'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { startReadOnlyApi } = require('./agent-account-api.cjs');
const writeAccess = require('./agent-write-access.cjs');
const { runStorage } = require('./storage-bin.cjs');

const active = new Map();

function isRemoteVault(opts, api) {
  return runStorage(['agent-account', 'is-remote-vault', JSON.stringify({ opts, api })]) === true;
}

async function prepareWorkspace(opts, api, mirrorHost) {
  if (isRemoteVault(opts, api)) {
    if (!api?.url || !(api.writeToken || api.token) || !opts.vaultId) {
      throw new Error('Remote vault workspace requires an authenticated mirror connection');
    }
    mirrorHost ||= require('./vault-mirror.cjs').mirrors();
    const mirror = mirrorHost.watch({ origin: api.origin || api.url,
      token: api.writeToken || api.token, vaultId: opts.vaultId });
    await mirrorHost.reconcile(mirror);
    const root = fs.realpathSync(mirror.root);
    if (!fs.statSync(root).isDirectory()) throw new Error('Remote vault mirror is not a directory');
    return { root, remote: true };
  }
  try {
    return runStorage(['agent-account', 'prepare-workspace', JSON.stringify({ opts, api })]);
  } catch (error) {
    if (error.code === 'ENOENT') {
      const err = new Error(error.message);
      err.code = 'ENOENT';
      throw err;
    }
    throw error;
  }
}

function resolveWorkspace(selected) {
  return runStorage(['agent-account', 'resolve-workspace', selected], { raw: true }).trim();
}

function enabled() { return runStorage(['agent-account', 'enabled'], { raw: true }).trim() === 'true'; }
function shouldOffer() { return runStorage(['agent-account', 'should-offer'], { raw: true }).trim() === 'true'; }
function decline() { runStorage(['agent-account', 'decline'], { raw: true }); }

function setupCommand({ resourcesPath = process.resourcesPath, packaged = false } = {}) {
  const args = ['agent-account', 'setup-command'];
  if (packaged) args.push('--packaged', resourcesPath || '');
  return runStorage(args, { raw: true }).trim();
}

function launchArguments(node, worker, socket) {
  const { storageBinary } = require('./storage-bin.cjs');
  const env = { ...process.env, FIZZER_NODE_BIN: node };
  if (!env.FIZZER_STORAGE_BIN) {
    const candidate = storageBinary();
    if (candidate !== 'fizzer-storage' && fs.existsSync(candidate)) env.FIZZER_STORAGE_BIN = candidate;
  }
  return JSON.parse(runStorage(['agent-account', 'launch-argv', socket, worker], { raw: true, env }));
}

async function startBridge(root, directory, index = 0, remote) {
  const installedAlock = process.env.FIZZER_ALOCK_BIN || '/usr/local/libexec/fizzer/alock';
  if (!fs.existsSync(installedAlock)) throw new Error('Agent write setup is incomplete: rerun the installer.');
  const bridgeBinary = require('./awatch.cjs').alockBinary();
  const socket = path.join(directory, `socket-${index}`);
  const args = ['account', 'serve', '--root', root, '--user', 'fizzer', '--socket', socket, '--control-stdin'];
  if (remote) args.push('--remote-url', remote.url, '--header-file', remote.header);
  const child = spawn(bridgeBinary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  let errors = '';
  child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4000); });
  const session = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Agent write bridge startup timed out.')); }, 10000);
    const failed = error => { clearTimeout(timer); reject(error); };
    child.once('error', failed);
    child.once('exit', code => {
      if (code === 2 && errors.includes('alock bridge serve') && !errors.includes('alock account serve')) {
        failed(new Error(`Installed alock is outdated (${installedAlock}): this Fizzer version requires account/HTTP support. Update the native helper bundle using install-agent-writes.sh --update, then retry the run.`));
      } else if (errors.includes('alock: unknown command')) {
        failed(new Error('An older alock daemon is still running. Update older alock copies on PATH, finish active edits, and allow the idle daemon to exit before retrying. The installed account bridge cannot use the older daemon.'));
      } else failed(new Error(`Agent write bridge exited (${code}): ${errors}`));
    });
    let buffer = '';
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (message.ready) { clearTimeout(timer); resolve(message.session); }
        } catch {}
      }
    });
  });
  return { child, socket, session, error: () => errors };
}

async function run(opts, sendEvent, api) {
  let directory, worker, contextApi, activityViewer;
  const bridges = [];
  const record = { child: null, canceled: false };
  let sequence = 0, terminalStatus = false;
  const status = (value, summary) => {
    terminalStatus = true;
    sendEvent({ runId: Number(opts.runId), seq: ++sequence, type: 'status', payload_json: JSON.stringify({ status: value, summary }) });
  };
  try {
    const { root, remote } = await prepareWorkspace(opts, api);
    opts = { ...opts, cwd: root, remoteVault: remote };
    directory = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'faw-'));
    fs.chmodSync(directory, 0o755);
    if (remote) {
      const writeToken = api.writeToken || api.token;
      const header = path.join(directory, 'remote-authorization');
      fs.writeFileSync(header, `Authorization: Bearer ${writeToken}\n`, { mode: 0o600, flag: 'wx' });
      const url = `${new URL(api.url).origin}/api/vaults/${encodeURIComponent(opts.vaultId)}/alock`;
      bridges.push({ ...await startBridge(root, directory, bridges.length, { url, header }),
        root: 'remote-vault', remote: true, vaultId: opts.vaultId, mirrorRoot: root });
    } else {
      for (const allowedRoot of writeAccess.roots(opts, api, root)) {
        bridges.push({ ...await startBridge(allowedRoot, directory, bridges.length), root: allowedRoot });
      }
    }
    const bridge = bridges[0];
    const sessions = new Set(bridges.filter(item => !item.remote && item.session).map(item => item.session));
    activityViewer = require('./awatch.cjs').createAwatchViewer(message => {
      for (const event of message.events || []) {
        if (!sessions.has(event.agent) || !['edit', 'lock'].includes(event.kind)) continue;
        const payload = { ...event, agent: event.author || opts.chatAuthor || opts.agent };
        for (const key of ['old_lines', 'new_lines']) {
          if (!Array.isArray(payload[key])) continue;
          let bytes = 0;
          payload[key] = payload[key].filter(line => (bytes += Buffer.byteLength(line) + 1) <= 32768);
          if (payload[key].length < event[key].length) payload.truncated = true;
        }
        sendEvent({ runId: Number(opts.runId), seq: ++sequence, type: 'activity', payload_json: JSON.stringify(payload) });
      }
    }, { batchMs: 0, tail: true });
    await activityViewer.ready;
    contextApi = await startReadOnlyApi(api, opts.vaultId);
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
          sendEvent({ ...message.event, seq: ++sequence });
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
    for (const bridge of bridges) if (bridge.child.exitCode === null && bridge.child.signalCode === null) await new Promise(resolve => {
      const timer = setTimeout(() => { bridge.child.kill('SIGKILL'); resolve(); }, 30000);
      bridge.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    activityViewer?.close();
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

module.exports = { enabled, shouldOffer, decline, setupCommand, launchArguments, resolveWorkspace, isRemoteVault, prepareWorkspace, run, cancel };
