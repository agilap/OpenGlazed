'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const ingest = require('../src/ingest');

const DIM = 1536;
const mkVec = (seed) => new Array(DIM).fill(0).map((_, i) => (i === seed ? 1 : 0));

test('storeLevel0Chunks is incremental: add/keep/purge by content hash', async () => {
  if (!process.env.DATABASE_URL) return;
  await db.ensureSchema(DIM);

  const biz = await db.insertBusiness('test-incr-' + Date.now(), 'https://incr.test');
  const bid = biz.id;
  const src = 'url:https://incr.test/page';

  const r1 = await ingest.storeLevel0Chunks([
    { content: 'A alpha', source_url: 'u', token_count: 1, embedding: mkVec(10) },
    { content: 'B beta',  source_url: 'u', token_count: 1, embedding: mkVec(20) },
    { content: 'C gamma', source_url: 'u', token_count: 1, embedding: mkVec(30) },
  ], bid, src);
  assert.strictEqual(r1.added, 3);
  assert.strictEqual(r1.unchanged, 0);
  assert.strictEqual(r1.removed, 0);

  const embA_before = (await db.getAllChunks(bid)).find((c) => c.content.includes('A')).embedding;

  const r2 = await ingest.storeLevel0Chunks([
    { content: 'A alpha',   source_url: 'u', token_count: 1, embedding: mkVec(999) },
    { content: 'B beta v2', source_url: 'u', token_count: 1, embedding: mkVec(21) },
  ], bid, src);

  assert.strictEqual(r2.added, 1, 'only the changed chunk is added');
  assert.strictEqual(r2.unchanged, 1, 'A is detected as unchanged');
  assert.strictEqual(r2.removed, 2, 'old B hash + deleted C are removed');

  const after = await db.getAllChunks(bid);
  assert.strictEqual(after.length, 2, 'only A + Bv2 remain');
  assert.ok(!after.some((c) => c.content.includes('C')), 'C is purged');

  const embA_after = after.find((c) => c.content.includes('A')).embedding;
  assert.strictEqual(embA_after, embA_before, 'unchanged chunk keeps its original embedding');

  await db.deleteChunksByBusiness(bid);
});
