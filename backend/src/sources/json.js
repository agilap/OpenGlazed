'use strict';

function parse({ text, filename }) {
  const label = filename || 'data.json';
  let value;
  try {
    value = JSON.parse(text || '');
  } catch (_error) {
    throw new Error('This JSON file is not valid JSON.');
  }
  const items = Array.isArray(value) ? value : [value];
  return items
    .map((item, i) => ({
      heading: items.length > 1 ? `${label} #${i + 1}` : label,
      content: typeof item === 'string' ? item : JSON.stringify(item, null, 2),
      url: label,
    }))
    .filter((section) => section.content.trim());
}

module.exports = { parse };
