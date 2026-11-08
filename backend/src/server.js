require('dotenv').config()
'use strict';

const path    = require('path');
const express = require('express');
const cors    = require('cors');
const crypto  = require('node:crypto');

const { runAgent }  = require('./services/agent');
const { classifyExchange } = require('./services/guard');
const { notifyUnanswered, sendMail, mailConfigured, appUrl } = require('./services/notify');
const db            = require('./db');
const auth = require('./auth');
const traces = require('./services/traces');
const { reembedMissing } = require('./ingest');
const { embedTexts } = require('./services/llm');
const { ingestDocument, removeDocument, recoverInterrupted, documentTypeFor, BINARY_TYPES } = require('./sources');

const app  = express();
const port = process.env.PORT || 3000;

const allowedOrigin = process.env.FRONTEND_ORIGIN       || 'http://localhost:5173';
const embedOrigin   = process.env.FRONTEND_EMBED_ORIGIN || allowedOrigin;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest();
const adminToken = process.env.ADMIN_TOKEN || '';
const weakAdminToken = process.env.NODE_ENV === 'production' && adminToken.length > 0 && adminToken.length < 32;
if (weakAdminToken) console.error('[auth] ADMIN_TOKEN is shorter than 32 characters — admin token access is disabled in production.');
else if (!adminToken) console.log('[auth] ADMIN_TOKEN not set — admin token access is disabled; sign in with an account.');
const ADMIN_DIGEST = adminToken && !weakAdminToken ? sha256(adminToken) : null;
function isAdminToken(token) {
  // Hash both sides so timingSafeEqual gets equal-length buffers and leaks no length.
  return Boolean(ADMIN_DIGEST && token) && crypto.timingSafeEqual(sha256(token), ADMIN_DIGEST);
}

// shortcut: in-memory fixed-window counters, per process and reset on restart; move to Postgres/Redis before running more than one instance.
const rateWindows = new Map();
function hit(key, max, windowMs) {
  const now = Date.now();
  let entry = rateWindows.get(key);
  if (!entry || now - entry.start >= windowMs) rateWindows.set(key, entry = { start: now, count: 0, windowMs });
  return ++entry.count <= max;
}
setInterval(function () {
  const now = Date.now();
  for (const [key, entry] of rateWindows) if (now - entry.start >= entry.windowMs) rateWindows.delete(key);
}, 60 * 1000).unref();

