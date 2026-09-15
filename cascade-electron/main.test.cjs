const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');

test('desktop startup paints a window before housekeeping and does not HEAD the hosted URL', () => {
  assert.doesNotMatch(source, /\bwaitForAppUrl\b|\bcanReachUrl\b/);
  assert.match(source, /backgroundColor: APP_BACKGROUND/);
  assert.match(source, /createWindow\(\);/);
  const backendAt = source.indexOf('await startEmbeddedBackend(');
  const createAt = source.indexOf('createWindow();', backendAt);
  const reapAt = source.indexOf('void reapOrphanedLocalAgentRuns()');
  const pruneAt = source.indexOf('void worktrees.pruneWorkspaces()');
  assert.ok(backendAt > 0 && createAt > backendAt && reapAt > createAt && pruneAt > createAt);
});

test('desktop navigation and runner helpers are pinned to the main-process instance', () => {
  assert.match(source, /win\.webContents\.on\('will-navigate', guardNavigation\)/);
  assert.match(source, /win\.webContents\.on\('will-redirect', guardNavigation\)/);
  assert.match(source, /isSameOrigin\(apiUrl, INSTANCE_ORIGIN\)/);
  assert.match(source, /connectDesktopRunner\(token, INSTANCE_ORIGIN\)/);
  assert.doesNotMatch(source, /hostname\.endsWith\('\.cscd\.online'\)/);
});

