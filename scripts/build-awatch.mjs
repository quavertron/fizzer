import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Development uses the canonical sibling checkout; releases use its bundled copy.
const sibling = path.join(root, '..', 'awatch');
const source = fs.existsSync(path.join(sibling, 'analyze.go')) ? sibling : path.join(root, 'vendor', 'awatch');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fizzer-awatch-build-'));
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, CGO_ENABLED: '1' } });
  if (result.error || result.status) throw result.error || new Error(`${command} failed (${result.status})`);
}
try {
  fs.cpSync(source, temporary, { recursive: true, filter: file => !['.git', 'awatch', 'libdtob'].includes(path.basename(file)) || file === source });
  fs.cpSync(path.join(root, 'vendor', 'libdtob'), path.join(temporary, 'libdtob'), { recursive: true });
  run('make', ['clean'], path.join(temporary, 'libdtob'));
  run('make', ['libdtob.a'], path.join(temporary, 'libdtob'));
  run('go', ['build', '-mod=readonly', '-trimpath', '-o', path.join(temporary, 'awatch'), '.'], temporary);
  const destination = path.join(root, '.native-tools');
  fs.mkdirSync(destination, { recursive: true });
  const staging = path.join(destination, `awatch-${process.pid}`);
  fs.copyFileSync(path.join(temporary, 'awatch'), staging);
  fs.chmodSync(staging, 0o755);
  fs.renameSync(staging, path.join(destination, 'awatch'));
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
