import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, 'cascade-chat');

test('coordinator helper starts and delegates a mission with structured API calls', async (t) => {
  const requests: Array<{ method: string; path: string; runId: string; body: Record<string, unknown> | null }> = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({
      method: req.method || '',
      path: req.url || '',
      runId: String(req.headers['x-cascade-run-id'] || ''),
      body: raw ? JSON.parse(raw) : null,
    });
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url === '/api/vaults/vault-1/channels/channel-1/messages') {
      const body = raw ? JSON.parse(raw) : {};
      res.statusCode = 201;
      res.end(JSON.stringify({ message: { id: 'sys-mission-root-new', body: body.body || '' } }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/vaults/vault-1/channels/channel-1/missions?coordinator=reg-sol') {
      res.end(JSON.stringify({ missions: [{ id: 'mission-1', title: 'Release', status: 'attention', tasks: [{ id: 'task-1', attempt: 2, runId: 42 }] }] }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/vaults/vault-1/channels/channel-1/missions/mission-1/history') {
      res.end(JSON.stringify({ events: [{ id: 1, kind: 'task_retried', title: 'Verify browser', fromStatus: 'failed', toStatus: 'pending', summary: '', attempt: 1, createdAt: '2026-08-08T12:00:00.000Z' }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/vaults/vault-1/channels/channel-1/missions') {
      res.statusCode = 201;
      res.end(JSON.stringify({ mission: { id: 'mission-1', title: 'Release', status: 'active', tasks: [] } }));
      return;
    }
    if (req.url === '/api/vaults/vault-1/channels/channel-1/missions/mission-1/tasks') {
      res.statusCode = 201;
      res.end(JSON.stringify({
        mission: { id: 'mission-1', title: 'Release', status: 'active' },
        task: { id: 'task-1', title: 'Verify browser', assigneeMention: 'sol·sub' },
        scheduled: true,
      }));
      return;
    }
    if (req.url === '/api/vaults/vault-1/channels/channel-1/missions/mission-1?coordinator=reg-sol') {
      res.end(JSON.stringify({
        mission: { id: 'mission-1', title: 'Release', status: 'reviewing', tasks: [] },
      }));
      return;
    }
    if (req.url === '/api/vaults/vault-1/channels/channel-1/missions/tasks/task-1/steer') {
      res.end(JSON.stringify({ steering: { id: 7, status: 'queued', detail: 'Waiting for provider stop acknowledgment' } }));
      return;
    }
    if (req.url === '/api/vaults/vault-1/channels/channel-1/missions/tasks/task-1') {
      res.end(JSON.stringify({ mission: { id: 'mission-1', title: 'Release', status: 'blocked', tasks: [] } }));
      return;
    }
    if (req.url === '/api/vaults/vault-1/channels/channel-1/missions/tasks/task-1/recovery-evidence') {
      res.end(JSON.stringify({ mission: { id: 'mission-1' } }));
      return;
    }
    if (req.url === '/api/vaults/vault-1/channels/channel-1/missions/mission-1/finish') {
      res.end(JSON.stringify({ mission: { id: 'mission-1', title: 'Release', status: 'completed', tasks: [] } }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');
  const common = [
    '--url', `http://127.0.0.1:${address.port}`,
    '--token', 'token',
    '--vault', 'vault-1',
    '--channel', 'channel-1',
  ];
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-chat-test-'));
  const config = path.join(fixtureDir, 'helper.json');
  fs.writeFileSync(config, JSON.stringify({
    registrationId: 'reg-sol',
    chatTriggeringMessageId: 'root-message',
    displayName: 'Sol',
  }));
  t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));
  const withCoordinator = { ...process.env, CASCADE_HELPER_CONFIG: config, CASCADE_RUN_ID: '777' };

  const steered = await execFileAsync(process.execPath, [
    cli, 'mission', 'steer', '--task', 'task-1', '--message', 'Keep edits; narrow the test.', ...common,
  ], { env: withCoordinator });
  assert.match(steered.stdout, /queued steering 7: Waiting for provider stop acknowledgment/);
  assert.deepEqual(requests.find((request) => request.path.endsWith('/steer'))?.body, {
    coordinatorRegistrationId: 'reg-sol', message: 'Keep edits; narrow the test.', attempt: 2, runId: 42,
  });

  requests.length = 0;
  const started = await execFileAsync(process.execPath, [
    cli, 'mission', 'start', '--title', 'Release', '--objective', 'Ship safely',
    ...common,
  ], { env: withCoordinator });
  assert.match(started.stdout, /mission mission-1 started/);
  const delegated = await execFileAsync(process.execPath, [
    cli, 'mission', 'delegate', '--mission', 'mission-1', '--to', '@sol', '--anonymous',
    '--task', 'Verify browser', '--message', 'Exercise reload and reconnect.',
    '--after', 'task-a,task-b', '--priority', '7', '--effort', 'high', ...common,
  ], { env: withCoordinator });
  assert.match(delegated.stdout, /dispatched task-1 to @sol·sub/);
  const status = await execFileAsync(process.execPath, [
    cli, 'mission', 'status', '--mission', 'mission-1', ...common,
  ], { env: withCoordinator });
  assert.match(status.stdout, /reviewing\s+mission-1/);
  const listed = await execFileAsync(process.execPath, [
    cli, 'mission', 'list', ...common,
  ], { env: withCoordinator });
  assert.match(listed.stdout, /attention\s+mission-1/);
  const history = await execFileAsync(process.execPath, [
    cli, 'mission', 'history', '--mission', 'mission-1', ...common,
  ], { env: withCoordinator });
  assert.match(history.stdout, /failed → pending · attempt 2/);
  await execFileAsync(process.execPath, [
    cli, 'mission', 'update', '--task', 'task-1', '--status', 'blocked',
    '--summary', 'Needs a credential', ...common,
  ], { env: withCoordinator });
  await execFileAsync(process.execPath, [
    cli, 'mission', 'retry', '--task', 'task-1', '--summary', 'Try again', ...common,
  ], { env: withCoordinator });
  await execFileAsync(process.execPath, [
    cli, 'mission', 'finish', '--mission', 'mission-1', '--summary', 'Integrated', '--verification', 'Tests passed; artifact inspected', ...common,
  ], { env: withCoordinator });
  await execFileAsync(process.execPath, [
    cli, 'mission', 'link-recovery', '--task', 'task-1', '--source-task', 'recovered-task',
    '--source-run', '3131', '--target-run', '3099', '--target-attempt', '0',
    '--objective', 'Ship safely', '--verification', 'Exact revision verified', ...common,
  ], { env: withCoordinator });
  assert.deepEqual(requests.at(-1)?.body, {
    coordinatorRegistrationId: 'reg-sol', sourceTaskId: 'recovered-task', sourceRunId: 3131,
    targetRunId: 3099, targetAttempt: 0, objective: 'Ship safely', verification: 'Exact revision verified',
  });
  assert.deepEqual(requests.map((request) => `${request.method} ${request.path}`), [
    'POST /api/vaults/vault-1/channels/channel-1/messages',
    'POST /api/vaults/vault-1/channels/channel-1/missions',
    'POST /api/vaults/vault-1/channels/channel-1/missions/mission-1/tasks',
    'GET /api/vaults/vault-1/channels/channel-1/missions/mission-1?coordinator=reg-sol',
    'GET /api/vaults/vault-1/channels/channel-1/missions?coordinator=reg-sol',
    'GET /api/vaults/vault-1/channels/channel-1/missions/mission-1/history',
    'PATCH /api/vaults/vault-1/channels/channel-1/missions/tasks/task-1',
    'PATCH /api/vaults/vault-1/channels/channel-1/missions/tasks/task-1',
    'POST /api/vaults/vault-1/channels/channel-1/missions/mission-1/finish',
    'POST /api/vaults/vault-1/channels/channel-1/missions/tasks/task-1/recovery-evidence',
  ]);
  assert.ok(requests.every((request) => request.runId === '777'));
  assert.equal(requests[0]?.body?.registrationId, 'reg-sol');
  assert.equal(requests[0]?.body?.author, 'Sol');
  assert.notEqual(requests[0]?.body?.id, 'root-message');
  assert.deepEqual(requests[1]?.body, {
    rootMessageId: 'sys-mission-root-new',
    coordinatorRegistrationId: 'reg-sol',
    title: 'Release',
    objective: 'Ship safely',
    controlPlane: false,
    reviewRequested: false,
    authorityMessageIds: [],
  });
  assert.deepEqual(requests[2]?.body, {
    coordinatorRegistrationId: 'reg-sol',
    title: 'Verify browser',
    assignee: '@sol',
    prompt: 'Exercise reload and reconnect.',
    dependsOn: ['task-a', 'task-b'],
    priority: 7,
    reasoningEffort: 'high',
    anonymous: true,
    workspaceMode: 'shared',
  });
  assert.deepEqual(requests[6]?.body, { status: 'blocked', summary: 'Needs a credential' });
  assert.deepEqual(requests[7]?.body, { status: 'pending', summary: 'Try again' });
  assert.deepEqual(requests[8]?.body, {
    coordinatorRegistrationId: 'reg-sol',
    status: 'completed',
    summary: 'Integrated',
    verification: 'Tests passed; artifact inspected',
  });
  assert.equal(JSON.parse(fs.readFileSync(config, 'utf8')).usedChatSend, undefined);
});

test('control-plane mission start explicitly asks the server not to bind a primary task', async (t) => {
  const runHeaders: Array<string | undefined> = [];
  const bodies: Array<Record<string, unknown>> = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    runHeaders.push(req.headers['x-cascade-run-id'] as string | undefined);
    bodies.push(raw ? JSON.parse(raw) : {});
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/messages')) return res.end(JSON.stringify({ message:{ id:'control-root' } }));
    if (req.url?.endsWith('/missions')) return res.end(JSON.stringify({ mission:{ id:'control-mission', title:'Control' } }));
    res.statusCode = 404; res.end(JSON.stringify({ error:'not found' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address(); assert(address && typeof address === 'object');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-chat-control-plane-'));
  const config = path.join(dir, 'helper.json');
  fs.writeFileSync(config, JSON.stringify({ registrationId:'reg-sol', displayName:'Sol' }));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  await execFileAsync(process.execPath, [cli, 'mission', 'start', '--control-plane', '--title', 'Control', '--url', `http://127.0.0.1:${address.port}`, '--token', 'token', '--vault', 'vault-1', '--channel', 'channel-1'], {
    env:{ ...process.env, CASCADE_HELPER_CONFIG:config, CASCADE_RUN_ID:'4242' },
  });
  assert.equal(runHeaders[0], '4242');
  assert.equal(runHeaders[1], '4242');
  assert.equal(bodies[1]?.controlPlane, true);
});

test('mission start delegates in one command and preserves explicit review', async (t) => {
  const runHeaders: Array<string | undefined> = [];
  const bodies: Array<Record<string, unknown>> = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    runHeaders.push(req.headers['x-cascade-run-id'] as string | undefined);
    bodies.push(raw ? JSON.parse(raw) : {});
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/messages')) return res.end(JSON.stringify({ message:{ id:'control-root' } }));
    if (req.url?.endsWith('/missions')) return res.end(JSON.stringify({ mission:{ id:'control-mission', title:'Control' } }));
    if (req.url?.endsWith('/tasks')) return res.end(JSON.stringify({ mission:{ id:'control-mission' }, task:{ id:'task-1', title:'Control' }, scheduled:true }));
    res.statusCode = 404; res.end(JSON.stringify({ error:'not found' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address(); assert(address && typeof address === 'object');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-chat-control-plane-'));
  const config = path.join(dir, 'helper.json');
  fs.writeFileSync(config, JSON.stringify({ registrationId:'reg-sol', displayName:'Sol' }));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  await execFileAsync(process.execPath, [cli, 'mission', 'start', '--control-plane', '--title', 'Control', '--message', 'Do the requested work', '--review', '--url', `http://127.0.0.1:${address.port}`, '--token', 'token', '--vault', 'vault-1', '--channel', 'channel-1'], {
    env:{ ...process.env, CASCADE_HELPER_CONFIG:config, CASCADE_RUN_ID:'4242' },
  });
  assert.equal(runHeaders[0], '4242');
  assert.equal(runHeaders[1], '4242');
  assert.equal(bodies[1]?.controlPlane, true);
  assert.equal(bodies[1]?.reviewRequested, true);
  assert.equal(bodies[2]?.assignee, 'reg-sol');
  assert.equal(bodies[2]?.anonymous, true);
  assert.equal(bodies[2]?.prompt, 'Do the requested work');
  assert.equal(runHeaders[2], '4242');
});

test('send creates a typed single-agent handoff without suppressing the caller reply', async (t) => {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ path: req.url || '', body: raw ? JSON.parse(raw) : {} });
    res.setHeader('content-type', 'application/json');
    res.statusCode = 201;
    res.end(JSON.stringify({ message: { id: 'collab-1' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-chat-handoff-'));
  const config = path.join(dir, 'helper.json');
  fs.writeFileSync(config, JSON.stringify({ registrationId: 'reg-sol', agentId: 'codex' }));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const result = await execFileAsync(process.execPath, [
    cli, 'send', '--to', '@terra', '--reply-to', 'source/message', '--relation', 'review_request',
    '--message', 'Check this result.', '--url', `http://127.0.0.1:${address.port}`,
    '--token', 'token', '--vault', 'vault-1', '--channel', 'channel-1',
  ], { env: { ...process.env, CASCADE_HELPER_CONFIG: config, CASCADE_RUN_ID: '88' } });

  assert.match(result.stdout, /asked @terra via review_request \(collab-1\)/);
  assert.equal(requests[0]?.path, '/api/vaults/vault-1/channels/channel-1/messages/source%2Fmessage/collaborate');
  assert.deepEqual(requests[0]?.body, {
    target: '@terra',
    relationship: 'review_request',
    instruction: 'Check this result.',
    requestId: requests[0]?.body.requestId,
    registrationId: 'reg-sol',
  });
  assert.match(String(requests[0]?.body.requestId), /^collab-codex-/);
  assert.equal(JSON.parse(fs.readFileSync(config, 'utf8')).usedChatSend, undefined);
});

test('avatar --file uploads image data to the current registration only', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-avatar-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = path.join(dir, 'helper.json');
  fs.writeFileSync(config, JSON.stringify({ registrationId: 'reg-astra' }));
  const file = path.join(dir, 'avatar.png');
  const bytes = Buffer.from('89504e470d0a1a0a', 'hex');
  fs.writeFileSync(file, bytes);
  const requests: unknown[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push([req.method, req.url, req.headers['x-cascade-run-id'], JSON.parse(raw)]);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ registration: { avatarUrl: '/api/notes/agent-avatars/assets/astra' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');
  const result = await execFileAsync(process.execPath, [cli, 'avatar', '--file', file], {
    env: { ...process.env, CASCADE_HELPER_CONFIG: config, CASCADE_NOTE_URL: `http://127.0.0.1:${address.port}`, CASCADE_NOTE_TOKEN: 'token', CASCADE_NOTE_VAULT: 'vault', CASCADE_CHAT_CHANNEL: 'room', CASCADE_RUN_ID: '777' },
  });
  assert.match(result.stdout, /profile picture updated/);
  assert.deepEqual(requests, [['PUT', '/api/vaults/vault/channels/room/agents/reg-astra/avatar', '777', { avatarUrl: `data:image/png;base64,${bytes.toString('base64')}` }]]);
});

test('worker child and join use bounded endpoints with current run identity', async (t) => {
  const requests: Array<{ path: string; run: string; body: Record<string, unknown> }> = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ path: req.url || '', run: String(req.headers['x-cascade-run-id'] || ''), body: JSON.parse(raw) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url?.endsWith('/join') ? { children: [], instruction: 'End turn to join' } : { task: { id: 'child-1', title: 'Parser' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address() as { port: number };
  const common = ['--url', `http://127.0.0.1:${address.port}`, '--token', 'token', '--vault', 'vault-1', '--channel', 'channel-1'];
  const env = { ...process.env, CASCADE_RUN_ID: '51', CASCADE_HELPER_CONFIG: '/nonexistent' };
  await execFileAsync(process.execPath, [cli, 'mission', 'child', '--task', 'Parser', '--message', 'Implement parser only', ...common], { env });
  await execFileAsync(process.execPath, [cli, 'mission', 'join', ...common], { env });
  assert.deepEqual(requests, [
    { path: '/api/vaults/vault-1/channels/channel-1/missions/current/children', run: '51', body: { title: 'Parser', prompt: 'Implement parser only', reasoningEffort: '' } },
    { path: '/api/vaults/vault-1/channels/channel-1/missions/children/join', run: '51', body: {} },
  ]);
});

test('attachment opens note asset paths returned by message detail', async (t) => {
  const bytes = Buffer.from('fixture-image');
  const server = http.createServer((req, res) => {
    if (req.url === '/api/vaults/v/channels/c/messages/owner') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ message: { id: 'owner', images: ['/api/notes/n/assets/image'] } }));
    } else if (req.url === '/api/notes/n/assets/image') {
      assert.equal(req.headers.authorization, 'Bearer fixture-token');
      res.setHeader('content-type', 'image/png');
      res.end(bytes);
    } else { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const addr = server.address();
  assert(addr && typeof addr === 'object');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-asset-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = await execFileAsync(process.execPath, [cli, 'attachment', '--message-id', 'owner',
    '--url', `http://127.0.0.1:${addr.port}`, '--token', 'fixture-token', '--vault', 'v', '--channel', 'c', '--out', dir, '--json']);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(fs.readFileSync(output.files[0].path), bytes);
});


test('mission bookkeeping retries refused local connections only, with a fixed bound', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-connection-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hook = path.join(dir, 'fetch.cjs');
  const count = path.join(dir, 'attempts');
  fs.writeFileSync(hook, `
    const fs = require('node:fs');
    let calls = 0;
    global.fetch = async () => {
      fs.writeFileSync(process.env.TEST_COUNT, String(++calls));
      if (calls <= Number(process.env.TEST_REFUSALS)) {
        throw new TypeError('fetch failed', { cause: { code: process.env.TEST_CODE } });
      }
      return new Response(JSON.stringify({ mission: { id: 'm' }, error: 'Authority denied' }),
        { status: Number(process.env.TEST_STATUS) });
    };
  `);
  const invoke = (refusals: number, code = 'ECONNREFUSED', status = 200, host = '127.0.0.1') =>
    execFileAsync(process.execPath, ['--require', hook, cli, 'mission', 'update',
      '--task', 'task-1', '--status', 'completed', '--summary', 'Verified delivery',
      '--url', `http://${host}:34567`, '--token', 'test', '--vault', 'v', '--channel', 'c'],
      { env: { ...process.env, CASCADE_HELPER_CONFIG: path.join(dir, 'absent'),
        TEST_COUNT: count, TEST_REFUSALS: String(refusals), TEST_CODE: code, TEST_STATUS: String(status) } });
  const recovered = await invoke(2);
  assert.match(recovered.stdout, /task task-1 → completed/);
  assert.equal(fs.readFileSync(count, 'utf8'), '3');
  await assert.rejects(invoke(3));
  assert.equal(fs.readFileSync(count, 'utf8'), '3');
  for (const args of [[1, 'ECONNRESET', 200], [0, 'ECONNREFUSED', 403], [1, 'ECONNREFUSED', 200, 'example.com']] as const) {
    await assert.rejects(invoke(args[0], args[1], args[2], args[3]));
    assert.equal(fs.readFileSync(count, 'utf8'), '1');
  }
});

test('app context helper reads and conditionally saves without requiring a vault or channel', async (t) => {
  const requests: any[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ method: req.method, path: req.url, body: raw ? JSON.parse(raw) : null });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ content: 'Saved guidance', revision: 'r2' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address() as { port: number };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-context-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'context.txt');
  fs.writeFileSync(file, 'Saved guidance');
  const env = { ...process.env, CASCADE_NOTE_VAULT: '', CASCADE_CHAT_CHANNEL: '', CASCADE_HELPER_CONFIG: path.join(dir, 'missing') };
  const common = ['--url', `http://127.0.0.1:${address.port}`, '--token', 'test-token'];
  await execFileAsync(process.execPath, [cli, 'context', 'get', ...common], { env });
  await execFileAsync(process.execPath, [cli, 'context', 'set', '--file', file, '--revision', 'r1', ...common], { env });
  assert.deepEqual(requests, [
    { method: 'GET', path: '/api/app-context', body: null },
    { method: 'PUT', path: '/api/app-context', body: { content: 'Saved guidance', revision: 'r1' } },
  ]);
  await assert.rejects(execFileAsync(process.execPath, [cli, 'context', 'set', '--file', file, ...common], { env }), /requires --file and --revision/);
  assert.equal(requests.length, 2);
});

test('mission interpretation uses the scoped API and suppresses only acknowledged public or quiet replies', async (t) => {
  const requests: Array<{ method?: string; path?: string; body: Record<string, unknown>; run?: string }> = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ method: req.method, path: req.url, body: raw ? JSON.parse(raw) : {}, run: req.headers['x-cascade-run-id'] as string });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.method === 'GET' ? { revision: 0, fingerprint: 'evidence' } : { revision: 1, messageId: 'explanation-1' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address(); assert(address && typeof address === 'object');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-interpret-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'helper.json');
  fs.writeFileSync(configPath, JSON.stringify({ registrationId: 'coordinator', chatChannelId: 'channel' }));
  const input = { revision: 0, fingerprint: 'evidence', assessment: 'Delivered', body: 'Delivered.\nThe earlier answer still applies.' };
  const file = path.join(dir, 'interpretation.json');
  fs.writeFileSync(file, JSON.stringify(input));
  const args = [cli, 'mission', 'interpret', '--mission', 'mission', '--url', `http://127.0.0.1:${address.port}`, '--token', 'token', '--vault', 'vault', '--channel', 'channel'];
  const env = { ...process.env, CASCADE_HELPER_CONFIG: configPath, CASCADE_RUN_ID: '42' };
  await execFileAsync(process.execPath, args, { env });
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).usedChatSend, undefined);
  await execFileAsync(process.execPath, [...args, '--file', file], { env });
  assert.equal(requests[0].path, '/api/vaults/vault/channels/channel/missions/mission/interpretation?coordinator=coordinator');
  assert.equal(requests[1].path, '/api/vaults/vault/channels/channel/missions/mission/interpretation');
  assert.equal(requests[1].run, '42');
  assert.deepEqual(requests[1].body, { ...input, coordinatorRegistrationId: 'coordinator' });
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).usedChatSend, true);
});

test('coordinator continuation sends an explicit run-scoped disposition without suppressing the answer', async (t) => {
  const requests: any[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ path: req.url, body: raw ? JSON.parse(raw) : null, run: req.headers['x-cascade-run-id'] });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ revision: 1, status: 'waiting' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address(); assert(address && typeof address === 'object');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-continuation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'helper.json');
  fs.writeFileSync(configPath, JSON.stringify({ registrationId: 'coordinator', chatChannelId: 'channel' }));
  const args = [cli, 'continuation', '--url', `http://127.0.0.1:${address.port}`, '--token', 'token', '--vault', 'vault', '--channel', 'channel'];
  const env = { ...process.env, CASCADE_HELPER_CONFIG: configPath, CASCADE_RUN_ID: '42' };
  await execFileAsync(process.execPath, args, { env });
  await execFileAsync(process.execPath, [...args, '--status', 'waiting', '--revision', '0', '--summary', 'Existing worker owns delivery'], { env });
  assert.deepEqual(requests, [
    { path: '/api/vaults/vault/channels/channel/continuation', body: null, run: '42' },
    { path: '/api/vaults/vault/channels/channel/continuation', body: { status: 'waiting', revision: 0, summary: 'Existing worker owns delivery' }, run: '42' },
  ]);
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).usedChatSend, undefined);
});
