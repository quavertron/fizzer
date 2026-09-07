'use strict';

const { spawn: defaultSpawn } = require('node:child_process');

const ALLOWED_AGENT_IDS = Object.freeze([
  'claude-code',
  'codex',
  'grok',
  'antigravity',
]);
const ALLOWED_AGENT_SET = new Set(ALLOWED_AGENT_IDS);
const CODEX_TIMEOUT_MS = 10_000;
const ANTIGRAVITY_TIMEOUT_MS = 10_000;
const MAX_STDOUT_BYTES = 1_048_576;
const MAX_FIELD_LENGTH = 512;
const MAX_CURSOR_LENGTH = 2_048;
const MAX_CODEX_PAGES = 100;

const ERROR_MESSAGES = Object.freeze({
  unsupported: (provider) => `${provider} local model catalog is unsupported.`,
  unavailable: (provider) => `${provider} local model catalog is unavailable.`,
  malformed: (provider) => `${provider} returned an invalid model catalog.`,
  empty: (provider) => `${provider} returned no models.`,
  timeout: (provider) => `${provider} model catalog timed out.`,
});

function fallback(provider, kind = 'unavailable') {
  return {
    models: [],
    source: 'fallback',
    error: ERROR_MESSAGES[kind]?.(provider) || ERROR_MESSAGES.unavailable(provider),
  };
}

function cleanText(value, { allowWhitespace = false } = {}) {
  if (typeof value !== 'string') return null;
  const withoutControls = value.replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}]/gu, '');
  const cleaned = allowWhitespace
    ? withoutControls.replace(/\s+/gu, ' ').trim()
    : withoutControls.trim();
  if (!cleaned || cleaned.length > MAX_FIELD_LENGTH) return null;
  return cleaned;
}

function sanitizeModel(id, displayName) {
  const cleanId = cleanText(id);
  const cleanLabel = cleanText(displayName, { allowWhitespace: true });
  if (!cleanId || !cleanLabel || /\s/u.test(cleanId)) return null;
  return { id: cleanId, label: cleanLabel };
}

function isHiddenModel(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  return entry.hidden === true
    || entry.isHidden === true
    || entry.visibility === 'hidden';
}

function readCodexPage(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result) || !Array.isArray(result.data)) {
    return null;
  }
  const { nextCursor } = result;
  if (nextCursor !== undefined && nextCursor !== null) {
    if (typeof nextCursor !== 'string' || !nextCursor || nextCursor.length > MAX_CURSOR_LENGTH || /[\u0000-\u001f\u007f-\u009f]/u.test(nextCursor)) {
      return null;
    }
  }
  return { entries: result.data, nextCursor: nextCursor || null };
}

function parseCodexModelPage(result, models, seenIds) {
  const page = readCodexPage(result);
  if (!page) return null;

  for (const entry of page.entries) {
    if (isHiddenModel(entry)) continue;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const model = sanitizeModel(entry.id, entry.displayName ?? entry.id);
    if (!model || seenIds.has(model.id)) continue;
    seenIds.add(model.id);
    models.push(model);
  }
  return { nextCursor: page.nextCursor };
}

function terminateChild(child) {
  if (!child) return;
  try { child.stdin?.destroy(); } catch { /* child is already gone */ }
  try { child.kill('SIGKILL'); } catch { /* child is already gone */ }
}

function outputSize(value) {
  return Buffer.byteLength(value, 'utf8');
}

