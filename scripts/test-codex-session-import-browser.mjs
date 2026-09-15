import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const server = await createServer({ root: new URL('../client', import.meta.url).pathname, server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const imports = [];
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && message.text().includes('ErrorBoundary')) console.log(message.text()); });
  await page.addInitScript(() => {
    window.codexReads = [];
    window.electronAPI = {
      listCodexSessions: async () => ({ sessions: [{ id: 'local-session', title: 'Existing Codex work', cwd: '/tmp/project', updated_at: 123 }], nextOffset: null }),
      readCodexSession: async ({ id, offset, snapshotEnd }) => { window.codexReads.push({ offset, snapshotEnd }); return { id, title: 'Existing Codex work', cwd: '/tmp/project', messages: [{ index: offset, role: 'assistant', body: offset ? 'Later response' : 'Earlier response', createdAt: '2026-09-01T00:00:00Z' }], nextOffset: offset + 100, snapshotEnd: 200, hasMore: offset === 0 }; },
    };
  });
  await page.route('**/socket.io/**', route => route.abort());
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/import-codex-session')) {
      imports.push(route.request().postDataJSON());
      return route.fulfill({ json: { imported: { channelId: 'imported', title: 'Existing Codex work', following: true } } });
    }
    const data = path === '/api/session' ? { authenticated: true, user: { id: 1, username: 'import-owner' } }
      : path === '/api/vaults' ? { vaults: [{ id: 'test', name: 'Test' }] }
      : path === '/api/me/active-sessions' ? { sessions: [] }
      : path === '/api/community/updates' ? { items: [], counts: { total: 0, byVault: {}, byChannel: {}, byTarget: {} } }
      : { notes: [], folders: [], channels: [], agents: [], members: [], messages: [], items: [], runs: [], tasks: [] };
    return route.fulfill({ json: data });
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/app.html?vault=test`);
  await page.locator('#session-manager-btn').click({ timeout: 10000 });
  await page.getByRole('button', { name: 'Import local Codex session', exact: true }).click();
  await page.getByRole('button', { name: 'Existing Codex work', exact: true }).waitFor();
  assert.equal(imports.length, 0, 'Browsing must not upload local history');
  await page.getByRole('button', { name: 'Existing Codex work', exact: true }).click();
  await page.getByRole('dialog', { name: 'Agent sessions' }).waitFor({ state: 'hidden' });
  assert.deepEqual(imports.map(item => item.messages[0].body), ['Earlier response', 'Later response']);
  assert.deepEqual(await page.evaluate(() => window.codexReads), [{ offset: 0, snapshotEnd: undefined }, { offset: 100, snapshotEnd: 200 }]);
  assert.deepEqual(errors, []);
  console.log('Codex session selection imports a paginated snapshot and opens its Fizzer channel.');
} finally {
  await browser.close();
  server.httpServer.closeAllConnections();
  await new Promise(resolve => server.httpServer.close(resolve));
}
