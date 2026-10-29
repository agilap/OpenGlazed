const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');

const MAX_PAGES = 15;
const TIMEOUT = 12000;
const UA = 'Mozilla/5.0 (compatible; glazed-bot/0.1)';

function cleanText(raw) {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/(\b\w+\b)( \1){3,}/gi, '$1')
    .replace(/(top of page|back to top|skip to content|cookie policy|accept cookies)/gi, '')
    .trim();
}

function extractPage($, pageUrl) {
  $('script, style, noscript, svg, nav, footer, header, [role="navigation"], [role="banner"]').remove();

  const title = ($('title').text() || '').trim();
  const headings = $('h1, h2, h3')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter(Boolean)
    .join('\n');

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

function extractSections($, pageUrl) {
  $('script, style, noscript, svg, nav, footer, header, [role="navigation"], [role="banner"]').remove();

  const main = $('main, article, [role="main"]');
  const root = main.length ? main : $('body');
  const html = root.html() || '';
  const title = ($('title').text() || '').trim();

  const parts = html.split(/(<h[1-3]\b[^>]*>[\s\S]*?<\/h[1-3]>)/gi);

  const sections = [];
  let currentHeading = title || '';

  for (const part of parts) {
    const hMatch = part.match(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i);
    if (hMatch) {
      currentHeading = cheerio.load(hMatch[1]).text().trim() || currentHeading;
    } else {
      const spacedHtml = part.replace(/<\/(div|p|li|td|span|section|article|aside|blockquote|figure|figcaption)>/gi, '</$1> ');
      const text = cleanText(cheerio.load(`<div>${spacedHtml}</div>`).text());
      if (text.length > 50) {
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

function discoverLinks($, baseUrl) {
  const base = new URL(baseUrl);
  const links = new Set();

  $('a[href]').each((_, el) => {
    try {
      const href = $(el).attr('href');
      if (!href) return;
      const resolved = new URL(href, baseUrl);
      if (resolved.origin !== base.origin) return;
      if (/\.(pdf|zip|png|jpg|jpeg|gif|svg|mp4|mp3|doc|xls)$/i.test(resolved.pathname)) return;
      resolved.hash = '';
      links.add(resolved.href);
    } catch {}
  });

  return [...links];
}

async function fetchPage(url) {
  const response = await axios.get(url, {
    timeout: TIMEOUT,
    headers: { 'User-Agent': UA },
    maxRedirects: 3
  });
  return cheerio.load(response.data);
}

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
      const rawHtml = $.html();
      const text = extractPage($, current);
      const $fresh = cheerio.load(rawHtml);
      const sections = extractSections($fresh, current);
      if (text && text.length > 80) {
        pages.push({ url: current, text, sections });
      }
      const found = discoverLinks($, current);
      for (const link of found) {
        if (!visited.has(link) && !queue.includes(link)) {
          queue.push(link);
        }
      }
    } catch (err) {
      console.warn(`Skipped ${current}: ${err.message}`);
    }
  }

  if (!pages.length) {
    throw new Error('No readable content found on the provided URL.');
  }

  const merged = pages.map((p) => p.text).join('\n\n---\n\n');
  console.log(`Crawled ${pages.length} page(s) from ${url}`);

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