test('desktop opens safe external links in the system browser', () => {
  assert.match(source, /\['http:', 'https:', 'mailto:'\]\.includes\(new URL\(url\)\.protocol\)/);
  assert.match(source, /if \(isSafeExternalUrl\(url\)\) void shell\.openExternal\(url\)/);
  assert.match(source, /setWindowOpenHandler\(\(\{ url \}\) =>/);
});

test('packaged macOS updates download before launching the detached installer', () => {
  const prepareAt = source.indexOf('await prepareMacOSUpdate({');
  const launchAt = source.indexOf('launchMacOSInstaller(update);');
  const quitAt = source.indexOf('setTimeout(() => app.quit(), 250);');
  assert.ok(prepareAt > 0 && launchAt > prepareAt && quitAt > launchAt);
});

test('desktop repairs packaged macOS PATH before loading runner modules', () => {
  const pathAt = source.indexOf('installDesktopShellPath({ packaged: app.isPackaged });');
  const runnerAt = source.indexOf("require('./agent-runner.cjs')");
  assert.ok(pathAt > 0 && runnerAt > pathAt);
});

for (const tracked of [false, true]) {
  test(`source update preserves dirty work and equivalent commits (${tracked ? 'configured upstream' : 'no upstream'})`, async (t) => {
    const { execFileSync, spawn } = require('node:child_process');
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'fizzer-update-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const upstream = path.join(dir, 'upstream');
    const checkout = path.join(dir, 'checkout');
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    fs.mkdirSync(upstream);
    git(upstream, 'init', '-b', 'master');
    const configure = (cwd) => {
      git(cwd, 'config', 'user.email', 'updater@example.test');
      git(cwd, 'config', 'user.name', 'Updater Test');
      git(cwd, 'config', 'commit.gpgsign', 'false');
    };
    configure(upstream);
    fs.writeFileSync(path.join(upstream, '.gitignore'), 'build-output\n');
    fs.writeFileSync(path.join(upstream, 'local.txt'), 'original\n');
    fs.writeFileSync(path.join(upstream, 'package.json'), JSON.stringify({ scripts: {
      build: `node -e "require('fs').writeFileSync('build-output', require('fs').readFileSync('local.txt'))"`,
    } }));
    git(upstream, 'add', '.');
    git(upstream, 'commit', '-m', 'initial');
    git(dir, 'clone', upstream, checkout);
    configure(checkout);
    git(checkout, 'checkout', '--no-track', '-b', 'fizzer-main');
    // A configured non-master upstream must keep winning over the fallback.
    if (tracked) {
      git(upstream, 'checkout', '-b', 'custom');
      git(checkout, 'fetch', 'origin');
      git(checkout, 'branch', '--set-upstream-to=origin/custom');
    }
    for (const [cwd, message] of [[upstream, 'upstream patch'], [checkout, 'equivalent local patch']]) {
      fs.writeFileSync(path.join(cwd, 'equivalent.txt'), 'same patch\n');
      git(cwd, 'add', '.');
      git(cwd, 'commit', '-m', message);
    }
    fs.writeFileSync(path.join(upstream, 'release.txt'), 'new release\n');
    // A pulled release can introduce dependencies absent from the old desktop.
    // Use the shipped prebuild hook with real npm, including a workspace and
    // NODE_ENV=production, without running any native/lifecycle installers.
    fs.appendFileSync(path.join(upstream, '.gitignore'), 'node_modules/\n');
    fs.mkdirSync(path.join(upstream, 'client'));
    fs.mkdirSync(path.join(upstream, 'fixture-dependency'));
    fs.writeFileSync(path.join(upstream, 'fixture-dependency/package.json'), JSON.stringify({
      name: 'update-fixture-dependency', version: '1.0.0', main: 'index.cjs',
      scripts: { install: 'node -e "process.exit(97)"' },
    }));
    fs.writeFileSync(path.join(upstream, 'fixture-dependency/index.cjs'), 'module.exports = "installed";');
    fs.writeFileSync(path.join(upstream, 'client/package.json'), JSON.stringify({
      name: 'update-fixture-client', version: '1.0.0',
      devDependencies: { 'update-fixture-dependency': 'file:../fixture-dependency' },
    }));
    const manifest = JSON.parse(fs.readFileSync(path.join(upstream, 'package.json')));
    manifest.workspaces = ['client'];
    manifest.scripts.prebuild = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'))).scripts.prebuild;
    manifest.scripts.postinstall = 'node -e "process.exit(98)"';
    manifest.scripts.build = `node -e "if(require(require.resolve('update-fixture-dependency',{paths:['./client']}))!=='installed')process.exit(99)" && ${manifest.scripts.build}`;
    fs.writeFileSync(path.join(upstream, 'package.json'), JSON.stringify(manifest));
    git(upstream, 'add', '.');
    git(upstream, 'commit', '-m', 'release');
    fs.writeFileSync(path.join(checkout, 'local.txt'), 'unsaved work\n');
    fs.writeFileSync(path.join(checkout, 'untracked.txt'), 'untracked work\n');
    // Execute the actual updater with real Git and npm, without Electron or a renderer.
    const update = require('node:vm').runInNewContext(
      source.slice(source.indexOf('function runUpdateCommand('), source.indexOf('/** Reload every renderer'))
        + '\nupdateDesktopInPlace',
      { spawn, process: { ...process, env: { ...process.env, NODE_ENV: 'production' } }, getProjectRoot: () => checkout },
    );
    await update();
    assert.equal(git(checkout, 'rev-parse', 'HEAD'), git(upstream, 'rev-parse', 'HEAD'));
    assert.equal(fs.readFileSync(path.join(checkout, 'build-output'), 'utf8'), 'unsaved work\n');
    assert.equal(fs.readFileSync(path.join(checkout, 'local.txt'), 'utf8'), 'unsaved work\n');
    assert.equal(fs.readFileSync(path.join(checkout, 'untracked.txt'), 'utf8'), 'untracked work\n');
    assert.equal(git(checkout, 'stash', 'list'), '');
  });
}

for (const buildFails of [false, true]) {
  test(`source overlap is rejected before checkout mutation or build (build fails: ${buildFails})`, async (t) => {
    const { execFileSync, spawn } = require('node:child_process');
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'fizzer-update-conflict-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const upstream = path.join(dir, 'upstream');
    const checkout = path.join(dir, 'checkout');
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    fs.mkdirSync(upstream);
    git(upstream, 'init', '-b', 'master');
    git(upstream, 'config', 'user.email', 'updater@example.test');
    git(upstream, 'config', 'user.name', 'Updater Test');
    git(upstream, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(upstream, 'overlap.txt'), 'original\n');
    fs.writeFileSync(path.join(upstream, 'package.json'), JSON.stringify({ scripts: {
      build: buildFails ? `node -e "console.error('BUILD_SENTINEL');process.exit(1)"` : 'node -e "process.exit(0)"',
    } }));
    git(upstream, 'add', '.');
    git(upstream, 'commit', '-m', 'initial');
    git(dir, 'clone', upstream, checkout);
    git(checkout, 'config', 'user.email', 'updater@example.test');
    git(checkout, 'config', 'user.name', 'Updater Test');
    fs.writeFileSync(path.join(upstream, 'overlap.txt'), 'shipped change\n');
    git(upstream, 'commit', '-am', 'release');
    fs.writeFileSync(path.join(checkout, 'overlap.txt'), 'valuable local work\n');
    fs.writeFileSync(path.join(checkout, 'untracked.txt'), 'untracked work\n');
    const update = require('node:vm').runInNewContext(
      source.slice(source.indexOf('function runUpdateCommand('), source.indexOf('/** Reload every renderer'))
        + '\nupdateDesktopInPlace',
      { spawn, process, getProjectRoot: () => checkout },
    );
    const before = git(checkout, 'status', '--porcelain');
    const head = git(checkout, 'rev-parse', 'HEAD');
    const index = fs.readFileSync(path.join(checkout, '.git/index'));
    await assert.rejects(update(), /Update conflicts with local work[\s\S]*overlap.txt/);
    assert.equal(git(checkout, 'rev-parse', 'HEAD'), head);
    assert.equal(git(checkout, 'status', '--porcelain'), before);
    assert.deepEqual(fs.readFileSync(path.join(checkout, '.git/index')), index);
    assert.equal(fs.readFileSync(path.join(checkout, 'overlap.txt'), 'utf8'), 'valuable local work\n');
    assert.equal(fs.readFileSync(path.join(checkout, 'untracked.txt'), 'utf8'), 'untracked work\n');
    assert.equal(git(checkout, 'stash', 'list'), '');
  });
}
