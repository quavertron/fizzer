'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { VaultMirrors } = require('./vault-mirror.cjs');

const keyFor = (origin, vaultId) => createHash('sha256').update(JSON.stringify([origin, vaultId])).digest('hex');

test('mirror records persist and a restarted host restores entries without syncing', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-persist-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const first = new VaultMirrors({ directory });
  const original = first.watch({ origin: 'https://example.test', token: 'secret', vaultId: 'vault' });
  await first.close();

  const record = path.join(directory, 'mirrors', `${original.key}.json`);
  assert.deepEqual(JSON.parse(fs.readFileSync(record, 'utf8')), { origin: 'https://example.test', vaultId: 'vault' });

  const errors = [];
  const second = new VaultMirrors({ directory, onError: error => errors.push(error) });
  t.after(async () => { await second.close(); });
  const jobs = [];
  second.start = async () => { throw new Error('restore must not launch rclone'); };
  second.call = async operation => { if (operation === 'sync/sync') { jobs.push(operation); return { jobid: 1 }; } return { finished: true, success: true }; };

  second.restore();
  const restored = second.entries.get(original.key);
  assert.deepEqual(errors, []);
  assert.equal(second.entries.size, 1);
  assert.equal(restored.root, original.root);
  assert.equal(restored.vaultId, 'vault');
  assert.equal(restored.token, null);
  assert.equal(restored.dirty, false, 'restore must stay lazy and leave reconciliation to the next notification');
  assert.deepEqual(jobs, []);
});

test('orphaned mirror roots are pruned while connected ones are adopted', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-prune-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const origin = 'https://example.test';
  const vaultId = 'adopted';
  const key = keyFor(origin, vaultId);
  const orphan = 'f'.repeat(64);
  fs.mkdirSync(path.join(directory, 'mirrors', key), { recursive: true });
  fs.mkdirSync(path.join(directory, 'mirrors', orphan), { recursive: true });
  fs.writeFileSync(path.join(directory, 'mirrors', orphan, 'stale.txt'), 'stale');
  fs.mkdirSync(path.join(directory, 'remote-vaults'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'remote-vaults', `${key}.json`),
    JSON.stringify({ id: vaultId, name: 'Adopted', origin, token: 'stored' }));

  const host = new VaultMirrors({ directory });
  t.after(async () => { await host.close(); });
  host.restore();

  assert.equal(fs.existsSync(path.join(directory, 'mirrors', orphan)), false, 'a root with no surviving record is discarded');
  assert.equal(fs.existsSync(path.join(directory, 'mirrors', key)), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'mirrors', `${key}.json`), 'utf8')), { origin, vaultId });
  assert.equal(host.entries.get(key)?.vaultId, vaultId);
  assert.equal(host.entries.get(orphan), undefined);
});

test('a restored mirror without a credential defers instead of spawning rclone', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-token-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const origin = 'https://example.test';
  const vaultId = 'vault';
  const key = keyFor(origin, vaultId);
  fs.mkdirSync(path.join(directory, 'mirrors', key), { recursive: true });
  fs.writeFileSync(path.join(directory, 'mirrors', `${key}.json`), JSON.stringify({ origin, vaultId }));

  const host = new VaultMirrors({ directory });
  t.after(async () => { await host.close(); });
  host.restore();
  const entry = host.entries.get(key);
  assert.ok(entry);

  let starts = 0;
  host.start = async () => { starts++; };
  host.call = async operation => {
    if (operation === 'sync/sync') return { jobid: 1 };
    return { finished: true, success: true };
  };

  await host.reconcile(entry);
  assert.equal(starts, 0, 'rclone must not start just to collect 403s');
  assert.equal(entry.dirty, true, 'the mirror stays dirty so the next watch can finish it');

  host.watch({ origin, token: 'secret', vaultId });
  await host.reconcile(entry);
  assert.equal(starts, 1);
  assert.equal(entry.dirty, false);
});

