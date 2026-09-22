'use strict';
const fs = require('node:fs');
const { runStorage } = require('./storage-bin.cjs');

function isRemoteVault(opts, api) {
  return runStorage(['agent-account', 'is-remote-vault', JSON.stringify({ opts, api })]) === true;
}

async function prepareWorkspace(opts, api, mirrorHost) {
  if (isRemoteVault(opts, api)) {
    if (!api?.url || !(api.writeToken || api.token) || !opts.vaultId) {
      throw new Error('Remote vault workspace requires an authenticated mirror connection');
    }
    mirrorHost ||= require('./vault-mirror.cjs').mirrors();
    const mirror = mirrorHost.watch({ origin: api.origin || api.url,
      token: api.writeToken || api.token, vaultId: opts.vaultId });
    await mirrorHost.reconcile(mirror);
    const root = fs.realpathSync(mirror.root);
    if (!fs.statSync(root).isDirectory()) throw new Error('Remote vault mirror is not a directory');
    return { root, remote: true };
  }
  try {
    return runStorage(['agent-account', 'prepare-workspace', JSON.stringify({ opts, api })]);
  } catch (error) {
    if (error.code === 'ENOENT') {
      const err = new Error(error.message);
      err.code = 'ENOENT';
      throw err;
    }
    throw error;
  }
}

function resolveWorkspace(selected) {
  return runStorage(['agent-account', 'resolve-workspace', selected], { raw: true }).trim();
}

function enabled() { return runStorage(['agent-account', 'enabled'], { raw: true }).trim() === 'true'; }
function shouldOffer() { return runStorage(['agent-account', 'should-offer'], { raw: true }).trim() === 'true'; }
function decline() { runStorage(['agent-account', 'decline'], { raw: true }); }

function setupCommand({ resourcesPath = process.resourcesPath, packaged = false } = {}) {
  const args = ['agent-account', 'setup-command'];
  if (packaged) args.push('--packaged', resourcesPath || '');
  return runStorage(args, { raw: true }).trim();
}

function launchArguments(node, worker, socket) {
  const { storageBinary } = require('./storage-bin.cjs');
  const env = { ...process.env, FIZZER_NODE_BIN: node };
  if (!env.FIZZER_STORAGE_BIN) {
    const candidate = storageBinary();
    if (candidate !== 'fizzer-storage' && fs.existsSync(candidate)) env.FIZZER_STORAGE_BIN = candidate;
  }
  return JSON.parse(runStorage(['agent-account', 'launch-argv', socket, worker], { raw: true, env }));
}

module.exports = { enabled, shouldOffer, decline, setupCommand, launchArguments, resolveWorkspace, isRemoteVault, prepareWorkspace };
