# Offline RAG evaluation

Run from the repository root:

```sh
npm run eval -w backend -- --out eval/reports/after.json --baseline eval/reports/before.json
```

No Postgres, embedding endpoint, chat model, or API key is used by the default run. It executes the **production retriever** with deterministic synthetic stage responses injected at its database and embedding boundaries. This isolates retrieval orchestration, fusion, filtering and context selection. It does **not** measure the quality of your embedding model, Postgres full-text ranking, scraping, chunking, or generated answers. The small sample is a regression dataset with controls, not evidence of production quality. Evaluate representative customer questions before deploying.

`--dataset path.json`, `--out path.json`, and `--baseline report.json` are optional. Paths are relative to the working directory. Reports contain the dataset and retriever SHA-256, per-question selected document IDs, aggregate metrics, and deltas against a baseline. Baseline comparison rejects a different dataset, k, or retrieval mode. Context selection uses k chunks within the production character budget; longer chunks can therefore limit the number admitted. `--retriever path.js` can evaluate a saved prior production retriever. The checked-in `before.json` records the original implementation; `after.json` records the updated implementation. Timings are intentionally excluded because mocked services do not represent production latency.

## Golden dataset format

A version 1 JSON object contains `name`, positive integer `k`, and `cases`. Each case contains:

- `id`, `query`, optional `businessId` (default 1).
- `dense`: ordered leaf rows returned by dense retrieval.
- `lexical`: ordered full-text rows.
- Rows use `id`, `content`, `level`, `source_url`, `similarity`. String bigint IDs match node-postgres behavior.
- `queryEmbedding` (default `[1,0]`), optional `embeddings` keyed by chunk ID, and optional `embeddingError: true` to test lexical-only fallback. Small synthetic vectors deliberately avoid a dependency on any embedding provider.
- `relevance`: graded judgments keyed by `level:id`, e.g. `{ "0:123": 3 }`. Missing IDs have grade 0; positive grades are relevant.
- Optional `answer`: a **saved answer** with `claims` (`text`, `supportedBy` document keys) and `citations` (`claim` zero-based index, `document` key). Human reviewers assign supporting document keys; use an empty list for unsupported claims. These are fixed answer annotations, not generated answers.

At k, hit rate is the fraction of questions with any relevant result; recall is relevant unique IDs retrieved / all positive judgments; MRR uses the first relevant rank; nDCG uses graded gain `2^grade - 1` with log2 discount. Duplicate IDs receive no second credit. Dataset aggregate metrics are unweighted per-question means. Empty-relevance questions score 0 and should normally live in a separate abstention dataset.

## Answer scoring

The default `faithfulness_proxy` is the proportion of human-labelled claims whose supporting document occurs in the final context. Citation correctness is the proportion of citations pointing to a retrieved document labelled as supporting the associated claim. Citation coverage measures claims with such a citation. No claims/citations means `null`, not a fabricated perfect score. These metrics verify annotated evidence availability and citation validity; they cannot detect semantic hallucinations in arbitrary text. The sample includes an unsupported cash-payment claim to demonstrate a failure.

For an optional semantic check of saved answers, pass `--judge`. This calls your existing `LLM_*` provider (no additional service/model is configured) using the actual selected context, reporting separate `llm_judge` faithfulness/citation correctness values per case. It is disabled by default, costs model tokens, may send these fixtures to the configured provider, and is not needed for retrieval metrics. Judge failures are recorded as errors with no score. Judge values are subjective and are not mixed into deterministic baseline deltas. It does not generate new answers or replace human relevance judgments.

## Live evaluation against your own corpus

Create a dataset with the same `version`, `name`, `k`, and `cases`, but provide only `id`, `businessId`, `query`, graded `relevance` document IDs from your database, and optional human-labelled saved `answer` objects. Stage fixture arrays are ignored in live mode.

```sh
# Requires DATABASE_URL and an ingested corpus, but no model key:
npm run eval -w backend -- --live --lexical --dataset eval/customer-golden.json --out eval/reports/live-lexical.json
# Uses your existing EMBED_* model, with no query rewrite or answer generation:
npm run eval -w backend -- --live --dataset eval/customer-golden.json --out eval/reports/live-hybrid.json
```

`--lexical` passes `dense: false` to retrieval, so the no-key live path never calls embeddings. `--judge` remains opt-in. Live runs execute real Postgres retrieval and context selection. Preserve database content, model configuration and relevance labels when comparing runs; retriever and dataset hashes alone do not identify the corpus or model. Report mode is checked when comparing baselines, preventing offline/live and lexical/hybrid mixes. Live database and provider evaluations have not been run for the checked-in sample reports.

To reproduce the original offline baseline from this branch's base commit without keeping duplicate production code:

```sh
git show HEAD:backend/src/services/retriever.js > /tmp/openglazed-before-retriever.js
npm run eval -w backend -- --retriever /tmp/openglazed-before-retriever.js --out eval/reports/before-reproduced.json
```

This command assumes the feature changes are uncommitted and HEAD is the original base. After committing, substitute the base commit SHA for HEAD.
