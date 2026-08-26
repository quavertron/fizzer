'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createFizzerIssue,
  parseCreatedIssue,
  ERRORS,
  FIZZER_REPOSITORY,
  ISSUE_TITLE_MAX_LENGTH,
  ISSUE_BODY_MAX_LENGTH,
  GH_TIMEOUT_MS,
} = require('./github-issues.cjs');

function successfulRunner(calls, output = 'https://github.com/grm4871/fizzer/issues/42\n') {
  return async (file, args, options) => {
    calls.push({ file, args, options });
    return { error: null, stdout: output, stderr: '' };
  };
}

test('creates an issue with the exact fixed-repository argv and timeout', async () => {
  const calls = [];
  const result = await createFizzerIssue(
    { title: 'Settings fail to save', body: 'Steps to reproduce', label: 'bug' },
    successfulRunner(calls),
  );

  assert.deepEqual(result, {
    ok: true,
    url: 'https://github.com/grm4871/fizzer/issues/42',
    number: 42,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'gh');
  assert.deepEqual(calls[0].args, [
    'issue',
    'create',
    '--repo',
    FIZZER_REPOSITORY,
    '--title',
    'Settings fail to save',
    '--body',
    'Steps to reproduce',
    '--label',
    'bug',
  ]);
  assert.equal(calls[0].options.timeout, GH_TIMEOUT_MS);
  assert.equal(calls[0].options.shell, false);
});

test('keeps hostile title and body strings as single literal arguments', async () => {
  const calls = [];
  const title = '$(touch /tmp/fizzer-pwned); --repo attacker/repository';
  const body = 'line one\n--label\ninvalid && open /Applications/Calculator.app';

  const result = await createFizzerIssue(
    { title, body, label: 'enhancement' },
    successfulRunner(calls),
  );

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[5], title);
  assert.equal(calls[0].args[7], body);
  assert.equal(calls[0].args.filter((arg) => arg === FIZZER_REPOSITORY).length, 1);
  assert.equal(calls[0].args.filter((arg) => arg === 'enhancement').length, 1);
  assert.equal(calls[0].options.shell, false);
});

test('invalid inputs never invoke the runner', async () => {
  let invocations = 0;
  const runner = async () => {
    invocations += 1;
    throw new Error('runner must not be called');
  };
  const valid = { title: 'A title', body: 'A body', label: 'bug' };
  const invalidInputs = [
    undefined,
    null,
    { ...valid, title: '' },
    { ...valid, title: '   \n' },
    { ...valid, title: 42 },
    { ...valid, title: 'x'.repeat(ISSUE_TITLE_MAX_LENGTH + 1) },
    { ...valid, body: '' },
    { ...valid, body: '\t ' },
    { ...valid, body: [] },
    { ...valid, body: 'x'.repeat(ISSUE_BODY_MAX_LENGTH + 1) },
    { ...valid, label: 'security' },
    { ...valid, label: 'Bug' },
    { ...valid, label: ['bug'] },
  ];

  for (const input of invalidInputs) {
    const result = await createFizzerIssue(input, runner);
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, 'string');
  }
  assert.equal(invocations, 0);
});

test('parses only canonical issue URLs for the fixed repository', () => {
  assert.deepEqual(
    parseCreatedIssue('Creating issue...\nhttps://github.com/grm4871/fizzer/issues/987\n'),
    { url: 'https://github.com/grm4871/fizzer/issues/987', number: 987 },
  );
  assert.equal(parseCreatedIssue('https://github.com/attacker/repository/issues/987'), null);
  assert.equal(parseCreatedIssue('https://github.com/grm4871/fizzer/pull/987'), null);
  assert.equal(parseCreatedIssue('issue created without a URL'), null);
});

test('returns stable errors for missing gh, authentication, permission, and other failures', async () => {
  const input = { title: 'A title', body: 'A body', label: 'bug' };
  const cases = [
    [{ code: 'ENOENT', message: 'spawn gh ENOENT' }, '', ERRORS.missingGh],
    [{ code: 1, message: 'exit 1' }, 'To get started with GitHub CLI, run: gh auth login', ERRORS.auth],
    [{ code: 1, message: 'exit 1' }, 'GraphQL: Resource not accessible by integration (HTTP 403)', ERRORS.permission],
    [{ code: 1, message: 'exit 1' }, 'an unexpected failure', ERRORS.general],
  ];

  for (const [error, stderr, expected] of cases) {
    const runner = async () => ({ error, stdout: '', stderr });
    assert.deepEqual(await createFizzerIssue(input, runner), { ok: false, error: expected });
  }
});

test('rejects a successful command response without a parseable fixed-repository URL', async () => {
  const result = await createFizzerIssue(
    { title: 'A title', body: 'A body', label: 'enhancement' },
    async () => ({ error: null, stdout: 'https://github.com/other/repo/issues/12\n', stderr: '' }),
  );
  assert.deepEqual(result, { ok: false, error: ERRORS.general });
});
