'use strict';

// Embeddings now come from services/llm.js, which is provider-agnostic
// (Ollama/LocalAI/OpenAI). Kept as a thin re-export so existing require sites
// (ingest.js, retriever.js) don't need to change.

const { embedTexts, embedQuery } = require('./llm');
const { embed: embedCfg } = require('./modelConfig');

module.exports = { embedTexts, embedQuery, EMBED_DIM: embedCfg.dim, EMBED_MODEL: embedCfg.model };
