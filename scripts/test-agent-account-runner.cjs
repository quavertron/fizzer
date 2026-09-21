#!/usr/bin/env node
'use strict';
// Requires install-agent-writes.sh. No provider calls or real project edits.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { run, cancel } = require('../cascade-electron/agent-account.cjs');

async function main() {
  const id = spawnSync('/usr/bin/sudo', ['-n', '-H', '-u', 'fizzer', '/usr/bin/id', '-u'], { encoding: 'utf8' });
  if (id.status !== 0) throw new Error('Run bash install-agent-writes.sh first.');
  const expectedUid = Number(id.stdout.trim());
  const directory = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'fizzer-runner-check-'));
  const root = path.join(directory, 'project');
  const prior = process.env.CLAUDE_BIN;
  const priorData = process.env.CASCADE_DATA_DIR;
  process.env.CASCADE_DATA_DIR = path.join(directory, 'state');
  try {
    fs.chmodSync(directory, 0o755);
    fs.mkdirSync(root, { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'note.txt'), 'original\n', { mode: 0o644 });
    fs.symlinkSync('note.txt', path.join(root, 'read-only-link'));
    fs.symlinkSync('.', path.join(root, 'cycle'));
    fs.symlinkSync('absent', path.join(root, 'dangling'));
    fs.mkdirSync(path.join(root, 'private-build'), { mode: 0o700 });
    fs.writeFileSync(path.join(root, 'private-build', 'hidden'), 'private', { mode: 0o666 });
    const fake = path.join(directory, 'fake-claude.cjs');
    fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs');
const {spawnSync} = require('node:child_process');
if (process.getuid() !== ${expectedUid}) throw new Error('Wrong agent UID');
try { fs.writeFileSync('note.txt', 'bypass'); throw new Error('Direct write unexpectedly succeeded'); }
catch (error) { if (!['EACCES', 'EPERM'].includes(error.code)) throw error; }
function bridge(args) {
  if (['stage', 'commit'].includes(args[0])) args.push('--author', 'fizzer-test');
  const result = spawnSync(process.env.FIZZER_ALOCK_BIN, ['account', ...args, '--socket', process.env.FIZZER_BRIDGE_SOCKET], {encoding:'utf8'});
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout);
}
const stage = bridge(['stage', '--path', 'note.txt']);
try {
  fs.writeFileSync(stage.file, 'through alock\\n');
  bridge(['commit', '--ticket', stage.ticket, '--file', stage.file]);
} finally { fs.unlinkSync(stage.file); fs.unlinkSync(stage.file + '.alock'); }
console.log(JSON.stringify({type:'result', subtype:'success', result:'permissions and bridge verified', session_id:'disposable-test'}));
`, { mode: 0o755 });
    process.env.CLAUDE_BIN = fake;
    const events = [];
    const result = await run({ runId: 990017, agent: 'claude-code', cwd: root, vaultRoot: path.join(directory, 'missing-vault'),
      prompt: 'Disposable permission test', model: 'fake-provider' }, event => events.push(event), {});
    if (result.sessionId !== 'disposable-test' || fs.readFileSync(path.join(root, 'note.txt'), 'utf8') !== 'through alock\n') {
      throw new Error('Worker result or committed file did not match.');
    }
    const activity = events.filter(event => event.type === 'activity').map(event => JSON.parse(event.payload_json));
    if (!activity.some(event => event.kind === 'lock') || !activity.some(event =>
      event.kind === 'edit' && event.file === path.join(root, 'note.txt') && event.new_lines.includes('through alock'))) {
      throw new Error('This run’s native lock and edit events did not reach the desktop relay.');
    }
    console.log('PASS: actual fizzer UID, denied direct write, native bridge commit, runner events and cleanup. No provider contacted.');
    const outsideProject = path.join(directory, 'outside.txt');
    fs.writeFileSync(outsideProject, 'outside baseline\n', { mode: 0o644 });
    fs.writeFileSync(fake, fs.readFileSync(fake, 'utf8').replace("'--path', 'note.txt'", "'--path', " + JSON.stringify(outsideProject.slice(1))));
    const wideOpts = { runId: 990021, agent: 'claude-code', cwd: root, vaultId: 'test-vault', chatRegistrationId: 'wide-agent', prompt: 'Test authorized outside edit' };
    const wideApi = { url: 'http://127.0.0.1:1' };
    require('../cascade-electron/agent-write-access.cjs').save(wideApi.url, wideOpts.vaultId, wideOpts.chatRegistrationId, { scope: 'human' });
    await run(wideOpts, () => {}, wideApi);
    if (fs.readFileSync(outsideProject, 'utf8') !== 'through alock\n') throw new Error('Human scope did not edit outside workspace');
    let denied = false;
    try { await run({ ...wideOpts, runId: 990022, chatRegistrationId: 'ungranted-agent' }, () => {}, wideApi); }
    catch { denied = true; }
    if (!denied) throw new Error('Different agent inherited broad write access');
    console.log('PASS: human scope edits outside workspace; ungranted agent rejected');
    fs.writeFileSync(path.join(process.env.CASCADE_DATA_DIR, 'agent-write-access-default.json'), '{"scope":"human"}');
    await run({ runId: 990024, agent: 'claude-code', cwd: root, prompt: 'Installation default outside edit' }, () => {}, {});
    console.log('PASS: installation default grants outside-workspace edits without registration setup');
    require('../cascade-electron/agent-write-access.cjs').save(wideApi.url, wideOpts.vaultId, wideOpts.chatRegistrationId,
      { scope: 'folders', folders: [directory, root] });
    fs.writeFileSync(fake, fs.readFileSync(fake, 'utf8').replace(JSON.stringify(outsideProject.slice(1)), "'outside.txt'"));
    await run({ ...wideOpts, runId: 990023 }, () => {}, wideApi);
    console.log('PASS: selected folder bridges work independently of the working directory');
    fs.writeFileSync(fake, `#!/usr/bin/env node
