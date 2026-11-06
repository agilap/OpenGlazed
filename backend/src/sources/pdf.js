'use strict';

const { PDFParse } = require('pdf-parse');

async function parse({ data, filename }) {
  const label = filename || 'document.pdf';
  const parser = new PDFParse({ data });
  try {
    const { pages } = await parser.getText();
    const sections = pages
      .map((page) => ({ heading: `${label}, page ${page.num}`, content: (page.text || '').trim(), url: `${label} p.${page.num}` }))
      .filter((section) => section.content);
    if (!sections.length) throw new Error('No text layer found. Scanned PDFs need OCR before upload.');
    return sections;
  } finally {
    await parser.destroy();
  }
}

module.exports = { parse };
