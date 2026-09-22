'use strict';
const path = require('node:path');
const { runStorage, storageBinary } = require('./storage-bin.cjs');

function readRemoteVaults(directory) {
  try {
    return runStorage(['remote-vaults', 'read', path.resolve(directory)]);
  } catch {
    return [];
  }
}

function saveRemoteVault(directory, record) {
  runStorage(['remote-vaults', 'save', path.resolve(directory)], { input: JSON.stringify(record), raw: true });
}

module.exports = { readRemoteVaults, saveRemoteVault, storageBinary };
