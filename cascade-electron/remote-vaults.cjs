'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function storageBinary() {
  if (process.env.FIZZER_STORAGE_BIN) return process.env.FIZZER_STORAGE_BIN;
  return [
    process.resourcesPath && path.join(process.resourcesPath, 'embedded-runtime', 'agent-account-setup', 'fizzer-storage'),
    path.join(__dirname, '..', '.native-tools', 'fizzer-storage'),
    '/usr/local/libexec/fizzer/fizzer-storage',
  ].find(file => file && fs.existsSync(file)) || 'fizzer-storage';
}

function readRemoteVaults(directory) {
  try {
    const stdout = execFileSync(storageBinary(), ['remote-vaults', 'read', path.resolve(directory)], { encoding: 'utf8' });
    return JSON.parse(stdout);
  } catch {
    return [];
  }
}

function saveRemoteVault(directory, record) {
  execFileSync(storageBinary(), ['remote-vaults', 'save', path.resolve(directory)], {
    input: JSON.stringify(record),
    encoding: 'utf8',
  });
}

module.exports = { readRemoteVaults, saveRemoteVault, storageBinary };

