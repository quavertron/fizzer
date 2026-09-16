import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { antigravityFullHostProject, antigravityChildEnv, selectAntigravityProject, runCliAgent, cancelAntigravityRun } from './cli-agent.js';

const project = (id: string, ...roots: string[]) => ({
  id, projectResources: { resources: roots.map(root => ({ gitFolder: { folderUri: pathToFileURL(root).href } })) },
});

test('project selection uses roots, path boundaries, and primary-root tie breaking', () => {
  const projects = [
    { ...project('unrelated', '/work/other'), permissionGrants: { allow: ['read_file(/work/My Vault)'] } },
    project('polluted', '/work/repo', '/work/My Vault'),
    project('vault', '/work/My Vault'),
    project('parent', '/work'),
    project('fizzer-agy-full-test', '/elsewhere'),
  ];
  assert.equal(selectAntigravityProject(projects, '/work/My Vault/notes'), 'vault');
  assert.equal(selectAntigravityProject(projects, '/work/My Vault-copy'), 'parent');
  assert.equal(selectAntigravityProject(projects, '/elsewhere'), undefined);
});

test('agentapi child drops inherited provenance and keeps helper credentials and discovered connection', () => {
  const env = antigravityChildEnv({
    PATH: '/bin', CASCADE_NOTE_TOKEN: 'test-helper',
    ANTIGRAVITY_PROJECT_ID: 'wrong', ANTIGRAVITY_CONVERSATION_ID: 'gone',
    ANTIGRAVITY_SOURCE_METADATA: 'stale', ANTIGRAVITY_TRAJECTORY_ID: 'gone',
    ANTIGRAVITY_AGENTAPI_EXE: '/wrong/agy', ANTIGRAVITY_CSRF_TOKEN: 'old',
  }, { ANTIGRAVITY_PROJECT_ID: 'right', ANTIGRAVITY_CSRF_TOKEN: 'new' });
  assert.deepEqual(env, { PATH: '/bin', CASCADE_NOTE_TOKEN: 'test-helper', ANTIGRAVITY_PROJECT_ID: 'right', ANTIGRAVITY_CSRF_TOKEN: 'new' });
});

test('Antigravity runner regressions with a fake agentapi and provider', async t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-regression-'));
  const bin = path.join(scratch, 'agentapi');
  const transcript = path.join(scratch, '.gemini/antigravity/brain/fresh/.system_generated/logs/transcript.jsonl');
  const projects = path.join(scratch, '.gemini/config/projects');
  fs.mkdirSync(projects, { recursive: true });
  const config = JSON.stringify({ ...project('correct', scratch), permissionGrants: { v2Migrated: true, permissionGrants: { deny: ['write_file(secret)'], ask: ['command(curl)'] } } });
  fs.writeFileSync(path.join(projects, 'correct.json'), config);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_ARGS, JSON.stringify(args) + '\\n');
