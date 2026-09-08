/** Headless regression against the built UI with isolated API fixtures. */
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(10000);
  const user = { id: 1, username: 'fixture', displayName: 'Fixture' };
  const notes = ['brief', 'milestone', 'feature'].map((id, i) => ({
    id, title: ['Mission brief', 'First milestone', 'First feature'][i], content: `# ${id}\n\nPlan for @worker.`,
    revision: 'r1', vault_id: 'v0', tags: [],
  }));
  const tasks = [
    { id: 't1', title: 'Nested active work', briefNoteId: 'feature', status: 'running', runId: 21, attempt: 2, assigneeMention: 'worker', purpose: 'implementation' },
    { id: 't2', title: 'Unlinked research', status: 'running', runId: 22, attempt: 1, assigneeMention: 'researcher', purpose: 'research' },
  ];
  const mission = { id: 'm1', vaultId: 'v0', channelId: 'c1', title: 'Mission fixture', phase: 'planning', status: 'active', coordinatorRegistrationId: 'coord', updatedAt: '2026-09-08T00:00:00Z', tasks,
    notes: notes.map((n, i) => ({ noteId: n.id, title: n.title, revision: n.revision, kind: ['mission', 'milestone', 'feature'][i], parentNoteId: i === 2 ? 'milestone' : null })) };
  const messages = [
    { id: 'old', channelId: 'c1', missionTaskId: 't1', runId: 20, body: 'PREVIOUS ATTEMPT', createdAt: '2026-09-08T00:00:00Z', author: 'worker' },
    { id: 'current', channelId: 'c1', missionTaskId: 't1', runId: 21, body: 'CURRENT ATTEMPT', createdAt: '2026-09-08T00:00:00Z', author: 'worker' },
    { id: 'research', channelId: 'c1', missionTaskId: 't2', runId: 22, body: 'Research findings', createdAt: '2026-09-08T00:00:00Z', author: 'researcher' },
  ];
  const errors = [];
  const writes = [];
  let approvalCalls = 0;
  let log = 'first hydrated tool output';
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const method = request.method();
    let data = {}, status = 200;
    if (method !== 'GET') writes.push({ pathname, method, body: request.postDataJSON() });
    if (pathname === '/api/session') data = { authenticated: true, user, owner: false };
    else if (pathname === '/api/vaults') data = { vaults: [{ id: 'v0', name: 'Fixture', role: 'owner' }] };
    else if (pathname.endsWith('/missions/m1/approve')) {
      approvalCalls++;
      if (approvalCalls === 1) {
        notes[0].revision = 'r2'; notes[0].content += '\nCollaborator update'; mission.notes[0].revision = 'r2';
        status = 409; data = { error: 'Mission changed' };
      } else {
        assert.equal(request.postDataJSON().expectedRevisions.brief, 'r2');
        mission.phase = 'executing'; data = { mission };
      }
    } else if (pathname.endsWith('/missions/m1/finish')) {
      assert.equal(request.postDataJSON().status, 'canceled');
      mission.phase = 'closed'; mission.status = 'canceled'; tasks.forEach(task => { task.status = 'canceled'; });
      data = { mission };
    } else if (pathname.endsWith('/missions/m1')) data = { mission };
    else if (pathname.endsWith('/missions')) data = { missions: [mission] };
    else if (pathname.startsWith('/api/notes/')) data = { note: notes.find(n => n.id === pathname.split('/').at(-1)) };
    else if (pathname.endsWith('/messages/current')) data = { message: { ...messages[1], harnessLog: log } };
    else if (pathname.includes('/messages/')) data = { message: messages.find(m => m.id === pathname.split('/').at(-1)) };
    else if (pathname.endsWith('/messages')) data = { messages, hasMore: false };
    else if (pathname.endsWith('/channels')) data = { channels: [{ id: 'c1', name: 'Mission conversation', vaultId: 'v0' }] };
    else if (pathname.endsWith('/folders')) data = { folders: [] };
    else if (pathname.endsWith('/notes') || pathname.endsWith('/public-home-notes')) data = { notes: [] };
    else if (pathname.endsWith('/members')) data = { members: [{ ...user, userId: 1, role: 'owner' }], role: 'owner' };
    else if (pathname.includes('/community/updates')) data = { updates: [], counts: { byVault: {}, byTarget: {}, total: 0 } };
    else if (pathname.endsWith('/agents') || pathname.endsWith('/vault-agents')) data = { agents: [] };
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
  });
  await page.goto(`${base}/app.html`);
  await page.locator('.sidebar-mission-item').filter({ hasText: 'Mission fixture' }).click();
  const workspace = page.getByRole('region', { name: 'Mission workspace: Mission fixture', exact: true });
  await workspace.getByRole('button', { name: 'Approve mission', exact: true }).waitFor();
  await workspace.locator('.mission-live-summary').click();
  assert.equal(await workspace.locator('.mission-milestone-summary').getAttribute('aria-expanded'), 'true');
  assert.equal(await workspace.locator('.mission-feature-summary').getAttribute('aria-expanded'), 'true');
  await workspace.locator('#mission-worker-t1').click();
  const trace = workspace.getByRole('region', { name: 'Worker trace for worker', exact: true });
  await trace.getByText('CURRENT ATTEMPT', { exact: true }).waitFor();
  assert.equal(await trace.getByText('PREVIOUS ATTEMPT', { exact: true }).count(), 0);
  assert.equal(await workspace.locator('.mission-feature .mission-trace').count(), 1);
  await trace.getByText('first hydrated tool output', { exact: true }).waitFor();
  log = 'refreshed tool output';
  await trace.getByTitle('Refresh trace', { exact: true }).click();
  await trace.getByText(log, { exact: true }).waitFor();
  await trace.getByTitle('Open fullscreen', { exact: true }).click();
  assert.equal(await workspace.locator('.mission-trace.is-fullscreen').count(), 1);
  await page.keyboard.press('Escape');
  assert.equal(await workspace.locator('.mission-trace.is-fullscreen').count(), 0);
  await trace.getByTitle('Close trace', { exact: true }).click();
  await workspace.getByRole('button', { name: /Unlinked research/ }).click();
  await workspace.getByRole('region', { name: 'Worker trace for researcher', exact: true }).getByText('Research findings', { exact: true }).waitFor();
  await workspace.getByRole('button', { name: 'Brief', exact: true }).click();
  await workspace.getByRole('button', { name: 'Approve mission', exact: true }).click();
  await workspace.getByRole('button', { name: 'Mark updated note reviewed', exact: true }).click();
  await workspace.getByRole('button', { name: 'Approve mission', exact: true }).click();
  await workspace.locator('.mission-phase').filter({ hasText: 'executing' }).waitFor();
  const editor = workspace.locator('.mission-brief-view .cm-content');
  await editor.focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' Local edit');
  await workspace.getByText('Unsaved changes', { exact: true }).waitFor();
  for (const width of [840, 390]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await workspace.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'workspace fits narrow viewport');
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await workspace.getByRole('button', { name: 'Stop', exact: true }).click();
  await workspace.locator('.mission-phase').filter({ hasText: 'closed' }).waitFor();
  assert.equal(writes.filter(write => write.pathname.endsWith('/finish')).length, 1);
  assert.deepEqual(errors, []);
  console.log('PASS mission UI: nested navigation, inline exact-run traces, refresh, fullscreen/Escape, unlinked tasks, approval conflict recovery, and Stop');
} finally {
  await browser?.close();
  preview.kill('SIGTERM');
}
