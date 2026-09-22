#!/usr/bin/env node
import { runCliAgent } from '../dist/cli-agents/cli-agent.js';
import { cancelCliAgentRun } from '../dist/cli-agents/cli-agent.js';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });

process.on('SIGTERM', () => {
  const runId = Number(process.env.CASCADE_RUN_ID);
  if (Number.isFinite(runId) && runId > 0) {
    try { cancelCliAgentRun(runId); } catch { /* ignore */ }
  }
  process.exit(143);
});

const emitLine = (value) => {
  process.stdout.write(JSON.stringify(value) + '\n');
};

process.stdin.on('end', async () => {
  let opts;
  try {
    opts = JSON.parse(input || '{}');
  } catch (error) {
    emitLine({ error: error?.message || String(error) });
    process.exit(1);
    return;
  }
  const runId = Number(opts.runId);
  if (!Number.isFinite(runId) || runId <= 0) {
    emitLine({ error: 'Invalid run id' });
    process.exit(1);
    return;
  }
  let seq = 0;
  const emit = (type, payload) => {
    emitLine({
      event: {
        runId,
        seq: ++seq,
        type,
        payload_json: JSON.stringify(payload ?? {}),
      },
    });
  };
  const contextMode = opts.contextMode === 'self-contained';
  const chatChannelId = String(opts.chatChannelId || opts.chat?.channelId || '').trim();
  try {
    const result = await runCliAgent({
      agent: String(opts.agent || ''),
      context: chatChannelId || contextMode ? '' : opts.__context || '',
      userPrompt: String(opts.prompt || ''),
      cwd: String(opts.cwd || process.cwd()),
      resumeSessionId: typeof opts.resumeSessionId === 'string' ? opts.resumeSessionId : undefined,
      images: Array.isArray(opts.images) ? opts.images : [],
      model: typeof opts.model === 'string' ? opts.model : undefined,
      reasoningEffort: typeof opts.reasoningEffort === 'string' ? opts.reasoningEffort : undefined,
      priorityServiceTier: opts.priorityServiceTier === true,
      sandbox: contextMode && opts.sandbox === 'read-only' ? 'read-only' : undefined,
      yolo: opts.yolo === true,
      hermesProfile: typeof opts.hermesProfile === 'string' ? opts.hermesProfile : undefined,
      hermesSafeMode: opts.hermesSafeMode === true,
      runId,
      emit,
      env: process.env,
    });
    emitLine({ result: { summary: result?.summary || '', sessionId: result?.sessionId } });
    process.exit(0);
  } catch (error) {
    emitLine({ error: error?.message || String(error) });
    process.exit(1);
  }
});
