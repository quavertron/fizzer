#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageAgentAccountSetup } from './prepare-agent-account-setup.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backendRoot = path.join(root, 'backend_elixir');
const releaseRoot = path.join(backendRoot, '_build', 'prod', 'rel', 'cascade_elixir');
const clientDist = path.join(root, 'client', 'dist');
const runtimeRoot = path.join(root, 'cascade-electron', 'embedded-runtime');

function run(command, args, cwd = root) {
  const executable = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : command;
  const executableArgs = process.platform === 'win32'
    ? ['/d', '/s', '/c', command, ...args]
    : args;
  const result = spawnSync(executable, executableArgs, {
    cwd,
    env: { ...process.env, MIX_ENV: 'prod' },
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const mix = process.platform === 'win32' ? 'mix.bat' : 'mix';

fs.rmSync(runtimeRoot, { recursive: true, force: true });
run(npm, ['run', 'build:client']);
run(mix, ['deps.get', '--only', 'prod'], backendRoot);
run(mix, ['compile', '--warnings-as-errors'], backendRoot);
run(mix, ['release', '--overwrite'], backendRoot);

for (const required of [path.join(releaseRoot, 'bin'), path.join(clientDist, 'app.html')]) {
  if (!fs.existsSync(required)) throw new Error(`Desktop runtime build did not produce ${required}`);
}

fs.mkdirSync(runtimeRoot, { recursive: true });
fs.cpSync(releaseRoot, path.join(runtimeRoot, 'backend-release'), { recursive: true, preserveTimestamps: true });
fs.cpSync(clientDist, path.join(runtimeRoot, 'client-dist'), { recursive: true, preserveTimestamps: true });

const backendLicenses = path.join(runtimeRoot, 'backend-licenses');
fs.mkdirSync(path.join(backendLicenses, 'hex'), { recursive: true });
fs.copyFileSync(
  path.join(backendRoot, 'THIRD_PARTY_NOTICES.md'),
  path.join(backendLicenses, 'THIRD_PARTY_NOTICES.md'),
);
fs.copyFileSync(
  path.join(backendRoot, 'deps', 'cc_precompiler', 'LICENSE'),
  path.join(backendLicenses, 'APACHE-2.0.txt'),
);
for (const dependency of fs.readdirSync(path.join(backendRoot, 'deps'), { withFileTypes: true })) {
  if (!dependency.isDirectory()) continue;
  const dependencyRoot = path.join(backendRoot, 'deps', dependency.name);
  const notices = fs.readdirSync(dependencyRoot).filter((name) => (
    /^(?:license|copying|notice)/iu.test(name)
    && fs.statSync(path.join(dependencyRoot, name)).isFile()
  ));
  if (!notices.length) continue;
  const destination = path.join(backendLicenses, 'hex', dependency.name);
  fs.mkdirSync(destination, { recursive: true });
  for (const notice of notices) fs.copyFileSync(path.join(dependencyRoot, notice), path.join(destination, notice));
}

console.log(`[build-desktop-runtime] staged ${runtimeRoot}`);
if (process.platform !== 'win32') stageAgentAccountSetup(path.join(runtimeRoot, 'agent-account-setup'));
