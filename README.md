# OpenGlazed

> **JTBD:** Give any team a document assistant they can **self-host and fully own**: upload PDFs, Word files and notes, and get cited answers from them, running on their own models and data, with no API-key lock-in, no per-token bill, and no third party sitting between them and their customers.

OpenGlazed is an **open-source, self-hosted RAG agent**. Your data and conversations live in your own Postgres + pgvector; the model is **bring-your-own** — any OpenAI-compatible API (OpenAI, OpenRouter, Groq, Gemini, Anthropic, or a self-hosted vLLM/Ollama server), set by three env vars.

One agent, two surfaces: a shareable **chat widget** and an internal **team chat** for staff. Both remember conversations across reloads.

A **hybrid retrieval pipeline** (dense + lexical + RAPTOR + rerank) — not a single vector lookup — grounds answers in your content, and every answer surfaces its citations so you can verify it.

- URL scraper (Cheerio) → bounded semantic chunking → local Postgres + pgvector
- Embeddable chat widget (React + iframe) that shows the sources it used
- **Hybrid retrieval**: dense (pgvector) + lexical (Postgres FTS / `ts_rank_cd`) fused with Reciprocal Rank Fusion (RRF=60), optional overview summaries, and bounded context. No extra services; legacy cosine reranking is opt-in
- **Tool-calling agent**: the model decides when to search the knowledge base, capture a lead, or escalate to a human (falls back to plain RAG on providers without tool calling)
- **Persistent conversations**: history is stored server-side; the widget restores a visitor's chat on reload, and the dashboard lists recent conversations
- **Team chat** (`/team/:id`): staff ask the same agent about the business *and* customer activity (recent conversations, leads)
- Lead capture (form or agent tool) + dashboard of leads and conversations
- Confidence gating: the response carries a `source` field (`model` vs `retriever`) so you can see whether it came from generation or retrieval fallback

## Tech stack

- **Backend:** Node.js / Express + node-postgres (`pg`)
- **Frontend:** React 19 + React Router + Vite
- **Models:** any OpenAI-compatible API via the `openai` SDK (`LLM_*` / `EMBED_*` env vars)
- **Agent:** `backend/src/services/agent.js` — a small tool-calling loop, no framework
- **Ranking:** hybrid RRF by default; optional local cosine rerank using stored vectors
- **Database:** PostgreSQL + pgvector (runs locally via Docker — no cloud account needed)

## Project structure

- `backend/` Express API, scraping pipeline, chunk store, chat APIs
- `backend/src/services/embeddings.js` OpenAI embedding helper
- `docker-compose.yml` + `db/init.sql` — local Postgres + pgvector, auto-creates the schema
- `frontend/` React SPA (onboarding + dashboard)

## System prerequisites

- Node.js 20+ (recommended: current LTS)
- npm 10+
- Docker (for the local Postgres + pgvector database)

If npm is broken on your machine (for example `Cannot find module 'node:path'`), reset Node with nvm:

```bash
nvm install --lts
nvm use --lts
npm -v
```

## Database setup (local, no cloud account)

The project uses a local PostgreSQL + pgvector instance. `docker-compose.yml` boots it
and `db/init.sql` creates the schema + retrieval functions automatically on first start.

```bash
docker compose up -d        # Postgres + pgvector on localhost:55434
cp backend/.env.example backend/.env   # DATABASE_URL already points at the local DB
```

The default connection string is `postgresql://glazed:glazed@localhost:55434/glazed`.
To use a different Postgres, set `DATABASE_URL` in `backend/.env`.

## Install all npm packages

From project root:

```bash
npm install
```

This installs workspace dependencies for both `backend` and `frontend`.

## Environment config

Backend env file:

```bash
cp backend/.env.example backend/.env
# DATABASE_URL is pre-set to the local Docker Postgres.
# Set LLM_BASE_URL / LLM_API_KEY / LLM_MODEL to your model provider.
```

Frontend env file (optional — Vite proxies `/api` to backend in dev):

```bash
cp frontend/.env.example frontend/.env
```

## Run backend + frontend together

From project root:

```bash
npm run dev
```

App URLs:

- Frontend: `http://localhost:5173`
- Backend API: `http://localhost:3000`
- Iframe widget route: `http://localhost:5173/embed/:businessId`

