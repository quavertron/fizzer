const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const runnerLeaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-runner-leases-'));
const runnerStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-runner-state-'));
const runnerBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-runner-bin-'));
process.env.CASCADE_AGENT_PROCESS_DIR = runnerLeaseDir;
process.env.CASCADE_AGENT_STATE_DIR = runnerStateDir;
process.env.CASCADE_AGENT_BIN_DIR = runnerBinDir;
const {
  buildRunHelperEnv,
  chatTriggeringMessageId,
  cleanupRunHelperConfig,
  helperAllowedTools,
  isMissingClaudeSession,
  formatToolHarnessPreview,
  renderInlineSvgAttachments,
  normalizeClaudeEffort,
  startLocalAgentRun,
  cancelLocalAgentRun,
} = require('./agent-runner.cjs');

test('inline SVG prompt markup becomes a PNG attachment plus a temporary source note', (t) => {
  const source = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8"><rect width="12" height="8" fill="red"/></svg>';
  const prepared = renderInlineSvgAttachments('before [[FIZZER_INLINE_SVG:1]] after', [source]);
  t.after(prepared.cleanup);

  assert.equal(prepared.images.length, 1);
  assert.equal(prepared.images[0].media_type, 'image/png');
  assert.deepEqual(Buffer.from(prepared.images[0].data, 'base64').subarray(1, 4), Buffer.from('PNG'));
  assert.doesNotMatch(prepared.prompt, /<svg\b/i);
  const note = prepared.prompt.match(/\[FIZZER HARNESS NOTE TO AGENT:[\s\S]*?SEE <([^>]+)>\]/);
  assert.ok(note);
  assert.equal(fs.readFileSync(note[1], 'utf8'), source);

  prepared.cleanup();
  assert.equal(fs.existsSync(note[1]), false);
});

test('invalid inline SVG remains in the prompt instead of being discarded', () => {
  const source = '<svg><not-valid></svg>';
  const prepared = renderInlineSvgAttachments('[[FIZZER_INLINE_SVG:1]]', [source]);
  assert.equal(prepared.prompt, source);
  assert.deepEqual(prepared.images, []);
});

test('recognizes a Claude session that belongs to another machine', () => {
  assert.equal(isMissingClaudeSession(new Error('No conversation found with session ID: abc')), true);
  assert.equal(isMissingClaudeSession(new Error('Claude rate limited')), false);
});

test('chat triggering message id follows the mission root through runner payload shapes', () => {
  assert.equal(chatTriggeringMessageId({ chatTriggeringMessageId: 'root-top' }), 'root-top');
  assert.equal(chatTriggeringMessageId({ chat: { triggeringMessageId: 'root-nested' } }), 'root-nested');
  assert.equal(chatTriggeringMessageId({ chatMessageId: 'worker-placeholder' }), '');
});

test('durable work item identity reaches both the provider env and helper context', () => {
  const runId = 91991;
  const env = buildRunHelperEnv({
    runId,
    vaultId: 'vault-1',
    chatChannelId: 'channel-1',
    workItemId: 'work-item-1',
  });
  try {
    assert.equal(env.CASCADE_WORK_ITEM_ID, 'work-item-1');
    const helper = JSON.parse(fs.readFileSync(env.CASCADE_HELPER_CONFIG, 'utf8'));
    assert.equal(helper.workItemId, 'work-item-1');
    assert.equal(env.CASCADE_NOTE_VAULT, 'vault-1');
    assert.equal(helper.vaultId, 'vault-1');
    assert.ok(env.PATH.split(path.delimiter).includes(runnerBinDir));
  } finally {
    cleanupRunHelperConfig(runId);
  }
});

test('Cascade helpers are pre-authorized by command name and discovered paths', () => {
  const rules = helperAllowedTools();
  assert.ok(rules.includes('Bash(cascade-note *)'));
  assert.ok(rules.includes(`Bash(${path.join(__dirname, '..', 'cli-agents', 'cascade-note')} *)`));
  assert.ok(rules.includes(`Bash(${path.join(runnerBinDir, 'cascade-note')} *)`));
});

test('Claude effort overrides support every Claude CLI level and reject ultra', () => {
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    assert.equal(normalizeClaudeEffort(effort), effort);
  }
  assert.equal(normalizeClaudeEffort('ultra', 'medium'), 'medium');
});

