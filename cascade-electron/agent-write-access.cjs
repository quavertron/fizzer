'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

function policyPath(server, vault, agent) {
  if (!server || !vault || !agent) throw new Error('Server, vault and agent registration ID are required.');
  const key = JSON.stringify([new URL(server).origin, String(vault), String(agent)]);
  return path.join(process.env.CASCADE_DATA_DIR || path.join(os.homedir(), '.fizzer'),
    'agent-write-access', createHash('sha256').update(key).digest('hex') + '.json');
}
function validate(policy) {
  if (!policy || !['workspace', 'human', 'folders'].includes(policy.scope)) throw new Error('Invalid agent write scope.');
  if (policy.scope === 'folders' && (!Array.isArray(policy.folders) || !policy.folders.length ||
    policy.folders.some(folder => typeof folder !== 'string' || !path.isAbsolute(folder)))) {
    throw new Error('Folder access requires absolute directory paths.');
  }
  return policy;
}
function save(server, vault, agent, policy) {
  validate(policy);
  const target = policyPath(server, vault, agent);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = target + '.' + randomUUID();
  try {
    fs.writeFileSync(temporary, JSON.stringify(policy) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, target);
  } finally { fs.rmSync(temporary, { force: true }); }
}
function roots(opts, api, workspace) {
  let policy;
  const directory = process.env.CASCADE_DATA_DIR || path.join(os.homedir(), '.fizzer');
  const candidates = [path.join(directory, 'agent-write-access-default.json')];
  if (opts.chatRegistrationId && opts.vaultId && api?.url) {
    candidates.unshift(policyPath(api.url, opts.vaultId, opts.chatRegistrationId));
  }
  for (const file of candidates) {
    try { policy = validate(JSON.parse(fs.readFileSync(file, 'utf8'))); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!policy) return [workspace];
  if (policy.scope === 'workspace') return [workspace];
  if (policy.scope === 'human') return ['/'];
  return [...new Set(policy.folders.map(folder => fs.realpathSync(folder)))];
}
module.exports = { save, roots };
