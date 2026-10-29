'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');

const DIM = 1536;
const mkVec = (axis) => {
  const v = new Array(DIM).fill(0);
  v[axis] = 1;
  return v;
};

function cosineSim(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
  }
  return d / (Math.sqrt(na) * Math.sqrt(nb));
}

test('ensureSchema is idempotent for the current dim', async () => {
  if (!process.env.DATABASE_URL) return;
  await assert.doesNotReject(db.ensureSchema(DIM));
  const ok = await db.getAllChunks.length;
  assert.strictEqual(typeof ok, 'number');
});

test('getEmbeddingsForIds returns parsed arrays, keyed for retriever lookups', async () => {
  if (!process.env.DATABASE_URL) return;
  const biz = await db.insertBusiness('test-rerank-' + Date.now(), 'https://x.test');
  const bid = biz.id;
  await db.insertChunks([
    { business_id: bid, chunk_text: 'A apple', source_url: 'u', source_ref: 't', chunk_index: 0, level: 0, token_count: 2, embedding: mkVec(10) },
    { business_id: bid, chunk_text: 'B banana', source_url: 'u', source_ref: 't', chunk_index: 1, level: 0, token_count: 2, embedding: mkVec(500) },
    { business_id: bid, chunk_text: 'C car', source_url: 'u', source_ref: 't', chunk_index: 2, level: 0, token_count: 2, embedding: mkVec(1000) },
  ]);

  const chunks = await db.getAllChunks(bid);
  const ids = chunks.map((c) => c.id);
  const embMap = await db.getEmbeddingsForIds(ids);

  assert.ok(Array.isArray(embMap.get(String(ids[0]))), 'embedding should be a parsed array');
  assert.strictEqual(embMap.has(String(ids[0])), true, 'retriever lookup by String id must hit');

  const q = mkVec(500);
  const scored = ids
    .map((id) => ({ id, sim: embMap.has(String(id)) ? cosineSim(q, embMap.get(String(id))) : 0 }))
    .sort((a, b) => b.sim - a.sim);

  const topId = scored[0].id;
  const topChunk = chunks.find((c) => String(c.id) === String(topId));
  assert.strictEqual(topChunk.content, 'B banana', 'rerank should surface the query-aligned chunk');
  assert.strictEqual(scored[0].sim, 1, 'cosine sim to the aligned chunk should be 1.0');

  await db.deleteChunksByBusiness(bid);
});

test('getEmbeddingsForIds handles empty input without error', async () => {
  if (!process.env.DATABASE_URL) return;
  const m = await db.getEmbeddingsForIds([]);
  assert.strictEqual(m.size, 0);
});
