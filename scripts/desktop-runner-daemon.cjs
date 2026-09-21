#!/usr/bin/env node
/**
 * @file desktop-runner-daemon.cjs — Headless agent execution runner for Fizzer / Cascade
 *
 * Connects to the Elixir backend's /runners Socket.IO namespace, registers as the active
 * desktop runner, and executes delegated agent runs (Claude, Codex, etc.) locally on this
 * machine via agent-runner.cjs.
 *
 * The login is not frozen at startup. ~/.fizzer/token expires after seven days; a later
 * TUI login is stored as the local server session. This process follows whichever is still
 * valid and renews it during the last three days, the same window the backend uses for cookies.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { io } = require('socket.io-client');
const {
  startLocalAgentRun,
  cancelLocalAgentRun,
  reapOrphanedLocalAgentRuns,
  setNoteApiConfig,
} = require('../cascade-electron/agent-runner.cjs');
const { readSessions, rememberSession } = require('../cascade-electron/server-sessions.cjs');
const worktrees = require('../cascade-electron/worktrees.cjs');

// Same window as Cascade.Auth.Session.
const LOGIN_RENEWAL_WINDOW_SECONDS = 3 * 24 * 60 * 60;

function fizzerDir() {
  if (process.env.CASCADE_DATA_DIR) return process.env.CASCADE_DATA_DIR;
  const home = os.homedir();
  const primary = path.join(home, '.fizzer');
  if (fs.existsSync(primary)) return primary;
  const legacy = path.join(home, '.cascade');
  if (fs.existsSync(legacy)) return legacy;
  return primary;
}

function tokenPath() {
  return process.env.CASCADE_TOKEN_PATH || path.join(fizzerDir(), 'token');
}

function decodeTokenExp(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString());
    return Number.isFinite(payload.exp) ? payload.exp : 0;
  } catch {
    return 0;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

// Prefer a login that has not expired. Among those, prefer the one that lasts longest.
function resolveToken() {
  const candidates = [
    process.env.CASCADE_TOKEN,
    readText(tokenPath()),
    readSessions(fizzerDir()).local,
  ].map(value => String(value || '').trim()).filter(Boolean);
  const unique = [...new Set(candidates)];
  if (unique.length === 0) return '';
  const now = Math.floor(Date.now() / 1000);
  const fresh = unique.filter(candidate => decodeTokenExp(candidate) > now);
  const pool = fresh.length > 0 ? fresh : unique;
  pool.sort((left, right) => decodeTokenExp(right) - decodeTokenExp(left));
  return pool[0];
}

function parseRenewedSessionCookie(setCookies) {
  let best = '';
  let bestExp = 0;
  for (const line of setCookies || []) {
    const pair = String(line).split(';', 1)[0];
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    if (name !== 'cascade_session' && name !== '__Host-cascade_session') continue;
    const value = decodeURIComponent(pair.slice(eq + 1).trim());
    const exp = decodeTokenExp(value);
    if (value && exp >= bestExp) {
      best = value;
      bestExp = exp;
    }
  }
  return best;
}

function persistToken(token) {
  const next = String(token || '').trim();
  if (!next) return;
  const file = tokenPath();
  if (readText(file) !== next) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${next}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  }
  if (String(readSessions(fizzerDir()).local || '').trim() !== next) {
    rememberSession(fizzerDir(), 'local', next);
  }
}

const API_BASE = (process.env.API_URL || process.env.API_BASE || 'http://localhost:3000').replace(/\/$/, '');

let activeToken = '';
let lastConnectError = '';
let loginTimer = null;
let dispatchInterval = null;
const activeRuns = new Map();
const triggeringDispatches = new Set();
let runnerSocket = null;
let vaultSocket = null;
const mirrorEntries = new Map();
const remoteMirroring = process.env.FIZZER_REMOTE_MIRROR === '1' ||
  !['localhost', '127.0.0.1', '[::1]'].includes(new URL(API_BASE).hostname);
const { mirrors, closeMirrors } = require('../cascade-electron/vault-mirror.cjs');

function log(msg, ...args) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[DesktopRunner ${ts}] ${msg}`, ...args);
}

function errorLog(msg, ...args) {
  const ts = new Date().toISOString().slice(11, 19);
  console.error(`[DesktopRunner ${ts}] ${msg}`, ...args);
}

function adoptToken() {
  const next = resolveToken();
  if (!next) return '';
  const now = Math.floor(Date.now() / 1000);
  const previousExp = decodeTokenExp(activeToken);
  if (decodeTokenExp(readText(tokenPath())) < decodeTokenExp(next) ||
      String(readSessions(fizzerDir()).local || '').trim() !== next) {
    persistToken(next);
  }
  if (next !== activeToken) {
    activeToken = next;
    setNoteApiConfig({ url: API_BASE, token: next });
    if (previousExp && previousExp <= now && decodeTokenExp(next) > now) {
      log('Runner login was stale. Using the current local session.');
    }
  }
  return activeToken;
}

async function refreshLogin() {
  const current = adoptToken();
  const now = Math.floor(Date.now() / 1000);
  const exp = decodeTokenExp(current);
  if (!current || exp <= now || exp - now > LOGIN_RENEWAL_WINDOW_SECONDS) return;
  let response;
  try {
    response = await fetch(`${API_BASE}/api/session`, {
      headers: {
        Cookie: `cascade_session=${encodeURIComponent(current)}; __Host-cascade_session=${encodeURIComponent(current)}`,
      },
    });
  } catch (error) {
    errorLog('Login refresh failed:', error?.message || error);
    return;
  }
  const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  const renewed = parseRenewedSessionCookie(cookies);
  if (renewed && decodeTokenExp(renewed) > exp) {
    persistToken(renewed);
    adoptToken();
    log('Renewed the runner login before it expired.');
  }
}

function scheduleLoginMaintenance() {
  if (loginTimer) clearTimeout(loginTimer);
  const token = adoptToken();
  const now = Math.floor(Date.now() / 1000);
  const exp = decodeTokenExp(token);
  const renewalAt = exp - LOGIN_RENEWAL_WINDOW_SECONDS;
  let delay = 30_000;
  let refresh = false;
  if (token && exp > now && now >= renewalAt) {
    delay = 60 * 60 * 1000;
    refresh = true;
  } else if (token && now < renewalAt) {
    delay = Math.min((renewalAt - now) * 1000, 6 * 60 * 60 * 1000);
  }
  loginTimer = setTimeout(() => {
    ensureConnected();
    const step = refresh ? refreshLogin() : Promise.resolve();
    Promise.resolve(step).finally(scheduleLoginMaintenance);
  }, delay);
}

function connect() {
  const runnerInstanceId = `headless-runner-${process.pid}-${Date.now().toString(36)}`;

  runnerSocket = io(`${API_BASE}/runners`, {
    auth: (cb) => {
      adoptToken();
      cb({ token: activeToken });
    },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 10000,
    timeout: 20000,
  });

  runnerSocket.on('connect', () => {
    log(`Connected to ${API_BASE}/runners. Registering runner instance (${runnerInstanceId})...`);
    runnerSocket.emit('runner:register', {
      activeRunIds: [...activeRuns.keys()],
      runnerInstanceId,
    });
  });

  if (remoteMirroring) {
    // Multiplex the vault namespace on the existing runner transport.
    vaultSocket = runnerSocket.io.socket('/vault', {
      auth: (cb) => cb({ token: activeToken }),
    });
    vaultSocket.on('connect', () => {
      for (const [id, entry] of mirrorEntries) {
        vaultSocket.emit('joinVault', id);
        mirrors().notify(entry);
      }
    });
    for (const event of ['vault:filesChanged', 'vault:noteChanged', 'vault:noteCreated', 'vault:noteDeleted']) {
      vaultSocket.on(event, data => {
        const entry = mirrorEntries.get(data?.vaultId);
        if (entry) mirrors().notify(entry);
      });
    }
    vaultSocket.connect();
  }

  runnerSocket.on('runner:registered', (data) => {
    lastConnectError = '';
    log('Successfully registered with backend. Desktop runner is ONLINE.', data);
    void refreshLogin();
    void checkPendingDispatches();
  });

  runnerSocket.on('connect_error', (err) => {
    const message = err?.message || String(err);
    if (message !== lastConnectError) {
      errorLog('Connection error:', message);
      lastConnectError = message;
    }
    adoptToken();
  });

  runnerSocket.on('disconnect', (reason) => {
    log(`Disconnected: ${reason}`);
    if (reason === 'io server disconnect') {
      runnerSocket.connect();
    }
  });

  runnerSocket.on('run:delegate', async (payload) => {
    const runId = Number(payload?.runId);
    const agent = String(payload?.agent || 'unknown');
    log(`[Run #${runId}] Received delegation for agent "${agent}"`);

    activeRuns.set(runId, payload);

    try {
      const sendEvent = (event) => {
        if (!runnerSocket?.connected) return;
        try {
          const parsedPayload = JSON.parse(event.payload_json);
          runnerSocket.emit('runner:runEvent', {
            runId: event.runId,
            type: event.type,
            payload: parsedPayload,
          });
        } catch (e) {
          errorLog(`[Run #${runId}] Malformed event payload:`, e?.message);
        }
      };

      const result = await startLocalAgentRun(payload, sendEvent);
      log(`[Run #${runId}] Completed successfully`, result?.sessionId ? `(session: ${result.sessionId})` : '');
    } catch (err) {
      errorLog(`[Run #${runId}] Failed:`, err?.message || err);
    } finally {
      activeRuns.delete(runId);
    }
  });

  runnerSocket.on('run:cancel', async (data, ack) => {
    const runId = Number(data?.runId);
    log(`[Run #${runId}] Cancellation requested`);
    try {
      const ok = await cancelLocalAgentRun(runId);
      activeRuns.delete(runId);
      ack?.({ success: ok });
      log(`[Run #${runId}] Cancellation acknowledged (success: ${ok})`);
    } catch (err) {
      errorLog(`[Run #${runId}] Cancel error:`, err?.message || err);
      ack?.({ success: false });
    }
  });

  runnerSocket.on('workspace:prepare', async (opts, ack) => {
    try {
      log('Workspace prepare requested:', opts?.channelId || opts?.repository);
      const result = await worktrees.prepareWorkspace(opts);
      ack?.(result);
    } catch (err) {
      errorLog('Workspace prepare error:', err?.message || err);
      ack?.({ ok: false, error: err?.message || String(err) });
    }
  });
}

function ensureConnected() {
  if (!adoptToken() || runnerSocket) return;
  connect();
}

/**
 * Fallback poller to ensure dispatches from TUI/API without a browser
 * are initiated even if the backend's auto-dispatcher had a hiccup.
 */
