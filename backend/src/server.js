require('dotenv').config()
'use strict';

const path    = require('path');
const express = require('express');
const cors    = require('cors');
const { v4: uuidv4 } = require('uuid');

const {
  generateAnswer,
  streamAnswer,
  generateEscalationMessage,
  extractLead,
  evaluateAnswer,
} = require('./services/generator');
const { retrieve }  = require('./services/retriever');
const db            = require('./db');
const { runIngest, ingestNormalized } = require('./ingest');
const { ingestSource, SUPPORTED } = require('./sources');

const app  = express();
const port = process.env.PORT || 3000;

const allowedOrigin = process.env.FRONTEND_ORIGIN       || 'http://localhost:5173';
const embedOrigin   = process.env.FRONTEND_EMBED_ORIGIN || allowedOrigin;

// ── Admin auth ──────────────────────────────────────────────────
// Protected endpoints (dashboard data, ingest, source ingestion, business
// creation) require `Authorization: Bearer <ADMIN_TOKEN>`. If ADMIN_TOKEN is
// unset we generate a random one at boot and log it, so the deployment is never
// silently open. The public chat widget endpoints stay unauthenticated.
let ADMIN_TOKEN = process.env.ADMIN_TOKEN;
if (!ADMIN_TOKEN) {
  ADMIN_TOKEN = require('crypto').randomBytes(24).toString('hex');
  console.log('[auth] ADMIN_TOKEN not set — generated ephemeral token: ' + ADMIN_TOKEN);
}

