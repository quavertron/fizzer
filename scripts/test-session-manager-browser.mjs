/** Opening Session Manager must survive a deploy replacing unloaded assets. */
import assert from 'node:assert/strict';
import { preview } from 'vite';
import { chromium } from 'playwright';

const server = await preview({ root: new URL('../client', import.meta.url).pathname, preview: { host: '127.0.0.1', port: 0 } });
const browser = await chromium.launch({ headless: true });
try {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 412, height: 915 }]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('console', message => {
      if (message.type() === 'error' && message.text().includes('[ErrorBoundary:')) errors.push(message.text());
    });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/socket.io/**', route => route.abort());
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
      const data = path === '/api/session'
        ? { authenticated: true, user: { id: 1, username: 'regression' } }
        : path === '/api/vaults' ? { vaults: [{ id: 'test', name: 'Test' }] }
        : path === '/api/me/active-sessions' ? { sessions: [{ id: 1, agent: 'codex', status: 'running', prompt: 'Regression request', started_at: new Date().toISOString(), vault_name: 'Test' }] }
        : path === '/api/runs/1/events' ? { events: [{ id: 1, seq: 1, type: 'status', payload_json: JSON.stringify({ status: 'running' }), ts: new Date().toISOString() }] }
        : path === '/api/community/updates' ? { items: [], counts: { total: 0, byVault: {}, byChannel: {} } }
        : { notes: [], folders: [], channels: [], agents: [], members: [], items: [], runs: [], tasks: [] };
      return route.fulfill({ json: data });
    });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/app.html`);
    await page.locator('#session-manager-btn').waitFor({ timeout: 5000 });
    // The running shell remains open while the deployment removes old chunks.
    // Recovery must not require reloading the entire workspace.
    await page.route('**/assets/SessionManager-*.js', route => route.abort());
    await page.locator('#session-manager-btn').click({timeout:5000});
    await page.getByRole('dialog', { name: 'Agent sessions' }).waitFor({ timeout: 5000 });
    await page.locator('.session-manager-item').click();
    await page.getByText('Agent connected and working.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Close session manager' }).click();
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`Session Manager survives replaced assets at ${viewport.width}px`);
  }
} finally {
  await browser.close();
  server.httpServer.closeAllConnections();
  await new Promise(resolve => server.httpServer.close(resolve));
}
