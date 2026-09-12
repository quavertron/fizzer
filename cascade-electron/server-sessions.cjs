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

function listConnections(directory, vaults) {
  const connections = vaults.map(({ id, name, origin }) => ({ id, name, origin }));
  for (const origin of Object.keys(readSessions(directory))) {
    if (origin === 'local' || connections.some(connection => connection.origin === origin)) continue;
    connections.push({ id: '', name: 'Remote server', origin });
  }
  return connections;
}

module.exports = { readSessions, rememberSession, listConnections };
