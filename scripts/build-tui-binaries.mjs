#!/usr/bin/env node
// Build the cascade-tui binary for one or more Rust targets and stage each into
// its npm platform package (npm/<pkg>/bin/cascade-tui). Publishing those
// packages is what feeds the esbuild-style optionalDependencies in the root
// package.json. Run with no args to build the host target only.
//
//   node scripts/build-tui-binaries.mjs                      # host target
//   node scripts/build-tui-binaries.mjs aarch64-apple-darwin # explicit target(s)
//   node scripts/build-tui-binaries.mjs --all                # every known target

import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync, chmodSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = path.join(repoRoot, 'tui', 'Cargo.toml');

// Rust target triple -> npm platform package directory name.
const TARGETS = {
  'aarch64-apple-darwin': 'fizzer-darwin-arm64',
  'x86_64-unknown-linux-gnu': 'fizzer-linux-x64',
};

function hostTarget() {
  const { platform, arch } = process;
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin';
  if (platform === 'linux' && arch === 'x64') return 'x86_64-unknown-linux-gnu';
  throw new Error(`no known target for host ${platform}-${arch}`);
}

const argv = process.argv.slice(2);
const targets = argv.includes('--all')
  ? Object.keys(TARGETS)
  : (argv.length ? argv : [hostTarget()]);

for (const target of targets) {
  const pkg = TARGETS[target];
  if (!pkg) throw new Error(`unknown target ${target}`);

  console.error(`building ${target} -> npm/${pkg}`);
  const build = spawnSync(
    'cargo',
    ['build', '--release', '--locked', '--manifest-path', manifest, '--target', target],
    { stdio: 'inherit' },
  );
  if (build.status !== 0) process.exit(build.status ?? 1);

  const binName = target.includes('windows') ? 'cascade-tui.exe' : 'cascade-tui';
  const from = path.join(repoRoot, 'tui', 'target', target, 'release', binName);
  const destDir = path.join(repoRoot, 'npm', pkg, 'bin');
  mkdirSync(destDir, { recursive: true });
  const to = path.join(destDir, binName);
  copyFileSync(from, to);
  chmodSync(to, 0o755);
  console.error(`staged ${to}`);

  // Copy LICENSE and README.md into platform package
  const licenseSrc = path.join(repoRoot, 'LICENSE');
  const readmeSrc = path.join(repoRoot, 'tui', 'README.md');
  const fallbackReadme = path.join(repoRoot, 'README.md');
  if (existsSync(licenseSrc)) {
    copyFileSync(licenseSrc, path.join(repoRoot, 'npm', pkg, 'LICENSE'));
  }
  if (existsSync(readmeSrc)) {
    copyFileSync(readmeSrc, path.join(repoRoot, 'npm', pkg, 'README.md'));
  } else if (existsSync(fallbackReadme)) {
    copyFileSync(fallbackReadme, path.join(repoRoot, 'npm', pkg, 'README.md'));
  }

  // If this target matches the host running the build, stage directly into
  // repo bin/ for local standalone packaging (npm pack)
  let isHost = false;
  try {
    if (target === hostTarget()) isHost = true;
  } catch {}
  if (isHost) {
    const hostBinDir = path.join(repoRoot, 'bin');
    mkdirSync(hostBinDir, { recursive: true });
    const hostBin = path.join(hostBinDir, binName);
    copyFileSync(from, hostBin);
    chmodSync(hostBin, 0o755);
    console.error(`staged host binary ${hostBin}`);
  }
}

// Ensure bin/fizzer.cjs is executable and stage npm/fizzer files
const shimPath = path.join(repoRoot, 'bin', 'fizzer.cjs');
if (existsSync(shimPath)) {
  chmodSync(shimPath, 0o755);
  const fizzerPkgDir = path.join(repoRoot, 'npm', 'fizzer');
  mkdirSync(path.join(fizzerPkgDir, 'bin'), { recursive: true });
  copyFileSync(shimPath, path.join(fizzerPkgDir, 'bin', 'fizzer.cjs'));
  chmodSync(path.join(fizzerPkgDir, 'bin', 'fizzer.cjs'), 0o755);
  const licenseSrc = path.join(repoRoot, 'LICENSE');
  const readmeSrc = path.join(repoRoot, 'tui', 'README.md');
  if (existsSync(licenseSrc)) copyFileSync(licenseSrc, path.join(fizzerPkgDir, 'LICENSE'));
  if (existsSync(readmeSrc)) copyFileSync(readmeSrc, path.join(fizzerPkgDir, 'README.md'));
}
