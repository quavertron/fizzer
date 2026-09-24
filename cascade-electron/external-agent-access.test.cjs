'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { startExternalAgentAccess, request } = require('./external-agent-access.cjs');
const vaultId = '5f57525b-4272-47aa-96ed-cc913a6563e8';
async function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fizzer-access-')));
  fs.chmodSync(directory, 0o700);
  const notes = new Map(), messages = new Map(), calls = [];
  const state = { owner: 1, role: 'owner', corrupt: false, failWrite: false, posts: 0,
    visibility: 'private', creator: 1, members: [{ userId: 1, role: 'owner' }] };
  const vaults = new Map([[vaultId, { id: vaultId, name: 'My Vault', role: 'owner' }]]);
  const upstream = http.createServer(async (req, res) => {
    const parts = []; for await (const c of req) parts.push(c);
    const raw = Buffer.concat(parts).toString('utf8');
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ path: req.url, method: req.method, body });
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.url === '/api/me') return send(200, { user: { id: state.owner } });
    if (req.url === '/api/vaults' && req.method === 'GET') return send(200,
      { vaults: [...vaults.values()].map(v => ({ ...v, role: state.role })) });
    if (req.url === '/api/vaults' && req.method === 'POST') {
      assert.equal(req.headers['x-cascade-browser'], '1');
      assert.equal(req.headers.authorization, undefined);
      assert.deepEqual(body, { name: 'Along — shared wiki', visibility: 'private' });
      state.posts++;
      if (state.failWrite) return send(500, { error: 'SECRET' });
      const vault = { id: randomUUID(), name: body.name, role: 'owner' };
      vaults.set(vault.id, vault); return send(201, { vault });
    }
    const vaultPath = req.url.match(/^\/api\/vaults\/([^/]+)(\/members)?$/);
    if (vaultPath && req.method === 'GET' && vaults.has(vaultPath[1])) {
      assert.equal(req.headers.authorization, undefined);
      return send(200, vaultPath[2] ? { role: state.role, members: state.members } :
        { vault: { ...vaults.get(vaultPath[1]), created_by: state.creator,
          visibility: state.visibility }, role: state.role });
    }
    if (req.url === '/api/auth/agent-token') {
      assert.equal(req.headers['x-cascade-browser'], '1');
      assert.equal(req.method, 'POST'); return send(200, { token: 'fixture-agent-token' });
    }
    if (!req.headers.authorization) {
      assert.equal(req.headers['x-cascade-browser'], '1');
      state.folders ||= [];
      if (req.url === `/api/vaults/${vaultId}/folders`) {
        if (req.method === 'GET') return send(200, { folders: state.folders });
        state.posts++;
        const folder = { id: randomUUID(), vault_id: vaultId, ...body };
        state.folders.push(folder);
        if (state.failWrite) return send(500, {});
        return send(201, { folder });
      }
      if (req.url === `/api/vaults/${vaultId}/notes`) return send(200, { notes: [...notes.values()] });
      if (req.url.endsWith('/move')) {
        state.posts++;
        const n = notes.get(req.url.split('/')[3]);
        n.folder_id = body.folder_id;
        if (state.corrupt) n.content = 'corrupted';
        if (state.failWrite) return send(500, {});
        return send(200, { ok: true });
      }
      if (req.url.startsWith('/api/notes/')) {
        const note = notes.get(req.url.split('/').pop());
        if (req.method === 'PUT') {
          assert.deepEqual(Object.keys(body), ['content', 'expectedRevision']);
          if (body.expectedRevision !== note.revision) return send(409, {});
          state.posts++; note.content = state.corrupt ? 'corrupted' : body.content;
          if (state.failWrite) return send(500, {});
        }
        return send(200, { note });
      }
      assert.fail('unexpected browser route');
    }
    assert.equal(req.headers.authorization, 'Bearer fixture-agent-token');
    assert.equal(req.headers.cookie, undefined);
    if (req.method === 'GET' && req.url.endsWith('/messages-no-invoke-v1')) {
      if (state.unsupported) return send(404, { error: 'Not found' });
      return send(200, { contract: state.badCapability ? 'unknown' : 'messages_no_invoke_v1',
        actorUserId: 1, vaultId, channelId: req.url.split('/')[5] });
    }
    if (req.method === 'POST') {
      state.posts++;
      if (state.failWrite) return send(500, { error: 'SECRET upstream path' });
      if (req.url === `/api/vaults/${vaultId}/notes`) {
        assert.equal(body.is_listed, true);
        const note = { id: randomUUID(), vault_id: vaultId, title: body.title, content: body.content, is_listed: true };
        notes.set(note.id, note); return send(201, { note });
      }
      assert.equal(body.agentId, 'hermes'); assert.equal(body.registrationId, null);
      assert.equal(body.replyTo, null); assert.deepEqual(body.attachments, []);
      const channelId = req.url.split('/')[5];
      const message = { ...body, id: randomUUID(), channelId, actorUserId: 1 };
      assert.ok(req.url.endsWith('/messages-no-invoke-v1')); // No legacy send fallback.
      if (state.oldPost) return send(404, { error: 'Not found' });
      messages.set(message.id, message); return send(201, { contract: 'messages_no_invoke_v1', message, dispatches: [] });
    }
    if (req.url === `/api/vaults/${vaultId}/notes`) return send(200, { notes: [...notes.values()] });
    if (req.url.startsWith('/api/notes/')) return send(200, { note: notes.get(req.url.split('/').pop()) });
    if (req.url.includes('?limit=40')) return send(200, { messages: [...messages.values()] });
    const message = messages.get(req.url.split('/').pop());
    return send(200, { message: state.corrupt ? { ...message, agentId: null } : message });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => upstream.close(r)));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  const options = { enabled: true, directory, origin, vaultId, ownerId: 1, agentId: 'hermes', author: 'Along (AI agent)',
    allowFixtureHTTP: true, browserFetch: fetch, agentFetch: (url, init) => { assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error'); return fetch(url, init); } };
  let service = await startExternalAgentAccess(options);
  t.after(async () => { if (service) await service.close(); });
  return { directory, options, notes, messages, vaults, state, calls, call: p => request(service.socketPath, p),
    restart: async () => { await service.close(); service = await startExternalAgentAccess(options); } };
}
test('real Unix + HTTP: permissions, bounded create/list/read/history/send, agent attribution and durable replay', async t => {
  const f = await fixture(t);
  assert.equal(fs.statSync(path.join(f.directory, 'access.sock')).mode & 0o777, 0o600);
  const create = { op: 'createChannel', requestId: 'channel-1', title: 'Along · Fizzer usability' };
  const c = await f.call(create); assert.equal(c.status, 200); assert.equal(c.note.content, 'cascade://chat-channel');
  assert.deepEqual(await f.call(create), c); assert.equal(f.state.posts, 1);
  assert.equal((await f.call({ op: 'list' })).notes.length, 1);
  const { promisify } = require('node:util');
  const { execFile } = require('node:child_process');
  const cli = await promisify(execFile)(process.execPath, [path.join(__dirname, '../scripts/external-agent-client.cjs'),
    path.join(f.directory, 'access.sock'), JSON.stringify({ op: 'list' })]);
  assert.equal(JSON.parse(cli.stdout).notes[0].id, c.note.id);
  assert.equal((await f.call({ op: 'read', noteId: c.note.id })).note.id, c.note.id);
  const send = { op: 'send', requestId: 'message-1', channelId: c.note.id, body: 'I am Along, an AI agent. This is fixture content.' };
  f.state.unsupported = true;
  assert.equal((await f.call(send)).error, 'nonping_backend_unsupported');
  assert.equal(f.state.posts, 1);
  assert.equal(fs.readdirSync(path.join(f.directory, 'receipts')).length, 1);
  f.state.unsupported = false; f.state.badCapability = true;
  assert.equal((await f.call(send)).error, 'nonping_backend_unsupported');
  assert.equal(f.state.posts, 1); f.state.badCapability = false;
  const sent = await f.call(send); assert.equal(sent.status, 200);
  assert.equal(sent.message.actorUserId, 1); assert.equal(sent.message.agentId, 'hermes');
  assert.deepEqual(await f.call(send), sent); assert.equal(f.state.posts, 2);
  assert.equal((await f.call({ op: 'history', channelId: c.note.id })).messages.length, 1);
  await f.restart(); assert.deepEqual(await f.call(create), c);
  assert.deepEqual(await f.call(send), sent); assert.equal(f.state.posts, 2);
  f.state.corrupt = true;
  assert.equal((await f.call(send)).error, 'readback_mismatch'); f.state.corrupt = false;
  f.state.oldPost = true;
  const mixed = { ...send, requestId: 'mixed-version' };
  assert.equal((await f.call(mixed)).error, 'upstream_404');
  f.state.oldPost = false;
  assert.equal((await f.call(mixed)).error, 'uncertain_write');
  assert.equal(f.state.posts, 3);
  assert.equal((await f.call({ ...create, title: 'changed' })).error, 'idempotency_conflict');
  for (const name of fs.readdirSync(path.join(f.directory, 'receipts'))) {
    const file = path.join(f.directory, 'receipts', name);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /fixture-agent-token|fixture content/);
  }
});
test('fail closed: scope, arbitrary proxy, nonping, owner, readback and uncertain writes', async t => {
  const f = await fixture(t);
  for (const input of [{ op: 'fetch', url: 'https://evil.invalid' }, { op: 'list', vaultId: randomUUID() },
    { op: 'send', requestId: 'x', channelId: randomUUID(), body: '@agent hello' },
    { op: 'send', requestId: 'x', channelId: randomUUID(), body: '/compact' }]) assert.equal((await f.call(input)).status, 400);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.call({ op: 'read', noteId: '../secret' })).error, 'invalid_id');
  const foreign = randomUUID();
  assert.equal((await f.call({ op: 'read', noteId: foreign })).error, 'note_out_of_scope');
  assert.ok(!f.calls.some(c => c.path === `/api/notes/${foreign}`));
  f.state.owner = 2; assert.equal((await f.call({ op: 'list' })).error, 'owner_scope_mismatch'); f.state.owner = 1;
  f.state.role = 'editor'; assert.equal((await f.call({ op: 'list' })).error, 'owner_scope_mismatch'); f.state.role = 'owner';
  const c = await f.call({ op: 'createChannel', requestId: 'channel', title: 'Fixture' });
  f.notes.get(c.note.id).content = 'cascade://chat-channel?source=other';
  assert.equal((await f.call({ op: 'history', channelId: c.note.id })).error, 'note_out_of_scope');
  f.notes.get(c.note.id).content = 'cascade://chat-channel';
  f.notes.get(c.note.id).title = 'Renamed';
  assert.equal((await f.call({ op: 'createChannel', requestId: 'channel', title: 'Fixture' })).error, 'readback_mismatch');
  assert.equal(f.state.posts, 1);
  f.state.failWrite = true;
  const create = { op: 'createChannel', requestId: 'uncertain', title: 'Unknown' };
  assert.equal((await f.call(create)).error, 'upstream_500');
  await f.restart(); const count = f.state.posts;
  assert.equal((await f.call(create)).error, 'uncertain_write'); assert.equal(f.state.posts, count);
});
test('opt in, origin pin, endpoint collision and unsafe directory refusal', async t => {
  assert.equal(await startExternalAgentAccess({ enabled: false }), null);
  const f = await fixture(t);
  await assert.rejects(startExternalAgentAccess(f.options), /endpoint_exists/);
  await assert.rejects(startExternalAgentAccess({ ...f.options, origin: 'http://evil.invalid' }), /invalid_scope/);
  fs.chmodSync(f.directory, 0o755);
  await assert.rejects(startExternalAgentAccess(f.options), /unsafe_directory/);
  fs.chmodSync(f.directory, 0o700);
  const link = f.directory + '-link'; fs.symlinkSync(f.directory, link);
  try { await assert.rejects(startExternalAgentAccess({ ...f.options, directory: link }), /unsafe_directory/); }
  finally { fs.unlinkSync(link); }
});