## Environment: models

OpenGlazed is **model-agnostic**: it talks the OpenAI-compatible `/v1` API, so
any provider works with three env vars.

```bash
LLM_BASE_URL=https://api.openai.com/v1   # or OpenRouter, Groq, Gemini, Anthropic, vLLM...
LLM_API_KEY=sk-...
LLM_MODEL=gpt-4o-mini

# Embeddings default to the same provider. Override when your chat provider
# has no embeddings endpoint:
# EMBED_BASE_URL=https://api.openai.com/v1
# EMBED_API_KEY=sk-...
EMBED_MODEL=text-embedding-3-small
```

The agent uses tool calling. Providers or models without it fall back to the
plain retrieve-then-answer path automatically.

Keep the embedding model and dimension consistent with existing data. The existing schema helper attempts dimension changes, but populated vectors may reject an incompatible dimension; switching models requires a planned migration and re-ingestion. This upgrade does not rewrite existing vectors.

## Product flow

1. Sign up, name a workspace on `/`, and upload PDF, DOCX, Markdown, TXT, CSV or JSON files, or paste text
2. Each document is parsed (PDFs page by page), chunked and embedded; the list shows its status
3. Chunks are stored in the local Postgres + pgvector database for retrieval context
4. You receive the embed snippet, and can create API keys for your own apps
5. Anyone with the widget, or your app through the API, asks questions; widget conversations persist across reloads
6. The agent searches the knowledge base (dense + BM25 + RAPTOR) as needed, answers with citations, captures leads, or escalates
7. Business sees recent conversations and captured leads on `/dashboard/:id`, and asks its own questions in team chat at `/team/:id`

## Main files

- `backend/src/db.js` node-postgres (pg) client + query helpers
- `backend/src/server.js` API routes + widget hosting
- `backend/src/ingest.js` scrape/chunk storage pipeline
- `backend/src/services/agent.js` tool-calling agent loop (widget + team surfaces)
- `backend/src/services/retriever.js` BlendedRAG retrieval (dense + BM25 + RAPTOR + rerank)
- `backend/public/widget.js` embeddable widget script
- `db/init.sql` PostgreSQL + pgvector schema (auto-applied by docker-compose)
- `frontend/src/App.jsx` React router setup
- `frontend/src/pages/Onboarding.jsx` business onboarding page
- `frontend/src/pages/Dashboard.jsx` per-business dashboard (leads + recent conversations)
- `frontend/src/pages/TeamChat.jsx` internal team chat with persistent threads
- `frontend/src/components/EmbeddableWidget.jsx` React iframe widget UI
- `frontend/src/pages/EmbedWidgetPage.jsx` iframe widget route page

## Recommended datasets

Aligned with the sales-conversion JTBD (used only if you later fine-tune):

| Dataset | HuggingFace ID | Purpose |
|---|---|---|
| Bitext Customer Support | `bitext/Bitext-customer-support-llm-chatbot-training-dataset` | 27 intents: pricing, product info, complaints, refunds |
| E-Commerce FAQ | `NebulaByte/E-Commerce_FAQs` | Product explanation Q&A pairs |
| MS MARCO Passage | `ms_marco` (passage subset) | Question→passage retrieval patterns |
| UltraChat 200k | `HuggingFaceH4/ultrachat_200k` | Fluent multi-turn explanatory dialogue |
| SQuAD 2.0 | `rajpurkar/squad_v2` | Extractive QA + "I don't know" behaviour |

## Retrieval architecture

`backend/src/services/retriever.js` keeps the existing hybrid pipeline, with these fixes:

1. Every query searches source chunks. Explicit overview questions additionally search RAPTOR summaries; short factual questions no longer search summaries exclusively.
2. Dense pgvector retrieval embeds the original question. Lexical retrieval uses PostgreSQL English full-text search and `ts_rank_cd` (not BM25).
3. RRF (k=60) combines the rankings, using separate identities for source chunks and summaries, preserving per-stage scores. The old cosine-only rerank repeats the dense signal and can erase exact lexical matches, so it is now opt-in.
4. Context deduplicates normalized text and admits at most five chunks, 4,000 characters per chunk and 12,000 total. Overview text uses this same budget. Agent searches share a 24,000-character budget across turns in one request, with stable source labels.
5. Missing embeddings degrade to lexical retrieval. Missing optional rewrite/rerank capabilities preserve the original query or fused ranking. Empty results escalate; nonempty results receive an uncalibrated `medium` confidence rather than pretending RRF is a probability.

