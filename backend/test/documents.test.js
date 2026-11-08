'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.LLM_BASE_URL = 'http://127.0.0.1:1/v1';
process.env.EMBED_BASE_URL = 'http://127.0.0.1:1/v1';

function tinyPdf(lines) {
  const stream = 'BT /F1 12 Tf 72 720 Td 14 TL ' + lines.map((line) => `(${line}) Tj T*`).join(' ') + ' ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const offset = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

test('pdf parser returns one cited section per page', async () => {
  const pdf = require('../src/sources/pdf');
  const sections = await pdf.parse({ data: tinyPdf(['Refunds are accepted within 30 days.']), filename: 'policy.pdf' });
  assert.equal(sections.length, 1);
  assert.match(sections[0].content, /Refunds are accepted within 30 days/);
  assert.equal(sections[0].url, 'policy.pdf p.1');
});

test('pdf parser reports a missing text layer', async () => {
  const pdf = require('../src/sources/pdf');
  await assert.rejects(pdf.parse({ data: tinyPdf([]), filename: 'scan.pdf' }), /No text layer/);
});

test('pdf parsing runs in a worker and passes parser errors back', async () => {
  const { parseInWorker } = require('../src/sources');
  const sections = await parseInWorker('pdf', { data: tinyPdf(['Shipping is free over $50.']), filename: 'ship.pdf' });
  assert.match(sections[0].content, /Shipping is free over \$50/);
  await assert.rejects(parseInWorker('pdf', { data: tinyPdf([]), filename: 'scan.pdf' }), /No text layer/);
});

test('docx zip bombs are rejected from the central directory before inflating', async () => {
  const { parseInWorker, zipUncompressedSize } = require('../src/sources');
  const name = Buffer.from('word/document.xml');
  const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt32LE(0xffffffff, 24); entry.writeUInt16LE(name.length, 28);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(4, 16);
  const bomb = Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), entry, name, eocd]);
  assert.equal(zipUncompressedSize(bomb), 0xffffffff);
  await assert.rejects(parseInWorker('docx', { data: bomb, filename: 'bomb.docx' }), /expands to more than 200 MB/);
  assert.throws(() => zipUncompressedSize(Buffer.from('PK not a zip')), /valid DOCX/);
});

test('json parser splits arrays and rejects invalid JSON', () => {
  const json = require('../src/sources/json');
  const sections = json.parse({ text: '[{"q":"a"},{"q":"b"}]', filename: 'faq.json' });
  assert.equal(sections.length, 2);
  assert.equal(sections[1].heading, 'faq.json #2');
  assert.throws(() => json.parse({ text: '{bad', filename: 'x.json' }), /not valid JSON/);
});

test('document types come from the file extension', () => {
  const { documentTypeFor } = require('../src/sources');
  assert.equal(documentTypeFor('Handbook.PDF'), 'pdf');
  assert.equal(documentTypeFor('notes.txt'), 'paste');
  assert.equal(documentTypeFor('readme.md'), 'markdown');
  assert.equal(documentTypeFor('virus.exe'), null);
});

test('documents are scoped to their workspace and stats use document metrics', { skip: !process.env.AUTH_TEST_DATABASE_URL }, async () => {
  process.env.DATABASE_URL = process.env.AUTH_TEST_DATABASE_URL;
  process.env.ADMIN_TOKEN = 'documents-test-admin';
  const app = require('../src/server');
  const db = require('../src/db');
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const suffix = crypto.randomBytes(8).toString('hex');
  const emails = [`docs-a-${suffix}@example.test`, `docs-b-${suffix}@example.test`];
  const post = (path, body, cookie) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  try {
    const cookies = [];
    for (const email of emails) {
      const res = await post('/api/auth/signup', { email, password: 'documents test password' });
      assert.equal(res.status, 201);
      cookies.push(res.headers.get('set-cookie').split(';')[0]);
    }
    const [cookieA, cookieB] = cookies;
    const created = await post('/api/businesses', { name: 'Docs A' }, cookieA);
    assert.equal(created.status, 200);
    const businessA = (await created.json()).businessId;
    const businessB = (await (await post('/api/businesses', { name: 'Docs B' }, cookieB)).json()).businessId;

    assert.equal((await post(`/api/sources/${businessA}`, { filename: 'tool.exe', text: 'x' }, cookieA)).status, 400);
    assert.equal((await post(`/api/sources/${businessA}`, { filename: 'fake.pdf', data: Buffer.from('nope').toString('base64') }, cookieA)).status, 400);
    const upload = await post(`/api/sources/${businessA}`, { filename: 'notes.md', text: '# Refunds\nRefunds within 30 days.' }, cookieA);
    assert.equal(upload.status, 202);
    const doc = (await upload.json()).document;
    assert.equal(doc.source_type, 'markdown');

    const listed = await (await fetch(`${base}/api/sources/${businessA}`, { headers: { cookie: cookieA } })).json();
    assert.deepEqual(listed.documents.map((d) => d.id), [doc.id]);
    assert.equal((await fetch(`${base}/api/sources/${businessA}`, { headers: { cookie: cookieB } })).status, 404);
    assert.equal((await fetch(`${base}/api/sources/${businessA}/${doc.id}`, { method: 'DELETE', headers: { cookie: cookieB } })).status, 404);
    assert.equal((await fetch(`${base}/api/sources/${businessB}/${doc.id}`, { method: 'DELETE', headers: { cookie: cookieB } })).status, 404);

    const stats = await (await fetch(`${base}/api/dashboard/${businessA}/stats`, { headers: { cookie: cookieA } })).json();
    assert.deepEqual(Object.keys(stats).sort(), ['conversations', 'documents', 'medianLatencyMs', 'offTopic', 'questionsAnswered', 'totalLeads', 'unansweredRate']);
    assert.equal(stats.unansweredRate, null);
    assert.equal(stats.medianLatencyMs, null);
    for (const status of ['answered', 'unanswered', 'off_topic', 'smalltalk']) await db.saveMessage(businessA, 'stats-session', 'assistant', 'reply', { channel: 'widget', answer_status: status });
    const counted = await (await fetch(`${base}/api/dashboard/${businessA}/stats`, { headers: { cookie: cookieA } })).json();
    assert.equal(counted.questionsAnswered, 1, 'only answered questions count');
    assert.equal(counted.unansweredRate, 0.5, 'per on-topic question, not per conversation');

    assert.equal((await fetch(`${base}/api/sources/${businessA}/${doc.id}`, { method: 'DELETE', headers: { cookie: cookieA } })).status, 202);
    for (let i = 0; i < 50 && (await db.listDocuments(businessA)).length; i += 1) await new Promise((r) => setTimeout(r, 100));
    assert.equal((await db.listDocuments(businessA)).length, 0);
    assert.equal(await db.countChunksBySource(businessA, 'doc:' + doc.id), 0);
    await db.query('DELETE FROM businesses WHERE id = ANY($1)', [[businessA, businessB]]);
  } finally {
    await db.query('DELETE FROM users WHERE email = ANY($1)', [emails]);
    await new Promise((resolve) => server.close(resolve));
    await db.pool.end();
  }
});

test('file parsing runs at most two workers at once', async () => {
  const { withParseSlot } = require('../src/sources');
  let running = 0;
  let peak = 0;
  const job = () => withParseSlot(async () => {
    running += 1; peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 20));
    running -= 1;
  });
  await Promise.all([job(), job(), job(), job(), job()]);
  assert.equal(peak, 2);
  assert.equal(running, 0);
});
