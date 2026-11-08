'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { ingestNormalized } = require('../ingest');
const db = require('../db');

const markdown = require('./markdown');
const paste = require('./paste');
const csv = require('./csv');
const pdf = require('./pdf');
const docx = require('./docx');
const json = require('./json');

const PARSERS = { markdown, paste, csv, pdf, docx, json };
const SUPPORTED = Object.keys(PARSERS);

async function ingestSource(businessId, sourceType, payload = {}) {
  const parser = PARSERS[sourceType];
  if (!parser) throw new Error(`Unsupported sourceType: ${sourceType}`);

  const sections = BINARY_TYPES.has(sourceType) ? await parseInWorker(sourceType, payload) : await parser.parse(payload);
  return ingestNormalized(sections, {
    businessId,
    sourceRef: payload.sourceRef || payload.filename || payload.url || sourceType,
  });
}

const FILE_TYPES = { pdf: 'pdf', docx: 'docx', md: 'markdown', markdown: 'markdown', txt: 'paste', csv: 'csv', json: 'json' };
const BINARY_TYPES = new Set(['pdf', 'docx']);
const PARSE_TIMEOUT_MS = Number(process.env.PARSE_TIMEOUT_MS) || 60 * 1000;
const MAX_DOCX_UNCOMPRESSED = 200 * 1024 * 1024;

// Sums the uncompressed sizes in the ZIP central directory, to reject zip bombs before inflating anything.
function zipUncompressedSize(buf) {
  const floor = Math.max(0, buf.length - 65557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= floor; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('This file does not look like a valid DOCX.');
  let offset = buf.readUInt32LE(eocd + 16);
  let total = 0;
  for (let n = buf.readUInt16LE(eocd + 10); n > 0; n--) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) throw new Error('This file does not look like a valid DOCX.');
    total += buf.readUInt32LE(offset + 24);
    offset += 46 + buf.readUInt16LE(offset + 28) + buf.readUInt16LE(offset + 30) + buf.readUInt16LE(offset + 32);
  }
  return total;
}

function parseInWorker(sourceType, { data, filename }) {
  if (sourceType === 'docx' && zipUncompressedSize(data) > MAX_DOCX_UNCOMPRESSED) return Promise.reject(new Error('This Word document expands to more than 200 MB.'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'parseWorker.js'), { workerData: { sourceType, data, filename }, resourceLimits: { maxOldGenerationSizeMb: 512 } });
    let settled = false;
    const finish = (error, sections) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      if (error) reject(error); else resolve(sections);
    };
    const timer = setTimeout(() => finish(new Error('This file took too long to read. Try a smaller file.')), PARSE_TIMEOUT_MS);
    worker.once('message', (message) => finish(message.error ? new Error(message.error) : null, message.sections));
    worker.once('error', (error) => finish(error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? new Error('This file needs too much memory to read.') : error));
    worker.once('exit', () => finish(new Error('The file reader stopped unexpectedly.')));
  });
}

function documentTypeFor(filename) {
  const ext = String(filename || '').toLowerCase().split('.').pop();
  return FILE_TYPES[ext] || null;
}

const queues = new Map();
function enqueue(businessId, task) {
  const key = String(businessId);
  const next = (queues.get(key) || Promise.resolve()).catch(() => {}).then(task);
  queues.set(key, next);
  next.catch(() => {}).finally(() => { if (queues.get(key) === next) queues.delete(key); });
  return next;
}

function ingestDocument(businessId, document, payload) {
  return enqueue(businessId, async () => {
    const sourceRef = 'doc:' + document.id;
    try {
      await db.updateDocument(document.id, { status: 'processing' });
      await ingestSource(businessId, document.source_type, { ...payload, filename: document.filename, sourceRef });
      await db.updateDocument(document.id, { status: 'ready', chunkCount: await db.countChunksBySource(businessId, sourceRef) });
    } catch (error) {
      await db.updateDocument(document.id, { status: 'error', error: String(error.message || error).slice(0, 300) }).catch(() => {});
      throw error;
    }
  });
}

function removeDocument(businessId, documentId) {
  return enqueue(businessId, async () => {
    await db.deleteDocument(businessId, documentId);
  });
}

// Jobs live in memory, so a restart orphans them. Uploaded bytes are not stored, so interrupted ingests cannot be resumed.
// shortcut: assumes one server process; with several, this would fail another instance's in-flight jobs.
// businessId limits recovery to one workspace (tests run in parallel against one database).
async function recoverInterrupted({ businessId = null } = {}) {
  const failed = await db.query("UPDATE documents SET status = 'error', error = 'Interrupted by a server restart. Upload the file again.' WHERE status IN ('queued', 'processing') AND ($1::bigint IS NULL OR business_id = $1) RETURNING id, business_id", [businessId]);
  for (const doc of failed.rows) await db.query('DELETE FROM chunks WHERE business_id = $1 AND source_ref = $2', [doc.business_id, 'doc:' + doc.id]);
  const deleting = await db.query("SELECT id, business_id FROM documents WHERE status = 'deleting' AND ($1::bigint IS NULL OR business_id = $1)", [businessId]);
  for (const doc of deleting.rows) removeDocument(doc.business_id, doc.id).catch((error) => console.error('[sources] delete retry failed for', doc.business_id, doc.id, error.message));
  return { failed: failed.rowCount, deleting: deleting.rowCount };
}

module.exports = { recoverInterrupted, parseInWorker, zipUncompressedSize, ingestSource, ingestDocument, removeDocument, documentTypeFor, BINARY_TYPES, SUPPORTED, PARSERS };
