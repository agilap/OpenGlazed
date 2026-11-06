'use strict';
process.env.LLM_BASE_URL = 'http://127.0.0.1:1/v1';
process.env.EMBED_BASE_URL = 'http://127.0.0.1:1/v1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseClassification, classifyExchange } = require('../src/services/guard');

test('classification parses JSON and fenced JSON and rejects invalid responses', () => {
  assert.deepEqual(parseClassification('{"status":"answered","reason":"It was answered."}'), { status: 'answered', reason: 'It was answered.' });
  assert.deepEqual(parseClassification('```json\n{"status":"off_topic","reason":"Unrelated."}\n```'), { status: 'off_topic', reason: 'Unrelated.' });
  assert.equal(parseClassification('garbage'), null);
  assert.equal(parseClassification('{"status":"unknown","reason":"No."}'), null);
});

test('classification falls back when the model fails', async () => {
  const deps = { chatComplete: async () => { throw new Error('unavailable'); } };
  assert.equal((await classifyExchange({ question: 'Q', answer: 'A', result: { escalated: true } }, deps)).status, 'unanswered');
  assert.equal((await classifyExchange({ question: 'Q', answer: 'A', confidence: 'low' }, deps)).status, 'unanswered');
  assert.equal((await classifyExchange({ question: 'Q', answer: 'A' }, deps)).status, 'answered');
});


test('classification prompt includes workspace topic context and off-topic rules', async () => {
  let captured;
  const classification = await classifyExchange({
    question: 'Write a poem about cats', answer: 'I can only help with Glazed AI.',
    business: { name: 'Workspace', scope: '' },
    topicContext: { filenames: ['Glazed AI guide.pdf', 'Product notes.txt'], summary: 'Glazed AI reads documents.' },
  }, { chatComplete: async (prompt, options) => {
    captured = prompt;
    assert.equal(options.temperature, 0);
    return '{"status":"off_topic","reason":"Unrelated."}';
  } });
  assert.deepEqual(classification, { status: 'off_topic', reason: 'Unrelated.' });
  assert.match(captured, /Glazed AI guide\.pdf/);
  assert.match(captured, /Product notes\.txt/);
  assert.match(captured, /Glazed AI reads documents\./);
  assert.match(captured, /off_topic: The question is unrelated to that subject, even if the assistant declined it/);
  assert.match(captured, /means the question was off_topic, not unanswered/);
});
