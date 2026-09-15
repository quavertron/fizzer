'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { startReadOnlyApi } = require('./agent-account-api.cjs');
const writeAccess = require('./agent-write-access.cjs');

const active = new Map();
function resolveWorkspace(selected) {
  let expanded = selected === '~' ? os.homedir()
    : selected.startsWith('~/') ? path.join(os.homedir(), selected.slice(2)) : selected;
  if (!fs.existsSync(expanded)) {
    const legacy = expanded.replace(`${path.sep}.fizzer${path.sep}`, `${path.sep}.cascade${path.sep}`);
    if (legacy !== expanded && fs.existsSync(legacy)) expanded = legacy;
  }
  return fs.realpathSync(expanded);
}
const installedAlock = '/usr/local/libexec/fizzer/alock';
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
  const providerBinaries = ['CLAUDE_BIN', 'CODEX_BIN', 'GROK_BIN', 'COPILOT_BIN', 'HERMES_BIN', 'AKRON_BIN', 'OMP_BIN', 'PI_BIN', 'ANTIGRAVITY_BIN']
    .filter(name => typeof process.env[name] === 'string' && process.env[name])
    .map(name => `${name}=${process.env[name]}`);
  // Antigravity installs its executable in the human home by default. It is
  // readable on a normal macOS installation, but is not on the fizzer PATH.
  if (!providerBinaries.some(value => value.startsWith('ANTIGRAVITY_BIN='))) {
    const candidate = path.join(os.homedir(), '.gemini', 'antigravity', 'bin', 'agentapi');
    if (fs.existsSync(candidate)) providerBinaries.push(`ANTIGRAVITY_BIN=${candidate}`);
  }
  return ['-n', '-H', '-u', 'fizzer', '--', '/usr/bin/env',
    `PATH=${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
    'ELECTRON_RUN_AS_NODE=1', 'FIZZER_AGENT_ACCOUNT_CHILD=1',
    `FIZZER_BRIDGE_SOCKET=${socket}`, `FIZZER_ALOCK_BIN=${installedAlock}`,
    ...providerBinaries,
    node, worker];
}
async function startBridge(root, directory, index = 0) {
  if (!fs.existsSync(installedAlock)) throw new Error('Agent write setup is incomplete: rerun the installer.');
  const socket = path.join(directory, `socket-${index}`);
  const child = spawn(installedAlock, ['bridge', 'serve', '--root', root, '--user', 'fizzer', '--socket', socket, '--turn'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4000); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Agent write bridge startup timed out.')); }, 10000);
    const failed = error => { clearTimeout(timer); reject(error); };
    child.once('error', failed);
    child.once('exit', code => failed(new Error(`Agent write bridge exited (${code}): ${errors}`)));
    child.stdout.on('data', chunk => {
      if (String(chunk).includes('Bridge ready:')) { clearTimeout(timer); resolve(); }
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
    const bridge = bridges[0];
    contextApi = await startReadOnlyApi(api, opts.vaultId);
    worker = spawn('/usr/bin/sudo', launchArguments(process.execPath, path.join(__dirname, 'agent-account-worker.cjs'), bridge.socket), {
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
      grants: bridges.map(({ root, socket }) => ({ root, socket })) }));
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
