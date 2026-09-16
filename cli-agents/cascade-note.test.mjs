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

test('cascade-note read/show/view/cat aliases get and resolves typos like nab for Navigation & Search', async (t) => {
  const noteId = '86bd621e-f26a-4334-8762-08526d86df07';
  const note = {
    id: noteId,
    vault_id: 'vault-1',
    title: 'Navigation & Search',
    content: 'Navigation content here',
  };
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    const { pathname, searchParams } = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && pathname === '/api/vaults/vault-1/notes') {
      const exact = searchParams.get('title');
      const partial = searchParams.get('title_contains');
      if (exact && note.title.toLowerCase() === exact.toLowerCase()) {
        return res.end(JSON.stringify({ notes: [note] }));
      }
      if (partial && note.title.toLowerCase().includes(partial.toLowerCase())) {
        return res.end(JSON.stringify({ notes: [note] }));
      }
      if (exact || partial) {
        return res.end(JSON.stringify({ notes: [] }));
      }
      return res.end(JSON.stringify({ notes: [note] }));
    }
    if (req.method === 'GET' && pathname === `/api/notes/${noteId}`) {
      return res.end(JSON.stringify({ note }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const targetArgs = [
    '--url', `http://127.0.0.1:${server.address().port}`,
    '--token', 'test-token',
    '--vault', 'vault-1',
  ];

  const readExact = await execFileAsync(process.execPath, [cli, 'read', 'Navigation & Search', ...targetArgs]);
  assert.equal(readExact.stdout.trim(), 'Navigation content here');

  const readFuzzy = await execFileAsync(process.execPath, [cli, 'read', 'nab', ...targetArgs]);
  assert.equal(readFuzzy.stdout.trim(), 'Navigation content here');

  const show = await execFileAsync(process.execPath, [cli, 'show', noteId, ...targetArgs]);
  assert.equal(show.stdout.trim(), 'Navigation content here');

  const cat = await execFileAsync(process.execPath, [cli, 'cat', 'Navigation', ...targetArgs]);
  assert.equal(cat.stdout.trim(), 'Navigation content here');
});

test('wiki setup is vault-scoped and disabling needs no surviving registration', async (t) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    requests.push({ method: req.method, url: req.url, body: text ? JSON.parse(text) : null });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ enabled: false }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const common = ['--url', `http://127.0.0.1:${server.address().port}`, '--token', 'test', '--vault', 'vault-1'];
  await execFileAsync(process.execPath, [cli, 'wiki', 'enable', '--channel', 'channel-1', '--registration', 'agent-1', ...common]);
  await execFileAsync(process.execPath, [cli, 'wiki', 'status', ...common]);
  await execFileAsync(process.execPath, [cli, 'wiki', 'disable', ...common]);
  assert.deepEqual(requests, [
    { method: 'PUT', url: '/api/vaults/vault-1/wiki-maintenance', body: { enabled: true, channelId: 'channel-1', registrationId: 'agent-1' } },
    { method: 'GET', url: '/api/vaults/vault-1/wiki-maintenance', body: null },
    { method: 'PUT', url: '/api/vaults/vault-1/wiki-maintenance', body: { enabled: false } },
  ]);
});
