// Real task resolver -> scheduler -> durable runner payload -> compiled CLI runner.
// Only provider executables are inert. No personal HOME, credentials, UI or inference.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fizzer-self-subagents-'));
const log = path.join(temp, 'calls.jsonl');
try {
  const backend = spawnSync('mix', ['test', 'test/cascade_web/orchestration_mission_execution_test.exs', '--only', 'self_subagents'], {
    cwd: path.join(root, 'backend_elixir'), stdio: 'inherit',
    env: { ...process.env, FIZZER_SELF_SUBAGENT_FIXTURE_DIR: temp },
  });
  assert.equal(backend.status, 0, 'backend resolver/dispatch regression');
  for (const provider of ['codex', 'hermes']) {
    const binary = path.join(temp, provider);
    fs.writeFileSync(binary, `#!${process.execPath}\nconst fs=require('fs');\nfs.appendFileSync(${JSON.stringify(log)},JSON.stringify({provider:${JSON.stringify(provider)},args:process.argv.slice(2)})+'\\n');\n${provider === 'codex'
      ? "console.log(JSON.stringify({type:'thread.started',thread_id:'inert-fixture'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'inert fixture completed'}}));"
      : "console.log('inert fixture completed');console.error('session_id: inert-fixture');"}\n`, { mode: 0o700 });
  }
  // Module command discovery happens at import time. Profile routing sees only this empty HOME.
  Object.assign(process.env, { HOME: temp, HERMES_HOME: path.join(temp, 'hermes-home'),
    CODEX_BIN: path.join(temp, 'codex'), HERMES_BIN: path.join(temp, 'hermes'),
    CASCADE_AGENT_PROCESS_DIR: path.join(temp, 'processes'), RUNNER_CODEX_PERSISTENT: '0' });
  const { runCliAgent } = await import(path.join(root, 'dist/cli-agents/cli-agent.js'));
  for (const provider of ['codex', 'hermes']) {
    for (const purpose of ['implementation', 'review']) {
      const payload = JSON.parse(fs.readFileSync(path.join(temp, `${provider}-${purpose}.json`), 'utf8'));
      const result = await runCliAgent({ ...payload, cwd: temp, context: '', userPrompt: payload.prompt, emit() {} });
      assert.equal(result.summary, 'inert fixture completed');
      const call = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').at(-1));
      assert.equal(call.provider, provider);
      assert.equal(call.args[call.args.indexOf(provider === 'codex' ? '--model' : '-m') + 1], 'gpt-6-astra');
      assert(!call.args.includes('resume') && !call.args.includes('--resume'));
      if (provider === 'hermes') assert.equal(call.args[call.args.indexOf('-p') + 1], 'fixture-astra');
      else assert(call.args.includes('model_reasoning_effort="xhigh"'));
      console.log(JSON.stringify({ provider, purpose, model: payload.model, profile: payload.hermesProfile,
        reasoningEffort: payload.reasoningEffort ?? 'profile default', freshSession: true, inertProvider: true }));
    }
  }
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 4);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
