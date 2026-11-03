'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detectQueryLevel, reciprocalRankFusion, assembleContext, cosineSim } = require('../src/services/retriever');

test('short specific queries include leaves, explicit overview adds summaries', () => {
  assert.deepEqual(detectQueryLevel('Refund deadline?'), [0]);
  assert.deepEqual(detectQueryLevel('What is your refund policy?'), [0]);
  assert.deepEqual(detectQueryLevel('Give me an overview'), [0, 1, 2]);
});
test('fusion namespaces summary IDs and preserves per-stage scores', () => {
  const dense = [{ id: '1', level: 2, content: 'Overview', similarity: .8 }];
  const lexical = [{ id: '1', level: 0, content: 'Refunds', lexical_score: .4 }];
  const rows = reciprocalRankFusion(dense, lexical);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].dense_score, .8);
  assert.equal(rows[1].lexical_score, .4);
});
test('context deduplicates text and fills from remaining candidates within budget', () => {
  const chunks = Array.from({ length: 7 }, (_, id) => ({ id, content: id < 5 ? 'Repeated fact' : `Distinct fact ${id}`, level: 0 }));
  const result = assembleContext(chunks, { maxChunks: 5, maxChars: 40 });
  assert.deepEqual(result.map((r) => r.id), [0, 5, 6]);
  assert.ok(result.reduce((sum, r) => sum + r.content.length, 0) <= 40);
});
test('cosine rejects malformed and mismatched vectors', () => {
  assert.equal(cosineSim([1], [1, 2]), null);
  assert.equal(cosineSim([NaN], [1]), null);
});

test('fusion does not count duplicate rows in one ranking as extra votes', () => {
  const row = { id: '1', level: 0, content: 'Fact', similarity: .8 };
  assert.equal(reciprocalRankFusion([row, row], [])[0].rrf_score, 1 / 61);
});

test('rerank embedding fetch scopes IDs to the requesting bot', async (t) => {
  const db = require('../src/db');
  const original = db.pool.query;
  let observed;
  db.pool.query = async (sql, params) => { observed = { sql, params }; return { rows: [{ id: '1', embedding: '[1,0]' }] }; };
  t.after(() => { db.pool.query = original; });
  const map = await db.getEmbeddingsForIds(['1'], '22');
  assert.match(observed.sql, /business_id = \$2/);
  assert.deepEqual(observed.params, [['1'], '22']);
  assert.deepEqual(map.get('1'), [1, 0]);
});