async function requireAdmin(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (isAdminToken(token)) return next();
    const user = await auth.getUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in required' });
    const businessId = req.params.businessId || req.params.id;
    if (businessId) {
      if (!validBusinessId(businessId)) return res.status(404).json({ error: 'Business not found' });
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

// TRUST_PROXY: hop count (e.g. 1) or an Express preset such as "loopback", so req.ip is the visitor, not the proxy.
if (process.env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
app.disable('x-powered-by');
app.use(function (req, res, next) {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" });
  next();
});
app.use(cors({ origin: allowedOrigin, credentials: true }));
app.use(function (req, res, next) {
  if ((req.path.startsWith('/api/auth/') || (req.headers.cookie || '').includes('og_session=')) && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin && req.headers.origin !== allowedOrigin && req.headers.origin !== req.protocol + '://' + req.get('host')) return res.status(403).json({ error: 'Invalid origin' });
  next();
});
app.param('businessId', function (req, res, next, value) {
  if (!validBusinessId(value)) return res.status(400).json({ error: 'Invalid businessId' });
  next();
});
app.param('id', function (req, res, next, value) {
  if (!validBusinessId(value)) return res.status(404).json({ error: 'Business not found' });
  next();
});

const smallJson = express.json({ limit: '100kb' });
const uploadJson = express.json({ limit: '25mb' });
const UPLOAD_PATH = /^\/api\/(sources\/[^/]+|v1\/documents)\/?$/;
app.use(function (req, res, next) {
  // Upload routes read their 25 MB body only after auth, so anonymous requests cannot fill memory.
  return req.method === 'POST' && UPLOAD_PATH.test(req.path) ? next() : smallJson(req, res, next);
});
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(function (req, res, next) {
  var start = Date.now();
  res.on('finish', function () {
    console.log(JSON.stringify({ event: 'http.request', method: req.method, path: req.path, status: res.statusCode, duration_ms: Date.now() - start }));
  });
  next();
});

function limitAuth(req, res, next) {
  if (!hit('auth:' + req.ip, 20, 15 * 60 * 1000)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  next();
}
const CHAT_PER_MINUTE = Number(process.env.CHAT_RATE_PER_MINUTE) || 20;
const CHAT_PER_DAY = Number(process.env.CHAT_DAILY_LIMIT) || 2000;
async function limitChat(req, res, next) {
  const id = req.params.businessId;
  if (!validBusinessId(id)) return next(); // the handler answers 400
  try { await db.getClient(id); } catch (err) {
    if (err.message === 'Business not found') return res.status(404).json({ error: 'Business not found' });
    return next(err);
  }
  if (!hit('chat:' + id + ':' + req.ip, CHAT_PER_MINUTE, 60 * 1000)) return res.status(429).json({ error: 'Too many messages. Wait a minute and try again.' });
  if (!hit('chat-day:' + id, CHAT_PER_DAY, 24 * 60 * 60 * 1000)) return res.status(429).json({ error: 'This assistant has reached its daily message limit.' });
  next();
}
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function credentials(body) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  return { email, password, valid: email.length <= 254 && EMAIL.test(email) && validPassword(password) };
}
const validPassword = (password) => typeof password === 'string' && password.length >= 12 && password.length <= 1024;
const publicUser = (user) => ({ id: user.id, email: user.email, email_verified: user.email_verified });

async function sendVerification(user) {
  const token = await auth.issueToken(user.id, 'verify', '24 hours');
  await sendMail({ to: user.email, subject: 'Confirm your Glazed AI email', text: `Confirm your email address:\n\n${appUrl()}/verify#${token}\n\nThe link expires in 24 hours. If you did not create an account, ignore this email.` });
}
async function requireUser(req, res, next) {
  try {
    const user = await auth.getUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in required' });
    req.user = user;
    next();
  } catch (err) { next(err); }
}
async function checkPassword(user, password) {
  const row = await db.query('SELECT password_hash FROM users WHERE id = $1', [user.id]);
  return typeof password === 'string' && password.length <= 1024 && row.rowCount > 0 && auth.verifyPassword(password, row.rows[0].password_hash);
}
app.post('/api/auth/signup', limitAuth, asyncRoute(async function (req, res) {
  const { email, password, valid } = credentials(req.body || {});
  if (!valid) return res.status(400).json({ error: 'Enter a valid email and a password of at least 12 characters.' });
  await auth.ensureAuthSchema();
  const hash = await auth.hashPassword(password);
  // Without SMTP there is no way to send a link, so the account starts verified.
  const result = await db.query('INSERT INTO users (email, password_hash, email_verified_at) VALUES ($1, $2, CASE WHEN $3 THEN NULL ELSE now() END) ON CONFLICT (email) DO NOTHING RETURNING id, email, email_verified_at IS NOT NULL AS email_verified', [email, hash, mailConfigured()]);
  if (!result.rowCount) return res.status(409).json({ error: 'An account with this email already exists.' });
  const user = result.rows[0];
  await auth.createSession(res, user.id);
  if (!user.email_verified) sendVerification(user).catch((err) => console.error(JSON.stringify({ event: 'auth.verify_mail_failed', error: err.message })));
  res.status(201).json({ user: publicUser(user) });
}));
app.post('/api/auth/login', limitAuth, asyncRoute(async function (req, res) {
  const { email, password } = credentials(req.body || {});
  if (email.length > 254 || password.length > 1024) return res.status(401).json({ error: 'Invalid email or password.' });
  if (!hit('login:' + email + ':' + req.ip, 10, 15 * 60 * 1000)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
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
  const businesses = await db.query("SELECT b.id, b.name, b.url, (SELECT count(*)::int FROM documents d WHERE d.business_id = b.id AND d.status = 'ready') AS document_count, (SELECT count(*)::int FROM inbox_items i WHERE i.business_id = b.id AND i.status = 'unanswered' AND i.resolved_at IS NULL) AS open_unanswered FROM businesses b WHERE b.owner_id = $1 ORDER BY b.id DESC", [user.id]);
  res.set('Cache-Control', 'no-store').json({ user: publicUser(user), businesses: businesses.rows });
}));
app.get('/api/auth/config', function (req, res) { res.json({ passwordReset: mailConfigured() }); });
app.post('/api/auth/logout', asyncRoute(async function (req, res) { await auth.logout(req, res); res.status(204).end(); }));
app.post('/api/auth/logout-all', requireUser, asyncRoute(async function (req, res) {
  await db.query('DELETE FROM user_sessions WHERE user_id = $1', [req.user.id]);
  auth.setCookie(res, '', 0);
  res.status(204).end();
}));
app.post('/api/auth/password', limitAuth, requireUser, asyncRoute(async function (req, res) {
  const body = req.body || {};
  if (!validPassword(body.password)) return res.status(400).json({ error: 'Use a new password of at least 12 characters.' });
  if (!await checkPassword(req.user, body.current)) return res.status(403).json({ error: 'Your current password is incorrect.' });
  await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await auth.hashPassword(body.password), req.user.id]);
  // Keep this session, end every other one.
  await db.query('DELETE FROM user_sessions WHERE user_id = $1 AND token_hash <> $2', [req.user.id, req.user.session_hash]);
  await db.query("DELETE FROM auth_tokens WHERE user_id = $1 AND purpose = 'reset'", [req.user.id]);
  res.status(204).end();
}));
app.delete('/api/auth/account', limitAuth, requireUser, asyncRoute(async function (req, res) {
  const body = req.body || {};
  if (body.confirm !== req.user.email) return res.status(400).json({ error: 'Type your email to confirm.' });
  if (!await checkPassword(req.user, body.password)) return res.status(403).json({ error: 'Your password is incorrect.' });
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const owned = await client.query('DELETE FROM businesses WHERE owner_id = $1 RETURNING id', [req.user.id]);
    await client.query('DELETE FROM users WHERE id = $1', [req.user.id]);
    await client.query('COMMIT');
    owned.rows.forEach((row) => db.clearBusinessCache(row.id));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  auth.setCookie(res, '', 0);
  res.status(204).end();
}));
app.post('/api/auth/verify', limitAuth, asyncRoute(async function (req, res) {
  const userId = await auth.consumeToken((req.body || {}).token, 'verify');
  if (!userId) return res.status(400).json({ error: 'This link is invalid or has expired.' });
  await db.query('UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1', [userId]);
  res.status(204).end();
}));
app.post('/api/auth/verify/resend', requireUser, asyncRoute(async function (req, res) {
  if (req.user.email_verified) return res.status(204).end();
  if (!mailConfigured()) return res.status(503).json({ error: 'Email is not configured on this server.' });
  if (!hit('verify:' + req.user.id, 3, 60 * 60 * 1000)) return res.status(429).json({ error: 'Too many emails. Try again later.' });
  await sendVerification(req.user);
  res.status(204).end();
}));
app.post('/api/auth/forgot', limitAuth, asyncRoute(async function (req, res) {
  const email = typeof (req.body || {}).email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!EMAIL.test(email) || email.length > 254) return res.status(400).json({ error: 'Enter a valid email.' });
  if (!mailConfigured()) return res.status(503).json({ error: 'Password reset by email is not configured on this server.' });
  // Same answer whether or not the account exists, so the form cannot be used to find accounts.
  res.status(202).json({ status: 'sent' });
  if (!hit('forgot:' + email, 3, 60 * 60 * 1000)) return;
  try {
    await auth.ensureAuthSchema();
    const found = await db.query('SELECT id, email FROM users WHERE email = $1', [email]);
    if (!found.rowCount) return;
    const token = await auth.issueToken(found.rows[0].id, 'reset', '1 hour');
    await sendMail({ to: email, subject: 'Reset your Glazed AI password', text: `Reset your password:\n\n${appUrl()}/reset#${token}\n\nThe link expires in 1 hour and works once. If you did not ask for this, ignore this email.` });
  } catch (err) {
    console.error(JSON.stringify({ event: 'auth.reset_mail_failed', error: err.message }));
  }
}));
app.post('/api/auth/reset', limitAuth, asyncRoute(async function (req, res) {
  const body = req.body || {};
  if (!validPassword(body.password)) return res.status(400).json({ error: 'Use a password of at least 12 characters.' });
  const userId = await auth.consumeToken(body.token, 'reset');
  if (!userId) return res.status(400).json({ error: 'This link is invalid or has expired.' });
  // Receiving the link proves the address, so a reset also verifies it.
  await db.query('UPDATE users SET password_hash = $1, email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $2', [await auth.hashPassword(body.password), userId]);
  await db.query('DELETE FROM user_sessions WHERE user_id = $1', [userId]);
  await auth.createSession(res, userId);
  res.status(204).end();
}));

app.post('/api/businesses', requireAdmin, asyncRoute(async function (req, res) {
  var name = typeof req.body.name === 'string' ? req.body.name.trim() : '';

  if (!name || name.length > 120) {
    return res.status(400).json({ error: 'A workspace name of up to 120 characters is required' });
  }

  if (req.user && !req.user.email_verified) return res.status(403).json({ error: 'Confirm your email before creating a workspace.' });
  var ownerId = req.user ? req.user.id : null;
  if (!req.user && req.body.owner_email !== undefined) {
    var owner = typeof req.body.owner_email === 'string' ? await db.query('SELECT id FROM users WHERE email = $1', [req.body.owner_email.trim().toLowerCase()]) : { rowCount: 0 };
    if (!owner.rowCount) return res.status(400).json({ error: 'owner_email does not match an account' });
    ownerId = owner.rows[0].id;
  }
  var business = ownerId
    // url is NOT NULL from the scraper era; documents are the only source now.
    ? (await db.query("INSERT INTO businesses (name, url, owner_id) VALUES ($1, '', $2) RETURNING *", [name, ownerId])).rows[0]
    : await db.insertBusiness(name, '');

  if (!business) {
    return res.status(500).json({ error: 'failed to create business' });
  }

  res.json({
    businessId: business.id,
    status: 'pending',
    embedScript: '<script src="' + req.protocol + '://' + req.get('host') + '/widget.js" data-business-id="' + business.id + '"></script>',
    embedIframe: '<iframe src="' + embedOrigin + '/embed/' + business.id + '" width="360" height="560" style="border:0;position:fixed;right:20px;bottom:20px;z-index:999999;border-radius:12px;" title="' + name + ' assistant"></iframe>',
  });
}));

app.get('/api/businesses/:id', asyncRoute(async function (req, res) {
  var business = validBusinessId(req.params.id) ? await db.getBusinessById(req.params.id) : null;

  if (!business) {
    return res.status(404).json({ error: 'business not found' });
  }

  return res.json({ business: { id: business.id, name: business.name, greeting: business.greeting, accent_color: business.accent_color } });
}));

const settingsFields = ['name', 'scope', 'greeting', 'accent_color', 'notify_email', 'notify_on_unanswered'];

app.get('/api/businesses/:id/settings', requireAdmin, asyncRoute(async function (req, res) {
  if (!validBusinessId(req.params.id)) return res.status(404).json({ error: 'Business not found' });
  const settings = await db.getBusinessProfileCols(req.params.id, settingsFields);
  if (!settings) return res.status(404).json({ error: 'Business not found' });
  res.json({ settings });
}));

app.patch('/api/businesses/:id/settings', requireAdmin, asyncRoute(async function (req, res) {
  if (!validBusinessId(req.params.id)) return res.status(404).json({ error: 'Business not found' });
  const body = req.body || {};
  const fields = {};
  for (const key of settingsFields) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    let value = body[key];
    if (key === 'name') {
      if (typeof value !== 'string' || !value.trim() || value.trim().length > 120) return res.status(400).json({ error: 'name must be 1–120 characters' });
      value = value.trim();
    } else if (key === 'scope' || key === 'greeting') {
      if (typeof value !== 'string' || value.length > (key === 'scope' ? 600 : 300)) return res.status(400).json({ error: key + ' is too long or invalid' });
    } else if (key === 'accent_color') {
      if (value !== null && (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value))) return res.status(400).json({ error: 'accent_color must be a six-digit hex color or null' });
    } else if (key === 'notify_email') {
      if (value === '' || value === null) value = null;
      else if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return res.status(400).json({ error: 'notify_email must be a valid email or null' });
    } else if (typeof value !== 'boolean') return res.status(400).json({ error: 'notify_on_unanswered must be a boolean' });
    fields[key] = value;
  }
  const exists = await db.getBusinessProfileCols(req.params.id, settingsFields);
  if (!exists) return res.status(404).json({ error: 'Business not found' });
  await db.updateBusiness(req.params.id, fields);
  db.clearBusinessCache(req.params.id);
  res.json({ settings: await db.getBusinessProfileCols(req.params.id, settingsFields) });
}));

