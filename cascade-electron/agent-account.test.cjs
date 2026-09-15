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

test('account runner resolves stale fizzer workspace through legacy cascade path', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'account-legacy-root-'));
  const legacy = path.join(parent, '.cascade', 'vaults', 'one');
  fs.mkdirSync(legacy, { recursive: true });
  try {
    assert.equal(account.resolveWorkspace(path.join(parent, '.fizzer', 'vaults', 'one')), fs.realpathSync(legacy));
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
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

for (const bridgeExit of [0, 1]) test(`account run cleans up and reports bridge exit ${bridgeExit}`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'account-run-'));
  const previousData = process.env.CASCADE_DATA_DIR;
  process.env.CASCADE_DATA_DIR = root;
  const calls = [];
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
    if (command.endsWith('/alock')) setImmediate(() => child.stdout.write('Bridge ready: socket\n'));
    else {
      let input = '';
      child.stdin.on('data', chunk => { input += chunk; });
      child.stdin.on('finish', () => setImmediate(() => {
        assert.equal(JSON.parse(input).opts.runId, 123);
        assert.equal(JSON.parse(input).opts.cwd, fs.realpathSync(root));
        assert.equal(JSON.parse(input).root, fs.realpathSync(root));
        child.stdout.write(JSON.stringify({ result: { sessionId: 'test-session' } }) + '\n');
        child.kill();
      }));
    }
    return child;
  }
  const fakeFs = Object.create(fs);
  fakeFs.existsSync = target => target === '/usr/local/libexec/fizzer/alock' || fs.existsSync(target);
  const context = { module: { exports: {} }, __dirname, process, setTimeout, clearTimeout,
    require: name => name === 'node:child_process' ? { spawn } : name === 'node:fs' ? fakeFs : require(name) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'agent-account.cjs'), 'utf8'), context);
  try {
    const events = [];
    const completion = context.module.exports.run({ runId: 123, cwd: root, vaultRoot: '/missing-vault', prompt: 'test' }, event => events.push(event), {});
    if (bridgeExit) {
      await assert.rejects(completion, /pending recovery snapshots/);
      assert.equal(JSON.parse(events.at(-1).payload_json).status, 'failed');
    } else assert.equal((await completion).sessionId, 'test-session');
    assert.equal(calls[0].command, '/usr/local/libexec/fizzer/alock');
    assert.ok(calls[0].args.includes('--turn'));
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
