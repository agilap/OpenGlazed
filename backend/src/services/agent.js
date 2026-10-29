'use strict';

const db = require('../db');
const { chatStream } = require('./llm');
const { retrieve } = require('./retriever');
const { streamAnswer, generateEscalationMessage } = require('./generator');

const MAX_STEPS = Number(process.env.AGENT_MAX_STEPS) || 4;

const fn = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});

const limitParam = { limit: { type: 'integer', description: 'How many to return (max 50)' } };

const TOOLS = {
  search_knowledge: fn(
    'search_knowledge',
    "Search the business's knowledge base (website pages, docs, FAQs). Use before answering any question about the business.",
    { query: { type: 'string', description: 'A focused search query' } },
    ['query']
  ),
  capture_lead: fn(
    'capture_lead',
    'Save the visitor\'s contact details as soon as they share an email or phone number.',
    {
      name: { type: 'string' },
      email: { type: 'string' },
      phone: { type: 'string' },
      intent: { type: 'string', enum: ['buying', 'researching', 'support', 'unclear'] },
      key_question: { type: 'string', description: 'One sentence: what the visitor wants' },
    }
  ),
  escalate: fn(
    'escalate',
    'Hand the conversation to a human when the knowledge base cannot answer.',
    { reason: { type: 'string', description: 'What information is missing' } },
    ['reason']
  ),
  recent_conversations: fn('recent_conversations', 'List recent customer conversations from the website widget.', limitParam),
  recent_leads: fn('recent_leads', 'List recent leads captured by the website widget.', limitParam),
};

const SURFACE_TOOLS = {
  widget: ['search_knowledge', 'capture_lead', 'escalate'],
  team: ['search_knowledge', 'recent_conversations', 'recent_leads'],
};

function systemPrompt(surface, business) {
  const name = business.name || 'the business';
  if (surface === 'team') {
    return [
      `You are the internal assistant for the ${name} team. Staff use you to look up facts about the business and to understand customer activity.`,
      '- Use search_knowledge for facts about the business. Use recent_conversations and recent_leads for customer activity.',
      '- Be direct and concise. Mention source URLs when you rely on knowledge results.',
      "- If the tools don't have the answer, say so plainly. Never invent facts.",
    ].join('\n');
  }
  return [
    `You are ${name}'s assistant on their website. Tone: ${business.brand_tone || 'professional'} — knowledgeable, helpful, never pushy.`,
    '- Use search_knowledge before answering questions about the business. Answer ONLY from what it returns; never guess.',
    "- If results partly answer, answer what you can and say what you don't have.",
    '- When the visitor shares an email or phone number, call capture_lead.',
    "- If the knowledge base can't answer, call escalate, then tell the visitor warmly and ask for their email.",
    `- If the visitor shows buying intent, end with: ${business.key_cta || 'Get in touch'}`,
    '- Speak naturally as a representative; never say "based on the context". Never mention competitors unless asked.',
    '- Keep answers under 120 words unless the question genuinely needs more.',
  ].join('\n');
}

function parseArgs(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_err) {
    return {};
  }
}

const clampLimit = (n) => Math.min(Math.max(Number(n) || 10, 1), 50);

async function runTool(name, args, ctx, state) {
  if (!SURFACE_TOOLS[ctx.surface].includes(name)) return `Unknown tool: ${name}`;

  switch (name) {
    case 'search_knowledge': {
      const r = await ctx.retrieve(ctx.businessId, String(args.query || ctx.message), { rewrite: false });
      state.chunks.push(...r.chunks);
      state.confidence = r.confidence;
      if (r.chunks.length === 0) return 'No matching content in the knowledge base.';
      return r.chunks
        .map((c, i) => `[${i + 1}] (${c.source_url || 'knowledge base'}) ${c.content}`)
        .join('\n\n');
    }
    case 'capture_lead': {
      if (!args.email && !args.phone) return 'Not saved: need an email or phone number.';
      await ctx.saveLead(ctx.businessId, ctx.sessionId, {
        name: args.name || null,
        email: args.email || null,
        phone: args.phone || null,
        intent: args.intent || null,
        key_question: args.key_question || null,
        follow_up_priority: args.intent === 'buying' ? 'high' : null,
      });
      return 'Lead saved.';
    }
    case 'escalate':
      state.escalated = true;
      return 'Escalated to the team. Tell the visitor someone will follow up, and ask for their email if you do not have it.';
    case 'recent_conversations':
      return JSON.stringify(await db.getSessions(ctx.businessId, { channel: 'widget', limit: clampLimit(args.limit) }));
    case 'recent_leads':
      return JSON.stringify(await db.getLeads(ctx.businessId, { limit: clampLimit(args.limit) }));
    default:
      return `Unknown tool: ${name}`;
  }
}

