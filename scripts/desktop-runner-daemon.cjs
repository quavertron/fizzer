#!/usr/bin/env node
/**
 * @file desktop-runner-daemon.cjs — Headless agent execution runner for Fizzer / Cascade
 *
 * Connects to the Elixir backend's /runners Socket.IO namespace, registers as the active
 * desktop runner, and executes delegated agent runs (Claude, Codex, etc.) locally on this
 * machine via agent-runner.cjs.
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
const worktrees = require('../cascade-electron/worktrees.cjs');

const API_BASE = (process.env.API_URL || process.env.API_BASE || 'http://localhost:3000').replace(/\/$/, '');
const TOKEN_PATH = process.env.CASCADE_TOKEN_PATH || path.join(os.homedir(), '.cascade', 'token');

function readToken() {
  if (process.env.CASCADE_TOKEN) return process.env.CASCADE_TOKEN.trim();
  try {
    return fs.readFileSync(TOKEN_PATH, 'utf8').trim();
  } catch {
    return '';
  }
}

const token = readToken();
if (!token) {
  console.error(`[DesktopRunner] Error: No auth token found at ${TOKEN_PATH} or in CASCADE_TOKEN env.`);
  process.exit(1);
}

setNoteApiConfig({ url: API_BASE, token });

const activeRuns = new Map();
const triggeringDispatches = new Set();
let runnerSocket = null;

function log(msg, ...args) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[DesktopRunner ${ts}] ${msg}`, ...args);
}

function errorLog(msg, ...args) {
  const ts = new Date().toISOString().slice(11, 19);
  console.error(`[DesktopRunner ${ts}] ${msg}`, ...args);
}

log(`Target API: ${API_BASE}`);
log(`Using auth token from: ${TOKEN_PATH}`);

function connect() {
  const runnerInstanceId = `headless-runner-${process.pid}-${Date.now().toString(36)}`;

  runnerSocket = io(`${API_BASE}/runners`, {
    auth: { token },
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

  runnerSocket.on('runner:registered', (data) => {
    log('Successfully registered with backend. Desktop runner is ONLINE.', data);
    void checkPendingDispatches();
  });

  runnerSocket.on('connect_error', (err) => {
    errorLog('Connection error:', err?.message || err);
  });

  runnerSocket.on('disconnect', (reason) => {
    log(`Disconnected: ${reason}`);
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

/**
 * Fallback poller to ensure dispatches from TUI/API without a browser
 * are initiated even if the backend's auto-dispatcher had a hiccup.
 */
async function checkPendingDispatches() {
  if (!runnerSocket?.connected) return;
  try {
    const vaultsRes = await fetch(`${API_BASE}/api/vaults`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!vaultsRes.ok) return;
    const { vaults } = await vaultsRes.json();
    if (!Array.isArray(vaults)) return;

    for (const vault of vaults) {
      const notesRes = await fetch(`${API_BASE}/api/vaults/${vault.id}/notes`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!notesRes.ok) continue;
      const { notes } = await notesRes.json();
      if (!Array.isArray(notes)) continue;

      const channels = notes.filter((n) => n.is_chat_channel || n.isChatChannel);
      for (const channel of channels) {
        const pendingRes = await fetch(
          `${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/agent-dispatches/pending`,
          { headers: { Authorization: `Bearer ${token}` } }
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
                Authorization: `Bearer ${token}`,
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

const dispatchInterval = setInterval(() => {
  void checkPendingDispatches();
}, 4000);

async function cleanup() {
  log('Shutting down runner daemon...');
  clearInterval(dispatchInterval);
  if (runnerSocket) {
    runnerSocket.disconnect();
    runnerSocket = null;
  }
  await reapOrphanedLocalAgentRuns().catch(() => {});
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

connect();

