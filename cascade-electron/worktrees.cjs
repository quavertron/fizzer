'use strict';

/**
 * @file worktrees.cjs — task workspaces (git worktrees) and pull requests
 *
 * Cascade runs several agents at once against the same repository. Sharing one
 * checkout means they overwrite each other's edits, so a channel can instead be
 * bound to an **isolated task workspace**: a git worktree on its own branch,
 * created and tracked here in the main process.
 *
 * Design constraints (see the vault note "Cascade-native parallel workspaces
 * and pull requests"):
 *  - The worktree is a host-local materialization. The durable record is the
 *    metadata registry in {@link workspacesRoot}, not anything written into the
 *    working tree (an untracked marker file would show up as a dirty repo).
 *  - Publishing is always explicit. Nothing here pushes or opens a PR unless
 *    the caller asked for it.
 *  - Cleanup never destroys work: a workspace with uncommitted changes or
 *    commits that exist on no remote is refused unless `force` is passed, and
 *    the repository's primary checkout is never removable.
 *
 * Every git/gh call goes through execFile with an argument array — no shell, so
 * branch names and paths cannot be injected into a command line.
 *
 * @module cascade-electron/worktrees
 */

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const GIT_TIMEOUT_MS = 20000;
const GH_TIMEOUT_MS = 60000;
const REGISTRY_FILE = 'workspaces.json';
const MAX_REVIEW_TEXT_BYTES = 512 * 1024;
/** How long a managed workspace may sit untouched before prune offers it up. */
const WORKSPACE_MAX_IDLE_MS = 3 * 24 * 60 * 60 * 1000;

/** Root for Cascade-managed worktrees. Overridable for tests. */
function workspacesRoot() {
  return process.env.CASCADE_WORKTREE_ROOT
    || path.join(os.homedir(), '.cascade', 'worktrees');
}

function run(file, args, cwd, timeout = GIT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
        // Preserve leading spaces: porcelain status uses them for the index /
        // worktree columns, and diff context lines begin with one by design.
        stdout: String(stdout || '').trimEnd(),
        stderr: String(stderr || '').trim() || (error ? String(error.message) : ''),
      });
    });
  });
}

const git = (args, cwd) => run('git', args, cwd);
const gh = (args, cwd) => run('gh', args, cwd, GH_TIMEOUT_MS);

/**
 * Branch/directory name for a workspace. Slugs are the only user-controlled
 * part of a path we create, so they are restricted rather than sanitized: a
 * rejected slug is easier to explain than a surprising directory.
 */
function normalizeSlug(input) {
  const slug = String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) return null;
  return slug;
}

function readRegistry() {
  const file = path.join(workspacesRoot(), REGISTRY_FILE);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeRegistry(entries) {
  const root = workspacesRoot();
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, REGISTRY_FILE), `${JSON.stringify(entries, null, 2)}\n`);
}

function rememberWorkspace(entry) {
  const entries = readRegistry().filter((e) => e.path !== entry.path);
  entries.push(entry);
  writeRegistry(entries);
}

function forgetWorkspace(target) {
  writeRegistry(readRegistry().filter((e) => e.path !== target));
}

/** Resolve a directory to its repository root, plus current branch/head. */
async function resolveRepo(dir) {
  const expanded = expandHome(dir);
  if (!expanded || !fs.existsSync(expanded)) return { isRepo: false, error: 'Directory does not exist' };
  const top = await git(['rev-parse', '--show-toplevel'], expanded);
  if (!top.ok) return { isRepo: false, error: 'Not a git repository' };
  const root = top.stdout;
  const [branch, head, common] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD'], root),
    // Review annotations bind to an exact snapshot, so keep the full object id;
    // renderers may shorten it for display.
    git(['rev-parse', 'HEAD'], root),
    git(['rev-parse', '--path-format=absolute', '--git-common-dir'], root),
  ]);
  // In a worktree the common dir points at the primary checkout's .git, which
  // is how we tell "this is the main checkout" from "this is a worktree".
  const primaryRoot = common.ok ? path.dirname(common.stdout) : root;
  return {
    isRepo: true,
    root,
    name: path.basename(primaryRoot),
    branch: branch.ok ? branch.stdout : '',
    head: head.ok ? head.stdout : '',
    primaryRoot,
    isPrimary: path.resolve(primaryRoot) === path.resolve(root),
  };
}

