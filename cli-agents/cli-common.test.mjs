import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { promisify } from 'node:util';
import test from 'node:test';
import { parseArgs, resolveToken } from './cli-common.mjs';

const exec = promisify(execFile);
const helpers = { chat: ['history'], note: ['list'], scratchpad: ['journal'] };
const env = { ...process.env, CASCADE_HELPER_CONFIG: '/nonexistent/cli-common-test',
  CASCADE_NOTE_TOKEN: '', CASCADE_NOTE_USER: '', CASCADE_NOTE_PASS: '', CASCADE_RUN_ID: '' };
function run(helper, args) {
  return exec(process.execPath, [new URL(`cascade-${helper}`, import.meta.url).pathname, ...args], { env });
}

test('shared parser preserves permissive values, positionals, repeated flags and aliases', () => {
  assert.deepEqual(parseArgs(['mission', '--json', 'list', '--limit', '2', '--limit', '3', '--file', '-', '--priority', '-5', '--unknown', '--status', 'open', '-h']),
    { _: ['mission', 'list'], json: true, limit: '3', file: '-', priority: '-5', unknown: true, status: 'open', help: true });
  assert.deepEqual(parseArgs(['--win', 'task', '--loss', '--neutral', '--unconsolidated', 'tail'], {
    win: ['result', 'win'], loss: ['result', 'loss'], neutral: ['result', 'neutral'], unconsolidated: ['unconsolidated', true],
  }), { _: ['task', 'tail'], result: 'neutral', unconsolidated: true });
  assert.deepEqual(parseArgs(['--include-reply-context', 'history'], { 'include-reply-context': ['include-reply-context', true] }),
    { _: ['history'], 'include-reply-context': true });
});

