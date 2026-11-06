'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function appWithAgent(runAgent, extra = {}) {
  const filename = path.resolve(__dirname, '../src/server.js');
  const localRequire = createRequire(filename);
  const dependencies = {
    './services/agent': { runAgent },
    './db': { getClient: async () => ({ name: 'Test' }), getHistory: async () => [] },
    './services/traces': { runTrace: async (_meta, fn) => fn({ id: 'test-trace' }), stage: async (_name, fn) => fn(), recordError() {} },
    ...extra,
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
  await route.stack.at(-1).handle({ params: { businessId: '1' }, body: { message: 'question', sessionId: 's' } }, res);
  assert.equal(ended, true);
  assert.deepEqual(events.map((event) => event.token).filter(Boolean), ['Partial answer']);
  assert.equal(events.at(-1).source, 'error');
  assert.equal(events.at(-1).done, true);
  assert.ok(events.at(-1).error);
});

test('widget non-answers carry no sources and offer a follow-up; answers keep their sources', async () => {
  const citations = [{ index: 1, source: 'hours.md', content: 'Open 7 to 3.' }];
  const agent = async ({ onToken }) => { onToken('Reply'); return { response: 'Reply', citations, chunks: [{ content: 'Open 7 to 3.' }], escalated: false, source: 'model', confidence: 'high' }; };
  for (const [status, sources, followUp] of [['answered', 1, false], ['unanswered', 0, true], ['off_topic', 0, false]]) {
    const app = appWithAgent(agent, {
      './services/guard': { classifyExchange: async () => ({ status, reason: 'test' }) },
      './db': { getClient: async () => ({ name: 'Test' }), getHistory: async () => [], getClassificationContext: async () => ({}), saveMessage: async () => {}, query: async () => ({ rows: [{}] }) },
    });
    const route = app._router.stack.find((layer) => layer.route?.path === '/api/chat/:businessId/stream').route;
    const events = [];
    const res = { writeHead() {}, on() {}, write(frame) { events.push(JSON.parse(frame.slice(6))); }, end() {} };
    await route.stack.at(-1).handle({ params: { businessId: '1' }, body: { message: 'q', sessionId: 's' } }, res);
    const done = events.at(-1);
    assert.equal(done.status, status);
    assert.equal(done.citations.length, sources, status);
    assert.equal(done.followUp, followUp, status);
  }
});
