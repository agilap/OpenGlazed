require('dotenv').config()
'use strict';

const path    = require('path');
const express = require('express');
const cors    = require('cors');
const crypto  = require('node:crypto');

const { evaluateAnswer } = require('./services/generator');
const { runAgent }  = require('./services/agent');
const db            = require('./db');
const auth = require('./auth');
const traces = require('./services/traces');
const { runIngest, ingestNormalized, reembedMissing } = require('./ingest');
const { embedTexts } = require('./services/llm');
const { ingestDocument, removeDocument, documentTypeFor, BINARY_TYPES } = require('./sources');

const app  = express();
const port = process.env.PORT || 3000;

const allowedOrigin = process.env.FRONTEND_ORIGIN       || 'http://localhost:5173';
const embedOrigin   = process.env.FRONTEND_EMBED_ORIGIN || allowedOrigin;

let ADMIN_TOKEN = process.env.ADMIN_TOKEN;
if (!ADMIN_TOKEN) {
  ADMIN_TOKEN = require('crypto').randomBytes(24).toString('hex');
  console.log('[auth] ADMIN_TOKEN not set — generated ephemeral token: ' + ADMIN_TOKEN);
}

async function requireAdmin(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (token && token === ADMIN_TOKEN) return next();
    const user = await auth.getUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in required' });
    const businessId = req.params.businessId || req.params.id;
    if (businessId) {
      if (!/^[1-9]\d{0,18}$/.test(businessId)) return res.status(404).json({ error: 'Business not found' });
      const owned = await db.query('SELECT 1 FROM businesses WHERE id = $1 AND owner_id = $2', [businessId, user.id]);
      if (!owned.rowCount) return res.status(404).json({ error: 'Business not found' });
    }
    req.user = user;
    next();
  } catch (err) { next(err); }
}

function asyncRoute(handler) {
  return function (req, res, next) {
    return handler(req, res, next).catch(next);
  };
}

app.use(cors({ origin: allowedOrigin, credentials: true }));
app.use(function (req, res, next) {
  if ((req.path.startsWith('/api/auth/') || (req.headers.cookie || '').includes('og_session=')) && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin && req.headers.origin !== allowedOrigin && req.headers.origin !== req.protocol + '://' + req.get('host')) return res.status(403).json({ error: 'Invalid origin' });
  next();
});
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(function (req, res, next) {
  var start = Date.now();
  res.on('finish', function () {
    console.log(JSON.stringify({ event: 'http.request', method: req.method, path: req.path, status: res.statusCode, duration_ms: Date.now() - start }));
  });
  next();
});

const authAttempts = new Map();
function limitAuth(req, res, next) {
  const now = Date.now();
  const key = req.ip;
  const recent = (authAttempts.get(key) || []).filter((time) => now - time < 15 * 60 * 1000);
  if (recent.length >= 20) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  recent.push(now); authAttempts.set(key, recent); next();
}
function credentials(body) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  return { email, password, valid: email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && password.length >= 12 && password.length <= 1024 };
}
app.post('/api/auth/signup', limitAuth, asyncRoute(async function (req, res) {
  const { email, password, valid } = credentials(req.body || {});
  if (!valid) return res.status(400).json({ error: 'Enter a valid email and a password of at least 12 characters.' });
  await auth.ensureAuthSchema();
  const hash = await auth.hashPassword(password);
  const result = await db.query('INSERT INTO users (email, password_hash) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING RETURNING id, email', [email, hash]);
  if (!result.rowCount) return res.status(409).json({ error: 'An account with this email already exists.' });
  await auth.createSession(res, result.rows[0].id);
  res.status(201).json({ user: result.rows[0] });
}));
app.post('/api/auth/login', limitAuth, asyncRoute(async function (req, res) {
  const { email, password } = credentials(req.body || {});
  if (email.length > 254 || password.length > 1024) return res.status(401).json({ error: 'Invalid email or password.' });
  await auth.ensureAuthSchema();
  const result = await db.query('SELECT id, email, password_hash FROM users WHERE email = $1', [email]);
  const user = result.rows[0];
  if (!user || !await auth.verifyPassword(password, user.password_hash)) return res.status(401).json({ error: 'Invalid email or password.' });
  await auth.createSession(res, user.id);
  res.json({ user: { id: user.id, email: user.email } });
}));
app.get('/api/auth/me', asyncRoute(async function (req, res) {
  const user = await auth.getUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in required' });
  const businesses = await db.query('SELECT id, name, url, ingest_status FROM businesses WHERE owner_id = $1 ORDER BY id DESC', [user.id]);
  res.set('Cache-Control', 'no-store').json({ user, businesses: businesses.rows });
}));
app.post('/api/auth/logout', asyncRoute(async function (req, res) { await auth.logout(req, res); res.status(204).end(); }));

