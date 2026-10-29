'use strict';

const { generateQueryRewrite } = require('./generator');
const db = require('../db');
const { embedQuery } = require('./llm');

function detectQueryLevel(query) {
  const vaguePatterns = [
    'what do you do',
    'what do you',
    'what does this',
    'what is this',
    'tell me about',
    'give me an overview',
    'explain what',
    'what can you',
    'about you',
    'about this',
    'who are you',
    'what do you offer',
    'overview',
    'summary',
    'what are you',
    'what is',
    'what is your',
    'describe your',
    'what does your',
    'explain your',
  ];

  const normalized = (query || '').toLowerCase().trim();
  const wordCount = normalized ? normalized.split(/\s+/).length : 0;
  const isVague = vaguePatterns.some((pattern) => normalized.includes(pattern)) || wordCount <= 6;

  return isVague ? [1, 2] : [0];
}

function normalizeResultRow(row, fallbackLevel = 0) {
  return {
    id: row?.id ?? null,
    content: row?.content || row?.chunk_text || row?.text || '',
    level: Number.isInteger(row?.level) ? row.level : fallbackLevel,
    source_url: row?.source_url || null,
    cluster_id: row?.cluster_id ?? null,
    similarity: typeof row?.similarity === 'number' ? row.similarity : null,
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
    console.log('[retriever] FTS no results for: ' + safeQuery);
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
        ? `id:${row.id}`
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
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0) return 0;
  let dotP = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dotP += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dotP / denom;
}

function reciprocalRankFusion(dense, bm25, k = 60) {
  const scoreMap = new Map();

  function addList(items, listName) {
    for (let rank = 0; rank < items.length; rank += 1) {
      const item = items[rank];
      const key = item.id !== null && item.id !== undefined
        ? `id:${item.id}`
        : `fallback:${item.level}:${item.content.slice(0, 120)}`;

      if (!scoreMap.has(key)) {
        scoreMap.set(key, {
          ...item,
          rrf_score: 0,
          _sources: new Set(),
        });
      }

      const existing = scoreMap.get(key);
      existing.rrf_score += 1 / (k + rank + 1);
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
  if (chunkCount === 0) {
    return {
      confidence: 'low',
      shouldEscalate: true,
      reason: 'No chunks retrieved',
    };
  }

  if (reranked) {
    if (topScore < 0.0) {
      return { confidence: 'low', shouldEscalate: true, reason: `Low relevance: ${topScore.toFixed(3)}` };
    }
    if (topScore < 0.25) {
      return { confidence: 'medium', shouldEscalate: false, reason: null };
    }
    return { confidence: 'high', shouldEscalate: false, reason: null };
  }

  if (!reranked && Array.isArray(queryLevels) && queryLevels.includes(2)) {
    return {
      confidence: 'medium',
      shouldEscalate: false,
      reason: null,
    };
  }

  const threshold = Array.isArray(queryLevels) && queryLevels.includes(2) ? -5.0 : -3.0;

  if (topScore < threshold) {
    return {
      confidence: 'low',
      shouldEscalate: true,
      reason: `Low relevance: ${topScore.toFixed(3)}`,
    };
  }

  if (topScore < 0) {
    return {
      confidence: 'medium',
      shouldEscalate: false,
      reason: null,
    };
  }

  return {
    confidence: 'high',
    shouldEscalate: false,
    reason: null,
  };
}

async function retrieve(businessId, rawQuery, { rewrite = true } = {}) {
  const safeRawQuery = (rawQuery || '').trim();

  const rawLevels = detectQueryLevel(safeRawQuery);
  const rewritePromise = rewrite ? generateQueryRewrite(safeRawQuery) : Promise.resolve(safeRawQuery);
  const rawBm25Promise = queryBM25(safeRawQuery, businessId);

  let rewrittenQuery = safeRawQuery;
  try {
    const rewritten = await rewritePromise;
    rewrittenQuery = (rewritten || safeRawQuery).trim();
  } catch (_error) {
    rewrittenQuery = safeRawQuery;
  }

  const levelsQueried = rawLevels;
  const rewrittenBm25Promise = queryBM25(rewrittenQuery || safeRawQuery, businessId);

  let queryEmbedding = null;
  let bm25RawResults = [];
  let bm25RewriteResults = [];

  const [embedResult, bm25RawResult, bm25RewriteResult] = await Promise.allSettled([
    embedQueryLocal(rewrittenQuery),
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
      rpcCalls.push(db.matchChunks(queryEmbedding, businessId, 0, 20));
      rpcMeta.push(0);
    }

    if (levelsQueried.includes(1)) {
      rpcCalls.push(db.matchSummaries(queryEmbedding, businessId, 1, 5));
      rpcMeta.push(1);
    }

    if (levelsQueried.includes(2)) {
      rpcCalls.push(db.matchSummaries(queryEmbedding, businessId, 2, 3));
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

    return combined;
  })();

  const denseResult = await Promise.allSettled([densePromise]);
  const denseResults = denseResult[0].status === 'fulfilled' ? denseResult[0].value : [];

  if (denseResult[0].status === 'rejected') {
    console.warn('[retriever] Dense retrieval failed:', denseResult[0].reason?.message || denseResult[0].reason);
  }

  if (denseResults.length === 0 && levelsQueried.includes(2) && queryEmbedding) {
    try {
      const fallback = await db.matchChunks(queryEmbedding, businessId, 0, 20);

      if (Array.isArray(fallback) && fallback.length > 0) {
        denseResults.push(...fallback.map((row) => normalizeResultRow(row, 0)));
      }
    } catch (error) {
      console.warn('[retriever] Dense fallback to level 0 failed:', error.message || error);
    }
  }

  const fused = reciprocalRankFusion(denseResults, bm25Results, 60);
  const raptorSummary = denseResults.find((row) => row.level === 2)?.content || null;

  let rerankSucceeded = false;
  let top5 = fused.slice(0, 5);
  let topScore = fused[0]?.rrf_score || 0;

  if (fused.length > 0 && !levelsQueried.includes(2)) {
    if (queryEmbedding) {
      try {
        const ids = fused.map((row) => row.id).filter((id) => id != null);
        const embMap = await db.getEmbeddingsForIds(ids);
        const scored = fused
          .map((row) => ({
            ...row,
            rerank_score: embMap.has(row.id) ? cosineSim(queryEmbedding, embMap.get(row.id)) : 0,
          }))
          .sort((a, b) => b.rerank_score - a.rerank_score);
        top5 = scored.slice(0, 5);
        topScore = top5[0]?.rerank_score ?? 0;
        rerankSucceeded = true;
      } catch (error) {
        console.warn('[retriever] Local rerank failed:', error.message);
      }
    }
  }

  if (!rerankSucceeded) {
    top5 = fused.slice(0, 5);
    topScore = fused[0]?.rrf_score || 0;
  }

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

  console.log('[retriever] retrievalPath', retrievalPath);

  return {
    chunks: top5,
    confidence,
    shouldEscalate,
    reason: reason || null,
    rewrittenQuery,
    raptorSummary,
    retrievalPath,
  };
}

module.exports = { retrieve };
