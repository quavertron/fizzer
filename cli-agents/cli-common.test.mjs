import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { promisify } from 'node:util';
import test from 'node:test';
import { parseArgs } from './cli-common.mjs';

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
