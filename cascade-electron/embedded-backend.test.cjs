const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { startEmbeddedBackend, existingBackend } = require('./embedded-backend.cjs');

test('reuses a healthy backend for the same database and leaves it running on quit', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fizzer-backend-reuse-'));
  const server = http.createServer((_request, response) => { response.writeHead(200); response.end('{"status":"ok"}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(directory, 'local-backend.json'), JSON.stringify({ origin, pid: process.pid, database: path.join(directory, 'docs.db') }));
  // No release is present: this must attach without attempting to spawn one.
  const backend = await startEmbeddedBackend({ env: { CASCADE_DATA_DIR: directory } });
  assert.equal(backend.origin, origin);
  assert.equal(backend.process, null);
  backend.stop();
  assert.equal((await fetch(`${origin}/api/health`)).status, 200);
  fs.writeFileSync(path.join(directory, 'local-backend.json'), JSON.stringify({ origin, pid: process.pid, database: '/different/docs.db' }));
  await assert.rejects(existingBackend(directory, 1), /does not match/);
});

test('a live but unhealthy backend blocks starting another one', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fizzer-backend-unhealthy-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'local-backend.json'), JSON.stringify({ origin: 'http://127.0.0.1:1', pid: process.pid, database: path.join(directory, 'docs.db') }));
  await assert.rejects(existingBackend(directory, 1), /already owns.*not healthy/);
});
