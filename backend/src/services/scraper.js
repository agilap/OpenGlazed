const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');

const MAX_PAGES = 15;
const TIMEOUT = 12000;
const UA = 'Mozilla/5.0 (compatible; glazed-bot/0.1)';

/* ── strip boilerplate noise from extracted text ──────────────── */
function cleanText(raw) {
  return raw
    .replace(/\s+/g, ' ')          // collapse whitespace
    .replace(/(\b\w+\b)( \1){3,}/gi, '$1')  // dedupe repeated words (nav items)
    .replace(/(top of page|back to top|skip to content|cookie policy|accept cookies)/gi, '')
    .trim();
}

/* ── extract readable text from one HTML page ─────────────────── */
function extractPage($, pageUrl) {
  $('script, style, noscript, svg, nav, footer, header, [role="navigation"], [role="banner"]').remove();

  const title = ($('title').text() || '').trim();
  const headings = $('h1, h2, h3')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter(Boolean)
    .join('\n');

  // prefer main/article content; fall back to full body
  let bodyText = '';
  const main = $('main, article, [role="main"]');
  if (main.length) {
    bodyText = main.text();
  } else {
    bodyText = $('body').text();
  }
  bodyText = cleanText(bodyText);

  const merged = [title, headings, bodyText].filter(Boolean).join('\n\n');
  return merged;
}

/* ── extract heading → content sections from one HTML page ──── */
function extractSections($, pageUrl) {
  $('script, style, noscript, svg, nav, footer, header, [role="navigation"], [role="banner"]').remove();

  const main = $('main, article, [role="main"]');
  const root = main.length ? main : $('body');
  const html = root.html() || '';
  const title = ($('title').text() || '').trim();

  // Split the HTML at every <h1>, <h2>, <h3> tag.
  // The regex capture group keeps the heading element in the result array.
  const parts = html.split(/(<h[1-3]\b[^>]*>[\s\S]*?<\/h[1-3]>)/gi);

  const sections = [];
  let currentHeading = title || '';

  for (const part of parts) {
    const hMatch = part.match(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i);
    if (hMatch) {
      // This part is a heading element — update the current label
      currentHeading = cheerio.load(hMatch[1]).text().trim() || currentHeading;
    } else {
      // This part is content between headings.
      // Insert space after closing block-level tags to prevent word mashup
      // (e.g. "<span>Presence</span><span>across</span>" → "Presence across")
      const spacedHtml = part.replace(/<\/(div|p|li|td|span|section|article|aside|blockquote|figure|figcaption)>/gi, '</$1> ');
      const text = cleanText(cheerio.load(`<div>${spacedHtml}</div>`).text());
      if (text.length > 50) {
        // Clean heading: strip site name suffixes like " | CloudEats 2022"
        const cleanHeading = currentHeading.replace(/\s*\|.*$/, '').trim();
        sections.push({
          heading: cleanHeading || currentHeading,
          content: text,
          url: pageUrl,
        });
      }
    }
  }

  return sections;
}

/* ── discover same-origin internal links on a page ────────────── */
function discoverLinks($, baseUrl) {
  const base = new URL(baseUrl);
  const links = new Set();

  $('a[href]').each((_, el) => {
    try {
      const href = $(el).attr('href');
      if (!href) return;
      const resolved = new URL(href, baseUrl);
      // same origin only, no anchors/mailto/tel, no file downloads
      if (resolved.origin !== base.origin) return;
      if (/\.(pdf|zip|png|jpg|jpeg|gif|svg|mp4|mp3|doc|xls)$/i.test(resolved.pathname)) return;
      resolved.hash = '';
      links.add(resolved.href);
    } catch { /* skip invalid URLs */ }
  });

  return [...links];
}

/* ── fetch one URL safely ─────────────────────────────────────── */
async function fetchPage(url) {
  const response = await axios.get(url, {
    timeout: TIMEOUT,
    headers: { 'User-Agent': UA },
    maxRedirects: 3
  });
  return cheerio.load(response.data);
}

/* ── crawl a site (BFS, up to MAX_PAGES) ──────────────────────── */
async function scrapeWebsite(url) {
  const visited = new Set();
  const queue = [url];
  const pages = [];

  while (queue.length > 0 && visited.size < MAX_PAGES) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);

    try {
      const $ = await fetchPage(current);
      const rawHtml = $.html();           // save before extractPage mutates DOM
      const text = extractPage($, current);
      const $fresh = cheerio.load(rawHtml);
      const sections = extractSections($fresh, current);
      if (text && text.length > 80) {
        pages.push({ url: current, text, sections });
      }
      // discover more pages from this one
      const found = discoverLinks($, current);
      for (const link of found) {
        if (!visited.has(link) && !queue.includes(link)) {
          queue.push(link);
        }
      }
    } catch (err) {
      // skip pages that fail (404, timeout, etc.)
      console.warn(`Skipped ${current}: ${err.message}`);
    }
  }

  if (!pages.length) {
    throw new Error('No readable content found on the provided URL.');
  }

  const merged = pages.map((p) => p.text).join('\n\n---\n\n');
  console.log(`Crawled ${pages.length} page(s) from ${url}`);

  // Build structured sections from every crawled page
  const allSections = [];
  for (const pg of pages) {
    allSections.push(...pg.sections);
  }

  return {
    url,
    text: merged,
    sections: allSections,
    pagesCrawled: pages.length,
  };
}

module.exports = {
  scrapeWebsite
};
