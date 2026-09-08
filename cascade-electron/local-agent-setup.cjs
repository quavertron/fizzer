'use strict';
// Private local setup RPC, deliberately NOT an HTTP/API proxy.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const UPSTREAM = 'https://cscd.online';
const FLAGS = Object.freeze({ pingableByOthers: false, taggableByAgents: false,
  replyToEveryMessage: false, orchestrator: false, ambientGroupChat: false,
  nextStepSuggestions: false, finalReplyOnly: true, yolo: false });
const ID = /^[A-Za-z0-9_-]{1,80}$/;
function requireThat(ok) { if (!ok) throw new Error('Setup validation failed'); }
function validateInput(input) {
  requireThat(input && typeof input === 'object' && !Array.isArray(input));
  const keys = ['vaultId', 'ownerUserId', 'displayName', 'mention', 'profile', 'cwd', 'model', 'flags'];
  requireThat(Object.keys(input).length === keys.length && keys.every(k => Object.hasOwn(input, k)));
  requireThat(typeof input.ownerUserId === 'number' && Number.isSafeInteger(input.ownerUserId) && input.ownerUserId > 0);
  requireThat(typeof input.vaultId === 'string' && ID.test(input.vaultId) && typeof input.mention === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(input.mention));
  requireThat(typeof input.profile === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(input.profile));
  requireThat(['displayName', 'model', 'cwd'].every(k => typeof input[k] === 'string' && input[k].length > 0 && input[k].length <= 256 && !/[\x00-\x1f]/.test(input[k])));
  requireThat(path.isAbsolute(input.cwd));
  requireThat(input.flags && Object.keys(input.flags).length === Object.keys(FLAGS).length && Object.entries(FLAGS).every(([k,v]) => input.flags[k] === v));
}
class SetupFailure extends Error {
  constructor(stage, status, category) {
    super('Setup refused or incomplete');
    this.stage = stage;
    if (Number.isInteger(status)) this.upstream_status = status;
    if (category) this.category = category;
  }
}
async function registerHermes(fetch, input) {
  let stage = 'input';
  try {
  validateInput(input);
  async function api(method, route, body) {
    const response = await fetch(UPSTREAM + route, { method, redirect: 'error',
      credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Cascade-Browser': '1' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
    if (!response.ok) {
      // Never forward upstream exception messages: they can contain paths or secrets.
      let category = 'upstream-rejection';
      try {
        const value = await response.json();
        const message = typeof value.error === 'string' ? value.error : '';
        for (const [name, pattern] of [
          ['filesystem-permission', /permission denied|eacces|read-only file system/i],
          ['filesystem-missing', /no such file or directory|enoent/i],
          ['database-constraint', /constraint|unique constraint|foreign key/i],
          ['database-schema', /no such column|no such table/i],
          ['backend-function', /undefined function|function clause|no function clause/i],
          ['backend-match', /no match of right hand side/i],
        ]) if (pattern.test(message)) { category = name; break; }
      } catch { /* retain fixed category */ }
      throw new SetupFailure(stage, response.status, category);
    }
    return response.json();
  }
  stage = 'account';
  const me = await api('GET', '/api/me');
  requireThat((me.user || me).id === input.ownerUserId);
  stage = 'vault';
  const { vaults } = await api('GET', '/api/vaults');
  const vault = vaults.find(v => v.id === input.vaultId);
  requireThat(vault && vault.role === 'owner' && vault.memberCount === 1);
  const root = '/api/vaults/' + input.vaultId;
  const exactId = value => { requireThat(typeof value === 'string' && ID.test(value)); return value; };
  function checkIdentity(a) {
    requireThat(a && a.ownerUserId === input.ownerUserId && a.agentId === 'hermes' &&
      a.hermesProfile === input.profile && a.mention === input.mention && a.cwd === input.cwd &&
      a.model === input.model && a.displayName === input.displayName && a.hermesSafeMode === false);
    exactId(a.id);
  }
  stage = 'identity-list';
  const { agents } = await api('GET', root + '/vault-agents');
  const matches = agents.filter(a => a.mention === input.mention);
  requireThat(matches.length <= 1);
  let identity = matches[0];
  if (identity) checkIdentity(identity);
  else {
    stage = 'identity-create';
    identity = (await api('PUT', root + '/vault-agents', { agentId: 'hermes',
      displayName: input.displayName, mention: input.mention, hermesProfile: input.profile,
      hermesSafeMode: false, model: input.model, cwd: input.cwd,
      contextPrompt: 'Connect to the existing owner-controlled Hermes profile session; do not start a separate session.' })).agent;
  }
  stage = 'identity-readback';
  const identityId = exactId(identity.id);
  identity = (await api('GET', root + '/vault-agents/' + identityId)).agent;
  checkIdentity(identity);
  requireThat(identity.id === identityId);
  stage = 'channel-list';
  const { notes } = await api('GET', root + '/notes');
  const channels = notes.filter(n => n.title === input.mention && n.content_preview === 'cascade://chat-channel');
  requireThat(channels.length <= 1);
  let channel = channels[0];
  stage = 'channel-create';
  if (!channel) channel = (await api('POST', root + '/notes', { title: input.mention, content: 'cascade://chat-channel' })).note;
  stage = 'channel-readback';
  const channelId = exactId(channel.id);
  channel = (await api('GET', '/api/notes/' + channelId)).note;
  requireThat(channel.id === channelId && channel.title === input.mention && channel.content === 'cascade://chat-channel');
  const route = root + '/channels/' + channelId + '/agents';
  stage = 'membership-list';
  const before = (await api('GET', route)).agents.filter(a => a.vaultAgentId === identityId);
  requireThat(before.length <= 1);
  if (before[0]) requireThat(before[0].ownerUserId === input.ownerUserId);
  stage = 'membership-write';
  const written = (await api('POST', route + '/from-vault', { vaultAgentId: identityId, ...FLAGS })).registration;
  stage = 'membership-readback';
  const writtenId = exactId(written.id);
  const members = (await api('GET', route)).agents.filter(a => a.vaultAgentId === identityId);
  requireThat(members.length === 1);
  const member = members[0];
  requireThat(member.ownerUserId === input.ownerUserId && member.hermesProfile === input.profile && member.agentId === 'hermes');
  requireThat(Object.entries(FLAGS).every(([k,v]) => member[k] === v));
  const registrationId = exactId(member.id);
  requireThat(registrationId === writtenId);
  if (before[0]) requireThat(registrationId === before[0].id);
  return { vault_id: vault.id, vault_name: vault.name, channel_id: channelId, channel_name: channel.title,
    agent_id: identityId, registration_id: registrationId, owner_user_id: input.ownerUserId,
    flags: FLAGS, scope: 'vault-wide identity; verified flags apply to returned channel membership', messages_sent: false };
  } catch (error) {
    throw error instanceof SetupFailure ? error : new SetupFailure(stage);
  }
}
// Every component must be real and not writable by another user. Never follow
// symlinks or unlink an existing endpoint (it may belong to a live desktop).
function validateParents(directory) {
  requireThat(path.isAbsolute(directory) && path.resolve(directory) === directory);
  let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split('/').filter(Boolean)) {
    current = path.join(current, part);
    const st = fs.lstatSync(current);
    requireThat(st.isDirectory() && !st.isSymbolicLink() && [0, process.getuid()].includes(st.uid) && (st.mode & 0o022) === 0);
  }
  const st = fs.lstatSync(directory);
  requireThat(st.uid === process.getuid() && (st.mode & 0o777) === 0o700);
}
async function startLocalAgentSetup({ fetch, directory = path.join(os.homedir(), '.cascade', 'agent-setup') }) {
  requireThat(typeof process.getuid === 'function' && typeof fetch === 'function');
  requireThat(path.isAbsolute(directory) && path.resolve(directory) === directory);
  const parent = path.dirname(directory);
  // Existing home/.cascade must already be a safe directory; only create our own leaf.
  if (!fs.existsSync(directory)) {
    // Validate ancestor chain before creating anything.
    const st = fs.lstatSync(parent);
    requireThat(st.isDirectory() && !st.isSymbolicLink());
    // Use the same traversal checks without imposing 0700 on the ancestor.
    for (let p = parent; ; p = path.dirname(p)) {
      const s = fs.lstatSync(p);
      requireThat(s.isDirectory() && !s.isSymbolicLink() && [0, process.getuid()].includes(s.uid) && (s.mode & 0o022) === 0);
      if (p === path.dirname(p)) break;
    }
    fs.mkdirSync(directory, { mode: 0o700 });
  }
  validateParents(directory);
  const socketPath = path.join(directory, 'setup.sock');
  requireThat(Buffer.byteLength(socketPath) < 104);
  try { fs.lstatSync(socketPath); throw new Error('Setup endpoint already exists; refusing to replace it'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  let busy = false;
  const server = http.createServer(async (req, res) => {
    const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    if (req.method !== 'POST' || req.url !== '/v1/register-hermes' || req.headers.origin || req.headers['sec-fetch-site'] || req.headers.authorization || req.headers.cookie || req.headers.host !== 'localhost' || req.headers['content-type'] !== 'application/json') return reply(403, { error: 'Forbidden setup request' });
    if (busy) return reply(409, { error: 'Setup already in progress; read back before retrying' });
    busy = true;
    try {
      validateParents(directory);
      const live = fs.lstatSync(socketPath);
      requireThat(live.isSocket() && live.uid === process.getuid() && (live.mode & 0o777) === 0o600 && live.ino === inode);
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; requireThat(size <= 4096); chunks.push(chunk); }
      const result = await registerHermes(fetch, JSON.parse(Buffer.concat(chunks).toString('utf8')));
      reply(200, result);
    } catch (error) { reply(400, { error: 'Setup refused or incomplete; inspect exact records before retrying',
      ...(error instanceof SetupFailure ? { stage: error.stage, ...(error.upstream_status ? { upstream_status: error.upstream_status, category: error.category } : {}) } : { stage: 'request' }) }); }
    finally { busy = false; }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  let inode;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  fs.chmodSync(socketPath, 0o600);
  inode = fs.lstatSync(socketPath).ino;
  server.unref();
  return { socketPath, close: () => new Promise(resolve => server.close(resolve)) };
}
module.exports = { startLocalAgentSetup, registerHermes, FLAGS, UPSTREAM };
