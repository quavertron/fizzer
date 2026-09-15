/** Real built App, isolated Chromium/API fixtures. Never touches a signed-in desktop. */
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
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${base}/app.html`).then(r => r.ok).catch(() => false)) { ready = true; break; }
    await delay(100);
  }
  assert.ok(ready, 'preview ready');
  browser = await chromium.launch({ headless: true });
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(15000);
    const errors = [], writes = [], missionReads = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const tab = { id: 'mission:old', title: 'Old workspace', type: 'mission', dirty: false };
      localStorage.setItem('cascade_session', JSON.stringify({activeVaultId:'v0',openTabs:[tab],activeTabId:tab.id}));
    });
    await page.route('**/socket.io/**', r => r.abort());
    await page.route('**/api/**', async route => {
      const req = route.request(), pathname = new URL(req.url()).pathname;
      if (req.method() !== 'GET') writes.push(pathname);
      if (pathname.includes('/missions')) missionReads.push(pathname);
      let data = {};
      const user = { id: 1, username: 'fixture', displayName: 'Fixture' };
      const note = { id: 'c1', title: 'Existing conversation', content_preview: 'cascade://chat-channel', content: 'cascade://chat-channel', vault_id:'v0', folder_id:null, tags:[] };
      if (pathname === '/api/session') data = { authenticated: true, user, owner: false };
      else if (pathname === '/api/vaults') data = { vaults: [{ id: 'v0', name: 'Rollback fixture', role: 'owner' }] };
      else if (pathname.endsWith('/missions')) data = { missions: [{id:'old',title:'Old workspace',channelId:'virtual-old',phase:'planning'}] };
      else if (pathname.endsWith('/folders')) data = { folders: [] };
      else if (pathname.endsWith('/notes')) data = { notes: [note] };
      else if (pathname.startsWith('/api/notes/')) data = { note };
      else if (pathname.endsWith('/messages')) data = {messages:[{id:'m1',channelId:'c1',author:'fixture',body:'Retained room transcript',createdAt:'2026-09-15T10:00:00Z'}],hasMore:false};
      else if (pathname.endsWith('/members')) data = {members:[{...user,userId:1,role:'owner'}],role:'owner'};
      else if (pathname.endsWith('/agents') || pathname.endsWith('/vault-agents')) data = {agents:[]};
      else if (pathname.includes('/community/updates')) data = {updates:[],counts:{byVault:{},byTarget:{},total:0}};
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
    });
    await page.goto(`${base}/app.html`);
    await page.getByText('Retained room transcript', {exact:true}).waitFor();
    assert.equal(await page.locator('.sidebar-missions, .mission-workspace').count(), 0);
    assert.equal(await page.getByRole('button', {name:'Create mission',exact:true}).count(), 0);
    assert.equal(await page.getByText('Old workspace', {exact:true}).count(), 0);
    assert.equal(await page.locator('#missions-sidebar-heading').count(), 0);
    assert.deepEqual(missionReads, [], 'no workspace discovery/hydration requests');
    assert.deepEqual(writes, [], 'no write or model dispatch during restoration');
    assert.deepEqual(errors, [], 'no runtime errors');
    await page.close();
    console.log(JSON.stringify({width,existingConversationRendered:true,staleMissionTabDiscarded:true,missionSectionAbsent:true,workspaceAbsent:true,writes:0}));
  }
} finally { await browser?.close(); preview.kill('SIGTERM'); }