app.delete('/api/businesses/:id', requireAdmin, asyncRoute(async function (req, res) {
  const business = validBusinessId(req.params.id) ? await db.getBusinessById(req.params.id) : null;
  if (!business) return res.status(404).json({ error: 'Business not found' });
  if (!req.body || req.body.confirm !== business.name) return res.status(400).json({ error: 'confirm must match the workspace name' });
  await db.query('DELETE FROM businesses WHERE id = $1', [req.params.id]);
  db.clearBusinessCache(req.params.id);
  res.status(204).end();
}));

app.get('/api/inbox/:businessId', requireAdmin, asyncRoute(async function (req, res) {
  if (!validBusinessId(req.params.businessId) || !await db.getBusinessById(req.params.businessId)) return res.status(404).json({ error: 'Business not found' });
  const status = req.query.status || 'unanswered';
  const state = req.query.state || 'open';
  if (!['unanswered', 'off_topic', 'blocked'].includes(status) || !['open', 'resolved'].includes(state)) return res.status(400).json({ error: 'Invalid status or state' });
  const [items, counts] = await Promise.all([
    db.query(`SELECT * FROM inbox_items WHERE business_id = $1 AND status = $2 AND (resolved_at IS NULL) = $3 ORDER BY created_at DESC, id DESC LIMIT 100`, [req.params.businessId, status, state === 'open']),
    db.query(`SELECT status, count(*)::int AS count FROM inbox_items WHERE business_id = $1 AND resolved_at IS NULL GROUP BY status`, [req.params.businessId]),
  ]);
  const totals = { unanswered: 0, off_topic: 0, blocked: 0 };
  for (const row of counts.rows) if (Object.prototype.hasOwnProperty.call(totals, row.status)) totals[row.status] = row.count;
  res.json({ items: items.rows, counts: totals });
}));

