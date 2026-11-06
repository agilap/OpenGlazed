'use strict';

const { ingestNormalized, rebuildSummaries } = require('../ingest');
const db = require('../db');

const markdown = require('./markdown');
const paste = require('./paste');
const csv = require('./csv');
const pdf = require('./pdf');
const docx = require('./docx');
const json = require('./json');
const sitemap = require('./sitemap');

const PARSERS = { markdown, paste, csv, pdf, docx, json, sitemap };
const SUPPORTED = Object.keys(PARSERS);

async function ingestSource(businessId, sourceType, payload = {}) {
  const parser = PARSERS[sourceType];
  if (!parser) throw new Error(`Unsupported sourceType: ${sourceType}`);

  if (sourceType === 'sitemap') {
    const urls = await sitemap.parse(payload.text || payload.url);
    let total = 0;
    for (const u of urls) {
      const r = await ingestNormalized([{ heading: u, content: '', url: u }], {
        businessId,
        sourceType: 'url',
        sourceRef: u,
      });
      total += r.chunks;
    }
    return { chunks: total, sources: urls.length };
  }

  const sections = await parser.parse(payload);
  return ingestNormalized(sections, {
    businessId,
    sourceType,
    sourceRef: payload.sourceRef || payload.filename || payload.url || sourceType,
    skipSummaries: Boolean(payload.skipSummaries),
  });
}

const FILE_TYPES = { pdf: 'pdf', docx: 'docx', md: 'markdown', markdown: 'markdown', txt: 'paste', csv: 'csv', json: 'json' };
const BINARY_TYPES = new Set(['pdf', 'docx']);

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
      await ingestSource(businessId, document.source_type, { ...payload, filename: document.filename, sourceRef, skipSummaries: true });
      await db.updateDocument(document.id, { status: 'ready', chunkCount: await db.countChunksBySource(businessId, sourceRef) });
    } catch (error) {
      await db.updateDocument(document.id, { status: 'error', error: String(error.message || error).slice(0, 300) }).catch(() => {});
      throw error;
    } finally {
      scheduleSummaries(businessId);
    }
  });
}

const summaryPending = new Set();
function scheduleSummaries(businessId) {
  const key = String(businessId);
  if (summaryPending.has(key)) return;
  summaryPending.add(key);
  enqueue(businessId, async () => {
    summaryPending.delete(key);
    try {
      await rebuildSummaries(businessId);
    } catch (error) {
      console.warn('[sources] summary rebuild skipped:', error.message);
    }
  }).catch(() => {});
}

function removeDocument(businessId, documentId) {
  return enqueue(businessId, async () => {
    await db.deleteDocument(businessId, documentId);
    await db.deleteSummaries(businessId, 1);
    await db.deleteSummaries(businessId, 2);
    scheduleSummaries(businessId);
  });
}

module.exports = { ingestSource, ingestDocument, removeDocument, documentTypeFor, BINARY_TYPES, SUPPORTED, PARSERS };
