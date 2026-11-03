'use strict';

process.env.ADMIN_TOKEN = 'trace-route-test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/server');
const db = require('../src/db');

async function invoke(path, { params = {}, query = {}, authorized = true } = {}) {
  const route = app._router.stack.find((layer) => layer.route?.path === path).route;
  let status = 200;
  let body;
  const headers = {};
  const res = {
    status(code) { status = code; return this; },
    set(key, value) { headers[key] = value; return this; },
    json(value) { body = value; return this; },
  };
  const req = { params, query, headers: authorized ? { authorization: 'Bearer trace-route-test' } : {} };
  let index = 0;
  const next = async (error) => {
    if (error) throw error;
    if (index < route.stack.length) await route.stack[index++].handle(req, res, next);
  };
  await next();
  return { status, body, headers };
}

const listPath = '/api/dashboard/:businessId/traces';
const detailPath = listPath + '/:traceId';
const traceId = '00000000-0000-4000-8000-000000000001';

test('trace endpoints reject unauthenticated and malformed inputs before accessing storage', async () => {
  assert.equal((await invoke(listPath, { authorized: false })).status, 401);
  assert.equal((await invoke(detailPath, { authorized: false })).status, 401);
  for (const query of [{ limit: '0' }, { limit: '101' }, { limit: '1.2' }, { before: 'bad' }]) {
    assert.equal((await invoke(listPath, { params: { businessId: '2' }, query })).status, 400);
  }
  assert.equal((await invoke(listPath, { params: { businessId: '0' } })).status, 400);
  assert.equal((await invoke(listPath, { params: { businessId: '9223372036854775808' } })).status, 400);
  assert.equal((await invoke(detailPath, { params: { businessId: '2', traceId: 'bad' } })).status, 400);
});

test('trace endpoints pass tenant scope to storage and return 404 for absent scoped detail', async (t) => {
  const oldList = db.getRequestTraces;
  const oldDetail = db.getRequestTrace;
  t.after(() => { db.getRequestTraces = oldList; db.getRequestTrace = oldDetail; });
  let seen;
  db.getRequestTraces = async (...args) => { seen = args; return [{ id: traceId }]; };
  const listed = await invoke(listPath, { params: { businessId: '22' }, query: { limit: '10', before: traceId } });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body, [{ id: traceId }]);
  assert.equal(seen[0], '22');
  assert.equal(seen[1].limit, 10);
  assert.equal(seen[1].before, traceId);
  const big = await invoke(listPath, { params: { businessId: '9223372036854775807' } });
  assert.equal(big.status, 200);
  assert.equal(seen[0], '9223372036854775807');
  assert.equal(listed.headers['Cache-Control'], 'no-store');
  db.getRequestTrace = async (...args) => { seen = args; return null; };
  const missing = await invoke(detailPath, { params: { businessId: '23', traceId } });
  assert.equal(missing.status, 404);
  assert.deepEqual(seen.slice(0, 2), ['23', traceId]);
});
