// API-first embeddings: OpenAI embeddings via the project API key.
// Replaces the old self-hosted model-server /embed endpoint.
'use strict';

const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const EMBED_MODEL = process.env.EMBED_MODEL || 'text-embedding-3-small'; // 1536-dim

// Embed a batch of texts. Returns an array of vectors (one per input text).
async function embedTexts(texts) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  const resp = await openai.embeddings.create({
    model: EMBED_MODEL,
    input: texts,
  });
  // OpenAI returns embeddings in the same order as input.
  return resp.data.map((d) => d.embedding);
}

// Embed a single query text.
async function embedQuery(queryText) {
  const [vec] = await embedTexts([queryText]);
  return vec || null;
}

module.exports = { embedTexts, embedQuery, EMBED_MODEL };
