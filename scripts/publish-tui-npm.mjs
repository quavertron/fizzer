#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const packages = [
  'npm/fizzer-darwin-arm64',
  'npm/fizzer-linux-x64',
  'npm/fizzer',
];

const otpArg = process.argv.slice(2).find((arg) => arg.startsWith('--otp=') || /^\d{6}$/.test(arg));
const otp = otpArg
  ? (otpArg.startsWith('--otp=') ? otpArg.slice(6) : otpArg)
  : null;

for (const pkg of packages) {
  const pkgDir = path.join(repoRoot, pkg);
  console.log(`\nPublishing ${pkg}...`);
  const args = ['publish', '--access', 'public'];
  if (otp) {
    args.push(`--otp=${otp}`);
  }
  const result = spawnSync('npm', args, {
    cwd: pkgDir,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    console.error(`Failed to publish ${pkg}`);
    process.exit(result.status ?? 1);
  }
}

console.log('\nSuccessfully published all packages to npm!');
