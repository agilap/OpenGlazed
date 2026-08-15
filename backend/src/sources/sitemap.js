'use strict';

const axios = require('axios');

// Return <loc> URLs from a sitemap.xml (dispatcher ingests each as 'url').
async function parse(url) {
  if (!url) throw new Error('sitemap requires a url');
  const { data } = await axios.get(url, { timeout: 15000 });
  return [...data.matchAll(/<loc>([\s\S]*?)<\/loc>/g)].map((m) => m[1].trim());
}

module.exports = { parse };
