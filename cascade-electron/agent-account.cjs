'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// DO NOT REMOVE spawnSync: launchArguments() uses it synchronously to discover Antigravity's
// live language server port & CSRF token before dropping privileges to the fizzer account.
const { spawn, spawnSync } = require('node:child_process');
const readline = require('node:readline');
const { startReadOnlyApi } = require('./agent-account-api.cjs');
const writeAccess = require('./agent-write-access.cjs');

const active = new Map();
function resolveWorkspace(selected) {
  let expanded = selected === '~' ? os.homedir()
    : selected.startsWith('~/') ? path.join(os.homedir(), selected.slice(2)) : selected;
  if (!fs.existsSync(expanded)) {
    // Delegated runs from a remote Fizzer server carry that server's container
    // workspace path. It is meaningful on the server, never on this machine.
    // Use the configured local workspace (or HOME) instead of letting
    // realpathSync throw ENOENT before the local provider can start.
    if (expanded === '/data' || expanded.startsWith('/data' + path.sep)
      || expanded === '/var/lib/cascade' || expanded.startsWith('/var/lib/cascade' + path.sep)) {
      const local = process.env.FIZZER_AGENT_WORKSPACE || os.homedir();
      return fs.realpathSync(local);
    }
    const legacy = expanded.replace(`${path.sep}.fizzer${path.sep}`, `${path.sep}.cascade${path.sep}`);
    if (legacy !== expanded && fs.existsSync(legacy)) expanded = legacy;
  }
  return fs.realpathSync(expanded);
}
const installedAlock = process.env.FIZZER_ALOCK_BIN || '/usr/local/libexec/fizzer/alock';
function stateDirectory() { return process.env.CASCADE_DATA_DIR || path.join(os.homedir(), '.fizzer'); }
function enabled() { return ['darwin', 'linux'].includes(process.platform) && fs.existsSync(path.join(stateDirectory(), 'agent-writes-enabled')); }
function shouldOffer() { return ['darwin', 'linux'].includes(process.platform) && !enabled() && !fs.existsSync(path.join(stateDirectory(), 'agent-writes-declined')); }
function decline() {
  fs.mkdirSync(stateDirectory(), { recursive: true });
  fs.writeFileSync(path.join(stateDirectory(), 'agent-writes-declined'), '1\n', { mode: 0o600 });
}
function shellQuote(value) { return "'" + String(value).replaceAll("'", "'\\''") + "'"; }
function setupCommand({ resourcesPath = process.resourcesPath, packaged = false } = {}) {
  const directory = packaged ? path.join(resourcesPath, 'embedded-runtime', 'agent-account-setup') : path.join(__dirname, '..');
  const command = `bash ${shellQuote(path.join(directory, 'install-agent-writes.sh'))}`;
  return packaged ? `${command} ${shellQuote(path.join(directory, 'alock'))}` : command;
}
function launchArguments(node, worker, socket) {
  const providerBinaries = [
    'CLAUDE_BIN', 'CODEX_BIN', 'GROK_BIN', 'COPILOT_BIN', 'HERMES_BIN', 'AKRON_BIN', 'OMP_BIN', 'PI_BIN',
    'ANTIGRAVITY_BIN', 'ANTIGRAVITY_HOME', 'ANTIGRAVITY_LS_ADDRESS', 'ANTIGRAVITY_CSRF_TOKEN',
    'ANTIGRAVITY_PROJECT_ID', 'ANTIGRAVITY_AGENTAPI_EXE',
  ]
    .filter(name => typeof process.env[name] === 'string' && process.env[name])
    .map(name => `${name}=${process.env[name]}`);
  // Antigravity installs its executable and config in the human home by default.
  // It is readable on a normal macOS installation, but is not on the fizzer PATH/HOME.
  if (!providerBinaries.some(value => value.startsWith('ANTIGRAVITY_BIN='))) {
    const candidate = path.join(os.homedir(), '.gemini', 'antigravity', 'bin', 'agentapi');
    if (fs.existsSync(candidate)) providerBinaries.push(`ANTIGRAVITY_BIN=${candidate}`);
  }
  if (!providerBinaries.some(value => value.startsWith('ANTIGRAVITY_HOME='))) {
    const candidate = path.join(os.homedir(), '.gemini');
    if (fs.existsSync(candidate)) providerBinaries.push(`ANTIGRAVITY_HOME=${candidate}`);
  }
  if (!providerBinaries.some(value => value.startsWith('ANTIGRAVITY_LS_ADDRESS='))) {
    if (process.platform === 'darwin') {
      try {
        const ps = spawnSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf-8' });
        for (const line of (ps.stdout || '').split('\n')) {
          if (!/\/language_server(\s|$)/.test(line)) continue;
          const tokenMatch = line.match(/--csrf_token\s+(\S+)/);
          const pidMatch = line.match(/^\s*(\d+)\s/);
          if (!tokenMatch || !pidMatch) continue;
          const token = tokenMatch[1];
          const pid = pidMatch[1];
          const lsof = spawnSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', pid], { encoding: 'utf-8' });
          const ports = [...(lsof.stdout || '').matchAll(/127\.0\.0\.1:(\d+)\s+\(LISTEN\)/g)]
            .map(m => parseInt(m[1], 10))
            .filter(n => Number.isFinite(n));
          for (const p of ports) {
            try {
              const probe = spawnSync('curl', ['-s', '-m', '1', `http://127.0.0.1:${p}/`], { encoding: 'utf-8' });
              if (probe.stdout && (probe.stdout.includes('__APP_CONFIG__') || probe.stdout.includes('<!doctype html>'))) {
                providerBinaries.push(`ANTIGRAVITY_LS_ADDRESS=127.0.0.1:${p}`);
                providerBinaries.push(`ANTIGRAVITY_CSRF_TOKEN=${token}`);
                break;
              }
            } catch {}
          }
          if (providerBinaries.some(value => value.startsWith('ANTIGRAVITY_LS_ADDRESS='))) break;
        }
      } catch {}
    }
  }
  // Claude runs as the fizzer account with a locked-down env and no login
  // keychain, so subscription OAuth can't be read from the Keychain. Forward an
  // explicit auth token/key instead: from the desktop env if present, otherwise
  // from a persisted file in the human's state dir. Without this the worker's
  // `claude` reports "Not logged in".
  const authEnv = [];
  for (const name of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']) {
    let value = process.env[name];
    if (!value) {
      try {
        const file = path.join(stateDirectory(), name === 'ANTHROPIC_API_KEY' ? 'anthropic-api-key' : 'claude-oauth-token');
        if (fs.existsSync(file)) value = fs.readFileSync(file, 'utf-8').trim();
      } catch {}
    }
    if (value) authEnv.push(`${name}=${value}`);
  }
  return ['-n', '-H', '-u', 'fizzer', '--', '/usr/bin/env',
    `PATH=${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
    'ELECTRON_RUN_AS_NODE=1', 'FIZZER_AGENT_ACCOUNT_CHILD=1',
    `FIZZER_BRIDGE_SOCKET=${socket}`, `FIZZER_ALOCK_BIN=${installedAlock}`,
    ...authEnv,
    ...providerBinaries,
    node, worker];
}
async function startBridge(root, directory, index = 0, remote) {
  if (!fs.existsSync(installedAlock)) throw new Error('Agent write setup is incomplete: rerun the installer.');
  const socket = path.join(directory, `socket-${index}`);
  const args = ['account', 'serve', '--root', root, '--user', 'fizzer', '--socket', socket, '--control-stdin'];
  if (remote) args.push('--remote-url', remote.url, '--header-file', remote.header);
  const child = spawn(installedAlock, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  let errors = '';
  child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4000); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Agent write bridge startup timed out.')); }, 10000);
    const failed = error => { clearTimeout(timer); reject(error); };
    child.once('error', failed);
    child.once('exit', code => failed(new Error(`Agent write bridge exited (${code}): ${errors}`)));
    child.stdout.on('data', chunk => {
      if (String(chunk).includes('"ready":true')) { clearTimeout(timer); resolve(); }
    });
  });
  return { child, socket, error: () => errors };
}
async function run(opts, sendEvent, api) {
  let directory, worker, contextApi;
  const bridges = [];
  const record = { child: null, canceled: false };
  let sequence = 0, terminalStatus = false;
  const status = (value, summary) => {
    terminalStatus = true;
    sendEvent({ runId: Number(opts.runId), seq: ++sequence, type: 'status', payload_json: JSON.stringify({ status: value, summary }) });
  };
  try {
    const selected = String(opts.cwd || '').trim() || String(opts.vaultRoot || '').trim() || process.cwd();
    const root = resolveWorkspace(selected);
    if (!fs.statSync(root).isDirectory()) throw new Error(`Agent workspace is not a directory: ${root}`);
    // Resolve once as the human; the worker's HOME belongs to the fizzer account.
    opts = { ...opts, cwd: root };
    // macOS os.tmpdir() is inside a per-user 0700 tree the agent cannot traverse.
    directory = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'faw-'));
    fs.chmodSync(directory, 0o755);
    for (const allowedRoot of writeAccess.roots(opts, api, root)) {
      bridges.push({ ...await startBridge(allowedRoot, directory, bridges.length), root: allowedRoot });
    }
    if (api?.url && api?.token && opts.vaultId &&
        (opts.remoteVault === true || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(api.origin || api.url).hostname))) {
      const mirrorHost = require('./vault-mirror.cjs').mirrors();
      const mirror = mirrorHost.watch({ origin: api.origin || api.url, token: api.token, vaultId: opts.vaultId });
      await mirrorHost.reconcile(mirror);
      const header = path.join(directory, 'remote-authorization');
      fs.writeFileSync(header, `Authorization: Bearer ${api.token}\n`, { mode: 0o600, flag: 'wx' });
      const url = `${new URL(api.url).origin}/api/vaults/${encodeURIComponent(opts.vaultId)}/alock`;
      bridges.push({ ...await startBridge(root, directory, bridges.length, { url, header }),
        root: 'remote-vault', remote: true, vaultId: opts.vaultId, mirrorRoot: mirror.root });
    }
    const bridge = bridges[0];
    contextApi = await startReadOnlyApi(api, opts.vaultId);
    // The worker is plain Node code. Do not pass Electron's process.execPath
    // through sudo: Electron then tries to resolve default_app.asar and fails
    // under the fizzer account. Resolve `node` through the preserved PATH.
    worker = spawn('/usr/bin/sudo', launchArguments('node', path.join(__dirname, 'agent-account-worker.cjs'), bridge.socket), {
      cwd: root, stdio: ['pipe', 'pipe', 'pipe'],
    });
    record.child = worker;
    active.set(Number(opts.runId), record);
    let errors = '', result, failure;
    worker.stderr.on('data', chunk => { errors = (errors + chunk).slice(-8000); });
    const lines = readline.createInterface({ input: worker.stdout });
    lines.on('line', line => {
      try {
        const message = JSON.parse(line);
        if (message.event) {
          if (message.event.type === 'assistant-turn-end') {
            for (const bridge of bridges) bridge.child.stdin.write('conclude\n');
            return;
          }
          sequence = Math.max(sequence, Number(message.event.seq) || 0);
          if (message.event.type === 'status') {
            const value = JSON.parse(message.event.payload_json)?.status;
            if (['completed', 'failed', 'canceled'].includes(value)) {
              if (record.canceled) return;
              terminalStatus = true;
            }
          }
          sendEvent(message.event);
        }
        if (message.result) result = message.result;
        if (message.error) failure = message.error;
      } catch { /* Ignore incidental provider/module stdout. */ }
    });
    const completion = new Promise((resolve, reject) => {
      worker.once('error', reject);
      worker.once('close', code => {
        if (record.canceled) { status('canceled', 'Run canceled.'); resolve({ canceled: true }); }
        else if (code === 0 && !failure) resolve(result || {});
        else reject(new Error(failure || errors || `Agent account worker exited (${code}). Check setup and provider login.`));
      });
    });
    for (const bridge of bridges) bridge.child.once('exit', () => {
      if (worker.exitCode === null) { failure = 'Agent write bridge stopped during the run.'; worker.kill('SIGTERM'); }
    });
    worker.stdin.on('error', () => {});
    worker.stdin.end(JSON.stringify({ opts, api: contextApi.config, root,
      grants: bridges.map(({ root, socket, remote, vaultId, mirrorRoot }) => ({ root, socket, remote, vaultId, mirrorRoot })) }));
    return await completion;
  } catch (error) {
    if (!terminalStatus) status('failed', error.message);
    throw error;
  } finally {
    active.delete(Number(opts.runId));
    await contextApi?.close();
    worker?.kill('SIGTERM');
    for (const bridge of bridges) bridge.child.kill('SIGTERM');
    // The bridge owns its socket until shutdown; wait before removing its directory.
    for (const bridge of bridges) if (bridge.child.exitCode === null && bridge.child.signalCode === null) await new Promise(resolve => {
      const timer = setTimeout(() => { bridge.child.kill('SIGKILL'); resolve(); }, 30000);
      bridge.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    const failedBridge = bridges.find(bridge => bridge.child.exitCode !== 0);
    if (failedBridge) {
      const message = `Agent write history did not finish cleanly; pending recovery snapshots are retained. ${failedBridge.error()}`;
      status('failed', message);
      throw new Error(message);
    }
  }
}
function cancel(id) { const record = active.get(Number(id)); if (!record) return false; record.canceled = true; record.child.kill('SIGTERM'); return true; }
module.exports = { enabled, shouldOffer, decline, setupCommand, launchArguments, resolveWorkspace, run, cancel };
