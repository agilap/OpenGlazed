'use strict';

const cheerio = require('cheerio');
const crypto = require('crypto');
const {
  updateClientStatus,
  updateIngestProgress,
  deleteChunksByBusiness,
  getStoredHashes,
  deleteChunksBySourceExcept,
  getAllChunks,
  insertChunks,
  deleteSummaries,
  insertSummaries,
  updateBusiness,
} = require('./db');

const { embedTexts } = require('./services/embeddings');
const { chatComplete } = require('./services/llm');

const SKIP_URL_PARTS = [
  'careers',
  'login',
  'privacy',
  'terms',
  'press',
  'sitemap',
  'cdn',
  'logout',
  'signup',
  'cookie',
  'legal',
  'unsubscribe',
];

const PRIORITY_URL_PARTS = [
  'pricing',
  'services',
  'products',
  'about',
  'faq',
  'contact',
  'case-study',
  'how-it-works',
  'features',
];

const MIN_CHARS = 80;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeWhitespace(text) {
  return text
    .replace(/\r/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[ \u00A0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function tokenizeWords(text) {
  return (text.toLowerCase().match(/[a-z0-9]+/g) || []);
}

function jaccardSimilarity(a, b) {
  const aSet = new Set(tokenizeWords(a));
  const bSet = new Set(tokenizeWords(b));

  if (aSet.size === 0 && bSet.size === 0) {
    return 1;
  }

  let intersection = 0;
  for (const token of aSet) {
    if (bSet.has(token)) {
      intersection += 1;
    }
  }

  const union = aSet.size + bSet.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const CHUNK_TOKEN_BUDGET = 320;
const TOKENS_PER_CHAR = 0.25;

function estimateTokens(text) {
  return Math.ceil(text.length * TOKENS_PER_CHAR);
}

function buildSemanticChunks(docs, businessId) {
  const chunks = [];

  for (const doc of docs) {
    const url = doc.url || null;
    const breadcrumb = doc.heading ? `## ${doc.heading}\n\n` : '';
    const paragraphs = (doc.content || '')
      .split(/\n{2,}/)
      .map((p) => normalizeWhitespace(p))
      .filter(Boolean);

    if (paragraphs.length === 0) continue;

    let current = '';
    let currentTokens = 0;

    const flush = () => {
      const content = normalizeWhitespace(breadcrumb + current).trim();
      if (content.length >= MIN_CHARS) {
        chunks.push({
          content,
          level: 0,
          source_url: url,
          business_id: businessId,
          token_count: estimateTokens(content),
          heading: doc.heading || null,
        });
      }
      current = '';
      currentTokens = 0;
    };

    for (const para of paragraphs) {
      const paraTokens = estimateTokens(para);

      if (currentTokens + paraTokens > CHUNK_TOKEN_BUDGET && current) {
        flush();
      }

      if (paraTokens > CHUNK_TOKEN_BUDGET) {
        const sentences = para.match(/[^.!?]+[.!?]*\s*/g) || [para];
        let buf = '';
        let bufTokens = 0;
        for (const sentence of sentences) {
          const sTokens = estimateTokens(sentence);
          if (bufTokens + sTokens > CHUNK_TOKEN_BUDGET && buf) {
            chunks.push({
              content: normalizeWhitespace(breadcrumb + buf).trim(),
              level: 0,
              source_url: url,
              business_id: businessId,
              token_count: estimateTokens(buf),
              heading: doc.heading || null,
            });
            buf = '';
            bufTokens = 0;
          }
          buf += sentence;
          bufTokens += sTokens;
        }
        if (buf.trim().length >= MIN_CHARS) {
          chunks.push({
            content: normalizeWhitespace(breadcrumb + buf).trim(),
            level: 0,
            source_url: url,
            business_id: businessId,
            token_count: estimateTokens(buf),
            heading: doc.heading || null,
          });
        }
        continue;
      }

      current += (current ? '\n\n' : '') + para;
      currentTokens += paraTokens;
    }

    if (current) flush();
  }

  return dedupeByJaccard(chunks);
}

function dedupeByJaccard(chunks) {
  const kept = [];

  for (const chunk of chunks) {
    let duplicate = false;
    for (const existing of kept) {
      if (jaccardSimilarity(existing.content, chunk.content) > 0.9) {
        duplicate = true;
        break;
      }
    }

    if (!duplicate) {
      kept.push(chunk);
    }
  }

  return kept;
}

function isSkippablePath(pathname) {
  const value = pathname.toLowerCase();
  return SKIP_URL_PARTS.some((part) => value.includes(part));
}

function getPriority(pathname) {
  const value = pathname.toLowerCase();
  return PRIORITY_URL_PARTS.some((part) => value.includes(part)) ? 2 : 1;
}

async function readRobotsDisallow(origin) {
  const disallow = [];

  try {
    const response = await fetch(`${origin}/robots.txt`);
    if (!response.ok) {
      return disallow;
    }

    const text = await response.text();
    const lines = text.split(/\r?\n/);
    let applyRules = false;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) {
        continue;
      }

      const uaMatch = line.match(/^user-agent\s*:\s*(.*)$/i);
      if (uaMatch) {
        const agent = uaMatch[1].trim().toLowerCase();
        applyRules = agent === '*';
        continue;
      }

      if (!applyRules) {
        continue;
      }

      const disallowMatch = line.match(/^disallow\s*:\s*(.*)$/i);
      if (disallowMatch) {
        const path = disallowMatch[1].trim();
        if (path) {
          disallow.push(path);
        }
      }
    }
  } catch (error) {
    console.warn('[ingest] robots.txt fetch failed:', error.message);
  }

  return disallow;
}

function isRobotsDisallowed(pathname, disallowRules) {
  if (!disallowRules || disallowRules.length === 0) {
    return false;
  }

  for (const rule of disallowRules) {
    if (rule === '/') {
      return true;
    }

    const normalizedRule = rule.endsWith('*') ? rule.slice(0, -1) : rule;
    if (!normalizedRule) {
      continue;
    }

    if (pathname.startsWith(normalizedRule)) {
      return true;
    }
  }

  return false;
}

function extractCleanPageText(html) {
  const $ = cheerio.load(html);

  $('nav, footer, header, script, style').remove();

  const bodyText = $('body').text();
  const normalized = normalizeWhitespace(bodyText);

  const lines = normalized
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.split(/\s+/).length >= 5);

  return normalizeWhitespace(lines.join('\n'));
}

function collectInternalLinks(html, pageUrl, origin) {
  const $ = cheerio.load(html);
  const links = [];

  $('a[href]').each((_, element) => {
    const href = $(element).attr('href');
    if (!href) {
      return;
    }

    try {
      const resolved = new URL(href, pageUrl);
      if (resolved.origin !== origin) {
        return;
      }

      resolved.hash = '';
      const normalized = `${resolved.origin}${resolved.pathname.replace(/\/$/, '') || '/'}${resolved.search}`;
      links.push(normalized);
    } catch (_error) {
      return;
    }
  });

  return links;
}

async function scrapeSite(startUrl, maxPages = 50) {
  const origin = new URL(startUrl).origin;
  const disallowRules = await readRobotsDisallow(origin);

  const visited = new Set();
  const pages = [];
  let queue = [{ url: startUrl, priority: getPriority(new URL(startUrl).pathname) }];

  while (queue.length > 0 && pages.length < maxPages) {
    queue.sort((a, b) => b.priority - a.priority);
    const next = queue.shift();
    const currentUrl = next.url;

    if (visited.has(currentUrl)) {
      continue;
    }

    visited.add(currentUrl);

    let parsed;
    try {
      parsed = new URL(currentUrl);
    } catch (_error) {
      continue;
    }

    const pathname = parsed.pathname.toLowerCase();

    if (isSkippablePath(pathname)) {
      continue;
    }

    if (isRobotsDisallowed(pathname, disallowRules)) {
      continue;
    }

    await sleep(1000);

    let response;
    try {
      response = await fetch(currentUrl, {
        headers: {
          'User-Agent': 'GlazedBot/1.0 (+https://glazed.ai)',
        },
      });
    } catch (error) {
      console.warn(`[ingest] Failed to fetch ${currentUrl}: ${error.message}`);
      continue;
    }

    if (!response.ok) {
      continue;
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) {
      continue;
    }

    const html = await response.text();

    const links = collectInternalLinks(html, currentUrl, origin);
    for (const link of links) {
      if (visited.has(link)) {
        continue;
      }

      const linkPath = new URL(link).pathname.toLowerCase();
      if (isSkippablePath(linkPath)) {
        continue;
      }

      if (isRobotsDisallowed(linkPath, disallowRules)) {
        continue;
      }

      queue.push({ url: link, priority: getPriority(linkPath) });
    }

    const content = extractCleanPageText(html);
    const wordCount = content ? content.split(/\s+/).length : 0;

    if (wordCount > 100) {
      pages.push({
        url: currentUrl,
        content,
      });
    }
  }

  return pages;
}

function buildLevel0Chunks(docs, businessId) {
  return buildSemanticChunks(docs, businessId);
}

async function embedTextsLocal(texts) {
  return embedTexts(texts);
}

async function attachChunkEmbeddings(chunks) {
  const batchSize = 50;

  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);

    try {
      const embeddings = await embedTextsLocal(batch.map((chunk) => chunk.content));
      batch.forEach((chunk, idx) => {
        chunk.embedding = embeddings[idx] || null;
      });
    } catch (error) {
      console.warn(`[ingest] Embedding batch ${i}-${i + batch.length - 1} failed: ${error.message}`);
      batch.forEach((chunk) => {
        chunk.embedding = null;
      });
    }
  }

  return chunks;
}

