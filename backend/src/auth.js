'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const db = require('./db');

let schema;
function ensureAuthSchema() {
  if (!schema) schema = db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY, email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS user_sessions (
      token_hash TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS owner_id BIGINT REFERENCES users(id);
    CREATE INDEX IF NOT EXISTS idx_businesses_owner ON businesses(owner_id);
    CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
    -- The default only fills rows that exist when the column is added, so accounts made before verification count as verified.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ DEFAULT now();
    ALTER TABLE users ALTER COLUMN email_verified_at DROP DEFAULT;
    CREATE TABLE IF NOT EXISTS auth_tokens (
      token_hash TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL CHECK (purpose IN ('verify', 'reset')),
      expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `).catch((err) => { schema = null; throw err; });
  return schema;
}
const digest = (token) => crypto.createHash('sha256').update(token).digest('hex');
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64);
  return `${salt}:${hash.toString('hex')}`;
}
async function verifyPassword(password, stored) {
  const [salt, value] = stored.split(':');
  if (!salt || !value || !/^[a-f0-9]{128}$/.test(value)) return false;
  const hash = await scrypt(password, salt, 64);
  return crypto.timingSafeEqual(hash, Buffer.from(value, 'hex'));
}
function sessionToken(req) {
  const cookie = (req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith('og_session='));
  return cookie ? cookie.slice('og_session='.length) : '';
}
function setCookie(res, token, maxAge) {
  res.cookie('og_session', token, { httpOnly: true, secure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge });
}
async function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const maxAge = 7 * 24 * 60 * 60 * 1000;
  await db.query('INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval \'7 days\')', [digest(token), userId]);
  setCookie(res, token, maxAge);
}
async function getUser(req) {
  const token = sessionToken(req);
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  await ensureAuthSchema();
  const result = await db.query('SELECT u.id, u.email, u.email_verified_at IS NOT NULL AS email_verified, s.token_hash AS session_hash FROM users u JOIN user_sessions s ON s.user_id = u.id WHERE s.token_hash = $1 AND s.expires_at > now()', [digest(token)]);
  return result.rows[0] || null;
}
// Single-use emailed token; only its hash is stored.
async function issueToken(userId, purpose, ttl) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.query('DELETE FROM auth_tokens WHERE user_id = $1 AND purpose = $2', [userId, purpose]);
  await db.query('INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at) VALUES ($1, $2, $3, now() + $4::interval)', [digest(token), userId, purpose, ttl]);
  return token;
}
async function consumeToken(token, purpose) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
  await ensureAuthSchema();
  const result = await db.query('DELETE FROM auth_tokens WHERE token_hash = $1 AND purpose = $2 RETURNING user_id, expires_at > now() AS live', [digest(token), purpose]);
  return result.rows[0] && result.rows[0].live ? result.rows[0].user_id : null;
}
async function pruneExpired() {
  await ensureAuthSchema();
  await db.query('DELETE FROM user_sessions WHERE expires_at <= now()');
  await db.query('DELETE FROM auth_tokens WHERE expires_at <= now()');
}
async function logout(req, res) {
  const token = sessionToken(req);
  if (/^[a-f0-9]{64}$/.test(token)) await db.query('DELETE FROM user_sessions WHERE token_hash = $1', [digest(token)]);
  setCookie(res, '', 0);
}
module.exports = { ensureAuthSchema, hashPassword, verifyPassword, createSession, getUser, logout, setCookie, issueToken, consumeToken, pruneExpired };
