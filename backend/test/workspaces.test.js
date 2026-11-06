'use strict';
process.env.LLM_BASE_URL = 'http://127.0.0.1:1/v1';
process.env.EMBED_BASE_URL = 'http://127.0.0.1:1/v1';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

test('workspace settings, inbox, ownership and deletion', { skip: !process.env.AUTH_TEST_DATABASE_URL }, async () => {
  process.env.DATABASE_URL = process.env.AUTH_TEST_DATABASE_URL;
  process.env.ADMIN_TOKEN = 'workspaces-test-admin';
  const app = require('../src/server');
  const db = require('../src/db');
  const { notifyUnanswered } = require('../src/services/notify');
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const suffix = crypto.randomBytes(8).toString('hex');
  const emails = [`workspaces-a-${suffix}@example.test`, `workspaces-b-${suffix}@example.test`];
  const call = (method, path, cookie, body) => fetch(base + path, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let businessA;
  let businessB;
  const smtpHost = process.env.SMTP_HOST;
  try {
    const cookies = [];
    for (const email of emails) {
      const signup = await call('POST', '/api/auth/signup', null, { email, password: 'workspace test password' });
      assert.equal(signup.status, 201);
      cookies.push(signup.headers.get('set-cookie').split(';')[0]);
    }
    const [cookieA, cookieB] = cookies;
    businessA = (await (await call('POST', '/api/businesses', cookieA, { name: 'Workspace A' })).json()).businessId;
    businessB = (await (await call('POST', '/api/businesses', cookieB, { name: 'Workspace B' })).json()).businessId;

    const publicBusiness = (await (await call('GET', `/api/businesses/${businessA}`)).json()).business;
    assert.deepEqual(Object.keys(publicBusiness).sort(), ['accent_color', 'greeting', 'id', 'name']);
    assert.equal(publicBusiness.name, 'Workspace A');
    const settings = { name: 'Updated A', scope: 'Store policies', greeting: 'Welcome', accent_color: '#aabbCC', notify_email: 'team@example.test', notify_on_unanswered: false };
    const updated = await call('PATCH', `/api/businesses/${businessA}/settings`, cookieA, settings);
    assert.equal(updated.status, 200);
    assert.deepEqual((await updated.json()).settings, settings);
    assert.deepEqual((await (await call('GET', `/api/businesses/${businessA}/settings`, cookieA)).json()).settings, settings);
    assert.equal((await (await call('GET', `/api/businesses/${businessA}`)).json()).business.greeting, 'Welcome');
    for (const [field, value] of Object.entries({ name: '', scope: 'x'.repeat(601), greeting: 'x'.repeat(301), accent_color: '#123', notify_email: 'invalid', notify_on_unanswered: 'true' })) {
      const invalid = await call('PATCH', `/api/businesses/${businessA}/settings`, cookieA, { [field]: value });
      assert.equal(invalid.status, 400, field);
      assert.match((await invalid.json()).error, new RegExp(field));
    }
    assert.equal((await (await call('PATCH', `/api/businesses/${businessA}/settings`, cookieA, { notify_email: '' })).json()).settings.notify_email, null);

    const inserted = await db.query("INSERT INTO inbox_items (business_id, session_id, channel, status, question, answer, reason) VALUES ($1, 'session', 'widget', 'unanswered', 'What are your hours?', 'I do not know.', 'Missing.') RETURNING *", [businessA]);
    const item = inserted.rows[0];
    await db.query("INSERT INTO inbox_items (business_id, channel, status, question) VALUES ($1, 'team', 'off_topic', 'A joke?'), ($1, 'api', 'blocked', 'Bad request')", [businessA]);
    for (const [method, path, body] of [
      ['GET', `/api/businesses/${businessA}/settings`],
      ['PATCH', `/api/businesses/${businessA}/settings`, { name: 'No' }],
      ['GET', `/api/inbox/${businessA}`],
      ['PATCH', `/api/inbox/${businessA}/${item.id}`, { resolved: true }],
      ['POST', `/api/inbox/${businessA}/${item.id}/answer`, { answer: 'No' }],
      ['DELETE', `/api/businesses/${businessA}`, { confirm: 'Updated A' }],
      ['PATCH', `/api/inbox/${businessB}/${item.id}`, { resolved: true }],
      ['POST', `/api/inbox/${businessB}/${item.id}/answer`, { answer: 'No' }],
    ]) assert.equal((await call(method, path, cookieB, body)).status, 404, `${method} ${path}`);

    const inbox = await (await call('GET', `/api/inbox/${businessA}`, cookieA)).json();
    assert.deepEqual(inbox.counts, { unanswered: 1, off_topic: 1, blocked: 1 });
    assert.equal(inbox.items[0].id, item.id);
    assert.equal((await call('PATCH', `/api/inbox/${businessA}/${item.id}`, cookieA, { resolved: 'true' })).status, 400);
    assert.ok((await (await call('PATCH', `/api/inbox/${businessA}/${item.id}`, cookieA, { resolved: true })).json()).item.resolved_at);
    assert.equal((await (await call('GET', `/api/inbox/${businessA}?state=resolved`, cookieA)).json()).items.length, 1);
    assert.equal((await (await call('PATCH', `/api/inbox/${businessA}/${item.id}`, cookieA, { resolved: false })).json()).item.resolved_at, null);
    assert.equal((await call('POST', `/api/inbox/${businessA}/${item.id}/answer`, cookieA, { answer: '' })).status, 400);
    delete process.env.SMTP_HOST;
    await notifyUnanswered({ business: { id: businessA, name: 'Updated A', notify_email: 'team@example.test', notify_on_unanswered: true }, item });
    assert.equal((await db.query('SELECT notified_at FROM inbox_items WHERE id = $1', [item.id])).rows[0].notified_at, null);
    const realCount = db.countChunksBySource;
    db.countChunksBySource = async () => { throw new Error('forced ingest failure'); };
    const failedAnswer = await call('POST', `/api/inbox/${businessA}/${item.id}/answer`, cookieA, { answer: 'Open 9 to 5.' });
    db.countChunksBySource = realCount;
    assert.equal(failedAnswer.status, 502);
    assert.equal((await db.query('SELECT resolved_at FROM inbox_items WHERE id = $1', [item.id])).rows[0].resolved_at, null, 'a failed answer leaves the question open');
    assert.equal((await db.query("SELECT 1 FROM documents WHERE business_id = $1 AND filename LIKE 'Answer:%'", [businessA])).rowCount, 0, 'the failed document is removed');
    const response = await call('POST', `/api/inbox/${businessA}/${item.id}/answer`, cookieA, { answer: 'Open 9 to 5.' });
    assert.equal(response.status, 200);
    const answered = await response.json();
    assert.equal(answered.document.filename, 'Answer: What are your hours?');
    assert.equal(answered.document.source_type, 'paste');
    assert.equal(answered.document.status, 'ready', 'resolved only after the answer is searchable');
    assert.ok(answered.item.resolved_at);
    assert.equal((await call('DELETE', `/api/businesses/${businessA}`, cookieA, { confirm: 'updated a' })).status, 400);
    assert.equal((await call('DELETE', `/api/businesses/${businessA}`, cookieA, {})).status, 400);
    assert.equal((await call('DELETE', `/api/businesses/${businessA}`, cookieA, { confirm: 'Updated A' })).status, 204);
    assert.equal((await call('GET', `/api/businesses/${businessA}`)).status, 404);
  } finally {
    if (smtpHost === undefined) delete process.env.SMTP_HOST; else process.env.SMTP_HOST = smtpHost;
    await db.query('DELETE FROM businesses WHERE id = ANY($1)', [[businessA, businessB].filter(Boolean)]);
    await db.query('DELETE FROM users WHERE email = ANY($1)', [emails]);
    await new Promise((resolve) => server.close(resolve));
    await db.pool.end();
  }
});