app.patch('/api/inbox/:businessId/:itemId', requireAdmin, asyncRoute(async function (req, res) {
  if (!validBusinessId(req.params.businessId) || !validBusinessId(req.params.itemId)) return res.status(404).json({ error: 'Item not found' });
  if (!req.body || typeof req.body.resolved !== 'boolean') return res.status(400).json({ error: 'resolved must be a boolean' });
  const result = await db.query('UPDATE inbox_items SET resolved_at = CASE WHEN $3 THEN COALESCE(resolved_at, now()) ELSE NULL END WHERE business_id = $1 AND id = $2 RETURNING *', [req.params.businessId, req.params.itemId, req.body.resolved]);
  if (!result.rowCount) return res.status(404).json({ error: 'Item not found' });
  res.json({ item: result.rows[0] });
}));

app.post('/api/inbox/:businessId/:itemId/answer', requireAdmin, asyncRoute(async function (req, res) {
  if (!validBusinessId(req.params.businessId) || !validBusinessId(req.params.itemId)) return res.status(404).json({ error: 'Item not found' });
  const answer = req.body && req.body.answer;
  if (typeof answer !== 'string' || !answer.trim() || answer.length > 4000) return res.status(400).json({ error: 'answer must be 1–4000 characters' });
  const found = await db.query('SELECT * FROM inbox_items WHERE business_id = $1 AND id = $2', [req.params.businessId, req.params.itemId]);
  if (!found.rowCount) return res.status(404).json({ error: 'Item not found' });
  const item = found.rows[0];
  const document = await db.createDocument(req.params.businessId, 'Answer: ' + item.question.slice(0, 60), 'paste');
  // Resolve only once the answer is searchable; on failure the question stays open and the owner keeps their text.
  try {
    await ingestDocument(req.params.businessId, document, { text: 'Q: ' + item.question + '\n\nA: ' + answer });
  } catch (err) {
    console.error('[sources] answer ingest failed for', req.params.businessId, document.id, err.message);
    await removeDocument(req.params.businessId, document.id).catch(function () {});
    return res.status(502).json({ error: 'Could not add this answer to your knowledge. The question is still open; try again.' });
  }
  const updated = await db.query('UPDATE inbox_items SET resolved_at = COALESCE(resolved_at, now()) WHERE business_id = $1 AND id = $2 RETURNING *', [req.params.businessId, req.params.itemId]);
  res.json({ document: await db.getDocument(req.params.businessId, document.id), item: updated.rows[0] });
}));