function hashText(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

async function storeLevel0Chunks(chunks, businessId, sourceRef = null) {
  if (!sourceRef) {
    await deleteChunksByBusiness(businessId);
  } else {
    const existing = await getStoredHashes(businessId, sourceRef);
    const incoming = chunks.map((c) => hashText(c.content));
    const keepHashes = incoming.filter((h) => !existing.has(h));
    const changed = new Set(keepHashes);

    const added = incoming.filter((h) => !existing.has(h)).length;
    const unchanged = incoming.length - added;
    const removed = await deleteChunksBySourceExcept(businessId, sourceRef, incoming);

    const toInsert = chunks.filter((c) => changed.has(hashText(c.content)));

    let insertedCount = 0;
    const batchSize = 100;
    for (let i = 0; i < toInsert.length; i += batchSize) {
      const batch = toInsert.slice(i, i + batchSize).map((chunk, idx) => ({
        business_id: businessId,
        chunk_text: chunk.content,
        source_url: chunk.source_url,
        source_ref: sourceRef,
        chunk_index: i + idx,
        level: 0,
        token_count: chunk.token_count,
        embedding: chunk.embedding || null,
        content_hash: hashText(chunk.content),
      }));
      const stored = await insertChunks(batch);
      insertedCount += stored.length;
    }

    return { added: insertedCount, unchanged, removed: Number(removed) || 0 };
  }

  const inserted = [];
  const batchSize = 100;

  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize).map((chunk, idx) => ({
      business_id: businessId,
      chunk_text: chunk.content,
      source_url: chunk.source_url,
      source_ref: sourceRef,
      chunk_index: i + idx,
      level: 0,
      token_count: chunk.token_count,
      embedding: chunk.embedding || null,
      content_hash: hashText(chunk.content),
    }));

    const stored = await insertChunks(batch);
    inserted.push(...stored);
  }

  return { added: inserted.length, unchanged: 0, removed: 0 };
}

