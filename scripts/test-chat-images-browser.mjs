#!/usr/bin/env node
// Real ChatGroupRow, normal URL images and external-agent persisted metadata.
// Optional private evidence is read locally, never embedded in the repository.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { pickPort } from './lib/test-ports.mjs';
const evidence = process.env.CHAT_IMAGE_EVIDENCE;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
const url = '/api/notes/channel/assets/test-image';
const input = evidence ? JSON.parse(fs.readFileSync(evidence, 'utf8')) : {
  messages: [{ id: 'external-image', channelId: 'channel', author: 'Along', body: 'Image fixture',
    createdAt: '2026-01-01T00:00:00Z', images: [{ data: '', media_type: 'image/png', name: 'test.png', url }] }],
  assets: [{ url }],
};
const fixture = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react'; import ReactDOM from 'react-dom/client'; import { flushSync } from 'react-dom';
import { ChatGroupRow } from '/src/components/ChatGroupRow.tsx';
import '/src/index.css';
const root = ReactDOM.createRoot(document.getElementById('root')); const noop = () => {};
window.show = message => flushSync(() => root.render(React.createElement(ChatGroupRow, {
 group: { key: message.id, messages: [message] }, selectedMessageId: message.id, jumpHighlightMessageId: null,
 avatarKind: 'agent', runningSiblingCount: 0, mentionableAliases: [], notes: [],
 onCancelRun: noop, onToggleSelect: noop, onContextMenu: noop, onReply: noop, onJumpToMessage: noop,
 loadedMessageIds: new Set([message.id]), onLightbox: src => { window.lightbox = src; }, onImageLoad: noop,
 scrollRootRef: { current: null },
})));
</script><style>body{margin:20px}#root{max-width:1000px}.chat-msg-images{display:flex;flex-wrap:wrap}</style></body></html>`;
const server = await createServer({ root: new URL('../client', import.meta.url).pathname,
 server: { host: '127.0.0.1', port: await pickPort() },
 plugins: [{ name: 'image-fixture', configureServer(server) {
  server.middlewares.use(async (req, res, next) => {
   if (req.url === '/image-test.html') { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(req.url, fixture)); return; }
   const asset = input.assets.find(a => a.url === req.url);
   if (asset) { for (const [k,v] of Object.entries(asset.headers || { 'content-type': 'image/png' })) if (v) res.setHeader(k,v);
    res.end(asset.path ? fs.readFileSync(asset.path) : png); return; }
   next();
  });
 } }],
});
let browser;
try {
 await server.listen(); browser = await chromium.launch({ headless: true });
 const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
 const errors = []; page.on('pageerror', e => errors.push(e.message));
 await page.goto(server.resolvedUrls.local[0] + 'image-test.html');
 await page.waitForFunction(() => typeof window.show === 'function');
 const receipts = [];
 // Verify both wire shapes against the same asset bytes and renderer.
 for (const shape of ['metadata', 'human-url']) for (const message of input.messages) {
  const row = shape === 'metadata' ? message : { ...message, images: message.images.map(i => typeof i === 'string' ? i : i.url) };
  await page.evaluate(m => window.show(m), row);
  const images = page.locator('.chat-msg-image'); await images.first().waitFor();
  const decoded = await images.evaluateAll(async nodes => Promise.all(nodes.map(async img => {
   let error = null; try { await img.decode(); } catch (e) { error = e.name; }
   return { src: img.getAttribute('src'), width: img.naturalWidth, height: img.naturalHeight,
    renderedWidth: img.getBoundingClientRect().width, renderedHeight: img.getBoundingClientRect().height, error };
  })));
  const receipt = { id: message.id, shape, decoded }; receipts.push(receipt);
  if (process.env.CHAT_IMAGE_OUTPUT) {
   fs.mkdirSync(process.env.CHAT_IMAGE_OUTPUT, { recursive: true, mode: 0o700 });
   await page.screenshot({ path: `${process.env.CHAT_IMAGE_OUTPUT}/${shape}-${message.id}.png`, fullPage: true });
   fs.writeFileSync(`${process.env.CHAT_IMAGE_OUTPUT}/render.json`, JSON.stringify(receipts, null, 2), { mode: 0o600 });
  }
  console.log(JSON.stringify(receipt));
  assert.equal(decoded.length, row.images.length);
  for (const [i, image] of decoded.entries()) {
   const expected = typeof message.images[i] === 'string' ? message.images[i] : message.images[i].url;
   assert.equal(image.src, expected);
   assert.equal(image.error, null); assert.ok(image.width > 0 && image.height > 0 && image.renderedWidth > 0 && image.renderedHeight > 0);
  }
  await images.first().click();
  assert.equal(await page.evaluate(() => window.lightbox), decoded[0].src);
 }
 assert.deepEqual(errors, []);
 console.log('PASS: persisted metadata and human URL images decode, render, and open exact lightbox URLs');
} finally { await browser?.close(); await server.close(); }