Chunking preserves short FAQ facts, paragraph boundaries, provenance and a heading-inclusive size bound. These changes apply on the next ingest/re-ingest; existing data stays intact. Character budgets approximate token usage and do not guarantee a particular model's token limit.

Optional backend environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `RAG_QUERY_REWRITE` | `false` | Plain-RAG fallback can expand the lexical query using the existing chat model; the original question still drives dense retrieval. The tool agent supplies its own focused search query. |
| `RAG_COSINE_RERANK` | `false` | Enable legacy cosine-only reranking for comparison; may reduce lexical relevance. No additional model required. |
| `LLM_STREAM_USAGE` | `false` | Request streaming token usage via `stream_options.include_usage`. Enable only for compatible providers. Unknown usage is stored as `null`, never estimated. |
| `TRACE_RETENTION_DAYS` | `7` | Maximum trace age, positive integer. |
| `TRACE_MAX_PER_BUSINESS` | `1000` | Maximum retained traces per bot, positive integer. |

## Evaluation

```bash
# Offline regression fixtures: no database or model/API key required
npm run eval -w backend -- --out eval/reports/after.json --baseline eval/reports/before.json
# Your real corpus, lexical retrieval only, no LLM or embedding key
npm run eval -w backend -- --live --lexical --dataset eval/customer-golden.json --out eval/reports/customer.json
```

The [golden dataset format and commands](backend/eval/README.md) cover hit rate/recall@k, MRR, nDCG, human-labelled faithfulness and citation metrics, and baseline comparisons. `--live` evaluates your actual corpus with your configured embeddings; `--judge` optionally scores saved answers with the existing chat provider. Neither is enabled by default. Reports include source/dataset hashes, selected IDs, per-case metrics and baseline deltas.

The checked-in [before/after results](backend/eval/reports/RESULTS.md) use eight synthetic regression/control fixtures and two annotated saved answers. Hit rate@5 improves 0.50 → 1.00, recall 0.375 → 0.9375, MRR 0.50 → 0.9375 and nDCG 0.390563 → 0.850284. The overview control regresses in nDCG (0.787155 → 0.337352); the exact-code answer reaches rank 2 rather than rank 1. These are orchestration regression results, not measured production relevance or generated-answer quality. Use representative customer questions and human judgments for deployment decisions.

## Local request traces

Each validated chat request records its query, raw stage candidates, dense/lexical/fused/rerank scores, selected context, model, available token usage, stage latency, source (`model`, `retriever`, or `error`) and errors in local Postgres. Scores unavailable for a stage are `null`. Structured logs carry request IDs and summaries; no telemetry service receives traces. Model calls still use the provider you configure in `LLM_*` / `EMBED_*`.

Existing databases receive the additive, idempotent `backend/migrations/001_request_traces.sql` automatically at startup and lazily before trace access. It can also be applied manually:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/migrations/001_request_traces.sql
```

`db/init.sql` includes the same additions for new databases. No existing rows or embeddings are dropped or rewritten by this migration. Startup/hourly cleanup removes expired traces and excess rows per bot; inserts also enforce age/count retention transactionally per bot. Reads exclude expired traces immediately. Cleanup requires the backend to be running; expiry is not an exact-time deletion guarantee. Existing messages and `eval_logs` have their existing lifecycle and are outside trace retention.

All trace endpoints require `Authorization: Bearer <ADMIN_TOKEN>` and scope every lookup, including pagination cursors, to the bot:

- `GET /api/dashboard/:businessId/traces?limit=50&before=<trace UUID>` — newest first, limit 1–100. Omit `before` for the first page; pass the last row's ID for the next page.
- `GET /api/dashboard/:businessId/traces/:traceId` — full trace; 404 when absent, expired or belonging to another bot.

Responses use `Cache-Control: no-store`. The existing installation-wide admin token grants access to every bot; it is not a per-tenant credential. Dashboard → **Traces** shows the most recent 25 requests and expandable details. Traces contain private conversations and retrieved documents; configure retention for your deployment.

## Embeddable widget

Existing snippets remain valid:

```html
<script src="https://chat.example.com/widget.js" data-business-id="123"></script>
```

Optional configuration:

```html
<script src="https://chat.example.com/widget.js"
  data-business-id="123"
  data-primary-color="#494bd6"
  data-theme="dark"
  data-position="left"
  data-greeting="How can we help?"
  data-app-url="https://app.example.com"></script>
