'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { VaultMirrors } = require('./vault-mirror.cjs');

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
