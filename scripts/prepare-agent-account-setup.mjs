import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildAgentTools } from './build-agent-tools.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let built;
export function stageAgentAccountSetup(destination, binary = process.env.FIZZER_ALOCK_BIN) {
  if (!binary) {
    built ||= buildAgentTools();
    binary = path.join(built, 'alock');
  }
  const probe = spawnSync(binary, ['bridge', '--help'], { encoding: 'utf8' });
  const help = `${probe.stdout || ''}${probe.stderr || ''}`;
  const accountProbe = spawnSync(binary, ['account', '--help'], { encoding: 'utf8' });
  const accountHelp = `${accountProbe.stdout || ''}${accountProbe.stderr || ''}`;
  if (!help.includes('alock bridge mkdir') || !help.includes('--author NAME') || !help.includes('--replace-symlink') || !help.includes('--delete') || !help.includes('--turn') || !accountHelp.includes('alock account http-serve') || !accountHelp.includes('--persistent')) {
    throw new Error('Packaging requires the current native helper bundle. Run npm run build:agent-tools.');
  }
  fs.mkdirSync(destination, { recursive: true });
  const tools = path.dirname(binary);
  for (const name of ['alock', 'nab', 'awatch', 'purrvect', 'rclone', 'DEPENDENCIES.json']) {
    fs.copyFileSync(path.join(tools, name), path.join(destination, name));
    if (name !== 'DEPENDENCIES.json') fs.chmodSync(path.join(destination, name), 0o755);
  }
  for (const name of fs.readdirSync(tools).filter(name => /\.dylib$|\.so(?:\.|$)/.test(name))) {
    fs.copyFileSync(path.join(tools, name), path.join(destination, name));
  }
  if (fs.existsSync(path.join(tools, 'licenses'))) fs.cpSync(path.join(tools, 'licenses'), path.join(destination, 'licenses'), { recursive: true });
  for (const name of ['install-agent-writes.sh', 'setup-fizzer-user.sh']) {
    fs.copyFileSync(path.join(root, name === 'install-agent-writes.sh' ? '' : 'scripts', name), path.join(destination, name));
  }
}
