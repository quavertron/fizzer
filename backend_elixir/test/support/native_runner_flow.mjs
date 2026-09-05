#!/usr/bin/env node

import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';

const require = createRequire(import.meta.url);
const { Manager } = require('../../../node_modules/socket.io-client');

const [target, token] = process.argv.slice(2);
if (!target || !token) throw new Error('target and token are required');

const manager = new Manager(target, {
  path: '/socket.io/',
  transports: ['websocket'],
  reconnection: false,
  timeout: 10_000,
});

const runner = manager.socket('/runners', { auth: { token } });
const timeout = setTimeout(() => fail(new Error('native runner flow timed out')), 30_000);

function fail(error) {
  clearTimeout(timeout);
  console.error(error?.stack || error);
  runner.disconnect();
  manager._close();
  process.exitCode = 1;
}

runner.on('connect_error', fail);

runner.on('connect', () => {
  runner.emit('runner:register', {
    activeRunIds: [],
    runnerInstanceId: 'native-runner-flow',
  });
});

runner.on('runner:registered', (response) => {
  console.log(JSON.stringify({ ready: true, response }));
});

const dropped = new Map();
runner.on('run:delegate', (payload) => {
  if (payload.probeMode === 'drop-first') {
    if (!dropped.has(payload.runId)) {
      dropped.set(payload.runId, payload);
      console.log(JSON.stringify({ dropped: payload.runId }));
      return;
    }
    if (!isDeepStrictEqual(payload, dropped.get(payload.runId))) {
      fail(new Error('Retry changed the delegated payload'));
      return;
    }
  }
  if (payload.probeMode === 'cancel') return;

  runner.emit('runner:runEvent', {
    runId: payload.runId,
    type: 'session',
    payload: { sessionId: `native-session-${payload.runId}` },
  });
  runner.emit('runner:runEvent', {
    runId: payload.runId,
    type: 'status',
    payload: { status: 'running' },
  });
  runner.emit('runner:runEvent', {
    runId: payload.runId,
    type: 'status',
    payload: {
      status: 'completed',
      summary: 'Native Socket.IO runner completed.',
      sessionId: `native-session-${payload.runId}`,
    },
  });
});

runner.on('run:cancel', (_payload, callback) => callback({ success: true }));

runner.on('workspace:prepare', (_payload, callback) => {
  callback({
    ok: true,
    path: '/tmp/native-worktree',
    repository: 'cascade',
    branch: 'work/native-flow',
    baseBranch: 'main',
    baseCommit: '0123456789abcdef0123456789abcdef01234567',
    resumed: false,
  });
});

runner.on('probe:finish', () => {
  clearTimeout(timeout);
  console.log(JSON.stringify({ done: true }));
  runner.disconnect();
  manager._close();
});

runner.connect();
