# OpenGlazed

> **JTBD:** Convert website visitors into customers by clearly explaining our value, offerings, and credibility without requiring human intervention.

Business-specific website chat assistant with a **hybrid retrieval pipeline** (dense + lexical + RAPTOR + rerank) rather than a single vector lookup.

- URL scraper (Cheerio) → chunking → local Postgres + pgvector
- Embeddable chat widget via React + iframe
- **BlendedRAG retrieval**: dense (pgvector) + BM25 (Postgres FTS) fused with Reciprocal Rank Fusion (RRF=60), a RAPTOR level-2 summary layer, and optional cross-encoder rerank
- Generation via API key (OpenAI chat) — no self-hosted model server
- Embeddings via API key (OpenAI `text-embedding-3-small`, 1536-dim)
- Lead capture (name + email before chat)
- Dashboard for questions asked + leads captured
- Confidence gating: `source` field (`model` vs `retriever`) flags whether the answer came from generation or retrieval fallback

## Tech stack

- **Backend:** Node.js / Express + node-postgres (`pg`)
- **Frontend:** React 19 + React Router + Vite
- **Generation + embeddings:** OpenAI API (API key)
- **Rerank (optional):** cross-encoder via `MODEL_API_URL` if set; otherwise skipped
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
# DATABASE_URL is pre-set to the local Docker Postgres; set OPENAI_API_KEY for generation
# Optional: MODEL_API_URL and FRONTEND_EMBED_ORIGIN
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

## Environment: API keys

Generation and embeddings are API-first — no self-hosted model server.

```bash
# backend/.env — set your OpenAI key
OPENAI_API_KEY=sk-...            # used for chat generation + embeddings
# optional rerank: if you run a cross-encoder rerank service, point to it:
# MODEL_API_URL=http://localhost:8000
```

`text-embedding-3-small` (1536-dim) is used for embeddings; `gpt-4o-mini` for answers.
Rerank is skipped unless `MODEL_API_URL` is set.

## Product flow

1. Add business name + URL on frontend `/`
2. Backend scrapes and chunks the page content
3. Business content chunks are stored in the local Postgres + pgvector database for retrieval context
4. You receive iframe embed code and URL
5. Site visitor opens widget, submits name/email, and starts chat
6. Backend retrieves top chunks (dense + BM25 + RAPTOR) and generates an answer via the API key
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

- Database is local PostgreSQL + pgvector (via `docker compose up` + `db/init.sql`). No cloud account needed. The rerank step is **optional**: without `MODEL_API_URL`, the backend still answers from retrieval (fallback).
- Chat response includes `source` (`model` or `retriever`) so you can verify which path answered.
- Training/fine-tuning is out of scope — generation and embeddings are API-first (OpenAI key). The optional `MODEL_API_URL` is only for a cross-encoder rerank service.