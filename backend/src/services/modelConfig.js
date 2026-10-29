'use strict';

const EMBED_DIMS = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
  'nomic-embed-text': 768,
  'bge-m3': 1024,
};

const trim = (url) => url.replace(/\/$/, '');

const chat = {
  baseURL: trim(process.env.LLM_BASE_URL || 'https://api.openai.com/v1'),
  apiKey: process.env.LLM_API_KEY || 'no-key',
  model: process.env.LLM_MODEL || 'gpt-4o-mini',
};

const embedModel = process.env.EMBED_MODEL || 'text-embedding-3-small';
const embed = {
  baseURL: trim(process.env.EMBED_BASE_URL || chat.baseURL),
  apiKey: process.env.EMBED_API_KEY || chat.apiKey,
  model: embedModel,
  dim: Number(process.env.EMBED_DIM) || EMBED_DIMS[embedModel] || 1536,
};

module.exports = { chat, embed, EMBED_DIMS };