test('private wiki: owner-only browser vault create, exact privacy readback and durable no-duplicate replay', async t => {
  const f = await fixture(t);
  const input = { op: 'createPrivateVault', requestId: 'wiki-vault' };
  const created = await f.call(input);
  assert.equal(created.status, 200);
  assert.equal(created.vault.name, 'Along — shared wiki');
  assert.equal(created.vault.visibility, 'private');
  assert.equal(created.vault.ownerId, 1);
  assert.deepEqual(created.vault.members, [{ userId: 1, role: 'owner' }]);
  await f.restart(); assert.deepEqual(await f.call(input), created);
  assert.equal(f.state.posts, 1);
  assert.equal((await f.call({ ...input, requestId: 'another' })).error, 'wiki_already_exists');
  f.state.visibility = 'public';
  assert.equal((await f.call(input)).error, 'private_vault_required');
  assert.equal(f.state.posts, 1);
  assert.ok(!f.calls.some(c => /messages|agents/.test(c.path)));
});

test('private wiki notes: privacy and full membership before POST, exact body, no chat route or replay', async t => {
  const f = await fixture(t);
  const input = { op: 'createNote', requestId: 'home', title: 'Home', content: '# Home\nMaintained by John and Along (AI).' };
  assert.equal((await f.call({ op: 'inspectPrivateVault' })).vault.visibility, 'private');
  for (const [key, invalid] of [['visibility', 'public'], ['creator', 2],
    ['members', [{ userId: 1, role: 'owner' }, { userId: 2, role: 'viewer' }]],
    ['members', []], ['members', [{ userId: 2, role: 'owner' }]],
    ['members', [{ userId: 1, role: 'editor' }]]]) {
    const old = f.state[key]; f.state[key] = invalid;
    assert.equal((await f.call(input)).error, 'private_vault_required');
    assert.equal(f.state.posts, 0); f.state[key] = old;
  }
  assert.equal(fs.readdirSync(path.join(f.directory, 'receipts')).length, 0);
  const created = await f.call(input);
  assert.equal(created.status, 200);
  assert.equal(created.note.content, input.content);
  const post = f.calls.findIndex(c => c.path.endsWith('/notes') && c.method === 'POST');
  assert.ok(f.calls.slice(0, post).some(c => c.path.endsWith('/members')));
  assert.deepEqual(await f.call({ op: 'read', noteId: created.note.id }), created);
  await f.restart(); assert.deepEqual(await f.call(input), created);
  assert.equal(f.state.posts, 1);
  f.notes.get(created.note.id).content = 'unexpected';
  assert.equal((await f.call(input)).error, 'readback_mismatch');
  assert.equal((await f.call({ ...input, requestId: 'channel', content: 'cascade://chat-channel' })).error, 'invalid_note_content');
  assert.equal(f.state.posts, 1);
  assert.ok(!f.calls.some(c => /messages|agents/.test(c.path)));
});