test('Claude runs through a separately installed CLI and streams its result', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-fake-claude-'));
  const bin = path.join(dir, 'claude');
  const argsFile = path.join(dir, 'args.json');
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(process.env.FAKE_CLAUDE_ARGS, JSON.stringify(process.argv.slice(2)));
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
send({ type: 'system', subtype: 'init', session_id: 'claude-session-1' });
send({ type: 'stream_event', event: { type: 'message_start' } });
send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'CLI thought' } } });
send({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tool-1', name: 'Bash' } } });
send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"command":"pwd"}' } } });
send({ type: 'stream_event', event: { type: 'content_block_stop' } });
send({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } });
send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'CLI answer' } } });
send({ type: 'stream_event', event: { type: 'content_block_stop' } });
send({ type: 'result', subtype: 'success', result: 'CLI answer', session_id: 'claude-session-1' });
`, { mode: 0o755 });
  const priorBin = process.env.CLAUDE_BIN;
  const priorArgs = process.env.FAKE_CLAUDE_ARGS;
  process.env.CLAUDE_BIN = bin;
  process.env.FAKE_CLAUDE_ARGS = argsFile;
  t.after(() => {
    if (priorBin === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = priorBin;
    if (priorArgs === undefined) delete process.env.FAKE_CLAUDE_ARGS; else process.env.FAKE_CLAUDE_ARGS = priorArgs;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const events = [];
  const intervals = t.mock.method(global, 'setInterval');
  const result = await startLocalAgentRun({
    runId: 91992,
    agent: 'claude-code',
    prompt: 'Say hello',
    cwd: dir,
    model: 'claude-test',
    chatChannelId: 'channel-1',
  }, (event) => events.push(event));

  const timings = events.filter(event => event.type === 'timing').map(event => JSON.parse(event.payload_json));
  assert.deepEqual(timings.map(event => event.phase), ['request_start', 'first_response', 'completion']);
  assert.equal(new Set(timings.map(event => event.requestId)).size, 1);
  assert.equal(timings[2].outcome, 'completed');
  assert.ok(timings.every(event => event.boundary === 'claude_cli_stdout'));
  assert.equal(result.sessionId, 'claude-session-1');
  const args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
  assert.ok(args.includes('--output-format'));
  assert.ok(args.includes('stream-json'));
  assert.equal(args.at(-1), 'Say hello');
  assert.equal(args[args.indexOf('--effort') + 1], process.env.RUNNER_CHAT_EFFORT || process.env.RUNNER_EFFORT || 'medium');
  assert.doesNotMatch(args.join(' '), /thinking.?tokens|budget.?tokens/i);
  const systemPrompt = args[args.indexOf('--append-system-prompt') + 1];
  assert.match(systemPrompt, /Your channel transcript is append-only\./);
  assert.match(systemPrompt, /cascade-chat history --around-message-id <id> --include-reply-context/);
  const payloads = events.filter((event) => event.type === 'text').map((event) => JSON.parse(event.payload_json));
  assert.ok(payloads.some((payload) => payload.chatVisible && payload.message.content[0].text === 'CLI answer'));
  assert.ok(payloads.some((payload) => payload.message.content[0].thinking === 'CLI thought'));
  const harness = events.filter((event) => event.type === 'harness').map((event) => JSON.parse(event.payload_json).data).join('');
  assert.match(harness, /CLI thought/);
  assert.match(harness, /pwd/);
  assert.doesNotMatch(harness, /\{"command":/);
  const heartbeat = intervals.mock.calls.find(({ arguments: args }) => args[1] === 15_000);
  assert.ok(heartbeat);
  assert.equal(heartbeat.result._destroyed, true);
  heartbeat.arguments[0]();
  assert.equal(events.at(-1).type, 'heartbeat');
});

test('Claude tool previews are readable one-line progress instead of JSON/control payloads', () => {
  assert.equal(formatToolHarnessPreview({ command: "python3 - <<'PY'\nprint('ok')\nPY" }), "python3 - <<'PY' print('ok') PY");
  assert.equal(formatToolHarnessPreview({ file_path: '/tmp/example.ts', old_string: 'x' }), '/tmp/example.ts');
});

test('Akron reaches the Electron event bridge with launch, reasoning, and terminal events', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-akron-bridge-'));
  const bin = path.join(dir, 'fake-akron');
  fs.writeFileSync(bin, `#!/usr/bin/env node
