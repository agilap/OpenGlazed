'use strict';

const db = require('../src/db');

async function main() {
  const [businessId, email] = process.argv.slice(2);
  if (!businessId || !email || !/^[1-9]\d{0,18}$/.test(businessId)) throw new Error('Usage: npm run assign-owner -w backend -- <businessId> <email>');
  const user = await db.query('SELECT id FROM users WHERE email = $1', [email.trim().toLowerCase()]);
  if (!user.rowCount) throw new Error('Account not found');
  const business = await db.query('UPDATE businesses SET owner_id = $1 WHERE id = $2 RETURNING id', [user.rows[0].id, businessId]);
  if (!business.rowCount) throw new Error('Workspace not found');
  console.log(`Assigned workspace ${businessId} to ${email}`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => db.pool.end());
