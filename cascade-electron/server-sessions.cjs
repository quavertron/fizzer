'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const temporarySessions = new Map();

function readSessions(directory) {
  let sessions = {};
  try { sessions = JSON.parse(fs.readFileSync(path.join(directory, 'server-sessions.json'), 'utf8')); }
  catch { /* Read legacy sessions without rewriting the shared file. */ }
  const entries = path.join(directory, 'server-sessions');
  let names = [];
  try { names = fs.readdirSync(entries); } catch { /* Session storage may be unavailable. */ }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try { Object.assign(sessions, JSON.parse(fs.readFileSync(path.join(entries, name), 'utf8'))); }
    catch { /* An unreadable entry must not hide other servers. */ }
  }
  return { ...sessions, ...temporarySessions.get(path.resolve(directory)) };
}

function rememberSession(directory, key, token) {
  if (typeof token !== 'string' || !token.trim()) return;
  const directoryKey = path.resolve(directory);
  const pending = temporarySessions.get(directoryKey) || {};
  pending[key] = token;
  temporarySessions.set(directoryKey, pending);
  const entries = path.join(directory, 'server-sessions');
  const destination = path.join(entries, `${createHash('sha256').update(key).digest('hex')}.json`);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(entries, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, JSON.stringify({ [key]: token }), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, destination);
    delete pending[key];
    return true;
  } catch {
    // Authentication already succeeded. Keep this login usable for the current
    // process even when it cannot be remembered across application restarts.
    return false;
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch { /* Best-effort cleanup. */ }
  }
}

function hostLabel(origin) {
  try { return new URL(origin).host; } catch { return origin; }
}

// One row per server, not per vault: the login screen picks where to sign in.
// `hasSession` means a stored token can resume without a password prompt.
function listConnections(directory, vaults, { localOrigin = '' } = {}) {
  const connections = new Map();
  const add = (origin, { id = '', local = false, hasSession = false } = {}) => {
    const entry = connections.get(origin) || { id: '', name: '', origin, local: false, hasSession: false };
    if (id && !entry.id) entry.id = id;
    entry.local = entry.local || local;
    entry.hasSession = entry.hasSession || hasSession;
    connections.set(origin, entry);
  };
  for (const vault of vaults) {
    if (vault?.origin) add(vault.origin, { id: vault.id, hasSession: Boolean(vault.token) });
  }
  for (const key of Object.keys(readSessions(directory))) {
    const origin = key === 'local' ? localOrigin : key;
    if (origin) add(origin, { local: key === 'local', hasSession: true });
  }
  return [...connections.values()]
    .map((entry) => ({ ...entry, name: entry.local ? 'This Mac' : hostLabel(entry.origin) }))
    .sort((a, b) => Number(b.local) - Number(a.local) || a.name.localeCompare(b.name));
}

module.exports = { readSessions, rememberSession, listConnections };
