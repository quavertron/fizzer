'use strict';

// Read-only access to local Codex history. Callers select an ID, never a file path.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function database(home) {
  return new DatabaseSync(path.join(home || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'state_5.sqlite'), { readOnly: true });
}

function listCodexSessions({ offset = 0, search = '' } = {}, home) {
  let db;
  try {
    db = database(home);
    const start = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
    const rows = db.prepare(`SELECT id, title, cwd, updated_at FROM threads
      WHERE title LIKE ? ORDER BY updated_at DESC, id LIMIT 51 OFFSET ?`)
      .all(`%${String(search).slice(0, 200)}%`, start);
    return { sessions: rows.slice(0, 50), nextOffset: rows.length > 50 ? start + 50 : null };
  } finally { db?.close(); }
}

function readCodexSession({ id, offset = 0, snapshotEnd } = {}, home) {
  if (typeof id !== 'string' || !id || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid Codex session or cursor.');
  const db = database(home);
  let thread;
  try { thread = db.prepare('SELECT id, title, cwd, rollout_path FROM threads WHERE id=?').get(id); }
  finally { db.close(); }
  if (!thread) throw new Error('Codex session no longer exists.');
  const fd = fs.openSync(thread.rollout_path, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (snapshotEnd !== undefined && (!Number.isSafeInteger(snapshotEnd) || snapshotEnd < offset || snapshotEnd > size)) throw new Error('Codex history changed; import it again.');
    const limit = snapshotEnd ?? size;
    if (offset > size) throw new Error('Codex history changed; import it again.');
    const buffer = Buffer.alloc(Math.min(1024 * 1024, limit - offset));
    fs.readSync(fd, buffer, 0, buffer.length, offset);
    const end = buffer.lastIndexOf(10) + 1;
    if (!end && buffer.length === 1024 * 1024) throw new Error('A Codex history entry exceeds the 1 MB import limit.');
    const messages = [];
    let position = offset;
    let nextOffset = offset;
    for (const line of buffer.subarray(0, end).toString('utf8').split('\n')) {
      const start = position;
      position += Buffer.byteLength(line) + 1;
      if (!line) continue;
      nextOffset = position;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      const item = event.payload;
      if (event.type !== 'response_item' || item?.type !== 'message' || !['user', 'assistant'].includes(item.role)) continue;
      const body = Array.isArray(item.content) ? item.content.map(part => typeof part?.text === 'string' ? part.text : '').join('\n') : '';
      if (body.trim()) messages.push({ index: start, role: item.role, body, createdAt: event.timestamp });
      if (messages.length >= 200) break;
    }
    return { id: thread.id, title: thread.title, cwd: thread.cwd, messages, nextOffset, snapshotEnd: limit, hasMore: nextOffset < limit && nextOffset > offset };
  } finally { fs.closeSync(fd); }
}

function assertCodexSessionIdle(id, home) {
  const db = database(home);
  let thread;
  try { thread = db.prepare('SELECT rollout_path FROM threads WHERE id=?').get(id); }
  finally { db.close(); }
  if (!thread) throw new Error('The imported Codex session is not on this computer.');
  if (require('./local-agents.cjs').codexTurnIsActive(thread.rollout_path)) {
    throw new Error('This Codex session is still working elsewhere. Wait for its turn to finish before continuing in Fizzer.');
  }
}

module.exports = { listCodexSessions, readCodexSession, assertCodexSessionIdle };
