'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

function key(record) { return JSON.stringify([new URL(record.origin).origin, record.id]); }
function readRemoteVaults(directory) {
  const records = new Map();
  const add = record => {
    if (typeof record?.id !== 'string' || typeof record?.token !== 'string') return;
    try { records.set(key(record), { ...record, origin: new URL(record.origin).origin }); } catch { /* Invalid entry. */ }
  };
  try {
    const legacy = JSON.parse(fs.readFileSync(path.join(directory, 'remote-vaults.json'), 'utf8'));
    if (Array.isArray(legacy)) legacy.forEach(add);
  } catch { /* Legacy file is a read-only migration fallback. */ }
  const entries = path.join(directory, 'remote-vaults');
  let names = [];
  try { names = fs.readdirSync(entries); } catch { /* No saved entries yet. */ }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try { add(JSON.parse(fs.readFileSync(path.join(entries, name), 'utf8'))); } catch { /* Preserve other readable entries. */ }
  }
  return [...records.values()];
}

function saveRemoteVault(directory, record) {
  record = { ...record, origin: new URL(record.origin).origin };
  const entries = path.join(directory, 'remote-vaults');
  fs.mkdirSync(entries, { recursive: true, mode: 0o700 });
  const destination = path.join(entries, `${createHash('sha256').update(key(record)).digest('hex')}.json`);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, destination);
  } finally { fs.rmSync(temporary, { force: true }); }
}

module.exports = { readRemoteVaults, saveRemoteVault };
