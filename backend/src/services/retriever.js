'use strict';

const { generateQueryRewrite } = require('./generator');
const db = require('../db');
const { embedQuery } = require('./llm');
const { stage, recordRetrieval, recordError } = require('./traces');

function detectQueryLevel(query) {
  const normalized = (query || '').toLowerCase().trim();
  const overview = /\b(overview|summary|what do you (do|offer)|who are you|tell me about (your business|the company))\b/.test(normalized);
  return overview ? [0, 1, 2] : [0];
}

function normalizeResultRow(row, fallbackLevel = 0) {
  return {
    id: row?.id ?? null,
    content: row?.content || row?.chunk_text || row?.text || '',
    level: Number.isInteger(row?.level) ? row.level : fallbackLevel,
    source_url: row?.source_url || null,
    cluster_id: row?.cluster_id ?? null,
    similarity: Number.isFinite(row?.similarity) ? row.similarity : null,
    lexical_score: Number.isFinite(row?.rank) ? row.rank : null,
  };
}

async function embedQueryLocal(queryText) {
  return embedQuery(queryText);
}

async function queryBM25(queryText, businessId) {
  const safeQuery = (queryText || '').trim();
  if (!safeQuery) {
    return [];
  }

  const rows = await db.matchChunksFts(safeQuery, businessId, 20);
  if (rows.length > 0) {
    return rows.map((row) => normalizeResultRow(row, 0));
  }

  const plainRows = await db.plainFtsSearch(safeQuery, businessId, 20);
  if (plainRows.length === 0) {
    return [];
  }

  return plainRows.map((row) => normalizeResultRow(row, 0));
}

