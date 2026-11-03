'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const traces = require('../src/services/traces');

const pause = () => new Promise((resolve) => setImmediate(resolve));

test('concurrent traces keep models, context, retrieval and errors isolated', async () => {
  const saved = [];
  const logs = [];
  const options = { save: async (trace) => saved.push(trace), log: (line) => logs.push(JSON.parse(line)) };
  await Promise.all([1, 2].map((id) => traces.runTrace({ businessId: id, sessionId: 's', surface: 'widget', query: `query-${id}` }, async () => {
    traces.recordContext([`context-${id}`]);
    await pause();
    traces.recordModel({ kind: 'chat', model: `model-${id}`, usage: id === 1 ? { total_tokens: 12 } : null, latencyMs: 12 });
    await traces.stage('retrieval', async () => traces.recordRetrieval({ query: `query-${id}`, candidates: [{ id }] }));
    if (id === 2) traces.recordError(new Error('local failure'), 'tool');
    return { source: id === 1 ? 'agent' : 'retriever-only' };
  }, options)));
  saved.sort((a, b) => a.business_id - b.business_id);
  assert.deepEqual(saved.map((t) => t.final_context), [['context-1'], ['context-2']]);
  assert.deepEqual(saved.map((t) => t.source), ['model', 'retriever']);
  assert.deepEqual(saved.map((t) => t.model), ['model-1', 'model-2']);
  assert.equal(saved[0].errors.length, 0);
  assert.equal(saved[1].errors[0].stage, 'tool');
  assert.equal(saved[1].token_usage[0].usage, null, 'unknown provider usage is not fabricated');
  assert.equal(saved[0].retrievals[0].candidates[0].id, 1);
  assert.equal(saved[0].stages[0].name, 'retrieval');
  assert.ok(saved[0].duration_ms >= 0);
  assert.ok(logs.every((line) => line.event === 'rag.request' && !('query' in line) && !('final_context' in line)));
});

test('failed requests persist an error trace and preserve the original error', async () => {
  let saved;
  await assert.rejects(traces.runTrace({ businessId: 1, sessionId: 's', surface: 'team', query: 'q' }, async () => {
    throw new Error('provider failed');
  }, { save: async (trace) => { saved = trace; }, log: () => {} }), /provider failed/);
  assert.equal(saved.source, 'error');
  assert.equal(saved.errors[0].message, 'provider failed');
});

test('retention config accepts only positive bounded integers', () => {
  assert.equal(traces.positiveInt('0', 7, 20), 7);
  assert.equal(traces.positiveInt('no', 7, 20), 7);
  assert.equal(traces.positiveInt('1.5', 7, 20), 7);
  assert.equal(traces.positiveInt('100', 7, 20), 20);
});

test('trace storage and pagination always scope queries to the requested bot', async (t) => {
  const originalQuery = db.pool.query;
  const originalConnect = db.pool.connect;
  const calls = [];
  db.pool.query = async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; };
  db.pool.connect = async () => ({ query: db.pool.query, release: () => {} });
  t.after(() => { db.pool.query = originalQuery; db.pool.connect = originalConnect; });
  await db.ensureTraceSchema();
  await db.ensureTraceSchema();
  assert.equal(calls.filter((c) => c.sql.includes('CREATE TABLE')).length, 1, 'schema is migrated once per process');
  await db.getRequestTraces('22', { limit: 10, before: '00000000-0000-4000-8000-000000000001', days: 3 });
  const list = calls.at(-1);
  assert.deepEqual(list.params, ['22', 10, '00000000-0000-4000-8000-000000000001', 3]);
  assert.match(list.sql, /WHERE business_id = \$1 AND id = \$3/);
  await db.getRequestTrace('22', '00000000-0000-4000-8000-000000000001', 3);
  assert.deepEqual(calls.at(-1).params, ['22', '00000000-0000-4000-8000-000000000001', 3]);
  assert.match(calls.at(-1).sql, /business_id = \$1 AND id = \$2/);
  await db.saveRequestTrace({ id: 'uuid', business_id: '22', session_id: 's', surface: 'widget', query: 'q', source: 'model',
    model: 'local', duration_ms: 2, token_usage: [], stages: [], retrievals: [], final_context: [], errors: [] }, { days: 3, maxPerBusiness: 10 });
  const prune = calls.find((c) => c.sql.includes('DELETE FROM request_traces WHERE business_id'));
  assert.deepEqual(prune.params, ['22', 3, 10]);
  assert.match(prune.sql, /OFFSET \$3/);
  assert.ok(calls.some((c) => c.sql.includes('pg_advisory_xact_lock')));
  assert.equal(calls.at(-1).sql, 'COMMIT');
});
