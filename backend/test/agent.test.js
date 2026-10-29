'use strict';

process.env.LLM_BASE_URL = 'http://127.0.0.1:9/v1';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { runAgent } = require('../src/services/agent');

const business = { name: 'Acme', brand_tone: 'friendly', key_cta: 'Book a call' };

function scriptedChat(turns, seen = []) {
  let i = 0;
  return async (messages, { tools, onToken }) => {
    seen.push({ messages: messages.slice(), tools });
    const turn = turns[i++];
    if (turn.error) throw Object.assign(new Error(turn.error), { status: turn.status });
    if (turn.content && onToken) onToken(turn.content);
    return { content: turn.content || '', toolCalls: turn.toolCalls || [] };
  };
}

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

const fakeRetrieve = async (_biz, query) => ({
  chunks: [
    { id: 1, content: `Pricing starts at $49 (${query})`, source_url: 'https://acme.test/pricing', level: 0 },
    { id: 2, content: 'Annual plans get 2 months free', source_url: 'https://acme.test/pricing', level: 0 },
    { id: 3, content: 'We ship worldwide', source_url: 'https://acme.test/shipping', level: 0 },
  ],
  confidence: 0.8,
  shouldEscalate: false,
});

test('searches, feeds the result back, then answers with citations', async () => {
  const seen = [];
  const tokens = [];
  const result = await runAgent({
    businessId: 1, business, surface: 'widget', sessionId: 's1',
    history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Hello!' }],
    message: 'how much is it?',
    onToken: (t) => tokens.push(t),
    deps: {
      chat: scriptedChat([
        { toolCalls: [call('c1', 'search_knowledge', { query: 'pricing' })] },
        { content: 'Plans start at $49.' },
      ], seen),
      retrieve: fakeRetrieve,
    },
  });

  assert.equal(result.response, 'Plans start at $49.');
  assert.equal(tokens.join(''), 'Plans start at $49.');
  assert.equal(result.escalated, false);
  assert.equal(result.source, 'agent');
  assert.equal(result.confidence, 0.8);
  assert.deepEqual(result.citations.map((c) => c.source), ['https://acme.test/pricing', 'https://acme.test/shipping']);

  const second = seen[1].messages;
  assert.equal(second[1].content, 'hi');
  assert.equal(second.at(-1).role, 'tool');
  assert.equal(second.at(-1).tool_call_id, 'c1');
  assert.match(second.at(-1).content, /\$49 \(pricing\)/);
});

test('widget cannot call team tools; capture_lead and escalate work', async () => {
  const leads = [];
  const seen = [];
  const result = await runAgent({
    businessId: 1, business, surface: 'widget', sessionId: 's2', message: 'email me: a@b.co',
    deps: {
      chat: scriptedChat([
        { toolCalls: [
          call('c1', 'recent_leads', {}),
          call('c2', 'capture_lead', { email: 'a@b.co', intent: 'buying' }),
          call('c3', 'escalate', { reason: 'custom quote' }),
        ] },
        { content: 'Thanks, the team will follow up.' },
      ], seen),
      retrieve: fakeRetrieve,
      saveLead: async (...args) => leads.push(args),
    },
  });

  const toolNames = seen[0].tools.map((t) => t.function.name);
  assert.ok(!toolNames.includes('recent_leads'));
  assert.equal(seen[1].messages.find((m) => m.tool_call_id === 'c1').content, 'Unknown tool: recent_leads');
  assert.deepEqual(leads[0].slice(0, 2), [1, 's2']);
  assert.equal(leads[0][2].email, 'a@b.co');
  assert.equal(leads[0][2].follow_up_priority, 'high');
  assert.equal(result.escalated, true);
  assert.deepEqual(result.citations, []);
});

test('stops after the step cap and forces a text answer', async () => {
  const seen = [];
  const loop = { toolCalls: [call('c', 'search_knowledge', { query: 'x' })] };
  const result = await runAgent({
    businessId: 1, business, surface: 'team', sessionId: 't1', message: 'x',
    deps: { chat: scriptedChat([loop, loop, loop, { content: 'Done.' }], seen), retrieve: fakeRetrieve },
  });
  assert.equal(seen.length, 4);
  assert.equal(result.response, 'Done.');
});

test('falls back to plain RAG when the provider rejects tools', async () => {
  const tokens = [];
  const result = await runAgent({
    businessId: 1, business, surface: 'widget', sessionId: 's3', message: 'price?',
    onToken: (t) => tokens.push(t),
    deps: { chat: scriptedChat([{ error: 'tools not supported', status: 400 }]), retrieve: fakeRetrieve },
  });
  assert.equal(result.source, 'retriever-only');
  assert.match(result.response, /\$49/);
  assert.equal(tokens.join(''), result.response);
});

test('auth/network errors surface instead of silently degrading', async () => {
  await assert.rejects(
    runAgent({
      businessId: 1, business, surface: 'widget', sessionId: 's4', message: 'hi',
      deps: { chat: scriptedChat([{ error: 'bad key', status: 401 }]), retrieve: fakeRetrieve },
    }),
    /bad key/
  );
});