for (const [helper, command] of Object.entries(helpers)) {
  test(`${helper}: JSON failures keep stderr parseable and stdout empty`, async () => {
    for (const args of [['--json'], [...command, '--json']]) {
      await assert.rejects(run(helper, args), error => {
        assert.equal(error.code, 1);
        assert.equal(error.stdout, '');
        const body = JSON.parse(error.stderr).error;
        assert.equal(body.command, `cascade-${helper}`);
        assert.equal(body.code, 'cli_error');
        assert.equal(body.exitCode, 1);
        assert.match(body.message, /missing command|no credentials|missing vault/);
        return true;
      });
    }
    await assert.rejects(run(helper, command), error => {
      assert.match(error.stderr, new RegExp(`^cascade-${helper}: (no credentials|missing vault)`));
      return true;
    });
  });

  test(`${helper}: HTTP errors preserve status and complete conflict details`, async t => {
    const conflict = { error: 'Read and reconcile', code: 'revision_conflict', currentRevision: 4,
      changedFields: ['status'], comparison: 'submitted_fields_only', limitation: 'Historical values unavailable' };
    let body = JSON.stringify(conflict);
    const server = http.createServer((req, res) => {
      if (body === null) { req.socket.destroy(); return; }
      res.statusCode = 409; res.end(body);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const args = [...command, '--url', `http://127.0.0.1:${server.address().port}`, '--token', 'fixture', '--vault', 'v', '--channel', 'c'];
    for (const value of [conflict, { raw: '<html>Unavailable</html>' }]) {
      body = value === conflict ? JSON.stringify(value) : value.raw;
      await assert.rejects(run(helper, [...args, '--json']), error => {
        assert.equal(error.code, 1);
        assert.equal(error.stdout, '');
        const result = JSON.parse(error.stderr).error;
        assert.equal(result.status, 409);
        assert.equal(result.method, 'GET');
        assert.match(result.path, /^\/api\//);
        assert.equal(result.code, value.code || 'http_error');
        assert.deepEqual(result.details, value);
        return true;
      });
    }
    body = null;
    await assert.rejects(run(helper, [...args, '--json']), error => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, '');
      const result = JSON.parse(error.stderr).error;
      assert.equal(result.command, `cascade-${helper}`);
      assert.equal(result.code, 'UND_ERR_SOCKET');
      assert.match(result.message, /fetch failed/);
      return true;
    });
  });
}


test('expired bound helper credentials do not fall back to a broader config bearer', () => {
  const prior = process.env.CASCADE_NOTE_TOKEN;
  const expired = `header.${Buffer.from(JSON.stringify({ exp: 1, agentSource: { runId: 7 } })).toString('base64url')}.signature`;
  try {
    process.env.CASCADE_NOTE_TOKEN = expired;
    assert.equal(resolveToken(undefined, 'broader-config-token'), expired);
    delete process.env.CASCADE_NOTE_TOKEN;
    assert.equal(resolveToken(undefined, expired), expired);
  } finally {
    if (prior === undefined) delete process.env.CASCADE_NOTE_TOKEN;
    else process.env.CASCADE_NOTE_TOKEN = prior;
  }
});

function boundToken(exp, source = { runId: 7, registrationId: 'reg', vaultAgentId: 'identity' }) {
  return `header.${Buffer.from(JSON.stringify({ id: 1, username: 'fixture', authVersion: 0, access: 'agent', exp, agentSource: source })).toString('base64url')}.signature`;
}

test('immutable env accepts only a newer same-source config bearer', () => {
  const prior = process.env.CASCADE_NOTE_TOKEN;
  const expired = boundToken(1);
  const fresh = boundToken(Date.now() / 1000 + 3600);
  try {
    process.env.CASCADE_NOTE_TOKEN = expired;
    assert.equal(resolveToken(undefined, fresh), fresh);
    assert.equal(resolveToken(undefined, boundToken(Date.now() / 1000 + 3600, { runId: 8 })), expired);
    assert.equal(resolveToken(undefined, 'owner-token'), expired);
    process.env.CASCADE_NOTE_TOKEN = fresh;
    assert.equal(resolveToken(undefined, expired), fresh);
  } finally {
    if (prior === undefined) delete process.env.CASCADE_NOTE_TOKEN;
    else process.env.CASCADE_NOTE_TOKEN = prior;
  }
});

for (const [helper, command] of Object.entries(helpers)) {
  test(`${helper}: expired bound credential renews before API access and fails closed`, async t => {
    const expired = boundToken(1);
    const fresh = boundToken(Date.now() / 1000 + 3600);
    const requests = [];
    let renewalStatus = 200;
    let returnedToken = fresh;
    const server = http.createServer((req, res) => {
      requests.push([req.url, req.headers.authorization]);
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/auth/agent-token/renew') {
        res.statusCode = renewalStatus;
        res.end(JSON.stringify(renewalStatus === 200 ? { token: returnedToken } : { error: 'Revoked' }));
      } else {
        res.end(JSON.stringify({ messages: [], notes: [], entries: [], journal: [] }));
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const args = [...command, '--url', `http://127.0.0.1:${server.address().port}`, '--token', expired, '--vault', 'v', '--channel', 'c', '--json'];
    await run(helper, args);
    assert.deepEqual(requests[0], ['/api/auth/agent-token/renew', `Bearer ${expired}`]);
    assert.ok(requests.length > 1);
    assert.ok(requests.slice(1).every(([, token]) => token === `Bearer ${fresh}`));
    requests.length = 0;
    renewalStatus = 401;
    await assert.rejects(run(helper, args), error => {
      assert.equal(JSON.parse(error.stderr).error.status, 401);
      return true;
    });
    assert.equal(requests.length, 1);
    requests.length = 0;
    renewalStatus = 200;
    returnedToken = boundToken(Date.now() / 1000 + 3600, { runId: 8 });
    await assert.rejects(run(helper, args), /different source/);
    assert.equal(requests.length, 1);
  });
}

test('renewal persists matching per-run context for the next invocation with an expired env', async t => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fizzer-renew-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, '7.json');
  const expired = boundToken(1);
  const fresh = boundToken(Date.now() / 1000 + 3600);
  let renewals = 0;
  const seen = [];
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/auth/agent-token/renew') {
      renewals++;
      res.end(JSON.stringify({ token: fresh }));
    } else {
      seen.push(req.headers.authorization);
      res.end(JSON.stringify({ messages: [] }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(configPath, JSON.stringify({ url, token: expired, runId: 7 }), { mode: 0o600 });
  for (let i = 0; i < 2; i++) {
    await exec(process.execPath, [new URL('cascade-chat', import.meta.url).pathname, 'history', '--vault', 'v', '--channel', 'c', '--json'], {
      env: { ...env, CASCADE_NOTE_TOKEN: expired, CASCADE_HELPER_CONFIG: configPath },
    });
  }
  assert.equal(renewals, 1);
  assert.ok(seen.length >= 2);
  assert.ok(seen.every(token => token === `Bearer ${fresh}`));
  assert.equal(JSON.parse(fs.readFileSync(configPath)).token, fresh);
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
});
