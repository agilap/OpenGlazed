# OpenGlazed

> **JTBD:** Give any business a website chat assistant they can **self-host and fully own** — running on their own models and data, with no API-key lock-in, no per-token bill, and no third party sitting between them and their customers.

OpenGlazed is an **open-source, self-hosted RAG agent**. Your data and conversations live in your own Postgres + pgvector; the model is **bring-your-own** — any OpenAI-compatible API (OpenAI, OpenRouter, Groq, Gemini, Anthropic, or a self-hosted vLLM/Ollama server), set by three env vars.

One agent, two surfaces: a **website widget** for customers and an internal **team chat** for staff. Both remember conversations across reloads.

A **hybrid retrieval pipeline** (dense + lexical + RAPTOR + rerank) — not a single vector lookup — grounds answers in your content, and every answer surfaces its citations so you can verify it.

- URL scraper (Cheerio) → semantic chunking → local Postgres + pgvector
- Embeddable chat widget (React + iframe) that shows the sources it used
- **BlendedRAG retrieval**: dense (pgvector) + BM25 (Postgres FTS) fused with Reciprocal Rank Fusion (RRF=60), a RAPTOR summary layer, and a local cosine rerank — all on by default, no extra services
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
- **Rerank:** local cosine rerank over the fused candidates (uses the vectors already in the DB)
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
docker compose up -d        # Postgres + pgvector on localhost:5432
cp backend/.env.example backend/.env   # DATABASE_URL already points at the local DB
```

The default connection string is `postgresql://glazed:glazed@localhost:5432/glazed`.
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

The vector schema auto-migrates to your embedding dim, so switching embedding
models (768 / 1024 / 1536 / 3072) needs no manual SQL — but re-ingest afterwards.

## Product flow

1. Add business name + URL on frontend `/`
2. Backend scrapes and chunks the page content
3. Business content chunks are stored in the local Postgres + pgvector database for retrieval context
4. You receive iframe embed code and URL
5. Site visitor opens widget and chats; the conversation persists across reloads
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

## Retrieval architecture (BlendedRAG)

`backend/src/services/retriever.js` implements the hybrid pipeline:

1. **Query analysis** — `detectQueryLevel` classifies the question (lookup / explanatory / comparison) to bias retrieval.
2. **Dense retrieval** — pgvector `match_chunks` over embeddings (SQL function in `db/init.sql`).
3. **Lexical retrieval** — BM25 via Postgres FTS (`match_chunks_fts`), run on both the raw and a rewritten query, then merged.
4. **Reciprocal Rank Fusion** — dense + BM25 lists fused with RRF (k=60).
5. **RAPTOR layer** — the level-2 summary chunk (pre-built during ingestion) is surfaced as additional context.
6. **Rerank** — fused candidates are reranked by cosine similarity to the query embedding; falls back to RRF order if embeddings are unavailable.
7. **Confidence gate** — `assessConfidence` decides whether generation is allowed; the chat response carries a `source` (`model` vs `retriever`) so you can verify which path answered.

## Notes

- Database is self-hosted PostgreSQL + pgvector (via `docker compose up` + `db/init.sql`).
- Re-ingest is incremental: only changed/added chunks are re-embedded, unchanged chunks keep their embeddings, and deleted pages are purged (diffed by a content hash per source).
- Training/fine-tuning is out of scope. Only a sample of widget answers (`EVAL_SAMPLE_RATE`, default 10%) is scored by the LLM judge, to keep per-message cost down.
