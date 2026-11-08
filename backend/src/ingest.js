'use strict';

const crypto = require('crypto');
const {
  updateClientStatus,
  updateIngestProgress,
  getStoredHashes,
  deleteChunksBySourceExcept,
  insertChunks,
} = require('./db');

const { embedTexts } = require('./services/llm');

function normalizeWhitespace(text) {
  return text
    .replace(/\r/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[ \u00A0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const CHUNK_TOKEN_BUDGET = 320;
const TOKENS_PER_CHAR = 0.25;

function estimateTokens(text) {
  return Math.ceil(text.length * TOKENS_PER_CHAR);
}

function splitToBudget(text, maxChars) {
  const pieces = [];
  let rest = text.trim();
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars + 1);
    const sentenceEnds = [...window.matchAll(/[.!?]\s+/g)];
    const sentenceEnd = sentenceEnds.at(-1);
    let cut = sentenceEnd ? sentenceEnd.index + 1 : window.lastIndexOf(' ');
    if (cut < maxChars / 2) cut = maxChars;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

function buildSemanticChunks(docs, businessId) {
  const chunks = [];
  const seen = new Set();
  const maxChars = CHUNK_TOKEN_BUDGET / TOKENS_PER_CHAR;

  for (const doc of docs) {
    const url = doc.url || null;
    const heading = normalizeWhitespace(doc.heading || '').slice(0, 240);
    const breadcrumb = heading ? `## ${heading}\n\n` : '';
    const bodyBudget = maxChars - breadcrumb.length;
    const paragraphs = (doc.content || '').split(/\n{2,}/)
      .map(normalizeWhitespace).filter(Boolean);
    let current = '';
    const flush = () => {
      if (!current) return;
      const content = breadcrumb + current;
      const key = JSON.stringify([url, content]);
      if (!seen.has(key)) {
        seen.add(key);
        chunks.push({
          content, level: 0, source_url: url, business_id: businessId,
          token_count: estimateTokens(content), heading: doc.heading || null,
        });
      }
      current = '';
    };
    for (const paragraph of paragraphs) {
      for (const piece of splitToBudget(paragraph, bodyBudget)) {
        if (current && current.length + 2 + piece.length > bodyBudget) flush();
        current += (current ? '\n\n' : '') + piece;
      }
    }
    flush();
  }
  return chunks;
}

async function attachChunkEmbeddings(chunks) {
  const batchSize = 50;

  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);

    const embeddings = await embedTexts(batch.map((chunk) => chunk.content));
    if (embeddings.length !== batch.length) throw new Error(`Embedding provider returned ${embeddings.length} vectors for ${batch.length} chunks.`);
    batch.forEach((chunk, idx) => {
      chunk.embedding = embeddings[idx] || null;
    });
  }

  return chunks;
}

function hashText(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

async function storeLevel0Chunks(chunks, businessId, sourceRef) {
  const existing = await getStoredHashes(businessId, sourceRef);
  const incoming = chunks.map((c) => hashText(c.content));
  const changed = new Set(incoming.filter((h) => !existing.has(h)));
  const unchanged = incoming.length - incoming.filter((h) => !existing.has(h)).length;
  const removed = await deleteChunksBySourceExcept(businessId, sourceRef, incoming);
  const toInsert = chunks.filter((c) => changed.has(hashText(c.content)));

  let insertedCount = 0;
  const batchSize = 100;
  for (let i = 0; i < toInsert.length; i += batchSize) {
    const batch = toInsert.slice(i, i + batchSize).map((chunk, idx) => ({
      business_id: businessId,
      chunk_text: chunk.content,
      source_url: chunk.source_url,
      source_ref: sourceRef,
      chunk_index: i + idx,
      level: 0,
      token_count: chunk.token_count,
      embedding: chunk.embedding || null,
      content_hash: hashText(chunk.content),
    }));
    const stored = await insertChunks(batch);
    insertedCount += stored.length;
  }

  return { added: insertedCount, unchanged, removed: Number(removed) || 0 };
}

async function ingestNormalized(sections, { businessId, sourceRef }) {
  try {
    await updateClientStatus(businessId, 'ingesting');
    await updateIngestProgress(businessId, 10);

    if (!sections.length) {
      throw new Error('No usable content extracted from source');
    }

    const fakePages = sections.map((s) => ({ url: s.url || sourceRef, content: s.content, heading: s.heading || null }));
    const level0Chunks = buildSemanticChunks(fakePages, businessId);
    await updateIngestProgress(businessId, 25);

    await attachChunkEmbeddings(level0Chunks);
    await updateIngestProgress(businessId, 40);

    const stored = await storeLevel0Chunks(level0Chunks, businessId, sourceRef);
    await updateIngestProgress(businessId, 55);

    await updateIngestProgress(businessId, 90);

    await updateClientStatus(businessId, 'active');
    await updateIngestProgress(businessId, 100);
    return { chunks: stored.added, unchanged: stored.unchanged, removed: stored.removed };
  } catch (error) {
    await updateClientStatus(businessId, 'error');
    throw error;
  }
}

async function reembedMissing() {
  const { query } = require('./db');
  let total = 0;
  let lastId = 0;
  for (;;) {
    const { rows } = await query('SELECT id, chunk_text AS text FROM chunks WHERE embedding IS NULL AND id > $1 ORDER BY id LIMIT 64', [lastId]);
    if (!rows.length) break;
    lastId = rows[rows.length - 1].id;
    const vectors = await embedTexts(rows.map((row) => row.text));
    for (let i = 0; i < rows.length; i += 1) {
      if (Array.isArray(vectors[i])) await query('UPDATE chunks SET embedding = $2 WHERE id = $1', [rows[i].id, `[${vectors[i].join(',')}]`]);
    }
    total += rows.length;
  }
  return total;
}


module.exports = { ingestNormalized, reembedMissing, storeLevel0Chunks, buildSemanticChunks };
