#!/usr/bin/env node
// Exercise the real ChatView and native Chromium wheel scrolling, without a desktop session.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { pickPort } from './lib/test-ports.mjs';

const fixture = `<!doctype html><html><body><div id="root"></div>
<script type="module">
import React from 'react';
import ReactDOM from 'react-dom/client';
import { ChatView } from '/src/components/ChatView.tsx';
import { chatMessageStore } from '/src/chat/messageStore.ts';
import '/src/index.css';
const noop = () => {};
let count = 0;
const row = () => ({ id: 'row-' + ++count, channelId: 'scroll-test', author: 'reader',
  body: 'Transcript message ' + count, createdAt: new Date(1700000000000 + count * 60000).toISOString() });
chatMessageStore.set('scroll-test', Array.from({length: 60}, row));
chatMessageStore.set('other-channel', Array.from({length: 60}, row));
window.appendRow = () => chatMessageStore.update('scroll-test', rows => [...rows, row()]);
const root = ReactDOM.createRoot(document.getElementById('root'));
window.switchChannel = (channelId = 'scroll-test') => root.render(React.createElement(ChatView, {
  channelId, channelName: 'Scroll test', currentUser: 'reader',
  presence: { participants: [], online: [] }, availableAgents: [], registeredAgents: [], sidebarMode: 'hidden',
  onRegisterAgent: noop, onRemoveAgent: noop, onInviteUser: async () => {}, onSendMessage: noop, onCancelRun: noop,
}));
window.switchChannel();
</script><style>html,body,#root{height:100%;margin:0}#root{display:flex}</style></body></html>`;
const server = await createServer({ root: new URL('../client', import.meta.url).pathname,
  server: { host: '127.0.0.1', port: await pickPort() },
  plugins: [{ name: 'scroll-fixture', configureServer(server) {
    server.middlewares.use('/scroll-test.html', async (_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(await server.transformIndexHtml('/scroll-test.html', fixture));
    });
  } }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  page.on('pageerror', error => { console.error(error); });
  await page.goto(server.resolvedUrls.local[0] + 'scroll-test.html');
  const pane = page.locator('.chat-messages');
  await pane.waitFor();
  await page.waitForTimeout(500);
  const bottomDistance = () => pane.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop);
  assert.ok(await bottomDistance() <= 1, 'mount follows recent messages');
  await page.evaluate(() => window.appendRow());
  await page.waitForTimeout(250);
  assert.ok(await bottomDistance() <= 1, 'new rows follow while pinned');
  await pane.hover();
  await page.mouse.wheel(0, -20);
  await page.waitForTimeout(100);
  assert.ok(await bottomDistance() >= 15, 'small upward wheel scroll moves into history');
  const historyTop = await pane.evaluate(el => el.scrollTop);
  await page.evaluate(() => window.appendRow());
  await page.waitForTimeout(300);
  assert.ok(Math.abs(await pane.evaluate(el => el.scrollTop) - historyTop) <= 2,
    'new rows must not undo a small upward wheel scroll inside the 48px bottom tolerance');
  await page.mouse.wheel(0, 10000);
  await page.waitForTimeout(250);
  await page.evaluate(() => window.appendRow());
  await page.waitForTimeout(250);
  assert.ok(await bottomDistance() <= 1, 'returning to bottom resumes follow');
  // Exercise the existing touch intent handlers without accessing a desktop.
  await pane.evaluate(el => {
    el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true,
      touches: [new Touch({ identifier: 1, target: el, clientY: 100 })] }));
    el.dispatchEvent(new TouchEvent('touchmove', { bubbles: true,
      touches: [new Touch({ identifier: 1, target: el, clientY: 120 })] }));
    el.scrollTop -= 20;
    el.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [] }));
  });
  await page.waitForTimeout(100);
  const touchTop = await pane.evaluate(el => el.scrollTop);
  await page.evaluate(() => window.appendRow());
  await page.waitForTimeout(300);
  assert.ok(Math.abs(await pane.evaluate(el => el.scrollTop) - touchTop) <= 2,
    'touch history reading survives incoming rows');
  await page.evaluate(() => window.switchChannel('other-channel'));
  await page.waitForTimeout(300);
  assert.ok(await bottomDistance() <= 1, 'channel switching resets history detachment');
  console.log('Chat scrolling browser regression passed');
} finally {
  await browser?.close();
  await server.close();
}
