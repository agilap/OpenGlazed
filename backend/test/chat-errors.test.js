'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function appWithAgent(runAgent) {
  const filename = path.resolve(__dirname, '../src/server.js');
  const localRequire = createRequire(filename);
  const dependencies = {
    './services/agent': { runAgent },
    './db': { getClient: async () => ({ name: 'Test' }), getHistory: async () => [] },
    './services/traces': { runTrace: async (_meta, fn) => fn({ id: 'test-trace' }), stage: async (_name, fn) => fn(), recordError() {} },
  };
  const mod = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports,__dirname){${fs.readFileSync(filename, 'utf8')}\n})`, { filename })(
    (name) => dependencies[name] || localRequire(name), mod, mod.exports, path.dirname(filename));
  return mod.exports;
}

test('server preserves partial model output without appending a different answer on failure', async () => {
  const app = appWithAgent(async ({ onToken }) => { onToken('Partial answer'); throw new Error('Stream lost'); });
  const route = app._router.stack.find((layer) => layer.route?.path === '/api/chat/:businessId/stream').route;
  const events = [];
  let ended = false;
  const res = { writeHead() {}, on() {}, write(frame) { events.push(JSON.parse(frame.slice(6))); }, end() { ended = true; } };
  await route.stack[0].handle({ params: { businessId: '1' }, body: { message: 'question', sessionId: 's' } }, res);
  assert.equal(ended, true);
  assert.deepEqual(events.map((event) => event.token).filter(Boolean), ['Partial answer']);
  assert.equal(events.at(-1).source, 'error');
  assert.equal(events.at(-1).done, true);
  assert.ok(events.at(-1).error);
});
