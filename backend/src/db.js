'use strict';

const path = require('path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Pool } = require('pg');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});

pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});

if (!process.env.DATABASE_URL) {
  console.error('[db] DATABASE_URL is not set. Point it at your Postgres (see docker-compose.yml).');
}

const businessCache = new Map();

function clearBusinessCache(businessId) {
  businessCache.delete(String(businessId));
}

async function getClient(businessId) {
  businessId = String(businessId);
  if (businessCache.has(businessId)) {
    return businessCache.get(businessId);
  }

  const { rows } = await pool.query('SELECT * FROM businesses WHERE id = $1', [businessId]);
  if (rows.length === 0) {
    throw new Error('Business not found');
  }

  businessCache.set(businessId, rows[0]);
  setTimeout(() => businessCache.delete(businessId), 5 * 60 * 1000).unref();
  return rows[0];
}

async function getClassificationContext(businessId) {
  const { rows } = await pool.query(
    `SELECT ARRAY(SELECT filename FROM documents WHERE business_id = $1 AND status = 'ready' ORDER BY id DESC LIMIT 20) AS filenames,
            (SELECT LEFT(content, 800) FROM summaries WHERE business_id = $1 AND level = 2 ORDER BY id DESC LIMIT 1) AS summary`,
    [businessId]
  );
  return rows[0];
}

async function updateClientStatus(businessId, status) {
  await pool.query('UPDATE businesses SET ingest_status = $1 WHERE id = $2', [status, businessId]);
  clearBusinessCache(businessId);
  return null;
}

async function updateIngestProgress(businessId, progress) {
  await pool.query('UPDATE businesses SET ingest_progress = $1 WHERE id = $2', [progress, businessId]);
  clearBusinessCache(businessId);
  return null;
}

