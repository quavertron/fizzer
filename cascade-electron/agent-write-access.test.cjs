const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { save, roots } = require('./agent-write-access.cjs');

test('local grants isolate server, vault and registration; defaults stay workspace-only', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'write-access-'));
  const previous = process.env.CASCADE_DATA_DIR;
  process.env.CASCADE_DATA_DIR = directory;
  const opts = { vaultId: 'vault', chatRegistrationId: 'agent' };
  const api = { url: 'http://localhost:3000' };
  try {
    assert.deepEqual(roots(opts, api, '/workspace'), ['/workspace']);
    save(api.url, 'vault', 'agent', { scope: 'human' });
    assert.deepEqual(roots(opts, api, '/workspace'), ['/']);
    assert.deepEqual(roots({ ...opts, chatRegistrationId: 'other' }, api, '/workspace'), ['/workspace']);
    assert.deepEqual(roots({ ...opts, vaultId: 'other' }, api, '/workspace'), ['/workspace']);
    assert.deepEqual(roots(opts, { url: 'http://localhost:3001' }, '/workspace'), ['/workspace']);
    save(api.url, 'vault', 'agent', { scope: 'folders', folders: [directory] });
    assert.deepEqual(roots(opts, api, '/workspace'), [fs.realpathSync(directory)]);
    save(api.url, 'vault', 'agent', { scope: 'workspace' });
    assert.deepEqual(roots(opts, api, '/workspace'), ['/workspace']);
    assert.throws(() => save(api.url, 'vault', 'agent', { scope: 'folders', folders: ['relative'] }));
    const defaultFile = path.join(directory, 'agent-write-access-default.json');
    fs.writeFileSync(defaultFile, '{"scope":"human"}');
    assert.deepEqual(roots({}, {}, '/workspace'), ['/']);
    assert.deepEqual(roots({ ...opts, chatRegistrationId: 'new-agent' }, api, '/workspace'), ['/']);
    assert.deepEqual(roots(opts, { url: 'http://localhost:9999' }, '/workspace'), ['/']);
    assert.deepEqual(roots(opts, api, '/workspace'), ['/workspace']);
    fs.writeFileSync(defaultFile, '{broken');
    assert.throws(() => roots({}, {}, '/workspace'));
    assert.deepEqual(roots(opts, api, '/workspace'), ['/workspace']);
    const file = path.join(directory, 'agent-write-access', fs.readdirSync(path.join(directory, 'agent-write-access'))[0]);
    fs.writeFileSync(file, '{broken');
    assert.throws(() => roots(opts, api, '/workspace'));
  } finally {
    if (previous === undefined) delete process.env.CASCADE_DATA_DIR; else process.env.CASCADE_DATA_DIR = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
