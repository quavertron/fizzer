#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const sourceDir = path.join(root, 'cli-agents');
const targetDir = path.join(root, 'dist', 'cli-agents');
const wrappers = ['cascade-note', 'cascade-chat', 'cascade-scratchpad', 'auto-papercut.mjs', 'cli-common.mjs'];
// TypeScript preserves the include root and emits cli-agents/*.ts at dist/*.js,
// while Electron deliberately loads the runtime from dist/cli-agents so it can
// sit beside the helper executables outside app.asar. Refresh that runtime on
// every build; otherwise source changes compile successfully but never run.
const compiledArtifacts = ['cli-agent.js'];

fs.mkdirSync(targetDir, { recursive: true });
// The packaged copy lives outside app.asar, so it does not inherit the
// Electron package's `type: module`. Keep compiled .js imports as ESM.
fs.writeFileSync(path.join(root, 'dist', 'package.json'), '{"type":"module"}\n');

for (const wrapper of wrappers) {
  const source = path.join(sourceDir, wrapper);
  const target = path.join(targetDir, wrapper);
  fs.copyFileSync(source, target);
  if (!wrapper.endsWith('.mjs')) fs.chmodSync(target, 0o755);
}

for (const artifact of compiledArtifacts) {
  fs.copyFileSync(path.join(root, 'dist', artifact), path.join(targetDir, artifact));
}
