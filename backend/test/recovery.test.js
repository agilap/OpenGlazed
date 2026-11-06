'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.LLM_BASE_URL = 'http://127.0.0.1:1/v1';
process.env.EMBED_BASE_URL = 'http://127.0.0.1:1/v1';

test('restart recovery fails interrupted ingests, drops their chunks, and finishes deletes', { skip: !process.env.AUTH_TEST_DATABASE_URL }, async () => {
  process.env.DATABASE_URL = process.env.AUTH_TEST_DATABASE_URL;
  const db = require('../src/db');
  const { recoverInterrupted } = require('../src/sources');
  await db.ensureSchema(null);
  const business = await db.insertBusiness('recovery-' + Date.now(), '');
  try {
    const stuck = await db.createDocument(business.id, 'stuck.pdf', 'pdf');
    await db.updateDocument(stuck.id, { status: 'processing' });
    const queued = await db.createDocument(business.id, 'queued.md', 'markdown');
    const removing = await db.createDocument(business.id, 'old.md', 'markdown');
    await db.updateDocument(removing.id, { status: 'deleting' });
    const ready = await db.createDocument(business.id, 'fine.md', 'markdown');
    await db.updateDocument(ready.id, { status: 'ready' });
    await db.query('INSERT INTO chunks (business_id, chunk_text, source_url, chunk_index, level, source_ref) VALUES ($1, $2, $3, 0, 0, $4)', [business.id, 'partial', 'stuck.pdf', 'doc:' + stuck.id]);

    const result = await recoverInterrupted({ businessId: business.id });
    assert.deepEqual(result, { failed: 2, deleting: 1 });
    for (const doc of [stuck, queued]) {
      const row = await db.getDocument(business.id, doc.id);
      assert.equal(row.status, 'error');
      assert.match(row.error, /server restart/);
    }
    assert.equal((await db.getDocument(business.id, ready.id)).status, 'ready');
    assert.equal((await db.query('SELECT 1 FROM chunks WHERE source_ref = $1', ['doc:' + stuck.id])).rowCount, 0);
    for (let i = 0; i < 50 && await db.getDocument(business.id, removing.id); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await db.getDocument(business.id, removing.id), null, 'pending delete completes');
  } finally {
    await db.query('DELETE FROM businesses WHERE id = $1', [business.id]);
    await db.pool.end();
  }
});