if (process.env.HERMES_CASCADE_EVENTS !== '1') process.exit(13);
if (process.env.FAKE_AKRON_CRASH_LOOP === '1') setInterval(() => {}, 1000);
process.stderr.write(JSON.stringify({ type: 'reasoning.delta', text: 'bridged thought' }) + '\\n');
process.stdout.write('bridged answer\\n');
`);
  fs.chmodSync(bin, 0o755);
  const previous = process.env.AKRON_BIN;
  process.env.AKRON_BIN = bin;
  t.after(() => {
    if (previous === undefined) delete process.env.AKRON_BIN;
    else process.env.AKRON_BIN = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const events = [];
  await startLocalAgentRun({
    runId: 92001,
    agent: 'akron-grok',
    prompt: 'exercise bridge',
    cwd: dir,
    vaultRoot: dir,
  }, (event) => events.push(event));

  assert.equal(JSON.parse(events[0].payload_json).status, 'running');
  const harness = events
    .filter((event) => event.type === 'harness')
    .map((event) => JSON.parse(event.payload_json).data)
    .join('');
  assert.match(harness, /launching Akron --grok harness/);
  assert.match(harness, /\$ .*fake-akron --grok/);
  assert.match(harness, /# cwd /);
  assert.ok(events.some((event) => event.type === 'text'
    && JSON.parse(event.payload_json).message?.content?.[0]?.thinking === 'bridged thought'));
  const terminal = events.at(-1);
  assert.equal(terminal.type, 'status');
  assert.equal(JSON.parse(terminal.payload_json).status, 'completed');

  // Reproduce a hard Electron-main crash: the detached Akron process group is
  // adopted by PID 1, while its durable lease survives on disk.
  const crashedRunId = 92002;
  const crashHost = `
    import fs from 'node:fs';
    import { runCliAgent } from ${JSON.stringify(pathToFileURL(path.join(__dirname, '..', 'dist', 'cli-agents', 'cli-agent.js')).href)};
    void runCliAgent({ agent: 'akron-grok', context: '', userPrompt: 'long orchestrator work', cwd: ${JSON.stringify(dir)}, runId: ${crashedRunId}, emit() {} });
    const lease = ${JSON.stringify(path.join(runnerLeaseDir, `${crashedRunId}.json`))};
    const timer = setInterval(() => {
      if (fs.existsSync(lease)) { clearInterval(timer); process.exit(77); }
    }, 10);
  `;
  const crashedOwner = spawn(process.execPath, ['--input-type=module', '-e', crashHost], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      AKRON_BIN: bin,
      FAKE_AKRON_CRASH_LOOP: '1',
      CASCADE_AGENT_PROCESS_DIR: runnerLeaseDir,
    },
    stdio: 'ignore',
  });
  const crashCode = await new Promise((resolve) => crashedOwner.once('exit', resolve));
  assert.equal(crashCode, 77);
  const orphanLease = JSON.parse(fs.readFileSync(path.join(runnerLeaseDir, `${crashedRunId}.json`), 'utf8'));
  assert.doesNotThrow(() => process.kill(orphanLease.processGroupId, 0));

  // Starting the next real coordinator turn goes through loadCliAgentModule,
  // which must reap the orphan before launching the replacement Akron run.
  const recoveredEvents = [];
  await startLocalAgentRun({
    runId: 92003,
    agent: 'akron-grok',
    prompt: 'coordinator after crash',
    cwd: dir,
    vaultRoot: dir,
  }, (event) => recoveredEvents.push(event));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.throws(() => process.kill(orphanLease.processGroupId, 0));
  assert.equal(JSON.parse(recoveredEvents.at(-1).payload_json).status, 'completed');
});

test('runner recovers from failed initial and replacement builds without restarting', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fizzer-runner-rebuild-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'cascade-electron'));
  fs.mkdirSync(path.join(dir, 'dist', 'cli-agents'), { recursive: true });
  fs.symlinkSync(path.join(__dirname, 'node_modules'), path.join(dir, 'node_modules'));
  const runnerPath = path.join(dir, 'cascade-electron', 'agent-runner.cjs');
  fs.copyFileSync(path.join(__dirname, 'agent-runner.cjs'), runnerPath);
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  const modPath = path.join(dir, 'dist', 'cli-agents', 'cli-agent.js');
  let revision = 0;
  const rebuild = (source) => {
    fs.writeFileSync(modPath, source);
    const time = new Date(1_700_000_000_000 + ++revision * 1000);
    fs.utimesSync(modPath, time, time);
  };
  const runner = require(runnerPath);
  rebuild('throw new Error("incomplete initial build");');
  await assert.rejects(runner.reapOrphanedLocalAgentRuns(), /incomplete initial build/);
  rebuild('export function shutdownPersistentCliAgents() {}');
  await runner.reapOrphanedLocalAgentRuns();
  rebuild('throw new Error("incomplete replacement build");');
  await assert.rejects(runner.reapOrphanedLocalAgentRuns(), /incomplete replacement build/);
  rebuild('export async function runCliAgent() { return { summary: "recovered", sessionId: "recovered-session" }; }');
  const events = [];
  const result = await runner.startLocalAgentRun({
    runId: 92005, agent: 'codex', prompt: 'resume work', cwd: dir,
    contextMode: 'self-contained',
  }, (event) => events.push(event));
  assert.equal(result.sessionId, 'recovered-session');
  assert.equal(JSON.parse(events.at(-1).payload_json).status, 'completed');
});

test('non-Claude setup failure cleans helper context, SVG attachments, and heartbeat', async (t) => {
  const runId = 92004;
  const directories = [];
  const intervals = t.mock.method(global, 'setInterval');
  const mkdtempSync = fs.mkdtempSync;
  t.mock.method(fs, 'mkdtempSync', (...args) => {
    const dir = mkdtempSync(...args);
    if (String(args[0]).includes('fizzer-inline-svg-')) directories.push(dir);
    return dir;
  });
  t.after(() => {
    intervals.mock.calls.forEach(({ result }) => clearInterval(result));
    directories.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
    cleanupRunHelperConfig(runId);
  });
  const events = [];
  await assert.rejects(startLocalAgentRun({
    runId,
    agent: 'codex',
    prompt: '[[FIZZER_INLINE_SVG:1]]',
    inlineSvgs: ['<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'],
    get cwd() { throw new Error('setup failed'); },
  }, (event) => events.push(event)), /setup failed/);
  assert.equal(directories.length, 1);
  assert.equal(fs.existsSync(directories[0]), false);
  assert.equal(fs.existsSync(path.join(runnerStateDir, 'run-contexts', `${runId}.json`)), false);
  assert.equal(intervals.mock.callCount(), 1);
  assert.equal(intervals.mock.calls[0].result._destroyed, true);
  assert.equal(JSON.parse(events.at(-1).payload_json).status, 'failed');
});


for (const stop of [false, true]) test(`retrying a persistent Codex turn ends ${stop ? 'canceled on Stop' : 'completed'}`, {timeout: 5000}, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fizzer-codex-cancel-'));
  const bin = path.join(dir, 'codex');
  fs.writeFileSync(bin, `#!/usr/bin/env node