function collectCodexModels({ spawnImpl = defaultSpawn, timeoutMs = CODEX_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const provider = 'Codex';
    const command = process.env.CODEX_BIN || 'codex';
    let child;
    let settled = false;
    let timer;
    let lineBuffer = '';
    let stdoutBytes = 0;
    let phase = 'initialize';
    let currentRequestId = 1;
    let pages = 0;
    const models = [];
    const seenIds = new Set();
    const seenCursors = new Set();

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      terminateChild(child);
      resolve(result);
    };
    const fail = (kind) => finish(fallback(provider, kind));
    const send = (message) => {
      try {
        if (!child?.stdin || child.stdin.destroyed) {
          fail('unavailable');
          return false;
        }
        child.stdin.write(`${JSON.stringify(message)}\n`);
        return true;
      } catch {
        fail('unavailable');
        return false;
      }
    };
    const requestPage = (cursor = null) => {
      phase = 'model-list';
      currentRequestId += 1;
      const params = { limit: 100, includeHidden: false };
      if (cursor !== null) params.cursor = cursor;
      send({ id: currentRequestId, method: 'model/list', params });
    };
    const handleMessage = (message) => {
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        fail('malformed');
        return;
      }
      if (phase === 'initialize' && message.id === 1) {
        if (message.error) {
          fail('unavailable');
          return;
        }
        if (
          !Object.prototype.hasOwnProperty.call(message, 'result')
          || !message.result
          || typeof message.result !== 'object'
          || Array.isArray(message.result)
        ) {
          fail('malformed');
          return;
        }
        phase = 'initialized';
        if (!send({ method: 'initialized' })) return;
        requestPage();
        return;
      }
      if (phase !== 'model-list' || message.id !== currentRequestId) return;
      if (message.error || !Object.prototype.hasOwnProperty.call(message, 'result')) {
        fail('unavailable');
        return;
      }
      pages += 1;
      if (pages > MAX_CODEX_PAGES) {
        fail('malformed');
        return;
      }
      const page = parseCodexModelPage(message.result, models, seenIds);
      if (!page) {
        fail('malformed');
        return;
      }
      const { nextCursor } = page;
      if (nextCursor === null) {
        if (!models.length) fail('empty');
        else finish({ models, source: 'live' });
        return;
      }
      if (seenCursors.has(nextCursor)) {
        fail('malformed');
        return;
      }
      seenCursors.add(nextCursor);
      requestPage(nextCursor);
    };

    try {
      child = spawnImpl(command, ['app-server', '--stdio'], {
        env: process.env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch {
      fail('unavailable');
      return;
    }
    if (!child || !child.stdout || !child.stdin) {
      fail('unavailable');
      return;
    }

    timer = setTimeout(() => fail('timeout'), timeoutMs);
    timer.unref?.();
    child.once('error', () => fail('unavailable'));
    child.once('close', () => {
      if (settled) return;
      const line = lineBuffer.trim();
      if (line) {
        lineBuffer = '';
        try {
          handleMessage(JSON.parse(line));
        } catch {
          fail('malformed');
          return;
        }
      }
      if (!settled) fail('unavailable');
    });
    child.stdin.on('error', () => fail('unavailable'));
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      const text = chunk.toString('utf8');
      stdoutBytes += Buffer.isBuffer(chunk) ? chunk.length : outputSize(text);
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        fail('malformed');
        return;
      }
      lineBuffer += text;
      if (outputSize(lineBuffer) > MAX_STDOUT_BYTES) {
        fail('malformed');
        return;
      }
      let newline;
      while (!settled && (newline = lineBuffer.indexOf('\n')) >= 0) {
        const line = lineBuffer.slice(0, newline).trim();
        lineBuffer = lineBuffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch {
          fail('malformed');
          break;
        }
        handleMessage(message);
      }
    });

    if (!send({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'cascade', title: 'Cascade', version: '0.2.0' },
        capabilities: { experimentalApi: true },
      },
    })) return;
  });
}

function parseAntigravityModels(stdout) {
  const models = [];
  const seenIds = new Set();
  for (const rawLine of String(stdout || '').split(/\r?\n/u)) {
    const tab = rawLine.indexOf('\t');
    if (tab < 1 || rawLine.indexOf('\t', tab + 1) !== -1) continue;
    const model = sanitizeModel(rawLine.slice(0, tab), rawLine.slice(tab + 1));
    if (!model || (model.id.toLowerCase() === 'id' && model.label.toLowerCase() === 'label')) continue;
    if (seenIds.has(model.id)) continue;
    seenIds.add(model.id);
    models.push(model);
  }
  return models;
}

function collectAntigravityModels({ spawnImpl = defaultSpawn, timeoutMs = ANTIGRAVITY_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const provider = 'Antigravity';
    const command = process.env.AGY_BIN || 'agy';
    let child;
    let settled = false;
    let timer;
    let stdout = '';
    let stdoutBytes = 0;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      terminateChild(child);
      resolve(result);
    };
    const fail = (kind) => finish(fallback(provider, kind));

    try {
      child = spawnImpl(command, ['models'], {
        env: process.env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      fail('unavailable');
      return;
    }
    if (!child || !child.stdout) {
      fail('unavailable');
      return;
    }

    timer = setTimeout(() => fail('timeout'), timeoutMs);
    timer.unref?.();
    child.once('error', () => fail('unavailable'));
    child.once('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        fail('unavailable');
        return;
      }
      const models = parseAntigravityModels(stdout);
      if (!models.length) fail('empty');
      else finish({ models, source: 'live' });
    });
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      stdout += chunk.toString('utf8');
      stdoutBytes += Buffer.isBuffer(chunk) ? chunk.length : outputSize(chunk.toString('utf8'));
      if (stdoutBytes > MAX_STDOUT_BYTES) fail('malformed');
    });
  });
}

async function getAgentModels(agentId) {
  if (typeof agentId !== 'string' || !ALLOWED_AGENT_SET.has(agentId)) {
    return fallback('Agent', 'unsupported');
  }
  if (agentId === 'claude-code') return fallback('Claude', 'unsupported');
  if (agentId === 'grok') return fallback('Grok', 'unsupported');
  if (agentId === 'codex') return collectCodexModels();
  return collectAntigravityModels();
}

module.exports = {
  ALLOWED_AGENT_IDS,
  getAgentModels,
  collectCodexModels,
  collectAntigravityModels,
  parseCodexModelPage,
  parseAntigravityModels,
  sanitizeModel,
};