async function ingestNormalized(sections, { businessId, sourceType, sourceRef }) {
  try {
    await updateClientStatus(businessId, 'ingesting');
    await updateIngestProgress(businessId, 10);

    if (!sections.length) {
      throw new Error('No usable content extracted from source');
    }

    const fakePages = sections.map((s) => ({ url: s.url || sourceRef, content: s.content, heading: s.heading || null }));
    const level0Chunks = buildSemanticChunks(fakePages, businessId);
    await updateIngestProgress(businessId, 25);

    await attachChunkEmbeddings(level0Chunks);
    await updateIngestProgress(businessId, 40);

    const stored = await storeLevel0Chunks(level0Chunks, businessId, sourceRef);
    await updateIngestProgress(businessId, 55);

    const allChunks = await getAllChunks(businessId);
    const level1Rows = await buildLevel1Summaries(allChunks, businessId);
    await updateIngestProgress(businessId, 70);

    const level2Summary = await buildLevel2Summary(level1Rows, businessId);
    await extractAndSaveBusinessProfile(level2Summary, businessId);

    await updateClientStatus(businessId, 'active');
    await updateIngestProgress(businessId, 100);
    return { chunks: stored.added, unchanged: stored.unchanged, removed: stored.removed };
  } catch (error) {
    await updateClientStatus(businessId, 'error');
    throw error;
  }
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
}
function norm(a) {
  return Math.sqrt(dot(a, a)) || 1;
}
function cosineDist(a, b) {
  return 1 - dot(a, b) / (norm(a) * norm(b));
}
function kmeans(vectors, k, iterations = 12) {
  const n = vectors.length;
  const dim = vectors[0].length;
  if (n <= k) return vectors.map((_, i) => i % k);

  const centroids = [vectors[Math.floor(Math.random() * n)].slice()];
  while (centroids.length < k) {
    let best = null;
    let bestD = -1;
    for (const v of vectors) {
      const d = Math.min(...centroids.map((c) => cosineDist(v, c)));
      if (d > bestD) { bestD = d; best = v; }
    }
    centroids.push(best.slice());
  }

  let labels = new Array(n).fill(0);
  for (let it = 0; it < iterations; it += 1) {
    for (let i = 0; i < n; i += 1) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c += 1) {
        const d = cosineDist(vectors[i], centroids[c]);
        if (d < bestD) { bestD = d; best = c; }
      }
      labels[i] = best;
    }
    const sums = Array.from({ length: k }, () => new Array(dim).fill(0));
    const counts = new Array(k).fill(0);
    for (let i = 0; i < n; i += 1) {
      const c = labels[i];
      counts[c] += 1;
      for (let j = 0; j < dim; j += 1) sums[c][j] += vectors[i][j];
    }
    for (let c = 0; c < k; c += 1) {
      if (counts[c] > 0) centroids[c] = sums[c].map((x) => x / counts[c]);
    }
  }
  return labels;
}