const readline = require('readline');
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({input: process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({id: m.id, result: {}});
  if (m.method === 'thread/start') send({id: m.id, result: {thread: {id: 'cancel-thread'}}});
  if (m.method === 'turn/start') {
    send({id: m.id, result: {turn: {id: 'cancel-turn'}}});
    send({method: 'error', params: {threadId: 'cancel-thread', turnId: 'cancel-turn', willRetry: true, error: {message: 'Reconnecting... 1/5'}}});
    if (!${stop}) setTimeout(() => send({method: 'turn/completed', params: {turn: {id: 'cancel-turn', status: 'completed'}}}), 100);
  }
  if (m.method === 'turn/interrupt') {
    send({method: 'turn/completed', params: {turn: {id: 'cancel-turn', status: 'interrupted'}}});
    send({id: m.id, result: {}});
  }
  if (m.method === 'thread/unsubscribe') send({id: m.id, result: {}});
});
`);
  fs.chmodSync(bin, 0o755);
  const modulePath = path.join(__dirname, '..', 'dist', 'cli-agents', 'cli-agent.js');
  t.after(async () => {
    const mod = await import(pathToFileURL(modulePath).href + `?t=${fs.statSync(modulePath).mtimeMs}`);
    mod.shutdownPersistentCliAgents();
  });
  const previous = process.env.CODEX_BIN;
  process.env.CODEX_BIN = bin;
  process.env.RUNNER_CODEX_PERSISTENT = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous;
    fs.rmSync(dir, {recursive: true, force: true});
  });
  const events = [];
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const run = startLocalAgentRun({runId: 92005, agent: 'codex', prompt: 'wait', cwd: dir}, event => {
    events.push(event);
    if (event.type === 'harness' && JSON.parse(event.payload_json).data.includes('Reconnecting')) ready();
  });
  await started;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events.filter(e => e.type === 'status').map(e => JSON.parse(e.payload_json).status), ['running']);
  if (stop) assert.equal(await cancelLocalAgentRun(92005), true);
  await run;
  const statuses = events.filter(event => event.type === 'status').map(event => JSON.parse(event.payload_json).status);
  assert.deepEqual(statuses, ['running', stop ? 'canceled' : 'completed']);
});
