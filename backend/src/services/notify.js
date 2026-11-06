'use strict';

const nodemailer = require('nodemailer');
const db = require('../db');

const mailConfigured = () => Boolean(process.env.SMTP_HOST);
const appUrl = () => (process.env.APP_URL || 'http://localhost:5173').replace(/\/$/, '');

function sendMail(message) {
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    ...(process.env.SMTP_USER ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' } } : {}),
  });
  return transport.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, ...message });
}

async function notifyUnanswered({ business, item }) {
  if (!process.env.SMTP_HOST || !business.notify_email || !business.notify_on_unanswered) return;
  let client;
  try {
    client = await db.pool.connect();
    await client.query('BEGIN');
    const result = await client.query('SELECT notified_at FROM inbox_items WHERE id = $1 AND business_id = $2 FOR UPDATE', [item.id, business.id]);
    if (!result.rowCount || result.rows[0].notified_at) {
      await client.query('COMMIT');
      return;
    }
    await sendMail({
      to: business.notify_email,
      subject: `Unanswered question in ${business.name}`,
      text: `Question: ${item.question}\n\nAssistant reply: ${item.answer || ''}\n\nChannel: ${item.channel}\nTime: ${new Date(item.created_at).toISOString()}\n\n${appUrl()}/dashboard/${business.id}/inbox`,
    });
    await client.query('UPDATE inbox_items SET notified_at = now() WHERE id = $1 AND business_id = $2', [item.id, business.id]);
    await client.query('COMMIT');
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error(JSON.stringify({ event: 'notify.failed', error: error.message }));
  } finally {
    if (client) client.release();
  }
}

module.exports = { notifyUnanswered, sendMail, mailConfigured, appUrl };
