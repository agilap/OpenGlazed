'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.LLM_BASE_URL = 'http://127.0.0.1:1/v1';
process.env.EMBED_BASE_URL = 'http://127.0.0.1:1/v1';

test('API keys are workspace-scoped, shown once, and revocable', { skip: !process.env.AUTH_TEST_DATABASE_URL }, async () => {
  process.env.DATABASE_URL = process.env.AUTH_TEST_DATABASE_URL;
  process.env.ADMIN_TOKEN = 'api-test-admin';
  const app = require('../src/server');
  const db = require('../src/db');
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const suffix = crypto.randomBytes(8).toString('hex');
  const emails = [`api-a-${suffix}@example.test`, `api-b-${suffix}@example.test`];
  const call = (method, path, { cookie, key, body } = {}) => fetch(base + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  try {
    const cookies = [];
    for (const email of emails) {
      const res = await call('POST', '/api/auth/signup', { body: { email, password: 'api test password!' } });
      assert.equal(res.status, 201);
      cookies.push(res.headers.get('set-cookie').split(';')[0]);
    }
    const [cookieA, cookieB] = cookies;
    const businessA = (await (await call('POST', '/api/businesses', { cookie: cookieA, body: { name: 'API A' } })).json()).businessId;
    const businessB = (await (await call('POST', '/api/businesses', { cookie: cookieB, body: { name: 'API B' } })).json()).businessId;

    assert.equal((await call('POST', `/api/keys/${businessA}`, { cookie: cookieA, body: {} })).status, 400);
    assert.equal((await call('POST', `/api/keys/${businessA}`, { cookie: cookieB, body: { name: 'x' } })).status, 404);
    const created = await call('POST', `/api/keys/${businessA}`, { cookie: cookieA, body: { name: 'CI' } });
    assert.equal(created.status, 201);
    const { key } = await created.json();
    assert.match(key.key, /^ogk_[A-Za-z0-9_-]{32}$/);
    const listed = (await (await call('GET', `/api/keys/${businessA}`, { cookie: cookieA })).json()).keys;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].key, undefined);
    assert.equal(listed[0].prefix, key.key.slice(0, 12));

    assert.equal((await call('GET', '/api/v1/documents')).status, 401);
    assert.equal((await call('GET', '/api/v1/documents', { key: 'ogk_' + 'x'.repeat(32) })).status, 401);
    const upload = await call('POST', '/api/v1/documents', { key: key.key, body: { filename: 'faq.md', text: '# Hours\nOpen 9 to 5.' } });
    assert.equal(upload.status, 202);
    const docId = (await upload.json()).document.id;
    const docsA = (await (await call('GET', '/api/v1/documents', { key: key.key })).json()).documents;
    assert.deepEqual(docsA.map((d) => d.id), [docId]);
    assert.equal((await call('GET', `/api/v1/documents/${docId}`, { key: key.key })).status, 200);

    const keyB = (await (await call('POST', `/api/keys/${businessB}`, { cookie: cookieB, body: { name: 'B' } })).json()).key.key;
    assert.deepEqual((await (await call('GET', '/api/v1/documents', { key: keyB })).json()).documents, []);
    assert.equal((await call('GET', `/api/v1/documents/${docId}`, { key: keyB })).status, 404);
    assert.equal((await call('DELETE', `/api/v1/documents/${docId}`, { key: keyB })).status, 404);

    assert.equal((await call('POST', '/api/v1/ask', { key: key.key, body: {} })).status, 400);
    assert.equal((await call('POST', '/api/v1/ask', { key: key.key, body: { question: 'hi', sessionId: 5 } })).status, 400);
    const ask = await call('POST', '/api/v1/ask', { key: key.key, body: { question: 'When are you open?' } });
    assert.equal(ask.status, 502);
    assert.ok((await ask.json()).traceId);

    assert.equal((await call('DELETE', `/api/keys/${businessA}/${key.id}`, { cookie: cookieB })).status, 404);
    assert.equal((await call('DELETE', `/api/keys/${businessA}/${key.id}`, { cookie: cookieA })).status, 204);
    assert.equal((await call('GET', '/api/v1/documents', { key: key.key })).status, 401);
    await db.query('DELETE FROM businesses WHERE id = ANY($1)', [[businessA, businessB]]);
  } finally {
    await db.query('DELETE FROM users WHERE email = ANY($1)', [emails]);
    await new Promise((resolve) => server.close(resolve));
    await db.pool.end();
  }
});
