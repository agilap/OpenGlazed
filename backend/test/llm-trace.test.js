'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
let complete;
let embed;
const calls = [];
const models = [];
const sdkPath = require.resolve('openai');
require.cache[sdkPath] = { id: sdkPath, filename: sdkPath, loaded: true, exports: class {
  constructor() {
    this.chat = { completions: { create: (input) => { calls.push(input); return complete(input); } } };
    this.embeddings = { create: (input) => embed(input) };
  }
} };
const tracePath = require.resolve('../src/services/traces');
require.cache[tracePath] = { id: tracePath, filename: tracePath, loaded: true, exports: { recordModel: (record) => models.push(record) } };
const { chatComplete, chatStream, embedTexts } = require('../src/services/llm');

test('records real provider usage and keeps absent streaming usage unknown', async () => {
  complete = async () => ({ choices: [{ message: { content: 'Hello' } }], usage: { total_tokens: 5 } });
  assert.equal(await chatComplete('hi'), 'Hello');
  assert.deepEqual(models.at(-1).usage, { total_tokens: 5 });
  assert.ok(models.at(-1).latencyMs >= 0);
  complete = async function* () { yield { choices: [{ delta: { content: 'Hello' } }] }; };
  delete process.env.LLM_STREAM_USAGE;
  assert.equal((await chatStream([])).content, 'Hello');
  assert.equal(models.at(-1).usage, null);
  assert.equal(calls.at(-1).stream_options, undefined);
  process.env.LLM_STREAM_USAGE = 'true';
  complete = async function* () { yield { choices: [], usage: { total_tokens: 7 } }; };
  await chatStream([]);
  assert.deepEqual(calls.at(-1).stream_options, { include_usage: true });
  assert.deepEqual(models.at(-1).usage, { total_tokens: 7 });
  delete process.env.LLM_STREAM_USAGE;
});

test('model failures are recorded and rethrown; embedding usage is separate', async () => {
  const failure = new Error('bad key');
  complete = async () => { throw failure; };
  await assert.rejects(chatComplete('hi'), /bad key/);
  assert.equal(models.at(-1).error, failure);
  embed = async () => ({ data: [{ embedding: [1, 0] }], usage: { total_tokens: 2 } });
  assert.deepEqual(await embedTexts(['hi']), [[1, 0]]);
  assert.equal(models.at(-1).kind, 'embedding');
  assert.deepEqual(models.at(-1).usage, { total_tokens: 2 });
});
