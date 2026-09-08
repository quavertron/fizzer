'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startLocalAgentSetup, FLAGS, UPSTREAM } = require('./local-agent-setup.cjs');
const INPUT = { vaultId: '21b2b809-6f53-4e41-9a58-fe30762d3657', ownerUserId: 1,
  displayName: 'Along', mention: 'along', profile: 'along', cwd: '/home/jt/projects/along', model: 'gpt-6-astra', flags: FLAGS };
async function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.homedir(), '.setup-test-'));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const state = { agents: [], notes: [], members: [], writes: [], calls: [], ...overrides };
  const root = '/api/vaults/' + INPUT.vaultId;
  const upstream = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : null;
    state.calls.push([req.method, req.url]);
    if (state.rejectChannel && req.url === root + '/notes' && req.method === 'POST') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: state.rejectChannel })); return;
    }
    if (state.redirect) { res.writeHead(302, { Location: 'https://invalid.example/forbidden' }); res.end(); return; }
    if (req.method !== 'GET') state.writes.push([req.method, req.url, body]);
    assert.equal(req.headers['x-cascade-browser'], '1');
    let result;
    if (req.url === '/api/me') result = { user: { id: state.owner ?? 1 } };
    else if (req.url === '/api/vaults') result = { vaults: [{ id: INPUT.vaultId, role: 'owner', memberCount: state.memberCount ?? 1, name: 'My Vault' }] };
    else if (req.url === root + '/vault-agents' && req.method === 'GET') result = { agents: state.agents };
    else if (req.url === root + '/vault-agents' && req.method === 'PUT') {
      const agent = { ...body, id: 'identity-1', ownerUserId: 1 };
      state.agents.push(agent); result = { agent };
    } else if (req.url === root + '/vault-agents/identity-1') result = { agent: state.agents[0] };
    else if (req.url === root + '/notes' && req.method === 'GET') result = { notes: state.notes };
    else if (req.url === root + '/notes' && req.method === 'POST') {
      const note = { ...body, id: 'channel-1', content_preview: body.content };
      state.notes.push(note); result = { note };
    } else if (req.url === '/api/notes/channel-1') result = { note: state.notes[0] };
    else if (req.url === root + '/channels/channel-1/agents') result = { agents: state.members };
    else if (req.url === root + '/channels/channel-1/agents/from-vault') {
      const member = { ...state.agents[0], ...body, id: 'registration-1', ...state.badReadback };
      state.members = [member]; result = { registration: member };
    } else { res.writeHead(404); res.end('{}'); return; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); }));
  const fetchFixture = (url, init) => {
    assert.equal(new URL(url).origin, UPSTREAM);
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'include');
    assert.equal(init.headers.Authorization, undefined);
    return fetch(`http://127.0.0.1:${upstream.address().port}${new URL(url).pathname}`, init);
  };
  const service = await startLocalAgentSetup({ fetch: fetchFixture, directory });
  t.after(() => service.close());
  return { ...service, directory, state, fetchFixture };
}
function rpc(socketPath, { method = 'POST', route = '/v1/register-hermes', headers = {}, body = INPUT } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, agent: false, method, path: route, headers: { Host: 'localhost', 'Content-Type': 'application/json', ...headers } }, res => {
      let text = ''; res.on('data', c => text += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    request.on('error', reject); request.end(JSON.stringify(body));
  });
}
test('private real socket + HTTP fixture: exact readback and idempotent identity/channel/registration', async t => {
  const f = await fixture(t);
  assert.equal(fs.statSync(f.directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(f.socketPath).mode & 0o777, 0o600);
  const first = await rpc(f.socketPath); assert.equal(first.status, 200);
  const second = await rpc(f.socketPath); assert.deepEqual(second, first);
  assert.equal(first.body.agent_id, 'identity-1'); assert.equal(first.body.channel_id, 'channel-1');
  assert.equal(first.body.registration_id, 'registration-1'); assert.deepEqual(first.body.flags, FLAGS);
  assert.equal(f.state.agents.length, 1); assert.equal(f.state.notes.length, 1); assert.equal(f.state.members.length, 1);
  assert.equal(f.state.writes.filter(([m]) => m === 'PUT').length, 1);
  assert.equal(f.state.calls.some(([, r]) => /messages|runs|chat$/.test(r)), false);
  assert.equal(first.body.messages_sent, false);
});
test('forbidden methods/routes, browser cross-origin headers and arbitrary URL fields never reach upstream', async t => {
  const f = await fixture(t);
  for (const opts of [{ method: 'GET' }, { method: 'OPTIONS' }, { route: '/api/me' },
    { route: 'https://evil.invalid/api/me' }, { route: '//evil.invalid/' }, { route: '/v1/register-hermes?url=x' },
    { headers: { Origin: 'https://evil.invalid' } }, { headers: { 'Sec-Fetch-Site': 'cross-site' } },
    { headers: { Authorization: 'not-a-real-credential' } }, { headers: { Cookie: 'fixture' } },
    { headers: { Host: 'evil.invalid' } }]) assert.equal((await rpc(f.socketPath, opts)).status, 403);
  for (const body of [{ ...INPUT, url: 'https://evil.invalid' }, { ...INPUT, vaultId: '../other' },
    { ...INPUT, flags: { ...FLAGS, yolo: true } }, { ...INPUT, flags: {} }, { ...INPUT, cwd: 'relative' },
    { ...INPUT, displayName: 'x'.repeat(5000) }]) assert.equal((await rpc(f.socketPath, { body })).status, 400);
  assert.equal(f.state.calls.length, 0);
});
test('partial setup reports only fixed diagnostics and preserves identity on retry', async t => {
  const f = await fixture(t, { rejectChannel: 'permission denied: /private/secret-token' });
  const first = await rpc(f.socketPath);
  assert.equal(first.status, 400);
  assert.equal(first.body.stage, 'channel-create');
  assert.equal(first.body.upstream_status, 400);
  assert.equal(first.body.category, 'filesystem-permission');
  assert.equal(JSON.stringify(first).includes('secret-token'), false);
  assert.equal(f.state.agents.length, 1);
  assert.equal(f.state.notes.length, 0);
  f.state.rejectChannel = false;
  const retry = await rpc(f.socketPath);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.agent_id, f.state.agents[0].id);
  assert.equal(f.state.agents.length, 1);
});
test('authoritative account/private-vault preflight prevents all writes', async t => {
  for (const overrides of [{ owner: 2 }, { memberCount: 2 }, { memberCount: 0 }]) {
    const f = await fixture(t, overrides);
    assert.equal((await rpc(f.socketPath)).status, 400); assert.equal(f.state.writes.length, 0);
  }
});
test('existing unrelated identity is refused; persisted flags must match', async t => {
  const conflict = await fixture(t, { agents: [{ mention: 'along', ownerUserId: 2 }] });
  assert.equal((await rpc(conflict.socketPath)).status, 400); assert.equal(conflict.state.writes.length, 0);
  const wrong = await fixture(t, { badReadback: { yolo: true } });
  assert.equal((await rpc(wrong.socketPath)).status, 400);
});
test('redirects are refused without following another origin', async t => {
  const f = await fixture(t, { redirect: true });
  assert.equal((await rpc(f.socketPath)).status, 400);
  assert.deepEqual(f.state.calls, [['GET', '/api/me']]);
  assert.equal(f.state.writes.length, 0);
});
test('concurrent setup is serialized rather than duplicating identities', async t => {
  const f = await fixture(t);
  const results = await Promise.all([rpc(f.socketPath), rpc(f.socketPath)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal(f.state.agents.length, 1);
});
test('live endpoint is never replaced; unsafe directory, socket permissions and symlinks fail closed', async t => {
  const f = await fixture(t);
  await assert.rejects(startLocalAgentSetup({ fetch: f.fetchFixture, directory: f.directory }), /already exists/);
  assert.equal((await rpc(f.socketPath)).status, 200);
  fs.chmodSync(f.socketPath, 0o666);
  assert.equal((await rpc(f.socketPath)).status, 400);
  fs.chmodSync(f.socketPath, 0o600);
  fs.chmodSync(f.directory, 0o755);
  await assert.rejects(startLocalAgentSetup({ fetch: f.fetchFixture, directory: f.directory }));
  assert.equal((await rpc(f.socketPath)).status, 400);
  fs.chmodSync(f.directory, 0o700);
  const link = f.directory + '-link'; fs.symlinkSync(f.directory, link);
  t.after(() => fs.unlinkSync(link));
  await assert.rejects(startLocalAgentSetup({ fetch: f.fetchFixture, directory: link }));
  await assert.rejects(startLocalAgentSetup({ fetch: f.fetchFixture, directory: '/tmp/fizzer-unsafe-fixture' }));
});
test('existing regular file or symlink socket is never removed', async t => {
  for (const symbolic of [false, true]) {
    const directory = fs.mkdtempSync(path.join(os.homedir(), '.setup-file-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sock = path.join(directory, 'setup.sock');
    if (symbolic) fs.symlinkSync('/dev/null', sock); else fs.writeFileSync(sock, 'preserve');
    await assert.rejects(startLocalAgentSetup({ directory, fetch: () => assert.fail('unexpected fetch') }));
    assert.equal(fs.lstatSync(sock).isSymbolicLink(), symbolic);
    if (!symbolic) assert.equal(fs.readFileSync(sock, 'utf8'), 'preserve');
  }
});