app.post('/api/businesses', requireAdmin, asyncRoute(async function (req, res) {
  var name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  var url  = typeof req.body.url === 'string' ? req.body.url.trim() : '';

  if (!name || name.length > 120) {
    return res.status(400).json({ error: 'A workspace name of up to 120 characters is required' });
  }

  var business = req.user
    ? (await db.query('INSERT INTO businesses (name, url, owner_id) VALUES ($1, $2, $3) RETURNING *', [name, url, req.user.id])).rows[0]
    : await db.insertBusiness(name, url);

  if (!business) {
    return res.status(500).json({ error: 'failed to create business' });
  }

  res.json({
    businessId: business.id,
    status: 'ingesting',
    embedScript: '<script src="' + req.protocol + '://' + req.get('host') + '/widget.js" data-business-id="' + business.id + '"></script>',
    embedIframe: '<iframe src="' + embedOrigin + '/embed/' + business.id + '" width="360" height="560" style="border:0;position:fixed;right:20px;bottom:20px;z-index:999999;border-radius:12px;" title="' + name + ' assistant"></iframe>',
  });

  if (url) runIngest(business.id, url).catch(function (err) {
    console.error('Background ingest failed for business', business.id, err.message);
  });
}));

app.get('/api/businesses/:id', asyncRoute(async function (req, res) {
  var business = await db.getBusinessById(req.params.id);

  if (!business) {
    return res.status(404).json({ error: 'business not found' });
  }

  return res.json({ business: business });
}));

app.get('/api/businesses/:id/dashboard', requireAdmin, asyncRoute(async function (req, res) {
  var businessId = Number(req.params.id);

  var business = await db.getBusinessById(businessId);
  if (!business) return res.status(404).json({ error: 'business not found' });

  return res.json({ business: business });
}));

app.post('/api/ingest/:businessId', requireAdmin, asyncRoute(async function (req, res) {
  var businessId = req.params.businessId;
  var business = await db.getBusinessUrl(businessId);
  if (!business) return res.status(404).json({ error: 'Business not found' });
  if (!business.url) return res.status(400).json({ error: 'This workspace has no website to re-index' });

  res.json({ status: 'started', message: 'Ingest triggered' });
  runIngest(businessId, business.url).catch(function (err) {
    console.error('Re-ingest failed for business', businessId, err.message);
  });
}));

app.get('/api/ingest/:businessId/status', asyncRoute(async function (req, res) {
  var data = await db.getBusinessStatusCols(req.params.businessId);

  res.json({
    status:          data.ingest_status  || 'unknown',
    ingest_progress: data.ingest_progress || 0,
  });
}));

const MAX_DOCUMENT_BYTES = 18 * 1024 * 1024;

app.post('/api/sources/:businessId', requireAdmin, asyncRoute(async function (req, res) {
  var businessId = Number(req.params.businessId);
  var business = await db.getBusinessById(businessId);
  if (!business) return res.status(404).json({ error: 'Business not found' });
  return acceptDocument(businessId, req.body || {}, res);
}));

