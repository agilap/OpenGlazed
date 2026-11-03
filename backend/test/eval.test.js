'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { retrievalMetrics, answerMetrics, compare } = require('../eval/run');

test('retrieval metrics use graded relevance and unique IDs', () => {
  const score = retrievalMetrics(['x', 'a', 'a', 'b'], { a: 3, b: 1 }, 4);
  assert.equal(score.hit_rate, 1);
  assert.equal(score.recall, 1);
  assert.equal(score.mrr, 0.5);
  const expected = (7 / Math.log2(3) + 1 / Math.log2(5)) / (7 + 1 / Math.log2(3));
  assert.equal(score.ndcg, expected);
  assert.deepEqual(retrievalMetrics([], { a: 1 }, 5), { hit_rate: 0, recall: 0, mrr: 0, ndcg: 0 });
});

test('missing evidence and incorrect citations do not get credit', () => {
  const answer = { claims: [{ supportedBy: ['a'] }, { supportedBy: ['b'] }, { supportedBy: [] }], citations: [{ claim: 0, document: 'a' }, { claim: 1, document: 'a' }, { claim: 2, document: 'b' }] };
  assert.deepEqual(answerMetrics(answer, ['a']), { faithfulness_proxy: 1 / 3, citation_correctness: 1 / 3, citation_coverage: 1 / 3 });
  assert.deepEqual(answerMetrics({ claims: [], citations: [] }, []), { faithfulness_proxy: null, citation_correctness: null, citation_coverage: null });
});

test('baseline comparison rejects changes in dataset and cutoff', () => {
  const report = { dataset_sha256: 'one', k: 5, retrieval: { recall: 0.8 }, answer: { faithfulness_proxy: null } };
  assert.throws(() => compare(report, { ...report, dataset_sha256: 'two' }), /differs/);
  assert.throws(() => compare(report, { ...report, k: 1 }), /differs/);
  assert.deepEqual(compare(report, { ...report, retrieval: { recall: 0.5 } }).retrieval_delta, { recall: 0.30000000000000004 });
});