function buildCitations(chunks) {
  const citations = [];
  const seen = new Set();
  for (const ch of chunks) {
    if (citations.length >= 3) break;
    const src = ch.source_url || (ch.level === 2 ? 'business summary' : 'knowledge base');
    if (seen.has(src)) continue;
    seen.add(src);
    citations.push({ content: (ch.content || '').slice(0, 240), source: src, level: ch.level });
  }
  return citations;
}

async function runPlainRag({ businessId, business, history, message, emit, retrieveFn }) {
  const r = await retrieveFn(businessId, message);
  const base = { confidence: r.confidence, chunks: r.chunks, citations: [] };
  const escalation = async (missingInfo) => {
    const esc = await generateEscalationMessage({
      query: message,
      missingInfo: missingInfo || 'Insufficient content',
      businessName: business.name,
      brandTone: business.brand_tone || 'professional',
    });
    emit(esc.response);
    return esc.response;
  };

  if (r.shouldEscalate) {
    return { ...base, response: await escalation(r.reason), escalated: true, source: 'escalation' };
  }

  const gen = await streamAnswer(
    {
      query: message,
      contextChunks: r.chunks.map((c) => c.content),
      businessName: business.name,
      brandTone: business.brand_tone || 'professional',
      conversationHistory: history,
      keyCta: business.key_cta || 'Get in touch',
      raptorSummary: r.raptorSummary,
    },
    { onToken: emit }
  );

  if (gen.escalated) {
    return { ...base, response: await escalation(gen.reason), escalated: true, source: 'model-escalation' };
  }
  if (gen.source === 'retriever-only' && gen.response) emit(gen.response);
  return { ...base, response: gen.response, escalated: false, source: gen.source, citations: buildCitations(r.chunks) };
}

async function runAgent({ businessId, business, surface = 'widget', sessionId, history = [], message, onToken, deps = {} }) {
  const chat = deps.chat || chatStream;
  const retrieveFn = deps.retrieve || retrieve;
  const ctx = { businessId, sessionId, surface, message, retrieve: retrieveFn, saveLead: deps.saveLead || db.saveLead };
  const tools = SURFACE_TOOLS[surface].map((n) => TOOLS[n]);
  const state = { chunks: [], escalated: false, confidence: null };

  let shown = '';
  const emit = (t) => {
    shown += t;
    if (onToken) onToken(t);
  };

  const messages = [
    { role: 'system', content: systemPrompt(surface, business) },
    ...history.map(({ role, content }) => ({ role, content })),
    { role: 'user', content: message },
  ];

  try {
    for (let step = 0; step < MAX_STEPS; step += 1) {
      const last = step === MAX_STEPS - 1;
      const sep = shown ? '\n\n' : '';
      let first = true;
      const { content, toolCalls } = await chat(messages, {
        tools,
        toolChoice: last ? 'none' : undefined,
        onToken: (t) => { emit(first ? sep + t : t); first = false; },
      });

      if (last || toolCalls.length === 0) break;

      messages.push({ role: 'assistant', content: content || null, tool_calls: toolCalls });
      for (const call of toolCalls) {
        let result;
        try {
          result = await runTool(call.function.name, parseArgs(call.function.arguments), ctx, state);
        } catch (err) {
          result = `Tool failed: ${err.message}`;
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: String(result) });
      }
    }
  } catch (err) {
    if (shown || ![400, 404, 422].includes(err.status)) throw err;
    console.warn('[agent] provider rejected tool calling, using plain RAG:', err.message);
    return runPlainRag({ businessId, business, history, message, emit, retrieveFn });
  }

  if (!shown.trim()) emit("Sorry, I couldn't put an answer together. Could you rephrase that?");

  return {
    response: shown.trim(),
    escalated: state.escalated,
    source: 'agent',
    confidence: state.confidence,
    citations: state.escalated ? [] : buildCitations(state.chunks),
    chunks: state.chunks,
  };
}

module.exports = { runAgent, SURFACE_TOOLS };
