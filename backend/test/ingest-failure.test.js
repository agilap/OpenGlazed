'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('embedding failure rejects ingestion and marks the document as error', async () => {
  const dbPath = require.resolve('../src/db');
  const llmPath = require.resolve('../src/services/llm');
  const updates = [];
  const failure = new Error('embedding service unavailable');
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
    updateDocument: async (id, update) => updates.push({ id, ...update }),
  } };
  require.cache[llmPath] = { id: llmPath, filename: llmPath, loaded: true, exports: {
    embedTexts: async () => { throw failure; },
  } };

  const { ingestDocument } = require('../src/sources');
  await assert.rejects(
    ingestDocument(42, { id: 7, source_type: 'paste', filename: 'notes.txt' }, { text: 'A useful document.' }),
    (error) => error === failure,
  );
  assert.deepEqual(updates, [
    { id: 7, status: 'processing' },
    { id: 7, status: 'error', error: 'embedding service unavailable' },
  ]);
});
