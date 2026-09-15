#!/usr/bin/env node
/**
 * Internal mission-workspace acceptance apparatus.
 * Real HTTP, SQLite, Socket.IO dispatch, restart, Git worktrees and Node tests;
 * deterministic worker/coordinator decisions, not a live-model quality claim.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { io } from 'socket.io-client';
import { launchTestBackend } from './lib/test-backend.mjs';
import { pickPort } from './lib/test-ports.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = await pickPort();
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
const sockets = [];
const backgroundErrors = [];
const missionByChannel = new Map();
const worktrees = new Map();
let runner;
let owner;
let helper;
let repo;
let server;
let initialServer;
const serverOptions = { name: 'mission-workspace-e2e', repoRoot: root, port,
  env: { JWT_SECRET: 'mission-workspace-e2e-secret', CASCADE_ALLOW_OPEN_REGISTRATION: '1',
    CASCADE_NETWORK_MODE: 'false', CASCADE_QMD_WORKER_ENABLED: 'false' }, pipeOutput: false };

function check(name, value) {
  assert.ok(value, name);
  checks.push({ name, at: new Date().toISOString() });
  console.log(`PASS ${name}`);
}
async function request(endpoint, auth = owner?.auth, method = 'GET', body) {
  const response = await fetch(`${base}${endpoint}`, { method,
    headers: { 'content-type': 'application/json', ...auth },
    body: body == null ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  return { status: response.status, ok: response.ok, data: await response.json() };
}
async function must(endpoint, auth, method, body) {
  const response = await request(endpoint, auth, method, body);
  assert.ok(response.ok, `${method || 'GET'} ${endpoint}: ${response.status} ${JSON.stringify(response.data)}`);
  return response.data;
}
async function until(name, predicate, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (backgroundErrors.length) throw backgroundErrors.shift();
    const value = await predicate();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`Timed out: ${name}`);
}
function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function testArtifact(cwd, strict = false) {
  const script = `import assert from 'node:assert/strict'; import { slug } from './slug.mjs';
    assert.equal(slug(' Hello World '), 'hello-world');
    ${strict ? "assert.equal(slug(' Two   Words '), 'two-words');" : ''}`;
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd, stdio: 'pipe' });
    return true;
  } catch { return false; }
}
function commit(cwd, message) {
  git(cwd, 'add', '.');
  git(cwd, '-c', 'user.name=Mission Test', '-c', 'user.email=mission-test@example.invalid', 'commit', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}
async function register(name) {
  const data = await must('/api/auth/register', {}, 'POST', { username: name, password: 'mission-test-password' });
  return { ...data, auth: { authorization: `Bearer ${data.token}` } };
}
async function connect(namespace, token) {
  const socket = io(`${base}/${namespace}`, { auth: { token }, transports: ['websocket'], autoConnect: false });
  sockets.push(socket);
  const connected = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${namespace} connection timeout`)), 10_000);
    socket.once('connect', () => { clearTimeout(timeout); resolve(); });
    socket.once('connect_error', (error) => { clearTimeout(timeout); reject(error); });
  });
  socket.connect();
  await connected;
  return socket;
}
async function runnerFor(activeRunIds = []) {
  const socket = await connect('runners', owner.token);
  const result = { socket, delegated: [], canceled: [] };
  socket.on('workspace:prepare', (payload, acknowledge) => {
    try {
      let directory = worktrees.get(payload.workItemId);
      const resumed = Boolean(directory);
      if (!directory) {
        directory = path.join(initialServer.tempRoot, `work-${payload.workItemId}`);
        git(repo, 'worktree', 'add', '-b', payload.branch, directory, 'master');
        worktrees.set(payload.workItemId, directory);
      }
      acknowledge({ ok: true, path: directory, repository: repo, branch: payload.branch,
        baseBranch: 'master', baseCommit: git(repo, 'rev-parse', 'master'), resumed });
    } catch (error) { acknowledge({ ok: false, error: error.message }); backgroundErrors.push(error); }
  });
  socket.on('run:delegate', (payload) => {
    result.delegated.push(payload);
    socket.emit('runner:runEvent', { runId: payload.runId, type: 'session',
      payload: { sessionId: `mission-test-session-${payload.runId}` } });
    socket.emit('runner:runEvent', { runId: payload.runId, type: 'status', payload: { status: 'running' } });
    // Only scripted coordinator maintenance is automatic. Artifact workers stay
    // running until the scenario has executed and checked their real outputs.
    if (String(payload.chatTriggeringMessageId || '').startsWith('sys-mission-')) {
      void (async () => {
        const mission = missionByChannel.get(payload.chatChannelId);
        if (!mission) return;
        const endpoint = `${mission.taskBase}/${mission.id}/interpretation`;
        const auth = { ...helper, 'x-cascade-run-id': String(payload.runId) };
        const state = await must(`${endpoint}?coordinator=${mission.coordinatorRegistrationId}`, auth);
        const questions = state.understanding?.questions || [];
        const references = state.understanding?.evidenceReferences || [];
        const askMigration = questions.some((q) => q.id === 'migration-resumption' && q.status === 'open')
          && !references.includes('migration-question-published');
        const saved = await request(endpoint, auth, 'POST', {
          coordinatorRegistrationId: mission.coordinatorRegistrationId,
          revision: state.revision, fingerprint: state.fingerprint, noMaterialChange: !askMigration,
          ...(askMigration ? {
            body: 'This unfinished mission was paused during the upgrade. Should I resume it with a newly approved brief, revise the plan, or close it?',
            evidenceReferences: [...references, 'migration-question-published'],
          } : {}),
          assessment: 'Internal test coordinator has inspected current durable state; existing tasks retain ownership.' });
        if (!saved.ok && ![409, 410].includes(saved.status)) throw new Error(JSON.stringify(saved));
        socket.emit('runner:runEvent', { runId: payload.runId, type: 'status',
          payload: { status: 'completed', summary: 'Durable mission state acknowledged.' } });
      })().catch((error) => backgroundErrors.push(error));
    }
  });
  socket.on('run:cancel', ({ runId }, acknowledge) => {
    result.canceled.push(Number(runId));
    acknowledge({ success: true });
  });
  const registered = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('runner registration timeout')), 10_000);
    socket.once('runner:registered', (data) => { clearTimeout(timeout); data?.ok === false ? reject(new Error(data.error)) : resolve(); });
  });
  socket.emit('runner:register', { activeRunIds, runnerInstanceId: 'mission-workspace-apparatus' });
  await registered;
  return result;
}
function enrich(mission) {
  const value = { ...mission, workspace: `/api/vaults/${mission.vaultId}/missions/${mission.id}`,
    taskBase: `/api/vaults/${mission.vaultId}/channels/${mission.channelId}/missions` };
  missionByChannel.set(value.channelId, value);
  return value;
}
async function state(mission) { return (await must(mission.workspace)).mission; }
async function task(mission, id) { return (await state(mission)).tasks.find((row) => row.id === id); }
async function add(mission, purpose, assignee, name, dependsOn = []) {
  return (await must(`${mission.taskBase}/${mission.id}/tasks`, helper, 'POST', {
    coordinatorRegistrationId: mission.coordinatorRegistrationId, title: name, purpose,
    assignee, prompt: name, dependsOn, workspaceMode: 'isolated' })).task;
}
async function running(mission, id) {
  return until(`task running ${id}`, async () => {
    const row = await task(mission, id);
    const payload = runner.delegated.find((item) => item.runId === row.runId);
    return row.status === 'running' && payload ? { ...row, payload } : null;
  });
}
async function settle(mission, row, summary, outcome = {}) {
  runner.socket.emit('runner:runEvent', { runId: row.runId, type: 'status', payload: { status: 'completed', summary } });
  await until(`task completed ${row.id}`, async () => (await task(mission, row.id)).status === 'completed');
  if (Object.keys(outcome).length) await must(`${mission.taskBase}/tasks/${row.id}`, helper, 'PATCH', { status: 'completed', summary, ...outcome });
}
async function approve(mission, auth = owner.auth) {
  const current = await state(mission);
  return must(`${mission.workspace}/approve`, auth, 'POST', {
    expectedRevisions: Object.fromEntries(current.notes.map((note) => [note.noteId, note.revision])) });
}
async function finish(mission, status, summary) {
  return request(`${mission.taskBase}/${mission.id}/finish`, helper, 'POST', {
    coordinatorRegistrationId: mission.coordinatorRegistrationId, status, summary, verification: summary });
}

async function main() {
  server = initialServer = await launchTestBackend(serverOptions);
  repo = path.join(server.tempRoot, 'artifact-repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-b', 'master');
  fs.writeFileSync(path.join(repo, 'slug.mjs'), 'export const slug = (value) => value;\n');
  const baseCommit = commit(repo, 'Baseline slug fixture');
  owner = await register(`mission_owner_${Date.now()}`);
  const guest = await register(`mission_guest_${Date.now()}`);
  helper = { authorization: `Bearer ${(await must('/api/auth/agent-token', owner.auth, 'POST', {})).token}` };
  const { vault } = await must('/api/vaults', owner.auth, 'POST', { name: 'Internal mission acceptance' });
  await must(`/api/vaults/${vault.id}/members`, owner.auth, 'POST', { username: guest.user.username, role: 'editor' });
  const identities = {};
  for (const mention of ['coordinator', 'implementer', 'reviewer', 'integrator']) {
    identities[mention] = (await must(`/api/vaults/${vault.id}/vault-agents`, owner.auth, 'PUT', {
      agentId: 'codex', mention, displayName: mention, model: 'gpt-5.6-sol', cwd: repo })).agent;
  }
  const mission = enrich((await must(`/api/vaults/${vault.id}/missions`, owner.auth, 'POST', {
    id: randomUUID(), title: 'Build a tested slug function', coordinatorIdentityId: identities.coordinator.id,
    briefContent: 'Implement slug(value): trim, lowercase, and replace whitespace with a single hyphen. Independent review and integration required.' })).mission);
  check('mission starts in planning with a dedicated channel and brief', mission.phase === 'planning' && mission.channelId && mission.notes.length === 1);
  await must(`/api/vaults/${vault.id}/channels/${mission.channelId}/agents`);
  const guestState = (await must(mission.workspace, guest.auth)).mission;
  check('another vault member can open the same mission', guestState.id === mission.id);
  const external = await register(`mission_external_${Date.now()}`);
  check('unrelated user cannot read the mission', !(await request(mission.workspace, external.auth)).ok);
  check('agent credentials cannot approve execution', !(await request(`${mission.workspace}/approve`, helper, 'POST', { expectedRevisions: Object.fromEntries(mission.notes.map((n) => [n.noteId, n.revision])) })).ok);
  check('implementation is rejected during planning', !(await request(`${mission.taskBase}/${mission.id}/tasks`, helper, 'POST', {
    coordinatorRegistrationId: mission.coordinatorRegistrationId, title: 'Unauthorized implementation', purpose: 'implementation', assignee: '@implementer' })).ok);
  const research = await add(mission, 'research', '@reviewer', 'Inspect fixture requirements');
  runner = await runnerFor();
  const researchRun = await running(mission, research.id);
  check('research dispatch receives planning context and a real isolated worktree',
    JSON.stringify(researchRun.payload).includes('planning') && fs.existsSync(researchRun.worktreePath));
  check('baseline artifact fails requirements', !testArtifact(researchRun.worktreePath));
  await settle(mission, researchRun, `Research inspected ${baseCommit}; baseline does not normalize whitespace.`);
  await approve(mission);
  check('human approval moves the mission to execution', (await state(mission)).phase === 'executing');
  const implementation = await add(mission, 'implementation', '@implementer', 'Implement slug and await amended edge case', [research.id]);
  let implementing = await running(mission, implementation.id);

  const beforeEdit = await state(mission);
  const brief = beforeEdit.notes.find((note) => note.kind === 'mission');
  const note = (await must(`/api/notes/${brief.noteId}`)).note;
  const updated = await must(`/api/notes/${brief.noteId}`, guest.auth, 'PUT', {
    content: `${note.content}\nSteering acceptance marker: also collapse repeated internal whitespace.`, expectedRevision: note.revision });
  check('collaborator note edit advances its revision', updated.note.revision !== note.revision);
  check('stale note save is rejected without overwrite', (await request(`/api/notes/${brief.noteId}`, owner.auth, 'PUT', {
    content: 'stale overwrite', expectedRevision: note.revision })).status === 409);
  const oldRunId = implementing.runId;
  await must(`${mission.taskBase}/tasks/${implementation.id}/steer`, helper, 'POST', {
    coordinatorRegistrationId: mission.coordinatorRegistrationId, message: 'Steering acceptance marker: collapse repeated internal whitespace.',
    attempt: implementing.attempt, runId: implementing.runId });
  implementing = await until('steered attempt receives fresh instructions', async () => {
    const row = await task(mission, implementation.id);
    const payload = runner.delegated.find((item) => item.runId === row.runId);
    return row.runId !== oldRunId && row.status === 'running' && payload ? { ...row, payload } : null;
  });
  check('steering stops old execution, preserves workspace and reaches resumed worker',
    runner.canceled.includes(oldRunId) && implementing.workItemId === implementation.workItemId
      && JSON.stringify(implementing.payload).includes('Steering acceptance marker'));

  const message = await must(`/api/vaults/${vault.id}/channels/${mission.channelId}/messages`, owner.auth, 'POST', {
    id: randomUUID(), author: owner.user.username, body: 'Confirm you are available while implementation runs.', channelId: mission.channelId });
  const responseRun = await until('coordinator gets live human message while worker executes', () => runner.delegated.find((run) => run.chatMessageId === `agent-dispatch-${message.dispatches?.[0]?.id}`));
  check('coordinator stays reachable without replacing its worker', responseRun.runId !== implementing.runId && !runner.canceled.includes(implementing.runId));
  runner.socket.emit('runner:runEvent', { runId: responseRun.runId, type: 'status', payload: { status: 'completed', summary: 'Worker remains responsible; amended brief acknowledged.' } });

  fs.writeFileSync(path.join(implementing.worktreePath, 'slug.mjs'), "export const slug = (value) => value.trim().toLowerCase().replace(' ', '-');\n");
  const firstCommit = commit(implementing.worktreePath, 'Implement basic slug normalization');
  check('implementation produces a real commit with passing basic tests', testArtifact(implementing.worktreePath) && firstCommit !== baseCommit);
  await settle(mission, implementing, `Implemented ${firstCommit}; basic Node assertions passed.`);
  check('worker completion alone cannot close a mission', !(await finish(mission, 'completed', 'Premature completion')).ok);
  const review = await add(mission, 'review', '@reviewer', 'Review implementation including repeated whitespace', [implementation.id]);
  const reviewing = await running(mission, review.id);
  git(reviewing.worktreePath, 'checkout', '--detach', firstCommit);
  check('independent review finds the deliberately missed edge case', !testArtifact(reviewing.worktreePath, true));
  await settle(mission, reviewing, `Reviewed ${firstCommit}: repeated spaces fail; changes requested.`, { reviewOutcome: 'changes_requested' });
  const fix = await add(mission, 'fix', '@implementer', 'Fix repeated whitespace after independent review', [review.id]);
  const fixing = await running(mission, fix.id);
  git(fixing.worktreePath, 'checkout', '--detach', firstCommit);
  fs.writeFileSync(path.join(fixing.worktreePath, 'slug.mjs'), 'export const slug = (value) => value.trim().toLowerCase().replace(/\\s+/g, "-");\n');
  const fixedCommit = commit(fixing.worktreePath, 'Collapse repeated whitespace');
  check('fix satisfies all real Node assertions', testArtifact(fixing.worktreePath, true));
  await settle(mission, fixing, `Fixed ${fixedCommit}; strict Node assertions passed.`);
  const accepted = await add(mission, 'review', '@reviewer', 'Independently accept corrected implementation', [fix.id]);
  const accepting = await running(mission, accepted.id);
  git(accepting.worktreePath, 'checkout', '--detach', fixedCommit);
  check('independent reviewer verifies the exact corrected revision', testArtifact(accepting.worktreePath, true));
  await settle(mission, accepting, `Accepted ${fixedCommit}; all requirements verified independently.`, { reviewOutcome: 'accepted' });
  const integration = await add(mission, 'integration', '@integrator', 'Integrate independently accepted revision', [accepted.id]);
  const integrating = await running(mission, integration.id);
  git(repo, 'merge', '--ff-only', fixedCommit);
  check('integration lands the exact verified commit in the fixture main branch', git(repo, 'rev-parse', 'master') === fixedCommit && testArtifact(repo, true));
  await settle(mission, integrating, `Integrated ${fixedCommit} into fixture master; strict assertions passed.`);
  const verification = await add(mission, 'verification', '@reviewer', 'Verify integrated artifact', [integration.id]);
  const verifying = await running(mission, verification.id);
  check('verification worktree starts from integrated master', git(verifying.worktreePath, 'rev-parse', 'HEAD') === fixedCommit && testArtifact(verifying.worktreePath, true));
  await settle(mission, verifying, `Verified integrated ${fixedCommit}.`, { verificationPassed: true });
  const final = await finish(mission, 'completed', `Delivered ${fixedCommit}; independent review and integrated Node tests passed.`);
  check('full reviewed delivery closes successfully', final.ok && (await state(mission)).phase === 'closed');
  const history = await must(`${mission.taskBase}/${mission.id}/history`, helper);
  check('history preserves worker, steering, and completion evidence', history.events.some((event) => event.kind === 'mission_completed') && history.events.some((event) => String(event.kind).includes('steer')));

  const stopped = enrich((await must(`/api/vaults/${vault.id}/missions`, owner.auth, 'POST', {
    id: randomUUID(), title: 'Stop and restart acceptance', coordinatorIdentityId: identities.coordinator.id,
    briefContent: 'Research only; stop on request and never resume without fresh authority.' })).mission);
  await must(`/api/vaults/${vault.id}/channels/${stopped.channelId}/agents`);
  const stopTask = await add(stopped, 'research', '@implementer', 'Wait for explicit Stop');
  const stopping = await running(stopped, stopTask.id);
  check('Stop closes the mission and reaches its active worker', (await finish(stopped, 'canceled', 'Owner requested Stop.')).ok);
  await until('runner acknowledges Stop', () => runner.canceled.includes(stopping.runId));
  const legacy = enrich((await must(`/api/vaults/${vault.id}/missions`, owner.auth, 'POST', {
    id: randomUUID(), title: 'Unfinished mission before upgrade', coordinatorIdentityId: identities.coordinator.id,
    briefContent: 'Preserve this unfinished responsibility and ask before continuing.' })).mission);
  await must(`/api/vaults/${vault.id}/channels/${legacy.channelId}/agents`);
  const legacyTask = await add(legacy, 'research', '@implementer', 'Historical task awaiting a decision');
  const legacyRun = await running(legacy, legacyTask.id);
  runner.socket.disconnect();
  await server.stop({ cleanup: false });
  // Only this owned throwaway DB is edited: emulate a pre-cutover database so
  // the real startup migration, not a test-side substitute, fences old work.
  const database = new DatabaseSync(initialServer.databasePath);
  database.prepare("DELETE FROM chat_mission_migrations WHERE name IN ('mission-workspace-fence-v2','mission-workspace-decisions-v1')").run();
  database.close();
  server = await launchTestBackend({ ...serverOptions, tempRoot: initialServer.tempRoot });
  runner = await runnerFor();
  await sleep(1_000);
  check('restart retains completed delivery and stopped mission without worker revival',
    (await state(mission)).phase === 'closed' && (await state(stopped)).status === 'canceled'
      && !runner.delegated.some((run) => run.missionTaskId === stopTask.id));
  check('restart preserves the exact integrated artifact', git(repo, 'rev-parse', 'master') === fixedCommit && testArtifact(repo, true));
  const migrated = await state(legacy);
  check('migration fences unfinished work and clears stale execution authority', migrated.phase === 'planning'
    && migrated.tasks.every((row) => row.status === 'canceled') && !migrated.approvedAt);
  const legacyMessages = async () => (await must(`/api/vaults/${vault.id}/channels/${legacy.channelId}/messages`)).messages;
  const migrationQuestion = (messages) => messages.filter((message) => message.body.includes('Should I resume it with a newly approved brief'));
  await until('orchestrator publishes the migration question', async () => migrationQuestion(await legacyMessages()).length === 1);
  check('migration question is visible while historical worker remains stopped',
    !(runner.delegated.some((run) => run.runId === legacyRun.runId)) && (await task(legacy, legacyTask.id)).status === 'canceled');
  runner.socket.disconnect();
  await server.stop({ cleanup: false });
  server = await launchTestBackend({ ...serverOptions, tempRoot: initialServer.tempRoot });
  runner = await runnerFor();
  await sleep(1_000);
  check('second restart retains one question and does not resume historical work',
    migrationQuestion(await legacyMessages()).length === 1 && (await state(legacy)).phase === 'planning'
      && (await task(legacy, legacyTask.id)).status === 'canceled');
  await approve(legacy);
  const decided = await must(`${legacy.taskBase}/${legacy.id}/interpretation?coordinator=${legacy.coordinatorRegistrationId}`, helper);
  check('fresh human approval durably answers the migration decision', decided.understanding.questions.some((q) => q.id === 'migration-resumption' && q.status === 'answered'));
  await finish(legacy, 'canceled', 'Migration acceptance complete; stop the fixture.');
  const evidence = { kind: 'deterministic internal acceptance, real server and artifacts', checks, baseCommit, fixedCommit,
    missionId: mission.id, stoppedMissionId: stopped.id, worktrees: [...worktrees.values()] };
  fs.writeFileSync(path.join(initialServer.tempRoot, 'mission-evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ passed: checks.length, evidence: path.join(initialServer.tempRoot, 'mission-evidence.json'), fixedCommit }));
}
try { await main(); }
catch (error) { console.error(error.stack); if (server) console.error(server.output?.()); process.exitCode = 1; }
finally {
  for (const socket of sockets) socket.disconnect();
  await server?.stop();
  if (initialServer !== server) await initialServer?.stop();
}