function expandHome(dir) {
  const value = String(dir || '').trim();
  if (!value) return '';
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

/** Default integration branch: origin's HEAD, else main/master, else current. */
async function defaultBaseBranch(root) {
  const remote = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], root);
  if (remote.ok && remote.stdout) return remote.stdout.replace(/^origin\//, '');
  for (const candidate of ['main', 'master']) {
    const exists = await git(['rev-parse', '--verify', '--quiet', candidate], root);
    if (exists.ok) return candidate;
  }
  const current = await git(['rev-parse', '--abbrev-ref', 'HEAD'], root);
  return current.ok ? current.stdout : 'HEAD';
}

/** Live checkout tip — not a possibly stale local master/main ref. */
async function currentStartCommit(root) {
  return git(['rev-parse', 'HEAD'], root);
}

/**
 * Status of one workspace: what changed, what is committed but unpushed, and
 * whether the base has moved on underneath it.
 */
async function workspaceStatus(dir) {
  const repo = await resolveRepo(dir);
  if (!repo.isRepo) return { ok: false, error: repo.error || 'Not a git repository' };

  const entry = readRegistry().find((e) => path.resolve(e.path) === path.resolve(repo.root));
  const baseRef = entry?.baseBranch || await defaultBaseBranch(repo.root);
  const baseCommit = entry?.baseCommit || '';

  const range = `${baseCommit || baseRef}...HEAD`;
  const [statusOut, upstream, logOut, baseDiffOut] = await Promise.all([
    git(['status', '--porcelain'], repo.root),
    git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], repo.root),
    git(['log', '--oneline', '--no-decorate', '-n', '25', `${baseCommit || baseRef}..HEAD`], repo.root),
    git(['diff', '--name-status', range], repo.root),
  ]);

  const workingFiles = statusOut.ok && statusOut.stdout
    ? statusOut.stdout.split('\n').map((line) => ({
      status: line.slice(0, 2).trim(),
      path: line.slice(3),
    }))
    : [];
  // Base-relative changes include committed work; merge the working tree so a
  // mission does not look empty merely because its agent committed.
  const baseFiles = baseDiffOut.ok && baseDiffOut.stdout
    ? baseDiffOut.stdout.split('\n').map((line) => {
      const [status, ...paths] = line.split('\t');
      return { status, path: paths.at(-1) || '' };
    }).filter((file) => file.path)
    : [];
  // Prefer the base-relative classification (for example A over a later
  // working-tree M); retain working-only entries such as untracked files.
  const changedFiles = [...new Map([...workingFiles, ...baseFiles].map((file) => [file.path, file])).values()];
  const commits = logOut.ok && logOut.stdout
    ? logOut.stdout.split('\n').map((line) => {
      const [sha, ...rest] = line.split(' ');
      return { sha, subject: rest.join(' ') };
    })
    : [];

  // Unpushed = committed here but on no remote branch. That is the state that
  // makes deleting a worktree lossy, so it is computed explicitly.
  let unpushed = commits.length;
  if (upstream.ok && upstream.stdout) {
    const counts = await git(['rev-list', '--left-right', '--count', `${upstream.stdout}...HEAD`], repo.root);
    if (counts.ok) unpushed = Number(counts.stdout.split(/\s+/)[1] || 0);
  }

  let behindBase = 0;
  if (baseRef) {
    const counts = await git(['rev-list', '--left-right', '--count', `${baseRef}...HEAD`], repo.root);
    if (counts.ok) behindBase = Number(counts.stdout.split(/\s+/)[0] || 0);
  }

  return {
    ok: true,
    path: repo.root,
    repo: repo.name,
    branch: repo.branch,
    head: repo.head,
    isPrimary: repo.isPrimary,
    baseBranch: baseRef,
    baseCommit,
    dirty: workingFiles.length > 0,
    changedFiles,
    commits,
    unpushed,
    behindBase,
    hasUpstream: Boolean(upstream.ok && upstream.stdout),
  };
}

