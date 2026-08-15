'use strict';

// Single OpenAI-compatible client used for BOTH chat + embeddings.
// Pointing baseURL at Ollama/LocalAI/LM Studio makes us fully local.
// This replaces the three separate `new OpenAI(...)` instances that were
// hard-wired to the OpenAI API (and the 1536-dim assumption).

const OpenAI = require('openai');
const { chat: chatCfg, embed: embedCfg } = require('./modelConfig');

const chatClient = new OpenAI({ baseURL: chatCfg.baseURL, apiKey: chatCfg.apiKey });
const embedClient = new OpenAI({ baseURL: embedCfg.baseURL, apiKey: embedCfg.apiKey });

// Chat completion. Returns trimmed text. `opts.maxTokens` default 1000.
async function chatComplete(prompt, { temperature = 0.3, maxTokens = 1000, signal } = {}) {
  const response = await chatClient.chat.completions.create(
    {
      model: chatCfg.model,
      messages: [{ role: 'user', content: prompt }],
      temperature,
      max_tokens: maxTokens,
    },
    signal ? { signal } : {}
  );
  return (response.choices[0].message.content || '').trim();
}

// Embed a batch of texts → array of vectors (order preserved).
async function embedTexts(texts) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  const resp = await embedClient.embeddings.create({ model: embedCfg.model, input: texts });
  return resp.data.map((d) => d.embedding);
}

async function embedQuery(queryText) {
  const [vec] = await embedTexts([queryText]);
  return vec || null;
}

module.exports = { chatComplete, embedTexts, embedQuery, chatCfg, embedCfg };
