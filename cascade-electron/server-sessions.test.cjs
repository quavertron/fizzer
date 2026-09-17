const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readSessions, rememberSession, listConnections } = require('./server-sessions.cjs');

test('server logins persist independently without any vault registrations', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fizzer-server-sessions-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  rememberSession(directory, 'local', 'local-token');
  rememberSession(directory, 'https://remote.example', 'remote-token');
  rememberSession(directory, 'https://remote.example', 'renewed-token');
  assert.deepEqual(readSessions(directory), { local: 'local-token', 'https://remote.example': 'renewed-token' });
  assert.deepEqual(listConnections(directory, []), [
    { id: '', name: 'remote.example', origin: 'https://remote.example', local: false, hasSession: true },
  ]);
  const vault = { id: 'vault', name: 'My vault', origin: 'https://remote.example', token: 'secret' };
  assert.deepEqual(listConnections(directory, [vault]), [
    { id: 'vault', name: 'remote.example', origin: 'https://remote.example', local: false, hasSession: true },
  ]);
  if (process.platform !== 'win32') {
    for (const name of fs.readdirSync(path.join(directory, 'server-sessions'))) {
      assert.equal(fs.statSync(path.join(directory, 'server-sessions', name)).mode & 0o777, 0o600);
    }
  }
});

test('the connection list is one row per server with the local instance first', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fizzer-connections-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  rememberSession(directory, 'local', 'local-token');
  rememberSession(directory, 'https://b.example', 'b-token');
  const vaults = [
    { id: 'v1', name: 'One', origin: 'https://a.example', token: 'a-token' },
    { id: 'v2', name: 'Two', origin: 'https://a.example', token: 'a-token' },
  ];
  assert.deepEqual(listConnections(directory, vaults, { localOrigin: 'http://127.0.0.1:3000' }), [
    { id: '', name: 'This Mac', origin: 'http://127.0.0.1:3000', local: true, hasSession: true },
    { id: 'v1', name: 'a.example', origin: 'https://a.example', local: false, hasSession: true },
    { id: '', name: 'b.example', origin: 'https://b.example', local: false, hasSession: true },
  ]);
  // Without an embedded backend the 'local' session key has no origin to show.
  assert.deepEqual(listConnections(directory, [], {}).map(c => c.name), ['b.example']);
  // A vault without a stored session still appears, marked as needing sign-in.
  assert.deepEqual(listConnections(directory, [{ id: 'v3', name: 'Three', origin: 'https://c.example', token: '' }], {}), [
    { id: '', name: 'b.example', origin: 'https://b.example', local: false, hasSession: true },
    { id: 'v3', name: 'c.example', origin: 'https://c.example', local: false, hasSession: false },
  ]);
});

test('unwritable session storage keeps authenticated connections usable in memory', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fizzer-session-failure-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  // A regular file in place of the directory reliably fails on every platform,
  // including tests run as an administrator.
  fs.writeFileSync(path.join(directory, 'server-sessions'), 'blocked');
  assert.equal(rememberSession(directory, 'https://remote.example', 'authenticated'), false);
  assert.equal(readSessions(directory)['https://remote.example'], 'authenticated');
  assert.equal(listConnections(directory, [])[0].origin, 'https://remote.example');
  fs.unlinkSync(path.join(directory, 'server-sessions'));
  assert.equal(rememberSession(directory, 'https://remote.example', 'renewed'), true);
  assert.equal(readSessions(directory)['https://remote.example'], 'renewed');
});
