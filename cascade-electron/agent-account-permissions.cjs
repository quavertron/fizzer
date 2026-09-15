'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Run under the agent UID, so ACLs and supplementary groups are evaluated by
// the OS. Never launch an agent into a tree where it can bypass the bridge.
async function verifyReadOnlyProject(root) {
  const pending = [root];
  const visited = new Set();
  while (pending.length) {
    const entry = pending.pop();
    let target;
    try { target = await fs.promises.realpath(entry); }
    catch (error) {
      // A dangling link exposes no existing content; the bridge rejects link edits.
      if (error.code === 'ENOENT' && (await fs.promises.lstat(entry)).isSymbolicLink()) continue;
      throw error;
    }
    if (visited.has(target)) continue;
    visited.add(target);
    let writable = false;
    try { await fs.promises.access(target, fs.constants.W_OK); writable = true; }
    catch (error) { if (!['EACCES', 'EPERM'].includes(error.code)) throw error; }
    if (writable) throw new Error(`Agent account can write ${target} directly. Remove its file/directory write permissions before running with alock.`);
    const info = await fs.promises.lstat(target);
    if (info.isDirectory()) {
      try { await fs.promises.access(target, fs.constants.X_OK); }
      catch (error) {
        if (['EACCES', 'EPERM'].includes(error.code)) continue;
        throw error;
      }
      for (const name of await fs.promises.readdir(target)) pending.push(path.join(target, name));
    }
  }
}
module.exports = { verifyReadOnlyProject };