app.get('/api/businesses/:id/dashboard', requireAdmin, asyncRoute(async function (req, res) {
  var businessId = Number(req.params.id);

  var business = await db.getBusinessById(businessId);
  if (!business) return res.status(404).json({ error: 'business not found' });

  return res.json({ business: business });
}));

const MAX_DOCUMENT_BYTES = 18 * 1024 * 1024;

app.post('/api/sources/:businessId', requireAdmin, uploadJson, asyncRoute(async function (req, res) {
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

  var firstLine = filename ? '' : body.text.trim().split('\n')[0].replace(/^#+\s*/, '').trim().slice(0, 80);
  var document = await db.createDocument(businessId, filename || firstLine || 'Pasted text ' + new Date().toISOString().slice(0, 10), sourceType);
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
    var controller = new AbortController();
    res.on('close', function () { closed = true; if (!res.writableEnded) controller.abort(); });
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
        signal:     controller.signal,
        onToken:    function (t) { send({ token: t }); },
      }));

      // Classify before the final event so non-answers carry no sources and can offer a follow-up.
      // Sources go out now; the final event hides them if classification says the question went unanswered.
      if (!result.escalated && result.citations.length) send({ citations: result.citations });
      var classification = await traces.stage('classify', async function () {
        return classifyExchange({ question: message, answer: result.response, chunks: result.chunks, business, topicContext: await db.getClassificationContext(businessId), result, confidence: result.confidence });
      }).catch(function () { return null; });
      if (!classification) {
        const topicContext = await db.getClassificationContext(businessId);
        classification = await classifyExchange({ question: message, answer: result.response, chunks: result.chunks, business, topicContext, result, confidence: result.confidence });
      }
      if (controller.signal.aborted) return { source: 'aborted' };
      var status = classification.status;
      await db.saveMessage(businessId, sessionId, 'visitor', message, { channel: surface });
      await db.saveMessage(businessId, sessionId, 'assistant', result.response, {
        confidence: result.confidence, escalated: result.escalated, source: result.source,
        channel: surface, answer_status: status,
      });
      send({
        done: true,
        ...(surface === 'widget' ? { followUp: Boolean(result.escalated || status === 'unanswered' || /^\s*\[UNANSWERED\]/i.test(result.response || '')) } : {}),
        status:     status,
        escalated:  result.escalated,
        source:     result.source,
        confidence: result.confidence,
        sessionId:  sessionId,
        citations:  !status || status === 'answered' ? result.citations : [],
        traceId: trace.id,
      });
      res.end();
      recordExchange(businessId, sessionId, surface, message, result, business, classification || undefined);
      return result;
    } catch (err) {
      if (controller.signal.aborted) return { source: 'aborted' }; // client left; not a provider error
      traces.recordError(err);
      console.error(JSON.stringify({ event: 'rag.request_error', trace_id: trace.id, message: err.message }));
      if (!sentText) send({ token: "I'm having trouble right now. Please try again." });
      send({ done: true, error: 'Unable to answer. Please try again.', escalated: false, source: 'error', sessionId: sessionId, citations: [], traceId: trace.id });
      res.end();
      return { source: 'error' };
    }
  });
}

