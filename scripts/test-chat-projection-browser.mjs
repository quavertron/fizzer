#!/usr/bin/env node
/** Two browser clients against the real backend with a controlled desktop runner. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { io } from 'socket.io-client';
import { launchTestBackend } from './lib/test-backend.mjs';
import { installBrowserSession } from './lib/browser-session.mjs';
import { pickPort } from './lib/test-ports.mjs';

async function until(predicate, label) {
  for (let i = 0; i < 450; i++) {
    const result = await predicate();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}

const backend = await launchTestBackend({ name: 'chat-projection-browser', env: { CASCADE_ALLOW_OPEN_REGISTRATION: '1' } });
let vite, browser, runner;
try {
  const request = async (path, body, token) => {
    const response = await fetch(`${backend.baseUrl}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json();
    assert(response.ok, `${path}: ${JSON.stringify(data)}`);
    return data;
  };
  const { token } = await request('/api/auth/register', { username: 'projection_owner', password: 'testpass12345' });
  const { token: guestToken } = await request('/api/auth/register', { username: 'projection_guest', password: 'testpass12345' });
  const { vault } = await request('/api/vaults', { name: 'Projection test' }, token);
  const { note: channel } = await request(`/api/vaults/${vault.id}/notes`, { title: 'projection', content: 'cascade://chat-channel' }, token);
  await request(`/api/vaults/${vault.id}/members`, { username: 'projection_guest', role: 'editor' }, token);
  const identityResponse = await fetch(`${backend.baseUrl}/api/vaults/${vault.id}/vault-agents`, {
    method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ agentId: 'codex', displayName: 'Sol', mention: 'sol', model: 'test-model' }),
  });
  assert(identityResponse.ok);
  const { agent } = await identityResponse.json();
  await request(`/api/vaults/${vault.id}/channels/${channel.id}/agents/from-vault`, { vaultAgentId: agent.id, pingableByOthers: true }, token);
  const delegated = [];
  runner = io(`${backend.baseUrl}/runners`, { auth: { token }, transports: ['websocket'] });
  runner.on('connect', () => runner.emit('runner:register', { activeRunIds: [], runnerInstanceId: 'projection-test' }));
  runner.on('run:delegate', (run) => {
    delegated.push(run);
    runner.emit('runner:runEvent', { runId: run.runId, type: 'status', payload: { status: 'running' } });
  });
  runner.on('run:cancel', (_run, acknowledge) => acknowledge({ success: true }));
  await until(async () => (await request('/api/me/desktop-runner', null, token)).online, 'runner online');
  const port = await pickPort();
  const url = `http://127.0.0.1:${port}`;
  vite = spawn('npm', ['--workspace=client', 'run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port)], {
    stdio: 'ignore', env: { ...process.env, CASCADE_DEV_PROXY_TARGET: backend.baseUrl, VITE_API_URL: url, VITE_DISABLE_AUTO_REFRESH: 'true' },
  });
  await until(async () => { try { return (await fetch(`${url}/app.html`)).ok; } catch { return false; } }, 'Vite');
  browser = await chromium.launch({ headless: true });
  const errors = [], requests = [], pages = [];
  let blockOwnerSocket = true;
  let dropOwnerFrames = false;
  let failHydration = false;
  let failedHydrations = 0;
  let failStop = false;
  for (const sessionToken of [token, guestToken]) {
    const context = await browser.newContext({ hasTouch: true });
    await installBrowserSession(context, url, sessionToken);
    await context.addInitScript(({ vaultId, channelId }) => {
      localStorage.setItem('cascade_session', JSON.stringify({ activeVaultId: vaultId, workspacesByVault: {
        [vaultId]: { openTabs: [{ id: channelId, title: 'projection', type: 'chat', dirty: false }],
          layout: { type: 'pane', id: 'main', tabIds: [channelId], activeTabId: channelId }, focusedPaneId: 'main' },
      } }));
    }, { vaultId: vault.id, channelId: channel.id });
    const page = await context.newPage();
    if (sessionToken === token) {
      await page.route('**/socket.io/**', (route) => blockOwnerSocket ? route.abort() : route.continue());
      await page.routeWebSocket('**/socket.io/**', (socket) => {
        if (blockOwnerSocket) return socket.close();
        const server = socket.connectToServer();
        server.onMessage((message) => {
          if (!dropOwnerFrames) socket.send(message);
        });
      });
      await page.route('**/runs/*/cancel', (route) => failStop
        ? route.fulfill({ status: 503, json: { error: 'Injected stop outage' } }) : route.continue());
      // Current recovery polls channel snapshots, not individual run messages.
      await page.route(/\/channels\/[^/]+\/messages(?:\?.*)?$/, (route) => {
        if (failHydration && route.request().method() === 'GET') {
          failedHydrations++;
          return route.fulfill({ status: 503, json: { error: 'Injected snapshot outage' } });
        }
        return route.continue();
      });
      await page.route('**/messages/agent-dispatch-*', (route) => {
        if (failStop && route.request().method() === 'DELETE') {
          return route.fulfill({ status: 503, json: { error: 'Injected stop outage' } });
        }
        if (failHydration && route.request().method() === 'GET') {
          failedHydrations++;
          return route.fulfill({ status: 503, json: { error: 'Injected hydration outage' } });
        }
        return route.continue();
      });
    }
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => requests.push({ method: request.method(), path: new URL(request.url()).pathname }));
    await page.goto(`${url}/app.html`);
    await page.locator('.chat-composer textarea').waitFor();
    pages.push(page);
  }
  const send = async (text) => {
    const composer = pages[0].locator('.chat-composer textarea');
    await composer.fill(text);
    await composer.press('Enter');
  };
  const bothSee = async (text) => {
    for (const page of pages) await page.getByRole('log').getByText(text, { exact: false }).first().waitFor();
  };
  const emit = (runId, type, payload) => runner.emit('runner:runEvent', { runId, type, payload });
  await send('@sol first turn');
  await until(() => delegated[0], 'browser-created run');
  const first = delegated[0].runId;
  emit(first, 'text', { chatVisible: true, message: { content: [{ type: 'text', text: 'Authoritative streamed answer.' }] } });
  await bothSee('Authoritative streamed answer.');
  failStop = true;
  await pages[0].getByRole('button', { name: 'Stop run', exact: true }).first().click();
  await until(async () => pages[0].getByRole('button', { name: 'Stop run', exact: true }).first().isEnabled(), 'failed running Stop becomes retryable');
  failStop = false;
  await pages[0].getByRole('button', { name: 'Stop run', exact: true }).first().click();
  await bothSee('Run canceled by user.');
  blockOwnerSocket = false;
  await pages[0].reload();
  await pages[0].locator('.chat-composer textarea').waitFor();
  await send('@sol second turn');
  await until(() => delegated[1], 'next run after cancel');
  const second = delegated[1].runId;
  emit(second, 'text', { chatVisible: true, message: { content: [{ type: 'text', text: 'Long preliminary answer before the final.' }] } });
  await bothSee('Long preliminary answer before the final.');
  emit(second, 'status', { status: 'completed', summary: 'Short final.' });
  await bothSee('Short final.');
  await send('@sol start another answer');
  await until(() => delegated[2], 'run before steer');
  emit(delegated[2].runId, 'text', { chatVisible: true, message: { content: 'Working before steer.' } });
  await bothSee('Working before steer.');
  await send('@sol instead verify steering');
  await until(() => delegated[3], 'steering continuation');
  assert.equal(requests.filter((r) => r.path === `/api/runs/${delegated[2].runId}/cancel`).length, 0, 'Steering belongs to the server');
  emit(delegated[3].runId, 'status', { status: 'completed', summary: 'Steering preserved.' });
  await bothSee('Steering preserved.');
  await send('@sol network failure case');
  await until(() => delegated[4], 'run before network failure');
  const outageRun = delegated[4].runId;
  emit(outageRun, 'text', { chatVisible: true, message: { content: 'This answer will be suppressed.' } });
  await bothSee('This answer will be suppressed.');
  dropOwnerFrames = true;
  failHydration = true;
  emit(outageRun, 'session', { sessionId: 'completed-before-clear' });
  emit(outageRun, 'status', { status: 'completed', summary: 'Suppressed', suppressChatBody: true });
  await until(() => failedHydrations > 0, 'independent polling reaches failed terminal hydration');
  assert(await pages[0].getByRole('log').getByText('This answer will be suppressed.', { exact: true }).count());
  failHydration = false;
  await until(async () => !(await pages[0].getByRole('log').getByText('This answer will be suppressed.', { exact: true }).count()), 'suppressed shell removed by retried authoritative hydration');
  dropOwnerFrames = false;
  for (const page of pages) {
    assert.equal(await page.getByRole('log').getByText('Long preliminary answer before the final.', { exact: true }).count(), 0);
    await page.reload();
    await page.getByRole('log').getByText('Short final.', { exact: true }).waitFor();
  }
  const admit = async (text) => {
    const response = pages[0].waitForResponse((response) => response.request().method() === 'POST'
      && new URL(response.url()).pathname === `/api/vaults/${vault.id}/channels/${channel.id}/messages`);
    await send(text);
    return (await response).json();
  };
  const beforeClear = await admit('@sol establish a resumed session');
  await until(() => delegated[5], 'resumed run before clear');
  assert.equal(delegated[5].resumeSessionId, 'completed-before-clear');
  emit(delegated[5].runId, 'status', { status: 'completed', summary: 'Old session completed.' });
  await bothSee('Old session completed.');
  const cleared = await admit(' /clear @sol ');
  const ping = await admit('@sol ping after clear');
  assert.deepEqual(cleared.dispatches, [], 'Clear creates no dispatch');
  assert.notEqual(cleared.agents[0].conversationId, beforeClear.dispatches[0].conversationId);
  assert.equal(ping.dispatches[0].conversationId, cleared.agents[0].conversationId);
  await bothSee('Cleared the session for @sol.');
  await until(() => delegated[6], 'fresh run after clear');
  assert.equal(delegated[6].resumeSessionId, undefined, 'Clear must not resume a completed old session');
  emit(delegated[6].runId, 'status', { status: 'completed', summary: 'Fresh session confirmed.' });
  await bothSee('Fresh session confirmed.');
  runner.disconnect();
  await until(async () => !(await request('/api/me/desktop-runner', null, token)).online, 'runner offline');
  // Master keeps offline outbox work quiet until runner registration (b512bc75).
  // A queued Stop control requires an actual shell; do not invent one here.
  const admission = await admit('@sol finish after my browser closes');
  assert(admission.dispatches.length > 0, 'Admission returns durable dispatches');
  assert.equal(delegated.length, 7, 'No delegation while the runner is offline');
  await pages[0].close();
  pages.shift();
  await pages[0].getByRole('log').getByText('@sol finish after my browser closes', { exact: true }).waitFor();
  assert.equal(await pages[0].locator(`[data-message-id="agent-dispatch-${admission.dispatches[0].id}"]`).count(), 0, 'Offline outbox does not manufacture a queued reply');
  runner.connect();
  await until(() => delegated[7], 'server delegation after origin close and runner reconnect');
  emit(delegated[7].runId, 'status', { status: 'completed', summary: 'Completed without the origin browser.' });
  await bothSee('Completed without the origin browser.');
  await delay(1_500);
  assert.equal(delegated.length, 8, 'Offline dispatch delegates exactly once after runner reconnect');
  await pages[0].getByTitle('Log out', { exact: true }).click();
  const readsAtLogout = requests.filter((r) => r.path.includes('/messages')).length;
  await delay(16_000);
  assert.equal(requests.filter((r) => r.path.includes('/messages')).length, readsAtLogout, 'Snapshot polling stops after logout');
  assert.equal(requests.filter((r) => r.method === 'POST' && /\/runs$/.test(r.path)).length, 0, 'ZERO client POST /runs');
  assert.equal(requests.filter((r) => r.method === 'PATCH' && r.path.includes('/messages/')).length, 0, 'No renderer patches agent messages');
  assert.equal(requests.filter((r) => /\/runs\/\d+\/events$/.test(r.path)).length, 0, 'No per-run event backfill');
  assert.deepEqual(errors, []);
  console.log('PASS: two browsers, real backend: send, stream, cancel, shorter final, server steering, never-connected socket, dropped frames, failed hydration, suppression recovery, reload, clear then ping without resuming a completed old session, running Stop failure/retry, quiet offline outbox, close-origin before delegation, runner reconnect, logout cleanup; ZERO client POST /runs, message PATCH, or event backfill.');
} finally {
  await browser?.close();
  runner?.disconnect();
  vite?.kill('SIGTERM');
  await backend.stop();
}
