'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const nodemailer = require('nodemailer');
const db = require('../src/db');
const { notifyUnanswered } = require('../src/services/notify');

const business = { id: 1, name: 'B', notify_email: 'a@b.co', notify_on_unanswered: true };
const item = { id: 5, question: 'q', answer: 'a', channel: 'widget', created_at: new Date() };

test('notify claims first, skips mail when already notified, releases claim on send failure', async (t) => {
  process.env.SMTP_HOST = 'smtp.test';
  const realQuery = db.query;
  const realTransport = nodemailer.createTransport;
  t.after(() => { delete process.env.SMTP_HOST; db.query = realQuery; nodemailer.createTransport = realTransport; });
  let sent = 0;
  let sendError = null;
  nodemailer.createTransport = () => ({ sendMail: async () => { sent++; if (sendError) throw sendError; } });
  const queries = [];
  let claimRows = 0;
  db.query = async (sql) => { queries.push(sql); return { rowCount: /IS NULL RETURNING/.test(sql) ? claimRows : 1, rows: [] }; };

  await notifyUnanswered({ business, item });
  assert.equal(sent, 0, 'already notified: no mail');

  claimRows = 1;
  sendError = new Error('smtp down');
  queries.length = 0;
  await notifyUnanswered({ business, item });
  assert.equal(sent, 1);
  assert.match(queries[1], /notified_at = NULL/, 'claim reset after failure');
});
