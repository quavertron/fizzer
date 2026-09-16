#!/usr/bin/env node
// Real Electron renderer + two real Elixir servers, with disposable accounts,
// databases, home directory and Electron profile. No live agent credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';
import { launchTestBackend } from './lib/test-backend.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagedExecutable = process.env.FIZZER_E2E_EXECUTABLE_PATH;
const electronExecutable = packagedExecutable || createRequire(path.join(root, 'cascade-electron/package.json'))('electron');
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'fizzer-desktop-vaults-e2e-'));
const home = path.join(artifacts, 'home');
fs.mkdirSync(home);
const checks = [];
const servers = [];
let app;
let page;
const password = 'isolated-e2e-password';
function pass(name) { checks.push(name); console.log(`PASS ${name}`); }
async function api(origin, endpoint, token, body) {
  const response = await fetch(`${origin}${endpoint}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  });
  assert.ok(response.ok, `${endpoint}: HTTP ${response.status}`);
  return response.json();
}
async function start(name) {
  const server = await launchTestBackend({ name, repoRoot: root, pipeOutput: false,
    env: { JWT_SECRET: `isolated-${name}-jwt-secret`, CASCADE_NETWORK_MODE: 'false',
      CASCADE_QMD_WORKER_ENABLED: 'false', ERL_FLAGS: '+S 2:2' },
    prepare: ({ clientDistRoot }) => fs.cpSync(path.join(root, 'client/dist'), clientDistRoot, { recursive: true }),
  });
  servers.push(server);
  return server;
}
async function currentUser() {
  return page.evaluate(async () => (await (await fetch('/api/session')).json()).user?.username);
}
async function waitUser(username) {
  await page.waitForFunction(async expected => (await (await fetch('/api/session')).json()).user?.username === expected, username);
}
async function waitPage(url) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const candidate = app.windows().find(window => !window.isClosed() && window.url() === url);
    if (candidate) { page = candidate; page.setDefaultTimeout(15_000); return; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Desktop did not open ${url}`);
}
async function localMenu(localOrigin) {
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find(item => item.label === 'Vault').submenu.items[0].click());
  await waitPage(`${localOrigin}/app?chooser=1`);
  await page.getByRole('heading', { name: 'Choose a vault' }).waitFor();
}

