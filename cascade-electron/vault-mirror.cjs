'use strict';
// One rclone process per host. All update jobs use its HTTP API over a private
// Unix socket. Only this module chooses destinations; callers cannot reverse sync.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createHash, randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function rcloneBinary() {
  if (process.env.FIZZER_RCLONE_BIN) return process.env.FIZZER_RCLONE_BIN;
  const candidates = ['/usr/local/libexec/fizzer/rclone', '/opt/homebrew/bin/rclone', '/usr/local/bin/rclone'];
  return candidates.find(candidate => fs.existsSync(candidate)) || 'rclone';
}

class VaultMirrors {
  constructor({ directory = process.env.CASCADE_DATA_DIR || path.join(os.homedir(), '.fizzer'),
    binary = rcloneBinary(), onError = error => console.error('[vault mirror]', error.message) } = {}) {
    this.directory = directory;
    this.binary = binary;
    this.onError = onError;
    this.entries = new Map();
    this.agent = new http.Agent({ keepAlive: true });
    this.closed = false;
  }

  async start() {
    if (this.closed) throw new Error('Mirror host is closed');
    if (this.starting) return this.starting;
    this.starting = this.launch().catch(error => { this.starting = null; throw error; });
    return this.starting;
  }

  async launch() {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fizzer-rc-'));
    fs.chmodSync(temporary, 0o700);
    this.temporary = temporary;
    this.socket = path.join(temporary, 'rc.sock');
    const password = randomBytes(32).toString('hex');
    this.authorization = `Basic ${Buffer.from('fizzer:' + password).toString('base64')}`;
    const child = spawn(this.binary, ['rcd', '--rc-addr', this.socket, '--config', path.join(temporary, 'rclone.conf'),
      '--cache-dir', path.join(temporary, 'cache'), '--log-level', 'ERROR'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, RCLONE_RC_USER: 'fizzer', RCLONE_RC_PASS: password },
    });
    this.child = child;
    let failure;
    child.on('error', () => { failure = new Error('Cannot start rclone; install rclone or set FIZZER_RCLONE_BIN.'); });
    child.stderr.resume(); // Never print daemon diagnostics that may contain remote credentials.
    child.once('exit', () => {
      failure = new Error('rclone daemon stopped');
      if (this.child === child) { this.child = null; this.starting = null; }
      fs.rmSync(temporary, { recursive: true, force: true });
    });
    for (let attempt = 0; attempt < 100 && !this.closed; attempt++) {
      if (failure) break;
      try { await this.call('rc/noop', {}); return; } catch { await delay(50); }
    }
    child.kill();
    fs.rmSync(temporary, { recursive: true, force: true });
    throw failure || new Error('rclone daemon did not become ready');
  }

  call(operation, payload) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);
      const request = http.request({ socketPath: this.socket, path: '/' + operation, method: 'POST', agent: this.agent,
        headers: { authorization: this.authorization, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, response => {
        let data = '';
        response.on('data', chunk => { data += chunk; if (data.length > 1024 * 1024) response.destroy(new Error('Oversize rclone response')); });
        response.on('error', reject);
        response.on('end', () => {
          if (response.statusCode !== 200) return reject(new Error(`rclone ${operation} failed (${response.statusCode})`));
          try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid rclone response')); }
        });
      });
      request.setTimeout(10000, () => request.destroy(new Error('rclone API timeout')));
      request.on('error', reject);
      request.end(body);
    });
  }

  watch({ origin, token, vaultId }) {
    origin = new URL(origin).origin;
    if (!/^https?:/.test(origin) || !token || !/^[a-zA-Z0-9_-]{1,128}$/.test(vaultId)) throw new Error('Invalid mirror connection');
    const key = createHash('sha256').update(JSON.stringify([origin, vaultId])).digest('hex');
    let entry = this.entries.get(key);
    if (!entry) {
      // Never sync into cwd, a repository, or a caller-selected path.
      const root = path.join(this.directory, 'mirrors', key);
      fs.mkdirSync(root, { recursive: true, mode: 0o755 });
      if (fs.lstatSync(root).isSymbolicLink()) throw new Error('Mirror root must not be a symlink');
      entry = { origin, vaultId, root, token, dirty: false, running: null, timer: null };
      this.entries.set(key, entry);
      // Reconciliation also repairs a lost final notification without inventing
      // another event journal or relying on Socket.IO replay support.
      entry.interval = setInterval(() => this.notify(entry), 60000);
      entry.interval.unref();
    }
    entry.token = token;
    return entry;
  }

  notify(entry) {
    if (this.closed) return;
    entry.dirty = true;
    if (!entry.running && !entry.timer) {
      entry.timer = setTimeout(() => {
        entry.timer = null;
        this.reconcile(entry).catch(error => this.onError(error));
      }, 100);
      entry.timer.unref();
    }
  }

  async reconcile(entry) {
    if (this.closed) throw new Error('Mirror host is closed');
    entry.dirty = true;
    if (entry.running) return entry.running;
    clearTimeout(entry.timer); entry.timer = null;
    entry.running = (async () => {
      await this.start();
      while (entry.dirty && !this.closed) {
        entry.dirty = false;
        const source = { type: 'http', url: `${entry.origin}/api/vaults/${encodeURIComponent(entry.vaultId)}/mirror/`,
          headers: `Authorization,"Bearer ${entry.token.replaceAll('"', '""')}"` };
        const { jobid } = await this.call('sync/sync', { srcFs: source, dstFs: entry.root,
          createEmptySrcDirs: true, _async: true,
          // HTTP has second-resolution dates and no checksums. Same-size edits
          // in one second must still reach the mirror. Never trust timestamps.
          _config: { IgnoreTimes: true, Transfers: 4, Checkers: 4 },
        });
        for (;;) {
          if (this.closed) return;
          const status = await this.call('job/status', { jobid });
          if (status.finished) {
            if (!status.success) throw new Error('Vault mirror download failed; will retry on the next notification or reconciliation');
            break;
          }
          await delay(100);
        }
      }
    })().finally(() => { entry.running = null; });
    return entry.running;
  }

  async close() {
    this.closed = true;
    for (const entry of this.entries.values()) { clearInterval(entry.interval); clearTimeout(entry.timer); }
    const child = this.child;
    if (child && child.exitCode === null) {
      await new Promise(resolve => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill('SIGTERM');
      });
    }
    await Promise.allSettled([...this.entries.values()].map(entry => entry.running));
    this.agent.destroy();
    if (this.temporary) fs.rmSync(this.temporary, { recursive: true, force: true });
  }
}

let host;
function mirrors() { if (!host || host.closed) host = new VaultMirrors(); return host; }
async function closeMirrors() { if (host) await host.close(); }
module.exports = { VaultMirrors, mirrors, closeMirrors };
