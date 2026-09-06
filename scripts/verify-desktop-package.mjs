#!/usr/bin/env node

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronRoot = path.join(root, 'cascade-electron');
const requireFromElectron = createRequire(path.join(electronRoot, 'package.json'));
const { listPackage } = requireFromElectron('@electron/asar');
const electronManifest = JSON.parse(fs.readFileSync(path.join(electronRoot, 'package.json'), 'utf8'));
const productName = String(electronManifest.productName || electronManifest.name || '').trim();
const executableName = String(electronManifest.name || '').trim();
if (!productName) throw new Error('Desktop package manifest has no product name');
if (!executableName) throw new Error('Desktop package manifest has no executable name');
const valueAfter = (flag) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : '';
};
const platform = valueAfter('--platform') || process.platform;
const arch = valueAfter('--arch') || process.arch;
// Electron Packager names both the output directory and macOS app bundle from
// the product identity. Derive it from the manifest so a rebrand cannot leave
// this verifier looking for a stale hard-coded package name.
const packageRoot = path.join(electronRoot, 'out', `${productName}-${platform}-${arch}`);
const resources = platform === 'darwin'
  ? path.join(packageRoot, `${productName}.app`, 'Contents', 'Resources')
  : path.join(packageRoot, 'resources');
const executable = platform === 'darwin'
  ? path.join(packageRoot, `${productName}.app`, 'Contents', 'MacOS', executableName)
  : path.join(packageRoot, platform === 'win32' ? `${executableName}.exe` : executableName);

const requiredFiles = [
  executable,
  path.join(resources, 'app.asar'),
  path.join(resources, 'FIZZER-LICENSE.txt'),
  path.join(resources, 'THIRD_PARTY_NOTICES.md'),
  path.join(resources, 'LICENSE'),
  path.join(resources, 'dist', 'package.json'),
  path.join(resources, 'dist', 'cli-agents', 'cli-agent.js'),
  path.join(resources, 'dist', 'cli-agents', 'cascade-note'),
  path.join(resources, 'dist', 'cli-agents', 'cascade-chat'),
  path.join(resources, 'dist', 'cli-agents', 'cascade-scratchpad'),
  path.join(resources, 'dist', 'cli-agents', 'auto-papercut.mjs'),
  path.join(resources, 'dist', 'cli-agents', 'cli-common.mjs'),
  path.join(resources, 'embedded-runtime', 'client-dist', 'app.html'),
  path.join(resources, 'embedded-runtime', 'backend-licenses', 'THIRD_PARTY_NOTICES.md'),
  path.join(resources, 'embedded-runtime', 'backend-licenses', 'APACHE-2.0.txt'),
  path.join(resources, 'embedded-runtime', 'backend-licenses', 'hex', 'bandit', 'LICENSE'),
  path.join(
    resources,
    'embedded-runtime',
    'backend-release',
    'bin',
    platform === 'win32' ? 'cascade_elixir.bat' : 'cascade_elixir',
  ),
];
const missing = requiredFiles.filter((file) => !fs.existsSync(file));
if (missing.length) {
  throw new Error(`Packaged runtime is incomplete:\n${missing.map((file) => `- ${file}`).join('\n')}`);
}

const thirdPartyNotices = fs.readFileSync(path.join(resources, 'THIRD_PARTY_NOTICES.md'), 'utf8');
const mplLicense = fs.readFileSync(path.join(resources, 'LICENSE'), 'utf8');
if (!thirdPartyNotices.includes('@resvg/resvg-js') || !mplLicense.includes('Mozilla Public License Version 2.0')) {
  throw new Error('Packaged third-party notices are incomplete');
}

// @electron/asar follows the host path separator when listing entries. Keep
// archive assertions identical on Windows, macOS, and Linux.
const asarEntries = new Set(
  listPackage(path.join(resources, 'app.asar')).map((entry) => entry.replaceAll('\\', '/')),
);
const requiredAsarEntries = [
  '/agent-runner.cjs',
  '/desktop-runner-host.cjs',
  '/embedded-backend.cjs',
  '/instance-origin.cjs',
];
const absentFromAsar = requiredAsarEntries.filter((entry) => !asarEntries.has(entry));
if (absentFromAsar.length) {
  throw new Error(`Packaged app.asar is incomplete:\n${absentFromAsar.map((entry) => `- ${entry}`).join('\n')}`);
}

const forbiddenAsarEntries = [...asarEntries].filter((entry) =>
  entry.includes('/node_modules/@anthropic-ai') || /\/(?:claude|claude\.exe)$/.test(entry),
);
if (forbiddenAsarEntries.length) {
  throw new Error(`Packaged app.asar redistributes Claude runtime files:\n${forbiddenAsarEntries.map((entry) => `- ${entry}`).join('\n')}`);
}

console.log(`[verify-desktop-package] OK - ${platform}/${arch} includes the local service, client, agent runtime, and helpers without a bundled Claude runtime`);
