'use strict';

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const LOOPBACK = '127.0.0.1';

function runtimePaths({ packaged, resourcesPath, projectRoot, env = process.env }) {
  const packagedRoot = path.join(resourcesPath, 'embedded-runtime');
  return {
    releaseRoot: path.resolve(
      env.FIZZER_BACKEND_RELEASE_DIR
      || (packaged ? path.join(packagedRoot, 'backend-release') : path.join(projectRoot, 'backend_elixir', '_build', 'prod', 'rel', 'cascade_elixir')),
    ),
    clientDistDir: path.resolve(
      env.FIZZER_CLIENT_DIST_DIR
      || (packaged ? path.join(packagedRoot, 'client-dist') : path.join(projectRoot, 'client', 'dist'))),
  };
}

function releaseInvocation(releaseRoot, platform = process.platform) {
  const script = path.join(releaseRoot, 'bin', platform === 'win32' ? 'cascade_elixir.bat' : 'cascade_elixir');
  if (platform === 'win32') {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${script}" start`],
      script,
    };
  }
  return { command: script, args: ['start'], script };
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, LOOPBACK, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function healthIsReady(port) {
  return new Promise((resolve) => {
    const request = http.get({ hostname: LOOPBACK, port, path: '/api/health', timeout: 750 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function terminateProcessTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  child.kill('SIGTERM');
}

async function existingBackend(dataDir, timeout = 30_000) {
  const database = path.join(dataDir, 'docs.db');
  let record;
  try { record = JSON.parse(fs.readFileSync(path.join(dataDir, 'local-backend.json'), 'utf8')); }
  catch { return null; }
  if (!Number.isInteger(record.pid) || record.pid < 1) return null;
  try { process.kill(record.pid, 0); } catch (error) {
    if (error.code === 'ESRCH') return null;
    throw error;
  }
  const origin = new URL(record.origin);
  if (origin.protocol !== 'http:' || origin.hostname !== LOOPBACK || origin.username || origin.password
      || (record.database && path.resolve(record.database) !== database)) {
    throw new Error('The local backend discovery record does not match this data directory.');
  }
  const deadline = Date.now() + timeout;
  do {
    if (await healthIsReady(Number(origin.port))) {
      return { origin: origin.origin, process: null, reused: true, stop() {} };
    }
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(`A backend already owns ${dataDir}, but is not healthy. Check it before starting another backend.`);
}

function rejectLegacyDatabaseOwner(dataDir) {
  // Older backends do not publish discovery or acquire the new lease. Refuse
  // to start beside one rather than guessing which server/database it serves.
  const database = path.join(dataDir, 'docs.db');
  if (process.platform === 'win32' || !fs.existsSync(database)) return;
  const result = spawnSync('lsof', ['-t', '--', database], { encoding: 'utf8', timeout: 3_000 });
  if (result.status === 0 && result.stdout.trim()) {
    throw new Error(`Another process has ${database} open. Stop that older backend before opening Fizzer, or update it to support backend discovery.`);
  }
  if (result.error && result.error.code !== 'ENOENT') throw result.error;
}

async function startEmbeddedBackend({ packaged, resourcesPath, projectRoot, userDataDir, env = process.env }) {
  const dataDir = path.resolve(env.CASCADE_DATA_DIR || path.join(require('node:os').homedir(), '.fizzer'));
  fs.mkdirSync(dataDir, { recursive: true });
  const existing = await existingBackend(dataDir);
  if (existing) return existing;
  rejectLegacyDatabaseOwner(dataDir);
  const { releaseRoot, clientDistDir } = runtimePaths({ packaged, resourcesPath, projectRoot, env });
  const invocation = releaseInvocation(releaseRoot);
  const appHtml = path.join(clientDistDir, 'app.html');
  if (!fs.existsSync(invocation.script)) {
    throw new Error(`The bundled local backend is missing (${invocation.script}).`);
  }
  if (!fs.existsSync(appHtml)) {
    throw new Error(`The bundled client is missing (${appHtml}).`);
  }

  const port = await availablePort();
  fs.mkdirSync(userDataDir, { recursive: true });
  const logPath = path.join(userDataDir, 'local-backend.log');
  fs.writeFileSync(logPath, `Starting local backend on ${LOOPBACK}:${port}\nData directory: ${dataDir}\n`, { mode: 0o600 });
  const child = spawn(invocation.command, invocation.args, {
    cwd: releaseRoot,
    env: {
      ...env,
      API_PORT: String(port),
      CASCADE_BIND_IP: LOOPBACK,
      CASCADE_NETWORK_MODE: '0',
      CASCADE_QMD_WORKER_ENABLED: '0',
      CASCADE_DATA_DIR: dataDir,
      DOCS_DB_PATH: path.join(dataDir, 'docs.db'),
      CASCADE_VAULTS_BASE_DIR: path.join(dataDir, 'vaults'),
      CASCADE_QMD_DIR: path.join(dataDir, 'qmd'),
      CASCADE_CLIENT_DIST_DIR: clientDistDir,
      RELEASE_DISTRIBUTION: 'none',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let output = '';
  const appendOutput = (chunk) => {
    const text = chunk.toString();
    output = (output + text).slice(-16_000);
    process.stderr.write(`[Local backend] ${text}`);
    fs.appendFileSync(logPath, text);
  };
  child.stdout.on('data', appendOutput);
  child.stderr.on('data', appendOutput);

  let exit;
  child.once('error', (error) => { exit = error; });
  child.once('exit', (code, signal) => {
    exit = new Error(`Local backend exited before startup (code ${code ?? 'none'}, signal ${signal ?? 'none'}).`);
  });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !exit) {
    if (await healthIsReady(port)) {
      const origin = `http://${LOOPBACK}:${port}`;
      return {
        origin,
        process: child,
        stop: () => terminateProcessTree(child),
      };
    }
    await delay(100);
  }

  terminateProcessTree(child);
  // A simultaneous launcher may have acquired the backend lease first.
  const winner = exit ? await existingBackend(dataDir) : null;
  if (winner) return winner;
  const reason = exit ? exit.message : 'Timed out waiting for its health endpoint.';
  throw new Error(`${reason}\nStartup log: ${logPath}${output.trim() ? `\n\n${output.trim()}` : ''}`);
}

module.exports = {
  runtimePaths,
  existingBackend,
  startEmbeddedBackend,
};
