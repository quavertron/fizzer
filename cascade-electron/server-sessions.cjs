'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const temporarySessions = new Map();

function storageBinary() {
  if (process.env.FIZZER_STORAGE_BIN) return process.env.FIZZER_STORAGE_BIN;
  return [
    process.resourcesPath && path.join(process.resourcesPath, 'embedded-runtime', 'agent-account-setup', 'fizzer-storage'),
    path.join(__dirname, '..', '.native-tools', 'fizzer-storage'),
    '/usr/local/libexec/fizzer/fizzer-storage',
  ].find(file => file && fs.existsSync(file)) || 'fizzer-storage';
}

function readSessions(directory) {
  let sessions = {};
  try {
    const stdout = execFileSync(storageBinary(), ['server-sessions', 'read', path.resolve(directory)], { encoding: 'utf8' });
    sessions = JSON.parse(stdout);
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
    execFileSync(storageBinary(), ['server-sessions', 'remember', directoryKey, key, token], {
      stdio: 'pipe',
      encoding: 'utf8',
    });
    delete pending[key];
    return true;
  } catch {

    // Authentication already succeeded. Keep this login usable for the current
    // process even when it cannot be remembered across application restarts.
    return false;
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

module.exports = { readSessions, rememberSession, listConnections, storageBinary };


