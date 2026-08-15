'use strict';

// Source adapter registry + dispatcher.
// Each adapter exports parse(payload) -> Array<{heading, content, url}> (the
// same canonical section shape scraper.js produces), so ingestNormalized() is
// source-agnostic. Adding a source = drop a file in this folder + register it.

const { ingestNormalized } = require('../ingest');

const markdown = require('./markdown');
const paste = require('./paste');
const csv = require('./csv');
const pdf = require('./pdf');
const docx = require('./docx');
const json = require('./json');
const sitemap = require('./sitemap');

const PARSERS = { markdown, paste, csv, pdf, docx, json, sitemap };
const SUPPORTED = Object.keys(PARSERS);

// payload shape varies: {text} | {text, filename} | {url} | {base64, filename}
async function ingestSource(businessId, sourceType, payload = {}) {
  const parser = PARSERS[sourceType];
  if (!parser) throw new Error(`Unsupported sourceType: ${sourceType}`);

  // sitemap is special: it yields URLs, each ingested as its own 'url' source.
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
    sourceRef: payload.filename || payload.url || sourceType,
  });
}

module.exports = { ingestSource, SUPPORTED, PARSERS };
