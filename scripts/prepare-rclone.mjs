import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// Official standalone release archives. No installer, container, or runtime fetch.
const version = 'v1.75.1';
const checksums = {
  'linux-amd64': '982b5aa772841168f8e380f139e9e787b2a105403e32b94da8676a0e1c0a13ab',
  'linux-arm64': '03f2504174034b6d004152ed7369251c9a9ec1f7e0836eda420f5c7a5ec0dff9',
  'osx-amd64': '29253d0288b8fbbac46baad6e5f6add6cb01d462c79f10805bbd4631c4cdf82c',
  'osx-arm64': 'c61d7a371c62bcbbe882c3423aa4b8bf63485c248dd0f692997b8f0c3f6d0c6f',
};
const platform = `${process.platform === 'darwin' ? 'osx' : process.platform}-${process.arch === 'x64' ? 'amd64' : process.arch}`;
if (!checksums[platform]) throw new Error(`Unsupported rclone platform: ${platform}`);
const destination = path.resolve(process.argv[2]);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fizzer-rclone-build-'));
async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Cannot download rclone (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}
try {
  const archiveName = `rclone-${version}-${platform}`;
  const data = await download(`https://downloads.rclone.org/${version}/${archiveName}.zip`);
  if (createHash('sha256').update(data).digest('hex') !== checksums[platform]) throw new Error('rclone archive checksum mismatch');
  const archive = path.join(temporary, 'rclone.zip');
  fs.writeFileSync(archive, data);
  const unpack = spawnSync('unzip', ['-q', archive, '-d', temporary], { stdio: 'inherit' });
  if (unpack.error || unpack.status !== 0) throw new Error('unzip is required to package rclone');
  fs.mkdirSync(destination, { recursive: true });
  fs.copyFileSync(path.join(temporary, archiveName, 'rclone'), path.join(destination, 'rclone'));
  fs.chmodSync(path.join(destination, 'rclone'), 0o755);
  fs.mkdirSync(path.join(destination, 'licenses'), { recursive: true });
  fs.writeFileSync(path.join(destination, 'licenses', 'rclone-COPYING'),
    await download(`https://raw.githubusercontent.com/rclone/rclone/${version}/COPYING`));
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
