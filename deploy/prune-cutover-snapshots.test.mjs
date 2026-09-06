import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import Database from 'better-sqlite3';

const script = new URL('./prune-cutover-snapshots.py', import.meta.url).pathname;
const name = day => `cutover-${'a'.repeat(40)}-202609${String(day).padStart(2, '0')}T000000Z`;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fizzer-retention-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (let day = 1; day <= 4; day++) {
    const directory = path.join(root, name(day));
    fs.mkdirSync(path.join(directory, 'corpus/vaults'), { recursive: true });
    fs.mkdirSync(path.join(directory, 'corpus/qmd'));
    fs.writeFileSync(path.join(directory, 'corpus/vaults/note.md'), `day ${day}`);
    const db = new Database(path.join(directory, 'docs.db'));
    db.exec(`CREATE TABLE note(body TEXT); INSERT INTO note VALUES ('day ${day}')`);
    db.close();
    fs.writeFileSync(path.join(directory, 'docs.db.sha256'), `${crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, 'docs.db'))).digest('hex')}  docs.db\n`);
    fs.writeFileSync(path.join(directory, 'revision.txt'), `${'a'.repeat(40)}\n`);
  }
  return root;
}
function run(root, ...args) {
  const result = spawnSync('python3', [script, root, ...args], { encoding: 'utf8', env: { ...process.env, CASCADE_DEPLOY_LOCK_HELD: '1' } });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('dry run preserves all bytes; repeated successful cleanup keeps two complete recovery points', t => {
  const root = fixture(t);
  assert.equal(run(root).removed.length, 2);
  assert.equal(fs.readdirSync(root).length, 4);
  const result = run(root, '--apply');
  assert.deepEqual(result.retained, [name(4), name(3)]);
  assert.deepEqual(fs.readdirSync(root).sort(), [name(3), name(4)]);
  assert.ok(result.removed_allocated_bytes > 0);
  assert.deepEqual(run(root, '--apply').removed, []);
  for (const day of [3, 4]) {
    const snapshot = path.join(root, name(day));
    const live = path.join(root, `restored-${day}.db`);
    fs.writeFileSync(live, 'candidate data');
    const restored = spawnSync('bash', [new URL('./restore-sqlite-snapshot.sh', import.meta.url).pathname, snapshot, live, 'retention-test'], { encoding: 'utf8' });
    assert.equal(restored.status, 0, restored.stderr);
    const db = new Database(live, { readonly: true });
    assert.equal(db.prepare('SELECT body FROM note').pluck().get(), `day ${day}`);
    db.close();
  }
});

test('corrupt newest, incomplete attempts, protected points, and unrelated files survive', t => {
  const root = fixture(t);
  fs.appendFileSync(path.join(root, name(4), 'docs.db'), 'corruption');
  fs.mkdirSync(path.join(root, name(5)));
  fs.writeFileSync(path.join(root, 'operator-backup'), 'keep');
  const result = run(root, '--apply', '--protect', path.join(root, name(1)));
  assert.deepEqual(result.retained, [name(3), name(2)]);
  assert.deepEqual(result.removed, []);
  assert.equal(fs.readdirSync(root).length, 6);
  assert.equal(result.warnings.length, 2);
});

test('never prunes the sole good recovery point', t => {
  const root = fixture(t);
  for (const day of [2, 3, 4]) fs.unlinkSync(path.join(root, name(day), 'docs.db.sha256'));
  const result = run(root, '--apply');
  assert.deepEqual(result.removed, []);
  assert.equal(fs.readdirSync(root).length, 4);
});

test('creation-time corpus manifest rejects tampering and uncheckpointed WAL', t => {
  const root = fixture(t);
  const newest = path.join(root, name(4));
  run(newest, '--seal');
  fs.appendFileSync(path.join(newest, 'corpus/vaults/note.md'), 'tamper');
  fs.writeFileSync(path.join(root, name(3), 'docs.db-wal'), 'uncheckpointed');
  const result = run(root, '--apply');
  assert.deepEqual(result.retained, [name(2), name(1)]);
  assert.deepEqual(result.removed, []);
  assert.match(result.warnings.join('\n'), /corpus checksum mismatch/);
  assert.match(result.warnings.join('\n'), /uncheckpointed WAL/);
});

test('unsafe removal tree fails the whole plan before any deletion', t => {
  const root = fixture(t);
  fs.symlinkSync('/tmp', path.join(root, name(1), 'outside'));
  const result = spawnSync('python3', [script, root, '--apply'], { encoding: 'utf8', env: { ...process.env, CASCADE_DEPLOY_LOCK_HELD: '1' } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsafe snapshot entry/);
  assert.equal(fs.readdirSync(root).length, 4);
});

test('standalone retention cannot race a held deployment/restore lock', t => {
  const root = fixture(t);
  const result = spawnSync('bash', ['-c', `
    unset CASCADE_DEPLOY_LOCK_HELD
    exec 9<"$1"
    flock 9
    python3 "$2" "$3" --apply
  `, 'test', path.dirname(path.dirname(script)), script, root], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /BlockingIOError/);
  assert.equal(fs.readdirSync(root).length, 4);
});
