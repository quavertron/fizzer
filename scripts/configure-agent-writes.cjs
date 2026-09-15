#!/usr/bin/env node
'use strict';
const { save } = require('../cascade-electron/agent-write-access.cjs');
const args = process.argv.slice(2);
const value = flag => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
try {
  const scope = value('--scope');
  const folders = args.flatMap((arg, index) => arg === '--folder' ? [args[index + 1]] : []);
  save(value('--server'), value('--vault'), value('--agent'), { scope, ...(scope === 'folders' ? { folders } : {}) });
  console.log(`Saved ${scope} write access for this agent registration. Applies on its next run; working directory is unchanged.`);
} catch (error) {
  console.error(error.message);
  console.error('Usage: node scripts/configure-agent-writes.cjs --server URL --vault ID --agent REGISTRATION_ID --scope workspace|human|folders [--folder /absolute/path ...]');
  process.exitCode = 1;
}
