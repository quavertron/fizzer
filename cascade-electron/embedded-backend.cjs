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

async function startEmbeddedBackend({ packaged, resourcesPath, projectRoot, userDataDir, env = process.env }) {
  const { releaseRoot, clientDistDir } = runtimePaths({ packaged, resourcesPath, projectRoot, env });
  const invocation = releaseInvocation(releaseRoot);
  const appHtml = path.join(clientDistDir, 'app.html');
  if (!fs.existsSync(invocation.script)) {
    throw new Error(`The bundled local backend is missing (${invocation.script}).`);
  }
  if (!fs.existsSync(appHtml)) {
    throw new Error(`The bundled client is missing (${appHtml}).`);
  }

  const dataDir = path.join(userDataDir, 'local-server');
  fs.mkdirSync(dataDir, { recursive: true });
  const port = await availablePort();
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
      HOME: dataDir,
      USERPROFILE: dataDir,
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
      return {
        origin: `http://${LOOPBACK}:${port}`,
        process: child,
        stop: () => terminateProcessTree(child),
      };
    }
    await delay(100);
  }

  terminateProcessTree(child);
  const reason = exit ? exit.message : 'Timed out waiting for its health endpoint.';
  throw new Error(`${reason}${output.trim() ? `\n\n${output.trim()}` : ''}`);
}

module.exports = {
  runtimePaths,
  startEmbeddedBackend,
};
