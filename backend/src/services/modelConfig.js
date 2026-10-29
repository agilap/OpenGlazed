'use strict';

const PROVIDERS = { openai: 'openai', ollama: 'ollama' };

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
