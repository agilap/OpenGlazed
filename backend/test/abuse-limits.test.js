'use strict';

process.env.ADMIN_TOKEN = 'limits-test-admin';
process.env.CHAT_RATE_PER_MINUTE = '2';
process.env.DATABASE_URL = 'postgres://x:x@127.0.0.1:1/x';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/server');
const db = require('../src/db');

// Chat limiter checks the workspace exists; no database in this suite.
db.getClient = async (id) => { if (id === '404') throw new Error('Business not found'); return { id }; };

async function withServer(t) {
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}
const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('public chat is rate limited per visitor', async (t) => {
  const base = await withServer(t);
  // Empty messages fail validation after the limiter, so no database or model is needed.
  assert.equal((await post(`${base}/api/chat/7/stream`, { message: '', sessionId: 's' })).status, 400);
  assert.equal((await post(`${base}/api/chat/7/stream`, { message: '', sessionId: 's' })).status, 400);
  assert.equal((await post(`${base}/api/chat/7/stream`, { message: '', sessionId: 's' })).status, 429);
  assert.equal((await post(`${base}/api/chat/8/stream`, { message: '', sessionId: 's' })).status, 400, 'other workspaces keep their own limit');
});

test('non-upload routes reject bodies over 100 KB', async (t) => {
  const base = await withServer(t);
  assert.equal((await post(`${base}/api/chat/9/stream`, { message: 'x'.repeat(200 * 1024), sessionId: 's' })).status, 413);
});

test('lead endpoint validates input before touching the database', async (t) => {
  const base = await withServer(t);
  assert.equal((await post(`${base}/api/chat/abc/lead`, { sessionId: 's', email: 'a@b.co' })).status, 400);
  for (const body of [{}, { sessionId: 's' }, { sessionId: 's', email: 'nope' }, { sessionId: 's', email: 'a@b.co', name: 'x'.repeat(121) }, { sessionId: 's', email: { $ne: 1 } }]) {
    const response = await post(`${base}/api/chat/1/lead`, body);
    assert.equal(response.status, 400, JSON.stringify(body).slice(0, 80));
  }
});

test('admin token must match exactly', async (t) => {
  const base = await withServer(t);
  for (const token of ['wrong', 'limits-test-admi', 'limits-test-admin-extra']) {
    assert.equal((await fetch(`${base}/api/sources/1`, { headers: { Authorization: `Bearer ${token}` } })).status, 401, token);
  }
  assert.notEqual((await fetch(`${base}/api/sources/1`, { headers: { Authorization: 'Bearer limits-test-admin' } })).status, 401);
});

test('bad ids are rejected before any query, without leaking database errors', async (t) => {
  const base = await withServer(t);
  for (const url of ['/api/chat/abc/history?sessionId=s', '/api/dashboard/abc/stats', '/api/dashboard/1e3/stats', '/api/team/-1/threads']) {
    const response = await fetch(base + url, { headers: { Authorization: 'Bearer limits-test-admin' } });
    assert.equal(response.status, 400, url);
  }
  assert.equal((await fetch(`${base}/api/businesses/abc`)).status, 404);
  assert.equal((await fetch(`${base}/api/dashboard/1/stats`)).status, 401, 'dashboard needs sign-in');
  const failed = await fetch(`${base}/api/dashboard/1/stats`, { headers: { Authorization: 'Bearer limits-test-admin' } });
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { error: 'Internal server error' });
});

test('responses carry security headers and no framework banner', async (t) => {
  const base = await withServer(t);
  const response = await fetch(`${base}/health`);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(response.headers.get('x-powered-by'), null);
});

test('login is limited per account across IPs', async (t) => {
  const base = await withServer(t);
  // The DB is unreachable, so attempts under the limit fail with 500; the 11th is refused before any query.
  for (let i = 0; i < 10; i++) assert.equal((await post(`${base}/api/auth/login`, { email: 'Victim@x.co', password: 'p' })).status, 500);
  assert.equal((await post(`${base}/api/auth/login`, { email: 'victim@x.co', password: 'p' })).status, 429);
});

test('chat to an unknown workspace is 404 and not counted', async (t) => {
  const base = await withServer(t);
  assert.equal((await post(`${base}/api/chat/404/stream`, { message: 'hi', sessionId: 's' })).status, 404);
});

test('upload routes check auth before reading the body', async (t) => {
  const base = await withServer(t);
  // An unread body means the auth check answers, not the JSON parser (which would say 400).
  for (const path of ['/api/sources/1', '/api/v1/documents']) {
    const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
    assert.equal(response.status, 401, path);
  }
});