async function acceptDocument(businessId, body, res) {
  var filename = typeof body.filename === 'string' ? body.filename.trim().slice(0, 200) : '';
  var sourceType = filename ? documentTypeFor(filename) : 'paste';
  if (!sourceType) return res.status(400).json({ error: 'Upload a PDF, DOCX, Markdown, TXT, CSV or JSON file.' });

  var payload = {};
  if (BINARY_TYPES.has(sourceType)) {
    var data = typeof body.data === 'string' ? Buffer.from(body.data, 'base64') : Buffer.alloc(0);
    var magic = sourceType === 'pdf' ? '%PDF' : 'PK';
    if (data.subarray(0, magic.length).toString('latin1') !== magic) return res.status(400).json({ error: 'This file does not look like a valid ' + sourceType.toUpperCase() + '.' });
    if (data.length > MAX_DOCUMENT_BYTES) return res.status(413).json({ error: 'Files must be 18 MB or smaller.' });
    payload.data = data;
  } else {
    if (typeof body.text !== 'string' || !body.text.trim()) return res.status(400).json({ error: 'The document is empty.' });
    if (Buffer.byteLength(body.text) > MAX_DOCUMENT_BYTES) return res.status(413).json({ error: 'Files must be 18 MB or smaller.' });
    payload.text = body.text;
  }

  var document = await db.createDocument(businessId, filename || 'Pasted text ' + new Date().toISOString().slice(0, 10), sourceType);
  res.status(202).json({ document: document });
  ingestDocument(businessId, document, payload).catch(function (err) {
    console.error('[sources] ingest failed for', businessId, document.id, err.message);
  });
}

app.get('/api/sources/:businessId', requireAdmin, asyncRoute(async function (req, res) {
  res.set('Cache-Control', 'no-store').json({ documents: await db.listDocuments(req.params.businessId) });
}));

app.delete('/api/sources/:businessId/:documentId', requireAdmin, asyncRoute(async function (req, res) {
  if (!/^[1-9]\d{0,18}$/.test(req.params.documentId)) return res.status(404).json({ error: 'Document not found' });
  var document = await db.getDocument(req.params.businessId, req.params.documentId);
  if (!document) return res.status(404).json({ error: 'Document not found' });
  await db.updateDocument(document.id, { status: 'deleting', error: null });
  res.status(202).json({ status: 'deleting' });
  removeDocument(req.params.businessId, document.id).catch(function (err) {
    console.error('[sources] delete failed for', req.params.businessId, document.id, err.message);
  });
}));

var EVAL_SAMPLE_RATE = process.env.EVAL_SAMPLE_RATE !== undefined ? Number(process.env.EVAL_SAMPLE_RATE) : 0.1;

function validBusinessId(value) {
  return typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
}

async function handleChatStream(req, res, surface) {
  var businessId = req.params.businessId;
  if (!validBusinessId(businessId)) return res.status(400).json({ error: 'Invalid businessId' });
  var message    = req.body.message;
  var sessionId  = req.body.sessionId;

  if (typeof message !== 'string' || !message.trim() || typeof sessionId !== 'string' || !sessionId) {
    return res.status(400).json({ error: 'message and sessionId are required strings' });
  }
  if (message.length > 4000 || sessionId.length > 100) {
    return res.status(400).json({ error: 'message or sessionId too long' });
  }

  return traces.runTrace({ businessId, sessionId, surface, query: message }, async function (trace) {
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection:      'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    var closed = false;
    res.on('close', function () { closed = true; });
    var sentText = false;
    var send = function (obj) {
      if (obj.token) sentText = true;
      if (!closed) res.write('data: ' + JSON.stringify(obj) + '\n\n');
    };

    try {
      var business = await traces.stage('business', () => db.getClient(businessId));
      var history  = await traces.stage('history', () => db.getHistory(businessId, sessionId, surface));

      var result = await traces.stage('agent', () => runAgent({
        businessId: businessId,
        business:   business,
        surface:    surface,
        sessionId:  sessionId,
        history:    history,
        message:    message,
        onToken:    function (t) { send({ token: t }); },
      }));

      send({
        done: true,
        escalated:  result.escalated,
        source:     result.source,
        confidence: result.confidence,
        sessionId:  sessionId,
        citations:  result.citations,
        traceId: trace.id,
      });
      res.end();
      recordExchange(businessId, sessionId, surface, message, result);
      return result;
    } catch (err) {
      traces.recordError(err);
      console.error(JSON.stringify({ event: 'rag.request_error', trace_id: trace.id, message: err.message }));
      if (!sentText) send({ token: "I'm having trouble right now. Please try again." });
      send({ done: true, error: 'Unable to answer. Please try again.', escalated: false, source: 'error', sessionId: sessionId, citations: [], traceId: trace.id });
      res.end();
      return { source: 'error' };
    }
  });
}