function recordExchange(businessId, sessionId, surface, message, result, business, classification) {
  setImmediate(async function () {
    try {
      if (!classification) {
        const topicContext = await db.getClassificationContext(businessId);
        classification = await classifyExchange({ question: message, answer: result.response, chunks: result.chunks, business, topicContext, result, confidence: result.confidence });
      }
      if (['unanswered', 'off_topic', 'blocked'].includes(classification.status)) {
        const inserted = await db.query('INSERT INTO inbox_items (business_id, session_id, channel, status, question, answer, reason) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *', [businessId, sessionId, surface, classification.status, message, result.response, classification.reason]);
        if (classification.status === 'unanswered') await notifyUnanswered({ business, item: inserted.rows[0] });
      }

    } catch (asyncErr) {
      console.error('Chat side-effects failed:', asyncErr.message);
    }
  });
}

app.post('/api/chat/:businessId/stream', limitChat, function (req, res) {
  return handleChatStream(req, res, 'widget');
});

app.get('/api/chat/:businessId/history', asyncRoute(async function (req, res) {
  if (typeof req.query.sessionId !== 'string' || !req.query.sessionId || req.query.sessionId.length > 100) return res.status(400).json({ error: 'sessionId is required' });
  res.json(await db.getHistory(req.params.businessId, req.query.sessionId, 'widget', 100));
}));