async function clusterEmbeddings(embeddings, k) {
  if (!Array.isArray(embeddings) || embeddings.length === 0) return [];
  return kmeans(embeddings, k);
}

async function callLLM(prompt, { timeoutMs } = {}) {
  return chatComplete(prompt);
}

async function buildLevel1Summaries(storedChunks, businessId) {
  const embedded = storedChunks.filter((chunk) => Array.isArray(chunk.embedding));
  if (embedded.length === 0) {
    return [];
  }

  const k = Math.max(3, Math.floor(Math.sqrt(storedChunks.length)));

  let labels;
  try {
    labels = await clusterEmbeddings(
      embedded.map((chunk) => chunk.embedding),
      k
    );
  } catch (error) {
    console.warn('[ingest] Clustering failed:', error.message);
    return [];
  }

  const groups = new Map();
  for (let i = 0; i < embedded.length; i += 1) {
    const label = Number.isInteger(labels[i]) ? labels[i] : 0;
    if (!groups.has(label)) {
      groups.set(label, []);
    }
    groups.get(label).push(embedded[i]);
  }

  const clusters = Array.from(groups.entries()).map(([clusterId, chunks]) => ({
    clusterId,
    chunks,
  }));

  function clusterPrompt(cluster) {
    return [
      'You are building a retrieval index for a business chatbot.',
      'Write a dense summary paragraph (150-250 words) capturing every distinct',
      'fact, service, feature, claim, price, timeline, and credential.',
      "Use the business's own terminology. Factual, not marketing copy.",
      `CHUNKS: ${cluster.chunks.map((chunk) => chunk.content).join('\n---\n')}`,
      'SUMMARY:',
    ].join('\n');
  }

  function fallbackClusterSummary(cluster) {
    return cluster.chunks.map((chunk) => chunk.content).join('\n---\n').slice(0, 6000);
  }

  async function summarizeCluster(cluster) {
    try {
      const content = await callLLM(clusterPrompt(cluster), { timeoutMs: 8000 });
      return {
        clusterId: cluster.clusterId,
        chunks: cluster.chunks,
        content: content || fallbackClusterSummary(cluster),
      };
    } catch (error) {
      if (error && error.code === 'TIMEOUT') {
        return {
          clusterId: cluster.clusterId,
          chunks: cluster.chunks,
          content: fallbackClusterSummary(cluster),
        };
      }

      throw error;
    }
  }

  let summaryResults = await Promise.allSettled(
    clusters.map((cluster) => summarizeCluster(cluster))
  );

  const retryIndexes = [];
  summaryResults.forEach((result, index) => {
    if (result.status === 'rejected' && result.reason && result.reason.status === 429) {
      retryIndexes.push(index);
    }
  });

  if (retryIndexes.length > 0) {
    await sleep(10000);
    const retryClusters = retryIndexes.map((index) => clusters[index]);
    const retryResults = await Promise.allSettled(
      retryClusters.map((cluster) => summarizeCluster(cluster))
    );

    retryIndexes.forEach((originalIndex, retryIndex) => {
      summaryResults[originalIndex] = retryResults[retryIndex];
    });
  }

  const level1Rows = [];

  for (let summaryIndex = 0; summaryIndex < summaryResults.length; summaryIndex += 1) {
    const summaryResult = summaryResults[summaryIndex];
    if (summaryResult.status !== 'fulfilled') {
      const failedClusterId = clusters[summaryIndex]?.clusterId;
      console.warn(`[ingest] Level 1 summary failed for cluster ${failedClusterId}: ${summaryResult.reason?.message || summaryResult.reason}`);
      continue;
    }

    const { clusterId, chunks, content } = summaryResult.value;

    let embedding = null;
    try {
      const embeddings = await embedTexts([content]);
      embedding = embeddings[0] || null;
    } catch (error) {
      console.warn(`[ingest] Level 1 embedding failed for cluster ${clusterId}: ${error.message}`);
    }

    level1Rows.push({
      business_id: businessId,
      level: 1,
      cluster_id: clusterId,
      content,
      embedding,
      source_chunk_ids: chunks.map((chunk) => chunk.id).filter(Boolean),
    });
  }

  if (level1Rows.length > 0) {
    await deleteSummaries(businessId, 1);
    await insertSummaries(level1Rows);
  }

  return level1Rows;
}