function recordExchange(businessId, sessionId, surface, message, result) {
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

function validTraceScope(req, res, next) {
  if (!validBusinessId(req.params.businessId)) return res.status(400).json({ error: 'Invalid businessId' });
  return next();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
app.get('/api/dashboard/:businessId/traces', requireAdmin, validTraceScope, asyncRoute(async function (req, res) {
  const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
  const before = req.query.before || null;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (before && (typeof before !== 'string' || !UUID.test(before)))) {
    return res.status(400).json({ error: 'limit must be 1–100; before must be a trace UUID' });
  }
  res.set('Cache-Control', 'no-store');
  res.json(await db.getRequestTraces(req.params.businessId, { limit, before, days: traces.retention().days }));
}));

app.get('/api/dashboard/:businessId/traces/:traceId', requireAdmin, validTraceScope, asyncRoute(async function (req, res) {
  if (!UUID.test(req.params.traceId)) return res.status(400).json({ error: 'Invalid traceId' });
  res.set('Cache-Control', 'no-store');
  const trace = await db.getRequestTrace(req.params.businessId, req.params.traceId, traces.retention().days);
  if (!trace) return res.status(404).json({ error: 'Trace not found' });
  res.json(trace);
}));

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

app.get('/api/keys/:businessId', requireAdmin, asyncRoute(async function (req, res) {
  res.set('Cache-Control', 'no-store').json({ keys: await db.listApiKeys(req.params.businessId) });
}));

app.post('/api/keys/:businessId', requireAdmin, asyncRoute(async function (req, res) {
  var name = typeof (req.body || {}).name === 'string' ? req.body.name.trim().slice(0, 80) : '';
  if (!name) return res.status(400).json({ error: 'Give the key a name.' });
  res.set('Cache-Control', 'no-store').status(201).json({ key: await db.createApiKey(Number(req.params.businessId), name) });
}));

app.delete('/api/keys/:businessId/:keyId', requireAdmin, asyncRoute(async function (req, res) {
  if (!/^[1-9]\d{0,18}$/.test(req.params.keyId)) return res.status(404).json({ error: 'Key not found' });
  if (!await db.revokeApiKey(req.params.businessId, req.params.keyId)) return res.status(404).json({ error: 'Key not found' });
  res.status(204).end();
}));

const apiCalls = new Map();
async function requireApiKey(req, res, next) {
  try {
    var header = req.headers.authorization || '';
    var key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    var found = /^ogk_[A-Za-z0-9_-]{32}$/.test(key) ? await db.findApiKey(key) : null;
    if (!found) return res.status(401).json({ error: 'Invalid or revoked API key' });
    var now = Date.now();
    var recent = (apiCalls.get(found.id) || []).filter(function (time) { return now - time < 60 * 1000; });
    if (recent.length >= 60) return res.status(429).json({ error: 'Rate limit is 60 requests per minute per key' });
    recent.push(now);
    apiCalls.set(found.id, recent);
    req.businessId = Number(found.business_id);
    next();
  } catch (err) { next(err); }
}

app.get('/api/v1/documents', requireApiKey, asyncRoute(async function (req, res) {
  res.json({ documents: await db.listDocuments(req.businessId) });
}));

app.post('/api/v1/documents', requireApiKey, asyncRoute(async function (req, res) {
  return acceptDocument(req.businessId, req.body || {}, res);
}));

app.get('/api/v1/documents/:documentId', requireApiKey, asyncRoute(async function (req, res) {
  var document = /^[1-9]\d{0,18}$/.test(req.params.documentId) ? await db.getDocument(req.businessId, req.params.documentId) : null;
  if (!document) return res.status(404).json({ error: 'Document not found' });
  res.json({ document: { id: document.id, filename: document.filename, source_type: document.source_type, status: document.status, chunk_count: document.chunk_count, error: document.error, created_at: document.created_at } });
}));

app.delete('/api/v1/documents/:documentId', requireApiKey, asyncRoute(async function (req, res) {
  var document = /^[1-9]\d{0,18}$/.test(req.params.documentId) ? await db.getDocument(req.businessId, req.params.documentId) : null;
  if (!document) return res.status(404).json({ error: 'Document not found' });
  await db.updateDocument(document.id, { status: 'deleting', error: null });
  res.status(202).json({ status: 'deleting' });
  removeDocument(req.businessId, document.id).catch(function (err) {
    console.error('[sources] delete failed for', req.businessId, document.id, err.message);
  });
}));

app.post('/api/v1/ask', requireApiKey, asyncRoute(async function (req, res) {
  var body = req.body || {};
  var question = typeof body.question === 'string' ? body.question.trim() : '';
  var sessionId = body.sessionId === undefined ? 'api-' + crypto.randomUUID() : body.sessionId;
  if (!question || question.length > 4000) return res.status(400).json({ error: 'question must be a non-empty string of up to 4000 characters' });
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 100) return res.status(400).json({ error: 'sessionId must be a string of up to 100 characters' });
  var businessId = String(req.businessId);

  return traces.runTrace({ businessId, sessionId, surface: 'api', query: question }, async function (trace) {
    try {
      var business = await traces.stage('business', () => db.getClient(businessId));
      var history = await traces.stage('history', () => db.getHistory(businessId, sessionId, 'api'));
      var result = await traces.stage('agent', () => runAgent({ businessId, business, surface: 'api', sessionId, history, message: question }));
      var marked = /^\s*\[UNANSWERED\]\s*:?\s*/i;
      if (marked.test(result.response || '')) result = { ...result, response: result.response.replace(marked, ''), escalated: true };
      res.json({
        answer: result.response,
        citations: result.citations.map(function (c) { return { index: c.index, source: c.source, excerpt: c.content }; }),
        unanswered: Boolean(result.escalated) || result.confidence === 'low',
        confidence: result.confidence,
        sessionId: sessionId,
        traceId: trace.id,
      });
      recordExchange(businessId, sessionId, 'api', question, result);
      return result;
    } catch (err) {
      traces.recordError(err);
      console.error(JSON.stringify({ event: 'rag.request_error', trace_id: trace.id, message: err.message }));
      res.status(502).json({ error: 'The model provider failed to answer. Try again.', traceId: trace.id });
      return { source: 'error' };
    }
  });
}));

