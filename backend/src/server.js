require('dotenv').config()
'use strict';

const path    = require('path');
const express = require('express');
const cors    = require('cors');

const { evaluateAnswer } = require('./services/generator');
const { runAgent }  = require('./services/agent');
const db            = require('./db');
const { runIngest, ingestNormalized } = require('./ingest');
const { ingestSource, SUPPORTED } = require('./sources');

const app  = express();
const port = process.env.PORT || 3000;

const allowedOrigin = process.env.FRONTEND_ORIGIN       || 'http://localhost:5173';
const embedOrigin   = process.env.FRONTEND_EMBED_ORIGIN || allowedOrigin;

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

app.use(function (req, res, next) {
  var start = Date.now();
  res.on('finish', function () {
    console.log(req.method + ' ' + req.path + ' ' + res.statusCode + ' ' + (Date.now() - start) + 'ms');
  });
  next();
});

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

  return res.json({ business: business });
});

app.get('/api/businesses/:id/dashboard', requireAdmin, async function (req, res) {
  var businessId = Number(req.params.id);

  var business = await db.getBusinessById(businessId);
  if (!business) return res.status(404).json({ error: 'business not found' });

  return res.json({ business: business });
});

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

var EVAL_SAMPLE_RATE = process.env.EVAL_SAMPLE_RATE !== undefined ? Number(process.env.EVAL_SAMPLE_RATE) : 0.1;

async function handleChatStream(req, res, surface) {
  var businessId = req.params.businessId;
  var message    = req.body.message;
  var sessionId  = req.body.sessionId;

  if (typeof message !== 'string' || !message.trim() || typeof sessionId !== 'string' || !sessionId) {
    return res.status(400).json({ error: 'message and sessionId are required strings' });
  }
  if (message.length > 4000 || sessionId.length > 100) {
    return res.status(400).json({ error: 'message or sessionId too long' });
  }

  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection:      'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  var closed = false;
  res.on('close', function () { closed = true; });
  var send = function (obj) { if (!closed) res.write('data: ' + JSON.stringify(obj) + '\n\n'); };

  try {
    var business = await db.getClient(businessId);
    var history  = await db.getHistory(businessId, sessionId, surface);

    var result = await runAgent({
      businessId: businessId,
      business:   business,
      surface:    surface,
      sessionId:  sessionId,
      history:    history,
      message:    message,
      onToken:    function (t) { send({ token: t }); },
    });

    send({
      done: true,
      escalated:  result.escalated,
      source:     result.source,
      confidence: result.confidence,
      sessionId:  sessionId,
      citations:  result.citations,
    });
    res.end();

    setImmediate(async function () {
      try {
        await db.saveMessage(businessId, sessionId, 'visitor', message, { channel: surface });
        await db.saveMessage(businessId, sessionId, 'assistant', result.response, {
          confidence: result.confidence,
          escalated:  result.escalated,
          source:     result.source,
          channel:    surface,
        });

        if (surface === 'widget' && !result.escalated && result.chunks.length > 0 && Math.random() < EVAL_SAMPLE_RATE) {
          var contents = result.chunks.map(function (c) { return c.content; });
          var scores = await evaluateAnswer({ query: message, answer: result.response, chunks: contents });
          await db.insertEvalLog({
            business_id: businessId, session_id: sessionId,
            query: message, answer: result.response,
            retrieved_chunks: JSON.stringify(result.chunks),
            faithfulness_score: scores.faithfulness,
            answer_relevance_score: scores.answer_relevance,
            context_precision_score: scores.context_precision,
            overall_score: (scores.faithfulness !== null && scores.answer_relevance !== null) ? (scores.faithfulness + scores.answer_relevance + (scores.context_precision || 0)) / 3 : null,
            flagged_hallucination: scores.has_hallucination,
          });
        }
      } catch (asyncErr) {
        console.error('Chat side-effects failed:', asyncErr.message);
      }
    });
  } catch (err) {
    console.error('Chat stream error:', err);
    send({ token: "I'm having trouble right now. Please try again." });
    send({ done: true, escalated: false, source: 'error', sessionId: sessionId, citations: [] });
    res.end();
  }
}

app.post('/api/chat/:businessId/stream', function (req, res) {
  return handleChatStream(req, res, 'widget');
});

app.get('/api/chat/:businessId/history', async function (req, res) {
  if (!req.query.sessionId) return res.status(400).json({ error: 'sessionId is required' });
  try {
    res.json(await db.getHistory(req.params.businessId, String(req.query.sessionId), 'widget', 100));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

app.post('/api/team/:businessId/stream', requireAdmin, function (req, res) {
  return handleChatStream(req, res, 'team');
});

app.get('/api/team/:businessId/threads', requireAdmin, async function (req, res) {
  try {
    res.json(await db.getSessions(req.params.businessId, { channel: 'team' }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/team/:businessId/threads/:threadId', requireAdmin, async function (req, res) {
  try {
    res.json(await db.getHistory(req.params.businessId, req.params.threadId, 'team', 200));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

app.get('/health', function (_req, res) { res.json({ ok: true }); });

const { chat: chatCfg } = require('./services/modelConfig');
if (!process.env.LLM_API_KEY) {
  console.warn('[llm] LLM_API_KEY not set — calls to ' + chatCfg.baseURL + ' will fail unless that server needs no key.');
}

const { embed: embedCfg } = require('./services/modelConfig');
db.ensureSchema(embedCfg.dim).catch(function (err) {
  console.error('[db] ensureSchema failed:', err.message);
});

app.listen(port, function () {
  console.log('glazed server running on http://localhost:' + port);
});