console.log(JSON.stringify({type:'system', subtype:'init', session_id:'cancel-test'}));
setInterval(() => {}, 1000);
`, { mode: 0o755 });
    let requestedCancel = false;
    const canceled = await run({ runId: 990018, agent: 'claude-code', cwd: root, vaultRoot: root,
      prompt: 'Disposable cancellation test', model: 'fake-provider' }, event => {
      if (!requestedCancel && event.type === 'timing' && JSON.parse(event.payload_json).phase === 'first_response') {
        requestedCancel = true;
        setTimeout(() => cancel(990018), 25);
      }
    }, {});
    if (!canceled.canceled) throw new Error('Cancellation did not complete.');
    console.log('PASS: cancellation reaches the separate-account worker');
    const outside = path.join(directory, 'writable-outside');
    fs.writeFileSync(outside, 'outside', { mode: 0o666 });
    fs.chmodSync(outside, 0o666);
    const writableLink = path.join(root, 'writable-link');
    fs.symlinkSync(outside, writableLink);
    fs.chmodSync(path.join(root, 'note.txt'), 0o666);
    fs.writeFileSync(fake, `#!/usr/bin/env node
console.log(JSON.stringify({type:'system', subtype:'init', session_id:'writable-tree-test'}));
console.log(JSON.stringify({type:'result', result:'Started without scanning unrelated permissions', session_id:'writable-tree-test'}));
`, { mode: 0o755 });
    const writable = await run({ runId: 990019, agent: 'claude-code', cwd: root, vaultRoot: root,
      prompt: 'Unrelated writable files must not block startup', model: 'fake-provider' }, () => {}, {});
    if (writable.sessionId !== 'writable-tree-test') throw new Error('Writable tree blocked startup.');
    console.log('PASS: writable files and linked folders do not block agent startup');
  } finally {
    if (prior === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = prior;
    if (priorData === undefined) delete process.env.CASCADE_DATA_DIR; else process.env.CASCADE_DATA_DIR = priorData;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
