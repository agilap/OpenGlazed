'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.LLM_BASE_URL = 'http://127.0.0.1:1/v1';
process.env.EMBED_BASE_URL = 'http://127.0.0.1:1/v1';

test('accounts isolate businesses, persist sessions, and revoke logout', { skip: !process.env.AUTH_TEST_DATABASE_URL }, async () => {
  process.env.DATABASE_URL = process.env.AUTH_TEST_DATABASE_URL;
  process.env.ADMIN_TOKEN = 'auth-test-admin';
  const app = require('../src/server');
  const db = require('../src/db');
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const suffix = crypto.randomBytes(8).toString('hex');
  const emails = [`a-${suffix}@example.test`, `b-${suffix}@example.test`];
  async function request(path, options = {}) {
    const res = await fetch(base + path, options);
    return res;
  }
  const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const a = await request('/api/auth/signup', json({ email: emails[0], password: 'correct horse battery staple' }));
    assert.equal(a.status, 201);
    const cookieA = a.headers.get('set-cookie').split(';')[0];
    assert.match(a.headers.get('set-cookie'), /HttpOnly/);
    const userA = (await a.json()).user;
    const b = await request('/api/auth/signup', json({ email: emails[1], password: 'another correct password' }));
    assert.equal(b.status, 201);
    const cookieB = b.headers.get('set-cookie').split(';')[0];
    const business = await db.query('INSERT INTO businesses (name, url, owner_id) VALUES ($1, $2, $3) RETURNING id', ['Test', 'https://example.test', userA.id]);
    const id = business.rows[0].id;
    assert.equal((await request(`/api/businesses/${id}/dashboard`, { headers: { cookie: cookieA } })).status, 200);
    assert.equal((await request(`/api/businesses/${id}/dashboard`, { headers: { cookie: cookieB } })).status, 404);
    assert.equal((await request(`/api/team/${id}/threads`, { headers: { cookie: cookieB } })).status, 404);
    assert.equal((await request('/api/auth/login', json({ email: emails[0], password: 'incorrect password' }))).status, 401);
    const login = await request('/api/auth/login', json({ email: emails[0], password: 'correct horse battery staple' }));
    assert.equal(login.status, 200);
    const loginCookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await request('/api/auth/me', { headers: { cookie: loginCookie } })).status, 200);
    assert.equal((await request('/api/auth/logout', { method: 'POST', headers: { cookie: loginCookie } })).status, 204);
    assert.equal((await request('/api/auth/me', { headers: { cookie: loginCookie } })).status, 401);
    assert.equal((await request('/api/auth/logout', { method: 'POST', headers: { cookie: cookieA, origin: 'https://evil.example' } })).status, 403);
    await db.query('DELETE FROM businesses WHERE id = $1', [id]);
  } finally {
    await db.query('DELETE FROM users WHERE email = ANY($1)', [emails]);
    await new Promise((resolve) => server.close(resolve));
    await db.pool.end();
  }
});
