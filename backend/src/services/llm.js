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

async function chatStream(messages, { tools, toolChoice, onToken, temperature = 0.3, maxTokens = 1000, signal } = {}) {
  const stream = await chatClient.chat.completions.create(
    {
      model: chatCfg.model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: true,
      ...(tools && tools.length ? { tools, ...(toolChoice ? { tool_choice: toolChoice } : {}) } : {}),
    },
    signal ? { signal } : {}
  );

  let content = '';
  const calls = [];
  for await (const part of stream) {
    const delta = part.choices?.[0]?.delta || {};
    if (delta.content) {
      content += delta.content;
      if (onToken) onToken(delta.content);
    }
    for (const tc of delta.tool_calls || []) {
      const call = calls[tc.index] || (calls[tc.index] = { id: '', type: 'function', function: { name: '', arguments: '' } });
      if (tc.id) call.id = tc.id;
      if (tc.function?.name) call.function.name += tc.function.name;
      if (tc.function?.arguments) call.function.arguments += tc.function.arguments;
    }
  }
  return { content: content.trim(), toolCalls: calls.filter(Boolean) };
}

async function streamChat(prompt, opts = {}) {
  const { content } = await chatStream([{ role: 'user', content: prompt }], opts);
  return content;
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

module.exports = { chatComplete, chatStream, streamChat, embedTexts, embedQuery, chatCfg, embedCfg };
