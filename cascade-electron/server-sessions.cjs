'use strict';
const path = require('node:path');
const { runStorage, storageBinary } = require('./storage-bin.cjs');
const temporarySessions = new Map();

function readSessions(directory) {
  let sessions = {};
  try {
    sessions = runStorage(['server-sessions', 'read', path.resolve(directory)]);
  } catch { /* Session storage may be unavailable. */ }
  return { ...sessions, ...temporarySessions.get(path.resolve(directory)) };
}

function rememberSession(directory, key, token) {
  if (typeof token !== 'string' || !token.trim()) return;
  const directoryKey = path.resolve(directory);
  const pending = temporarySessions.get(directoryKey) || {};
  pending[key] = token;
  temporarySessions.set(directoryKey, pending);
  try {
    runStorage(['server-sessions', 'remember', directoryKey, key, token], { raw: true, stdio: 'pipe' });
    delete pending[key];
    return true;
  } catch {
    // Authentication already succeeded. Keep this login usable for the current
    // process even when it cannot be remembered across application restarts.
    return false;
  }
}

function listConnections(directory, vaults) {
  const connections = runStorage([
    'list-connections', path.resolve(directory), JSON.stringify(vaults),
  ]);
  const pending = temporarySessions.get(path.resolve(directory)) || {};
  for (const origin of Object.keys(pending)) {
    if (origin === 'local' || connections.some(connection => connection.origin === origin)) continue;
    connections.push({ id: '', name: 'Remote server', origin });
  }
  return connections;
}

module.exports = { readSessions, rememberSession, listConnections, storageBinary };