async function saveMessage(businessId, sessionId, role, content, metadata = {}) {
  await pool.query(
    `INSERT INTO messages (business_id, session_id, role, content, confidence, escalated, source, channel, answer_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      businessId,
      sessionId,
      role,
      content,
      metadata.confidence ?? null,
      metadata.escalated ?? false,
      metadata.source ?? null,
      metadata.channel ?? 'widget',
      metadata.answer_status ?? null,
    ]
  );
  return null;
}

async function getHistory(businessId, sessionId, channel = 'widget', limit = 20) {
  const { rows } = await pool.query(
    `SELECT role, content, created_at FROM (
       SELECT role, content, created_at, id FROM messages
       WHERE business_id = $1 AND session_id = $2 AND channel = $3
       ORDER BY id DESC LIMIT $4
     ) t ORDER BY id ASC`,
    [businessId, sessionId, channel, limit]
  );
  return rows.map((r) => ({
    role: r.role === 'visitor' ? 'user' : 'assistant',
    content: r.content,
    created_at: r.created_at,
  }));
}

async function saveLead(businessId, sessionId, leadData) {
  await pool.query(
    `INSERT INTO leads (business_id, session_id, name, email, phone, intent, sentiment, key_question, follow_up_priority)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (business_id, session_id) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, leads.name),
       email = COALESCE(EXCLUDED.email, leads.email),
       phone = COALESCE(EXCLUDED.phone, leads.phone),
       intent = COALESCE(EXCLUDED.intent, leads.intent),
       sentiment = COALESCE(EXCLUDED.sentiment, leads.sentiment),
       key_question = COALESCE(EXCLUDED.key_question, leads.key_question),
       follow_up_priority = COALESCE(EXCLUDED.follow_up_priority, leads.follow_up_priority)`,
    [
      businessId,
      sessionId,
      leadData.name ?? null,
      leadData.email ?? null,
      leadData.phone ?? null,
      leadData.intent ?? null,
      leadData.sentiment ?? null,
      leadData.key_question ?? null,
      leadData.follow_up_priority ?? null,
    ]
  );
  return null;
}

async function getLeads(businessId, { limit = 100, priority = null } = {}) {
  const params = [businessId];
  let sql = 'SELECT * FROM leads WHERE business_id = $1';
  if (priority) {
    params.push(priority);
    sql += ` AND follow_up_priority = $${params.length}`;
  }
  sql += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1);
  params.push(limit);
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function getTranscripts(businessId, sessionId = null) {
  const params = [businessId];
  let sql = 'SELECT * FROM messages WHERE business_id = $1';
  if (sessionId) {
    params.push(sessionId);
    sql += ` AND session_id = $${params.length}`;
  }
  sql += ' ORDER BY created_at ASC';
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function getSessions(businessId, { channel = 'widget', limit = 50 } = {}) {
  const { rows } = await pool.query(
    `SELECT m.session_id,
            (ARRAY_AGG(m.content ORDER BY m.id) FILTER (WHERE m.role = 'visitor'))[1] AS title,
            COUNT(*)::int AS message_count,
            MAX(m.created_at) AS last_at,
            BOOL_OR(m.escalated) AS escalated,
            MAX(l.name) AS lead_name,
            MAX(l.email) AS lead_email
     FROM messages m
     LEFT JOIN leads l ON l.business_id = m.business_id AND l.session_id = m.session_id
     WHERE m.business_id = $1 AND m.channel = $2 AND m.session_id IS NOT NULL
     GROUP BY m.session_id
     ORDER BY last_at DESC
     LIMIT $3`,
    [businessId, channel, limit]
  );
  return rows;
}

async function getTopQuestions(businessId, days = 7) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { rows } = await pool.query(
    `SELECT content FROM messages
     WHERE business_id = $1 AND role = 'visitor' AND channel = 'widget' AND created_at >= $2
     ORDER BY created_at DESC`,
    [businessId, since]
  );
  return rows.map((r) => r.content);
}

async function getDashboardStats(businessId) {
  const [docs, convo, leads, latency, offTopic] = await Promise.all([
    pool.query("SELECT COUNT(*) FILTER (WHERE status = 'ready')::int AS c FROM documents WHERE business_id = $1", [businessId]),
    pool.query(`SELECT COUNT(*) FILTER (WHERE role = 'assistant' AND (answer_status IS NULL OR answer_status NOT IN ('smalltalk', 'blocked', 'off_topic')))::int AS answered,
                       COUNT(DISTINCT session_id)::int AS conversations,
                       COUNT(DISTINCT session_id) FILTER (WHERE role = 'assistant' AND answer_status = 'unanswered')::int AS unanswered
                FROM messages WHERE business_id = $1 AND channel IN ('widget', 'team', 'api') AND session_id IS NOT NULL`, [businessId]),
    pool.query('SELECT COUNT(*)::int AS c FROM leads WHERE business_id = $1', [businessId]),
    pool.query('SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50 FROM request_traces WHERE business_id = $1', [businessId]),
    pool.query("SELECT COUNT(*)::int AS c FROM inbox_items WHERE business_id = $1 AND status = 'off_topic'", [businessId]),
  ]);
  const { answered, conversations, unanswered } = convo.rows[0];
  const p50 = latency.rows[0].p50;
  return {
    documents: docs.rows[0].c,
    questionsAnswered: answered,
    conversations,
    unansweredRate: conversations > 0 ? unanswered / conversations : null,
    medianLatencyMs: p50 === null ? null : Math.round(Number(p50)),
    totalLeads: leads.rows[0].c,
    offTopic: offTopic.rows[0].c,
  };
}

async function createDocument(businessId, filename, sourceType) {
  const { rows } = await pool.query(
    'INSERT INTO documents (business_id, filename, source_type) VALUES ($1, $2, $3) RETURNING *',
    [businessId, filename, sourceType]
  );
  return rows[0];
}

async function updateDocument(id, { status, chunkCount = null, error = null }) {
  await pool.query(
    'UPDATE documents SET status = $2, chunk_count = COALESCE($3, chunk_count), error = $4 WHERE id = $1',
    [id, status, chunkCount, error]
  );
}

async function listDocuments(businessId) {
  const { rows } = await pool.query(
    'SELECT id, filename, source_type, status, chunk_count, error, created_at FROM documents WHERE business_id = $1 ORDER BY id DESC',
    [businessId]
  );
  return rows;
}

async function getDocument(businessId, id) {
  const { rows } = await pool.query('SELECT * FROM documents WHERE id = $1 AND business_id = $2', [id, businessId]);
  return rows[0] || null;
}

async function deleteDocument(businessId, id) {
  await pool.query('DELETE FROM chunks WHERE business_id = $1 AND source_ref = $2', [businessId, 'doc:' + id]);
  await pool.query('DELETE FROM documents WHERE id = $1 AND business_id = $2', [id, businessId]);
}

async function countChunksBySource(businessId, sourceRef) {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM chunks WHERE business_id = $1 AND source_ref = $2 AND level = 0', [businessId, sourceRef]);
  return rows[0].c;
}

const hashKey = (key) => crypto.createHash('sha256').update(key).digest('hex');

async function createApiKey(businessId, name) {
  const key = 'ogk_' + crypto.randomBytes(24).toString('base64url');
  const { rows } = await pool.query(
    'INSERT INTO api_keys (business_id, name, prefix, key_hash) VALUES ($1, $2, $3, $4) RETURNING id, name, prefix, created_at, last_used_at',
    [businessId, name, key.slice(0, 12), hashKey(key)]
  );
  return { ...rows[0], key };
}

async function listApiKeys(businessId) {
  const { rows } = await pool.query(
    'SELECT id, name, prefix, created_at, last_used_at FROM api_keys WHERE business_id = $1 AND revoked_at IS NULL ORDER BY id DESC',
    [businessId]
  );
  return rows;
}

async function revokeApiKey(businessId, id) {
  const { rowCount } = await pool.query(
    'UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND business_id = $2 AND revoked_at IS NULL',
    [id, businessId]
  );
  return rowCount > 0;
}

async function findApiKey(key) {
  const { rows } = await pool.query(
    'UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1 AND revoked_at IS NULL RETURNING id, business_id',
    [hashKey(key)]
  );
  return rows[0] || null;
}

async function insertBusiness(name, url) {
  const { rows } = await pool.query(
    'INSERT INTO businesses (name, url) VALUES ($1, $2) RETURNING *',
    [name, url]
  );
  return rows[0];
}

async function getBusinessById(businessId) {
  const { rows } = await pool.query('SELECT * FROM businesses WHERE id = $1', [businessId]);
  return rows[0] || null;
}

async function getBusinessProfileCols(businessId, cols) {
  const { rows } = await pool.query(`SELECT ${cols.join(', ')} FROM businesses WHERE id = $1`, [businessId]);
  return rows[0] || null;
}

async function updateBusiness(businessId, fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return null;
  const set = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const params = keys.map((k) => fields[k]);
  params.push(businessId);
  await pool.query(`UPDATE businesses SET ${set} WHERE id = $${params.length}`, params);
  clearBusinessCache(businessId);
  return null;
}

async function getBusinessStatusCols(businessId) {
  const { rows } = await pool.query(
    'SELECT ingest_status, ingest_progress FROM businesses WHERE id = $1',
    [businessId]
  );
  return rows[0] || {};
}

async function deleteChunksByBusiness(businessId) {
  await pool.query('DELETE FROM chunks WHERE business_id = $1', [businessId]);
}

async function getAllChunks(businessId) {
  const { rows } = await pool.query(
    'SELECT id, chunk_text AS content, source_url, embedding, token_count FROM chunks WHERE business_id = $1 AND level = 0',
    [businessId]
  );
  return rows.map((r) => ({
    id: r.id,
    content: r.content,
    source_url: r.source_url,
    embedding: r.embedding,
    token_count: r.token_count,
  }));
}

async function deleteChunksBySource(businessId, sourceRef) {
  await pool.query(
    'DELETE FROM chunks WHERE business_id = $1 AND source_ref = $2',
    [businessId, sourceRef]
  );
}

async function insertChunks(payload) {
  const inserted = [];
  for (const c of payload) {
    const emb = Array.isArray(c.embedding) ? `[${c.embedding.join(',')}]` : c.embedding ?? null;
    const { rows } = await pool.query(
      `INSERT INTO chunks (business_id, chunk_text, source_url, source_ref, chunk_index, level, token_count, embedding, content_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [c.business_id, c.chunk_text, c.source_url, c.source_ref ?? null, c.chunk_index, c.level, c.token_count, emb, c.content_hash ?? null]
    );
    inserted.push({ ...c, id: rows[0].id });
  }
  return inserted;
}

