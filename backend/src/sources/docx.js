'use strict';

const mammoth = require('mammoth');

async function parse({ data, filename }) {
  const label = filename || 'document.docx';
  const { value } = await mammoth.extractRawText({ buffer: data });
  const content = (value || '').trim();
  if (!content) throw new Error('No text found in this Word document.');
  return [{ heading: label, content, url: label }];
}

module.exports = { parse };
