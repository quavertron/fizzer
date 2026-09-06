// Real chat rendering and interaction in headless Chromium; no desktop session.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { pickPort } from './lib/test-ports.mjs';

const fixture = `<!doctype html><html><body><div id="root"></div>
<script type="module">
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatGroupRow } from '/src/components/ChatGroupRow.tsx';
import { ChatWorkTrace } from '/src/components/ChatWorkTrace.tsx';
import '/src/index.css';
const noop = () => {};
const identity = { id: 'mission-one', title: 'Simplify chat markers', role: 'Worker', taskTitle: 'Ship quieter chat' };
const rows = [
  { id: 'answer', body: 'Delivered the visual simplification. Useful message content stays readable.' },
  { id: 'canceled', status: 'canceled', body: 'Partial progress before interruption.', hasHarness: true, harnessLog: 'Retained diagnostic history' },
  { id: 'failed', status: 'failed', body: 'Deployment failed: credentials expired.', hasHarness: true, harnessLog: 'Authentication failed' },
].map(row => ({ author: 'Astra', agentId: 'codex', channelId: 'fixture', createdAt: '2026-09-06T12:00:00Z', ...row }));
function App() {
  const [selected, select] = useState(null);
  return React.createElement('div', { className: 'chat-messages' },
    rows.map(row => React.createElement(ChatGroupRow, {
      key: row.id, group: { messages: [row] }, avatarKind: 'agent',
      selectedMessageId: selected, jumpHighlightMessageId: null,
      missionIdentities: new Map(rows.map(row => [row.id, identity])),
      latestRunningMessageId: '', runningSiblingCount: 0,
      mentionableAliases: [], notes: [], loadedMessageIds: new Set(), scrollRootRef: { current: null },
      onToggleSelect: id => select(selected === id ? null : id),
      onCancelRun: noop, onContextMenu: event => { event.preventDefault(); window.contextOpened = true; },
      onReply: noop, onJumpToMessage: noop, onLightbox: noop, onImageLoad: noop,
    })),
    React.createElement(ChatWorkTrace, { trace: [rows[1]], missionIdentity: identity,
      selectedMessageId: null, onCancelRun: noop, onContextMenu: noop, onReply: noop,
      runningMessageState: new Map() }));
}
createRoot(document.getElementById('root')).render(React.createElement(App));
</script><style>html,body{margin:0}#root{width:100%;max-width:900px}.chat-messages{padding:16px}</style></body></html>`;
const server = await createServer({ root: new URL('../client', import.meta.url).pathname,
  server: { host: '127.0.0.1', port: await pickPort() },
  plugins: [{ name: 'marker-fixture', configureServer(server) {
    server.middlewares.use('/markers.html', async (_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(await server.transformIndexHtml('/markers.html', fixture));
    });
  } }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  for (const width of [1100, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(server.resolvedUrls.local[0] + 'markers.html');
    const answer = page.locator('[data-message-id="answer"]');
    await answer.waitFor();
    assert.match(await answer.innerText(), /Useful message content stays readable/);
    assert.match(await answer.getAttribute('aria-label'), /Simplify chat markers · Worker · Ship quieter chat/);
    assert.equal(await page.locator('.chat-mission-identity, .chat-steering-prompt, .chat-message-status.is-steered').count(), 0);
    assert.equal(await answer.evaluate(el => getComputedStyle(el).borderLeftWidth), '2px');
    const canceled = page.locator('.chat-message-chunk[data-message-id="canceled"]');
    assert.equal(await canceled.locator('.cascade-run-panel').count(), 0);
    assert.match(await canceled.innerText(), /Partial progress/);
    assert.equal(await page.locator('.chat-message-group.status-canceled .is-error').count(), 0);
    assert.equal(await page.locator('[data-message-id="failed"] .cascade-run-panel.is-failed').count(), 1);
    await canceled.click();
    assert.equal(await canceled.locator('.cascade-run-panel.open').count(), 1);
    await answer.click({ button: 'right' });
    assert.equal(await page.evaluate(() => window.contextOpened), true);
    await page.locator('.chat-work-trace-toggle').click();
    assert.equal(await page.locator('.chat-work-line .err').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: '/tmp/fizzer-chat-markers-' + width + '.png', fullPage: true });
    assert.deepEqual(errors, []);
    await page.close();
    console.log('Chat markers: rendering, history, context menu and width ' + width + ' passed');
  }
} finally {
  await browser?.close();
  await server.close();
}