async function getStoredHashes(businessId, sourceRef) {
  const { rows } = await pool.query(
    'SELECT content_hash FROM chunks WHERE business_id = $1 AND source_ref = $2 AND content_hash IS NOT NULL',
    [businessId, sourceRef]
  );
  return new Set(rows.map((r) => r.content_hash));
}

async function deleteChunksBySourceExcept(businessId, sourceRef, keepHashes) {
  if (keepHashes.length === 0) {
    return deleteChunksBySource(businessId, sourceRef);
  }
  const { rowCount } = await pool.query(
    'DELETE FROM chunks WHERE business_id = $1 AND source_ref = $2 AND content_hash <> ALL($3)',
    [businessId, sourceRef, keepHashes]
  );
  return rowCount ?? 0;
}

async function deleteSummaries(businessId, level) {
  await pool.query('DELETE FROM summaries WHERE business_id = $1 AND level = $2', [businessId, level]);
}

async function insertSummaries(rows) {
  for (const s of rows) {
    const emb = Array.isArray(s.embedding) ? `[${s.embedding.join(',')}]` : s.embedding ?? null;
    await pool.query(
      `INSERT INTO summaries (business_id, level, cluster_id, content, embedding, source_chunk_ids)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [s.business_id, s.level, s.cluster_id ?? null, s.content, emb, s.source_chunk_ids ?? null]
    );
  }
}

async function insertEvalLog(fields) {
  const cols = Object.keys(fields);
  const vals = cols.map((c) => fields[c]);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  await pool.query(
    `INSERT INTO eval_logs (${cols.join(', ')}) VALUES (${placeholders})`,
    vals
  );
}

async function matchChunksFts(queryText, businessId, matchCount = 20) {
  const { rows } = await pool.query('SELECT * FROM match_chunks_fts($1, $2, $3)', [queryText, businessId, matchCount]);
  return rows;
}

async function matchChunks(queryEmbedding, businessId, level = 0, matchCount = 20) {
  const { rows } = await pool.query('SELECT * FROM match_chunks($1, $2, $3, $4)', [
    JSON.stringify(queryEmbedding),
    businessId,
    level,
    matchCount,
  ]);
  return rows;
}

async function matchSummaries(queryEmbedding, businessId, level, matchCount = 5) {
  const { rows } = await pool.query('SELECT * FROM match_summaries($1, $2, $3, $4)', [
    JSON.stringify(queryEmbedding),
    businessId,
    level,
    matchCount,
  ]);
  return rows;
}

async function plainFtsSearch(queryText, businessId, matchCount = 20) {
  const { rows } = await pool.query(
    `SELECT id, chunk_text AS content, level, source_url, cluster_id
     FROM chunks
     WHERE business_id = $1 AND level = 0 AND fts @@ websearch_to_tsquery('english', $2)
     ORDER BY ts_rank_cd(fts, websearch_to_tsquery('english', $2)) DESC
     LIMIT $3`,
    [businessId, queryText, matchCount]
  );
  return rows;
}

async function query(...args) {
  return pool.query(...args);
}

module.exports = {
  pool,
  clearBusinessCache,
  getClient,
  getClassificationContext,
  updateClientStatus,
  updateIngestProgress,
  saveMessage,
  saveLead,
  getLeads,
  getTranscripts,
  getHistory,
  getSessions,
  getTopQuestions,
  getDashboardStats,
  insertBusiness,
  getBusinessById,
  getBusinessProfileCols,
  updateBusiness,
  getBusinessStatusCols,
  deleteChunksByBusiness,
  deleteChunksBySource,
  getStoredHashes,
  deleteChunksBySourceExcept,
  getAllChunks,
  insertChunks,
  deleteSummaries,
  insertSummaries,
  insertEvalLog,
  matchChunksFts,
  matchChunks,
  matchSummaries,
  plainFtsSearch,
  query,
  getEmbeddingsForIds: async (ids, businessId) => {
    if (!Array.isArray(ids) || ids.length === 0) return new Map();
    const { rows } = await pool.query(
      'SELECT id, embedding FROM chunks WHERE id = ANY($1) AND embedding IS NOT NULL' +
        (businessId === undefined ? '' : ' AND business_id = $2'),
      businessId === undefined ? [ids] : [ids, businessId]
    );
    const parse = (e) => (typeof e === 'string' ? JSON.parse(e) : e);
    return new Map(rows.map((r) => [String(r.id), parse(r.embedding)]));
  },
  ensureSchema,
  createDocument,
  createApiKey,
  listApiKeys,
  revokeApiKey,
  findApiKey,
  updateDocument,
  listDocuments,
  getDocument,
  deleteDocument,
  countChunksBySource,
  ensureTraceSchema,
  saveRequestTrace,
  pruneRequestTraces,
  getRequestTraces,
  getRequestTrace,
};

async function ensureSchema(dim = 1536) {
  await ensureTraceSchema();
  await pool.query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS scope text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS greeting text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS accent_color text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS notify_email text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS notify_on_unanswered boolean NOT NULL DEFAULT true;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS answer_status text;
CREATE TABLE IF NOT EXISTS inbox_items (
  id bigserial PRIMARY KEY,
  business_id bigint NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  session_id text,
  channel text NOT NULL,
  status text NOT NULL,
  question text NOT NULL,
  answer text,
  reason text,
  notified_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inbox_items_business ON inbox_items(business_id, resolved_at, created_at DESC);
CREATE TABLE IF NOT EXISTS documents (
  id           BIGSERIAL PRIMARY KEY,
  business_id  BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,
  source_type  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued',
  chunk_count  INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_documents_business ON documents(business_id, id DESC);
CREATE TABLE IF NOT EXISTS api_keys (
  id            BIGSERIAL PRIMARY KEY,
  business_id   BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  prefix        TEXT NOT NULL,
  key_hash      TEXT NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_api_keys_business ON api_keys(business_id, id DESC);
`);
  const DIM = Number(dim) || 0;
  const current = await pool.query(
    "SELECT atttypmod AS m FROM pg_attribute WHERE attrelid = 'chunks'::regclass AND attname = 'embedding'"
  );
  const curDim = current.rows[0] && current.rows[0].m > 0 ? current.rows[0].m : 1536;

  await pool.query('ALTER TABLE chunks ADD COLUMN IF NOT EXISTS content_hash text;');
  await pool.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_business_source_hash ON chunks(business_id, source_ref, content_hash);'
  );
  await pool.query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'widget';");
  await pool.query('CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(business_id, channel, session_id);');
  await pool.query(`DO $$ BEGIN
    IF (SELECT data_type FROM information_schema.columns WHERE table_name = 'messages' AND column_name = 'confidence') <> 'text' THEN
      ALTER TABLE messages ALTER COLUMN confidence TYPE text;
    END IF;
  END $$;`);

  if (!DIM || curDim === DIM) return false;

  console.log(`[db] migrating vector dim ${curDim} -> ${DIM}`);
  await pool.query('DROP INDEX IF EXISTS chunks_embedding_idx;');
  await pool.query('DROP INDEX IF EXISTS summaries_embedding_idx;');
  await pool.query(`ALTER TABLE chunks ALTER COLUMN embedding TYPE vector(${DIM}) USING NULL;`);
  await pool.query(`ALTER TABLE summaries ALTER COLUMN embedding TYPE vector(${DIM}) USING NULL;`);
  await pool.query('DROP INDEX IF EXISTS chunks_embedding_idx;');
  await pool.query('DROP INDEX IF EXISTS summaries_embedding_idx;');
  await pool.query(`CREATE INDEX chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);`);
  await pool.query(`CREATE INDEX summaries_embedding_idx ON summaries USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);`);
  await pool.query('DROP FUNCTION IF EXISTS match_chunks(vector, bigint, int, int);');
  await pool.query('DROP FUNCTION IF EXISTS match_summaries(vector, bigint, int, int);');

  await pool.query(`
    CREATE OR REPLACE FUNCTION match_chunks(
      query_embedding vector(${DIM}), p_business_id bigint, p_level int DEFAULT 0, match_count int DEFAULT 20
    ) RETURNS TABLE (id bigint, content text, level int, source_url text, cluster_id int, similarity float)
    LANGUAGE plpgsql AS $$
    BEGIN
      RETURN QUERY SELECT c.id, c.chunk_text AS content, c.level, c.source_url, c.cluster_id,
        1 - (c.embedding <=> query_embedding) AS similarity
      FROM chunks c WHERE c.business_id = p_business_id AND c.level = p_level AND c.embedding IS NOT NULL
      ORDER BY c.embedding <=> query_embedding LIMIT match_count;
    END; $$;`);

  await pool.query(`
    CREATE OR REPLACE FUNCTION match_summaries(
      query_embedding vector(${DIM}), p_business_id bigint, p_level int, match_count int DEFAULT 5
    ) RETURNS TABLE (id bigint, content text, level int, cluster_id int, similarity float)
    LANGUAGE plpgsql AS $$
    BEGIN
      RETURN QUERY SELECT s.id, s.content, s.level, s.cluster_id,
        1 - (s.embedding <=> query_embedding) AS similarity
      FROM summaries s WHERE s.business_id = p_business_id AND s.level = p_level AND s.embedding IS NOT NULL
      ORDER BY s.embedding <=> query_embedding LIMIT match_count;
    END; $$;`);
  return true;
}