async function buildLevel2Summary(level1Rows, businessId) {
  const level1Summaries = level1Rows.map((row) => row.content).join('\n---\n');

  const prompt = [
    'Write a comprehensive 250-350 word business profile in prose (no bullets):',
    '1. Core offering  2. Target customer  3. Differentiators  4. Pricing model',
    '5. Getting started  6. Trust signals.',
    "Must fully answer: 'what do you guys do?'",
    `SECTION SUMMARIES: ${level1Summaries}`,
  ].join('\n');

  const content = await callLLM(prompt);

  let embedding = null;
  try {
    const embeddings = await embedTexts([content]);
    embedding = embeddings[0] || null;
  } catch (error) {
    console.warn('[ingest] Level 2 embedding failed:', error.message);
  }

  await deleteSummaries(businessId, 2);
  await insertSummaries([
    {
      business_id: businessId,
      level: 2,
      content,
      embedding,
    },
  ]);

  return content;
}

async function extractAndSaveBusinessProfile(level2Summary, businessId) {
  const prompt = [
    'Using the business profile below, return ONLY valid JSON with no markdown:',
    '{',
    '  "primary_offering": "",',
    '  "industry": "",',
    '  "pricing_model": "",',
    '  "brand_tone": "",',
    '  "key_cta": "",',
    '  "target_customer": ""',
    '}',
    `PROFILE: ${level2Summary}`,
  ].join('\n');

  const raw = await callLLM(prompt);
  const jsonText = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  const parsed = JSON.parse(jsonText);

  await updateBusiness(businessId, {
    primary_offering: parsed.primary_offering || null,
    industry: parsed.industry || null,
    pricing_model: parsed.pricing_model || null,
    brand_tone: parsed.brand_tone || null,
    key_cta: parsed.key_cta || null,
    target_customer: parsed.target_customer || null,
    last_ingested_at: new Date().toISOString(),
  });
}

async function runIngest(businessId, url) {
  try {
    await updateClientStatus(businessId, 'ingesting');

    const pages = await scrapeSite(url, 50);
    await updateIngestProgress(businessId, 10);

    if (pages.length === 0) {
      throw new Error('No usable pages found during scrape');
    }

    const level0Chunks = buildSemanticChunks(
      pages.map((p) => ({ url: p.url, content: p.content, heading: p.heading || null })),
      businessId
    );
    await updateIngestProgress(businessId, 25);

    await attachChunkEmbeddings(level0Chunks);
    await updateIngestProgress(businessId, 40);

    const storedChunks = await storeLevel0Chunks(level0Chunks, businessId, 'url:' + url);
    await updateIngestProgress(businessId, 55);

    const allChunks = await getAllChunks(businessId);
    const level1Rows = await buildLevel1Summaries(allChunks, businessId);
    await updateIngestProgress(businessId, 70);

    const level2Summary = await buildLevel2Summary(level1Rows, businessId);

    await extractAndSaveBusinessProfile(level2Summary, businessId);

    await updateClientStatus(businessId, 'active');
    await updateIngestProgress(businessId, 100);
  } catch (error) {
    await updateClientStatus(businessId, 'error');
    throw error;
  }
}

module.exports = { runIngest, ingestNormalized, storeLevel0Chunks };
