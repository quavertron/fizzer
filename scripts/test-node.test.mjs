import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const runner = fileURLToPath(new URL('./test-node.mjs', import.meta.url));
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT; // Launch an independent actual test runner.

function fixture(t, source, suffix = 'mjs') {
  const dir = mkdtempSync(join(tmpdir(), 'fizzer-reporter-fixture-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, `fixture.${suffix}`);
  writeFileSync(path, source);
  return path;
}
function run(t, args) {
  const result = spawnSync(process.execPath, [runner, ...args], { encoding: 'utf8', timeout: 20000, env });
  assert.ifError(result.error);
  const log = result.stdout.match(/Full test diagnostics: (.+)/)?.[1];
  assert.ok(log, result.stderr);
  t.after(() => rmSync(dirname(log), { recursive: true, force: true }));
  if (process.platform !== 'win32') assert.equal(statSync(dirname(log)).mode & 0o777, 0o700);
  return { ...result, diagnostics: existsSync(log) ? readFileSync(log, 'utf8') : '', log };
}

test('successful noisy tests stay compact; all tests, skips, todos and diagnostics are retained', t => {
  const file = fixture(t, `import test from 'node:test';
    test('passes', () => { console.log('output-marker-' + 'x'.repeat(10000)); console.error('stderr-marker'); });
    test.skip('skipped', () => {}); test.todo('todo');`);
  const result = run(t, [file]);
  assert.equal(result.status, 0);
  assert.ok(result.stdout.length < 500);
  assert.ok(!result.stdout.includes('output-marker'));
  for (const marker of ['passes', 'skipped', 'todo', 'output-marker-', 'stderr-marker', 'tests 3', 'pass 1', 'skipped 1', 'todo 1']) {
    assert.ok(result.diagnostics.includes(marker), marker);
  }
});

test('failures preserve exit status and print the full saved diagnostics', t => {
  const file = fixture(t, `import test from 'node:test'; import assert from 'node:assert/strict';
    test('failure-marker', () => assert.equal('actual-marker', 'expected-marker'));`);
  const result = run(t, [file]);
  assert.equal(result.status, 1);
  for (const marker of ['failure-marker', 'actual-marker', 'expected-marker', 'AssertionError', 'fail 1']) {
    assert.ok(result.diagnostics.includes(marker), marker);
    assert.ok(result.stderr.includes(marker), marker);
  }
});

test('typescript and test selection use the same Node runner', t => {
  const file = fixture(t, `import test from 'node:test';
    const value: number = 1; test('selected', () => { if (value !== 1) throw Error('wrong'); });
    test('not-selected', () => { throw Error('must not run'); });`, 'ts');
  const result = run(t, ['--typescript', '--test-name-pattern=^selected$', file]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.diagnostics.includes('selected'));
  assert.ok(!result.diagnostics.includes('must not run'));
});

test('invalid runner options remain failures with diagnostics', t => {
  const result = run(t, ['--not-a-real-node-option']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /bad option/);
});

test('SIGTERM terminates an already-running test process', async t => {
  const file = fixture(t, '');
  const ready = join(dirname(file), 'ready');
  writeFileSync(file, `import test from 'node:test'; import { writeFileSync } from 'node:fs';
    test('waiting', async () => { writeFileSync(${JSON.stringify(ready)}, String(process.pid));
      await new Promise(resolve => setTimeout(resolve, 30000)); });`);
  const child = spawn(process.execPath, [runner, file], { stdio: ['ignore', 'pipe', 'pipe'], env });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  const closed = new Promise((resolve, reject) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
    child.once('error', reject);
  });
  const deadline = Date.now() + 5000;
  while (!existsSync(ready) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(existsSync(ready), 'test process must have started before cancellation');
  const testPid = Number(readFileSync(ready, 'utf8'));
  child.kill('SIGTERM');
  let timer;
  const result = await Promise.race([closed, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('cancellation timed out')), 5000);
  })]).finally(() => clearTimeout(timer));
  const log = output.match(/Full test diagnostics: (.+)/)?.[1];
  if (log) rmSync(dirname(log), { recursive: true, force: true });
  assert.equal(result.signal, 'SIGTERM');
  assert.throws(() => process.kill(testPid, 0), { code: 'ESRCH' });
});