test('organization: real folders, reversible exact-content moves, private guard, no mint, durable uncertainty', async t => {
  const f = await fixture(t);
  const create = { op: 'createFolder', requestId: 'ideas', name: 'Ideas' };
  f.state.members.push({ userId: 2, role: 'viewer' });
  assert.equal((await f.call(create)).error, 'private_vault_required');
  assert.equal(f.state.posts, 0); f.state.members.pop();
  const made = await f.call(create); assert.equal(made.status, 200);
  assert.equal((await f.call({ ...create, requestId: 'duplicate' })).error, 'wiki_already_exists');
  await f.restart(); assert.deepEqual(await f.call(create), made); assert.equal(f.state.posts, 1);
  assert.equal((await f.call({ op: 'listFolders' })).folders.length, 1);
  const id = randomUUID(), content = '# Idea\nSources: exact ID';
  f.notes.set(id, { id, vault_id: vaultId, title: 'Idea', content, folder_id: null, is_listed: 1 });
  const move = { op: 'moveNote', requestId: 'move', noteId: id, folderId: made.folder.id, expectedFolderId: null,
    expectedContentHash: require('node:crypto').createHash('sha256').update(content).digest('hex') };
  assert.equal((await f.call({ ...move, folderId: randomUUID() })).error, 'note_out_of_scope');
  assert.equal((await f.call({ ...move, expectedContentHash: '0'.repeat(64) })).error, 'readback_mismatch');
  const moved = await f.call(move); assert.equal(moved.status, 200); assert.equal(moved.note.content, content);
  await f.restart(); assert.deepEqual(await f.call(move), moved); assert.equal(f.state.posts, 2);
  assert.equal((await f.call({ ...move, requestId: 'undo', expectedFolderId: made.folder.id, folderId: null })).status, 200);
  f.state.failWrite = true;
  assert.equal((await f.call({ ...move, requestId: 'uncertain' })).error, 'upstream_500');
  const count = f.state.posts; await f.restart(); f.state.failWrite = false;
  assert.equal((await f.call({ ...move, requestId: 'uncertain' })).error, 'uncertain_write');
  assert.equal(f.state.posts, count);
  f.state.corrupt = true;
  assert.equal((await f.call({ ...move, requestId: 'corrupt', expectedFolderId: made.folder.id, folderId: null })).error, 'readback_mismatch');
  assert.ok(!f.calls.some(c => /agent-token|messages|agents/.test(c.path)));
});