function mergeBm25Results(primary, secondary) {
  const merged = [];
  const seen = new Set();

  for (const list of [primary || [], secondary || []]) {
    for (const row of list) {
      const key = row.id !== null && row.id !== undefined
        ? `id:${row.level}:${row.id}`
        : `fallback:${row.content.slice(0, 120)}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(row);
    }
  }

  return merged;
}

function cosineSim(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length || !a.every(Number.isFinite) || !b.every(Number.isFinite)) return null;
  let dotP = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dotP += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? null : dotP / denom;
}

function reciprocalRankFusion(dense, bm25, k = 60) {
  const scoreMap = new Map();

  function addList(items, listName) {
    for (let rank = 0; rank < items.length; rank += 1) {
      const item = items[rank];
      const key = item.id !== null && item.id !== undefined
        ? `id:${item.level}:${item.id}`
        : `fallback:${item.level}:${item.content.slice(0, 120)}`;

      if (!scoreMap.has(key)) {
        scoreMap.set(key, {
          ...item,
          rrf_score: 0,
          dense_score: null,
          lexical_score: null,
          rerank_score: null,
          _sources: new Set(),
        });
      }

      const existing = scoreMap.get(key);
      if (existing._sources.has(listName)) continue;
      existing.rrf_score += 1 / (k + rank + 1);
      if (listName === 'dense') existing.dense_score = item.similarity;
      if (listName === 'bm25') existing.lexical_score = item.lexical_score;
      existing._sources.add(listName);
    }
  }

  addList(dense, 'dense');
  addList(bm25, 'bm25');

  return Array.from(scoreMap.values())
    .map((row) => ({
      ...row,
      source: Array.from(row._sources).join('+'),
      _sources: undefined,
    }))
    .sort((a, b) => b.rrf_score - a.rrf_score)
    .slice(0, 20);
}

function assessConfidence(topScore, chunkCount, queryLevels, reranked) {
  if (!chunkCount) return { confidence: 'low', shouldEscalate: true, reason: 'No chunks retrieved' };
  if (reranked && topScore < 0) return { confidence: 'low', shouldEscalate: true, reason: 'Negative cosine relevance' };
  return { confidence: 'medium', shouldEscalate: false, reason: null };
}

function assembleContext(candidates, { maxChunks = 5, maxChars = 12000, chunkChars = 4000 } = {}) {
  const selected = [];
  const seen = new Set();
  let remaining = maxChars;
  for (const candidate of candidates) {
    const content = (candidate.content || '').trim();
    const key = content.replace(/\s+/g, ' ').toLowerCase();
    if (!key || seen.has(key) || remaining <= 0 || selected.length >= maxChunks) continue;
    seen.add(key);
    const bounded = content.slice(0, Math.min(chunkChars, remaining));
    remaining -= bounded.length;
    selected.push({ ...candidate, content: bounded, context_truncated: bounded.length < content.length });
  }
  return selected;
}

async function retrieve(businessId, rawQuery, { rewrite = process.env.RAG_QUERY_REWRITE === 'true', dense = true, rerank = process.env.RAG_COSINE_RERANK === 'true', maxChunks = 5 } = {}) {
  const safeRawQuery = (rawQuery || '').trim();

  const rawLevels = detectQueryLevel(safeRawQuery);
  const rewritePromise = rewrite ? stage('query_rewrite', () => generateQueryRewrite(safeRawQuery)) : Promise.resolve(safeRawQuery);
  const rawBm25Promise = stage('lexical_raw', () => queryBM25(safeRawQuery, businessId));
  rawBm25Promise.catch(() => {});

  let rewrittenQuery = safeRawQuery;
  try {
    const rewritten = await rewritePromise;
    rewrittenQuery = (rewritten || safeRawQuery).trim();
  } catch (_error) {
    rewrittenQuery = safeRawQuery;
  }

  const levelsQueried = rawLevels;
  const rewrittenBm25Promise = rewrittenQuery !== safeRawQuery
    ? stage('lexical_rewrite', () => queryBM25(rewrittenQuery, businessId)) : Promise.resolve([]);

  let queryEmbedding = null;
  let bm25RawResults = [];
  let bm25RewriteResults = [];

  const [embedResult, bm25RawResult, bm25RewriteResult] = await Promise.allSettled([
    dense ? stage('query_embedding', () => embedQueryLocal(safeRawQuery)) : Promise.resolve(null),
    rawBm25Promise,
    rewrittenBm25Promise,
  ]);

  if (embedResult.status === 'fulfilled') {
    queryEmbedding = embedResult.value;
  } else {
    console.warn('[retriever] Query embedding failed:', embedResult.reason?.message || embedResult.reason);
  }

  if (bm25RawResult.status === 'fulfilled') {
    bm25RawResults = bm25RawResult.value || [];
  } else {
    console.warn('[retriever] BM25 raw-query retrieval failed:', bm25RawResult.reason?.message || bm25RawResult.reason);
    bm25RawResults = [];
  }

  if (bm25RewriteResult.status === 'fulfilled') {
    bm25RewriteResults = bm25RewriteResult.value || [];
  } else {
    console.warn('[retriever] BM25 rewritten-query retrieval failed:', bm25RewriteResult.reason?.message || bm25RewriteResult.reason);
    bm25RewriteResults = [];
  }

  const bm25Results = mergeBm25Results(bm25RawResults, bm25RewriteResults);

  if (!queryEmbedding) {
    console.warn('[retriever] Query embedding unavailable — skipping dense retrieval');
  }

  const densePromise = (async () => {
    if (!queryEmbedding) {
      return [];
    }

    const rpcCalls = [];
    const rpcMeta = [];

    if (levelsQueried.includes(0)) {
      rpcCalls.push(stage('dense_chunks', () => db.matchChunks(queryEmbedding, businessId, 0, 20)));
      rpcMeta.push(0);
    }

    if (levelsQueried.includes(1)) {
      rpcCalls.push(stage('dense_summary_1', () => db.matchSummaries(queryEmbedding, businessId, 1, 5)));
      rpcMeta.push(1);
    }

    if (levelsQueried.includes(2)) {
      rpcCalls.push(stage('dense_summary_2', () => db.matchSummaries(queryEmbedding, businessId, 2, 3)));
      rpcMeta.push(2);
    }

    if (rpcCalls.length === 0) {
      return [];
    }

    const settledDenseCalls = await Promise.allSettled(rpcCalls);
    const combined = [];

    for (let idx = 0; idx < settledDenseCalls.length; idx += 1) {
      const result = settledDenseCalls[idx];
      if (result.status !== 'fulfilled') {
        console.warn('[retriever] Dense sub-query failed:', result.reason?.message || result.reason);
        continue;
      }

      const rows = Array.isArray(result.value) ? result.value : [];
      const fallbackLevel = rpcMeta[idx];
      for (const row of rows) {
        combined.push(normalizeResultRow(row, row?.level ?? fallbackLevel));
      }
    }

    return combined.sort((a, b) => (b.similarity ?? -1) - (a.similarity ?? -1));
  })();

  const denseResult = await Promise.allSettled([densePromise]);
  const denseResults = denseResult[0].status === 'fulfilled' ? denseResult[0].value : [];

  if (denseResult[0].status === 'rejected') {
    console.warn('[retriever] Dense retrieval failed:', denseResult[0].reason?.message || denseResult[0].reason);
  }

  const fused = await stage('fusion', async () => reciprocalRankFusion(denseResults, bm25Results, 60));
  const raptorSummary = null;

  let rerankSucceeded = false;
  let rankedCandidates = fused;
  let top5 = assembleContext(fused, { maxChunks });
  let topScore = fused[0]?.rrf_score || 0;

  if (rerank && fused.length > 0 && !levelsQueried.includes(2)) {
    if (queryEmbedding) {
      try {
        const ids = fused.filter((row) => row.level === 0).map((row) => row.id).filter((id) => id != null);
        const embMap = await stage('rerank_embeddings', () => db.getEmbeddingsForIds(ids, businessId));
        const scored = fused
          .map((row) => ({
            ...row,
            rerank_score: row.level === 0 && embMap.has(String(row.id)) ? cosineSim(queryEmbedding, embMap.get(String(row.id))) : null,
          }))
          .sort((a, b) => (b.rerank_score ?? -1) - (a.rerank_score ?? -1) || b.rrf_score - a.rrf_score);
        rankedCandidates = scored;
        top5 = assembleContext(scored, { maxChunks });
        topScore = top5[0]?.rerank_score ?? 0;
        rerankSucceeded = scored.some((row) => Number.isFinite(row.rerank_score));
      } catch (error) {
        recordError(error, 'rerank');
        console.warn('[retriever] Local rerank failed:', error.message);
      }
    }
  }

  if (!rerankSucceeded) {
    top5 = assembleContext(fused, { maxChunks });
    topScore = fused[0]?.rrf_score || 0;
  }

  top5 = await stage('context_assembly', async () => assembleContext(rankedCandidates, { maxChunks }));
  const { confidence, shouldEscalate, reason } = assessConfidence(
    topScore,
    top5.length,
    levelsQueried,
    rerankSucceeded
  );

  const retrievalPath = {
    denseCount: denseResults.length,
    bm25Count: bm25Results.length,
    fusedCount: fused.length,
    reranked: rerankSucceeded,
    levelsQueried,
    topScore,
  };

  console.log(JSON.stringify({ event: 'retrieval', ...retrievalPath }));

  const result = {
    query: safeRawQuery,
    chunks: top5,
    candidates: rankedCandidates,
    stageCandidates: { dense: denseResults, lexicalRaw: bm25RawResults, lexicalRewrite: bm25RewriteResults },
    confidence,
    shouldEscalate,
    reason: reason || null,
    rewrittenQuery,
    raptorSummary,
    retrievalPath,
  };
  recordRetrieval(result);
  return result;
}

module.exports = { retrieve, detectQueryLevel, reciprocalRankFusion, assembleContext, cosineSim };
