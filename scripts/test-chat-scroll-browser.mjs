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
import { chatMessageStore, fetchChatMessageSnapshot } from '/src/chat/messageStore.ts';
import { captureChatMessageSnapshotBaseline, reconcileChatMessageSnapshot } from '/src/chat/runBlocks.ts';
import '/src/index.css';
const noop = () => {};
let count = 0;
const row = () => ({ id: 'row-' + ++count, channelId: 'scroll-test', author: 'reader',
  body: 'Transcript message ' + count, createdAt: new Date(1700000000000 + count * 60000).toISOString() });
chatMessageStore.set('scroll-test', Array.from({length: 60}, row));
chatMessageStore.set('other-channel', Array.from({length: 60}, row));
window.setAgentStatus = status => chatMessageStore.update('scroll-test', rows => [
  ...rows.filter(row => row.id !== 'agent-activity'),
  { id: 'agent-activity', channelId: 'scroll-test', author: 'Sol', agentId: 'codex',
    createdAt: new Date(1800000000000).toISOString(), status,
    body: status ? 'Internal process commentary' : 'The substantive final answer.' },
]);
window.streamOutput = text => chatMessageStore.update('scroll-test', rows => rows.map(row =>
  row.id === 'agent-activity' ? { ...row, blocks: [{ type: 'thinking', text: 'Private reasoning' }, { type: 'text', text }] } : row));
window.appendRow = () => chatMessageStore.update('scroll-test', rows => [...rows, row()]);
const root = ReactDOM.createRoot(document.getElementById('root'));
window.switchChannel = (channelId = 'scroll-test') => root.render(React.createElement(ChatView, {
  channelId, channelName: 'Scroll test', currentUser: 'reader', vaultId: channelId === 'history-test' ? 'vault' : undefined,
  presence: { participants: [], online: [] }, availableAgents: [], registeredAgents: [], sidebarMode: 'hidden',
  onRegisterAgent: noop, onRemoveAgent: noop, onInviteUser: async () => {}, onSendMessage: noop, onCancelRun: noop,
}));
window.historyRows = () => chatMessageStore.getChannel('history-test');
window.refreshHistory = async () => {
  const baseline = captureChatMessageSnapshotBaseline(window.historyRows());
  const remote = await fetchChatMessageSnapshot('vault', 'history-test', baseline);
  chatMessageStore.update('history-test', rows => reconcileChatMessageSnapshot(rows, remote, baseline));
};
window.seedHistory = rows => chatMessageStore.set('history-test', rows);
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
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0] + 'scroll-test.html');
  const pane = page.locator('.chat-messages');
  await pane.waitFor();
  await page.waitForTimeout(500);
  const bottomDistance = () => pane.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop);
  assert.ok(await bottomDistance() <= 1, 'mount follows recent messages');
  await page.evaluate(() => window.appendRow());
  await page.waitForTimeout(250);
  assert.ok(await bottomDistance() <= 1, 'new rows follow while pinned');
  for (const status of ['queued', 'running', undefined]) {
    await page.evaluate(status => window.setAgentStatus(status), status);
    await page.waitForTimeout(250);
    const activity = page.locator('[data-message-id="agent-activity"]');
    assert.equal(await pane.locator('.thinking-spinner').count(), status ? 1 : 0);
    assert.ok(!(await activity.innerText()).includes('Internal process commentary'));
    const decal = page.locator('article').filter({ has: activity }).locator('.chat-working-output');
    if (status === 'running') {
      for (const text of ['First public output', 'Second public output']) {
        await page.evaluate(text => window.streamOutput(text), text);
        await page.waitForTimeout(100);
        assert.equal(await decal.innerText(), text);
        assert.ok(!(await activity.innerText()).includes('Private reasoning'));
        assert.ok(await bottomDistance() <= 1, 'stream updates preserve the live edge');
      }
      assert.equal(await decal.evaluate(el => getComputedStyle(el).animationName), 'chat-activity-flicker');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      assert.equal(await decal.evaluate(el => getComputedStyle(el).animationName), 'none');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
    }
    if (!status) assert.equal(await decal.count(), 0);
    if (!status) assert.ok((await activity.innerText()).includes('The substantive final answer.'));
    assert.ok(await bottomDistance() <= 1, 'activity transitions preserve the live edge');
  }
  await pane.hover();
  await page.mouse.wheel(0, 20);
  await page.waitForTimeout(100);
  await page.evaluate(() => window.appendRow());
  await page.waitForTimeout(250);
  assert.ok(await bottomDistance() <= 1, 'downward wheel at bottom preserves follow');
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
  const historicalRow = seq => ({ id: `history-${seq}`, seq, channelId: 'history-test', author: 'reader',
    body: `Historical message ${seq}`, createdAt: new Date(1700000000000 + seq * 60000).toISOString() });
  const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => historicalRow(from + i));
  const cursors = [];
  let refreshCount = 0;
  await page.route('**/api/vaults/vault/channels/history-test/messages?**', async route => {
    const before = Number(new URL(route.request().url()).searchParams.get('beforeSeq'));
    if (!before) {
      refreshCount++;
      return route.fulfill({ json: { messages: range(361, 481), beforeSeq: 361, hasMore: true } });
    }
    cursors.push(before);
    if (before === 361) return route.fulfill({ json: { messages: range(241, 360), beforeSeq: 241, hasMore: true } });
    if (before === 241) return route.fulfill({ json: { messages: [], beforeSeq: 121, hasMore: true } });
    if (before === 121) return route.fulfill({ json: { messages: range(1, 120), beforeSeq: 1, hasMore: false } });
    throw new Error(`Unexpected history cursor ${before}`);
  });
  await page.evaluate(rows => { window.seedHistory(rows); window.switchChannel('history-test'); }, range(361, 480));
  await page.waitForTimeout(350);
  assert.deepEqual(cursors, [], 'history sentinel is bound to scroller and does not fetch at live edge');
  await pane.hover();
  await page.mouse.wheel(0, -100000);
  await page.waitForFunction(() => window.historyRows().length === 240);
  await page.waitForTimeout(250);
  assert.ok(await pane.evaluate(el => el.scrollTop) > 100, 'prepend preserves the reading anchor');
  await page.evaluate(() => window.refreshHistory());
  assert.equal(await page.evaluate(() => window.historyRows().length), 241, 'recent refresh retains older page and new realtime row');
  await page.mouse.wheel(0, -100000);
  await page.waitForFunction(() => window.historyRows().some(row => row.seq === 1));
  assert.deepEqual(cursors, [361, 241, 121], 'sentinel crosses an entirely hidden page without false exhaustion');
  await page.evaluate(() => window.refreshHistory());
  assert.equal(await page.evaluate(() => window.historyRows().length), 361);
  assert.equal(await page.evaluate(() => new Set(window.historyRows().map(row => row.id)).size), 361, 'merge deduplicates pages and snapshots');
  await page.mouse.wheel(0, -100000);
  await page.waitForTimeout(300);
  assert.deepEqual(cursors, [361, 241, 121], 'exhausted history stays exhausted across recent refresh');
  assert.equal(refreshCount, 2);
  assert.ok(await page.getByText('Beginning of conversation').isVisible());
  assert.deepEqual(errors, [], 'chat fixture has no runtime errors');
  console.log('Chat scrolling browser regression passed');
} finally {
  await browser?.close();
  await server.close();
}