test('long wiki create and content-only update: exact bytes, guards, CSRF, durable uncertainty', async t => {
  const f = await fixture(t);
  const content = '界'.repeat(11000) + '\nSources: https://example.org';
  const create = { op: 'createNote', requestId: 'long', title: 'Reference', content };
  const made = await f.call(create); assert.equal(made.status, 200); assert.equal(made.note.content, content);
  assert.equal((await f.call({ ...create, requestId: 'oversize', content: 'x'.repeat(65537) })).error, 'invalid_note_content');
  const n = f.notes.get(made.note.id); n.folder_id = null; n.revision = 'note-v1:1';
  const update = { op: 'updateNote', requestId: 'editorial', noteId: n.id, content: content + '\nAn idea, directly explained.', expectedFolderId: null,
    expectedContentHash: require('node:crypto').createHash('sha256').update(content).digest('hex') };
  f.calls.length = 0;
  assert.equal((await f.call({ ...update, expectedContentHash: '0'.repeat(64) })).error, 'readback_mismatch');
  f.state.members.push({ userId: 2, role: 'viewer' });
  assert.equal((await f.call(update)).error, 'private_vault_required'); f.state.members.pop();
  assert.equal((await f.call({ ...update, content: 'cascade://chat-channel' })).error, 'invalid_note_content');
  const result = await f.call(update); assert.equal(result.status, 200);
  assert.equal(result.note.id, n.id); assert.equal(result.note.title, 'Reference'); assert.equal(result.note.content, update.content);
  await f.restart(); assert.deepEqual(await f.call(update), result); assert.equal(f.state.posts, 2);
  const next = { ...update, requestId: 'uncertain-edit', content: 'Revised\nSources: https://example.org',
    expectedContentHash: require('node:crypto').createHash('sha256').update(update.content).digest('hex') };
  f.state.failWrite = true; assert.equal((await f.call(next)).error, 'upstream_500');
  await f.restart(); f.state.failWrite = false;
  assert.equal((await f.call(next)).error, 'uncertain_write'); assert.equal(f.state.posts, 3);
  assert.equal(n.content, next.content);
  const corrupt = { ...next, requestId: 'corrupt-edit', expectedContentHash: require('node:crypto').createHash('sha256').update(next.content).digest('hex') };
  f.state.corrupt = true; assert.equal((await f.call(corrupt)).error, 'readback_mismatch');
  assert.ok(!f.calls.some(c => /agent-token|messages|agents/.test(c.path)));
});

test('private vault unknown result survives restart without a second POST', async t => {
  const f = await fixture(t); f.state.failWrite = true;
  const input = { op: 'createPrivateVault', requestId: 'uncertain-vault' };
  assert.equal((await f.call(input)).error, 'upstream_500');
  await f.restart(); f.state.failWrite = false;
  assert.equal((await f.call(input)).error, 'uncertain_write');
  assert.equal(f.state.posts, 1);
});
