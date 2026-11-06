'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

test('a failed query returns 500 and the server stays up', async (t) => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(port), ADMIN_TOKEN: 'test', DATABASE_URL: 'postgres://x:x@127.0.0.1:1/x' },
    stdio: 'ignore',
  });
  t.after(() => server.kill());

  await new Promise((resolve, reject) => {
    const poll = setInterval(() => {
      fetch(`${base}/health`).then(() => {
        clearInterval(poll);
        resolve();
      }, () => {});
    }, 100);
    server.once('exit', () => {
      clearInterval(poll);
      reject(new Error('server exited during startup'));
    });
  });

  const auth = { Authorization: 'Bearer test' };
  const failing = [
    ['GET', '/api/ingest/1/status', auth],
    ['GET', '/api/businesses/1', {}],
    ['GET', '/api/businesses/1/dashboard', auth],
    ['POST', '/api/sources/1', auth],
    ['GET', '/api/dashboard/1/traces', auth],
    ['GET', '/api/dashboard/1/traces/00000000-0000-4000-8000-000000000001', auth],
  ];
  for (const [method, url, headers] of failing) {
    const res = await fetch(base + url, { method, headers });
    assert.equal(res.status, 500, url);
    assert.deepEqual(await res.json(), { error: 'Internal server error' }, url);
  }

  assert.equal((await fetch(base + '/api/dashboard/1/traces')).status, 401);
  for (const url of ['/api/dashboard/0/traces', '/api/dashboard/1/traces?limit=101', '/api/dashboard/1/traces?before=bad', '/api/dashboard/1/traces/bad']) {
    assert.equal((await fetch(base + url, { headers: auth })).status, 400, url);
  }

  const create = await fetch(`${base}/api/businesses`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'a', url: 'https://example.com' }),
  });
  assert.equal(create.status, 500);

  const malformed = await fetch(`${base}/api/businesses`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: '{bad',
  });
  assert.equal(malformed.status, 400);

  assert.equal((await fetch(`${base}/health`)).status, 200);
});
