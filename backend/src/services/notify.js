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

const logFailure = (error) => console.error(JSON.stringify({ event: 'notify.failed', error: error.message }));

// shortcut: at-most-once; a crash between claim and send drops the email, add a retry job if alerts become critical.
async function notifyUnanswered({ business, item }) {
  if (!process.env.SMTP_HOST || !business.notify_email || !business.notify_on_unanswered) return;
  const claimed = await db.query('UPDATE inbox_items SET notified_at = now() WHERE id = $1 AND business_id = $2 AND notified_at IS NULL RETURNING id', [item.id, business.id]).catch(logFailure);
  if (!claimed || !claimed.rowCount) return;
  try {
    await sendMail({
      to: business.notify_email,
      subject: `Unanswered question in ${business.name}`,
      text: `Question: ${item.question}\n\nAssistant reply: ${item.answer || ''}\n\nChannel: ${item.channel}\nTime: ${new Date(item.created_at).toISOString()}\n\n${appUrl()}/dashboard/${business.id}/inbox`,
    });
  } catch (error) {
    logFailure(error);
    await db.query('UPDATE inbox_items SET notified_at = NULL WHERE id = $1 AND business_id = $2', [item.id, business.id]).catch(() => {});
  }
}

module.exports = { notifyUnanswered, sendMail, mailConfigured, appUrl };
