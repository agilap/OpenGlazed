'use strict';

const OpenAI = require('openai');
const { chat: chatCfg, embed: embedCfg } = require('./modelConfig');

const chatClient = new OpenAI({ baseURL: chatCfg.baseURL, apiKey: chatCfg.apiKey });
const embedClient = new OpenAI({ baseURL: embedCfg.baseURL, apiKey: embedCfg.apiKey });

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

async function streamChat(prompt, { onToken, temperature = 0.3, maxTokens = 1000, signal } = {}) {
  const stream = await chatClient.chat.completions.create(
    {
      model: chatCfg.model,
      messages: [{ role: 'user', content: prompt }],
      temperature,
      max_tokens: maxTokens,
      stream: true,
    },
    signal ? { signal } : {}
  );

  let full = '';
  for await (const part of stream) {
    const delta = part.choices?.[0]?.delta?.content;
    if (delta) {
      full += delta;
      if (onToken) onToken(delta);
    }
  }
  return full.trim();
}

async function embedTexts(texts) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  const resp = await embedClient.embeddings.create({ model: embedCfg.model, input: texts });
  return resp.data.map((d) => d.embedding);
}

async function embedQuery(queryText) {
  const [vec] = await embedTexts([queryText]);
  return vec || null;
}

module.exports = { chatComplete, streamChat, embedTexts, embedQuery, chatCfg, embedCfg };
