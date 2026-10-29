'use strict';

function parse({ text, filename }) {
  if (!text || !text.trim()) return [];
  const rows = text.split('\n').filter((r) => r.trim().length > 0);
  if (rows.length < 2) return [];

  const header = rows[0].split(',').map((h) => h.trim());
  const sections = [];

  for (let i = 1; i < rows.length; i += 1) {
    const cells = rows[i].split(',');
    const content = header
      .map((h, idx) => `${h}: ${cells[idx] || ''}`.trim())
      .join('\n');
    sections.push({ heading: `${filename || 'row'} #${i}`, content, url: 'csv:' + (filename || 'data') });
  }
  return sections;
}

module.exports = { parse };