test('notifications coalesce, changes during a sync run again, and direction is fixed', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-unit-'));
  const host = new VaultMirrors({ directory });
  t.after(async () => { await host.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  host.start = async () => {};
  const jobs = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  host.call = async (operation, body) => {
    if (operation === 'sync/sync') { jobs.push(body); return { jobid: jobs.length }; }
    if (jobs.length === 1) await gate;
    return { finished: true, success: true };
  };
  const entry = host.watch({ origin: 'https://example.test', token: 'secret', vaultId: 'vault' });
  const running = host.reconcile(entry);
  await new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i < 50; i++) host.notify(entry);
  release();
  await running;
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].srcFs.type, 'http');
  assert.equal(jobs[0].srcFs.url, 'https://example.test/api/vaults/vault/mirror/');
  assert.equal(jobs[0].dstFs, entry.root);
  assert.ok(entry.root.startsWith(path.join(directory, 'mirrors') + path.sep));
});

test('rclone is rediscovered after installation or a failed launch', {
  skip: !process.env.FIZZER_RCLONE_BIN,
}, async t => {
  const binary = process.env.FIZZER_RCLONE_BIN;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-install-'));
  const host = new VaultMirrors({ directory });
  t.after(async () => {
    process.env.FIZZER_RCLONE_BIN = binary;
    await host.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  process.env.FIZZER_RCLONE_BIN = path.join(directory, 'not-installed');
  await assert.rejects(host.start(), /Cannot start rclone.*ENOENT/);
  process.env.FIZZER_RCLONE_BIN = binary;
  await host.start();
  assert.ok(host.child.pid);
  await host.call('rc/noop', {});
});

test('real rclone daemon reuses its PID, mirrors same-size edits and deletions, never uploads', {
  skip: !process.env.FIZZER_RCLONE_BIN,
}, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-real-'));
  const files = new Map([['note.txt', 'first'], ['gone.txt', 'gone']]);
  const methods = [];
  let denied = false;
  const server = http.createServer((req, res) => {
    methods.push(req.method);
    if (denied || req.headers.authorization !== 'Bearer private') { res.writeHead(403); res.end(); return; }
    const name = decodeURIComponent(req.url.split('/').pop());
    if (!name) {
      const body = [...files.keys()].map(name => `<a href="${encodeURIComponent(name)}">file</a>`).join('\n');
      res.writeHead(200, { 'content-type': 'text/html', 'content-length': Buffer.byteLength(body) }); res.end(body); return;
    }
    if (!files.has(name)) { res.writeHead(404); res.end(); return; }
    const body = files.get(name);
    res.writeHead(200, { 'content-length': Buffer.byteLength(body), 'last-modified': 'Sat, 19 Sep 2026 00:00:00 GMT' });
    res.end(req.method === 'HEAD' ? '' : body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const host = new VaultMirrors({ directory });
  t.after(async () => {
    await host.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const entry = host.watch({ origin: `http://127.0.0.1:${server.address().port}`, token: 'private', vaultId: 'vault' });
  await host.reconcile(entry);
  const pid = host.child.pid;
  assert.equal(fs.readFileSync(path.join(entry.root, 'note.txt'), 'utf8'), 'first');
  files.set('note.txt', 'later'); files.delete('gone.txt');
  fs.writeFileSync(path.join(entry.root, 'local-only'), 'must not upload');
  await host.reconcile(entry);
  assert.equal(host.child.pid, pid);
  assert.equal(fs.readFileSync(path.join(entry.root, 'note.txt'), 'utf8'), 'later');
  assert.equal(fs.existsSync(path.join(entry.root, 'gone.txt')), false);
  assert.equal(fs.existsSync(path.join(entry.root, 'local-only')), false);
  denied = true;
  await assert.rejects(host.reconcile(entry));
  assert.equal(fs.readFileSync(path.join(entry.root, 'note.txt'), 'utf8'), 'later');
  assert.ok(methods.every(method => ['GET', 'HEAD'].includes(method)));
  assert.equal(files.has('local-only'), false);
  denied = false;
  const child = host.child;
  await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); });
  await host.reconcile(entry);
  assert.notEqual(host.child.pid, pid);
  assert.equal(fs.readFileSync(path.join(entry.root, 'note.txt'), 'utf8'), 'later');
});
