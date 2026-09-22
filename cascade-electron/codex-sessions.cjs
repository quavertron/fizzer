'use strict';
const { runStorage } = require('./storage-bin.cjs');

function listCodexSessions({ offset = 0, search = '' } = {}, home) {
  return runStorage(['codex-sessions', 'list', JSON.stringify({ offset, search, home: home || undefined })]);
}

function readCodexSession({ id, offset = 0, snapshotEnd } = {}, home) {
  return runStorage(['codex-sessions', 'read', JSON.stringify({
    id, offset, snapshotEnd, home: home || undefined,
  })]);
}

function assertCodexSessionIdle(id, home) {
  runStorage(['codex-sessions', 'assert-idle', JSON.stringify({ id, home: home || undefined })]);
}

module.exports = { listCodexSessions, readCodexSession, assertCodexSessionIdle };