let traceSchemaPromise;
function ensureTraceSchema() {
  if (!traceSchemaPromise) {
    const sql = fs.readFileSync(path.resolve(__dirname, '../migrations/001_request_traces.sql'), 'utf8');
    traceSchemaPromise = pool.query(sql).catch((error) => { traceSchemaPromise = null; throw error; });
  }
  return traceSchemaPromise;
}

async function saveRequestTrace(trace, { days, maxPerBusiness }) {
  await ensureTraceSchema();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [trace.business_id]);
    await client.query(
      `INSERT INTO request_traces
       (id, business_id, session_id, surface, query, source, model, duration_ms, token_usage, stages, retrievals, final_context, errors)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [trace.id, trace.business_id, trace.session_id, trace.surface, trace.query, trace.source, trace.model,
        trace.duration_ms, JSON.stringify(trace.token_usage), JSON.stringify(trace.stages),
        JSON.stringify(trace.retrievals), JSON.stringify(trace.final_context), JSON.stringify(trace.errors)]
    );
    await client.query(
      `DELETE FROM request_traces WHERE business_id = $1 AND
       (created_at < now() - ($2 * interval '1 day') OR id IN (
         SELECT id FROM request_traces WHERE business_id = $1
         ORDER BY created_at DESC, id DESC OFFSET $3))`,
      [trace.business_id, days, maxPerBusiness]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function pruneRequestTraces(days, maxPerBusiness = 1000) {
  await ensureTraceSchema();
  await pool.query(
    `DELETE FROM request_traces WHERE created_at < now() - ($1 * interval '1 day')
     OR id IN (SELECT id FROM (
       SELECT id, row_number() OVER (PARTITION BY business_id ORDER BY created_at DESC, id DESC) AS position
       FROM request_traces) ranked WHERE position > $2)`, [days, maxPerBusiness]
  );
}

async function getRequestTraces(businessId, { limit = 50, before = null, days = 7 } = {}) {
  await ensureTraceSchema();
  const { rows } = await pool.query(
    `SELECT id, business_id, session_id, surface, query, source, model, duration_ms, token_usage,
            jsonb_array_length(errors) AS error_count, created_at
     FROM request_traces WHERE business_id = $1
       AND created_at >= now() - ($4 * interval '1 day')
       AND ($3::uuid IS NULL OR (created_at, id) < (
         SELECT created_at, id FROM request_traces WHERE business_id = $1 AND id = $3))
     ORDER BY created_at DESC, id DESC LIMIT $2`,
    [businessId, limit, before, days]
  );
  return rows;
}

async function getRequestTrace(businessId, traceId, days = 7) {
  await ensureTraceSchema();
  const { rows } = await pool.query(
    "SELECT * FROM request_traces WHERE business_id = $1 AND id = $2 AND created_at >= now() - ($3 * interval '1 day')",
    [businessId, traceId, days]
  );
  return rows[0] || null;
}
