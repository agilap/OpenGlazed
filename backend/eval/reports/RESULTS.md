# Retrieval regression evaluation

These reports use eight **synthetic stage fixtures**, the actual production retriever, and human relevance labels at k=5. No LLM, embedding provider, or Postgres was contacted. They measure orchestration/context regressions, not production retrieval or generated answer quality. Source/dataset hashes and per-case outputs are in the JSON reports.

| Metric @5 | Before | After |
| --- | ---: | ---: |
| Hit rate | 0.500000 | 1.000000 |
| Recall | 0.375000 | 0.937500 |
| MRR | 0.500000 | 0.937500 |
| nDCG | 0.390563 | 0.850284 |

Short fact questions and a specific “what is” question now reach leaf chunks. The summary/chunk-ID collision fixture retrieves the correct leaf; the exact error-code result moves from outside the top five to rank 2, still short of the ideal rank 1. Removing identical context text allows both warranty and battery evidence into context.

The dense+lexical agreement and embedding-outage controls remain unchanged. **Overview nDCG regressed from 0.787155 to 0.337352:** identical-text deduplication retains the leaf rather than the summary that the dataset grades higher; recall remains 0.5. This is partly a strict document-ID metric artifact (the selected text is identical), but the lower score is retained. No change improved every case.

For the two saved, human-labelled answers, evidence-availability faithfulness proxy, citation correctness, and citation coverage each rose from 0.25 to 0.75. One saved answer deliberately contains an unsupported cash-payment claim, so its correctness remains 0.5. **These are fixed answer annotation checks, not new model-generated answers or a semantic hallucination assessment.** Optional LLM judging and live corpus runs were not performed.

Run again:

```sh
npm run eval -w backend -- --out eval/reports/after.json --baseline eval/reports/before.json
```