app.post('/api/chat/:businessId/lead', asyncRoute(async function (req, res) {
  if (!validBusinessId(req.params.businessId)) return res.status(404).json({ error: 'Business not found' });
  if (!hit('lead:' + req.ip, 10, 60 * 1000)) return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
  const body = req.body || {};
  // undefined = invalid, null = not given
  const field = (value, max) => value === undefined || value === null || value === '' ? null : typeof value === 'string' && value.trim().length <= max ? value.trim() || null : undefined;
  const name = field(body.name, 120), email = field(body.email, 254), phone = field(body.phone, 40);
  if (typeof body.sessionId !== 'string' || !body.sessionId || body.sessionId.length > 100) return res.status(400).json({ error: 'sessionId is required' });
  if (name === undefined || email === undefined || phone === undefined || (email && !EMAIL.test(email)) || (!email && !phone)) return res.status(400).json({ error: 'Enter a valid email or phone number.' });
  if (!await db.getBusinessById(req.params.businessId)) return res.status(404).json({ error: 'Business not found' });
  await db.saveLead(req.params.businessId, body.sessionId, {
    name, email, phone,
    intent:             'unknown',
    sentiment:          'neutral',
    follow_up_priority: 'medium',
    key_question:       null,
  });
  res.json({ success: true });
}));

app.post('/api/team/:businessId/stream', requireAdmin, function (req, res) {
  return handleChatStream(req, res, 'team');
});

app.get('/api/team/:businessId/threads', requireAdmin, asyncRoute(async function (req, res) {
  res.json(await db.getSessions(req.params.businessId, { channel: 'team' }));
}));

app.get('/api/team/:businessId/threads/:threadId', requireAdmin, asyncRoute(async function (req, res) {
  res.json(await db.getHistory(req.params.businessId, req.params.threadId, 'team', 200));
}));

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

app.get('/api/dashboard/:businessId/stats', requireAdmin, asyncRoute(async function (req, res) {
  res.json(await db.getDashboardStats(req.params.businessId));
}));

app.get('/api/dashboard/:businessId/transcripts', requireAdmin, asyncRoute(async function (req, res) {
  res.json(await db.getTranscripts(req.params.businessId, req.query.sessionId || null));
}));