try {
  const local = await start('desktop-local');
  const remote = await start('desktop-remote');
  // Deliberately share a hostname: Electron must isolate cookies by full origin,
  // including the port, instead of relying on browser cookie host scoping.
  const remoteOrigin = remote.baseUrl;
  const localAccount = await api(local.baseUrl, '/api/auth/register', null, { username: 'local_owner', password });
  const remoteAccount = await api(remoteOrigin, '/api/auth/register', null, { username: 'remote_owner', password });
  const localVault = (await api(local.baseUrl, '/api/vaults', localAccount.token, { name: 'Local E2E vault' })).vault;
  assert.deepEqual((await api(remoteOrigin, '/api/vaults', remoteAccount.token)).vaults, []);
  const discoveryBefore = fs.readFileSync(path.join(path.dirname(local.databasePath), 'local-backend.json'), 'utf8');
  app = await electron.launch({ executablePath: electronExecutable, args: packagedExecutable ? [] : [path.join(root, 'cascade-electron')], cwd: root,
    env: { ...process.env, HOME: home, CASCADE_APP_URL: '', APP_URL: '',
      FIZZER_EMBEDDED_BACKEND: '1', CASCADE_DATA_DIR: path.dirname(local.databasePath),
      CASCADE_USER_DATA_DIR: path.join(artifacts, 'electron-profile'), ERL_FLAGS: '+S 2:2' }, timeout: 30_000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  await page.getByRole('heading', { name: 'Choose a vault' }).waitFor();
  assert.equal(await page.locator('#auth-panel').count(), 0);
  pass('fresh desktop opens chooser without an app login gate');
  await page.getByRole('button', { name: /^Connect to local server/ }).click();
  await page.locator('#username').fill('local_owner');
  await page.locator('#password').fill(password);
  await page.locator('#auth-submit').click();
  await page.getByRole('button', { name: /Local E2E vault/ }).waitFor();
  await waitUser('local_owner');
  assert.equal(fs.readFileSync(path.join(path.dirname(local.databasePath), 'local-backend.json'), 'utf8'), discoveryBefore);
  pass('existing local account logs in and Electron reuses the existing backend');

  await page.getByRole('button', { name: /Connect to remote server/ }).click();
  await page.locator('#desktop-remote-origin').fill(remoteOrigin);
  await page.locator('#desktop-remote-username').fill('remote_owner');
  await page.locator('#desktop-remote-password').fill(password);
  await page.locator('.desktop-remote-form button[type=submit]').click();
  await waitPage(`${remoteOrigin}/app`);
  await waitUser('remote_owner');
  await page.getByRole('heading', { name: 'Choose a vault' }).waitFor();
  pass('remote account with no vaults opens its own authenticated server');
  await page.getByRole('button', { name: /Create .* vault/ }).click();
  await page.locator('#desktop-new-vault').fill('Remote E2E vault');
  await page.locator('.desktop-chooser-form button[type=submit]').click();
  await page.getByRole('button', { name: /Remote E2E vault/ }).waitFor();
  const remoteVault = (await api(remoteOrigin, '/api/vaults', remoteAccount.token)).vaults.find(vault => vault.name === 'Remote E2E vault');
  assert.ok(remoteVault);
  assert.equal((await api(local.baseUrl, '/api/vaults', localAccount.token)).vaults.length, 1);
  pass('first remote vault is created on the remote server only');

  await localMenu(local.baseUrl);
  await waitUser('local_owner');
  await page.getByRole('button', { name: /Local E2E vault/ }).click();
  await page.getByRole('button', { name: 'Open selected vault' }).click();
  await page.locator('#sidebar').waitFor();
  const invitation = await api(remoteOrigin, `/api/vaults/${remoteVault.id}/invite-link`, remoteAccount.token, { role: 'editor' });
  await page.getByRole('button', { name: 'Manage vaults', exact: true }).click();
  await page.getByRole('button', { name: /Join vault.*Use an invite link/ }).click();
  await page.getByRole('textbox', { name: 'Vault invite link' }).fill(`${remoteOrigin}/vault-invite/${invitation.token}`);
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await waitPage(`${remoteOrigin}/app?vault=${remoteVault.id}`);
  await waitUser('remote_owner');
  await page.locator('#sidebar').waitFor();
  pass('workspace remote invite navigates to the remote server with its identity');
  await page.screenshot({ path: path.join(artifacts, 'remote-workspace.png') });

  await localMenu(local.baseUrl);
  assert.equal(await currentUser(), 'local_owner');
  pass('same-host different-port servers retain independent authenticated sessions');
  // Exercise an actual disk failure followed by a fresh successful login.
  const entries = path.join(path.dirname(local.databasePath), 'server-sessions');
  fs.renameSync(entries, `${entries}.saved`);
  fs.writeFileSync(entries, 'block session writes');
  await app.evaluate(async ({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) await window.webContents.session.clearStorageData({ storages: ['cookies'] });
  });
  await page.reload();
  await page.getByRole('button', { name: /^Connect to local server/ }).click();
  await page.locator('#username').fill('local_owner');
  await page.locator('#password').fill(password);
  await page.locator('#auth-submit').click();
  await page.getByRole('button', { name: /Local E2E vault/ }).waitFor();
  await waitUser('local_owner');
  pass('session storage failure does not prevent an existing account logging in');
  await app.close();
  app = null;
  assert.equal((await api(local.baseUrl, '/api/health')).status, 'ok');
  pass('quitting Electron leaves the reused backend healthy');
  if (packagedExecutable) {
    const freshData = path.join(artifacts, 'fresh-data');
    app = await electron.launch({ executablePath: packagedExecutable, args: [], cwd: root,
      env: { ...process.env, HOME: home, CASCADE_APP_URL: '', APP_URL: '',
        FIZZER_EMBEDDED_BACKEND: '1', CASCADE_DATA_DIR: freshData,
        CASCADE_USER_DATA_DIR: path.join(artifacts, 'fresh-profile'), ERL_FLAGS: '+S 2:2' }, timeout: 45_000,
    });
    page = await app.firstWindow();
    await page.getByRole('heading', { name: 'Choose a vault' }).waitFor({ timeout: 30_000 });
    const discovery = JSON.parse(fs.readFileSync(path.join(freshData, 'local-backend.json'), 'utf8'));
    assert.equal(discovery.database, path.join(freshData, 'docs.db'));
    assert.equal((await api(discovery.origin, '/api/health')).status, 'ok');
    pass('packaged app boots its bundled backend on a fresh database');
    await app.close();
    app = null;
    fs.rmSync(freshData, { recursive: true, force: true });
    fs.rmSync(path.join(artifacts, 'fresh-profile'), { recursive: true, force: true });
  }
  console.log(`PASS ${checks.length} desktop E2E checks; artifacts: ${artifacts}`);
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
    fs.writeFileSync(path.join(artifacts, 'failure.txt'), await page.locator('body').innerText().catch(() => 'Window unavailable'));
  }
  console.error(`FAIL ${error.stack}\nArtifacts: ${artifacts}`);
  process.exitCode = 1;
} finally {
  await app?.close().catch(() => {});
  for (const server of servers.reverse()) await server.stop();
  fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify({ checks, passed: !process.exitCode }, null, 2));
  // Keep screenshots/results; remove cookies, credentials and test home.
  fs.rmSync(path.join(artifacts, 'electron-profile'), { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
}
