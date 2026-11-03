'use strict';
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/v1';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runAgent } = require('../src/services/agent');
const call = (query) => ({ id: query, type: 'function', function: { name: 'search_knowledge', arguments: JSON.stringify({ query }) } });

test('knowledge context has stable source labels and repeated searches do not duplicate content', async () => {
  const seen = [];
  let n = 0;
  const result = await runAgent({ businessId: 1, business: { name: 'Acme' }, message: 'pricing and shipping', deps: {
    chat: async (messages, { onToken }) => {
      seen.push(messages.slice());
      n += 1;
      if (n < 3) return { content: '', toolCalls: [call(String(n))] };
      onToken('Price [1], shipping [2].');
      return { content: 'Price [1], shipping [2].', toolCalls: [] };
    },
    retrieve: async (_id, query) => ({ confidence: 'high', chunks: query === '1'
      ? [{ id: 1, level: 0, content: 'Price $49', source_url: 'https://test/pricing' }]
      : [{ id: 1, level: 0, content: 'Price $49', source_url: 'https://test/pricing' }, { id: 2, level: 0, content: 'Free shipping', source_url: 'https://test/shipping' }] }),
  } });
  assert.equal(result.chunks.length, 2);
  const tools = seen.at(-1).filter((m) => m.role === 'tool');
  assert.match(tools[0].content, /\[1\].*Price \$49/);
  assert.match(tools[1].content, /\[2\].*Free shipping/);
  assert.doesNotMatch(tools[1].content, /Price \$49/);
  assert.deepEqual(result.citations.map((c) => c.index), [1, 2]);
});

test('tool context has a shared character budget across multiple searches', async () => {
  const seen = [];
  let n = 0;
  const result = await runAgent({ businessId: 1, business: {}, message: 'x', deps: {
    chat: async (messages, { onToken }) => {
      seen.push(messages.slice());
      n += 1;
      if (n < 4) return { content: '', toolCalls: [call(String(n))] };
      onToken('Done'); return { content: 'Done', toolCalls: [] };
    },
    retrieve: async (_id, query) => ({ chunks: Array.from({ length: 5 }, (_, i) => ({ id: `${query}-${i}`, content: 'x'.repeat(10000), level: 0 })) }),
  } });
  const texts = seen.at(-1).filter((m) => m.role === 'tool').map((m) => m.content).join('');
  assert.ok(texts.length < 26000, `unbounded context: ${texts.length}`);
  assert.ok(result.chunks.reduce((n, c) => n + c.content.length, 0) <= 24000);
});
