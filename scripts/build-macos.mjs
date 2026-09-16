#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), '..');
const nodeVersion = '24.20.0';
const mode = process.argv[2] ?? 'make';

if (process.platform !== 'darwin') {
  console.error('The macOS build must run on macOS.');
  process.exit(1);
}
if (!['make', 'package'].includes(mode)) {
  console.error('Usage: build-macos.mjs [make|package]');
  process.exit(1);
}

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Forge's ZIP extraction stalls on Node 26. Use the version tested for this build.
if (process.versions.node !== nodeVersion) {
  console.log(`[build-macos] Selecting Node ${nodeVersion}`);
  run('npm', ['exec', '--yes', `--package=node@${nodeVersion}`, '--', 'node', script, mode]);
  process.exit(0);
}
// Keep npm, Forge and native build subprocesses on the same host Node ABI.
process.env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`;
console.log(`[build-macos] Using Node ${process.versions.node}`);
if (mode === 'make') {
  console.log('[build-macos] Rebuilding native DMG tooling');
  run('npm', ['rebuild', 'macos-alias', 'fs-xattr', '--ignore-scripts=false', '--loglevel=warn'], path.join(root, 'cascade-electron'));
}
run('npm', ['run', 'build']);
run('npm', ['run', 'build:desktop-runtime']);
run('npm', ['--prefix', 'cascade-electron', 'run', mode]);
