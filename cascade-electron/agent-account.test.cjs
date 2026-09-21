const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
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

test('launch discovers and passes Antigravity language server address and CSRF token', () => {
  const oldAddress = process.env.ANTIGRAVITY_LS_ADDRESS;
  const oldToken = process.env.ANTIGRAVITY_CSRF_TOKEN;
  delete process.env.ANTIGRAVITY_LS_ADDRESS;
  delete process.env.ANTIGRAVITY_CSRF_TOKEN;
  try {
    const args = account.launchArguments('/usr/bin/node', '/tmp/worker.cjs', '/tmp/socket');
    assert.ok(Array.isArray(args));
    if (process.platform === 'darwin') {
      const hasLs = args.some(v => v.startsWith('ANTIGRAVITY_LS_ADDRESS='));
      const hasCsrf = args.some(v => v.startsWith('ANTIGRAVITY_CSRF_TOKEN='));
      assert.equal(hasLs, hasCsrf);
    }
  } finally {
    if (oldAddress !== undefined) process.env.ANTIGRAVITY_LS_ADDRESS = oldAddress;
    if (oldToken !== undefined) process.env.ANTIGRAVITY_CSRF_TOKEN = oldToken;
  }
});

test('missing vault reports terminal failure before worker startup', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'missing-vault-'));
  const events = [];
  try {
    await assert.rejects(account.run({ runId: 1507, vaultRoot: path.join(directory, 'missing') },
      event => events.push(event), {}), { code: 'ENOENT' });
    assert.equal(events.length, 1);
    assert.equal(events[0].runId, 1507);
    assert.equal(events[0].type, 'status');
    const payload = JSON.parse(events[0].payload_json);
    assert.equal(payload.status, 'failed');
    assert.match(payload.summary, /ENOENT/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

for (const bridgeExit of [0, 1, 2, 3]) test(`account run cleans up and reports bridge exit ${bridgeExit}`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'account-run-'));
  const previousData = process.env.CASCADE_DATA_DIR;
  process.env.CASCADE_DATA_DIR = root;
  const calls = [];
  const concludes = [];
  let activity, viewerClosed = false;
  function spawn(command, args) {
    calls.push({ command, args });
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.exitCode = null;
    child.kill = () => {
      if (child.exitCode === null) {
        child.exitCode = command.endsWith('/alock') ? bridgeExit : 0;
        child.emit('exit', child.exitCode); child.emit('close', child.exitCode);
      }
    };
    if (command.endsWith('/alock')) {
      child.stdin.on('data', chunk => concludes.push(String(chunk)));
      setImmediate(() => {
        if (bridgeExit >= 2) {
          child.stderr.write(bridgeExit === 2 ? 'usage:\n alock bridge serve --socket <path>\n' : 'alock: unknown command\n');
          child.kill();
        } else child.stdout.write('{"ready":true,"session":"own-bridge"}\n');
      });
    }
    else {
      let input = '';
      child.stdin.on('data', chunk => { input += chunk; });
      child.stdin.on('finish', () => setImmediate(() => {
        assert.equal(JSON.parse(input).opts.runId, 123);
        assert.equal(JSON.parse(input).opts.cwd, fs.realpathSync(root));
        assert.equal(JSON.parse(input).root, fs.realpathSync(root));
        activity({ events: [
          { kind: 'edit', agent: 'another-bridge', file: '/private/unrelated', old_lines: [], new_lines: ['secret'] },
          { kind: 'edit', agent: 'own-bridge', author: 'Codex', file: '/local/test', old_lines: ['before'], new_lines: ['after'] },
        ] });
        child.stdout.write(JSON.stringify({ event: { type: 'assistant-turn-end' } }) + '\n');
        child.stdout.write(JSON.stringify({ event: { type: 'assistant-turn-end' } }) + '\n');
        child.stdout.write(JSON.stringify({ result: { sessionId: 'test-session' } }) + '\n');
        child.kill();
      }));
    }
    return child;
  }
  const fakeFs = Object.create(fs);
  fakeFs.existsSync = target => target === '/usr/local/libexec/fizzer/alock' || fs.existsSync(target);
  const context = { module: { exports: {} }, __dirname, process, Buffer, setTimeout, clearTimeout,
    require: name => name === './awatch.cjs' ? {
      alockBinary: () => '/test/bundled/alock',
      createAwatchViewer: callback => { activity = callback; return { close: () => { viewerClosed = true; } }; },
    } : name === 'node:child_process' ? { spawn, spawnSync: () => ({ stdout: '' }) } : name === 'node:fs' ? fakeFs : require(name) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'agent-account.cjs'), 'utf8'), context);
  try {
    const events = [];
    const completion = context.module.exports.run({ runId: 123, cwd: root, vaultRoot: '/missing-vault', prompt: 'test' }, event => events.push(event), {});
    if (bridgeExit >= 2) {
      await assert.rejects(completion, bridgeExit === 2 ? /Installed alock is outdated.*install-agent-writes.sh --update/ : /older alock daemon.*PATH/);
      assert.equal(calls.length, 1, 'Do not launch the agent with an incompatible bridge');
      assert.equal(JSON.parse(events.at(-1).payload_json).status, 'failed');
      return;
    }
    if (bridgeExit) {
      await assert.rejects(completion, /pending recovery snapshots/);
      assert.equal(JSON.parse(events.at(-1).payload_json).status, 'failed');
    } else assert.equal((await completion).sessionId, 'test-session');
    const edits = events.filter(event => event.type === 'activity').map(event => JSON.parse(event.payload_json));
    assert.equal(edits.length, 1, 'Only this run’s bridge activity reaches its vault');
    assert.equal(edits[0].file, '/local/test');
    assert.equal(edits[0].agent, 'Codex');
    assert.equal(viewerClosed, true);
    assert.equal(calls[0].command, '/test/bundled/alock');
    assert.deepEqual(Array.from(calls[0].args.slice(0, 2)), ['account', 'serve']);
    assert.deepEqual(concludes, ['conclude\n', 'conclude\n']);
    assert.equal(calls[0].args[calls[0].args.indexOf('--root') + 1], fs.realpathSync(root));
    assert.equal(calls[1].command, '/usr/bin/sudo');
    assert.ok(calls[1].args.includes('fizzer'));
    const socket = calls[0].args[calls[0].args.indexOf('--socket') + 1];
    assert.equal(fs.existsSync(path.dirname(socket)), false);
  } finally {
    if (previousData === undefined) delete process.env.CASCADE_DATA_DIR; else process.env.CASCADE_DATA_DIR = previousData;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
