/** Headless UI regression against the built client; all API traffic is mocked. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { pickPort } from './lib/test-ports.mjs';

const port = await pickPort();
const base = `http://127.0.0.1:${port}`;
const preview = spawn('npm', ['--workspace=client', 'run', 'preview', '--', '--host', '127.0.0.1', '--port', String(port)], { stdio: 'ignore' });
let browser;
try {
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${base}/app.html`).then(r => r.ok).catch(() => false)) break;
    await delay(100);
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const user = { id: 1, username: 'fixture', displayName: 'Fixture', avatarUrl: '' };
  let vaults = ['Alpha', 'Beta'].map((name, i) => ({ id: `v${i}`, name, role: 'owner', visibility: 'public', memberCount: 1 }));
  const writes = [];
  const errors = [];
  let failDelete = true;
  let failMembers = false;
  let failList = false;
  let role = 'owner';
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    let data = {};
    let status = 200;
    if (method !== 'GET') writes.push({ path, method });
    if (path === '/api/session') data = { authenticated: true, user, owner: false };
    else if (path === '/api/vaults') {
      if (method === 'POST') { status = 400; data = { error: 'Fixture create rejected' }; }
      else if (failList) { status = 503; data = { error: 'Fixture vault list unavailable' }; }
      else data = { vaults };
    }
    else if (/\/api\/vaults\/v\d$/.test(path)) {
      const id = path.split('/').at(-1);
      if (method === 'PATCH') {
        vaults = vaults.map(v => v.id === id ? { ...v, name: request.postDataJSON().name } : v);
        data = { vault: vaults.find(v => v.id === id) };
      } else if (method === 'DELETE') {
        await delay(150);
        if (failDelete) { status = 403; data = { error: 'Fixture deletion refused' }; }
        else vaults = vaults.filter(v => v.id !== id);
      }
    } else if (path.endsWith('/members/1') && method === 'DELETE') vaults = vaults.filter(v => !path.includes(`/${v.id}/`));
    else if (path.endsWith('/members')) {
      await delay(800);
      if (failMembers) { status = 503; data = { error: 'Fixture settings unavailable' }; }
      else data = { members: [{ ...user, userId: 1, role }], role };
    } else if (path.endsWith('/visibility')) data = { visibility: 'public' };
    else if (path.endsWith('/folders')) data = { folders: [] };
    else if (path.endsWith('/notes') || path.endsWith('/public-home-notes')) data = { notes: [] };
    else if (path.endsWith('/join-requests')) data = { requests: [] };
    else if (path.endsWith('/bans')) data = { bans: [] };
    else if (path.endsWith('/reports')) data = { reports: [] };
    else if (path.includes('/community/updates')) data = { updates: [], counts: { byVault: {}, byTarget: {}, total: 0 } };
    else if (path.endsWith('/vault-agents')) data = { agents: [] };
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
  });
  await page.goto(`${base}/app.html`);
  await page.getByRole('button', { name: 'Open vault Alpha', exact: true }).waitFor();
  const openManager = async () => page.getByRole('button', { name: 'Manage vaults', exact: true }).last().click();
  const active = () => page.locator('.vault-rail-button[aria-current="page"]').getAttribute('data-vault-id');
  assert.equal(await active(), 'v0');
  await openManager();
  await page.screenshot({ path: '/tmp/vault-manager-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('.vault-manager-menu').evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await page.screenshot({ path: '/tmp/vault-manager-populated-mobile.png' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.locator('.vault-manager-menu').evaluate(el => el.contains(document.activeElement)), true);
  await page.getByRole('button', { name: 'Manage Beta', exact: true }).click();
  await page.getByText('Loading vault settings…').waitFor();
  assert.equal(await page.getByText('private to you').count(), 0);
  await page.getByRole('button', { name: 'Rename vault', exact: true }).waitFor();
  assert.equal(await active(), 'v0', 'Managing another vault must preserve the active workspace');
  await page.screenshot({ path: '/tmp/vault-settings-desktop.png' });
  await page.getByLabel('Vault name', { exact: true }).fill('Beta renamed');
  await page.getByRole('button', { name: 'Rename vault', exact: true }).click();
  await page.getByText('Vault renamed.', { exact: true }).waitFor();
  assert.equal(writes.at(-1).path, '/api/vaults/v1');
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Delete vault permanently', exact: true }).click();
  await page.getByRole('button', { name: 'Working…', exact: true }).waitFor();
  await page.getByText('Could not delete vault. Try again.', { exact: true }).waitFor();
  assert.equal(await active(), 'v0');
  failDelete = false;
  await page.getByRole('button', { name: 'Delete vault permanently', exact: true }).click();
  await page.locator('.account-settings').waitFor({ state: 'detached' });
  assert.equal(await active(), 'v0');
  await openManager();
  await page.getByRole('button', { name: 'Manage Alpha', exact: true }).click();
  await page.getByRole('button', { name: 'Delete vault permanently', exact: true }).click();
  await page.locator('.account-settings').waitFor({ state: 'detached' });
  await openManager();
  await page.getByText('No vaults yet. Create a vault or join with an invite link below.').waitFor();
  assert.equal(writes.filter(w => w.path === '/api/vaults' && w.method === 'POST').length, 0, 'Last-vault deletion must not recreate a vault');
  await page.getByRole('button', { name: 'Close vault workspace' }).click();
  vaults = [{ id: 'v0', name: 'Alpha', role: 'viewer', visibility: 'private', memberCount: 2 }];
  role = 'viewer';
  await page.reload();
  await openManager();
  await page.getByRole('button', { name: 'Manage Alpha', exact: true }).click();
  await page.getByRole('button', { name: 'Leave vault', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Delete vault permanently', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Rename vault', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Close account settings' }).click();
  failMembers = true;
  await openManager();
  await page.getByRole('button', { name: 'Manage Alpha', exact: true }).click();
  await page.getByText('Fixture settings unavailable').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Leave vault', exact: true }).count(), 0);
  failMembers = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByRole('button', { name: 'Leave vault', exact: true }).click();
  await page.locator('.account-settings').waitFor({ state: 'detached' });
  await openManager();
  await page.getByText('No vaults yet. Create a vault or join with an invite link below.').waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('.vault-manager-menu').evaluate(el => el.scrollWidth <= el.clientWidth), true, 'Manager must fit the mobile viewport');
  await page.getByRole('button', { name: 'New vault Start a private workspace' }).click();
  await page.getByLabel('New vault name').fill('Fixture');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByText('Could not create vault. Check the name and try again.').waitFor();
  assert.equal(await page.getByLabel('New vault name').inputValue(), 'Fixture');
  await page.screenshot({ path: '/tmp/vault-manager-mobile.png' });
  await page.setViewportSize({ width: 1280, height: 900 });
  failList = true;
  await page.reload();
  await page.getByRole('button', { name: 'Retry vaults', exact: true }).waitFor();
  failList = false;
  await page.getByRole('button', { name: 'Retry vaults', exact: true }).click();
  await page.getByRole('button', { name: 'Retry vaults', exact: true }).waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  console.log('PASS: selected-vault rename/delete, workspace preservation, loading/error/retry, owner/viewer permissions, last delete/leave, mobile overflow; mocked API only.');
} finally {
  await browser?.close();
  preview.kill();
}
