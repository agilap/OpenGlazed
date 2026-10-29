'use strict';

function parse({ text, filename }) {
  const content = (text || '').trim();
  if (!content) return [];
  const label = filename || 'Pasted note ' + new Date().toISOString().slice(0, 10);
  return [{ heading: label, content, url: 'paste:' + label }];
}

module.exports = { parse };
