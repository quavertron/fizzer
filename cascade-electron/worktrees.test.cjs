'use strict';

/**
 * Exercises the workspace manager against real git repositories in a temp dir —
 * the safety rules (dirty / unpushed / primary checkout) are the whole point of
 * the module, and mocking git would test the mock instead.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-wt-'));
process.env.CASCADE_WORKTREE_ROOT = path.join(scratch, 'workspaces');

const wt = require('./worktrees.cjs');

function makeRepo(name) {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  const g = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  g('init', '-b', 'main');
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo\n');
  g('add', '.');
  g('commit', '-m', 'init');
  return dir;
}

test('slugs are restricted, not silently mangled into odd paths', () => {
  assert.equal(wt.normalizeSlug('Native PRs'), 'native-prs');
  assert.equal(wt.normalizeSlug('  ../escape  '), 'escape');
  assert.equal(wt.normalizeSlug('!!!'), null);
  assert.equal(wt.normalizeSlug(''), null);
});

test('non-repositories are reported rather than treated as a repo', async () => {
  const plain = path.join(scratch, 'not-a-repo');
  fs.mkdirSync(plain, { recursive: true });
  const repo = await wt.resolveRepo(plain);
  assert.equal(repo.isRepo, false);
  const listed = await wt.listWorkspaces(plain);
  assert.equal(listed.ok, false);
});

test('creates an isolated workspace on its own branch, outside the checkout', async () => {
  const repo = makeRepo('alpha');
  const created = await wt.createWorkspace({ dir: repo, slug: 'Native PRs', channelId: 'chan-1' });
  assert.equal(created.ok, true, created.error);
  assert.equal(created.branch, 'cascade/native-prs');
  assert.equal(created.baseBranch, 'main');
  assert.ok(created.path.startsWith(process.env.CASCADE_WORKTREE_ROOT));
  assert.ok(fs.existsSync(path.join(created.path, 'README.md')));

  // Editing the workspace must not touch the primary checkout.
  fs.writeFileSync(path.join(created.path, 'README.md'), '# changed\n');
  assert.equal(fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), '# repo\n');

  const dup = await wt.createWorkspace({ dir: repo, slug: 'native-prs' });
  assert.equal(dup.ok, false);
  assert.match(dup.error, /already exists/);

  const listed = await wt.listWorkspaces(repo);
  assert.equal(listed.ok, true);
  assert.equal(listed.workspaces.length, 2);
  const managed = listed.workspaces.find((w) => w.managed);
  assert.equal(managed.branch, 'cascade/native-prs');
  assert.equal(managed.channelId, 'chan-1');
  assert.equal(listed.workspaces.find((w) => w.isPrimary).managed, false);
});

test('listing uses the first normalized registry match and leaves unmanaged worktrees unowned', async (t) => {
  const repo = makeRepo('listing');
  const managedPath = path.join(scratch, 'listing-managed');
  const unmanagedPath = path.join(scratch, 'listing-unmanaged');
  execFileSync('git', ['worktree', 'add', '-b', 'managed', managedPath], { cwd: repo, stdio: 'pipe' });
  execFileSync('git', ['worktree', 'add', '--detach', unmanagedPath], { cwd: repo, stdio: 'pipe' });

  const file = path.join(wt.workspacesRoot(), 'workspaces.json');
  fs.mkdirSync(wt.workspacesRoot(), { recursive: true });
  const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  t.after(() => previous === null ? fs.rmSync(file) : fs.writeFileSync(file, previous));
  const first = {
    path: `${path.relative(process.cwd(), managedPath)}/../listing-managed/.`,
    channelId: 'first-channel',
    workItemId: 'first-item',
    baseBranch: 'main',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  fs.writeFileSync(file, JSON.stringify([
    first,
    { path: managedPath, channelId: 'last-channel', workItemId: 'last-item', baseBranch: 'other', createdAt: 'later' },
  ]));

  const listed = await wt.listWorkspaces(managedPath);
  const unowned = { managed: false, channelId: null, workItemId: null, baseBranch: null, createdAt: null, exists: true };
  assert.deepEqual(listed, {
    ok: true,
    repo: 'listing',
    primaryRoot: repo,
    workspaces: [
      { path: repo, branch: 'main', isPrimary: true, ...unowned },
      {
        path: managedPath, branch: 'managed', isPrimary: false, managed: true,
        channelId: first.channelId, workItemId: first.workItemId,
        baseBranch: first.baseBranch, createdAt: first.createdAt, exists: true,
      },
      { path: unmanagedPath, branch: '(detached)', isPrimary: false, ...unowned },
    ],
  });
});

test('prepares one exact task branch and recovers it idempotently by work item', async () => {
  const repo = makeRepo('mission-owned');
  const branch = 'cascade/mission-123/fix-renderer-task-9';
  const first = await wt.prepareWorkspace({
    dir: repo,
    branch,
    channelId: 'chan-mission',
    workItemId: 'work-item-9',
  });
  assert.equal(first.ok, true, first.error);
  assert.equal(first.resumed, undefined);
  assert.equal(first.branch, branch);
  assert.equal(first.repository, repo);
  assert.ok(first.baseCommit);

  const recovered = await wt.prepareWorkspace({
    // Recovery is registry-owned and does not depend on the stale server path.
    dir: path.join(repo, 'missing-old-path'),
    branch,
    channelId: 'chan-mission',
    workItemId: 'work-item-9',
  });
  assert.equal(recovered.ok, true, recovered.error);
  assert.equal(recovered.resumed, true);
  assert.equal(recovered.path, first.path);
  assert.equal(recovered.baseCommit, first.baseCommit);

  const hijack = await wt.prepareWorkspace({
    dir: repo,
    branch,
    workItemId: 'different-work-item',
  });
  assert.equal(hijack.ok, false);
  assert.match(hijack.error, /owned by another workspace|already exists/);
});

test('mission worktrees start from current HEAD, not a stale local master', async () => {
  const repo = makeRepo('stale-master');
  execFileSync('git', ['branch', 'master'], { cwd: repo, stdio: 'pipe' });
  execFileSync('git', ['checkout', '-b', 'fizzer-main'], { cwd: repo, stdio: 'pipe' });
  fs.writeFileSync(path.join(repo, 'README.md'), '# current\n');
  execFileSync('git', ['commit', '-am', 'current work'], { cwd: repo, stdio: 'pipe' });
  const current = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
  const master = execFileSync('git', ['rev-parse', 'master'], { cwd: repo }).toString().trim();
  assert.notEqual(current, master);

  const created = await wt.createWorkspace({ dir: repo, slug: 'artifact' });
  assert.equal(created.ok, true, created.error);
  assert.equal(created.baseCommit, current);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: created.path }).toString().trim();
  assert.equal(head, current);
});

test('child workspaces use the requested worktree tip on creation and empty resume', async () => {
  const repo = makeRepo('parent-tip');
  const parent = await wt.createWorkspace({ dir: repo, slug: 'parent-tip' });
  const g = (...args) => execFileSync('git', args, { cwd: parent.path, stdio: 'pipe' }).toString().trim();
  fs.writeFileSync(path.join(parent.path, 'README.md'), '# parent change\n');
  g('commit', '-am', 'parent change');
  const options = { dir: parent.path, branch: 'cascade/parent-tip-child', workItemId: 'parent-tip-child' };
  const child = await wt.prepareWorkspace(options);
  assert.equal(child.ok, true, child.error);
  assert.equal(child.baseCommit, g('rev-parse', 'HEAD'));

  fs.writeFileSync(path.join(parent.path, 'README.md'), '# newer parent change\n');
  g('commit', '-am', 'newer parent change');
  const resumed = await wt.prepareWorkspace(options);
  assert.equal(resumed.ok, true, resumed.error);
  assert.equal(resumed.rebased, true);
  assert.equal(resumed.baseCommit, g('rev-parse', 'HEAD'));
  assert.equal(fs.readFileSync(path.join(child.path, 'README.md'), 'utf8'), '# newer parent change\n');
  assert.equal(fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), '# repo\n');

  fs.writeFileSync(path.join(child.path, 'worker.txt'), 'uncommitted worker progress\n');
  fs.writeFileSync(path.join(parent.path, 'README.md'), '# final parent change\n');
  g('commit', '-am', 'final parent change');
  const busy = await wt.prepareWorkspace(options);
  assert.equal(busy.ok, true, busy.error);
  assert.equal(busy.rebased, false);
  assert.equal(busy.baseCommit, resumed.baseCommit);
  assert.equal(fs.readFileSync(path.join(child.path, 'worker.txt'), 'utf8'), 'uncommitted worker progress\n');
});

test('unused prepared worktrees move onto current HEAD instead of staying misbased', async () => {
  const repo = makeRepo('rebase-empty');
  const branch = 'cascade/mission-a/task-1';
  const first = await wt.prepareWorkspace({
    dir: repo,
    branch,
    workItemId: 'work-item-stale',
  });
  assert.equal(first.ok, true, first.error);

  fs.writeFileSync(path.join(repo, 'README.md'), '# moved\n');
  execFileSync('git', ['commit', '-am', 'move primary'], { cwd: repo, stdio: 'pipe' });
  const current = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
  assert.notEqual(first.baseCommit, current);

  const prepared = await wt.prepareWorkspace({
    dir: repo,
    branch,
    workItemId: 'work-item-stale',
  });
  assert.equal(prepared.ok, true, prepared.error);
  assert.equal(prepared.rebased, true);
  assert.equal(prepared.baseCommit, current);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: prepared.path }).toString().trim();
  assert.equal(head, current);
});

test('prepared worktrees with worker commits keep their original base', async () => {
  const repo = makeRepo('keep-base');
  const branch = 'cascade/mission-b/task-1';
  const first = await wt.prepareWorkspace({
    dir: repo,
    branch,
    workItemId: 'work-item-busy',
  });
  assert.equal(first.ok, true, first.error);
  fs.writeFileSync(path.join(first.path, 'worker.txt'), 'edits\n');
  execFileSync('git', ['add', 'worker.txt'], { cwd: first.path, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'worker progress'], { cwd: first.path, stdio: 'pipe' });

  fs.writeFileSync(path.join(repo, 'README.md'), '# later primary\n');
  execFileSync('git', ['commit', '-am', 'later primary'], { cwd: repo, stdio: 'pipe' });

  const prepared = await wt.prepareWorkspace({
    dir: repo,
    branch,
    workItemId: 'work-item-busy',
  });
  assert.equal(prepared.ok, true, prepared.error);
  assert.equal(prepared.rebased, false);
  assert.equal(prepared.baseCommit, first.baseCommit);
});

test('status separates uncommitted changes from unpushed commits', async () => {
  const repo = makeRepo('beta');
  const created = await wt.createWorkspace({ dir: repo, slug: 'work' });
  fs.writeFileSync(path.join(created.path, 'new.txt'), 'hello\n');

  const dirty = await wt.workspaceStatus(created.path);
  assert.equal(dirty.ok, true);
  assert.equal(dirty.dirty, true);
  assert.equal(dirty.isPrimary, false);
  assert.deepEqual(dirty.changedFiles.map((f) => f.path), ['new.txt']);
  assert.equal(dirty.commits.length, 0);

  execFileSync('git', ['add', '.'], { cwd: created.path });
  execFileSync('git', ['commit', '-m', 'add new file'], { cwd: created.path });

  const committed = await wt.workspaceStatus(created.path);
  assert.equal(committed.dirty, false);
  assert.equal(committed.commits.length, 1);
  assert.equal(committed.commits[0].subject, 'add new file');
  assert.equal(committed.unpushed, 1);
  assert.equal(committed.branch, 'cascade/work');

  const primary = await wt.workspaceStatus(repo);
  assert.equal(primary.isPrimary, true);
});

test('review evidence is base-relative across commits, edits, and untracked files', async () => {
  const repo = makeRepo('review-evidence');
  const created = await wt.createWorkspace({ dir: repo, slug: 'review' });
  fs.writeFileSync(path.join(created.path, 'README.md'), '# committed\n');
  execFileSync('git', ['add', 'README.md'], { cwd: created.path });
  execFileSync('git', ['commit', '-m', 'committed edit'], { cwd: created.path });
  fs.writeFileSync(path.join(created.path, 'README.md'), '# working tree\n');
  fs.writeFileSync(path.join(created.path, 'notes.txt'), 'untracked review note\n');

  const evidence = await wt.workspaceDiff(created.path);
  assert.equal(evidence.ok, true, evidence.error);
  assert.equal(evidence.baseCommit, created.baseCommit);
  assert.deepEqual(evidence.files.map((file) => file.path).sort(), ['README.md', 'notes.txt']);

  const tracked = await wt.workspaceFileDiff({ dir: created.path, file: 'README.md' });
  assert.equal(tracked.ok, true, tracked.error);
  assert.equal(tracked.kind, 'patch');
  assert.match(tracked.text, /\+\# working tree/);

  const untracked = await wt.workspaceFileDiff({ dir: created.path, file: 'notes.txt' });
  assert.equal(untracked.ok, true, untracked.error);
  assert.equal(untracked.kind, 'text');
  assert.equal(untracked.text, 'untracked review note\n');

  const escaped = await wt.workspaceFileDiff({ dir: created.path, file: '../README.md' });
  assert.equal(escaped.ok, false);
  assert.match(escaped.error, /inside the workspace|not changed/);
  const unchanged = await wt.workspaceFileDiff({ dir: created.path, file: 'not-changed.txt' });
  assert.equal(unchanged.ok, false);
  assert.match(unchanged.error, /not changed/);
});

test('removal refuses to discard work, and never touches the primary checkout', async () => {
  const repo = makeRepo('gamma');
  const created = await wt.createWorkspace({ dir: repo, slug: 'risky' });
  fs.writeFileSync(path.join(created.path, 'draft.txt'), 'unsaved\n');

  const dirtyRemove = await wt.removeWorkspace({ dir: created.path });
  assert.equal(dirtyRemove.ok, false);
  assert.equal(dirtyRemove.needsForce, true);
  assert.ok(fs.existsSync(created.path));

  execFileSync('git', ['add', '.'], { cwd: created.path });
  execFileSync('git', ['commit', '-m', 'work'], { cwd: created.path });

  const unpushedRemove = await wt.removeWorkspace({ dir: created.path });
  assert.equal(unpushedRemove.ok, false);
  assert.match(unpushedRemove.error, /only here/);

  const primaryRemove = await wt.removeWorkspace({ dir: repo, force: true });
  assert.equal(primaryRemove.ok, false);
  assert.match(primaryRemove.error, /primary checkout/);
  assert.ok(fs.existsSync(path.join(repo, 'README.md')));

  const forced = await wt.removeWorkspace({ dir: created.path, force: true });
  assert.equal(forced.ok, true, forced.error);
  assert.equal(fs.existsSync(created.path), false);
  const listed = await wt.listWorkspaces(repo);
  assert.equal(listed.workspaces.filter((w) => w.managed).length, 0);
});

test('a clean workspace with no commits cannot open a pull request', async () => {
  const repo = makeRepo('delta');
  const created = await wt.createWorkspace({ dir: repo, slug: 'empty' });
  const pr = await wt.createPullRequest({ dir: created.path, title: 'nope' });
  assert.equal(pr.ok, false);
  assert.match(pr.error, /commit something/);
});

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

// Age a workspace the way time does: both the directory mtime and the registry
// row's createdAt. pruneWorkspaces treats the later of the two as last activity.
function ageWorkspace(dir, ms) {
  const when = new Date(Date.now() - ms);
  fs.utimesSync(dir, when, when);
  const file = path.join(wt.workspacesRoot(), 'workspaces.json');
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const row of rows) if (row.path === dir) row.createdAt = when.toISOString();
  fs.writeFileSync(file, `${JSON.stringify(rows, null, 2)}\n`);
}

test('prune removes finished workspaces and refuses to touch live work', async () => {
  const repo = makeRepo('prune');
  const stale = await wt.createWorkspace({ dir: repo, slug: 'stale' });
  const dirty = await wt.createWorkspace({ dir: repo, slug: 'dirty' });
  const unpushed = await wt.createWorkspace({ dir: repo, slug: 'unpushed' });
  const fresh = await wt.createWorkspace({ dir: repo, slug: 'fresh' });

  fs.writeFileSync(path.join(dirty.path, 'scratch.txt'), 'work in progress\n');

  fs.writeFileSync(path.join(unpushed.path, 'README.md'), '# local only\n');
  execFileSync('git', ['add', '.'], { cwd: unpushed.path });
  execFileSync('git', ['commit', '-m', 'local only'], { cwd: unpushed.path });

  // Age everything except `fresh` past the cutoff.
  for (const dir of [stale.path, dirty.path, unpushed.path]) ageWorkspace(dir, 30 * 24 * 60 * 60 * 1000);

  const preview = await wt.pruneWorkspaces({ maxAgeMs: 24 * 60 * 60 * 1000, dryRun: true });
  assert.ok(preview.removed.some((entry) => entry.path === stale.path));
  assert.equal(fs.existsSync(stale.path), true, 'dry run must not delete anything');

  const pruned = await wt.pruneWorkspaces({ maxAgeMs: 24 * 60 * 60 * 1000 });
  assert.ok(pruned.removed.some((entry) => entry.path === stale.path));
  assert.equal(fs.existsSync(stale.path), false);

  // Other tests share the registry, so only assert on this repo's workspaces.
  const mine = new Set([stale.path, dirty.path, unpushed.path, fresh.path]);
  const keptPaths = pruned.kept.map((entry) => entry.path).filter((p) => mine.has(p)).sort();
  assert.deepEqual(keptPaths, [dirty.path, fresh.path, unpushed.path].sort());
  assert.equal(fs.existsSync(dirty.path), true);
  assert.equal(fs.existsSync(unpushed.path), true);
  assert.equal(fs.existsSync(fresh.path), true);
  assert.match(pruned.kept.find((e) => e.path === dirty.path).reason, /uncommitted/);
  assert.match(pruned.kept.find((e) => e.path === unpushed.path).reason, /exist only here/);
  assert.match(pruned.kept.find((e) => e.path === fresh.path).reason, /recently active/);
});

test('prune keeps a workspace that is currently in use and forgets vanished rows', async () => {
  const repo = makeRepo('prune-inuse');
  const busy = await wt.createWorkspace({ dir: repo, slug: 'busy' });
  const gone = await wt.createWorkspace({ dir: repo, slug: 'gone' });

  ageWorkspace(busy.path, 30 * 24 * 60 * 60 * 1000);

  // Simulate a worktree deleted out from under the registry.
  execFileSync('git', ['worktree', 'remove', '--force', gone.path], { cwd: repo });

  const pruned = await wt.pruneWorkspaces({ maxAgeMs: 24 * 60 * 60 * 1000, keepPaths: [busy.path] });
  assert.equal(fs.existsSync(busy.path), true);
  assert.equal(pruned.kept.find((entry) => entry.path === busy.path).reason, 'in use');
  assert.ok(pruned.forgotten.includes(gone.path));
});

test('prune with force clears dirty and unpushed workspaces but keeps their branches', async () => {
  const repo = makeRepo('prune-force');
  const dirty = await wt.createWorkspace({ dir: repo, slug: 'force-dirty' });
  const unpushed = await wt.createWorkspace({ dir: repo, slug: 'force-unpushed' });

  fs.writeFileSync(path.join(dirty.path, 'scratch.txt'), 'work in progress\n');
  fs.writeFileSync(path.join(unpushed.path, 'README.md'), '# local only\n');
  execFileSync('git', ['add', '.'], { cwd: unpushed.path });
  execFileSync('git', ['commit', '-m', 'local only'], { cwd: unpushed.path });
  const kept = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: unpushed.path }).toString().trim();

  for (const dir of [dirty.path, unpushed.path]) ageWorkspace(dir, 30 * 24 * 60 * 60 * 1000);

  // Without force both refuse.
  const refused = await wt.pruneWorkspaces({ maxAgeMs: 24 * 60 * 60 * 1000, dryRun: true });
  const refusedMine = refused.kept.filter((e) => [dirty.path, unpushed.path].includes(e.path));
  assert.equal(refusedMine.length, 2);

  const pruned = await wt.pruneWorkspaces({ maxAgeMs: 24 * 60 * 60 * 1000, force: true });
  const removedPaths = pruned.removed.map((e) => e.path);
  assert.ok(removedPaths.includes(dirty.path));
  assert.ok(removedPaths.includes(unpushed.path));
  assert.equal(fs.existsSync(dirty.path), false);
  assert.equal(fs.existsSync(unpushed.path), false);

  // The checkout is gone; the commit is still reachable in the primary repo.
  const stillThere = execFileSync('git', ['rev-parse', 'cascade/force-unpushed'], { cwd: repo }).toString().trim();
  assert.equal(stillThere, kept);
});
