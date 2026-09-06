import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-codex-app-server-'));
const fakeBin = path.join(scratch, 'codex');
const launchLog = path.join(scratch, 'launches');
const protocolLog = path.join(scratch, 'protocol');

fs.writeFileSync(fakeBin, `#!/usr/bin/env node
const fs = require('fs');
const readline = require('readline');
fs.appendFileSync(${JSON.stringify(launchLog)}, '1\\n');
let thread = 0;
let turn = 0;
const interrupted = new Set();
const retryTurns = new Map();
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(protocolLog)}, message.method + ':' + (message.params?.threadId || '') + '\\n');
  if (message.method === 'initialize') return send({ id: message.id, result: {} });
  if (message.method === 'thread/start') return send({ id: message.id, result: { thread: { id: 'thread-' + (++thread) } } });
  if (message.method === 'thread/resume') {
    if (message.params.threadId === 'thread-locked' || (message.params.threadId === 'thread-stale' && !interrupted.has('stale-turn'))) {
      return send({ id: message.id, error: { message: 'thread ' + message.params.threadId + ' already has an active writer' } });
    }
    return send({ id: message.id, result: { thread: { id: message.params.threadId } } });
  }
  if (message.method === 'thread/read') {
    const turns = message.params.threadId === 'thread-stale' && !interrupted.has('stale-turn')
      ? [{ id: 'stale-turn', status: 'inProgress', items: [] }]
      : [];
    return send({ id: message.id, result: { thread: { id: message.params.threadId, turns } } });
  }
  if (message.method === 'turn/interrupt') {
    interrupted.add(message.params.turnId);
    if (retryTurns.has(message.params.turnId)) {
      clearTimeout(retryTurns.get(message.params.turnId));
      send({ method: 'turn/completed', params: { turn: { id: message.params.turnId, status: 'interrupted' } } });
    }
    return send({ id: message.id, result: {} });
  }
  if (message.method === 'thread/unsubscribe') return send({ id: message.id, result: { status: 'unsubscribed' } });
  if (message.method === 'turn/start') {
    const id = 'turn-' + (++turn);
    const prompt = message.params.input[0].text;
    const threadId = message.params.threadId;
    if (['retry succeeds', 'retry fails', 'retry stop', 'retry exits', 'fatal error', 'stale events'].includes(prompt)) {
      send({ id: message.id, result: { turn: { id } } });
      if (prompt === 'stale events') {
        send({ method: 'item/completed', params: { threadId, turnId: 'old-turn', item: { id: 'old-answer', type: 'agentMessage', text: 'STALE' } } });
        send({ method: 'error', params: { threadId, turnId: 'old-turn', willRetry: false, error: { message: 'old failure' } } });
        send({ method: 'item/completed', params: { threadId: 'other-thread', turnId: id, item: { id: 'foreign-answer', type: 'agentMessage', text: 'FOREIGN' } } });
      } else {
        send({ method: 'error', params: { threadId, turnId: id, willRetry: prompt !== 'fatal error', error: { message: 'Reconnecting... 1/5' } } });
        if (prompt === 'fatal error') return;
      }
      retryTurns.set(id, setTimeout(() => {
        if (prompt === 'retry exits') return process.exit(9);
        if (prompt === 'retry fails') return send({ method: 'turn/completed', params: { threadId, turn: { id, status: 'failed', error: { message: 'Retries exhausted' } } } });
        send({ method: 'item/completed', params: { threadId, turnId: id, item: { id: 'answer', type: 'agentMessage', text: 'Recovered answer' } } });
        send({ method: 'turn/completed', params: { threadId, turn: { id, status: 'completed' } } });
      }, 150));
      return;
    }
    if (message.params.input[0].text === 'stream tokens') {
      // A notification can race the turn/start response; preserve those tokens too.
      send({ method: 'item/agentMessage/delta', params: { turnId: id, itemId: 'progress', delta: 'Checking' } });
      send({ id: message.id, result: { turn: { id } } });
      setTimeout(() => {
        send({ method: 'item/agentMessage/delta', params: { turnId: id, itemId: 'progress', delta: ' files' } });
        send({ method: 'item/completed', params: { turnId: id, item: { id: 'progress', type: 'agentMessage', text: 'Checking files.' } } });
        send({ method: 'item/agentMessage/delta', params: { turnId: id, itemId: 'final', delta: '' } });
        send({ method: 'item/agentMessage/delta', params: { turnId: id, itemId: 'final', delta: 'Fixed' } });
        send({ method: 'item/agentMessage/delta', params: { turnId: id, itemId: 'final', delta: ' it.' } });
        send({ method: 'item/completed', params: { turnId: id, item: { id: 'final', type: 'agentMessage', text: 'Fixed it.' } } });
        send({ method: 'item/completed', params: { turnId: id, item: { id: 'final', type: 'agentMessage', text: 'Fixed it.' } } });
        send({ method: 'turn/completed', params: { turn: { id, status: 'completed' } } });
      }, 200);
      return;
    }
    send({ id: message.id, result: { turn: { id } } });
    setImmediate(() => {
      if (message.params.input[0].text === 'empty turn') {
        return send({ method: 'turn/completed', params: { turn: { id, status: 'completed' } } });
      }
      send({ method: 'item/started', params: { turnId: id, item: { id: 'reason-' + id, type: 'reasoning' } } });
      send({ method: 'item/completed', params: { turnId: id, item: { id: 'reason-' + id, type: 'reasoning', summary: ['Thinking'] } } });
      send({ method: 'item/started', params: { turnId: id, item: { id: 'answer-' + id, type: 'agentMessage' } } });
      send({ method: 'item/completed', params: { turnId: id, item: { id: 'answer-' + id, type: 'agentMessage', text: 'answer ' + turn } } });
      send({ method: 'turn/completed', params: { turn: { id, status: 'completed' } } });
    });
  }
});
`);
fs.chmodSync(fakeBin, 0o755);
process.env.CODEX_BIN = fakeBin;
process.env.RUNNER_CODEX_PERSISTENT = '1';