app.get('/health', function (_req, res) { res.json({ ok: true }); });

app.use(function (err, req, res, next) {
  if (res.headersSent) return next(err);
  var status = err.status || 500;
  if (status >= 500) console.error(req.method + ' ' + req.path + ' failed:', err.message);
  res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message });
});

module.exports = app;

if (require.main === module) {
const { chat: chatCfg } = require('./services/modelConfig');
if (!process.env.LLM_API_KEY) {
  console.warn('[llm] LLM_API_KEY not set — calls to ' + chatCfg.baseURL + ' will fail unless that server needs no key.');
}

const { embed: embedCfg } = require('./services/modelConfig');
async function embeddingDim() {
  if (Number(process.env.EMBED_DIM) > 0) return Number(process.env.EMBED_DIM);
  const [vector] = await embedTexts(['dimension probe']);
  if (!Array.isArray(vector) || !vector.length) throw new Error('embedding provider returned no vector');
  return vector.length;
}

async function prepareDatabase() {
  await db.ensureSchema(null);
  const dim = await embeddingDim();
  if (dim !== embedCfg.dim) console.log('[db] ' + embedCfg.model + ' returns ' + dim + '-dimension vectors');
  embedCfg.dim = dim;
  if (await db.ensureSchema(dim)) console.log('[db] embedding model changed; re-embedding stored content');
  const count = await reembedMissing();
  if (count) console.log('[db] embedded ' + count + ' stored chunks and summaries');
}

function bootSchema(attempt) {
  prepareDatabase().catch(function (err) {
    const delay = Math.min(30000, 1000 * 2 ** attempt);
    console.error('[db] startup setup failed, retrying in ' + delay / 1000 + 's:', err.message);
    setTimeout(bootSchema, delay, attempt + 1).unref();
  });
}
bootSchema(0);

function pruneTraces() {
  const retention = traces.retention();
  db.pruneRequestTraces(retention.days, retention.maxPerBusiness).catch((err) => {
    console.error(JSON.stringify({ event: 'rag.trace_prune_failed', message: err.message }));
  });
}
pruneTraces();
setInterval(pruneTraces, 60 * 60 * 1000).unref();

app.listen(port, function () {
  console.log('glazed server running on http://localhost:' + port);
});

}
