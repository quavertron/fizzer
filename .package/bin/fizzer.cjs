#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const packageRoot = path.resolve(__dirname, '..');
const manifest = path.join(packageRoot, 'tui', 'Cargo.toml');
const releaseBinary = path.join(packageRoot, 'tui', 'target', 'release', process.platform === 'win32' ? 'cascade-tui.exe' : 'cascade-tui');

if (!fs.existsSync(manifest)) {
  console.error('fizzer: the TUI source is missing from this installation');
  process.exit(1);
}

const command = fs.existsSync(releaseBinary) ? releaseBinary : 'cargo';
const args = command === 'cargo'
  ? ['run', '--release', '--locked', '--manifest-path', manifest, '--', ...process.argv.slice(2)]
  : process.argv.slice(2);
const result = spawnSync(command, args, { stdio: 'inherit', env: process.env });

if (result.error?.code === 'ENOENT') {
  console.error('fizzer: Rust/Cargo is required. Install it from https://rustup.rs/');
  process.exit(1);
}
process.exit(result.status == null ? 1 : result.status);
