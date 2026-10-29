'use strict';

const { chatComplete } = require('./llm');

const MODEL_URL = process.env.MODEL_API_URL || 'http://localhost:8000';

function stripMarkdownFences(text) {
  return (text || '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}

function buildHistory(conversationHistory, businessName) {
  if (!Array.isArray(conversationHistory) || conversationHistory.length === 0) {
    return '';
  }

  return conversationHistory
    .map((message) => {
      const speaker = message.role === 'user' ? 'Visitor' : businessName;
      return `${speaker}: ${message.content}`;
    })
    .join('\n');
}

async function callLLM(prompt) {
  return chatComplete(prompt);
}

async function callLLMFallback(query, contextChunks) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(`${MODEL_URL}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        context_chunks: contextChunks,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Fallback generate failed (${response.status})`);
    }

    const data = await response.json();
    const text = typeof data.response === 'string'
      ? data.response.trim()
      : typeof data.answer === 'string'
        ? data.answer.trim()
        : '';

    if (!text) {
      throw new Error('Fallback returned empty response');
    }

    return {
      response: text,
      escalated: false,
      source: 'model-fallback',
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function generateAnswer({
  query,
  contextChunks,
  businessName,
  brandTone,
  conversationHistory,
  keyCta,
  raptorSummary,
}) {
  const safeBusinessName = businessName || 'Our team';
  const safeBrandTone = brandTone || 'professional';
  const safeKeyCta = keyCta || 'Contact our team to get started.';
  const safeContextChunks = Array.isArray(contextChunks) ? contextChunks : [];
  const historyText = buildHistory(conversationHistory || [], safeBusinessName);

  const prompt = [
    `You are ${safeBusinessName}'s intelligent sales assistant on their website.`,
    `Personality: ${safeBrandTone} — knowledgeable, helpful, never pushy.`,
    '',
    'STRICT RULES:',
    '1. Answer ONLY using information in CONTEXT below',
    '2. Think through context carefully before writing your answer',
    "3. If context partially answers → answer what you can, state what you don't have",
    '4. Never say "based on the context" — speak naturally as a representative',
    '5. Never mention competitors unless visitor explicitly asks',
    `6. If visitor shows buying intent → naturally end with: ${safeKeyCta}`,
    '7. Keep under 120 words unless question genuinely requires more',
    '8. If you cannot answer from context at all → respond with exactly:',
    '   [ESCALATE]: <one sentence on what is missing>',
    '',
    raptorSummary ? `BUSINESS OVERVIEW:\n${raptorSummary}\n` : '',
    'CONTEXT CHUNKS:',
    safeContextChunks.map((chunk, index) => `[${index + 1}] ${chunk}`).join('\n\n'),
    '',
    'CONVERSATION:',
    historyText,
    '',
    `Visitor: ${query}`,
    `${safeBusinessName}:`,
  ].join('\n');

  try {
    const text = await callLLM(prompt);

    if (/^\[ESCALATE\]/i.test(text)) {
      const reason = text.replace(/^\[ESCALATE\]\s*:\s*/i, '').trim();
      return {
        response: null,
        escalated: true,
        reason,
        source: 'model',
      };
    }

    return {
      response: text,
      escalated: false,
      source: 'model',
    };
  } catch (_llmError) {
    try {
      return await callLLMFallback(query, safeContextChunks);
    } catch (_fallbackError) {
      const fallbackText = safeContextChunks[0]
        ? `${safeContextChunks[0].slice(0, 280)}...`
        : null;

      return {
        response: fallbackText,
        escalated: safeContextChunks.length === 0,
        source: 'retriever-only',
      };
    }
  }
}

async function streamAnswer(
  { query, contextChunks, businessName, brandTone, conversationHistory, keyCta, raptorSummary },
  { onToken } = {}
) {
  const safeBusinessName = businessName || 'Our team';
  const safeBrandTone = brandTone || 'professional';
  const safeKeyCta = keyCta || 'Contact our team to get started.';
  const safeContextChunks = Array.isArray(contextChunks) ? contextChunks : [];
  const historyText = buildHistory(conversationHistory || [], safeBusinessName);

  const prompt = [
    `You are ${safeBusinessName}'s intelligent sales assistant on their website.`,
    `Personality: ${safeBrandTone} — knowledgeable, helpful, never pushy.`,
    '',
    'STRICT RULES:',
    '1. Answer ONLY using information in CONTEXT below',
    '2. Think through context carefully before writing your answer',
    "3. If context partially answers → answer what you can, state what you don't have",
    '4. Never say "based on the context" — speak naturally as a representative',
    '5. Never mention competitors unless visitor explicitly asks',
    `6. If visitor shows buying intent → naturally end with: ${safeKeyCta}`,
    '7. Keep under 120 words unless question genuinely requires more',
    '8. If you cannot answer from context at all → respond with exactly:',
    '   [ESCALATE]: <one sentence on what is missing>',
    '',
    raptorSummary ? `BUSINESS OVERVIEW:\n${raptorSummary}\n` : '',
    'CONTEXT CHUNKS:',
    safeContextChunks.map((chunk, index) => `[${index + 1}] ${chunk}`).join('\n\n'),
    '',
    'CONVERSATION:',
    historyText,
    '',
    `Visitor: ${query}`,
    `${safeBusinessName}:`,
  ].join('\n');

  const { streamChat } = require('./llm');
  let accumulated = '';

  const flush = (token) => {
    if (onToken) onToken(token);
  };

  try {
    accumulated = await streamChat(prompt, { onToken: flush });
  } catch (_err) {
    return { response: safeContextChunks[0] ? `${safeContextChunks[0].slice(0, 280)}...` : null, escalated: safeContextChunks.length === 0, source: 'retriever-only' };
  }

  if (/^\[ESCALATE\]/i.test(accumulated)) {
    const reason = accumulated.replace(/^\[ESCALATE\]\s*:\s*/i, '').trim();
    return { response: null, escalated: true, reason, source: 'model' };
  }

  return { response: accumulated, escalated: false, source: 'model' };
}

async function generateEscalationMessage({ query, missingInfo, businessName, brandTone }) {
  const safeBusinessName = businessName || 'Our team';
  const safeBrandTone = brandTone || 'professional';

  const prompt = [
    `You are ${safeBusinessName}'s chatbot. Visitor asked something you cannot answer accurately.`,
    "Respond warmly, acknowledge you don't have that detail, naturally ask for their email.",
    `Tone: ${safeBrandTone}. Under 60 words. Never guess.`,
    `Visitor question: ${query || ''}`,
    `Missing info: ${missingInfo || ''}`,
  ].join('\n');

  try {
    const response = await callLLM(prompt);
    return {
      response,
      escalated: true,
      source: 'model',
    };
  } catch (_error) {
    return {
      response: "Great question — I don't have that detail right now. Leave your email and our team will follow up with everything you need!",
      escalated: true,
      source: 'model',
    };
  }
}

async function generateQueryRewrite(rawQuery) {
  const prompt = [
    'Rewrite this visitor question into a clear retrieval query.',
    'Make implicit intent explicit. Add synonyms. Remove filler words.',
    'Under 30 words. Return ONLY the rewritten query.',
    `Original: ${rawQuery}`,
  ].join('\n');

  try {
    const rewritten = await callLLM(prompt);
    return rewritten || rawQuery;
  } catch (_error) {
    return rawQuery;
  }
}

async function extractLead(transcript) {
  const prompt = [
    'Extract lead details from this conversation and return ONLY valid JSON (no markdown):',
    '{',
    '  "name": string or null,',
    '  "email": string or null,',
    '  "phone": string or null,',
    '  "intent": "buying"|"researching"|"support"|"unclear",',
    '  "key_question": "one sentence",',
    '  "sentiment": "positive"|"neutral"|"frustrated",',
    '  "follow_up_priority": "high"|"medium"|"low"',
    '}',
    'Priority high if transcript mentions price, timeline, or buying signals.',
    `TRANSCRIPT: ${transcript}`,
  ].join('\n');

  try {
    const raw = await callLLM(prompt);
    const jsonText = stripMarkdownFences(raw);
    return JSON.parse(jsonText);
  } catch (_error) {
    return null;
  }
}

async function evaluateAnswer({ query, answer, chunks }) {
  const prompt = [
    'Evaluate this RAG answer and return ONLY valid JSON:',
    '{',
    '  "faithfulness": float 0-1,',
    '  "answer_relevance": float 0-1,',
    '  "context_precision": float 0-1,',
    '  "has_hallucination": boolean,',
    '  "reason": "one sentence"',
    '}',
    `QUERY: ${query}`,
    `ANSWER: ${answer}`,
    `CHUNKS: ${(chunks || []).join('\n---\n')}`,
  ].join('\n');

  try {
    const raw = await callLLM(prompt);
    const jsonText = stripMarkdownFences(raw);
    const parsed = JSON.parse(jsonText);

    return {
      faithfulness: typeof parsed.faithfulness === 'number' ? parsed.faithfulness : null,
      answer_relevance: typeof parsed.answer_relevance === 'number' ? parsed.answer_relevance : null,
      context_precision: typeof parsed.context_precision === 'number' ? parsed.context_precision : null,
      has_hallucination: typeof parsed.has_hallucination === 'boolean' ? parsed.has_hallucination : false,
      reason: typeof parsed.reason === 'string' ? parsed.reason : null,
    };
  } catch (_error) {
    return {
      faithfulness: null,
      answer_relevance: null,
      context_precision: null,
      has_hallucination: false,
    };
  }
}

module.exports = {
  generateAnswer,
  streamAnswer,
  generateEscalationMessage,
  generateQueryRewrite,
  extractLead,
  evaluateAnswer,
};
