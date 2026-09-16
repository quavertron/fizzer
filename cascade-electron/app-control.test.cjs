'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { startExternalAgentAccess, request } = require('./external-agent-access.cjs');
const { reads, writes } = require('./app-control.cjs');
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fizzer-control-'));
  fs.chmodSync(directory, 0o700);
  const v = randomUUID(), other = randomUUID();
  const vaults = new Map([[v, { id: v, name: 'Private', created_by: 1, visibility: 'private', role: 'owner' }], [other, { id: other, name: 'Shared', created_by: 2, visibility: 'public', role: 'viewer' }]]);
  const notes = new Map(), folders = new Map(), calls = [];
  const state = { owner: 1, writes: 0, lost: false, corrupt: false, shared: false };
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const b of req) raw += b;
    const body = raw ? JSON.parse(raw) : null;
    calls.push([req.method, req.url]);
    assert.equal(req.headers['x-cascade-browser'], '1');
    assert.equal(req.headers.authorization, undefined);
    const respond = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    const get = req.method === 'GET';
    if (!get) state.writes++;
    if (req.url === '/api/me') return respond(200, { user: { id: state.owner, username: 'owner', avatarUrl: 'NOT_RETURNED' } });
    if (req.url === '/api/vaults' && get) return respond(200, { vaults: [...vaults.values()] });
    if (req.url === '/api/vaults' && !get) { const vault = { id: randomUUID(), ...body, role: 'owner', created_by: 1 }; vaults.set(vault.id, vault); return respond(201, { vault }); }
    const m = req.url.match(/^\/api\/vaults\/([^/]+)(?:\/(.*))?$/);
    if (m) {
      const id = m[1], suffix = m[2];
      if (!vaults.has(id)) return respond(404, {});
      if (!suffix) {
        if (!get) vaults.get(id).name = body.name;
        return respond(200, { vault: vaults.get(id), role: vaults.get(id).role });
      }
      if (suffix === 'members') return respond(200, { role: vaults.get(id).role, members: [{ userId: vaults.get(id).created_by, role: 'owner' }, ...(state.shared ? [{ userId: 3, role: 'viewer' }] : [])] });
      if (suffix === 'notes' || suffix === 'folders') {
        const map = suffix === 'notes' ? notes : folders;
        if (get) return respond(200, { [suffix]: [...map.values()].filter(x => x.vault_id === id) });
        const row = { id: randomUUID(), vault_id: id, ...body };
        map.set(row.id, row);
        if (state.lost) return respond(500, { error: 'SECRET_UPSTREAM' });
        return respond(201, { [suffix === 'notes' ? 'note' : 'folder']: row });
      }
      if (suffix === 'vault-agents') return respond(200, { agents: [{ id: 'agent', name: 'Agent', avatarUrl: 'NO', apiKey: 'NO' }] });
      if (suffix.endsWith('/messages?limit=40')) return respond(200, { messages: [] });
      return respond(200, { fixture: suffix });
    }
    const n = req.url.match(/^\/api\/notes\/([^/]+)(?:\/(.*))?$/);
    if (n && notes.has(n[1])) {
      const row = notes.get(n[1]);
      if (!get && n[2] === 'rename') row.title = body.title;
      if (!get && n[2] === 'move') row.folder_id = body.folder_id;
      if (n[2] && get) return respond(200, { fixture: n[2] });
      if (state.lost && !get) return respond(500, {});
      return respond(200, { note: state.corrupt ? { ...row, content: 'wrong' } : row });
    }
    const f = req.url.match(/^\/api\/folders\/([^/]+)$/);
    if (f && folders.has(f[1])) { folders.get(f[1]).name = body.name; return respond(200, { folder: folders.get(f[1]) }); }
    return respond(200, { fixture: req.url });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const options = { enabled: true, directory, origin: `http://127.0.0.1:${upstream.address().port}`, vaultId: v, ownerId: 1, agentId: 'hermes', author: 'Along (AI agent)', browserFetch: fetch, agentFetch: fetch, allowFixtureHTTP: true };
  let service = await startExternalAgentAccess(options);
  t.after(async () => { await service.close(); await new Promise(r => upstream.close(r)); fs.rmSync(directory, { recursive: true }); });
  const call = p => request(service.socketPath, p);
  const plan = (action, args, requestId = randomUUID()) => call({ op: 'appPlan', action, args, requestId });
  const apply = p => call({ op: 'appApply', action: p.action, args: p.args, requestId: p.requestId, planDigest: p.planDigest });
  return { v, other, state, notes, folders, vaults, calls, call, plan, apply, restart: async () => { await service.close(); service = await startExternalAgentAccess(options); } };
}
test('schema, sanitized identity, explicit shared viewer reads, inaccessible IDs, owner changes and no inference GETs', async t => {
  const f = await fixture(t);
  const cap = await f.call({ op: 'appCapabilities' });
  assert.equal(cap.contract, 'fizzer_app_control_v1');
  assert.equal(cap.operations.filter(x => x.implemented).length, Object.keys(reads).length + Object.keys(writes).length);
  assert.equal((await f.call({ op: 'appRead', action: 'identity', args: {} })).user.avatarUrl, undefined);
  assert.equal((await f.call({ op: 'appRead', action: 'navigation', args: { vaultId: f.other } })).role, 'viewer');
  assert.equal((await f.call({ op: 'appRead', action: 'note', args: { vaultId: f.other, noteId: randomUUID() } })).error, 'note_out_of_scope');
  assert.equal((await f.call({ op: 'appRead', action: 'notes', args: { vaultId: randomUUID() } })).error, 'vault_out_of_scope');
  for (const action of ['semanticSearch', 'channelAgents']) assert.equal((await f.call({ op: 'appRead', action, args: {} })).error, 'invalid_request');
  f.state.owner = 2;
  assert.equal((await f.call({ op: 'appCapabilities' })).error, 'owner_scope_mismatch');
  assert.equal(f.state.writes, 0);
  assert.ok(!f.calls.some(([,p]) => /search|\/channels\/.*\/agents|agent-token/.test(p)));
});
test('real socket plan/apply/readback all eight metadata/create actions, nested folder and durable replay', async t => {
  const f = await fixture(t);
  const folder = await f.apply(await f.plan('createFolder', { vaultId: f.v, name: '资料 🌱', parentId: null }));
  assert.equal(folder.state, 'verified');
  const nested = await f.apply(await f.plan('createFolder', { vaultId: f.v, name: 'Nested', parentId: folder.result.id }));
  assert.equal(nested.result.parent_id, folder.result.id);
  const notePlan = await f.plan('createNote', { vaultId: f.v, title: 'A', content: '', folderId: nested.result.id });
  assert.equal(f.state.writes, 2);
  const n = await f.apply(notePlan); assert.equal(n.state, 'verified');
  await f.restart(); assert.equal((await f.apply(notePlan)).state, 'verified'); assert.equal(f.state.writes, 3);
  const rename = await f.plan('renameNote', { vaultId: f.v, noteId: n.result.id, title: 'B' });
  assert.equal((await f.apply(rename)).result.title, 'B');
  assert.equal((await f.apply(await f.plan('moveNote', { vaultId: f.v, noteId: n.result.id, folderId: null }))).result.folder_id, null);
  assert.equal((await f.apply(await f.plan('renameFolder', { vaultId: f.v, folderId: nested.result.id, name: 'Changed' }))).result.name, 'Changed');
  assert.equal((await f.apply(await f.plan('renameVault', { vaultId: f.v, name: 'New private name' }))).result.name, 'New private name');
  assert.equal((await f.apply(await f.plan('createChannel', { vaultId: f.v, title: 'Channel', folderId: null }))).result.content, 'cascade://chat-channel');
  assert.equal((await f.apply(await f.plan('createVault', { name: 'Not hardcoded wiki' }))).result.name, 'Not hardcoded wiki');
});
test('specific shared approval is not fabricated by plan or input, viewer mutation and arbitrary transport rejected', async t => {
  const f = await fixture(t); f.state.shared = true;
  const p = await f.plan('createNote', { vaultId: f.v, title: 'Shared', content: 'AI text', folderId: null });
  assert.equal(p.requiresConfirmation, true);
  assert.equal((await f.apply(p)).error, 'specific_approval_required');
  assert.equal((await f.call({ op: 'appApply', action: p.action, args: p.args, requestId: p.requestId, planDigest: p.planDigest, approved: true })).error, 'invalid_request');
  assert.equal((await f.plan('renameVault', { vaultId: f.other, name: 'No' })).error, 'owner_scope_mismatch');
  assert.equal((await f.plan('deleteVault', { vaultId: f.v })).error, 'action_not_implemented');
  assert.equal((await f.call({ op: 'appRead', action: 'fetch', args: { route: '/api/me' } })).error, 'invalid_request');
  assert.equal(f.state.writes, 0);
});
test('stale previews, intent conflicts and lost creation responses never replay across restart', async t => {
  const f = await fixture(t);
  const initial = await f.apply(await f.plan('createNote', { vaultId: f.v, title: 'A', content: 'x', folderId: null }));
  const p = await f.plan('renameNote', { vaultId: f.v, noteId: initial.result.id, title: 'B' });
  f.notes.get(initial.result.id).content = 'other editor';
  assert.equal((await f.apply(p)).error, 'stale_plan');
  assert.equal((await f.plan(p.action, { ...p.args, title: 'C' }, p.requestId)).error, 'idempotency_conflict');
  const unknown = await f.plan('createFolder', { vaultId: f.v, name: 'Unknown', parentId: null });
  f.state.lost = true; assert.equal((await f.apply(unknown)).error, 'upstream_500');
  const count = f.state.writes; await f.restart(); f.state.lost = false;
  assert.equal((await f.apply(unknown)).state, 'uncertain'); assert.equal(f.state.writes, count);
  const known = await f.plan('renameNote', { vaultId: f.v, noteId: initial.result.id, title: 'Final' });
  f.state.lost = true; assert.equal((await f.apply(known)).error, 'upstream_500');
  f.state.lost = false;
  const before = f.state.writes;
  const reconciled = await f.call({ op: 'appReconcile', action: known.action, args: known.args, requestId: known.requestId, planDigest: known.planDigest });
  assert.equal(reconciled.state, 'verified'); assert.equal(f.state.writes, before);
});
test('read coverage routes and channel binding exercise actual socket with fixtures', async t => {
  const f = await fixture(t);
  const n = await f.apply(await f.plan('createChannel', { vaultId: f.v, title: 'Channel', folderId: null }));
  for (const [action, fields] of Object.entries(reads)) {
    const values = { vaultId: f.v, noteId: n.result.id, channelId: n.result.id };
    const result = await f.call({ op: 'appRead', action, args: Object.fromEntries(fields.map(k => [k, values[k]])) });
    assert.equal(result.status, 200, action + ': ' + JSON.stringify(result));
  }
});
