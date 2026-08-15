'use strict';

// Resolves which model backend to use for chat + embeddings.
// Local-first default: Ollama (OpenAI-compatible /v1 endpoint).
// Set LLM_PROVIDER=openai / EMBED_PROVIDER=openai to use the API instead.
//
// Any OpenAI-compatible server works as "local": Ollama, LocalAI, LM Studio,
// vLLM — they all expose /v1/chat/completions and /v1/embeddings.

const PROVIDERS = { openai: 'openai', ollama: 'ollama' };

// Per-model embedding dims. EMBED_DIM env overrides (used when you swap models).
const EMBED_DIMS = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
  'nomic-embed-text': 768,
  'bge-m3': 1024,
};

function resolveChat() {
  const provider = (process.env.LLM_PROVIDER || 'ollama').toLowerCase();
  if (provider === PROVIDERS.openai) {
    return {
      provider: 'openai',
      baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      apiKey: process.env.OPENAI_API_KEY || 'sk-no-key',
      model: process.env.CHAT_MODEL || 'gpt-4o-mini',
    };
  }
  // ollama (default) — OpenAI-compatible /v1 endpoint
  return {
    provider: 'ollama',
    baseURL: (process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1').replace(/\/$/, ''),
    apiKey: process.env.OLLAMA_API_KEY || 'ollama',
    model: process.env.OLLAMA_CHAT_MODEL || 'llama3.1',
  };
}

function resolveEmbed() {
  const provider = (process.env.EMBED_PROVIDER || 'ollama').toLowerCase();
  let model;
  let baseURL;
  let apiKey;

  if (provider === PROVIDERS.openai) {
    model = process.env.EMBED_MODEL || 'text-embedding-3-small';
    baseURL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    apiKey = process.env.OPENAI_API_KEY || 'sk-no-key';
  } else {
    model = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
    baseURL = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1').replace(/\/$/, '');
    apiKey = process.env.OLLAMA_API_KEY || 'ollama';
  }

  const dim = Number(process.env.EMBED_DIM) || EMBED_DIMS[model] || 1536;
  return { provider, model, baseURL, apiKey, dim };
}

const chat = resolveChat();
const embed = resolveEmbed();

module.exports = { chat, embed, EMBED_DIMS };
