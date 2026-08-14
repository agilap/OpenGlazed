// Local-first data layer: node-postgres (pg) over a pgvector Postgres.
// Replaces the previous Supabase client. No external accounts required —
// point DATABASE_URL at the docker-compose Postgres (see db/init.sql).
'use strict';

const path = require('path');
const { Pool } = require('pg');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});

// Fail fast with a clear message if DATABASE_URL is missing.
if (!process.env.DATABASE_URL) {
  console.error('[db] DATABASE_URL is not set. Point it at your Postgres (see docker-compose.yml).');
}

const businessCache = new Map();

function clearBusinessCache(businessId) {
  businessCache.delete(businessId);
}

async function getClient(businessId) {
  if (businessCache.has(businessId)) {
    return businessCache.get(businessId);
  }

  const { rows } = await pool.query('SELECT * FROM businesses WHERE id = $1', [businessId]);
  if (rows.length === 0) {
    throw new Error('Business not found');
  }

  businessCache.set(businessId, rows[0]);
  setTimeout(() => businessCache.delete(businessId), 5 * 60 * 1000);
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
    `INSERT INTO messages (business_id, session_id, role, content, confidence, escalated, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      businessId,
      sessionId,
      role,
      content,
      metadata.confidence ?? null,
      metadata.escalated ?? false,
      metadata.source ?? null,
    ]
  );
  return null;
}

async function saveLead(businessId, sessionId, leadData) {
  await pool.query(
    `INSERT INTO leads (business_id, session_id, name, email, phone, intent, sentiment, key_question, follow_up_priority)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (business_id, session_id) DO UPDATE SET
       name = EXCLUDED.name,
       email = EXCLUDED.email,
       phone = EXCLUDED.phone,
       intent = EXCLUDED.intent,
       sentiment = EXCLUDED.sentiment,
       key_question = EXCLUDED.key_question,
       follow_up_priority = EXCLUDED.follow_up_priority`,
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

async function getSessions(businessId) {
  const { rows } = await pool.query(
    'SELECT DISTINCT session_id FROM messages WHERE business_id = $1 AND session_id IS NOT NULL ORDER BY session_id DESC',
    [businessId]
  );
  return rows.map((r) => r.session_id);
}

async function getTopQuestions(businessId, days = 7) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { rows } = await pool.query(
    `SELECT content FROM messages
     WHERE business_id = $1 AND role = 'visitor' AND created_at >= $2
     ORDER BY created_at DESC`,
    [businessId, since]
  );
  return rows.map((r) => r.content);
}

async function getDashboardStats(businessId) {
  const [leads, sessions, esc, asst, total] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS c FROM leads WHERE business_id = $1', [businessId]),
    pool.query('SELECT COUNT(DISTINCT session_id)::int AS c FROM messages WHERE business_id = $1 AND session_id IS NOT NULL', [businessId]),
    pool.query("SELECT COUNT(*)::int AS c FROM messages WHERE business_id = $1 AND role = 'assistant' AND escalated = true", [businessId]),
    pool.query("SELECT COUNT(*)::int AS c FROM messages WHERE business_id = $1 AND role = 'assistant'", [businessId]),
    pool.query('SELECT COUNT(*)::int AS c FROM messages WHERE business_id = $1', [businessId]),
  ]);

  const totalLeads = leads.rows[0].c;
  const distinctSessionCount = sessions.rows[0].c;
  const escalatedCount = esc.rows[0].c;
  const assistantTotalCount = asst.rows[0].c;
  const totalMessages = total.rows[0].c;

  const escalationRate = assistantTotalCount > 0 ? escalatedCount / assistantTotalCount : 0;
  const avgMessagesPerSession = distinctSessionCount > 0 ? totalMessages / distinctSessionCount : 0;

  return { totalLeads, totalConversations: distinctSessionCount, escalationRate, avgMessagesPerSession };
}

// ── Raw table access used by ingest.js / server.js ────────────────────────────

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

async function getBusinessUrl(businessId) {
  const { rows } = await pool.query('SELECT url FROM businesses WHERE id = $1', [businessId]);
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

async function getLatestTrainingJob(businessId) {
  const { rows } = await pool.query(
    `SELECT status, dataset_path, model_path, created_at, updated_at, error
     FROM training_jobs WHERE business_id = $1 ORDER BY id DESC LIMIT 1`,
    [businessId]
  );
  return rows[0] || null;
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

async function insertChunks(payload) {
  // payload: array of {business_id, chunk_text, source_url, chunk_index, level, token_count, embedding}
  const inserted = [];
  for (const c of payload) {
    const emb = Array.isArray(c.embedding) ? `[${c.embedding.join(',')}]` : c.embedding ?? null;
    const { rows } = await pool.query(
      `INSERT INTO chunks (business_id, chunk_text, source_url, chunk_index, level, token_count, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [c.business_id, c.chunk_text, c.source_url, c.chunk_index, c.level, c.token_count, emb]
    );
    inserted.push({ ...c, id: rows[0].id });
  }
  return inserted;
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

async function insertLeadDirect(businessId, name, email) {
  const { rows } = await pool.query(
    'INSERT INTO leads (business_id, name, email) VALUES ($1, $2, $3) RETURNING *',
    [businessId, name, email]
  );
  return rows[0];
}

async function insertChatSession(businessId, leadId, token) {
  await pool.query(
    'INSERT INTO chat_sessions (business_id, lead_id, session_token) VALUES ($1, $2, $3)',
    [businessId, leadId, token]
  );
}

async function getSessionByToken(token) {
  const { rows } = await pool.query('SELECT * FROM chat_sessions WHERE session_token = $1', [token]);
  return rows[0] || null;
}

async function insertQuestion(businessId, sessionId, question, answer) {
  await pool.query(
    'INSERT INTO questions (business_id, session_id, question, answer) VALUES ($1, $2, $3, $4)',
    [businessId, sessionId, question, answer]
  );
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

async function insertTrainingJob(fields) {
  const cols = Object.keys(fields);
  const vals = cols.map((c) => fields[c]);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  await pool.query(
    `INSERT INTO training_jobs (${cols.join(', ')}) VALUES (${placeholders})`,
    vals
  );
}

// ── Retrieval (calls the SQL functions defined in db/init.sql) ─────────────────

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

// Fallback plain FTS for BM25 branch (used when match_chunks_fts returns nothing).
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

module.exports = {
  pool,
  clearBusinessCache,
  getClient,
  updateClientStatus,
  updateIngestProgress,
  saveMessage,
  saveLead,
  getLeads,
  getTranscripts,
  getSessions,
  getTopQuestions,
  getDashboardStats,
  // raw access
  insertBusiness,
  getBusinessById,
  getBusinessUrl,
  getBusinessProfileCols,
  updateBusiness,
  getLatestTrainingJob,
  getBusinessStatusCols,
  deleteChunksByBusiness,
  insertChunks,
  deleteSummaries,
  insertSummaries,
  insertLeadDirect,
  insertChatSession,
  getSessionByToken,
  insertQuestion,
  insertEvalLog,
  insertTrainingJob,
  // retrieval
  matchChunksFts,
  matchChunks,
  matchSummaries,
  plainFtsSearch,
  // expose for ad-hoc scripts
  query: (text, params) => pool.query(text, params),
};
