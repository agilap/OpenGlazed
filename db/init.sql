-- ═══════════════════════════════════════════════════════════════════════════════
-- Glazed — local Postgres (pgvector) init schema
-- Runs automatically from docker-compose on first boot (idempotent).
-- Plain PostgreSQL + pgvector only — NO Supabase / auth / RLS.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS vector;

-- ── Core tables ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS businesses (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  url         TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chunks (
  id           BIGSERIAL PRIMARY KEY,
  business_id  BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  chunk_text   TEXT NOT NULL,
  source_url   TEXT NOT NULL,
  chunk_index  INTEGER NOT NULL,
  topic        TEXT,
  heading      TEXT,
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS training_jobs (
  id            BIGSERIAL PRIMARY KEY,
  business_id   BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'queued',
  dataset_path  TEXT,
  model_path    TEXT,
  error         TEXT,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS leads (
  id                  BIGSERIAL PRIMARY KEY,
  business_id         BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  session_id          TEXT,
  name                TEXT,
  email               TEXT,
  phone               TEXT,
  intent              TEXT,
  sentiment           TEXT,
  key_question        TEXT,
  follow_up_priority  TEXT,
  created_at          TIMESTAMPTZ DEFAULT now(),
  UNIQUE (business_id, session_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id           BIGSERIAL PRIMARY KEY,
  business_id  BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  session_id   TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('visitor', 'assistant', 'system')),
  content      TEXT NOT NULL,
  confidence   FLOAT,
  escalated    BOOLEAN DEFAULT false,
  source       TEXT,
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id             BIGSERIAL PRIMARY KEY,
  business_id    BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  lead_id        BIGINT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  session_token  TEXT NOT NULL UNIQUE,
  created_at     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS questions (
  id           BIGSERIAL PRIMARY KEY,
  business_id  BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  session_id   BIGINT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  question     TEXT NOT NULL,
  answer       TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT now()
);

-- ── Upgrade: chunks ──────────────────────────────────────────────────────────
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS embedding vector(1536);
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS level integer DEFAULT 0;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS cluster_id integer;
-- source attribution: which input produced this chunk (url | md | pdf | csv | ...)
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS source_ref text;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (to_tsvector('english', chunk_text)) STORED;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS token_count integer;

-- ── Upgrade: businesses ──────────────────────────────────────────────────────
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS brand_tone text DEFAULT 'professional';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS key_cta text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS ingest_progress integer DEFAULT 0;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS ingest_status text DEFAULT 'pending';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS last_ingested_at timestamptz;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS primary_offering text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS industry         text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS pricing_model    text;

-- ── Summaries (RAPTOR) ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS summaries (
  id               BIGSERIAL PRIMARY KEY,
  business_id      BIGINT REFERENCES businesses(id) ON DELETE CASCADE,
  level            INTEGER NOT NULL,
  cluster_id       INTEGER,
  content          TEXT NOT NULL,
  embedding        vector(1536),
  source_chunk_ids BIGINT[],
  created_at       TIMESTAMPTZ DEFAULT now()
);

-- ── Eval logs ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS eval_logs (
  id                       BIGSERIAL PRIMARY KEY,
  business_id              BIGINT REFERENCES businesses(id) ON DELETE CASCADE,
  session_id               TEXT,
  query                    TEXT,
  answer                   TEXT,
  retrieved_chunks         JSONB,
  faithfulness_score       FLOAT,
  answer_relevance_score   FLOAT,
  context_precision_score  FLOAT,
  overall_score            FLOAT,
  flagged_hallucination    BOOLEAN DEFAULT false,
  created_at               TIMESTAMPTZ DEFAULT now()
);

-- ── Indexes ────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_chunks_business        ON chunks(business_id);
CREATE INDEX IF NOT EXISTS idx_chunks_topic           ON chunks(business_id, topic);
CREATE INDEX IF NOT EXISTS idx_training_jobs_business ON training_jobs(business_id);
CREATE INDEX IF NOT EXISTS idx_leads_business         ON leads(business_id);
CREATE INDEX IF NOT EXISTS idx_leads_session          ON leads(business_id, session_id);
CREATE INDEX IF NOT EXISTS idx_messages_business      ON messages(business_id);
CREATE INDEX IF NOT EXISTS idx_messages_session       ON messages(business_id, session_id);
CREATE INDEX IF NOT EXISTS idx_messages_role          ON messages(business_id, role);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_token    ON chat_sessions(session_token);
CREATE INDEX IF NOT EXISTS idx_questions_business     ON questions(business_id);
CREATE INDEX IF NOT EXISTS chunks_embedding_idx
  ON chunks USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS summaries_embedding_idx
  ON summaries USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS chunks_fts_idx ON chunks USING gin(fts);
CREATE INDEX IF NOT EXISTS idx_eval_logs_business ON eval_logs(business_id);
CREATE INDEX IF NOT EXISTS idx_eval_logs_session  ON eval_logs(session_id);
CREATE INDEX IF NOT EXISTS idx_summaries_business_level ON summaries(business_id, level);

-- ── Retrieval functions (called by the backend via pg) ────────────────────────
CREATE OR REPLACE FUNCTION match_chunks(
  query_embedding  vector(1536),
  p_business_id    bigint,
  p_level          int     DEFAULT 0,
  match_count      int     DEFAULT 20
)
RETURNS TABLE (
  id          bigint,
  content     text,
  level       int,
  source_url  text,
  cluster_id  int,
  similarity  float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.id,
    c.chunk_text           AS content,
    c.level,
    c.source_url,
    c.cluster_id,
    1 - (c.embedding <=> query_embedding) AS similarity
  FROM chunks c
  WHERE c.business_id = p_business_id
    AND c.level        = p_level
    AND c.embedding   IS NOT NULL
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

CREATE OR REPLACE FUNCTION match_chunks_fts(
  query_text    text,
  p_business_id bigint,
  match_count   int DEFAULT 20
)
RETURNS TABLE (
  id         bigint,
  content    text,
  source_url text,
  rank       float
)
LANGUAGE plpgsql
AS $$
DECLARE
  tsq tsquery;
BEGIN
  tsq := websearch_to_tsquery('english', query_text);

  RETURN QUERY
  SELECT
    c.id,
    c.chunk_text                                AS content,
    c.source_url,
    ts_rank_cd(c.fts, tsq)::float               AS rank
  FROM chunks c
  WHERE c.business_id = p_business_id
    AND c.level       = 0
    AND c.fts        @@ tsq
  ORDER BY ts_rank_cd(c.fts, tsq) DESC
  LIMIT match_count;
END;
$$;

CREATE OR REPLACE FUNCTION match_summaries(
  query_embedding vector(1536),
  p_business_id   bigint,
  p_level         int,
  match_count     int DEFAULT 5
)
RETURNS TABLE (
  id          bigint,
  content     text,
  level       int,
  cluster_id  int,
  similarity  float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    s.id,
    s.content,
    s.level,
    s.cluster_id,
    1 - (s.embedding <=> query_embedding) AS similarity
  FROM summaries s
  WHERE s.business_id = p_business_id
    AND s.level        = p_level
    AND s.embedding   IS NOT NULL
  ORDER BY s.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