function requireAdmin(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (token && token === ADMIN_TOKEN) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

app.use(cors({ origin: allowedOrigin }));
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE 1 — Request logger
// ─────────────────────────────────────────────────────────────────────────────

app.use(function (req, res, next) {
  var start = Date.now();
  res.on('finish', function () {
    console.log(req.method + ' ' + req.path + ' ' + res.statusCode + ' ' + (Date.now() - start) + 'ms');
  });
  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE 2 — Prompt injection guard  (applied to /api/chat/* only)
// ─────────────────────────────────────────────────────────────────────────────

function injectionGuard(req, res, next) {
  var text = ((req.body && req.body.message) || '').toLowerCase();
  var patterns = [
    'ignore previous instructions', 'ignore all instructions',
    'you are now', 'pretend you are', 'act as if',
    'jailbreak', 'dan mode', 'your new instructions',
    'forget everything', 'new persona', 'system prompt',
    'disregard your',
  ];
  if (patterns.some(function (p) { return text.includes(p); })) {
    console.warn('INJECTION_DETECTED', {
      businessId: req.params.businessId,
      sessionId:  req.body && req.body.sessionId,
      ip:         req.ip,
    });
    return res.status(400).json({
      error: 'Invalid input',
      code:  'INJECTION_DETECTED',
    });
  }
  next();
}

app.use('/api/chat', injectionGuard);

// =============================================================================
// BUSINESSES
// =============================================================================

app.post('/api/businesses', requireAdmin, async function (req, res) {
  var name = req.body.name;
  var url  = req.body.url;

  if (!name || !url) {
    return res.status(400).json({ error: 'name and url are required' });
  }

  var business = await db.insertBusiness(name, url);

  if (!business) {
    return res.status(500).json({ error: 'failed to create business' });
  }

  res.json({
    businessId: business.id,
    status: 'ingesting',
    embedScript: '<script src="' + req.protocol + '://' + req.get('host') + '/widget.js" data-business-id="' + business.id + '"></script>',
    embedIframe: '<iframe src="' + embedOrigin + '/embed/' + business.id + '" width="360" height="560" style="border:0;position:fixed;right:20px;bottom:20px;z-index:999999;border-radius:12px;" title="' + name + ' assistant"></iframe>',
  });

  runIngest(business.id, url).catch(function (err) {
    console.error('Background ingest failed for business', business.id, err.message);
  });
});

app.get('/api/businesses/:id', async function (req, res) {
  var business = await db.getBusinessById(req.params.id);

  if (!business) {
    return res.status(404).json({ error: 'business not found' });
  }

  var training = await db.getLatestTrainingJob(req.params.id);

  return res.json({ business: business, training: training });
});

app.get('/api/businesses/:id/dashboard', requireAdmin, async function (req, res) {
  var businessId = Number(req.params.id);

  var business = await db.getBusinessById(businessId);
  if (!business) return res.status(404).json({ error: 'business not found' });

  var qCount = (await db.query('SELECT COUNT(*)::int AS c FROM questions WHERE business_id = $1', [businessId])).rows[0].c;
  var lCount = (await db.query('SELECT COUNT(*)::int AS c FROM leads WHERE business_id = $1', [businessId])).rows[0].c;
  var rqRes  = await db.query('SELECT question, answer, created_at FROM questions WHERE business_id = $1 ORDER BY id DESC LIMIT 20', [businessId]);
  var rlRes  = await db.query('SELECT name, email, created_at FROM leads WHERE business_id = $1 ORDER BY id DESC LIMIT 20', [businessId]);
  var trRes  = await db.getLatestTrainingJob(businessId);

  return res.json({
    business:        business,
    totals:          { questions: qCount || 0, leads: lCount || 0 },
    recentQuestions: rqRes.rows || [],
    recentLeads:     rlRes.rows || [],
    training:        trRes,
  });
});

// =============================================================================
// INGEST
// =============================================================================

app.post('/api/ingest/:businessId', requireAdmin, async function (req, res) {
  var businessId = req.params.businessId;
  var business = await db.getBusinessUrl(businessId);
  if (!business) return res.status(404).json({ error: 'Business not found' });

  res.json({ status: 'started', message: 'Ingest triggered' });
  runIngest(businessId, business.url).catch(function (err) {
    console.error('Re-ingest failed for business', businessId, err.message);
  });
});

app.get('/api/ingest/:businessId/status', async function (req, res) {
  var data = await db.getBusinessStatusCols(req.params.businessId);

  res.json({
    status:          data.ingest_status  || 'unknown',
    ingest_progress: data.ingest_progress || 0,
  });
});

// ── Multi-source ingestion (md / paste / csv / json / sitemap; pdf/docx stubbed)
// Body: { sourceType: 'markdown'|'paste'|'csv'|'json'|'sitemap'|'pdf'|'docx',
//         text?: string, url?: string, filename?: string }
app.post('/api/sources/:businessId', requireAdmin, async function (req, res) {
  var businessId = Number(req.params.businessId);
  var business = await db.getBusinessById(businessId);
  if (!business) return res.status(404).json({ error: 'Business not found' });

  var { sourceType, text, url, filename } = req.body || {};
  if (!SUPPORTED.includes(sourceType)) {
    return res.status(400).json({ error: 'Unsupported sourceType', supported: SUPPORTED });
  }

  res.json({ status: 'started', message: 'Source ingest triggered' });

  ingestSource(businessId, sourceType, { text, url, filename })
    .then((r) => console.log('[sources]', sourceType, '->', r))
    .catch(function (err) {
      console.error('[sources] ingest failed for', businessId, sourceType, err.message);
    });
});

// =============================================================================
// CHAT
// =============================================================================

/* ── Legacy session-token start ─────────────────────────────────── */
app.post('/api/chat/start', async function (req, res) {
  var businessId = req.body.businessId;
  var name       = req.body.name;
  var email      = req.body.email;

  if (!businessId || !name || !email) {
    return res.status(400).json({ error: 'businessId, name, email are required' });
  }

  var business = await db.getBusinessById(businessId);
  if (!business) return res.status(404).json({ error: 'business not found' });

  var lead = await db.insertLeadDirect(businessId, name, email);
  if (!lead) return res.status(500).json({ error: 'failed to create lead' });

  var token = uuidv4();
  await db.insertChatSession(businessId, lead.id, token);

  return res.json({ sessionToken: token });
});

/* ── PRIMARY chat endpoint ─────────────────────────────────────── */
app.post('/api/chat/:businessId', async function (req, res) {
  var businessId          = req.params.businessId;
  var message             = req.body.message;
  var sessionId           = req.body.sessionId;
  var conversationHistory = req.body.conversationHistory || [];

  if (!message || !sessionId) {
    return res.status(400).json({ error: 'message and sessionId are required' });
  }

  try {
    var business = await db.getClient(businessId);

    var retrieval      = await retrieve(businessId, message);
    var chunks         = retrieval.chunks;
    var confidence     = retrieval.confidence;
    var shouldEscalate = retrieval.shouldEscalate;
    var reason         = retrieval.reason;
    var rewrittenQuery = retrieval.rewrittenQuery;
    var raptorSummary  = retrieval.raptorSummary;

    var response, escalated, source;

    if (shouldEscalate) {
      var escResult = await generateEscalationMessage({
        query:        message,
        missingInfo:  reason || 'Insufficient content',
        businessName: business.name,
        brandTone:    business.brand_tone || 'professional',
      });
      response  = escResult.response;
      escalated = true;
      source    = 'escalation';
    } else {
      var genResult = await generateAnswer({
        query:               message,
        contextChunks:       chunks.map(function (c) { return c.content; }),
        businessName:        business.name,
        brandTone:           business.brand_tone || 'professional',
        conversationHistory: conversationHistory,
        keyCta:              business.key_cta || 'Get in touch',
        raptorSummary:       raptorSummary,
      });

      if (genResult.escalated) {
        var gemEsc = await generateEscalationMessage({
          query:        message,
          missingInfo:  genResult.reason || 'Insufficient content',
          businessName: business.name,
          brandTone:    business.brand_tone || 'professional',
        });
        response  = gemEsc.response;
        escalated = true;
        source    = 'model-escalation';
      } else {
        response  = genResult.response;
        escalated = false;
        source    = genResult.source;
      }
    }

    // Build citations from the retrieved (reranked) chunks so the widget can
    // show which passages backed the answer. Deduped by source, capped at 3.
    var citations = [];
    var seenSources = new Set();
    for (var ci = 0; ci < chunks.length && citations.length < 3; ci += 1) {
      var ch = chunks[ci];
      var src = ch.source_url || (ch.level === 2 ? 'business summary' : 'knowledge base');
      if (seenSources.has(src)) continue;
      seenSources.add(src);
      citations.push({
        content: (ch.content || '').slice(0, 240),
        source: src,
        level: ch.level,
      });
    }

    res.json({
      response: response,
      escalated: escalated,
      source: source,
      confidence: confidence,
      sessionId: sessionId,
      citations: citations,
    });

    setImmediate(async function () {
      try {
        await db.saveMessage(businessId, sessionId, 'visitor',   message,  {});
        await db.saveMessage(businessId, sessionId, 'assistant', response, {
          confidence: confidence,
          escalated:  escalated,
          source:     source,
        });

        var evalTask = Promise.resolve(null);
        if (!escalated && chunks.length > 0 && source === 'model') {
          evalTask = evaluateAnswer({
            query:  message,
            answer: response,
            chunks: chunks.map(function (c) { return c.content; }),
          }).then(function (scores) {
            return db.insertEvalLog({
              business_id:             businessId,
              session_id:              sessionId,
              query:                   rewrittenQuery || message,
              answer:                  response,
              retrieved_chunks:        JSON.stringify(chunks),
              faithfulness_score:      scores.faithfulness,
              answer_relevance_score:  scores.answer_relevance,
              context_precision_score: scores.context_precision,
              overall_score:
                (scores.faithfulness !== null && scores.answer_relevance !== null)
                  ? (scores.faithfulness + scores.answer_relevance + (scores.context_precision || 0)) / 3
                  : null,
              flagged_hallucination: scores.has_hallucination,
            });
          });
        }

        var leadTask = db
          .getTranscripts(businessId, sessionId)
          .then(function (allMessages) {
            var transcript = allMessages.map(function (m) { return m.role + ': ' + m.content; }).join('\n');
            return extractLead(transcript);
          })
          .then(function (lead) {
            if (lead && lead.email) {
              return db.saveLead(businessId, sessionId, lead);
            }
            return null;
          });

        await Promise.allSettled([evalTask, leadTask]);
      } catch (asyncErr) {
        console.error('Async side-effect failed:', asyncErr.message);
      }
    });

  } catch (err) {
    console.error('Chat route error:', err);
    res.status(500).json({
      response:  "I'm having trouble right now. Please try again.",
      escalated: false,
      source:    'error',
    });
  }
});

/* ── Streaming chat (SSE) ─────────────────────────────────────── */
app.post('/api/chat/:businessId/stream', async function (req, res) {
  var businessId          = req.params.businessId;
  var message             = req.body.message;
  var sessionId           = req.body.sessionId;
  var conversationHistory = req.body.conversationHistory || [];

  if (!message || !sessionId) {
    return res.status(400).json({ error: 'message and sessionId are required' });
  }

  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection:      'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  var closed = false;
  req.on('close', function () { closed = true; });

  var send = function (obj) { if (!closed) res.write('data: ' + JSON.stringify(obj) + '\n\n'); };

  try {
    var business = await db.getClient(businessId);
    var retrieval      = await retrieve(businessId, message);
    var chunks         = retrieval.chunks;
    var confidence     = retrieval.confidence;
    var shouldEscalate = retrieval.shouldEscalate;
    var reason         = retrieval.reason;
    var rewrittenQuery = retrieval.rewrittenQuery;
    var raptorSummary  = retrieval.raptorSummary;

    if (shouldEscalate) {
      var esc = await generateEscalationMessage({
        query: message, missingInfo: reason || 'Insufficient content',
        businessName: business.name, brandTone: business.brand_tone || 'professional',
      });
      send({ token: esc.response });
      send({ done: true, escalated: true, source: 'escalation', confidence: confidence, sessionId: sessionId, citations: [] });
      return res.end();
    }

    var citations = [];
    var seenSources = new Set();
    for (var ci = 0; ci < chunks.length && citations.length < 3; ci += 1) {
      var ch = chunks[ci];
      var src = ch.source_url || (ch.level === 2 ? 'business summary' : 'knowledge base');
      if (seenSources.has(src)) continue;
      seenSources.add(src);
      citations.push({ content: (ch.content || '').slice(0, 240), source: src, level: ch.level });
    }

    var gen = await streamAnswer(
      {
        query: message,
        contextChunks: chunks.map(function (c) { return c.content; }),
        businessName: business.name,
        brandTone: business.brand_tone || 'professional',
        conversationHistory: conversationHistory,
        keyCta: business.key_cta || 'Get in touch',
        raptorSummary: raptorSummary,
      },
      { onToken: function (t) { send({ token: t }); } }
    );

    if (gen.escalated) {
      var gemEsc = await generateEscalationMessage({
        query: message, missingInfo: gen.reason || 'Insufficient content',
        businessName: business.name, brandTone: business.brand_tone || 'professional',
      });
      send({ token: gemEsc.response });
      send({ done: true, escalated: true, source: 'model-escalation', confidence: confidence, sessionId: sessionId, citations: [] });
      return res.end();
    }

    send({ done: true, escalated: false, source: gen.source, confidence: confidence, sessionId: sessionId, citations: citations });

    setImmediate(async function () {
      try {
        await db.saveMessage(businessId, sessionId, 'visitor',   message,  {});
        await db.saveMessage(businessId, sessionId, 'assistant', gen.response, { confidence: confidence, escalated: false, source: gen.source });
        if (chunks.length > 0 && gen.source === 'model') {
          var scores = await evaluateAnswer({ query: message, answer: gen.response, chunks: chunks.map(function (c) { return c.content; }) });
          await db.insertEvalLog({
            business_id: businessId, session_id: sessionId,
            query: rewrittenQuery || message, answer: gen.response,
            retrieved_chunks: JSON.stringify(chunks),
            faithfulness_score: scores.faithfulness,
            answer_relevance_score: scores.answer_relevance,
            context_precision_score: scores.context_precision,
            overall_score: (scores.faithfulness !== null && scores.answer_relevance !== null) ? (scores.faithfulness + scores.answer_relevance + (scores.context_precision || 0)) / 3 : null,
            flagged_hallucination: scores.has_hallucination,
          });
        }
        var allMessages = await db.getTranscripts(businessId, sessionId);
        var transcript = allMessages.map(function (m) { return m.role + ': ' + m.content; }).join('\n');
        var lead = await extractLead(transcript);
        if (lead && lead.email) await db.saveLead(businessId, sessionId, lead);
      } catch (asyncErr) {
        console.error('Stream async side-effects failed:', asyncErr.message);
      }
    });

    res.end();
  } catch (err) {
    console.error('Stream route error:', err);
    send({ token: "I'm having trouble right now. Please try again." });
    send({ done: true, escalated: false, source: 'error', sessionId: sessionId, citations: [] });
    res.end();
  }
});

/* ── Direct lead capture (widget form) ─────────────────────────── */
app.post('/api/chat/:businessId/lead', async function (req, res) {
  try {
    await db.saveLead(req.params.businessId, req.body.sessionId, {
      name:               req.body.name  || null,
      email:              req.body.email || null,
      phone:              req.body.phone || null,
      intent:             'unknown',
      sentiment:          'neutral',
      follow_up_priority: 'medium',
      key_question:       null,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── Legacy message endpoint (session-token) ────────────────────── */
app.post('/api/chat/message', requireAdmin, async function (req, res) {
  var sessionToken = req.body.sessionToken;
  var message      = req.body.message;

  if (!sessionToken || !message) {
    return res.status(400).json({ error: 'sessionToken and message are required' });
  }

  var session = await db.getSessionByToken(sessionToken);
  if (!session) return res.status(404).json({ error: 'session not found' });

  var biz = await db.getBusinessProfileCols(session.business_id, ['name', 'url', 'brand_tone', 'key_cta']);
  biz = biz || {};

  var retrieval = await retrieve(session.business_id, message);

  var response, source;
  if (retrieval.shouldEscalate) {
    var esc = await generateEscalationMessage({
      query:        message,
      missingInfo:  retrieval.reason || 'Insufficient content',
      businessName: biz.name || 'this business',
      brandTone:    biz.brand_tone || 'professional',
    });
    response = esc.response;
    source   = 'escalate';
  } else {
    var gen = await generateAnswer({
      query:         message,
      contextChunks: retrieval.chunks.map(function (c) { return c.content; }),
      businessName:  biz.name || 'this business',
      brandTone:     biz.brand_tone || 'professional',
      keyCta:        biz.key_cta || 'Get in touch',
      raptorSummary: retrieval.raptorSummary,
    });
    response = gen.response;
    source   = gen.escalated ? 'escalate' : 'model';
  }

  await db.insertQuestion(session.business_id, session.id, message, response);

  return res.json({ answer: response, source: source, escalate: source === 'escalate' });
});

// =============================================================================
// DASHBOARD
// =============================================================================

app.get('/api/dashboard/:businessId/stats', requireAdmin, async function (req, res) {
  try {
    res.json(await db.getDashboardStats(req.params.businessId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dashboard/:businessId/transcripts', requireAdmin, async function (req, res) {
  try {
    res.json(await db.getTranscripts(req.params.businessId, req.query.sessionId || null));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dashboard/:businessId/sessions', requireAdmin, async function (req, res) {
  try {
    res.json(await db.getSessions(req.params.businessId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dashboard/:businessId/leads', requireAdmin, async function (req, res) {
  try {
    res.json(await db.getLeads(req.params.businessId, {
      limit:    Number(req.query.limit) || 100,
      priority: req.query.priority      || null,
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dashboard/:businessId/questions', requireAdmin, async function (req, res) {
  try {
    res.json(await db.getTopQuestions(req.params.businessId, Number(req.query.days) || 7));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// HEALTH
// =============================================================================

app.get('/health', function (_req, res) { res.json({ ok: true }); });

// Align vector schema to the configured embedding dim (local models may be
// 768/1024 instead of 1536). No-op when already matched.
const { embed: embedCfg } = require('./services/modelConfig');
db.ensureSchema(embedCfg.dim).catch(function (err) {
  console.error('[db] ensureSchema failed:', err.message);
});

app.listen(port, function () {
  console.log('glazed server running on http://localhost:' + port);
});
