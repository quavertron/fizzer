'use strict';
// Real separate-account transport regression; requires the installed fizzer user.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const readline = require('node:readline');

async function client(root, endpoint, binary) {
  const net = require('node:net');
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  const exec = promisify(execFile);
  const directory = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'alock-frame-client-'));
  const proxyPath = path.join(directory, 'socket');
  const proxy = net.createServer(downstream => {
    const upstream = net.createConnection(endpoint);
    upstream.pipe(downstream);
    downstream.on('error', () => upstream.destroy());
    upstream.on('error', error => downstream.destroy(error));
    downstream.on('close', () => upstream.destroy());
    let frame = Buffer.alloc(0), forwarded = false;
    downstream.on('data', chunk => {
      frame = Buffer.concat([frame, chunk]);
      if (forwarded || frame.length < 4 || frame.length < frame.readUInt32LE(0) + 4) return;
      forwarded = true;
      void (async () => {
        for (let offset = 0; offset < frame.length;) {
          const size = offset < 4 ? 2 : 1024;
          upstream.write(frame.subarray(offset, offset + size));
          offset += size;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      })();
    });
  });
  await new Promise(resolve => proxy.listen(proxyPath, resolve));
  const call = async (operation, ...args) => JSON.parse((await exec(binary,
    ['account', operation, '--socket', proxyPath, ...args], { timeout: 20000, maxBuffer: 1024 * 1024 })).stdout);
  let proposal;
  try {
    const staged = await call('stage', '--path', 'large.txt', '--lines', '1-1000', '--author', 'framing-test');
    proposal = staged.file;
    const content = 'Fragmented account commit test\n'.repeat(4096);
    fs.writeFileSync(proposal, content);
    await call('commit', '--ticket', staged.ticket, '--file', proposal, '--author', 'framing-test');
    assert.equal(fs.readFileSync(path.join(root, 'large.txt'), 'utf8'), content);
    await call('abort', '--ticket', staged.ticket);
    console.log('PASS: fragmented headers and 120 KiB commit round-trip through the real account bridge');
  } finally {
    proxy.close();
    if (proposal) for (const file of [proposal, proposal + '.alock']) fs.rmSync(file, { force: true });
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function main() {
  const binary = process.env.FIZZER_ALOCK_BIN || require('../cascade-electron/awatch.cjs').alockBinary();
  const root = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'alock-frame-host-'));
  fs.chmodSync(root, 0o755);
  const endpoint = path.join(root, 'socket');
  const server = spawn(binary, ['account', 'serve', '--root', root, '--user', 'fizzer', '--socket', endpoint, '--control-stdin'], { stdio: ['pipe', 'pipe', 'inherit'] });
  try {
    const lines = readline.createInterface({ input: server.stdout });
    await new Promise((resolve, reject) => {
      lines.once('line', line => { assert.equal(JSON.parse(line).ready, true); resolve(); });
      server.once('error', reject);
      server.once('exit', code => reject(new Error(`Bridge exited ${code}`)));
    });
    const result = spawnSync('sudo', ['-n', '-H', '-u', 'fizzer', '--', process.execPath, __filename,
      '--client', root, endpoint, binary], { stdio: 'inherit', timeout: 30000 });
    assert.equal(result.status, 0, 'Framed requests must survive delayed chunks');
  } finally {
    server.stdin.end();
    await new Promise(resolve => server.once('exit', resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
(process.argv[2] === '--client' ? client(...process.argv.slice(3)) : main())
  .catch(error => { console.error(error); process.exitCode = 1; });
