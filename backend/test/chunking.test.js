'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSemanticChunks, extractCleanPageText } = require('../src/ingest');

const make = (content, extra = {}) => ({ content, url: 'https://example.test/faq', ...extra });

test('short factual FAQs survive ingestion', () => {
  const chunks = buildSemanticChunks([make('Refunds within 30 days.', { heading: 'Returns' })], 7);
  assert.equal(chunks.length, 1);
  assert.match(chunks[0].content, /Refunds within 30 days\./);
});

test('oversized unpunctuated sentences obey the heading-inclusive budget', () => {
  const text = Array.from({ length: 650 }, (_, i) => `word${i}`).join(' ');
  const chunks = buildSemanticChunks([make(text, { heading: 'Policy details' })], 7);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.content.length <= 1280);
    assert.equal(chunk.token_count, Math.ceil(chunk.content.length / 4));
  }
  assert.equal(chunks.map(c => c.content.replace(/^## Policy details\n\n/, '')).join(' '), text);
});

test('extremely long headings cannot consume the content budget', () => {
  const chunks = buildSemanticChunks([make('Delivery takes 3 days.', { heading: 'x'.repeat(1500) })], 7);
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].token_count <= 320);
  assert.match(chunks[0].content, /Delivery takes 3 days\./);
});

test('dedupe preserves distinct source provenance and near-identical numeric facts', () => {
  const repeated = 'Our annual business plan includes unlimited support for all team members and access to every product feature.';
  const chunks = buildSemanticChunks([
    make(repeated), make(repeated, { url: 'https://example.test/other' }),
    make(repeated + ' Costs $10.'), make(repeated + ' Costs $20.'), make(repeated),
  ], 7);
  assert.equal(chunks.length, 4);
});

test('HTML extraction keeps short facts and paragraph boundaries', () => {
  const content = extractCleanPageText('<main><h2>Returns</h2><p>Refunds: 30 days.</p><p>Shipping: $5.</p></main>');
  assert.match(content, /Returns\n\nRefunds: 30 days\.\n\nShipping: \$5\./);
});


test('section scraper preserves short FAQs and separates block text', () => {
  const cheerio = require('cheerio');
  const { extractSections } = require('../src/services/scraper');
  const sections = extractSections(cheerio.load('<main><h2>Returns</h2><p>Refunds: 30 days.</p><p>Shipping: $5.</p></main>'), 'https://example.test');
  assert.equal(sections.length, 1);
  assert.equal(sections[0].heading, 'Returns');
  assert.equal(sections[0].content, 'Refunds: 30 days.\n\nShipping: $5.');
});

test('long single tokens terminate and each chunk respects the estimate', () => {
  const token = Array.from({ length: 550 }, (_, i) => `x${String(i).padStart(5, '0')}`).join('');
  const chunks = buildSemanticChunks([make(token)], 7);
  assert.equal(chunks.map(c => c.content).join(''), token);
  assert.ok(chunks.every(c => c.token_count <= 320));
});
