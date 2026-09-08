import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { getHermesProfileCommand } from './hermes-profile-command.js';

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fizzer-hermes-route-'));
  const dir = path.join(home, '.cascade');
  fs.mkdirSync(dir, { mode: 0o700 });
  const config = path.join(dir, 'hermes-profile-commands.json');
  const command = path.join(home, 'adapter with spaces.cjs');
  const log = path.join(home, 'launches.jsonl');
  const executable = (file: string, name: string) => {
    fs.writeFileSync(file, `#!${process.execPath}\nconst fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({name:${JSON.stringify(name)}, args:process.argv.slice(2), marker:process.env.ROUTE_TEST_MARKER, events:process.env.HERMES_CASCADE_EVENTS})+'\\n');
process.stderr.write('session_id: fixture-session\\n');
process.stdout.write('fixture answer\\n');\n`, { mode: 0o700 });
  };
  executable(command, 'adapter');
  const write = (value: unknown = { version: 1, profiles: { along: { command } } }) => {
    fs.writeFileSync(config, JSON.stringify(value), { mode: 0o600 });
  };
  return { home, dir, config, command, log, executable, write };
}

test('routing loads each time and rejects invalid or insecure configuration', () => {
  const f = fixture();
  try {
    assert.equal(getHermesProfileCommand('along', f.config), undefined);
    f.write();
    assert.equal(getHermesProfileCommand('along', f.config), f.command);
    assert.equal(getHermesProfileCommand('other', f.config), undefined);
    assert.equal(getHermesProfileCommand('', f.config), undefined);
    for (const value of [null, [], { version: 2, profiles: {} },
      { version: 1, profiles: [] }, { version: 1, profiles: { along: null } },
      { version: 1, profiles: { along: { command: 'relative' } } },
      { version: 1, profiles: { along: { command: f.command, args: [] } } },
      { version: 1, profiles: { '../bad': { command: f.command } } },
      { version: 1, profiles: { along: { command: '/bad\0path' } } }]) {
      f.write(value);
      assert.throws(() => getHermesProfileCommand('along', f.config), /routing:/);
    }
    fs.writeFileSync(f.config, '{not json');
    assert.throws(() => getHermesProfileCommand('along', f.config), /routing:/);
    f.write();
    fs.chmodSync(f.config, 0o644);
    assert.throws(() => getHermesProfileCommand('along', f.config), /private regular file/);
    fs.chmodSync(f.config, 0o600);
    fs.chmodSync(f.dir, 0o777);
    assert.throws(() => getHermesProfileCommand('along', f.config), /config directory/);
    fs.chmodSync(f.dir, 0o700);
    const realConfig = path.join(f.home, 'real.json');
    fs.renameSync(f.config, realConfig);
    fs.symlinkSync(realConfig, f.config);
    assert.throws(() => getHermesProfileCommand('along', f.config), /securely open/);
    fs.unlinkSync(realConfig); // dangling config links must not mean opt-out
    assert.throws(() => getHermesProfileCommand('along', f.config), /securely open/);
    fs.unlinkSync(f.config);
    fs.mkdirSync(f.config, { mode: 0o700 });
    assert.throws(() => getHermesProfileCommand('along', f.config), /private regular file/);
    fs.rmdirSync(f.config);
    f.write();
    fs.chmodSync(f.command, 0o600);
    assert.throws(() => getHermesProfileCommand('along', f.config), /unavailable/);
    f.write({ version: 1, profiles: { along: { command: f.home } } });
    assert.throws(() => getHermesProfileCommand('along', f.config), /regular file/);
    fs.renameSync(f.dir, `${f.dir}-real`);
    fs.symlinkSync(`${f.dir}-real`, f.dir);
    assert.throws(() => getHermesProfileCommand('along', f.config), /config directory/);
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});

test('real runCliAgent routes only opted-in profiles, preserves argv/env and fails closed', async () => {
  const f = fixture();
  const saved = { HOME: process.env.HOME, HERMES_BIN: process.env.HERMES_BIN,
    CASCADE_AGENT_PROCESS_DIR: process.env.CASCADE_AGENT_PROCESS_DIR };
  try {
    process.env.HOME = f.home;
    process.env.CASCADE_AGENT_PROCESS_DIR = path.join(f.home, 'leases');
    const normal = path.join(f.home, 'normal.cjs');
    f.executable(normal, 'normal');
    process.env.HERMES_BIN = normal;
    f.write();
    const { runCliAgent } = await import('./cli-agent.js');
    const run = (profile?: string) => runCliAgent({ agent: 'hermes', context: '',
      userPrompt: 'literal ; $(not-a-shell) "prompt"', cwd: f.home, emit() {},
      hermesProfile: profile, resumeSessionId: 'existing-session', model: 'fixture-model',
      hermesSafeMode: true, yolo: true, env: { ROUTE_TEST_MARKER: 'unchanged' } });
    const result = await run('along');
    assert.equal(result.summary, 'fixture answer');
    assert.equal(result.sessionId, 'fixture-session');
    await run('other');
    await run();
    const launches = () => fs.readFileSync(f.log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const records = launches();
    assert.deepEqual(records.map(r => r.name), ['adapter', 'normal', 'normal']);
    assert.deepEqual(records[0].args, ['-p', 'along', ...records[2].args]);
    assert.deepEqual(records[1].args, ['-p', 'other', ...records[2].args]);
    assert.deepEqual(records[0].args.slice(2, 7), ['chat', '-Q', '--resume', 'existing-session', '-q']);
    assert.deepEqual(records[0].args.slice(-4), ['-m', 'fixture-model', '--yolo', '--safe-mode']);
    assert.equal(records[0].marker, 'unchanged');
    assert.equal(records[0].events, records[1].events);
    process.env.HERMES_BIN = path.join(f.home, 'normal-missing');
    await run('along'); // no normal Hermes installation required
    process.env.HERMES_BIN = normal;
    f.write({ version: 1, profiles: { along: { command: path.join(f.home, 'missing') } } });
    await assert.rejects(run('along'), /routing:.*unavailable/);
    assert.equal(launches().length, 4);
    await assert.rejects(run('../invalid'), /Hermes profile must/);
    assert.equal(launches().length, 4);
    f.write();
    fs.unlinkSync(f.command);
    await assert.rejects(run('along'), /routing:.*unavailable/);
    assert.equal(launches().length, 4);
    fs.writeFileSync(f.command, '#!/nonexistent/fizzer-test-interpreter\n', { mode: 0o700 });
    await assert.rejects(run('along')); // validation passes, but exec itself fails
    assert.equal(launches().length, 4);
    f.write({ version: 1, profiles: { along: { command: 'relative' } } });
    await assert.rejects(run('along'), /invalid profile mapping/);
    assert.equal(launches().length, 4);
    f.write();
    await run('other'); // broken target does not prevent a different profile
    fs.unlinkSync(f.config);
    await run('along'); // explicit removal restores default routing on next run
    assert.deepEqual(launches().slice(-2).map(r => r.name), ['normal', 'normal']);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(f.home, { recursive: true, force: true });
  }
});
