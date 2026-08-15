# OpenGlazed

> **JTBD:** Give any business a website chat assistant they can **self-host and fully own** — running on their own models and data, with no API-key lock-in, no per-token bill, and no third party sitting between them and their customers.

OpenGlazed is an **open-source, local-first RAG assistant**. It runs the whole stack on your machine (Postgres + pgvector + Ollama) so customer conversations never leave your infra. Swap in OpenAI/LocalAI/LM Studio via one env var if you want, but the default needs zero external accounts.

A **hybrid retrieval pipeline** (dense + lexical + RAPTOR + rerank) — not a single vector lookup — grounds answers in your content, and every answer surfaces its citations so you can verify it.

- URL scraper (Cheerio) → semantic chunking → local Postgres + pgvector
- Embeddable chat widget (React + iframe) that shows the sources it used
- **BlendedRAG retrieval**: dense (pgvector) + BM25 (Postgres FTS) fused with Reciprocal Rank Fusion (RRF=60), a RAPTOR summary layer, and a local cosine rerank — all on by default, no extra services
- Generation + embeddings run **locally on Ollama** by default (no API key); OpenAI-compatible providers selectable via env
- Lead capture (name + email before chat) + dashboard for questions asked and leads captured
- Confidence gating: the response carries a `source` field (`model` vs `retriever`) so you can see whether it came from generation or retrieval fallback

## Tech stack

- **Backend:** Node.js / Express + node-postgres (`pg`)
- **Frontend:** React 19 + React Router + Vite
- Generation + retrieval default to **local Ollama** (no API key); OpenAI-compatible providers (LocalAI, LM Studio, OpenAI) selectable via env
- **Rerank:** local cosine rerank over the fused candidates by default (uses the vectors already in the DB); an external cross-encoder at `MODEL_API_URL` is an optional override
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
# Models run LOCALLY on Ollama by default (see docker-compose.yml) — no API key.
# To use OpenAI instead: set LLM_PROVIDER=openai, EMBED_PROVIDER=openai,
# OPENAI_API_KEY, and optionally OPENAI_BASE_URL.
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

OpenGlazed is **provider-agnostic** — it talks the OpenAI-compatible `/v1` API,
so it runs fully local with **no API key** via Ollama (bundled in
`docker-compose.yml`). Chat + embeddings default to local models.

```bash
# Default (local, no key):
#   ollama pull llama3.1 && ollama pull nomic-embed-text
LLM_PROVIDER=ollama
OLLAMA_CHAT_MODEL=llama3.1
EMBED_PROVIDER=ollama
OLLAMA_EMBED_MODEL=nomic-embed-text   # 768-dim

# Or use OpenAI (set a key):
# LLM_PROVIDER=openai
# EMBED_PROVIDER=openai
# OPENAI_API_KEY=sk-...
```

The vector schema auto-migrates to your embedding dim (`embedCfg.dim`), so
switching models (768 / 1024 / 1536 / 3072) needs no manual SQL.

Rerank runs by default as a local cosine pass over the fused candidates; set `MODEL_API_URL` to use an external cross-encoder instead.

## Product flow

1. Add business name + URL on frontend `/`
2. Backend scrapes and chunks the page content
3. Business content chunks are stored in the local Postgres + pgvector database for retrieval context
4. You receive iframe embed code and URL
5. Site visitor opens widget, submits name/email, and starts chat
6. Backend retrieves top chunks (dense + BM25 + RAPTOR) and generates an answer with a **local model** (Ollama by default)
7. Business sees all questions and captured leads on `/dashboard/:id`

## Main files

- `backend/src/db.js` node-postgres (pg) client + query helpers
- `backend/src/server.js` API routes + widget hosting
- `backend/src/ingest.js` scrape/chunk storage pipeline
- `backend/src/services/retriever.js` BlendedRAG retrieval (dense + BM25 + RAPTOR + rerank)
- `backend/public/widget.js` embeddable widget script
- `db/init.sql` PostgreSQL + pgvector schema (auto-applied by docker-compose)
- `frontend/src/App.jsx` React router setup
- `frontend/src/pages/Onboarding.jsx` business onboarding page
- `frontend/src/pages/Dashboard.jsx` per-business dashboard
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
6. **Rerank (optional)** — if `MODEL_API_URL`/reranker is available, the fused list is reranked via the `/rerank` endpoint; otherwise it falls back to RRF order.
7. **Confidence gate** — `assessConfidence` decides whether generation is allowed; the chat response carries a `source` (`model` vs `retriever`) so you can verify which path answered.

## Notes

- Database is local PostgreSQL + pgvector (via `docker compose up` + `db/init.sql`). No cloud account needed. Rerank is a local cosine pass by default; set `MODEL_API_URL` to override with a cross-encoder.
- Re-ingest is incremental: only changed/added chunks are re-embedded, unchanged chunks keep their embeddings, and deleted pages are purged (diffed by a content hash per source).
- Training/fine-tuning is out of scope — but generation and embeddings are **local-first**: defaults run on Ollama with no API key. Set `LLM_PROVIDER=openai` / `EMBED_PROVIDER=openai` to use OpenAI (or any OpenAI-compatible endpoint) instead.
