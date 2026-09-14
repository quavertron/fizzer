/**
 * @file desktop-runner-host.cjs — Main-process helpers for the desktop runner
 *
 * The /runners Socket.IO client lives in the Chromium renderer (see
 * client/src/desktopRunnerHost.ts). Node/OpenSSL TLS to some hosts is broken
 * on middleboxed residential networks while Chromium still works, so the main
 * process must not own the relay socket.
 *
 * cascade-note / cascade-chat are child Node processes and hit the same TLS
 * breakage if pointed at https://cscd.online. We therefore expose a loopback
 * HTTP reverse proxy that re-issues upstream requests via Electron `net.fetch`
 * (Chromium network stack) and set CASCADE_NOTE_URL to that proxy.
 *
 * This module stores the live API URL + JWT for cascade-note / cascade-chat
 * child envs. It tracks nothing about the socket (renderer owns reconnects).
 */

const http = require('http');
const { setNoteApiConfig } = require('./agent-runner.cjs');

let apiBase = 'https://cscd.online';
let currentToken = '';
/** @type {import('http').Server | null} */
let helperProxyServer = null;
/** Loopback base URL helpers should call, e.g. http://127.0.0.1:54321 */
let helperProxyUrl = '';

function normalizeApiBase(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'https://cscd.online';
  return raw.replace(/\/$/, '');
}

/** True when Node can talk to the API directly (local/dev plain HTTP). */
function isDirectLocalHttp(base) {
  try {
    const u = new URL(base);
    if (u.protocol !== 'http:') return false;
    const host = u.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

function stopHelperProxy() {
  if (helperProxyServer) {
    try { helperProxyServer.close(); } catch { /* ignore */ }
    helperProxyServer = null;
  }
  helperProxyUrl = '';
}

/**
 * Headers safe to forward from the helper CLI → Chromium net.fetch.
 *
 * Allowlist only: Node's fetch client often sends `content-length: 0` on GET
 * and other hop headers that make Chromium net.fetch throw
 * net::ERR_INVALID_ARGUMENT. Never forward content-length (Chromium sets it).
 */
function forwardRequestHeaders(reqHeaders) {
  const allow = new Set([
    'authorization',
    'content-type',
    'accept',
    'x-request-id',
    'x-cascade-run-id',
  ]);
  const out = {};
  for (const [key, value] of Object.entries(reqHeaders || {})) {
    if (value == null) continue;
    const lower = key.toLowerCase();
    if (!allow.has(lower)) continue;
    // Node may give string[]; Chromium wants a single string.
    out[lower] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Start (or reuse) a loopback reverse proxy that re-issues HTTPS via Electron
 * net.fetch so helper CLIs avoid Node/OpenSSL middlebox breakage.
 * @returns {Promise<string>} base URL for CASCADE_NOTE_URL
 */
async function ensureHelperProxy(remoteBase) {
  const target = normalizeApiBase(remoteBase);

  // Local plain HTTP needs no Chromium hop.
  if (isDirectLocalHttp(target)) {
    stopHelperProxy();
    return target;
  }

  // Already running against the same upstream.
  if (helperProxyServer && helperProxyUrl && apiBase === target) {
    return helperProxyUrl;
  }

  stopHelperProxy();
  apiBase = target;

  // Lazy require so unit tests can load this module outside Electron.
  let net;
  try {
    ({ net } = require('electron'));
  } catch (err) {
    throw new Error(`Electron net unavailable for helper proxy: ${err?.message || err}`);
  }
  if (!net || typeof net.fetch !== 'function') {
    throw new Error('Electron net.fetch is required for the helper API proxy');
  }

  const server = http.createServer(async (req, res) => {
    try {
      const incomingPath = req.url || '/';
      const upstreamUrl = `${apiBase}${incomingPath}`;
      const method = (req.method || 'GET').toUpperCase();
      const bodyBuf = method === 'GET' || method === 'HEAD'
        ? Buffer.alloc(0)
        : await readRequestBody(req);

      /** @type {RequestInit} */
      const init = {
        method,
        headers: forwardRequestHeaders(req.headers),
      };
      // Only attach a body when non-empty. Empty Buffer / content-length:0 on
      // GET makes Chromium net.fetch fail with ERR_INVALID_ARGUMENT.
      if (bodyBuf.length > 0) {
        init.body = bodyBuf;
      }

      const upstream = await net.fetch(upstreamUrl, init);
      res.statusCode = upstream.status;

      // Copy a safe subset of response headers.
      const hopByHop = new Set([
        'connection',
        'keep-alive',
        'proxy-authenticate',
        'proxy-authorization',
        'te',
        'trailers',
        'transfer-encoding',
        'upgrade',
        'content-encoding', // net.fetch usually decompresses; avoid double-decode
      ]);
      upstream.headers.forEach((value, key) => {
        if (hopByHop.has(key.toLowerCase())) return;
        // Host-only; array values rare for our API.
        try { res.setHeader(key, value); } catch { /* ignore invalid */ }
      });

      const ab = await upstream.arrayBuffer();
      const buf = Buffer.from(ab);
      res.setHeader('content-length', String(buf.length));
      res.end(buf);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[helper-proxy] upstream failed:', message);
      if (!res.headersSent) {
        res.statusCode = 502;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: `helper proxy: ${message}` }));
      } else {
        try { res.end(); } catch { /* ignore */ }
      }
    }
  });

  await new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    server.close();
    throw new Error('helper proxy failed to bind loopback port');
  }

  helperProxyServer = server;
  helperProxyUrl = `http://127.0.0.1:${addr.port}`;
  console.log(`[helper-proxy] listening on ${helperProxyUrl} → ${apiBase}`);
  return helperProxyUrl;
}

/**
 * Configure child-process helper env (token/url). Socket ownership is renderer-side.
 * Kept name `connectDesktopRunner` for existing IPC callers.
 * Starts the Chromium-backed loopback proxy when the remote API is HTTPS.
 */
async function connectDesktopRunner(token, nextApiBase) {
  const authToken = String(token || '').trim();
  if (!authToken) {
    await disconnectDesktopRunner();
    return { success: false, error: 'Missing auth token' };
  }

  const nextBase = normalizeApiBase(nextApiBase);
  apiBase = nextBase;
  currentToken = authToken;

  let helperUrl = nextBase;
  try {
    helperUrl = await ensureHelperProxy(nextBase);
  } catch (err) {
    console.error('[helper-proxy] failed to start, falling back to direct URL:', err?.message || err);
    helperUrl = nextBase;
  }

  setNoteApiConfig({ url: helperUrl, token: authToken });
  return { success: true, helperUrl, apiBase: nextBase };
}

async function disconnectDesktopRunner() {
  currentToken = '';
  apiBase = 'https://cscd.online';
  stopHelperProxy();
  setNoteApiConfig({ url: '', token: '' });
}

module.exports = {
  connectDesktopRunner,
  disconnectDesktopRunner,
  // Socket is renderer-owned; main cannot observe it.
  isDesktopRunnerConnected: () => Boolean(currentToken),
  getActiveRunCount: () => 0,
  // Test / diagnostics
  getHelperProxyUrl: () => helperProxyUrl,
  getRemoteApiBase: () => apiBase,
};
