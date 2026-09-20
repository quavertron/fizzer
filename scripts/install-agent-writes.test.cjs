const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const installer = path.resolve(__dirname, '../install-agent-writes.sh');
const help = 'alock bridge serve --turn\nalock bridge mkdir --author NAME --replace-symlink --delete\nalock account http-serve --persistent';

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'install-agent-writes-'));
  const write = (name, content, mode) => {
    const target = path.join(directory, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, { mode });
    return target;
  };
  const binary = write('alock', `#!/bin/sh\ncat <<'HELP'\n${help}\nHELP\n`, 0o755);
  for (const name of ['nab', 'awatch', 'purrvect', 'rclone']) write(name, '#!/bin/sh\nexit 0\n', 0o755);
  const startup = write('mock-shell', `
sudo() { printf '%s\\n' "$*" >> "$MOCK_LOG"; }
git() {
  if [[ $1 == clone ]]; then
    echo 'Unexpected repository fetch' >&2
    return 99
  elif [[ $1 == -C ]]; then
    printf 'submodules %s\\n' "$*" >> "$MOCK_LOG"
  else command git "$@"; fi
}
`);
  const env = { ...process.env, HOME: directory, XDG_CONFIG_HOME: path.join(directory, 'config'),
    CASCADE_DATA_DIR: path.join(directory, 'data'), GIT_CONFIG_GLOBAL: path.join(directory, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1', BASH_ENV: startup, MOCK_LOG: path.join(directory, 'calls') };
  delete env.FIZZER_ALOCK_BIN;
  return { directory, write, binary, env,
    run(args = [binary], entry = installer) {
      const result = spawnSync('/bin/bash', [entry, ...args], { env, encoding: 'utf8', input: '', timeout: 120000 });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return result;
    }, clean() { fs.rmSync(directory, { recursive: true, force: true }); } };
}

test('root installer initializes history and ignores once, update preserves explicit settings', () => {
  const f = fixture();
  try {
    f.run(); f.run(['--update', f.binary]);
    assert.equal(fs.readFileSync(path.join(f.directory, 'config/alock.toml'), 'utf8'), 'nab = true\n');
    assert.equal(fs.readFileSync(path.join(f.directory, 'config/git/ignore'), 'utf8').split('\n').filter(x => x === '*.nab').length, 1);
    f.write('config/alock.toml', '# chosen by user\nnab = false\n');
    f.write('data/agent-write-access-default.json', '{"scope":"workspace"}\n');
    f.run(['--update', f.binary]);
    assert.equal(fs.readFileSync(path.join(f.directory, 'config/alock.toml'), 'utf8'), '# chosen by user\nnab = false\n');
    assert.equal(fs.readFileSync(path.join(f.directory, 'data/agent-write-access-default.json'), 'utf8'), '{"scope":"workspace"}\n');
  } finally { f.clean(); }
});

test('source checkout builds all bundled projects without sibling repositories', () => {
  const f = fixture();
  try {
    const entry = f.write('fresh/install-agent-writes.sh', fs.readFileSync(installer));
    const root = path.resolve(__dirname, '..');
    f.write('fresh/scripts/build-agent-tools.mjs', fs.readFileSync(path.join(__dirname, 'build-agent-tools.mjs')));
    f.write('fresh/scripts/prepare-rclone.mjs', fs.readFileSync(path.join(__dirname, 'prepare-rclone.mjs')));
    fs.cpSync(path.join(root, 'vendor'), path.join(f.directory, 'fresh/vendor'), { recursive: true });
    fs.cpSync(path.join(root, 'tui/vendor/purrvect'), path.join(f.directory, 'fresh/tui/vendor/purrvect'), { recursive: true });
    for (const name of ['GOMODCACHE', 'GOCACHE']) {
      f.env[name] = spawnSync('go', ['env', name], { encoding: 'utf8' }).stdout.trim();
    }
    f.env.RUSTUP_HOME = process.env.RUSTUP_HOME || path.join(os.homedir(), '.rustup');
    f.env.CARGO_HOME = process.env.CARGO_HOME || path.join(os.homedir(), '.cargo');
    f.run([], entry);
    const calls = fs.readFileSync(path.join(f.directory, 'calls'), 'utf8');
    assert.doesNotMatch(calls, /clone|submodules/);
    assert.match(calls, /--privileged/);
    assert.equal(fs.existsSync(path.join(f.directory, '.local/lib/libdtob.a')), false);
  } finally { f.clean(); }
});

test('nab default stays top-level and preserves unrelated TOML', () => {
  const f = fixture();
  try {
    f.write('config/alock.toml', '[other]\nvalue = 5\n');
    f.run();
    assert.equal(fs.readFileSync(path.join(f.directory, 'config/alock.toml'), 'utf8'), 'nab = true\n[other]\nvalue = 5\n');
  } finally { f.clean(); }
});
