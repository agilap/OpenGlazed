'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.LLM_BASE_URL = 'http://127.0.0.1:1/v1';
process.env.EMBED_BASE_URL = 'http://127.0.0.1:1/v1';

test('verification, password change, reset, sign-out-everywhere, deletion and pruning', { skip: !process.env.AUTH_TEST_DATABASE_URL }, async () => {
  process.env.DATABASE_URL = process.env.AUTH_TEST_DATABASE_URL;
  process.env.ADMIN_TOKEN = 'account-test-admin';
  process.env.SMTP_HOST = 'smtp.invalid';
  const sent = [];
  require('nodemailer').createTransport = () => ({ sendMail: async (message) => { sent.push(message); } });
  const app = require('../src/server');
  const db = require('../src/db');
  const auth = require('../src/auth');
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const email = `acct-${crypto.randomBytes(6).toString('hex')}@example.test`;
  const call = (method, path, { cookie, body, headers } = {}) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...headers }, body: body && JSON.stringify(body) });
  const cookieOf = (res) => res.headers.get('set-cookie').split(';')[0];
  const linkToken = (message) => message.text.match(/#([a-f0-9]{64})/)[1];
  const settle = () => new Promise((resolve) => setTimeout(resolve, 200));
  try {
    const signup = await call('POST', '/api/auth/signup', { body: { email, password: 'first password 123' } });
    assert.equal(signup.status, 201);
    assert.equal((await signup.json()).user.email_verified, false);
    const cookie = cookieOf(signup);
    assert.equal((await call('POST', '/api/businesses', { cookie, body: { name: 'blocked' } })).status, 403);
    await settle();
    const verifyToken = linkToken(sent.find((m) => m.to === email && /Confirm/.test(m.subject)));
    assert.equal((await call('POST', '/api/auth/verify', { body: { token: verifyToken } })).status, 204);
    assert.equal((await call('POST', '/api/auth/verify', { body: { token: verifyToken } })).status, 400, 'tokens are single use');
    const created = await call('POST', '/api/businesses', { cookie, body: { name: 'mine' } });
    assert.equal(created.status, 200);
    const businessId = (await created.json()).businessId;

    const other = cookieOf(await call('POST', '/api/auth/login', { body: { email, password: 'first password 123' } }));
    assert.equal((await call('POST', '/api/auth/password', { cookie, body: { current: 'wrong', password: 'second password 123' } })).status, 403);
    assert.equal((await call('POST', '/api/auth/password', { cookie, body: { current: 'first password 123', password: 'second password 123' } })).status, 204);
    assert.equal((await call('GET', '/api/auth/me', { cookie })).status, 200, 'current session survives');
    assert.equal((await call('GET', '/api/auth/me', { cookie: other })).status, 401, 'other sessions end');

    assert.equal((await call('POST', '/api/auth/forgot', { body: { email: 'nobody-' + email } })).status, 202);
    assert.equal((await call('POST', '/api/auth/forgot', { body: { email } })).status, 202);
    await settle();
    const resets = sent.filter((m) => /Reset/.test(m.subject));
    assert.equal(resets.length, 1, 'unknown emails get no mail');
    const reset = await call('POST', '/api/auth/reset', { body: { token: linkToken(resets[0]), password: 'third password 123' } });
    assert.equal(reset.status, 204);
    assert.equal((await call('GET', '/api/auth/me', { cookie })).status, 401, 'reset ends old sessions');
    const fresh = cookieOf(reset);

    const extra = cookieOf(await call('POST', '/api/auth/login', { body: { email, password: 'third password 123' } }));
    assert.equal((await call('POST', '/api/auth/logout-all', { cookie: extra })).status, 204);
    assert.equal((await call('GET', '/api/auth/me', { cookie: fresh })).status, 401);

    const last = cookieOf(await call('POST', '/api/auth/login', { body: { email, password: 'third password 123' } }));
    const adminMade = await call('POST', '/api/businesses', { headers: { Authorization: 'Bearer account-test-admin' }, body: { name: 'assigned', owner_email: email.toUpperCase() } });
    assert.equal(adminMade.status, 200);
    const assigned = (await adminMade.json()).businessId;
    assert.equal((await call('GET', `/api/businesses/${assigned}/settings`, { cookie: last })).status, 200, 'owner_email assigns the owner');
    assert.equal((await call('POST', '/api/businesses', { headers: { Authorization: 'Bearer account-test-admin' }, body: { name: 'x', owner_email: 'missing@example.test' } })).status, 400);

    assert.equal((await call('DELETE', '/api/auth/account', { cookie: last, body: { confirm: 'nope', password: 'third password 123' } })).status, 400);
    assert.equal((await call('DELETE', '/api/auth/account', { cookie: last, body: { confirm: email, password: 'wrong' } })).status, 403);
    assert.equal((await call('DELETE', '/api/auth/account', { cookie: last, body: { confirm: email, password: 'third password 123' } })).status, 204);
    assert.equal((await db.query('SELECT 1 FROM businesses WHERE id = ANY($1)', [[businessId, assigned]])).rowCount, 0, 'owned workspaces are deleted');
    assert.equal((await call('POST', '/api/auth/login', { body: { email, password: 'third password 123' } })).status, 401);

    const user = await db.query("INSERT INTO users (email, password_hash) VALUES ($1, 'x:y') RETURNING id", ['prune-' + email]);
    await db.query("INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() - interval '1 minute')", [crypto.randomBytes(32).toString('hex'), user.rows[0].id]);
    await auth.pruneExpired();
    assert.equal((await db.query('SELECT 1 FROM user_sessions WHERE user_id = $1', [user.rows[0].id])).rowCount, 0);
  } finally {
    await db.query('DELETE FROM businesses WHERE owner_id IN (SELECT id FROM users WHERE email = ANY($1))', [[email, 'prune-' + email]]);
    await db.query('DELETE FROM users WHERE email = ANY($1)', [[email, 'prune-' + email]]);
    await new Promise((resolve) => server.close(resolve));
    await db.pool.end();
  }
});
