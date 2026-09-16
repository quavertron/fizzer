/**
 * Codex resume behaviour, driven against a fake `codex` binary.
 *
 * The case that matters: the session id we hand to `codex exec resume` lives in
 * Codex's local rollout store, so it can be gone. When it is, the resume fails
 * and — without the fallback — takes the whole turn with it, for a reason that
 * has nothing to do with what was asked.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'node:child_process';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-codex-'));
const fakeBin = path.join(scratch, 'fake-codex');
const fakeAkronBin = path.join(scratch, 'fake-akron');
const argLog = path.join(scratch, 'args.jsonl');
const fakeHermesBin = path.join(scratch, 'fake-hermes');
const fakePiBin = path.join(scratch, 'fake-pi');
const piArgLog = path.join(scratch, 'pi-args.jsonl');
const hermesArgLog = path.join(scratch, 'hermes-args.jsonl');
const hermes503Log = path.join(scratch, 'hermes-503-attempts.txt');
const akronChildPid = path.join(scratch, 'akron-child.pid');
const akronAttemptLog = path.join(scratch, 'akron-attempts.txt');
const agentProcessLeaseDir = path.join(scratch, 'agent-processes');

fs.writeFileSync(fakeBin, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argLog)}, JSON.stringify(args) + '\\n');
if (process.env.FAKE_RUNTIME_ENV) {
  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: process.env.FAKE_RUNTIME_ENV + ':' + process.env.PATH } }));
  process.exit(0);
}
if (process.env.FAKE_CODEX_BROKEN) {
  process.stderr.write('Error: disk on fire\\n');
  process.exit(1);
}
if (args.includes('resume') && !process.env.FAKE_CODEX_RESUME_OK) {
  // What codex does for a pruned session: the complaint on stderr, no stdout.
  // Real codex exits 1; FAKE_CODEX_QUIET_FAIL covers the zero-exit variant.
  process.stderr.write('Error: thread/resume: thread/resume failed: no rollout found for thread id gone (code -32600)\\n');
  process.exit(process.env.FAKE_CODEX_QUIET_FAIL ? 0 : 1);
}
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'fresh-session-1' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'answered' } }) + '\\n');
process.exit(0);
`);
fs.chmodSync(fakeBin, 0o755);
fs.writeFileSync(fakeAkronBin, `#!/usr/bin/env node
const fs = require('fs');
const { spawn } = require('child_process');
if (process.env.FAKE_AKRON_RETRY) {
  let attempts = 0;
  try { attempts = Number(fs.readFileSync(${JSON.stringify(akronAttemptLog)}, 'utf8')) || 0; } catch {}
  attempts += 1;
  fs.writeFileSync(${JSON.stringify(akronAttemptLog)}, String(attempts));
  if (attempts > 1) {
    process.stdout.write('recovered answer\\n');
    process.exit(0);
  }
}
if (process.env.FAKE_AKRON_EVENTS) {
  if (process.env.HERMES_CASCADE_EVENTS !== '1') {
    process.stderr.write('cascade events disabled\\n');
    process.exit(13);
  }
  process.stderr.write(JSON.stringify({ type: 'reasoning.delta', text: 'mapping the harness' }) + '\\n');
  process.stdout.write('native answer\\n');
  process.exit(0);
}
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(akronChildPid)}, String(child.pid));
setInterval(() => {}, 1000);
`);
fs.chmodSync(fakeAkronBin, 0o755);

// Mirrors the real `hermes chat -Q` output shape: the session id lands on
// stderr, and reasoning arrives as a box-drawn panel on stdout whose body lines
// are CR-terminated while the actual answer ends with a bare LF.
fs.writeFileSync(fakeHermesBin, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(hermesArgLog)}, JSON.stringify(args) + '\\n');
const resumeAt = args.indexOf('--resume');
const session = resumeAt >= 0 ? args[resumeAt + 1] : '20260806_140649_084b24';
if (process.env.FAKE_RUNTIME_ENV) {
  process.stdout.write(process.env.FAKE_RUNTIME_ENV + ':' + process.env.PATH);
  process.stderr.write('session_id: trailing-session');
  process.exit(0);
}
if (process.env.FAKE_HERMES_503) {
  // Hermes exhausts its own retries, prints the capacity error as its answer,
  // and still exits 0. Recover on the attempt named by FAKE_HERMES_503.
  let n = 0;
  try { n = Number(fs.readFileSync(${JSON.stringify(hermes503Log)}, 'utf8')) || 0; } catch {}
  n += 1;
  fs.writeFileSync(${JSON.stringify(hermes503Log)}, String(n));
  if (n < Number(process.env.FAKE_HERMES_503)) {
    process.stdout.write('API call failed after 3 retries: HTTP 503: The requested model is temporarily unavailable due to upstream capacity limits. Please try again in a moment.\\n');
    if (process.env.FAKE_HERMES_503 !== '2') process.stderr.write('\\nsession_id: ' + session + '\\n');
    process.exit(0);
  }
  process.stdout.write('recovered after capacity error\\n');
  process.stderr.write('\\nsession_id: ' + session + '\\n');
  process.exit(0);
}
if (process.env.FAKE_HERMES_TALKS_ABOUT_503) {
  process.stdout.write('To handle this, retry when the API returns HTTP 503 with backoff.\\n');
  process.stderr.write('\\nsession_id: ' + session + '\\n');
  process.exit(0);
}
process.stdout.write('\\r\\n');
process.stdout.write('\\u250c\\u2500 Reasoning \\u2500\\u2500\\u2500\\u2500\\u2500\\u2510\\r\\n');
process.stdout.write('weighing the options\\r\\n');
process.stdout.write(resumeAt >= 0 ? 'resumed answer\\n' : 'fresh answer\\n');
process.stderr.write('\\nsession_id: ' + session + '\\n');
process.exit(0);
`);
fs.chmodSync(fakeHermesBin, 0o755);
fs.writeFileSync(fakePiBin, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(piArgLog)}, JSON.stringify(args) + '\\n');
process.stdout.write(JSON.stringify({ type: 'session', version: 3, id: 'pi-session-1', cwd: process.cwd() }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'message_update', usage: {}, assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'checking' } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'read', args: { path: 'README.md' } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'read', result: { content: [{ type: 'text', text: 'contents' }] }, isError: false }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'message_update', usage: {}, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'done' } }) + '\\n');
process.exit(0);
`);
fs.chmodSync(fakePiBin, 0o755);
process.env.CODEX_BIN = fakeBin;
process.env.AKRON_BIN = fakeAkronBin;
process.env.HERMES_BIN = fakeHermesBin;
process.env.PI_BIN = fakePiBin;
process.env.RUNNER_CLI_HEARTBEAT_MS = '25';
process.env.RUNNER_HERMES_UPSTREAM_BACKOFF_MS = '20';
process.env.RUNNER_AKRON_IDLE_TIMEOUT_MS = '1000';
process.env.CASCADE_AGENT_PROCESS_DIR = agentProcessLeaseDir;

const {
  activeCliProcesses,
  cancelCliAgentRun,
  reapOrphanedCliAgentProcesses,
  runCliAgent,
} = await import('./cli-agent.js');

function readArgs(): string[][] {
  return fs.readFileSync(argLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function resetArgs() {
  fs.writeFileSync(argLog, '');
}

const emit = () => {};

test('shared drivers isolate concurrent env overrides and flush partial provider lines', async () => {
  for (const agent of ['codex', 'hermes'] as const) {
    const results = await Promise.all(['first', 'second'].map((value, index) => runCliAgent({
      agent, context: '', userPrompt: 'env', cwd: scratch, emit,
      runId: 93000 + index,
      env: { FAKE_RUNTIME_ENV: value },
    })));
    assert.deepEqual(results.map((result) => result.summary), [
      `first:${process.env.PATH}`, `second:${process.env.PATH}`,
    ]);
    if (agent === 'hermes') {
      assert.ok(results.every((result) => result.sessionId === 'trailing-session'));
    }
    for (const runId of [93000, 93001]) {
      assert.equal(activeCliProcesses.has(runId), false);
      assert.equal(fs.existsSync(path.join(agentProcessLeaseDir, `${runId}.json`)), false);
    }
  }
  assert.equal(process.env.FAKE_RUNTIME_ENV, undefined);
});

test('Pi uses JSON mode, resumes by session id, and translates native events', async () => {
  fs.writeFileSync(piArgLog, '');
  const events: Array<{ type: string; payload: any }> = [];
  const result = await runCliAgent({
    agent: 'pi',
    context: '',
    userPrompt: 'inspect it',
    cwd: scratch,
    resumeSessionId: 'prior-pi-session',
    model: 'openai/gpt-5.6-terra',
    emit: (type, payload) => events.push({ type, payload }),
  });
  const args = JSON.parse(fs.readFileSync(piArgLog, 'utf8').trim());
  assert.deepEqual(args.slice(0, 5), ['--mode', 'json', '--approve', '--session', 'prior-pi-session']);
  assert.equal(args[args.indexOf('--model') + 1], 'openai/gpt-5.6-terra');
  assert.equal(args.at(-1), 'inspect it');
  assert.equal(result.sessionId, 'pi-session-1');
  assert.equal(result.summary, 'done');
  assert.ok(events.some((event) => event.type === 'text' && event.payload.message.content[0].type === 'thinking'));
  assert.ok(events.some((event) => event.type === 'text' && event.payload.message.content[0].type === 'tool_use'));
  assert.ok(events.some((event) => event.type === 'user' && event.payload.message.content[0].type === 'tool_result'));
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('condition did not become true');
}

test('Akron emits silent-work heartbeats and cancellation kills its process tree', async () => {
  fs.rmSync(akronChildPid, { force: true });
  const harness: string[] = [];
  const run = runCliAgent({
    agent: 'akron-grok', context: '', userPrompt: 'work silently', cwd: scratch, runId: 8080,
    emit: (type, payload: any) => {
      if (type === 'harness') harness.push(String(payload?.data || ''));
    },
  });
  await waitFor(() => fs.existsSync(akronChildPid));
  const descendantPid = Number(fs.readFileSync(akronChildPid, 'utf8'));
  await waitFor(() => harness.some((line) => line.includes('still working')));

  assert.equal(cancelCliAgentRun(8080), true);
  await assert.rejects(run, /exited with code/);
  await waitFor(() => {
    try {
      process.kill(descendantPid, 0);
      return false;
    } catch {
      return true;
    }
  });
});

test('Akron provider silence times out and releases its process tree', async () => {
  fs.rmSync(akronChildPid, { force: true });
  const started = Date.now();
  const run = runCliAgent({
    agent: 'akron-grok', context: '', userPrompt: 'provider never answers', cwd: scratch, runId: 8081,
    emit,
  });
  await waitFor(() => fs.existsSync(akronChildPid));
  const descendantPid = Number(fs.readFileSync(akronChildPid, 'utf8'));
  await assert.rejects(run, /produced no output for 1000ms and was stopped/);
  assert.ok(Date.now() - started < 3_000);
  await waitFor(() => {
    try {
      process.kill(descendantPid, 0);
      return false;
    } catch {
      return true;
    }
  });
});

test('Akron retries one byte-silent provider request with a fresh bridge', async () => {
  fs.rmSync(akronAttemptLog, { force: true });
  process.env.FAKE_AKRON_RETRY = '1';
  const harness: string[] = [];
  try {
    const result = await runCliAgent({
      agent: 'akron-grok', context: '', userPrompt: 'recover once', cwd: scratch, runId: 8082,
      emit: (type, payload: any) => {
        if (type === 'harness') harness.push(String(payload?.data || ''));
      },
    });
    assert.equal(result.summary, 'recovered answer');
  } finally {
    delete process.env.FAKE_AKRON_RETRY;
  }
  assert.equal(fs.readFileSync(akronAttemptLog, 'utf8'), '2');
  assert.match(harness.join(''), /retrying Akron once with a fresh bridge/);
});

async function crashHostLeavingAkronOrphan(runId: number): Promise<{ lease: any; descendantPid: number }> {
  fs.rmSync(akronChildPid, { force: true });
  const hostScript = `
    import fs from 'node:fs';
    import { runCliAgent } from ${JSON.stringify(new URL('./cli-agent.ts', import.meta.url).href)};
    void runCliAgent({ agent: 'akron-grok', context: '', userPrompt: 'orchestrate until crash', cwd: ${JSON.stringify(scratch)}, runId: ${runId}, emit() {} });
    const lease = ${JSON.stringify(path.join(agentProcessLeaseDir, `${runId}.json`))};
    const timer = setInterval(() => {
      if (fs.existsSync(lease)) {
        clearInterval(timer);
        process.exit(77);
      }
    }, 10);
  `;
  const crashedHost = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', hostScript], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AKRON_BIN: fakeAkronBin,
      CASCADE_AGENT_PROCESS_DIR: agentProcessLeaseDir,
      RUNNER_AKRON_IDLE_TIMEOUT_MS: '30000',
    },
    stdio: 'ignore',
  });
  const exitCode = await new Promise<number | null>((resolve) => crashedHost.once('exit', resolve));
  assert.equal(exitCode, 77, 'simulated Electron owner should crash abruptly');
  await waitFor(() => fs.existsSync(akronChildPid));
  const lease = JSON.parse(fs.readFileSync(path.join(agentProcessLeaseDir, `${runId}.json`), 'utf8'));
  const descendantPid = Number(fs.readFileSync(akronChildPid, 'utf8'));
  assert.doesNotThrow(() => process.kill(lease.processGroupId, 0), 'detached Akron should reproduce the orphan');
  return { lease, descendantPid };
}

test('a crashed desktop owner leaves a real Akron group that the next coordinator reaps', { skip: process.platform !== 'linux' }, async () => {
  fs.rmSync(agentProcessLeaseDir, { recursive: true, force: true });
  const { lease } = await crashHostLeavingAkronOrphan(9090);

  assert.deepEqual(await reapOrphanedCliAgentProcesses(), [9090]);
  await waitFor(() => {
    try { process.kill(lease.processGroupId, 0); return false; } catch { return true; }
  });

  process.env.FAKE_AKRON_EVENTS = '1';
  try {
    const next = await runCliAgent({
      agent: 'akron-grok', context: '', userPrompt: 'next coordinator turn', cwd: scratch, runId: 9091, emit,
    });
    assert.equal(next.summary, 'native answer');
  } finally {
    delete process.env.FAKE_AKRON_EVENTS;
  }
});

test('cancel after losing the in-memory process map still kills via durable lease', { skip: process.platform !== 'linux' }, async () => {
  fs.rmSync(agentProcessLeaseDir, { recursive: true, force: true });
  fs.rmSync(akronChildPid, { force: true });
  const run = runCliAgent({
    agent: 'akron-grok', context: '', userPrompt: 'survive module reload', cwd: scratch, runId: 9100, emit,
  });
  await waitFor(() => fs.existsSync(path.join(agentProcessLeaseDir, '9100.json')));
  await waitFor(() => fs.existsSync(akronChildPid));
  const descendantPid = Number(fs.readFileSync(akronChildPid, 'utf8'));

  // Simulate hot-reload / map loss while the detached group keeps running.
  assert.equal(activeCliProcesses.delete(9100), true);
  assert.equal(cancelCliAgentRun(9100), true, 'lease-backed cancel must succeed without the ChildProcess handle');
  await assert.rejects(run, /exited with code|stopped|SIG/);
  await waitFor(() => {
    try { process.kill(descendantPid, 0); return false; } catch { return true; }
  });
  assert.equal(fs.existsSync(path.join(agentProcessLeaseDir, '9100.json')), false);
});

test('reaper still kills token-bearing descendants after the group leader dies', { skip: process.platform !== 'linux' }, async () => {
  fs.rmSync(agentProcessLeaseDir, { recursive: true, force: true });
  const { lease, descendantPid } = await crashHostLeavingAkronOrphan(9101);

  try { process.kill(lease.processGroupId, 'SIGKILL'); } catch { /* already gone */ }
  await waitFor(() => {
    try { process.kill(lease.processGroupId, 0); return false; } catch { return true; }
  });
  assert.doesNotThrow(() => process.kill(descendantPid, 0), 'bridge/Hermes descendant should still be orphaned');

  assert.deepEqual(await reapOrphanedCliAgentProcesses(), [9101]);
  await waitFor(() => {
    try { process.kill(descendantPid, 0); return false; } catch { return true; }
  });
  assert.equal(fs.existsSync(path.join(agentProcessLeaseDir, '9101.json')), false);
});

