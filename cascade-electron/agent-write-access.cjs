'use strict';
const path = require('node:path');
const { runStorage } = require('./storage-bin.cjs');

function save(server, vault, agent, policy) {
  if (!policy || !['workspace', 'human', 'folders'].includes(policy.scope)) throw new Error('Invalid agent write scope.');
  if (policy.scope === 'folders' && (!Array.isArray(policy.folders) || !policy.folders.length ||
    policy.folders.some(folder => typeof folder !== 'string' || !path.isAbsolute(folder)))) {
    throw new Error('Folder access requires absolute directory paths.');
  }
  const args = ['agent-account', 'write-access', server, vault, agent, policy.scope];
  if (policy.scope === 'folders') args.push(...policy.folders);
  runStorage(args, { raw: true });
}

function roots(opts, api, workspace) {
  return runStorage(['agent-account', 'write-access-roots', JSON.stringify({ opts, api, workspace })]);
}

module.exports = { save, roots };