fs.appendFileSync(process.env.FAKE_PROJECTS, process.env.ANTIGRAVITY_PROJECT_ID + '\\n');
if (args[0] === 'send-message') {
  console.log(JSON.stringify({error: 'conversation "gone" not found'}));
  process.exit(0);
}
fs.writeFileSync(process.env.FAKE_TRANSCRIPT, process.env.FAKE_STEPS);
console.log(JSON.stringify({response: {newConversation: {conversationId: 'fresh'}}}));
`);
  fs.chmodSync(bin, 0o755);
  const previousBin = process.env.ANTIGRAVITY_BIN;
  process.env.ANTIGRAVITY_BIN = bin;
  t.mock.method(os, 'homedir', () => scratch);
  const requests: string[] = [];
  const serverProjects = new Map<string, any>([['correct', JSON.parse(config)]]);
  let providerStatus = 'CASCADE_RUN_STATUS_RUNNING';
  let metadataUnavailable = false;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options: RequestInit) => {
    const endpoint = String(url).split('/').at(-1)!;
    requests.push(endpoint);
    assert.equal((options.headers as Record<string, string>)['X-Codeium-Csrf-Token'], 'fake-token');
    const body = JSON.parse(String(options.body));
    if (endpoint === 'CreateProject' || endpoint === 'UpdateProject') {
      serverProjects.set(body.project.id, body.project);
      return new Response('{}');
    }
    if (endpoint === 'ReadProject') {
      return new Response(JSON.stringify(serverProjects.has(body.id) ? { project: serverProjects.get(body.id) } : { notFoundOnDisk: true }));
    }
    if (endpoint === 'GetConversationMetadata') {
      if (metadataUnavailable) return new Response(JSON.stringify({ message: 'temporary server failure' }), { status: 500 });
      return new Response(JSON.stringify(body.conversationId === 'full-session'
        ? { metadata: { projectId: antigravityFullHostProject(JSON.parse(config), scratch).id } } : { metadata: { projectId: 'correct' } }));
    }
    return new Response(JSON.stringify({ status: providerStatus }), { status: 200 });
  });
  t.after(() => {
    if (previousBin === undefined) delete process.env.ANTIGRAVITY_BIN;
    else process.env.ANTIGRAVITY_BIN = previousBin;
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const planner = (content: string, tool_calls: unknown[] = []) => ({ source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content, tool_calls });
  const run = (steps: unknown[], extra = {}) => runCliAgent({
    agent: 'antigravity', cwd: scratch, context: '', userPrompt: 'test', emit: () => {},
    env: {
      ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:1', ANTIGRAVITY_CSRF_TOKEN: 'fake-token',
      FAKE_TRANSCRIPT: transcript, FAKE_ARGS: path.join(scratch, 'args'), FAKE_PROJECTS: path.join(scratch, 'child-projects'),
      FAKE_STEPS: steps.map(step => JSON.stringify(step)).join('\n') + '\n',
    }, ...extra,
  });

  await t.test('surfaces quota errors immediately and cancels the provider', async () => {
    requests.length = 0;
    await assert.rejects(run([{ source: 'MODEL', type: 'ERROR_MESSAGE', status: 'DONE', content: 'Individual quota reached. Resets in 2 hours.' }]), /Individual quota reached/);
    assert.deepEqual(requests, ['ReadProject', 'CancelCascadeInvocation']);
  });

  await t.test('retries a missing saved session once, and preserves permission configuration', async () => {
    const result = await run([planner('Answered.')], { resumeSessionId: 'gone' });
    assert.equal(result.summary, 'Answered.');
    const args = fs.readFileSync(path.join(scratch, 'args'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(args.slice(-2).map(a => a[0]), ['send-message', 'new-conversation']);
    assert.equal(fs.readFileSync(path.join(projects, 'correct.json'), 'utf8'), config);
    assert.equal(fs.existsSync(path.join(scratch, '.gemini/config/config.json')), false);
  });

  await t.test('reports failed command when the provider stops without a final answer', async () => {
    providerStatus = 'CASCADE_RUN_STATUS_IDLE';
    await assert.rejects(run([
      planner('', [{ name: 'run_command', args: { CommandLine: 'cascade-chat --help' } }]),
      { source: 'MODEL', type: 'GENERIC', status: 'DONE', content: 'The command exited with code 1. EPERM: operation not permitted, open cascade-chat' },
    ]), /EPERM/);
    providerStatus = 'CASCADE_RUN_STATUS_RUNNING';
    assert.equal(requests.includes('ResolveOutstandingSteps'), false);
  });

  await t.test('a tool error can recover and return a real answer', async () => {
    const result = await run([
      planner('', [{ name: 'run_command', args: {} }]),
      { source: 'MODEL', type: 'GENERIC', status: 'ERROR', content: 'Command failed' },
      planner('Recovered answer.'),
    ]);
    assert.equal(result.summary, 'Recovered answer.');
  });

  await t.test('blank planner output does not imply successful completion', async () => {
    providerStatus = 'CASCADE_RUN_STATUS_IDLE';
    await assert.rejects(run([planner('')]), /without returning a response/);
    providerStatus = 'CASCADE_RUN_STATUS_RUNNING';
  });

  await t.test('full-host preference uses an isolated runtime project and scoped runs never reuse it', async () => {
    const full = await run([planner('Full host answer.')], { yolo: true });
    assert.equal(full.summary, 'Full host answer.');
    const managed = antigravityFullHostProject(JSON.parse(config), scratch);
    assert.equal(serverProjects.get(managed.id).settings.sandboxMode, false);
    assert.equal(serverProjects.get(managed.id).settings.permissionPreset, 'AGENT_PERMISSION_PRESET_TURBO');
    assert.deepEqual(serverProjects.get(managed.id).permissionGrants, JSON.parse(config).permissionGrants);
    assert.deepEqual(serverProjects.get('correct'), JSON.parse(config));
    assert.equal(fs.readFileSync(path.join(scratch, 'child-projects'), 'utf8').trim().split('\n').at(-1), managed.id);
    const scoped = await run([planner('Scoped answer.')], { yolo: false, resumeSessionId: 'full-session' });
    assert.equal(scoped.summary, 'Scoped answer.');
    const args = JSON.parse(fs.readFileSync(path.join(scratch, 'args'), 'utf8').trim().split('\n').at(-1)!);
    assert.equal(args[0], 'new-conversation');
    assert.equal(fs.readFileSync(path.join(scratch, 'child-projects'), 'utf8').trim().split('\n').at(-1), 'correct');
  });

  await t.test('does not resume a possibly privileged session when its permission mode cannot be verified', async () => {
    const before = fs.readFileSync(path.join(scratch, 'args'), 'utf8');
    metadataUnavailable = true;
    try {
      await assert.rejects(run([planner('Must not launch.')], { resumeSessionId: 'full-session', yolo: false }), /temporary server failure/);
      assert.equal(fs.readFileSync(path.join(scratch, 'args'), 'utf8'), before);
    } finally { metadataUnavailable = false; }
  });

  await t.test('does not lose a JSON record split between transcript polls', async () => {
    const record = JSON.stringify(planner('Complete record.'));
    let timer: NodeJS.Timeout | undefined;
    const result = await run([], {
      emit: (event: string) => {
        if (event === 'session') {
          fs.writeFileSync(transcript, record.slice(0, 30));
          timer = setTimeout(() => fs.appendFileSync(transcript, record.slice(30) + '\n'), 700);
        }
      },
    });
    if (timer) clearTimeout(timer);
    assert.equal(result.summary, 'Complete record.');
  });

  await t.test('cancels provider after agentapi has exited and polling has started', async () => {
    requests.length = 0;
    const result = await run([planner('', [{ name: 'run_command', args: {} }])], {
      runId: 90421,
      emit: (event: string) => { if (event === 'session') cancelAntigravityRun(90421); },
    });
    assert.equal(result.summary, 'Run canceled by user.');
    assert.deepEqual(requests, ['ReadProject', 'CancelCascadeInvocation']);
  });
});