test('Akron resolves BIN after import and emits launch metadata and native reasoning', async () => {
  const prior = process.env.AKRON_BIN;
  delete process.env.AKRON_BIN;
  const { getCliAgentBin, runCliAgent } = await import(`./cli-agent.js?bin-regression=${Date.now()}`);
  assert.equal(getCliAgentBin('akron-grok'), 'akron');
  process.env.AKRON_BIN = fakeAkronBin;
  process.env.FAKE_AKRON_EVENTS = '1';
  const events: Array<{ type: string; payload: any }> = [];
  try {
    const result = await runCliAgent({
      agent: 'akron-grok', context: '', userPrompt: 'exercise the bridge', cwd: scratch, runId: 8081,
      emit: (type: string, payload: unknown) => events.push({ type, payload }),
    });
    assert.equal(result.summary, 'native answer');
  } finally {
    delete process.env.FAKE_AKRON_EVENTS;
    if (prior === undefined) delete process.env.AKRON_BIN;
    else process.env.AKRON_BIN = prior;
  }

  const harness = events
    .filter((event) => event.type === 'harness')
    .map((event) => String(event.payload?.data || ''))
    .join('');
  assert.match(harness, /launching Akron --grok harness/);
  assert.match(harness, /\$ .*fake-akron --grok/);
  assert.match(harness, /# cwd /);
  assert.ok(events.some((event) => event.type === 'text'
    && event.payload?.message?.content?.[0]?.type === 'thinking'
    && event.payload.message.content[0].thinking === 'mapping the harness'));
});

test('resume passes the session id positionally, right before the prompt', async () => {
  resetArgs();
  process.env.FAKE_CODEX_RESUME_OK = '1';
  const result = await runCliAgent({
    agent: 'codex', context: '', userPrompt: 'hello there', cwd: scratch, emit,
    resumeSessionId: 'sess-abc123',
  });
  delete process.env.FAKE_CODEX_RESUME_OK;

  const [args] = readArgs();
  assert.deepEqual(args.slice(0, 2), ['exec', 'resume']);
  assert.equal(args[args.indexOf('sess-abc123') + 1], 'hello there', 'prompt must follow the session id');
  assert.equal(result.summary, 'answered');
});

test('Codex priority processing reaches fresh and resumed runs', async () => {
  resetArgs();
  await runCliAgent({
    agent: 'codex', context: '', userPrompt: 'fast fresh', cwd: scratch, emit,
    priorityServiceTier: true,
  });

  process.env.FAKE_CODEX_RESUME_OK = '1';
  try {
    await runCliAgent({
      agent: 'codex', context: '', userPrompt: 'fast resume', cwd: scratch, emit,
      resumeSessionId: 'sess-fast', priorityServiceTier: true,
    });
  } finally {
    delete process.env.FAKE_CODEX_RESUME_OK;
  }

  const attempts = readArgs();
  assert.equal(attempts.length, 2);
  for (const args of attempts) {
    const tierIndex = args.indexOf('service_tier="priority"');
    assert.ok(tierIndex > 0, 'priority service tier must reach Codex');
    assert.equal(args[tierIndex - 1], '-c');
  }
});

test('a session Codex no longer has falls back to a fresh one instead of a silent empty turn', async () => {
  resetArgs();
  const result = await runCliAgent({
    agent: 'codex', context: '', userPrompt: 'still there?', cwd: scratch, emit,
    resumeSessionId: 'sess-long-gone',
  });

  const attempts = readArgs();
  assert.equal(attempts.length, 2, 'should retry once');
  assert.ok(attempts[0].includes('resume'));
  assert.ok(!attempts[1].includes('resume'), 'retry must not resume anything');
  assert.equal(attempts[1][attempts[1].length - 1], 'still there?');
  assert.equal(result.summary, 'answered');
  // The new session must be handed back, or the next turn resumes the dead id.
  assert.equal(result.sessionId, 'fresh-session-1');
});

test('the zero-exit variant of a dead session also falls back', async () => {
  resetArgs();
  process.env.FAKE_CODEX_QUIET_FAIL = '1';
  const result = await runCliAgent({
    agent: 'codex', context: '', userPrompt: 'quiet failure', cwd: scratch, emit,
    resumeSessionId: 'sess-long-gone',
  });
  delete process.env.FAKE_CODEX_QUIET_FAIL;

  const attempts = readArgs();
  assert.equal(attempts.length, 2);
  assert.ok(!attempts[1].includes('resume'));
  assert.equal(result.summary, 'answered');
  assert.equal(result.sessionId, 'fresh-session-1');
});

test('an unrelated Codex failure still fails, rather than silently rerunning', async () => {
  resetArgs();
  const timings: any[] = [];
  process.env.FAKE_CODEX_BROKEN = '1';
  await assert.rejects(
    runCliAgent({ agent: 'codex', context: '', userPrompt: 'x', cwd: scratch, emit(type, payload) { if (type === 'timing') timings.push(payload); }, resumeSessionId: 'sess-abc' }),
    /disk on fire/,
  );
  delete process.env.FAKE_CODEX_BROKEN;
  assert.deepEqual(timings.map(event => event.phase), ['request_start', 'completion']);
  assert.equal(timings[1].outcome, 'failed');
  assert.equal(readArgs().length, 1, 'must not retry a failure that is not a dead session');
});

test('a fresh run is never retried and never mentions resume', async () => {
  resetArgs();
  const events: Array<{ type: string; payload: any }> = [];
  const result = await runCliAgent({
    agent: 'codex', context: '', userPrompt: 'new', cwd: scratch,
    emit: (type, payload) => events.push({ type, payload }),
  });
  const attempts = readArgs();
  assert.equal(attempts.length, 1);
  assert.ok(!attempts[0].includes('resume'));
  assert.equal(result.sessionId, 'fresh-session-1');
  const answer = events.find((event) => event.type === 'text' && event.payload?.chatVisible === true);
  assert.equal(answer?.payload.message.content[0].text, 'answered');
});

function readHermesArgs(): string[][] {
  return fs.readFileSync(hermesArgLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('a fresh Hermes turn reports a session id, so the next turn is not amnesiac', async () => {
  fs.writeFileSync(hermesArgLog, '');
  const result = await runCliAgent({
    agent: 'hermes', context: '', userPrompt: 'first turn', cwd: scratch, emit,
  });

  const [args] = readHermesArgs();
  // Oneshot (`-z`) is quiet but never reports a session id, so a fresh run had
  // nothing to hand back and every following turn started cold.
  assert.ok(!args.includes('-z'), 'fresh runs must not use the session-less oneshot path');
  assert.deepEqual(args.slice(0, 2), ['chat', '-Q']);
  assert.equal(args[args.indexOf('-q') + 1], 'first turn');
  assert.ok(!args.includes('--safe-mode'));
  assert.ok(!args.includes('--yolo'));
  assert.equal(result.sessionId, '20260806_140649_084b24', 'fresh run must hand back a resumable session');
});

test('Hermes profile, safe mode, and approval bypass are independent', async () => {
  fs.writeFileSync(hermesArgLog, '');
  await runCliAgent({
    agent: 'hermes', context: '', userPrompt: 'configured turn', cwd: scratch, emit,
    hermesProfile: 'greenhouse-codex', hermesSafeMode: true, yolo: false,
  });
  const [safeArgs] = readHermesArgs();
  assert.equal(safeArgs[safeArgs.indexOf('-p') + 1], 'greenhouse-codex');
  assert.equal(safeArgs[safeArgs.indexOf('-p') + 2], 'chat');
  assert.ok(safeArgs.includes('--safe-mode'));
  assert.ok(!safeArgs.includes('--yolo'));

  fs.writeFileSync(hermesArgLog, '');
  await runCliAgent({
    agent: 'hermes', context: '', userPrompt: 'approved turn', cwd: scratch, emit,
    hermesSafeMode: false, yolo: true,
  });
  const [yoloArgs] = readHermesArgs();
  assert.ok(!yoloArgs.includes('--safe-mode'));
  assert.ok(yoloArgs.includes('--yolo'));
});

test('Hermes rejects profile values that could become CLI options', async () => {
  await assert.rejects(
    runCliAgent({ agent: 'hermes', context: '', userPrompt: 'turn', cwd: scratch, emit, hermesProfile: '--safe-mode' }),
    /Hermes profile must use/,
  );
});

test('Hermes reasoning is kept out of the answer instead of rendered as the reply', async () => {
  fs.writeFileSync(hermesArgLog, '');
  const events: Array<{ type: string; payload: any }> = [];
  const result = await runCliAgent({
    agent: 'hermes', context: '', userPrompt: 'second turn', cwd: scratch,
    emit: (type, payload) => events.push({ type, payload }),
    resumeSessionId: 'sess-hermes-1',
  });

  const [args] = readHermesArgs();
  assert.equal(args[args.indexOf('--resume') + 1], 'sess-hermes-1');
  assert.equal(result.summary, 'resumed answer', 'the box-drawn panel must not reach the summary');
  assert.ok(!/Reasoning|weighing the options/.test(result.summary));

  const blocks = events.filter((event) => event.type === 'text').flatMap((event) => event.payload.message.content);
  assert.ok(
    blocks.some((block: any) => block.type === 'thinking' && /weighing the options/.test(block.thinking)),
    'reasoning body should stream as a thinking block',
  );
  assert.ok(
    !blocks.some((block: any) => block.type === 'text' && /Reasoning|weighing the options/.test(block.text)),
    'reasoning must never be emitted as answer text',
  );
});

test('an explicit model selection reaches Hermes', async () => {
  fs.writeFileSync(hermesArgLog, '');
  await runCliAgent({
    agent: 'hermes', context: '', userPrompt: 'which model?', cwd: scratch, emit,
    model: 'deepseek/deepseek-v4-pro',
  });
  const [args] = readHermesArgs();
  assert.equal(args[args.indexOf('-m') + 1], 'deepseek/deepseek-v4-pro');

  fs.writeFileSync(hermesArgLog, '');
  await runCliAgent({ agent: 'hermes', context: '', userPrompt: 'no model', cwd: scratch, emit });
  assert.ok(!readHermesArgs()[0].includes('-m'), 'no model picked must not send an empty -m');
});

for (const attempts of [2, 3]) {
  test(`Hermes recovers after ${attempts - 1} capacity failures ${attempts === 2 ? 'without' : 'with'} a session id`, async () => {
    fs.writeFileSync(hermesArgLog, '');
    fs.rmSync(hermes503Log, { force: true });
    process.env.FAKE_HERMES_503 = String(attempts);
    try {
      const result = await runCliAgent({
        agent: 'hermes', context: '', userPrompt: 'are you there?', cwd: scratch, emit,
      });
      assert.equal(readHermesArgs().length, attempts);
      assert.equal(result.summary, 'recovered after capacity error');
    } finally {
      delete process.env.FAKE_HERMES_503;
    }
  });
}

test('an answer that merely discusses HTTP 503 is not mistaken for a capacity failure', async () => {
  fs.writeFileSync(hermesArgLog, '');
  process.env.FAKE_HERMES_TALKS_ABOUT_503 = '1';
  try {
    const result = await runCliAgent({
      agent: 'hermes', context: '', userPrompt: 'how should I handle 503s?', cwd: scratch, emit,
    });
    // Matching "HTTP 503" anywhere would discard this real answer and then spin
    // for the entire retry budget before giving up.
    assert.equal(readHermesArgs().length, 1, 'a real answer must not be retried');
    assert.match(result.summary, /retry when the API returns HTTP 503/);
  } finally {
    delete process.env.FAKE_HERMES_TALKS_ABOUT_503;
  }
});

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