```

The iframe defaults to the script's origin, so cross-domain embeds work behind a shared frontend/backend reverse proxy. For split hosting, set `data-app-url` to the frontend origin and configure `VITE_API_BASE` / backend CORS for that frontend. Colors accept six-digit hex; theme is `light` or `dark`; position is `left` or `right`. Direct iframes support `?color=%23494bd6&theme=dark&greeting=Hello`.

The launcher is dependency-free (about 5 KB unminified). The widget preserves partial streams, detects interrupted responses, offers explicit retry, displays numbered source links, supports mobile viewports and reduced motion, and returns focus on close/Escape. Untrusted model text is rendered as text; only HTTP(S) source URLs become links. Citation links expose retrieved sources and are not proof that every generated claim is supported. Retrying resends the question; it does not undo agent tool side effects.

## Notes

- Re-ingest is incremental: changed/added chunks are embedded; unchanged hashes retain their embeddings.
- English FTS, approximate chunk/token budgets, synthetic evaluation coverage, and model citation compliance remain limitations. Scanned PDFs without a text layer are rejected (no OCR). Uploads are limited to 18 MB per file, and documents are processed one at a time per workspace by an in-process queue, so run a single API instance.
- Existing sampled answer judging uses `EVAL_SAMPLE_RATE` (default 0.1); set `0` to disable those extra model calls. The repeatable eval harness is separate and offline by default.

## Developer API

Create a key in the dashboard's API section. Keys are scoped to one workspace, shown once, stored as SHA-256 hashes, and limited to 60 requests per minute. Send it as `Authorization: Bearer ogk_...`.

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `POST` | `/api/v1/ask` | `{ "question": "...", "sessionId": "optional" }` | `{ answer, citations: [{ index, source, excerpt }], unanswered, confidence, sessionId, traceId }` |
| `GET` | `/api/v1/documents` | | `{ documents: [...] }` |
| `POST` | `/api/v1/documents` | `{ "filename": "faq.md", "text": "..." }`, or `{ "filename": "policy.pdf", "data": "<base64>" }` for PDF and DOCX, or `{ "text": "..." }` to paste | `202 { document }` |
| `GET` | `/api/v1/documents/:id` | | `{ document }` with `status`: `queued`, `processing`, `ready` or `error` |
| `DELETE` | `/api/v1/documents/:id` | | `202` |

```bash
curl http://localhost:3000/api/v1/ask \
  -H "Authorization: Bearer $OPENGLAZED_KEY" \
  -H "Content-Type: application/json" \
  -d '{"question": "How long do customers have to request a refund?"}'
```

Pass the returned `sessionId` back to keep a conversation. `unanswered` is `true` when the documents don't cover the question; those count toward the dashboard's Unanswered rate. A model provider failure returns `502` with a `traceId` you can look up in the dashboard's traces.

## Accounts and local database

Open `/signup` to create an account, then sign in at `/login`. Each account can access the businesses it creates from its workspace. Sessions are stored in PostgreSQL and expire after seven days. The existing `ADMIN_TOKEN` remains available for administrative and legacy access; businesses created with that token do not automatically belong to an account.

The database is persisted in the `glazed_pgdata` Docker volume and is bound to localhost on port 55434 by default. Set `POSTGRES_PORT` when starting Compose to use a different host port, and update `DATABASE_URL` in `backend/.env` accordingly for a backend running outside Docker. Do not run database tests against data you need to retain: use a separate database initialized with `db/init.sql`.

For HTTPS deployments, set `COOKIE_SECURE=true` and configure `FRONTEND_ORIGIN` to the exact frontend origin. Account recovery and email verification are not yet implemented.
