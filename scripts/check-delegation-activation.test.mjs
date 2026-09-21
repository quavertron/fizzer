import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const revision = 'a'.repeat(40);
const record = {
  revision,
  desktopRunners: 'verified',
  existingGenericProcesses: 'drained',
  externalClients: 'verified',
  evidence: 'https://example.test/review/123',
};
const run = (activation, rev = revision) => spawnSync(process.execPath,
  ['scripts/check-delegation-activation.mjs'], {
    env: { ...process.env, REVISION: rev, DELEGATION_ACTIVATION: activation }, encoding: 'utf8',
  });

test('default production push is blocked without a reviewed migration record', () => {
  for (const value of ['', 'invalid', 'null', '{}']) {
    const result = run(value);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Backend activation blocked/);
  }
});

test('stale revision and incomplete migration cannot activate enforcement', () => {
  for (const field of Object.keys(record)) {
    assert.equal(run(JSON.stringify({ ...record, [field]: '' })).status, 1, field);
  }
  assert.equal(run(JSON.stringify(record), 'b'.repeat(40)).status, 1);
  assert.equal(run(JSON.stringify({ ...record, revision: 'invalid' }), 'invalid').status, 1);
  assert.equal(run(JSON.stringify({ ...record, existingGenericProcesses: 'provisioned' })).status, 1);
  assert.equal(run(JSON.stringify({ ...record, desktopRunners: 'built' })).status, 1);
});

test('exact revision with all migration evidence opens the gate', () => {
  const result = run(JSON.stringify(record));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /migration attested/);
});

test('every production trigger passes the gate before credentials or deployment', () => {
  const workflow = readFileSync('.github/workflows/deploy-production.yml', 'utf8');
  const gate = workflow.indexOf('      - name: Require reviewed delegation migration');
  assert.ok(gate > 0);
  assert.ok(gate < workflow.indexOf('      - name: Configure pinned deploy identity'));
  const step = workflow.slice(gate, workflow.indexOf('      - name: Configure pinned deploy identity'));
  assert.doesNotMatch(step, /\bif:|continue-on-error:/);
  assert.match(step, /REVISION: \$\{\{ github.event.workflow_run.head_sha \|\| github.sha \}\}/);
  assert.match(step, /DELEGATION_ACTIVATION: \$\{\{ vars.DELEGATION_ACTIVATION \}\}/);
  assert.match(step, /run: node scripts\/check-delegation-activation.mjs/);
});
