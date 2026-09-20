'use strict';
// Invoked by the Elixir integration test with a disposable vault and real rclone.
const { io } = require('socket.io-client');
const { VaultMirrors } = require('../cascade-electron/vault-mirror.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const [origin, token, vaultId] = process.argv.slice(2);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fizzer-mirror-e2e-'));
const host = new VaultMirrors({ directory });
const entry = host.watch({ origin, token, vaultId });
const socket = io(origin + '/vault', { auth: { token }, transports: ['websocket'], reconnection: false });
const output = value => process.stdout.write(JSON.stringify(value) + '\n');
const contents = () => fs.readFileSync(path.join(entry.root, 'mirror-probe.txt'), 'utf8');
let pid, phase = 0;
async function cleanup() {
  socket.disconnect(); await host.close(); fs.rmSync(directory, { recursive: true, force: true });
}
async function fail(error) { output({ error: error.message }); await cleanup(); process.exit(1); }
socket.on('connect', async () => {
  socket.emit('joinVault', vaultId);
    try {
      await host.reconcile(entry);
      if (phase === 0) {
        if (contents() !== 'one') throw new Error('Initial download failed');
        pid = host.child.pid; phase = 1; output({ ready: true });
      } else if (phase === 2) {
        if (contents() !== 'tri' || host.child.pid !== pid) throw new Error('Reconnect reconciliation failed');
        await cleanup(); output({ done: true }); process.exit(0);
      }
    } catch (error) { await fail(error); }
});
socket.on('connect_error', fail);
socket.on('vault:filesChanged', async data => {
  if (data.vaultId !== vaultId || phase !== 1) return;
  try {
    await host.reconcile(entry);
    if (contents() !== 'two' || host.child.pid !== pid) throw new Error('Broadcast download failed');
    socket.disconnect(); phase = 2; output({ disconnected: true });
  } catch (error) { await fail(error); }
});
readline.createInterface({ input: process.stdin }).on('line', line => {
  if (line === 'reconnect') socket.connect();
});
setTimeout(() => fail(new Error('Mirror integration timed out')), 20000).unref();
