'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const llmPath = require.resolve('../src/services/llm');
let stream;
require.cache[llmPath] = { id: llmPath, filename: llmPath, loaded: true, exports: {
  chatComplete: async () => '', streamChat: (...args) => stream(...args),
} };
const { streamAnswer, buildAnswerPrompt } = require('../src/services/generator');

test('escalation marker split across stream chunks is never displayed', async () => {
  const tokens = [];
  stream = async (_prompt, { onToken }) => {
    for (const token of ['[ES', 'CALATE]', ': missing price']) onToken(token);
    return '[ESCALATE]: missing price';
  };
  const result = await streamAnswer({ query: 'price', contextChunks: [] }, { onToken: (t) => tokens.push(t) });
  assert.equal(result.escalated, true);
  assert.equal(result.reason, 'missing price');
  assert.deepEqual(tokens, []);
});

test('partial stream failures propagate instead of appending unrelated fallback text', async () => {
  const tokens = [];
  stream = async (_prompt, { onToken }) => { onToken('The price is'); throw new Error('connection lost'); };
  await assert.rejects(streamAnswer({ contextChunks: ['Fallback source'] }, { onToken: (t) => tokens.push(t) }), /connection lost/);
  assert.deepEqual(tokens, ['The price is']);
});

test('failure before tokens uses extractive fallback and normal answers stream once', async () => {
  stream = async () => { throw new Error('no provider'); };
  const result = await streamAnswer({ contextChunks: ['A source'] });
  assert.equal(result.source, 'retriever-only');
  assert.equal(result.response, 'A source...');
  const tokens = [];
  stream = async (_prompt, { onToken }) => { onToken('Hello'); return 'Hello'; };
  assert.equal((await streamAnswer({ contextChunks: [] }, { onToken: (t) => tokens.push(t) })).response, 'Hello');
  assert.deepEqual(tokens, ['Hello']);
  assert.match(buildAnswerPrompt({ contextChunks: ['A source'] }), /untrusted reference data/);
});

test('source labels remain consistent when multiple chunks share one source', () => {
  const prompt = buildAnswerPrompt({ contextChunks: [
    { content: 'Price $49', source_url: 'https://test/pricing', citation_index: 1 },
    { content: 'Annual discount', source_url: 'https://test/pricing', citation_index: 1 },
    { content: 'Free shipping', source_url: 'https://test/shipping', citation_index: 2 },
  ] });
  assert.match(prompt, /\[1\] \(https:\/\/test\/pricing\) Annual discount/);
  assert.match(prompt, /\[2\] \(https:\/\/test\/shipping\) Free shipping/);
});