app.get('/api/dashboard/:businessId/sessions', requireAdmin, asyncRoute(async function (req, res) {
  res.json(await db.getSessions(req.params.businessId));
}));

app.get('/api/dashboard/:businessId/leads', requireAdmin, asyncRoute(async function (req, res) {
  res.json(await db.getLeads(req.params.businessId, {
    limit:    Number(req.query.limit) || 100,
    priority: req.query.priority      || null,
  }));
}));

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

async function requireApiKey(req, res, next) {
  try {
    var header = req.headers.authorization || '';
    var key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    var found = /^ogk_[A-Za-z0-9_-]{32}$/.test(key) ? await db.findApiKey(key) : null;
    if (!found) return res.status(401).json({ error: 'Invalid or revoked API key' });
    if (!hit('key:' + found.id, 60, 60 * 1000)) return res.status(429).json({ error: 'Rate limit is 60 requests per minute per key' });
    req.businessId = Number(found.business_id);
    next();
  } catch (err) { next(err); }
}

app.get('/api/v1/documents', requireApiKey, asyncRoute(async function (req, res) {
  res.json({ documents: await db.listDocuments(req.businessId) });
}));

app.post('/api/v1/documents', requireApiKey, uploadJson, asyncRoute(async function (req, res) {
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
    var controller = new AbortController();
    res.on('close', function () { if (!res.writableEnded) controller.abort(); });
    try {
      var business = await traces.stage('business', () => db.getClient(businessId));
      var history = await traces.stage('history', () => db.getHistory(businessId, sessionId, 'api'));
      var result = await traces.stage('agent', () => runAgent({ businessId, business, surface: 'api', sessionId, history, message: question, signal: controller.signal }));
      var marked = /^\s*\[UNANSWERED\]\s*:?\s*/i;
      if (marked.test(result.response || '')) result = { ...result, response: result.response.replace(marked, ''), escalated: true };
      var topicContext = await db.getClassificationContext(businessId);
      var classification = await classifyExchange({ question, answer: result.response, chunks: result.chunks, business, topicContext, result, confidence: result.confidence });
      if (controller.signal.aborted) return { source: 'aborted' };
      await db.saveMessage(businessId, sessionId, 'visitor', question, { channel: 'api' });
      await db.saveMessage(businessId, sessionId, 'assistant', result.response, {
        confidence: result.confidence, escalated: result.escalated, source: result.source,
        channel: 'api', answer_status: classification.status,
      });
      res.json({
        answer: result.response,
        citations: result.citations.map(function (c) { return { index: c.index, source: c.source, excerpt: c.content }; }),
        status: classification.status,
        unanswered: classification.status === 'unanswered',
        confidence: result.confidence,
        sessionId: sessionId,
        traceId: trace.id,
      });
      recordExchange(businessId, sessionId, 'api', question, result, business, classification);
      return result;
    } catch (err) {
      if (controller.signal.aborted) return { source: 'aborted' }; // client left; not a provider error
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
  const recovered = await recoverInterrupted();
  if (recovered.failed || recovered.deleting) console.log('[sources] recovered after restart: ' + recovered.failed + ' interrupted, ' + recovered.deleting + ' pending deletes');
  const dim = await embeddingDim();
  if (dim !== embedCfg.dim) console.log('[db] ' + embedCfg.model + ' returns ' + dim + '-dimension vectors');
  embedCfg.dim = dim;
  if (await db.ensureSchema(dim)) console.log('[db] embedding model changed; re-embedding stored content');
  const count = await reembedMissing();
  if (count) console.log('[db] embedded ' + count + ' stored chunks');
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

function pruneAuth() {
  auth.pruneExpired().catch((err) => console.error(JSON.stringify({ event: 'auth.prune_failed', message: err.message })));
}
pruneAuth();
setInterval(pruneAuth, 60 * 60 * 1000).unref();

app.listen(port, function () {
  console.log('glazed server running on http://localhost:' + port);
});

}
