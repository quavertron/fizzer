const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const account = require('./agent-account.cjs');
const { offerAgentAccountSetup } = require('./agent-account-setup.cjs');

test('remote runs use the reconciled mirror even with an invalid profile workspace', async () => {
  const mirrorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-workspace-'));
  const calls = [];
  const mirror = { root: mirrorRoot };
  const host = { watch: config => { calls.push(config); return mirror; },
    reconcile: async entry => { assert.equal(entry, mirror); calls.push('synced'); } };
  try {
    for (const origin of ['https://vault.example', 'http://localhost:3000']) {
      const result = await account.prepareWorkspace({ remoteVault: true, vaultId: 'v1',
        cwd: '/missing/profile/workspace', vaultRoot: '/data' },
      { url: origin, token: 'read', writeToken: 'write' }, host);
      assert.deepEqual(result, { root: fs.realpathSync(mirrorRoot), remote: true });
      assert.equal(calls.at(-2).token, 'write');
      assert.equal(calls.at(-1), 'synced');
    }
    await assert.rejects(account.prepareWorkspace({ remoteVault: true }, {}, host), /authenticated mirror/);
    await assert.rejects(account.prepareWorkspace({ vaultId: 'v1', cwd: os.homedir() },
      { url: 'https://vault.example', token: 'token' },
      { ...host, reconcile: async () => { throw new Error('mirror unavailable'); } }), /mirror unavailable/);
  } finally { fs.rmSync(mirrorRoot, { recursive: true, force: true }); }
});

test('account runner resolves stale fizzer workspace through legacy cascade path', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'account-legacy-root-'));
  const legacy = path.join(parent, '.cascade', 'vaults', 'one');
  fs.mkdirSync(legacy, { recursive: true });
  try {
    assert.equal(account.resolveWorkspace(path.join(parent, '.fizzer', 'vaults', 'one')), fs.realpathSync(legacy));
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('account runner maps remote container workspace to a local directory', () => {
  const previous = process.env.FIZZER_AGENT_WORKSPACE;
  process.env.FIZZER_AGENT_WORKSPACE = os.tmpdir();
  try {
    assert.equal(account.resolveWorkspace('/data'), fs.realpathSync(os.tmpdir()));
    assert.equal(account.resolveWorkspace('/var/lib/cascade/vaults/demo'), fs.realpathSync(os.tmpdir()));
  } finally {
    if (previous === undefined) delete process.env.FIZZER_AGENT_WORKSPACE;
    else process.env.FIZZER_AGENT_WORKSPACE = previous;
  }
});

test('explicit Settings setup remains available after TUI decline without changing installation state', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'account-state-'));
  const previous = process.env.CASCADE_DATA_DIR;
  process.env.CASCADE_DATA_DIR = directory;
  try {
    assert.equal(account.shouldOffer(), process.platform !== 'win32');
    if (process.platform === 'win32') return;
    let copied;
    await offerAgentAccountSetup({
      dialog: { showMessageBox: async () => ({ response: 0 }) },
      clipboard: { writeText: text => { copied = text; } }, packaged: true, resourcesPath: '/Applications/Fizzer App/Resources',
    });
    assert.match(copied, /embedded-runtime\/agent-account-setup\/install-agent-writes.sh/);
    assert.match(copied, /'\/Applications\/Fizzer App/);
    assert.equal(account.shouldOffer(), true);
    account.decline();
    assert.equal(account.shouldOffer(), false);
    const before = fs.readdirSync(directory);
    let shown = 0;
    await offerAgentAccountSetup({
      dialog: { showMessageBox: async (_window, options) => {
        shown++;
        assert.deepEqual(options.buttons, ['Copy setup command', 'Close']);
        assert.match(options.detail, /sudo in your terminal/);
        return { response: 1 };
      } }, clipboard: { writeText: () => assert.fail('Close must not copy') },
      packaged: false,
    });
    assert.equal(shown, 1);
    assert.deepEqual(fs.readdirSync(directory), before);
    assert.equal(account.enabled(), false);
    fs.writeFileSync(path.join(directory, 'agent-writes-enabled'), '1\n');
    assert.equal(account.enabled(), true);
  } finally {
    if (previous === undefined) delete process.env.CASCADE_DATA_DIR; else process.env.CASCADE_DATA_DIR = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('desktop setup has only an explicit IPC caller, not a startup offer', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  assert.equal((source.match(/offerAgentAccountSetup\(/g) || []).length, 1);
  assert.match(source, /ipcMain\.handle\('agent:showAccountSetup'[\s\S]*?offerAgentAccountSetup/);
  const startup = source.slice(source.indexOf('app.whenReady()'));
  assert.doesNotMatch(startup, /offerAgentAccountSetup/);
});

test('launch always drops to fizzer without password collection or human HOME overrides', () => {
  const args = account.launchArguments('/node', '/worker', '/bridge/socket');
  assert.deepEqual(args.slice(0, 6), ['-n', '-H', '-u', 'fizzer', '--', '/usr/bin/env']);
  assert.ok(args.includes('FIZZER_BRIDGE_SOCKET=/bridge/socket'));
  assert.ok(!args.some(value => value.startsWith('HOME=') || value.startsWith('CODEX_HOME=')));
  assert.ok(!args.includes('-S'));
});

test('launch passes the human Antigravity executable to the fizzer account', () => {
  const old = process.env.ANTIGRAVITY_BIN;
  process.env.ANTIGRAVITY_BIN = '/Users/example/.gemini/antigravity/bin/agentapi';
  try {
    const args = account.launchArguments('/usr/bin/node', '/tmp/worker.cjs', '/tmp/socket');
    assert.ok(args.includes('ANTIGRAVITY_BIN=/Users/example/.gemini/antigravity/bin/agentapi'));
  } finally {
    if (old === undefined) delete process.env.ANTIGRAVITY_BIN;
    else process.env.ANTIGRAVITY_BIN = old;
  }
});

test('launch resolves the Go storage helper for the worker without discovering the LS in cjs', () => {
  const oldAddress = process.env.ANTIGRAVITY_LS_ADDRESS;
  const oldToken = process.env.ANTIGRAVITY_CSRF_TOKEN;
  delete process.env.ANTIGRAVITY_LS_ADDRESS;
  delete process.env.ANTIGRAVITY_CSRF_TOKEN;
  try {
    const args = account.launchArguments('/usr/bin/node', '/tmp/worker.cjs', '/tmp/socket');
    assert.ok(Array.isArray(args));
    assert.ok(!args.some(v => v.startsWith('ANTIGRAVITY_LS_ADDRESS=')));
    assert.ok(!args.some(v => v.startsWith('ANTIGRAVITY_CSRF_TOKEN=')));
    // Worker discovers/ensures via `fizzer-storage antigravity-ls ensure` (Go).
    const storage = args.find(v => v.startsWith('FIZZER_STORAGE_BIN='));
    if (fs.existsSync(path.join(__dirname, '..', '.native-tools', 'fizzer-storage'))) {
      assert.ok(storage, 'dev build must pass FIZZER_STORAGE_BIN to the worker');
    }
  } finally {
    if (oldAddress !== undefined) process.env.ANTIGRAVITY_LS_ADDRESS = oldAddress;
    if (oldToken !== undefined) process.env.ANTIGRAVITY_CSRF_TOKEN = oldToken;
  }
});
