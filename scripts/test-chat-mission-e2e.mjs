#!/usr/bin/env node
/** Real-server persistence/multiplayer test for chat-first missions. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';
import { launchTestBackend } from './lib/test-backend.mjs';
import { pickPort } from './lib/test-ports.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_PORT = Number(process.env.TEST_API_PORT) || await pickPort();
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

async function must(url, options = {}) {
  const result = await request(url, options);
  if (!result.ok) throw new Error(`${result.status} ${url}: ${result.data.error || 'request failed'}`);
  return result.data;
}

async function register(username) {
  const { token } = await must(`${API_BASE}/api/auth/register`, {
    method: 'POST', body: JSON.stringify({ username, password: 'testpass12345' }),
  });
  return { token, auth: { authorization: `Bearer ${token}` } };
}

async function socketFor(token, vaultId) {
  const socket = io(`${API_BASE}/vault`, { auth: { token }, transports: ['websocket'] });
  const created = [];
  const updated = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket timeout')), 10_000);
    socket.on('connect', () => {
      clearTimeout(timer);
      socket.emit('joinVault', vaultId);
      resolve();
    });
    socket.on('connect_error', reject);
  });
  socket.on('vault:chatMessageCreated', (event) => created.push(event));
  socket.on('vault:chatMessageUpdated', (event) => updated.push(event));
  return { socket, created, updated };
}

async function runnerFor(token) {
  const socket = io(`${API_BASE}/runners`, { auth: { token }, transports: ['websocket'] });
  const delegated = [];
  const canceled = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('runner socket timeout')), 10_000);
    socket.on('connect_error', reject);
    socket.on('runner:registered', (response) => {
      clearTimeout(timer);
      if (response?.ok === false) reject(new Error(response.error || 'runner registration failed'));
      else resolve();
    });
    socket.on('connect', () => {
      socket.emit('runner:register', {
        activeRunIds: [],
        runnerInstanceId: `mission-e2e-${Date.now()}`,
      });
    });
  });
  socket.on('workspace:prepare', (payload, acknowledge) => {
    acknowledge({
      ok: true,
      path: `/tmp/mission-e2e-${payload.workItemId}`,
      repository: '/tmp/mission-e2e-repo',
      branch: payload.branch,
      baseBranch: 'master',
      baseCommit: '0123456789abcdef0123456789abcdef01234567',
      resumed: false,
    });
  });
  socket.on('run:delegate', (payload) => {
    delegated.push(payload);
    socket.emit('runner:runEvent', {
      runId: payload.runId,
      type: 'status',
      payload: { status: 'running' },
    });
  });
  socket.on('run:cancel', ({ runId }, acknowledge) => {
    canceled.push(Number(runId));
    acknowledge({ success: true });
  });
  await waitUntil('runner registration to become authoritative', async () => {
    const status = await request(`${API_BASE}/api/me/desktop-runner`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return status.ok && status.data.online;
  });
  return { socket, delegated, canceled };
}

async function waitUntil(label, predicate, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

let failures = 0;
function check(label, condition) {
  if (condition) console.log(`[mission-e2e] OK  ${label}`);
  else { console.error(`[mission-e2e] FAIL ${label}`); failures += 1; }
}

async function main() {
  const server = await launchTestBackend({
    name: 'chat-mission-e2e', repoRoot: root, port: API_PORT,
    env: {
      JWT_SECRET: 'mission-e2e-secret',
      CASCADE_ALLOW_OPEN_REGISTRATION: '1',
    },
  });

  try {
    const stamp = Date.now();
    const owner = await register(`owner_${stamp}`);
    const guest = await register(`guest_${stamp}`);
    const { vault } = await must(`${API_BASE}/api/vaults`, {
      method: 'POST', headers: owner.auth, body: JSON.stringify({ name: 'Mission vault' }),
    });
    const { note: channel } = await must(`${API_BASE}/api/vaults/${vault.id}/notes`, {
      method: 'POST', headers: owner.auth,
      body: JSON.stringify({ title: 'dev', content: 'cascade://chat-channel' }),
    });
    const solIdentity = await must(`${API_BASE}/api/vaults/${vault.id}/vault-agents`, {
      method: 'PUT', headers: owner.auth,
      body: JSON.stringify({
        agentId: 'codex', displayName: 'Sol', mention: 'sol', model: 'gpt-5.6-sol', cwd: root,
      }),
    });
    const terraIdentity = await must(`${API_BASE}/api/vaults/${vault.id}/vault-agents`, {
      method: 'PUT', headers: owner.auth,
      body: JSON.stringify({ agentId: 'codex', displayName: 'Terra', mention: 'terra', model: 'gpt-5.6-terra' }),
    });
    const { registration: sol } = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/agents/from-vault`, {
      method: 'POST', headers: owner.auth,
      body: JSON.stringify({ vaultAgentId: solIdentity.agent.id, orchestrator: true, pingableByOthers: true }),
    });
    const { registration: terra } = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/agents/from-vault`, {
      method: 'POST', headers: owner.auth,
      body: JSON.stringify({ vaultAgentId: terraIdentity.agent.id, taggableByAgents: false }),
    });
    check('coordinator implies reply-to-every-human-message', sol.orchestrator && sol.replyToEveryMessage);
    check('worker remains closed to ordinary agent chaining', !terra.taggableByAgents);
    const { token: agentToken } = await must(`${API_BASE}/api/auth/agent-token`, {
      method: 'POST', headers: owner.auth,
    });
    const agentAuth = { authorization: `Bearer ${agentToken}` };
    const helperMembers = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/agents`, {
      headers: agentAuth,
    });
    check('restricted helper token can list mission teammates', helperMembers.agents?.length === 2);
    const helperFolder = await must(`${API_BASE}/api/vaults/${vault.id}/folders`, {
      method: 'POST', headers: agentAuth, body: JSON.stringify({ name: 'agent-created' }),
    });
    check('restricted helper token can create a live-note folder', helperFolder.folder?.name === 'agent-created');

    await must(`${API_BASE}/api/vaults/${vault.id}/members`, {
      method: 'POST', headers: owner.auth,
      body: JSON.stringify({ username: `guest_${stamp}`, role: 'editor' }),
    });
    const ownerSocket = await socketFor(owner.token, vault.id);
    const guestSocket = await socketFor(guest.token, vault.id);
    await sleep(150);

    const guestIdentity = await must(`${API_BASE}/api/vaults/${vault.id}/vault-agents`, {
      method: 'PUT', headers: guest.auth,
      body: JSON.stringify({ agentId: 'codex', displayName: 'Guest Sol', mention: `guest_sol_${stamp}`, model: 'gpt-5.6-sol' }),
    });
    const { registration: guestCoordinator } = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/agents/from-vault`, {
      method: 'POST', headers: guest.auth,
      body: JSON.stringify({ vaultAgentId: guestIdentity.agent.id, orchestrator: true }),
    });

    const guestPost = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/messages`, {
      method: 'POST', headers: guest.auth,
      body: JSON.stringify({
        id: `guest-${stamp}`, channelId: channel.id, author: `guest_${stamp}`,
        body: 'Coordinate this shared-channel request.', createdAt: new Date().toISOString(),
      }),
    });
    check('a shared user wakes only their own coordinator', guestPost.dispatches?.[0]?.registration?.id === guestCoordinator.id);

    const rootMessage = {
      id: `root-${stamp}`, channelId: channel.id, author: `owner_${stamp}`,
      body: 'Investigate and verify multiplayer orchestration.', createdAt: new Date().toISOString(),
    };
    const posted = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/messages`, {
      method: 'POST', headers: owner.auth, body: JSON.stringify(rootMessage),
    });
    check('human message creates a durable coordinator dispatch', posted.dispatches?.[0]?.registration?.id === sol.id);

    const { mission } = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/missions`, {
      method: 'POST', headers: agentAuth,
      body: JSON.stringify({
        rootMessageId: rootMessage.id,
        coordinatorRegistrationId: sol.id,
        title: 'Multiplayer orchestration',
        objective: rootMessage.body,
      }),
    });
    const delegated = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/missions/${mission.id}/tasks`, {
      method: 'POST', headers: agentAuth,
      body: JSON.stringify({
        coordinatorRegistrationId: sol.id,
        title: 'Verify guest reload',
        assignee: '@terra',
        prompt: 'Verify the guest can reload and retain mission state.',
      }),
    });
    check('coordinator can dispatch an opt-out worker explicitly', delegated.task?.assigneeMention === 'terra');
    check('delegation message is linked to its durable task', delegated.message?.missionTaskId === delegated.task?.id);
    const dependent = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/missions/${mission.id}/tasks`, {
      method: 'POST', headers: agentAuth,
      body: JSON.stringify({
        coordinatorRegistrationId: sol.id,
        title: 'Recheck after guest verification',
        assignee: '@terra',
        prompt: 'Recheck only after the guest reload evidence is ready.',
        dependsOn: [delegated.task.id],
        priority: 5,
        reasoningEffort: 'high',
      }),
    });
    check('dependent work stays undispatched while prerequisites run', dependent.scheduled === false && !dependent.message);
    check('mission projection exposes dependency waiting state', dependent.task?.waitingFor?.[0] === delegated.task.id);
    const helperStatus = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/missions/${mission.id}`, {
      headers: agentAuth,
    });
    check('restricted helper token can read mission state', helperStatus.mission?.id === mission.id);
    const helperUpdate = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/missions/tasks/${delegated.task.id}`, {
      method: 'PATCH', headers: agentAuth,
      body: JSON.stringify({ status: 'running', summary: 'Accepted by the worker queue.' }),
    });
    check('restricted helper token can update a mission task', helperUpdate.mission?.tasks?.[0]?.status === 'running');
    const completedFirst = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/missions/tasks/${delegated.task.id}`, {
      method: 'PATCH', headers: agentAuth,
      body: JSON.stringify({ status: 'completed', summary: 'Guest reload verified.' }),
    });
    check('completing a prerequisite automatically dispatches its dependent', (
      completedFirst.mission?.tasks?.find((task) => task.id === dependent.task.id)?.queueReason === 'queued'
    ));

    await sleep(300);
    check('owner received the inline mission update', ownerSocket.updated.some((event) => event.message?.mission?.id === mission.id));
    check('shared member received the same mission projection', guestSocket.updated.some((event) => (
      event.channelId === channel.id && event.message?.mission?.id === mission.id
    )));
    check('worker dispatch reached owner clients as a durable outbox event', ownerSocket.created.some((event) => (
      event.message?.missionTaskId === delegated.task.id
      && event.dispatches?.[0]?.registration?.id === terra.id
    )));
    check('automatic dependent dispatch reached owner clients', ownerSocket.created.some((event) => (
      event.message?.missionTaskId === dependent.task.id
      && event.dispatches?.[0]?.reasoningEffort === 'high'
    )));
    check('shared member received the owner-scoped worker dispatch', guestSocket.created.some((event) => (
      event.message?.missionTaskId === delegated.task.id
      && event.dispatches?.[0]?.registration?.id === terra.id
    )));

    const ownerReload = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/messages?detail=list`, { headers: owner.auth });
    const guestReload = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/messages?detail=list`, { headers: guest.auth });
    check('owner reload retains the scheduled task graph', ownerReload.messages.find((message) => message.id === rootMessage.id)?.mission?.tasks?.length === 2);
    check('shared member reload retains the scheduled task graph', guestReload.messages.find((message) => message.id === rootMessage.id)?.mission?.tasks?.length === 2);

    const pending = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/agent-dispatches/pending`, { headers: owner.auth });
    check('pending outbox survives without a renderer', pending.dispatches.some((dispatch) => (
      dispatch.message?.missionTaskId === dependent.task.id && dispatch.registration?.id === terra.id
    )));

    const failedDependent = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/missions/tasks/${dependent.task.id}`, {
      method: 'PATCH', headers: agentAuth,
      body: JSON.stringify({ status: 'failed', summary: 'Transient provider failure.' }),
    });
    check('worker failure asks for attention without closing the mission', failedDependent.mission?.status === 'attention');
    const retriedDependent = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/missions/tasks/${dependent.task.id}`, {
      method: 'PATCH', headers: agentAuth,
      body: JSON.stringify({ status: 'pending', summary: 'Retry with the same task and workspace.' }),
    });
    check('retry keeps task identity and increments its attempt', (
      retriedDependent.mission?.tasks?.find((task) => task.id === dependent.task.id)?.attempt === 1
    ));
    const retryOutbox = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/agent-dispatches/pending`, { headers: owner.auth });
    check('retry gets a fresh durable dispatch instead of reusing the settled one', retryOutbox.dispatches.some((dispatch) => (
      dispatch.message?.id === `mission-task-${dependent.task.id}-1`
    )));
    const history = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/missions/${mission.id}/history`, { headers: agentAuth });
    check('append-only history retains the retry transition', history.events?.some((event) => (
      event.kind === 'task_retried' && event.taskId === dependent.task.id
    )));
    const archive = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/missions`, { headers: agentAuth });
    check('mission archive is independent of the transcript window', archive.missions?.some((item) => item.id === mission.id));

    const runner = await runnerFor(owner.token);
    const parallel = [];
    for (const label of ['alpha', 'beta']) {
      const rootId = `sys-parallel-${label}-${stamp}`;
      await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/messages`, {
        method: 'POST', headers: agentAuth,
        body: JSON.stringify({
          id: rootId, channelId: channel.id, author: 'Sol', registrationId: sol.id,
          body: `Parallel ${label}`, createdAt: new Date().toISOString(),
        }),
      });
      const { mission: parallelMission } = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/missions`, {
        method: 'POST', headers: agentAuth,
        body: JSON.stringify({
          rootMessageId: rootId,
          coordinatorRegistrationId: sol.id,
          title: `Parallel ${label}`,
          objective: `Execute parallel ${label}`,
          controlPlane: true,
        }),
      });
      check(`control-plane ${label} starts without a coordinator task`, parallelMission.tasks?.length === 0);
      const delegatedTask = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/missions/${parallelMission.id}/tasks`, {
        method: 'POST', headers: agentAuth,
        body: JSON.stringify({
          coordinatorRegistrationId: sol.id,
          title: `Anonymous ${label}`,
          assignee: '@sol',
          prompt: `SYSTEM_PARALLEL_${label.toUpperCase()}`,
          anonymous: true,
          workspaceMode: 'isolated',
        }),
      });
      parallel.push({ mission: parallelMission, task: delegatedTask.task });
    }

    const workers = [];
    for (const { mission: parallelMission } of parallel) {
      let observedMission;
      let running;
      try {
        running = await waitUntil(`running worker for ${parallelMission.title}`, async () => {
          const result = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/missions/${parallelMission.id}`, { headers: agentAuth });
          observedMission = result.mission;
          const taskState = result.mission.tasks?.[0];
          return taskState?.status === 'running' && taskState.runId ? taskState : null;
        });
      } catch (error) {
        throw new Error(`${error.message}; last mission state: ${JSON.stringify(observedMission)}`);
      }
      workers.push(running);
      check(`parallel mission ${parallelMission.title} reaches running`, true);
    }
    check('independent anonymous missions dispatch concurrently', new Set(workers.map((run) => run.runId)).size === 2);
    check('each worker is bound to its own isolated workspace', workers.every((run) => (
      run.workItemId && String(run.worktreePath).startsWith('/tmp/mission-e2e-')
    )));

    const startCoordinatorTurn = async (sequence) => {
      const messageId = `control-plane-${sequence}-${stamp}`;
      const postedControl = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/messages`, {
        method: 'POST', headers: owner.auth,
        body: JSON.stringify({
          id: messageId,
          channelId: channel.id,
          author: `owner_${stamp}`,
          body: `Control-plane message ${sequence}`,
          createdAt: new Date().toISOString(),
        }),
      });
      const dispatch = postedControl.dispatches?.find((item) => item.registration?.id === sol.id);
      if (!dispatch) throw new Error(`control-plane message ${sequence} did not dispatch Sol`);
      const run = await waitUntil(`server-started coordinator turn ${sequence}`, () => (
        runner.delegated.find((run) => run.chatMessageId === `agent-dispatch-${dispatch.id}`)
      ));
      return { id: run.runId };
    };

    const firstCoordinatorRun = await startCoordinatorTurn('one');
    const secondCoordinatorRun = await startCoordinatorTurn('two');
    check('new coordinator turn replaces only its foreground predecessor', (
      runner.canceled.includes(firstCoordinatorRun.id)
      && !runner.canceled.some((runId) => workers.some((worker) => worker.runId === runId))
    ));

    runner.socket.emit('runner:runEvent', {
      runId: secondCoordinatorRun.id,
      type: 'status',
      payload: { status: 'completed', summary: 'Control plane stayed responsive.' },
    });
    await waitUntil('second coordinator turn completion', async () => {
      const result = await must(`${API_BASE}/api/runs/${secondCoordinatorRun.id}`, { headers: owner.auth });
      return result.run?.status === 'completed';
    });

    const thirdCoordinatorRun = await startCoordinatorTurn('three');
    runner.socket.emit('runner:runEvent', {
      runId: thirdCoordinatorRun.id,
      type: 'status',
      payload: { status: 'completed', summary: 'A later control-plane turn also completed.' },
    });
    await waitUntil('third coordinator turn completion', async () => {
      const result = await must(`${API_BASE}/api/runs/${thirdCoordinatorRun.id}`, { headers: owner.auth });
      return result.run?.status === 'completed';
    });

    for (const { mission: parallelMission } of parallel) {
      const stillRunning = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/missions/${parallelMission.id}`, { headers: agentAuth });
      check(`coordinator activity leaves ${parallelMission.title} running`, (
        stillRunning.mission.status === 'active'
        && stillRunning.mission.tasks?.[0]?.status === 'running'
      ));
    }

    for (const worker of workers) {
      runner.socket.emit('runner:runEvent', {
        runId: worker.runId,
        type: 'status',
        payload: { status: 'completed', summary: `Produced by run ${worker.runId}` },
      });
    }

    for (const { mission: parallelMission } of parallel) {
      const reviewing = await waitUntil(`review wake for ${parallelMission.title}`, async () => {
        const result = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/missions/${parallelMission.id}`, { headers: agentAuth });
        return result.mission.status === 'reviewing' ? result.mission : null;
      });
      check(`parallel mission ${parallelMission.title} reconciles run evidence`, (
        reviewing.tasks?.[0]?.verification?.startsWith('Produced by run ')
        && reviewing.tasks?.[0]?.baseCommit === '0123456789abcdef0123456789abcdef01234567'
      ));
      const reviewRun = await waitUntil(`server-started review for ${parallelMission.title}`, () => (
        runner.delegated.find((run) => run.chatRegistrationId === sol.id
          && String(run.chatTriggeringMessageId || '').startsWith(`sys-mission-${parallelMission.id}-`))
      ));
      check(`parallel mission ${parallelMission.title} wakes its coordinator`, true);
      runner.socket.emit('runner:runEvent', {
        runId: reviewRun.runId,
        type: 'status',
        payload: { status: 'completed', summary: `Reviewed ${parallelMission.title}` },
      });
      await waitUntil(`coordinator review turn for ${parallelMission.title}`, async () => {
        const result = await must(`${API_BASE}/api/runs/${reviewRun.runId}`, { headers: owner.auth });
        return result.run?.status === 'completed';
      });
      const finishedParallel = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/missions/${parallelMission.id}/finish`, {
        method: 'POST', headers: agentAuth,
        body: JSON.stringify({
          coordinatorRegistrationId: sol.id,
          status: 'completed',
          verification: 'Observed bound worker run completion and inspected parallel task results.',
          summary: 'Parallel worker evidence reconciled.',
        }),
      });
      check(`parallel mission ${parallelMission.title} finishes after review`, finishedParallel.mission?.status === 'completed');
    }
    runner.socket.disconnect();

    ownerSocket.socket.disconnect();
    guestSocket.socket.disconnect();
    if (failures) throw new Error(`${failures} mission check(s) failed`);
    console.log('[mission-e2e] All chat-first mission checks passed');
  } finally {
    await server.stop();
  }
}

main().catch((error) => {
  console.error('[mission-e2e] FAILED:', error.message || error);
  process.exit(1);
});
