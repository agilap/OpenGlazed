'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const frontend = path.resolve(__dirname, '../../frontend/src');

const stream = (parts) => new Response(new ReadableStream({ start(controller) {
  for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
  controller.close();
} }));

test('stream handles CRLF, split frames and an unterminated done frame', async () => {
  const { readChatStream } = await import(pathToFileURL(path.join(frontend, 'chatStream.js')));
  const events = [];
  await readChatStream(stream(['data: {"token":"hi"}\r', '\n\r\ndata: {"done":true}']), (event) => events.push(event));
  assert.deepEqual(events, [{ token: 'hi' }, { done: true }]);
});

test('stream rejects provider errors, malformed frames and early EOF', async () => {
  const { readChatStream } = await import(pathToFileURL(path.join(frontend, 'chatStream.js')));
  for (const data of ['data: {"error":"private detail"}\n\n', 'data: nope\n\n', 'data: {"token":"partial"}\n\n']) {
    await assert.rejects(readChatStream(stream([data]), () => {}), /retry/i);
  }
});

test('citation URLs and theme input reject executable or CSS payloads', async () => {
  const { safeCitationUrl, widgetConfig, colorText } = await import(pathToFileURL(path.join(frontend, 'widgetConfig.js')));
  for (const value of ['javascript:alert(1)', 'data:text/html,hello', '//attacker.test', 'file:///tmp/a']) assert.equal(safeCitationUrl(value), null);
  assert.equal(safeCitationUrl('https://example.test/a'), 'https://example.test/a');
  assert.equal(widgetConfig('?color=red;display:none').color, '#121218');
  assert.equal(widgetConfig('?color=%23abcdef&theme=dark').dark, true);
  assert.equal(colorText('#ffffff'), '#121218');
  assert.equal(colorText('#000000'), '#ffffff');
});

for (const [primaryColor, foreground] of [['#ffffff', '#121218'], ['#000000', '#ffffff']]) {
test(`legacy async script keeps readable ${primaryColor} theme, reduced motion and scoped close messages`, () => {
  const handlers = {};
  const elements = [];
  const node = () => ({ style: {}, attrs: {}, children: [], events: {}, setAttribute(key, value) { this.attrs[key] = value; }, appendChild(child) { this.children.push(child); }, addEventListener(key, fn) { this.events[key] = fn; }, focus() { this.focused = true; } });
  const document = {
    currentScript: { src: 'https://bot.test/widget.js', dataset: { businessId: '42', primaryColor, greeting: '<script>test</script>' } },
    readyState: 'loading', body: node(), createElement() { const el = node(); elements.push(el); return el; },
    addEventListener(key, fn) { handlers[key] = fn; },
  };
  const window = { location: { href: 'https://customer.test/' }, innerWidth: 375, matchMedia: () => ({ matches: true }), addEventListener(key, fn) { handlers[key] = fn; } };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../public/widget.js'), 'utf8'), { document, window, URL });
  document.currentScript = null;
  handlers.DOMContentLoaded();
  const [root, button, iframe, close] = elements;
  assert.equal(button.style.color, foreground);
  assert.equal(new URL(iframe.src).searchParams.get('color'), primaryColor);
  assert.equal(new URL(iframe.src).origin, 'https://bot.test');
  assert.equal(new URL(iframe.src).searchParams.get('greeting'), '<script>test</script>');
  button.events.click();
  assert.equal(button.attrs['aria-expanded'], 'true');
  assert.equal(close.style.display, 'block');
  assert.equal(iframe.style.transition, 'none');
  handlers.message({ source: {}, origin: 'https://attacker.test', data: { type: 'GLAZED_CLOSE' } });
  assert.equal(button.attrs['aria-expanded'], 'true');
  handlers.message({ source: iframe.contentWindow, origin: 'https://bot.test', data: { type: 'GLAZED_CLOSE' } });
  assert.equal(button.attrs['aria-expanded'], 'false');
  assert.equal(button.focused, true);
  assert.equal(root.children.length, 3);
});
}