async function checkPendingDispatches() {
  if (!runnerSocket?.connected || !activeToken) return;
  try {
    const vaultsRes = await fetch(`${API_BASE}/api/vaults`, {
      headers: { Authorization: `Bearer ${activeToken}` },
    });
    if (!vaultsRes.ok) return;
    const { vaults } = await vaultsRes.json();
    if (!Array.isArray(vaults)) return;

    for (const vault of vaults) {
      if (remoteMirroring && !mirrorEntries.has(vault.id)) {
        const entry = mirrors().watch({ origin: API_BASE, token: activeToken, vaultId: vault.id });
        mirrorEntries.set(vault.id, entry);
        if (vaultSocket?.connected) vaultSocket.emit('joinVault', vault.id);
        mirrors().notify(entry);
      }
      const notesRes = await fetch(`${API_BASE}/api/vaults/${vault.id}/notes`, {
        headers: { Authorization: `Bearer ${activeToken}` },
      });
      if (!notesRes.ok) continue;
      const { notes } = await notesRes.json();
      if (!Array.isArray(notes)) continue;

      const channels = notes.filter((n) => n.is_chat_channel || n.isChatChannel);
      for (const channel of channels) {
        const pendingRes = await fetch(
          `${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/agent-dispatches/pending`,
          { headers: { Authorization: `Bearer ${activeToken}` } }
        );
        if (!pendingRes.ok) continue;
        const { dispatches } = await pendingRes.json();
        if (!Array.isArray(dispatches) || dispatches.length === 0) continue;

        for (const dispatch of dispatches) {
          if (dispatch.runId != null) continue;
          if (triggeringDispatches.has(dispatch.id)) continue;
          triggeringDispatches.add(dispatch.id);

          log(`Found pending dispatch ${dispatch.id} in #${channel.title || channel.id} for agent ${dispatch.registration?.displayName || dispatch.registration?.agentId}`);

          try {
            const agentId = dispatch.registration?.agentId || 'claude-code';
            const agentMessageId = `msg-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const runBody = {
              prompt: dispatch.message?.body || 'Hello',
              note_id: null,
              agent: agentId,
              model: dispatch.registration?.model || undefined,
              cwd: dispatch.registration?.cwd || undefined,
              yolo: dispatch.registration?.yolo === true,
              registrationId: dispatch.registration?.id,
              chatDispatchId: dispatch.id,
              chat: {
                channelId: channel.id,
                messageId: agentMessageId,
                triggeringMessageId: dispatch.messageId,
                author: dispatch.registration?.displayName || 'Agent',
              },
            };

            const runRes = await fetch(`${API_BASE}/api/vaults/${vault.id}/runs`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${activeToken}`,
              },
              body: JSON.stringify(runBody),
            });

            if (runRes.ok) {
              const runData = await runRes.json();
              log(`Initiated run #${runData?.run?.id} for dispatch ${dispatch.id}`);
            } else {
              const errData = await runRes.json().catch(() => ({}));
              errorLog(`Failed to initiate run for dispatch ${dispatch.id}: ${runRes.status}`, errData?.error);
              triggeringDispatches.delete(dispatch.id);
            }
          } catch (e) {
            errorLog(`Error triggering dispatch ${dispatch.id}:`, e?.message || e);
            triggeringDispatches.delete(dispatch.id);
          }
        }
      }
    }
  } catch (err) {
    // Poller is best-effort fallback
  }
}

async function cleanup() {
  log('Shutting down runner daemon...');
  if (loginTimer) clearTimeout(loginTimer);
  if (dispatchInterval) clearInterval(dispatchInterval);
  vaultSocket?.disconnect();
  await closeMirrors();
  if (runnerSocket) {
    runnerSocket.disconnect();
    runnerSocket = null;
  }
  await reapOrphanedLocalAgentRuns().catch(() => {});
  process.exit(0);
}

function start() {
  log(`Target API: ${API_BASE}`);
  log('Runner login follows the current local session and renews before it expires.');
  ensureConnected();
  if (!runnerSocket) log('No runner login yet. Waiting for a local session.');
  dispatchInterval = setInterval(() => {
    void checkPendingDispatches();
  }, 4000);
  scheduleLoginMaintenance();
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

if (require.main === module) start();

module.exports = {
  resolveToken,
  decodeTokenExp,
  parseRenewedSessionCookie,
  persistToken,
};