function clipReviewText(value) {
  const buffer = Buffer.from(String(value || ''), 'utf8');
  if (buffer.length <= MAX_REVIEW_TEXT_BYTES) return { text: buffer.toString('utf8'), truncated: false };
  return {
    text: `${buffer.subarray(0, MAX_REVIEW_TEXT_BYTES).toString('utf8')}\n\n[Diff truncated by Cascade]`,
    truncated: true,
  };
}

/**
 * Base-relative file inventory for local review. The immutable base commit
 * recorded when Cascade prepared the worktree is preferred over a moving
 * branch ref, so a reviewer sees the same comparison the task owns.
 */
async function workspaceDiff(dir) {
  const status = await workspaceStatus(dir);
  if (!status.ok) return status;
  if (!status.baseCommit) return { ok: false, error: 'Workspace has no recorded base commit' };

  const shortStat = await git(['diff', '--shortstat', '--no-ext-diff', status.baseCommit, '--'], status.path);
  const untracked = status.changedFiles.filter((file) => file.status === '??').length;
  const summary = [
    shortStat.ok ? shortStat.stdout : '',
    untracked ? `${untracked} untracked file${untracked === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' · ');
  return {
    ok: true,
    path: status.path,
    repo: status.repo,
    branch: status.branch,
    head: status.head,
    baseBranch: status.baseBranch,
    baseCommit: status.baseCommit,
    dirty: status.dirty,
    files: status.changedFiles,
    summary,
  };
}

/** Read one changed file's patch/content without granting arbitrary file IO. */
async function workspaceFileDiff({ dir, file } = {}) {
  const evidence = await workspaceDiff(dir);
  if (!evidence.ok) return evidence;

  const relative = String(file || '').trim();
  if (!relative || path.isAbsolute(relative) || relative.includes('\0')) {
    return { ok: false, error: 'A repository-relative changed file is required' };
  }
  const normalized = path.normalize(relative);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    return { ok: false, error: 'File must stay inside the workspace' };
  }
  const changed = evidence.files.find((item) => item.path === relative);
  if (!changed) return { ok: false, error: 'File is not changed relative to this workspace base' };

  if (changed.status === '??') {
    const absolute = path.resolve(evidence.path, normalized);
    const rootPrefix = `${path.resolve(evidence.path)}${path.sep}`;
    if (!absolute.startsWith(rootPrefix)) return { ok: false, error: 'File must stay inside the workspace' };
    let info;
    try { info = fs.lstatSync(absolute); } catch { return { ok: false, error: 'Changed file no longer exists' }; }
    if (!info.isFile() || info.isSymbolicLink()) {
      return { ok: true, path: relative, status: changed.status, kind: 'binary', text: '', truncated: false };
    }
    const bytesToRead = Math.min(info.size, MAX_REVIEW_TEXT_BYTES + 1);
    const content = Buffer.alloc(bytesToRead);
    const fd = fs.openSync(absolute, 'r');
    try { fs.readSync(fd, content, 0, bytesToRead, 0); } finally { fs.closeSync(fd); }
    if (content.subarray(0, Math.min(content.length, 8000)).includes(0)) {
      return { ok: true, path: relative, status: changed.status, kind: 'binary', text: '', truncated: false };
    }
    const clipped = clipReviewText(content.toString('utf8'));
    return { ok: true, path: relative, status: changed.status, kind: 'text', ...clipped };
  }

  const diff = await git([
    'diff', '--no-color', '--no-ext-diff', '--find-renames', '--unified=4',
    evidence.baseCommit, '--', relative,
  ], evidence.path);
  if (!diff.ok) return { ok: false, error: diff.stderr || 'Could not read file diff' };
  const clipped = clipReviewText(diff.stdout);
  return { ok: true, path: relative, status: changed.status, kind: 'patch', ...clipped };
}

/**
 * Every workspace for a repository: the primary checkout plus each worktree
 * git knows about, annotated with the ones Cascade created.
 */
async function listWorkspaces(dir) {
  const repo = await resolveRepo(dir);
  if (!repo.isRepo) return { ok: false, error: repo.error || 'Not a git repository' };

  const listed = await git(['worktree', 'list', '--porcelain'], repo.primaryRoot);
  if (!listed.ok) return { ok: false, error: listed.stderr || 'git worktree list failed' };

  const registryByPath = new Map();
  for (const entry of readRegistry()) {
    const resolvedPath = path.resolve(entry.path);
    // Preserve the first matching registry row, as Array.find did.
    if (!registryByPath.has(resolvedPath)) registryByPath.set(resolvedPath, entry);
  }
  const primaryRoot = path.resolve(repo.primaryRoot);
  const workspaces = [];
  for (const block of listed.stdout.split('\n\n')) {
    const lines = block.split('\n');
    const line = lines.find((l) => l.startsWith('worktree '));
    if (!line) continue;
    const wtPath = line.slice('worktree '.length).trim();
    const resolvedPath = path.resolve(wtPath);
    const branchLine = lines.find((l) => l.startsWith('branch '));
    const entry = registryByPath.get(resolvedPath);
    workspaces.push({
      path: wtPath,
      branch: branchLine ? branchLine.slice('branch refs/heads/'.length).trim() : '(detached)',
      isPrimary: resolvedPath === primaryRoot,
      managed: Boolean(entry),
      channelId: entry?.channelId || null,
      workItemId: entry?.workItemId || null,
      baseBranch: entry?.baseBranch || null,
      createdAt: entry?.createdAt || null,
      exists: fs.existsSync(wtPath),
    });
  }
  return { ok: true, repo: repo.name, primaryRoot: repo.primaryRoot, workspaces };
}

/**
 * Create an isolated workspace: a new branch off the current base, checked out
 * into a Cascade-managed directory outside the repository.
 */
async function createWorkspace({ dir, slug, branch: requestedBranch, baseBranch, channelId, workItemId } = {}) {
  const repo = await resolveRepo(dir);
  if (!repo.isRepo) return { ok: false, error: repo.error || 'Not a git repository' };

  const name = normalizeSlug(slug);
  if (!name) return { ok: false, error: 'Workspace name must contain letters or numbers' };

  const branch = requestedBranch || `cascade/${name}`;
  if (!branch.startsWith('cascade/')) return { ok: false, error: 'Managed branches must start with cascade/' };
  const branchFormat = await git(['check-ref-format', '--branch', branch], repo.primaryRoot);
  if (!branchFormat.ok) return { ok: false, error: 'Invalid managed branch' };
  const target = path.join(workspacesRoot(), repo.name, name);

  const branchExists = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo.primaryRoot);
  if (branchExists.ok) return { ok: false, error: `Branch ${branch} already exists` };
  if (fs.existsSync(target)) return { ok: false, error: `Workspace directory already exists: ${target}` };

  const base = baseBranch || await defaultBaseBranch(repo.primaryRoot);
  const start = await currentStartCommit(repo.root);
  if (!start.ok || !start.stdout) return { ok: false, error: 'Could not resolve current HEAD' };

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const created = await git(['worktree', 'add', '-b', branch, target, start.stdout], repo.primaryRoot);
  if (!created.ok) return { ok: false, error: created.stderr || 'git worktree add failed' };

  rememberWorkspace({
    path: target,
    repoRoot: repo.primaryRoot,
    sourceRoot: repo.root,
    repo: repo.name,
    branch,
    baseBranch: base,
    baseCommit: start.stdout,
    channelId: channelId || null,
    workItemId: workItemId || null,
    createdAt: new Date().toISOString(),
  });

  return {
    ok: true,
    path: target,
    repository: repo.primaryRoot,
    repo: repo.name,
    branch,
    baseBranch: base,
    baseCommit: start.stdout,
  };
}

/**
 * Prepare or recover the one workspace owned by a durable work item.
 *
 * Unlike the manual create flow, this is idempotent: a desktop reconnect or
 * provider handoff resumes the registry-owned worktree. Existing branches that
 * are not owned by the same work item are refused rather than adopted.
 */
async function prepareWorkspace({ dir, branch, baseBranch, channelId, workItemId } = {}) {
  const itemId = String(workItemId || '').trim();
  const expectedBranch = String(branch || '').trim();
  if (!itemId) return { ok: false, error: 'Work item id is required' };
  if (!expectedBranch.startsWith('cascade/')) {
    return { ok: false, error: 'Managed task branches must start with cascade/' };
  }

  const owned = readRegistry().filter((entry) => entry.workItemId === itemId);
  if (owned.length > 1) return { ok: false, error: 'Work item owns multiple local workspaces' };
  if (owned.length === 1) {
    const entry = owned[0];
    if (!fs.existsSync(entry.path)) {
      return { ok: false, error: `Owned workspace is missing: ${entry.path}` };
    }
    const status = await workspaceStatus(entry.path);
    if (!status.ok) return status;
    if (status.branch !== expectedBranch || entry.branch !== expectedBranch) {
      return { ok: false, error: 'Owned workspace branch does not match the work item' };
    }
    const moved = await rebaseUnusedWorkspace(entry, status);
    if (!moved.ok) return moved;
    return {
      ok: true,
      resumed: true,
      rebased: moved.rebased === true,
      path: status.path,
      repository: entry.repoRoot,
      repo: entry.repo,
      branch: status.branch,
      baseBranch: entry.baseBranch,
      baseCommit: moved.baseCommit,
    };
  }

  const branchCheckDir = expandHome(dir);
  const branchCheck = branchCheckDir && fs.existsSync(branchCheckDir)
    ? await git(['check-ref-format', '--branch', expectedBranch], branchCheckDir)
    : { ok: false };
  if (!branchCheck.ok) return { ok: false, error: 'Invalid managed task branch' };

  const repo = await resolveRepo(dir);
  if (!repo.isRepo) return { ok: false, error: repo.error || 'Not a git repository' };
  const ambiguous = readRegistry().find((entry) => (
    path.resolve(entry.repoRoot) === path.resolve(repo.primaryRoot)
    && entry.branch === expectedBranch
  ));
  if (ambiguous) return { ok: false, error: 'Task branch is already owned by another workspace' };

  const name = normalizeSlug(expectedBranch.slice('cascade/'.length));
  if (!name) return { ok: false, error: 'Managed task branch has no usable workspace name' };
  return createWorkspace({
    dir: repo.root,
    slug: name,
    branch: expectedBranch,
    baseBranch,
    channelId,
    workItemId: itemId,
  });
}

/** Empty worker clones follow the requested source checkout; clones with work stay put. */
async function rebaseUnusedWorkspace(entry, status) {
  const unused = !status.dirty && (status.commits || []).length === 0
    && (!status.head || status.head === entry.baseCommit);
  if (!unused) return { ok: true, rebased: false, baseCommit: entry.baseCommit };

  const repo = await resolveRepo(entry.sourceRoot || entry.repoRoot);
  if (!repo.isRepo) return { ok: false, error: repo.error || 'Source workspace is not a git repository' };
  if (path.resolve(repo.primaryRoot) !== path.resolve(entry.repoRoot)) {
    return { ok: false, error: 'Source workspace belongs to another repository' };
  }
  const start = await currentStartCommit(repo.root);
  if (!start.ok || !start.stdout) return { ok: false, error: 'Could not resolve current HEAD' };
  if (start.stdout === entry.baseCommit) return { ok: true, rebased: false, baseCommit: entry.baseCommit };

  const reset = await git(['reset', '--hard', start.stdout], entry.path);
  if (!reset.ok) return { ok: false, error: reset.stderr || 'Could not move unused workspace onto current HEAD' };

  rememberWorkspace({ ...entry, baseCommit: start.stdout });
  return { ok: true, rebased: true, baseCommit: start.stdout };
}

/**
 * Remove a workspace. Refuses anything that would lose work — uncommitted
 * changes, commits on no remote, or the primary checkout — unless forced.
 */
async function removeWorkspace({ dir, force } = {}) {
  const status = await workspaceStatus(dir);
  if (!status.ok) return { ok: false, error: status.error };
  if (status.isPrimary) return { ok: false, error: 'Refusing to remove the repository’s primary checkout' };
  if (!force && status.dirty) {
    return { ok: false, error: `${status.changedFiles.length} uncommitted change(s) — commit them or remove with force`, needsForce: true };
  }
  if (!force && status.unpushed > 0) {
    return { ok: false, error: `${status.unpushed} commit(s) exist only here — push them or remove with force`, needsForce: true };
  }

  const repo = await resolveRepo(dir);
  const args = ['worktree', 'remove', status.path];
  if (force) args.push('--force');
  const removed = await git(args, repo.primaryRoot);
  if (!removed.ok) return { ok: false, error: removed.stderr || 'git worktree remove failed' };
  forgetWorkspace(status.path);
  return { ok: true, path: status.path, branch: status.branch };
}

/**
 * Remove managed workspaces that are finished with.
 *
 * Nothing ever called {@link removeWorkspace} except a human clicking Remove,
 * so every worktree a mission ever created stayed on disk (each one is a full
 * checkout with its own node_modules). This sweeps them.
 *
 * Safety comes from `removeWorkspace` itself: it is called *without* `force`,
 * so a workspace with uncommitted changes or unpushed commits refuses to go and
 * is reported as kept. A workspace is only offered up when it has also been
 * untouched for `maxAgeMs`, which keeps an idle-but-live task's checkout.
 * Registry rows whose directory has already vanished are simply forgotten.
 *
 * `force` is the deliberate exception: it passes force through to
 * `removeWorkspace`, so dirty and unpushed workspaces go too. Only ever pass it
 * on an explicit human instruction — `git worktree remove` leaves the branch
 * refs behind, so the commits survive in the primary repo, but uncommitted
 * edits do not.
 *
 * @param {{ maxAgeMs?: number, keepPaths?: string[], dryRun?: boolean, force?: boolean }} [opts]
 */
async function pruneWorkspaces({ maxAgeMs = WORKSPACE_MAX_IDLE_MS, keepPaths = [], dryRun = false, force = false } = {}) {
  const keep = new Set((keepPaths || []).map((entry) => path.resolve(expandHome(String(entry || '')))).filter(Boolean));
  const cutoff = Date.now() - Math.max(0, Number(maxAgeMs) || 0);
  const removed = [];
  const kept = [];
  const forgotten = [];

  for (const entry of readRegistry()) {
    const target = String(entry?.path || '');
    if (!target) continue;
    if (!fs.existsSync(target)) {
      if (!dryRun) forgetWorkspace(target);
      forgotten.push(target);
      continue;
    }
    if (keep.has(path.resolve(target))) {
      kept.push({ path: target, reason: 'in use' });
      continue;
    }
    let touchedAt = 0;
    try {
      touchedAt = fs.statSync(target).mtimeMs;
    } catch {
      touchedAt = 0;
    }
    const createdAt = Date.parse(entry?.createdAt || '') || 0;
    if (Math.max(touchedAt, createdAt) > cutoff) {
      kept.push({ path: target, reason: 'recently active' });
      continue;
    }
    if (dryRun) {
      const status = await workspaceStatus(target);
      const blocked = !status.ok
        ? status.error
        : force
          ? ''
          : status.dirty
            ? `${status.changedFiles.length} uncommitted change(s)`
            : status.unpushed > 0
              ? `${status.unpushed} unpushed commit(s)`
              : '';
      if (blocked) kept.push({ path: target, reason: blocked });
      else removed.push({ path: target, branch: status.branch });
      continue;
    }
    const result = await removeWorkspace({ dir: target, force });
    if (result.ok) removed.push({ path: result.path, branch: result.branch });
    else kept.push({ path: target, reason: result.error || 'refused' });
  }

  return { ok: true, removed, kept, forgotten };
}

/**
 * Push the workspace branch and open a pull request through `gh`.
 * Explicit by construction: nothing else in this module pushes.
 */
async function createPullRequest({ dir, title, body, draft = true, baseBranch } = {}) {
  const status = await workspaceStatus(dir);
  if (!status.ok) return { ok: false, error: status.error };
  if (!status.commits.length) return { ok: false, error: 'Nothing to review yet — commit something in this workspace first' };
  if (status.dirty) return { ok: false, error: `${status.changedFiles.length} uncommitted change(s) — commit them before opening a PR` };

  const version = await gh(['--version'], status.path);
  if (!version.ok) return { ok: false, error: 'GitHub CLI (gh) is not available on this machine' };

  const pushed = await run('git', ['push', '-u', 'origin', status.branch], status.path, GH_TIMEOUT_MS);
  if (!pushed.ok) return { ok: false, error: pushed.stderr || 'git push failed' };

  const base = baseBranch || status.baseBranch;
  const args = ['pr', 'create', '--base', base, '--head', status.branch,
    '--title', title || status.commits[0].subject,
    '--body', body || ''];
  if (draft) args.push('--draft');
  const created = await gh(args, status.path);
  if (!created.ok) return { ok: false, error: created.stderr || 'gh pr create failed' };

  const url = (created.stdout.match(/https:\/\/\S+/) || [])[0] || created.stdout;
  return { ok: true, url, branch: status.branch, base, draft };
}

/** Current PR for the workspace branch, if one exists. */
async function pullRequestStatus(dir) {
  const repo = await resolveRepo(dir);
  if (!repo.isRepo) return { ok: false, error: repo.error || 'Not a git repository' };
  const viewed = await gh(
    ['pr', 'view', '--json', 'number,url,title,state,isDraft,mergeable,reviewDecision,statusCheckRollup'],
    repo.root,
  );
  if (!viewed.ok) return { ok: true, pr: null };
  try {
    const pr = JSON.parse(viewed.stdout);
    const checks = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];
    return {
      ok: true,
      pr: {
        number: pr.number,
        url: pr.url,
        title: pr.title,
        state: pr.state,
        isDraft: pr.isDraft,
        mergeable: pr.mergeable,
        reviewDecision: pr.reviewDecision || null,
        checks: {
          total: checks.length,
          failing: checks.filter((c) => ['FAILURE', 'ERROR', 'TIMED_OUT'].includes(c.conclusion)).length,
          pending: checks.filter((c) => !c.conclusion).length,
        },
      },
    };
  } catch {
    return { ok: true, pr: null };
  }
}

module.exports = {
  workspacesRoot,
  normalizeSlug,
  resolveRepo,
  defaultBaseBranch,
  listWorkspaces,
  workspaceStatus,
  workspaceDiff,
  workspaceFileDiff,
  createWorkspace,
  prepareWorkspace,
  removeWorkspace,
  pruneWorkspaces,
  createPullRequest,
  pullRequestStatus,
};
