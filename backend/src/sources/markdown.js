'use strict';

function parse({ text, filename }) {
  const label = filename || 'document';
  if (!text || !text.trim()) return [];

  const lines = text.replace(/\r/g, '').split('\n');
  const sections = [];
  let currentHeading = '';
  let buffer = [];

  const flush = () => {
    const content = buffer.join('\n').trim();
    if (content.length > 0) {
      sections.push({ heading: currentHeading || label, content, url: 'md:' + label });
    }
    buffer = [];
  };

  for (const line of lines) {
    const m = line.match(/^(#{1,3})\s+(.*)$/);
    if (m) {
      flush();
      currentHeading = m[2].trim();
    } else {
      buffer.push(line);
    }
  }
  flush();

  if (sections.length === 0) {
    sections.push({ heading: label, content: text.trim(), url: 'md:' + label });
  }
  return sections;
}

module.exports = { parse };
