'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { loginScript, terminalInvocation, runAgentLogin, SUPPORTED } = require('./agent-login.cjs');

test('codex login runs as the fizzer account only when the account is enabled', () => {
  assert.match(loginScript('codex', true, { bin: 'codex' }), /^sudo -H -u fizzer 'codex' login$/);
  assert.equal(loginScript('codex', false, { bin: 'codex' }), "'codex' login");
});

test('claude login mints and persists a token for the fizzer worker when enabled', () => {
  const script = loginScript('claude', true, { bin: 'claude', tokenFile: '/home/x/.fizzer/claude-oauth-token' });
  assert.match(script, /'claude' setup-token/);
  assert.match(script, /read -r FIZZER_CLAUDE_TOKEN/);
  assert.match(script, /> '\/home\/x\/\.fizzer\/claude-oauth-token'/);
  // Disabled mode logs in as the human via the normal interactive CLI.
  const human = loginScript('claude', false, { bin: 'claude' });
  assert.match(human, /Run \/login inside Claude/);
  assert.doesNotMatch(human, /setup-token/);
});

test('binary paths with spaces or quotes are shell-escaped', () => {
  const script = loginScript('codex', true, { bin: "/opt/my codex/co'x" });
  assert.match(script, /sudo -H -u fizzer '\/opt\/my codex\/co'\\''x' login/);
});

test('terminal invocation is platform specific and rejects Windows', () => {
  const mac = terminalInvocation('/tmp/x/codex-login.sh', 'darwin');
  assert.equal(mac.command, 'osascript');
  assert.ok(mac.args.some(arg => /do script "bash \/tmp\/x\/codex-login\.sh"/.test(arg)));
  const linux = terminalInvocation('/tmp/x/codex-login.sh', 'linux');
  assert.equal(linux.command, 'x-terminal-emulator');
  assert.throws(() => terminalInvocation('/tmp/x.sh', 'win32'), /not supported/);
});

test('runAgentLogin rejects unsupported agents and Windows, and spawns a detached terminal otherwise', async () => {
  await assert.rejects(runAgentLogin({ agent: 'grok', platform: 'darwin' }), /Unsupported/);
  await assert.rejects(runAgentLogin({ agent: 'codex', platform: 'win32' }), /not supported on Windows/);

  let spawned;
  const result = await runAgentLogin({
    agent: 'codex',
    platform: 'darwin',
    enabled: true,
    spawnFn: (command, args, options) => { spawned = { command, args, options }; return { unref() {} }; },
  });
  assert.deepEqual(result, { success: true });
  assert.equal(spawned.command, 'osascript');
  assert.equal(spawned.options.detached, true);
});

test('only claude and codex are supported', () => {
  assert.deepEqual([...SUPPORTED].sort(), ['claude', 'codex']);
});
