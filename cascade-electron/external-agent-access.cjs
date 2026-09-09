'use strict';
// Opt-in private API. Never reuse or widen the loopback helper proxy.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CHANNEL = 'cascade://chat-channel';
const fail = code => { throw new Error(code); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function privateDirectory(dir) {
  if (!path.isAbsolute(dir) || path.resolve(dir) !== dir) fail('unsafe_directory');
  for (let p = dir; ; p = path.dirname(p)) {
    const s = fs.lstatSync(p);
    if (!s.isDirectory() || s.isSymbolicLink()) fail('unsafe_directory');
    // Permit root-owned sticky /tmp for isolated fixtures, not writable ancestors otherwise.
    if (p === dir ? s.uid !== process.getuid() || (s.mode & 0o777) !== 0o700
      : (s.mode & 0o022) && !(s.uid === 0 && (s.mode & 0o1000))) fail('unsafe_directory');
    if (p === path.dirname(p)) break;
  }
}
function durableWrite(file, value, exclusive = false) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT |
    fs.constants.O_NOFOLLOW | (exclusive ? fs.constants.O_EXCL : fs.constants.O_TRUNC), 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const d = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(d); } finally { fs.closeSync(d); }
}
async function boundedJSON(response) {
  if (!response.ok) fail(`upstream_${response.status}`);
  let size = 0; const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 1024 * 1024) fail('upstream_too_large');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks)); } catch { fail('upstream_invalid_json'); }
}
async function startExternalAgentAccess({ enabled, directory, origin, vaultId, ownerId,
  agentId, author, browserFetch, agentFetch, allowFixtureHTTP = false }) {
  if (!enabled) return null;
  const url = new URL(origin);
  if (url.origin !== origin || (url.protocol !== 'https:' &&
      !(allowFixtureHTTP && url.protocol === 'http:' && url.hostname === '127.0.0.1')) ||
      !UUID.test(vaultId) || !Number.isSafeInteger(ownerId) || ownerId < 1 ||
      agentId !== 'hermes' || author !== 'Along (AI agent)') fail('invalid_scope');
  privateDirectory(directory);
  const socketPath = path.join(directory, 'access.sock');
  if (fs.existsSync(socketPath)) fail('endpoint_exists');
  const receiptDir = path.join(directory, 'receipts');
  if (!fs.existsSync(receiptDir)) fs.mkdirSync(receiptDir, { mode: 0o700 });
  privateDirectory(receiptDir);
  const scope = { origin, vaultId, ownerId, agentId, author };
  const base = `/api/vaults/${vaultId}`;
  async function browser(route, method = 'GET', body) {
    return boundedJSON(await browserFetch(origin + route, { method, redirect: 'error',
      headers: { 'x-cascade-browser': '1', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) }));
  }
  async function privateVault(id) {
    checkId(id);
    const { vault, role } = await browser(`/api/vaults/${id}`);
    const membership = await browser(`/api/vaults/${id}/members`);
    if (vault?.id !== id || vault.visibility !== 'private' || vault.created_by !== ownerId ||
        role !== 'owner' || membership.role !== 'owner' || !Array.isArray(membership.members) ||
        membership.members.length !== 1 || membership.members[0].userId !== ownerId ||
        membership.members[0].role !== 'owner') fail('private_vault_required');
    return { id: vault.id, name: vault.name, visibility: vault.visibility, ownerId: vault.created_by,
      role, members: membership.members.map(m => ({ userId: m.userId, role: m.role })) };
  }
  async function authorize() {
    const me = await browser('/api/me');
    const vaults = await browser('/api/vaults');
    if (me.user?.id !== ownerId || !vaults.vaults?.some(v =>
      v.id === vaultId && v.role === 'owner')) fail('owner_scope_mismatch');
    const { token } = await browser('/api/auth/agent-token', 'POST');
    if (typeof token !== 'string' || !token) fail('agent_auth_unavailable');
    // Token exists only in this request closure. Cookie fallback is forbidden.
    return async (route, method = 'GET', body) => boundedJSON(await agentFetch(origin + route, {
      method, redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(10000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
  }
  function checkId(id) { if (typeof id !== 'string' || !UUID.test(id)) fail('invalid_id'); }
  const noteView = n => ({ id: n.id, vaultId: n.vault_id, title: n.title, content: n.content, listed: n.is_listed });
  const messageView = m => ({ id: m.id, channelId: m.channelId, author: m.author, body: m.body,
    actorUserId: m.actorUserId, agentId: m.agentId, registrationId: m.registrationId });
  async function note(api, id, channel = false) {
    checkId(id);
    // Check membership before an unscoped note GET; reject linked channel markers.
    const { notes } = await api(`${base}/notes`);
    if (!notes?.some(n => n.id === id)) fail('note_out_of_scope');
    const { note: n } = await api(`/api/notes/${id}`);
    if (n?.id !== id || n.vault_id !== vaultId || (channel && n.content !== CHANNEL)) fail('note_out_of_scope');
    return noteView(n);
  }
  async function execute(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_request');
    const fields = {
      list: ['op'], read: ['op', 'noteId'], history: ['op', 'channelId'],
      createChannel: ['op', 'requestId', 'title'], send: ['op', 'requestId', 'channelId', 'body'],
      inspectPrivateVault: ['op'], createPrivateVault: ['op', 'requestId'],
      createNote: ['op', 'requestId', 'title', 'content'],
    }[input.op];
    if (!fields || Object.keys(input).some(k => !fields.includes(k)) || fields.some(k => !(k in input))) fail('invalid_request');
    if (['createChannel', 'createNote'].includes(input.op) && (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 160)) fail('invalid_title');
    if (input.op === 'createNote' && (typeof input.content !== 'string' || !input.content.trim() ||
        input.content.length > 8000 || input.content.includes('cascade://'))) fail('invalid_note_content');
    if (input.op === 'send' && (typeof input.body !== 'string' || !input.body.trim() || input.body.length > 8000 || /@|\/compact/i.test(input.body))) fail('nonping_required');
    if (input.requestId !== undefined && !/^[A-Za-z0-9_-]{1,80}$/.test(input.requestId)) fail('invalid_request_id');
    const api = await authorize();
    if (input.op === 'inspectPrivateVault') return { vault: await privateVault(vaultId) };
    // Wiki text is admitted only after explicit privacy, immutable owner and full
    // single-member readback. Along uses John's existing session, not another member.
    if (input.op === 'createNote') await privateVault(vaultId);
    // Negotiate every send. The versioned POST route is also fail-safe across
    // mixed-version deployments; never fall back to legacy messages + a flag.
    const nonInvokeRoute = `${base}/channels/${input.channelId}/messages-no-invoke-v1`;
    if (input.op === 'send') {
      checkId(input.channelId);
      let capability;
      try { capability = await api(nonInvokeRoute); } catch { fail('nonping_backend_unsupported'); }
      if (capability.contract !== 'messages_no_invoke_v1' || capability.actorUserId !== ownerId ||
          capability.vaultId !== vaultId || capability.channelId !== input.channelId) fail('nonping_backend_unsupported');
    }
    if (input.op === 'list') {
      const { notes } = await api(`${base}/notes`);
      return { notes: notes.map(n => ({ id: n.id, title: n.title })) };
    }
    if (input.op === 'read') return { note: await note(api, input.noteId) };
    if (input.channelId) await note(api, input.channelId, true);
    if (input.op === 'history') {
      const { messages } = await api(`${base}/channels/${input.channelId}/messages?limit=40`);
      if (!Array.isArray(messages) || messages.some(m => m.channelId !== input.channelId)) fail('readback_mismatch');
      return { messages: messages.map(messageView) };
    }
    const file = path.join(receiptDir, hash({ scope, requestId: input.requestId }) + '.json');
    const digest = hash(input);
    let receipt;
    if (fs.existsSync(file)) {
      const s = fs.lstatSync(file);
      if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o600) fail('unsafe_receipt');
      try { receipt = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('uncertain_write'); }
      if (receipt.digest !== digest) fail('idempotency_conflict');
      if (!receipt.id) fail('uncertain_write');
    } else {
      if (input.op === 'createPrivateVault') {
        const { vaults } = await browser('/api/vaults');
        if (!Array.isArray(vaults)) fail('readback_mismatch');
        if (vaults.some(v => v.name === 'Along — shared wiki')) fail('wiki_already_exists');
      }
      if (fs.readdirSync(receiptDir).length >= 1000) fail('receipt_limit');
      receipt = { digest };
      durableWrite(file, receipt, true); // Persist intent BEFORE a network write. Never automatically replay uncertainty.
      let result;
      if (input.op === 'createPrivateVault') {
        // Vault creation is user-only upstream: use normal Chromium session/CSRF,
        // never the restricted agent bearer or a widened generic proxy.
        result = (await browser('/api/vaults', 'POST', { name: 'Along — shared wiki', visibility: 'private' })).vault;
      } else if (['createChannel', 'createNote'].includes(input.op)) {
        result = (await api(`${base}/notes`, 'POST', { title: input.title,
          content: input.op === 'createChannel' ? CHANNEL : input.content, is_listed: true })).note;
      } else {
        const response = await api(nonInvokeRoute, 'POST', {
          body: input.body, author, agentId, registrationId: null, status: 'completed', replyTo: null,
          images: [], attachments: [], blocks: null, runId: null,
        });
        if (response.contract !== 'messages_no_invoke_v1') fail('readback_mismatch');
        result = response.message;
        if (!Array.isArray(response.dispatches) || response.dispatches.length) fail('unexpected_dispatch');
      }
      checkId(result?.id);
      receipt.id = result.id;
      durableWrite(file, receipt);
    }
    if (input.op === 'createPrivateVault') {
      const vault = await privateVault(receipt.id);
      if (vault.name !== 'Along — shared wiki') fail('readback_mismatch');
      return { vault };
    }
    if (['createChannel', 'createNote'].includes(input.op)) {
      const n = await note(api, receipt.id, input.op === 'createChannel');
      if (n.title !== input.title || !n.listed ||
          (input.op === 'createNote' && n.content !== input.content)) fail('readback_mismatch');
      if (input.op === 'createNote') await privateVault(vaultId);
      return { note: n };
    }
    const { message: m } = await api(`${base}/channels/${input.channelId}/messages/${receipt.id}`);
    if (!m || m.id !== receipt.id || m.channelId !== input.channelId || m.body !== input.body ||
      m.actorUserId !== ownerId || m.agentId !== agentId || m.author !== author || m.registrationId != null) fail('readback_mismatch');
    return { message: messageView(m) };
  }
  let busy = false;
  const server = http.createServer(async (req, res) => {
    const reply = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.method !== 'POST' || req.url !== '/v1' || req.headers.origin || req.headers.authorization || req.headers.cookie) return reply(403, { error: 'local_protocol_only' });
    if (busy) return reply(409, { error: 'busy' });
    busy = true;
    try {
      let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 16384) fail('request_too_large'); }
      let input; try { input = JSON.parse(body); } catch { fail('invalid_json'); }
      reply(200, await execute(input));
    } catch (error) {
      // Fixed vocabulary only: no upstream bodies, tokens, paths, or exception strings.
      const code = /^(upstream_\d{3}|upstream_too_large|upstream_invalid_json|owner_scope_mismatch|agent_auth_unavailable|invalid_id|note_out_of_scope|invalid_request|invalid_title|invalid_note_content|private_vault_required|wiki_already_exists|nonping_required|nonping_backend_unsupported|invalid_request_id|readback_mismatch|unsafe_receipt|uncertain_write|idempotency_conflict|receipt_limit|unexpected_dispatch|request_too_large|invalid_json)$/.test(error.message) ? error.message : 'operation_failed';
      reply(400, { error: code });
    } finally { busy = false; }
  });
  server.requestTimeout = 15000; server.headersTimeout = 15000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  fs.chmodSync(socketPath, 0o600);
  return { socketPath, close: () => new Promise(resolve => server.close(resolve)) };
}
function request(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, agent: false, path: '/v1', method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
      let data = ''; res.on('data', c => { data += c; if (data.length > 1024 * 1024) req.destroy(new Error('response_too_large')); });
      res.on('end', () => { try { resolve({ status: res.statusCode, ...JSON.parse(data) }); } catch { reject(new Error('invalid_response')); } });
    });
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    req.on('error', reject); req.end(JSON.stringify(payload));
  });
}
module.exports = { startExternalAgentAccess, request };
