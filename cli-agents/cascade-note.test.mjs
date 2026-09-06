import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cascade-note');

test('regular notes can be renamed and deleted by title', async (t) => {
  const requests = [];
  let title = 'Old title';
  const note = () => ({
    id: 'note-1',
    vault_id: 'vault-1',
    title,
    content: 'Body',
  });

  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({
      method: req.method,
      url: req.url,
      body: body ? JSON.parse(body) : null,
    });

    res.setHeader('content-type', 'application/json');
    const { pathname, searchParams } = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && pathname === '/api/vaults/vault-1/notes') {
      // Mirror the server-side title filters the CLI relies on.
      const exact = searchParams.get('title');
      const partial = searchParams.get('title_contains');
      const matches = [note()].filter((n) => {
        if (exact !== null) return n.title.toLowerCase() === exact.toLowerCase();
        if (partial !== null) return n.title.toLowerCase().includes(partial.toLowerCase());
        return true;
      });
      res.end(JSON.stringify({ notes: matches }));
    } else if (req.method === 'GET' && req.url === '/api/notes/note-1') {
      res.end(JSON.stringify({ note: note() }));
    } else if (req.method === 'POST' && req.url === '/api/notes/note-1/rename') {
      title = JSON.parse(body).title;
      res.end(JSON.stringify({ note: note() }));
    } else if (req.method === 'DELETE' && req.url === '/api/notes/note-1') {
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');
  const targetArgs = [
    '--url',
    `http://127.0.0.1:${address.port}`,
    '--token',
    'test-token',
    '--vault',
    'vault-1',
  ];

  const renamed = await execFileAsync(process.execPath, [
    cli,
    'rename',
    'Old title',
    '--title',
    'New title',
    '--json',
    ...targetArgs,
  ]);
  assert.equal(JSON.parse(renamed.stdout).title, 'New title');

  const deleted = await execFileAsync(process.execPath, [
    cli,
    'delete',
    'New title',
    '--json',
    ...targetArgs,
  ]);
  assert.deepEqual(JSON.parse(deleted.stdout), {
    ok: true,
    note: note(),
  });

  assert.deepEqual(
    requests.map(({ method, url }) => `${method} ${url}`),
    [
      'GET /api/vaults/vault-1/notes?title=Old%20title',
      'POST /api/notes/note-1/rename',
      'GET /api/vaults/vault-1/notes?title=New%20title',
      'GET /api/notes/note-1',
      'DELETE /api/notes/note-1',
    ],
  );
  assert.deepEqual(requests[1].body, { title: 'New title' });
});

test('folders can be created and notes moved into them by name', async (t) => {
  const requests = [];
  const note = { id: 'note-1', vault_id: 'vault-1', title: 'Research', content: 'Body' };
  const folders = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
    res.setHeader('content-type', 'application/json');
    const { pathname, searchParams } = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && pathname === '/api/vaults/vault-1/folders') {
      res.end(JSON.stringify({ folders }));
    } else if (req.method === 'POST' && pathname === '/api/vaults/vault-1/folders') {
      const folder = { id: 'folder-docs', vault_id: 'vault-1', parent_id: null, ...JSON.parse(body) };
      folders.push(folder);
      res.statusCode = 201;
      res.end(JSON.stringify({ folder }));
    } else if (req.method === 'GET' && pathname === '/api/vaults/vault-1/notes') {
      const matches = searchParams.get('title') === 'Research' ? [note] : [];
      res.end(JSON.stringify({ notes: matches }));
    } else if (req.method === 'POST' && pathname === '/api/notes/note-1/move') {
      res.end(JSON.stringify({ note: { ...note, folder_id: JSON.parse(body).folder_id, is_listed: 1 } }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');
  const targetArgs = ['--url', `http://127.0.0.1:${address.port}`, '--token', 'test-token', '--vault', 'vault-1'];

  const created = await execFileAsync(process.execPath, [cli, 'folder', 'create', 'docs', '--json', ...targetArgs]);
  assert.equal(JSON.parse(created.stdout).id, 'folder-docs');
  const moved = await execFileAsync(process.execPath, [cli, 'move', 'Research', '--folder', 'docs', '--json', ...targetArgs]);
  assert.equal(JSON.parse(moved.stdout).folder_id, 'folder-docs');
  assert.deepEqual(requests.map(({ method, url }) => `${method} ${url}`), [
    'POST /api/vaults/vault-1/folders',
    'GET /api/vaults/vault-1/notes?title=Research',
    'GET /api/vaults/vault-1/folders',
    'POST /api/notes/note-1/move',
  ]);
  assert.deepEqual(requests[0].body, { name: 'docs' });
  assert.deepEqual(requests[3].body, { folder_id: 'folder-docs' });
});

test('vault deletion binds full ID, exact name, owner source and run, then verifies absence', async (t) => {
  let deleted = false;
  const writes = [];
  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && req.url === '/api/vaults') {
      res.end(JSON.stringify({ vaults: deleted ? [] : [{ id: 'target-id', name: 'QA' }] }));
    } else if (req.method === 'DELETE' && req.url === '/api/vaults/target-id') {
      let body = '';
      for await (const chunk of req) body += chunk;
      writes.push({ body: JSON.parse(body), run: req.headers['x-cascade-run-id'] });
      deleted = true;
      res.end(JSON.stringify({ success: true }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const env = { ...process.env, CASCADE_HELPER_CONFIG: '/nonexistent', CASCADE_RUN_ID: '42', CASCADE_NOTE_VAULT: 'current' };
  const args = [cli, 'vault', 'delete', 'target-id', '--confirm-name', 'QA', '--authority-message', 'owner-msg', '--url', `http://127.0.0.1:${server.address().port}`, '--token', 'agent', '--json'];
  await assert.rejects(execFileAsync(process.execPath, args.map((v) => v === 'QA' ? 'wrong' : v), { env }), /exact name do not match/);
  await assert.rejects(execFileAsync(process.execPath, args, { env: { ...env, CASCADE_NOTE_VAULT: 'target-id' } }), /current vault/);
  const { stdout } = await execFileAsync(process.execPath, args, { env });
  assert.equal(JSON.parse(stdout).verifiedAbsent, true);
  assert.deepEqual(writes, [{ body: { expectedName: 'QA', authorityMessageId: 'owner-msg' }, run: '42' }]);
});
