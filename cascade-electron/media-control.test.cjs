'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomUUID, randomBytes } = require('node:crypto');
const { startExternalAgentAccess, request } = require('./external-agent-access.cjs');
const { png } = require('./media-control.cjs');
const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fizzer-media-')); fs.chmodSync(directory, 0o700);
  const vaultId = randomUUID(), configuredVaultId = randomUUID(), channelId = randomUUID();
  const state = { owner: 1, role: 'owner', unsupported: false, uploads: 0, posts: 0, calls: [], assets: new Map(), messages: new Map() };
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : null; state.calls.push([req.method, req.url]);
    const send = (code, value) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.headers.authorization) { assert.equal(req.headers.authorization, 'Bearer fixture'); assert.equal(req.headers.cookie, undefined); }
    else assert.equal(req.headers['x-cascade-browser'], '1');
    if (req.url === '/api/me') return send(200, { user: { id: state.owner } });
    if (req.url === '/api/vaults') return send(200, { vaults: [{ id: vaultId, role: state.role }, { id: configuredVaultId, role: state.role }] });
    if (req.url === '/api/auth/agent-token') { assert.equal(req.method, 'POST'); assert.equal(req.headers.authorization, undefined); return send(200, { token: 'fixture' }); }
    if (req.url === `/api/vaults/${vaultId}/notes`) return send(200, { notes: [{ id: channelId }] });
    if (req.url === `/api/notes/${channelId}`) return send(200, { note: { id: channelId, vault_id: vaultId, content: 'cascade://chat-channel' } });
    if (req.url === `/api/notes/${channelId}/assets`) {
      assert.equal(req.headers.authorization, undefined); assert.equal(req.method, 'POST');
      assert.deepEqual(Object.keys(body).sort(), ['data', 'media_type']); assert.equal(body.media_type, 'image/png');
      state.uploads++; const asset_id = randomBytes(12).toString('base64url');
      const url = `/api/notes/${channelId}/assets/${asset_id}`; state.assets.set(url, Buffer.from(body.data, 'base64'));
      if (state.loseUpload) return send(500, {});
      return send(201, { asset_id, url, filename: asset_id + '.png' });
    }
    if (state.assets.has(req.url)) {
      assert.equal(req.method, 'GET'); res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(state.corruptAsset ? Buffer.from('corrupt') : state.assets.get(req.url));
    }
    if (req.url.endsWith('/messages-no-invoke-v1')) {
      assert.equal(req.headers.authorization, 'Bearer fixture');
      if (req.method === 'GET') return send(200, { contract: 'messages_no_invoke_v1', mediaContract: state.unsupported ? null : 'channel_png_assets_v1', actorUserId: 1, vaultId, channelId });
      state.posts++; assert.equal(body.replyTo, null); assert.equal(body.runId, null); assert.equal(body.blocks, null); assert.equal(body.status, 'completed');
      assert.deepEqual(body.attachments, []); assert.ok(body.images.every(i => state.assets.has(i.url)));
      const message = { ...body, id: randomUUID(), actorUserId: 1, channelId }; state.messages.set(message.id, message);
      if (state.loseSend) return send(500, {});
      return send(201, { contract: 'messages_no_invoke_v1', message, dispatches: [] });
    }
    const message = state.messages.get(req.url.split('/').pop());
    if (message) {
      if (state.loseReadback) return send(500, {});
      return send(200, { message: state.corruptMessage ? { ...message, images: [] } : message });
    }
    return send(404, {});
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const options = { enabled: true, directory, origin: `http://127.0.0.1:${upstream.address().port}`, vaultId: configuredVaultId, ownerId: 1,
    agentId: 'hermes', author: 'Along (AI agent)', browserFetch: fetch, agentFetch: fetch, allowFixtureHTTP: true };
  let service = await startExternalAgentAccess(options);
  t.after(async () => { await service.close(); await new Promise(r => upstream.close(r)); fs.rmSync(directory, { recursive: true }); });
  return { state, directory, vaultId, channelId, call: p => request(service.socketPath, p), restart: async () => { await service.close(); service = await startExternalAgentAccess(options); } };
}
const upload = f => ({ op: 'mediaUpload', mode: 'apply', requestId: 'upload', vaultId: f.vaultId, channelId: f.channelId, name: 'fixture.png', data });
const send = f => ({ op: 'mediaSend', mode: 'apply', requestId: 'send', vaultId: f.vaultId, channelId: f.channelId, body: 'Along (AI agent): fixture.', uploads: ['upload'] });
test('real private socket to HTTP: upload, bearer no-invoke send, byte readback and restart reconciliation', async t => {
  const f = await fixture(t); assert.equal(png(data).width, 1);
  assert.equal((await f.call({ op: 'mediaCapabilities' })).contract, 'fizzer_media_control_v1');
  const u = await f.call(upload(f)); assert.equal(u.status, 200, JSON.stringify(u));
  assert.equal(u.upload.size, Buffer.from(data, 'base64').length);
  const s = await f.call(send(f)); assert.equal(s.status, 200, JSON.stringify(s)); assert.equal(s.message.images.length, 1);
  await f.restart();
  assert.deepEqual(await f.call({ ...upload(f), mode: 'reconcile' }), u);
  assert.deepEqual(await f.call({ ...send(f), mode: 'reconcile' }), s);
  assert.deepEqual(await f.call(send(f)), s); assert.equal(f.state.uploads, 1); assert.equal(f.state.posts, 1);
  f.state.corruptAsset = true; assert.equal((await f.call(send(f))).error, 'readback_mismatch'); f.state.corruptAsset = false;
  f.state.corruptMessage = true; assert.equal((await f.call(send(f))).error, 'readback_mismatch');
  assert.equal((await f.call({ ...send(f), body: 'Changed' })).error, 'idempotency_conflict');
  assert.ok(!f.state.calls.some(([, route]) => /agents|runs|dispatch/.test(route)));
});
test('explicit-vault text-only send uses no upload, retains scope and reconciles exact durable ID', async t => {
  const f = await fixture(t);
  const s = { ...send(f), uploads: [] };
  const caps = await f.call({ op: 'mediaCapabilities' });
  assert.equal(caps.textOnly, true); assert.equal(caps.minImages, 0);
  assert.equal((await f.call({ ...s, mode: 'reconcile' })).error, 'intent_not_found');
  assert.equal((await f.call({ ...s, vaultId: randomUUID() })).error, 'owner_scope_mismatch');
  assert.equal((await f.call({ ...s, channelId: randomUUID() })).error, 'note_out_of_scope');
  f.state.unsupported = true;
  assert.equal((await f.call(s)).error, 'nonping_backend_unsupported'); f.state.unsupported = false;
  for (const body of ['', ' ', '@agent', '/compact', 'x'.repeat(8001)])
    assert.equal((await f.call({ ...s, body })).error, 'invalid_request');
  assert.equal(f.state.posts, 0);
  f.state.loseReadback = true;
  assert.equal((await f.call(s)).error, 'upstream_500');
  await f.restart(); f.state.loseReadback = false;
  const result = await f.call({ ...s, mode: 'reconcile' });
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.message.id, [...f.state.messages.keys()][0]);
  assert.equal(result.message.body, s.body); assert.equal(result.message.channelId, f.channelId);
  assert.deepEqual(result.message.images, []); assert.deepEqual(result.verifiedUploads, []);
  assert.deepEqual(await f.call(s), result);
  assert.equal((await f.call({ ...s, body: 'Changed' })).error, 'idempotency_conflict');
  assert.equal(f.state.posts, 1); assert.equal(f.state.uploads, 0);
  assert.ok(!f.state.calls.some(([, route]) => /assets|agents|runs|dispatch/.test(route)));
  assert.ok(f.state.calls.filter(([method]) => method === 'POST').every(([, route]) =>
    route === '/api/auth/agent-token' || route === `/api/vaults/${f.vaultId}/channels/${f.channelId}/messages-no-invoke-v1`));
});
test('lost text-only POST response remains unknown without replay after restart', async t => {
  const f = await fixture(t); const s = { ...send(f), uploads: [] };
  f.state.loseSend = true;
  assert.equal((await f.call(s)).error, 'upstream_500');
  await f.restart(); f.state.loseSend = false;
  assert.equal((await f.call({ ...s, mode: 'reconcile' })).error, 'uncertain_write');
  assert.equal((await f.call(s)).error, 'uncertain_write');
  assert.equal(f.state.posts, 1); assert.equal(f.state.uploads, 0);
});
test('invalid files, permission and capability refusals precede mutation', async t => {
  const f = await fixture(t);
  for (const change of [{ data: 'garbage' }, { data: data.slice(0, -4) }, { name: '../file.png' }, { data: Buffer.from('svg').toString('base64') }])
    assert.equal((await f.call({ ...upload(f), ...change })).error, 'invalid_media');
  assert.equal(f.state.calls.length, 0);
  f.state.unsupported = true; assert.equal((await f.call(upload(f))).error, 'nonping_backend_unsupported'); f.state.unsupported = false;
  f.state.role = 'viewer'; assert.equal((await f.call(upload(f))).error, 'owner_scope_mismatch'); f.state.role = 'owner';
  f.state.owner = 2; assert.equal((await f.call(upload(f))).error, 'owner_scope_mismatch'); f.state.owner = 1;
  assert.equal((await f.call({ ...upload(f), channelId: randomUUID() })).error, 'note_out_of_scope');
  assert.equal((await f.call({ ...upload(f), vaultId: randomUUID() })).error, 'owner_scope_mismatch');
  assert.equal((await f.call({ ...send(f), mode: 'reconcile' })).error, 'intent_not_found');
  assert.equal(f.state.uploads, 0); assert.equal(f.state.posts, 0);
});
test('lost upload and lost message responses never replay, including after restart', async t => {
  const f = await fixture(t); f.state.loseUpload = true;
  assert.equal((await f.call(upload(f))).error, 'upstream_500'); await f.restart(); f.state.loseUpload = false;
  assert.equal((await f.call(upload(f))).error, 'uncertain_write'); assert.equal(f.state.uploads, 1);
  assert.equal((await f.call({ ...upload(f), requestId: 'second' })).status, 200);
  f.state.loseSend = true; const s = { ...send(f), uploads: ['second'] };
  assert.equal((await f.call(s)).error, 'upstream_500'); await f.restart(); f.state.loseSend = false;
  assert.equal((await f.call(s)).error, 'uncertain_write'); assert.equal(f.state.posts, 1);
  for (const file of fs.readdirSync(path.join(f.directory, 'receipts'))) {
    const text = fs.readFileSync(path.join(f.directory, 'receipts', file), 'utf8');
    assert.ok(!text.includes(data)); assert.ok(!text.includes('Bearer')); assert.ok(!text.includes(s.body));
  }
});
