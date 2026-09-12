#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const packageRoot = path.resolve(__dirname, '..');
const binNames = process.platform === 'win32'
  ? ['fizzer.exe', 'cascade-tui.exe']
  : ['fizzer', 'cascade-tui'];

// Prebuilt binaries ship as per-platform optionalDependencies (esbuild-style).
// Map the current host to its platform package.
const PLATFORM_PACKAGES = {
  'darwin-arm64': 'fizzer-darwin-arm64',
  'linux-x64': 'fizzer-linux-x64',
};

function findRepoRoot(dir) {
  let cur = dir;
  while (cur && cur !== path.dirname(cur)) {
    if (fs.existsSync(path.join(cur, 'tui', 'Cargo.toml'))) {
      return cur;
    }
    cur = path.dirname(cur);
  }
  return null;
}

function findBinary() {
  const platformKey = `${process.platform}-${process.arch}`;
  const pkg = PLATFORM_PACKAGES[platformKey];
  const repoRoot = findRepoRoot(__dirname);

  for (const binName of binNames) {
    // 1. Installed platform package via optionalDependencies in node_modules
    if (pkg) {
      try {
        return require.resolve(`${pkg}/bin/${binName}`);
      } catch {
        // not installed via npm optionalDependencies
      }
    }

    // 2. Bundled binary directly in bin/ (for packaged standalone tarballs)
    const bundledBin = path.join(__dirname, binName);
    if (fs.existsSync(bundledBin)) return bundledBin;

    // 3. Staged in repo bin/ (in local repo checkout)
    if (repoRoot) {
      const hostBin = path.join(repoRoot, 'bin', binName);
      if (fs.existsSync(hostBin)) return hostBin;
    }

    // 4. Staged in npm/<platform-pkg>/bin/ (in repo checkout after build script)
    if (pkg) {
      const searchBases = repoRoot ? [packageRoot, repoRoot] : [packageRoot];
      for (const base of searchBases) {
        const staged = path.join(base, 'npm', pkg, 'bin', binName);
        if (fs.existsSync(staged)) return staged;
      }
    }

    // 5. In-tree cargo release builds (target-specific or default)
    const targetTriples = {
      'darwin-arm64': 'aarch64-apple-darwin',
      'darwin-x64': 'x86_64-apple-darwin',
      'linux-x64': 'x86_64-unknown-linux-gnu',
      'linux-arm64': 'aarch64-unknown-linux-gnu',
    };
    const triple = targetTriples[platformKey];
    const treeBases = repoRoot ? [packageRoot, repoRoot] : [packageRoot];
    for (const base of treeBases) {
      if (triple) {
        const targetBin = path.join(base, 'tui', 'target', triple, 'release', binName);
        if (fs.existsSync(targetBin)) return targetBin;
      }
      const inTree = path.join(base, 'tui', 'target', 'release', binName);
      if (fs.existsSync(inTree)) return inTree;
    }
  }

  return null;
}

const binary = findBinary();
const repoRoot = findRepoRoot(__dirname);
const manifest = path.join(repoRoot || packageRoot, 'tui', 'Cargo.toml');

let command;
let args;
if (binary) {
  command = binary;
  args = process.argv.slice(2);
} else if (fs.existsSync(manifest)) {
  // Developer checkout fallback: build and run from source via cargo
  command = 'cargo';
  args = ['run', '--release', '--locked', '--manifest-path', manifest, '--', ...process.argv.slice(2)];
} else {
  console.error(
    `fizzer: no prebuilt binary found for ${process.platform}-${process.arch}.\n` +
    `Expected platform package "${PLATFORM_PACKAGES[`${process.platform}-${process.arch}`] || 'unknown'}" to be installed.`
  );
  process.exit(1);
}

const result = spawnSync(command, args, { stdio: 'inherit', env: process.env });

if (result.error?.code === 'ENOENT') {
  if (command === 'cargo') {
    console.error('fizzer: Rust/Cargo is required to build from source. Install it from https://rustup.rs/');
  } else {
    console.error(`fizzer: failed to launch ${command}`);
  }
  process.exit(1);
}
process.exit(result.status == null ? 1 : result.status);