const { runCliAgent, shutdownPersistentCliAgents, cancelCliAgentRun } = await import('./cli-agent.js');

test('Codex app-server is reused across sequential turns', async () => {
  const sessions: string[] = [];
  const blocks: any[] = [];
  const timings: any[] = [];
  const first = await runCliAgent({
    agent: 'codex', context: '', userPrompt: 'first', cwd: scratch,
    emit(type, payload: any) {
      if (type === 'timing') timings.push(payload);
      if (type === 'session') sessions.push(payload.sessionId);
      if (type === 'text') blocks.push(...(payload.message?.content || []));
    },
  });
  const second = await runCliAgent({
    agent: 'codex', context: '', userPrompt: 'second', cwd: scratch,
    resumeSessionId: first.sessionId, emit() {},
  });

  assert.deepEqual(timings.map(event => event.phase), ['request_start', 'first_response', 'completion']);
  assert.equal(new Set(timings.map(event => event.requestId)).size, 1);
  assert.ok(timings.every(event => event.boundary === 'codex_app_server_turn' && Number.isFinite(Date.parse(event.observedAt))));
  assert.ok(timings[1].elapsedMs >= timings[0].elapsedMs);
  assert.ok(timings[2].elapsedMs >= timings[1].elapsedMs);
  assert.equal(timings[2].outcome, 'completed');
  assert.equal(first.summary, 'answer 1');
  assert.equal(second.summary, 'answer 2');
  assert.deepEqual(sessions, ['thread-1']);
  assert.deepEqual(blocks.map(block => block.type), ['thinking', 'text']);
  assert.equal(fs.readFileSync(launchLog, 'utf8').trim().split('\n').length, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(fs.readFileSync(protocolLog, 'utf8'), /thread\/unsubscribe:thread-1/);
  shutdownPersistentCliAgents();
});

test('streams public tokens before completion without duplicating final items', async (t) => {
  t.after(() => shutdownPersistentCliAgents());
  const chunks: string[] = [];
  let firstToken!: () => void;
  const streaming = new Promise<void>(resolve => { firstToken = resolve; });
  let finished = false;
  const run = runCliAgent({
    agent: 'codex', context: '', userPrompt: 'stream tokens', cwd: scratch,
    emit(type, payload: any) {
      if (type === 'text' && payload.chatVisible) {
        chunks.push(payload.message.content[0].text);
        firstToken();
      }
    },
  }).then(result => { finished = true; return result; });
  await streaming;
  assert.equal(finished, false);
  assert.deepEqual(chunks, ['Checking']);
  const result = await run;
  assert.deepEqual(chunks, ['Checking', ' files', '.', '\n\nFixed', ' it.']);
  assert.equal(chunks.join(''), 'Checking files.\n\nFixed it.');
  assert.equal(result.summary, 'Fixed it.');
  shutdownPersistentCliAgents();
});

test('an unfinished writer is interrupted before its thread is resumed', async () => {
  const result = await runCliAgent({
    agent: 'codex', context: '', userPrompt: 'recover stale turn', cwd: scratch,
    resumeSessionId: 'thread-stale', emit() {},
  });

  assert.equal(result.sessionId, 'thread-stale');
  assert.equal(result.summary, 'answer 1');
  const protocol = fs.readFileSync(protocolLog, 'utf8');
  assert.match(protocol, /thread\/read:thread-stale/);
  assert.match(protocol, /turn\/interrupt:thread-stale/);
  shutdownPersistentCliAgents();
});

test('an idle writer that cannot be released falls back to a fresh thread', async () => {
  const harness: string[] = [];
  const sessions: string[] = [];
  const result = await runCliAgent({
    agent: 'codex', context: '', userPrompt: 'escape locked thread', cwd: scratch,
    resumeSessionId: 'thread-locked',
    emit(type, payload: any) {
      if (type === 'session') sessions.push(payload.sessionId);
      if (type === 'harness') harness.push(payload.data);
    },
  });

  assert.equal(result.sessionId, 'thread-1');
  assert.deepEqual(sessions, ['thread-1']);
  assert.match(harness.join('\n'), /continuing in a fresh session/);
  shutdownPersistentCliAgents();
});

test('Codex acknowledgements and completion alone do not invent a first response', async () => {
  const timings: any[] = [];
  await runCliAgent({ agent: 'codex', context: '', userPrompt: 'empty turn', cwd: scratch,
    emit(type, payload) { if (type === 'timing') timings.push(payload); } });
  assert.deepEqual(timings.map(event => event.phase), ['request_start', 'completion']);
  shutdownPersistentCliAgents();
});


for (const prompt of ['retry succeeds', 'retry fails', 'retry stop', 'retry exits', 'fatal error', 'stale events']) {
  test(`Codex terminal ownership: ${prompt}`, async (t) => {
    t.after(() => shutdownPersistentCliAgents());
    const events: any[] = [];
    const start = fs.readFileSync(protocolLog, 'utf8').length;
    const run = runCliAgent({ agent: 'codex', context: '', userPrompt: prompt, cwd: scratch,
      resumeSessionId: 'thread-retry', runId: 98765,
      emit(type, payload: any) {
        events.push({ type, ...payload });
        if (type === 'harness' && payload.data.includes('Reconnecting')) {
          assert.doesNotMatch(fs.readFileSync(protocolLog, 'utf8').slice(start), /thread\/unsubscribe/);
          if (prompt === 'retry stop') assert.equal(cancelCliAgentRun(98765), true);
        }
      },
    });
    if (prompt === 'retry exits') await assert.rejects(run, /app-server exited/);
    else if (prompt === 'retry fails') await assert.rejects(run, /Retries exhausted/);
    else if (prompt === 'retry stop') await assert.rejects(run, /interrupted/);
    else if (prompt === 'fatal error') await assert.rejects(run, /Reconnecting/);
    else {
      const result = await run;
      assert.equal(result.summary, 'Recovered answer');
      assert.equal(result.sessionId, 'thread-retry');
      const text = events.filter(e => e.type === 'text').flatMap(e => e.message?.content || []).map(b => b.text || '').join('');
      assert.equal(text, 'Recovered answer');
    }
    if (prompt.startsWith('retry ')) assert.ok(events.some(e => e.type === 'harness' && e.data.includes('Reconnecting')));
    const completions = events.filter(e => e.type === 'timing' && e.phase === 'completion');
    assert.equal(completions.length, 1);
    assert.equal(completions[0].outcome, ['retry succeeds', 'stale events'].includes(prompt) ? 'completed' : prompt === 'retry stop' ? 'interrupted' : 'failed');
    await new Promise(resolve => setTimeout(resolve, 30));
    const protocol = fs.readFileSync(protocolLog, 'utf8').slice(start);
    assert.equal((protocol.match(/turn\/start:/g) || []).length, 1);
    assert.equal((protocol.match(/thread\/unsubscribe:/g) || []).length, prompt === 'retry exits' ? 0 : 1);
  });
}

test.after(() => {
  shutdownPersistentCliAgents();
  fs.rmSync(scratch, { recursive: true, force: true });
});
