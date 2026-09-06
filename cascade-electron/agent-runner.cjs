/**
 * @file agent-runner.cjs — Local CLI agent execution for the Electron main process
 *
 * Spawns Codex/Grok/etc. on the user's machine (where CLIs are installed) instead
 * of relying on a remote Cascade server. Reuses the compiled local CLI module.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const readline = require('readline');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { Resvg } = require('@resvg/resvg-js');

let cliAgentModulePromise = null;
let cliAgentModuleMtimeMs = -1;
const activeCliAgentModules = new Map();

// Claude runs through THIS machine's separately installed `claude` CLI and its
// login / ANTHROPIC_API_KEY — never the server's credentials.
// Mirrors the run options the server used to apply in server/runner.ts.
const CLAUDE_DEFAULT_MODEL = process.env.RUNNER_MODEL || 'claude-sonnet-5';
// Match Claude Code's adaptive reasoning instead of imposing a small fixed
// thinking budget. The local CLI currently defaults to medium effort; callers
// can override either surface without introducing a hard token ceiling.
const CLAUDE_EFFORT = process.env.RUNNER_EFFORT || 'medium';
const CLAUDE_CHAT_EFFORT = process.env.RUNNER_CHAT_EFFORT || CLAUDE_EFFORT;
const CLAUDE_AGENT_CONTEXT = 'You are a local workspace assistant. Use normal filesystem edits for requested local work. Respect auth boundaries and only handle secrets the user explicitly provides for this task.';

// Nudge agents to behave like chat participants, not verbose coding CLIs: the
// chat collapses step narration into a trace disclosure, so the actual message
// should be short. Detailed reasoning belongs in thinking, not the reply.
const CHAT_BREVITY_CONTEXT = 'You are a chat participant, not a coding CLI. Reply like a person in a chat channel: a few short sentences of plain prose, lead with the outcome. Do NOT format the reply as a report — no headings, no bold/italic emphasis, no bullet lists, no em-dash asides, and no restating the question. Keep it to one short paragraph where possible; use a blank line only to separate genuinely distinct points, never after every sentence. Put reasoning, step narration, and detail in thinking or the run trace, not the message. Do not confuse a mentioned @handle with the message author.';
const CHAT_CONTEXT_TOOL_CONTEXT = 'Your channel transcript is append-only. A continued turn contains only new room activity and an exact message cursor. Use the pre-authorized `cascade-chat history --around-message-id <id> --include-reply-context` or `cascade-chat search <query>` tool when that delta is insufficient; never require a repeated sliding-window transcript.';

// Live Cascade API config for helper wrappers, populated by the
// desktop runner host once it knows the server URL + the user's auth token.
// Children inherit these via process.env, so the wrapper authenticates against
// the same local or remote instance the desktop is connected to.
const noteApi = { url: '', token: '', configured: false };
const AGENT_STATE_DIR = process.env.CASCADE_AGENT_STATE_DIR
  || process.env.CASCADE_USER_DATA_DIR
  || path.join(os.homedir(), '.cascade');
const HELPER_CONFIG_PATH = path.join(AGENT_STATE_DIR, 'agent-helper-context.json');
const RUN_CONTEXT_DIR = path.join(AGENT_STATE_DIR, 'run-contexts');
const USER_BIN_DIR = process.env.CASCADE_AGENT_BIN_DIR || path.join(os.homedir(), '.local', 'bin');
// Electron launched from a desktop entry does not inherit the user's login
// shell PATH. Include the conventional per-user CLI locations so agents
// installed with Bun/npm (for example OMP in ~/.bun/bin) are discoverable.
const USER_EXEC_DIRS = [
  USER_BIN_DIR,
  path.join(os.homedir(), '.bun', 'bin'),
  path.join(os.homedir(), '.npm-global', 'bin'),
  path.join(os.homedir(), 'node_modules', '.bin'),
];
const HELPER_NAMES = ['cascade-note', 'cascade-chat', 'cascade-scratchpad'];
const INLINE_SVG_NOTE = (sourcePath) => `[FIZZER HARNESS NOTE TO AGENT: THIS INLINE SVG WAS REPLACED BY AN IMAGE. TO SEE THE SOURCE CODE FOR THE SVG, SEE <${sourcePath}>]`;

/** Render inline SVG prompt fragments into image attachments while retaining source access. */
function renderInlineSvgAttachments(prompt, inlineSvgs) {
  const input = String(prompt || '');
  const sources = Array.isArray(inlineSvgs) ? inlineSvgs.filter((svg) => typeof svg === 'string') : [];
  if (!sources.length) return { prompt: input, images: [], cleanup: () => {} };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fizzer-inline-svg-'));
  const images = [];
  let rewritten = input;
  sources.forEach((svg, offset) => {
    const index = offset + 1;
    const marker = `[[FIZZER_INLINE_SVG:${index}]]`;
    if (!rewritten.includes(marker)) return;
    const sourcePath = path.join(dir, `inline-${index}.svg`);
    try {
      fs.writeFileSync(sourcePath, svg, { mode: 0o600 });
      const png = new Resvg(svg).render().asPng();
      images.push({ media_type: 'image/png', data: Buffer.from(png).toString('base64') });
      rewritten = rewritten.replace(marker, INLINE_SVG_NOTE(sourcePath));
    } catch (error) {
      console.warn('[agent-runner] failed to render inline SVG:', error?.message || error);
      try { fs.rmSync(sourcePath, { force: true }); } catch { /* ignore */ }
      rewritten = rewritten.replace(marker, svg);
    }
  });

  if (!images.length) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    return { prompt: rewritten, images: [], cleanup: () => {} };
  }

  let cleaned = false;
  return {
    prompt: rewritten,
    images,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

/** Directory holding the agent helper CLIs; prefer source, fall back to dist. */
function resolveWrapperDir() {
  const candidates = [
    path.join(__dirname, '..', 'cli-agents'),
    path.join(__dirname, '..', 'dist', 'cli-agents'),
  ];
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'cascade-note'))) return dir;
    } catch { /* ignore */ }
  }
  return candidates[0];
}

function quoteSh(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function ensureExecutable(file) {
  try {
    if (!fs.existsSync(file)) return false;
    const current = fs.statSync(file).mode;
    fs.chmodSync(file, current | 0o755);
    return true;
  } catch (err) {
    console.warn('[agent-runner] failed to chmod helper:', file, err?.message || err);
    return false;
  }
}

function ensureUserBinWrapper(name, source) {
  try {
    fs.mkdirSync(USER_BIN_DIR, { recursive: true, mode: 0o755 });
    const target = path.join(USER_BIN_DIR, name);
    const contents = `#!/bin/sh\nexec node ${quoteSh(source)} "$@"\n`;
    let existing = '';
    try { existing = fs.readFileSync(target, 'utf8'); } catch { /* ignore */ }
    if (existing !== contents) fs.writeFileSync(target, contents, { mode: 0o755 });
    fs.chmodSync(target, 0o755);
    return true;
  } catch (err) {
    console.warn('[agent-runner] failed to install helper wrapper:', name, err?.message || err);
    return false;
  }
}

function ensureHelperInstall() {
  const dir = resolveWrapperDir();
  for (const name of HELPER_NAMES) {
    const source = path.join(dir, name);
    if (ensureExecutable(source)) ensureUserBinWrapper(name, source);
  }
}

/** Put wrappers on PATH (once) so agents can invoke `cascade-note`/`cascade-chat`. */
function ensureWrapperOnPath() {
  ensureHelperInstall();
  const dir = resolveWrapperDir();
  const parts = (process.env.PATH || '').split(path.delimiter);
  if (!parts.includes(dir)) process.env.PATH = [dir, ...parts].join(path.delimiter);
  for (const binDir of USER_EXEC_DIRS) {
    if (!parts.includes(binDir) && fs.existsSync(binDir)) {
      process.env.PATH = [binDir, process.env.PATH || ''].filter(Boolean).join(path.delimiter);
    }
  }
  process.env.CASCADE_HELPER_DIR = dir;
  process.env.CASCADE_HELPER_CONFIG = HELPER_CONFIG_PATH;
}

function chatTriggeringMessageId(opts) {
  return String(opts && opts.chatTriggeringMessageId || opts?.chat?.triggeringMessageId || '').trim();
}

/** Set the live API target/token the wrapper should use (call on runner connect). */
function setNoteApiConfig({ url, token } = {}) {
  if (typeof url === 'string') {
    noteApi.url = url.trim().replace(/\/$/, '');
    noteApi.configured = true;
  }
  if (typeof token === 'string') {
    noteApi.token = token.trim();
    noteApi.configured = true;
  }
}

/**
 * Inject helper env (target URL, token, current vault/channel) for a run, and
 * ensure it's on PATH. Vault is also stated in the prompt context, so the env
 * value is just a default the agent can override with --vault.
 */
function helperConfigPathForRun(runId) {
  const id = Number(runId);
  if (Number.isFinite(id) && id > 0) return path.join(RUN_CONTEXT_DIR, `${id}.json`);
  return HELPER_CONFIG_PATH;
}

function isExpiredJwt(token) {
  if (typeof token !== 'string' || !token) return true;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (typeof payload.exp === 'number') {
      return (Date.now() / 1000) > (payload.exp - 10);
    }
  } catch {
    return false;
  }
  return false;
}

function writeHelperConfig({ runId, vaultId, channelId, messageId, triggeringMessageId, chatAuthor, agentId, agentMemoryKey, registrationId, workItemId } = {}) {
  let token = noteApi.configured ? noteApi.token : (noteApi.token || process.env.CASCADE_NOTE_TOKEN || '');
  if (!token || isExpiredJwt(token)) {
    try {
      const diskTokenPath = path.join(os.homedir(), '.cascade', 'token');
      if (fs.existsSync(diskTokenPath)) {
        const dt = fs.readFileSync(diskTokenPath, 'utf8').trim();
        if (dt && !isExpiredJwt(dt)) token = dt;
      }
    } catch { /* ignore */ }
  }
  const payload = {
    url: noteApi.configured ? noteApi.url : (noteApi.url || process.env.CASCADE_NOTE_URL || 'https://cscd.online'),
    token,
    vaultId: vaultId || process.env.CASCADE_NOTE_VAULT || '',
    chatChannelId: channelId || process.env.CASCADE_CHAT_CHANNEL || '',
    chatMessageId: messageId || process.env.CASCADE_CHAT_MESSAGE || '',
    chatTriggeringMessageId: triggeringMessageId || process.env.CASCADE_CHAT_TRIGGERING_MESSAGE || '',
    chatAuthor: chatAuthor || process.env.CASCADE_CHAT_AUTHOR || '',
    agentId: agentId || '',
    agentMemoryKey: agentMemoryKey || '',
    registrationId: registrationId || '',
    workItemId: workItemId || '',
    runId: Number.isFinite(Number(runId)) ? Number(runId) : undefined,
    helperDir: resolveWrapperDir(),
    updatedAt: new Date().toISOString(),
  };
  const configPath = helperConfigPathForRun(runId);
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(configPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.chmodSync(configPath, 0o600);
    if (configPath !== HELPER_CONFIG_PATH) {
      fs.mkdirSync(path.dirname(HELPER_CONFIG_PATH), { recursive: true, mode: 0o700 });
      fs.writeFileSync(HELPER_CONFIG_PATH, JSON.stringify(payload, null, 2), { mode: 0o600 });
      fs.chmodSync(HELPER_CONFIG_PATH, 0o600);
    }
  } catch (err) {
    console.warn('[agent-runner] failed to write helper context:', err?.message || err);
  }
  return configPath;
}

/** Per-run env for helper CLIs so concurrent agents don't stomp each other's author. */
function buildRunHelperEnv(opts) {
  ensureWrapperOnPath();
  const runId = Number(opts?.runId);
  const vaultId = String(opts && opts.vaultId || '').trim();
  const channelId = String(opts && opts.chatChannelId || opts?.chat?.channelId || '').trim();
  const messageId = String(opts && opts.chatMessageId || opts?.chat?.messageId || '').trim();
  const triggeringMessageId = chatTriggeringMessageId(opts);
  const chatAuthor = String(opts && opts.chatAuthor || '').trim();
  const agentId = String(opts && opts.agent || '').trim();
  const agentMemoryKey = String(opts && opts.agentMemoryKey || '').trim();
  const registrationId = String(opts && opts.chatRegistrationId || '').trim();
  const workItemId = String(opts && opts.workItemId || '').trim();
  const configPath = writeHelperConfig({
    runId,
    vaultId,
    channelId,
    messageId,
    triggeringMessageId,
    chatAuthor,
    agentId,
    agentMemoryKey,
    registrationId,
    workItemId,
  });
  let token = noteApi.configured ? noteApi.token : (noteApi.token || process.env.CASCADE_NOTE_TOKEN || '');
  if (process.env.CASCADE_NOTE_TOKEN !== '' && (!token || isExpiredJwt(token))) {
    try {
      const diskTokenPath = path.join(os.homedir(), '.cascade', 'token');
      if (fs.existsSync(diskTokenPath)) {
        const dt = fs.readFileSync(diskTokenPath, 'utf8').trim();
        if (dt && !isExpiredJwt(dt)) token = dt;
      }
    } catch { /* ignore */ }
  }
  const env = {
    CASCADE_NOTE_URL: noteApi.configured ? noteApi.url : (noteApi.url || process.env.CASCADE_NOTE_URL || 'https://cscd.online'),
    CASCADE_NOTE_TOKEN: token,
    ...(noteApi.configured ? { CASCADE_NOTE_USER: '', CASCADE_NOTE_PASS: '' } : {}),
    CASCADE_HELPER_CONFIG: configPath,
    CASCADE_HELPER_DIR: resolveWrapperDir(),
    PATH: process.env.PATH || '',
  };
  if (!env.PATH.split(path.delimiter).includes(env.CASCADE_HELPER_DIR)) {
    env.PATH = [env.CASCADE_HELPER_DIR, env.PATH].filter(Boolean).join(path.delimiter);
  }
  for (const binDir of USER_EXEC_DIRS) {
    if (fs.existsSync(binDir) && !env.PATH.split(path.delimiter).includes(binDir)) {
      env.PATH = [binDir, env.PATH].filter(Boolean).join(path.delimiter);
    }
  }
  if (vaultId) env.CASCADE_NOTE_VAULT = vaultId;
  if (channelId) env.CASCADE_CHAT_CHANNEL = channelId;
  if (messageId) env.CASCADE_CHAT_MESSAGE = messageId;
  if (triggeringMessageId) env.CASCADE_CHAT_TRIGGERING_MESSAGE = triggeringMessageId;
  if (chatAuthor) env.CASCADE_CHAT_AUTHOR = chatAuthor;
  if (workItemId) env.CASCADE_WORK_ITEM_ID = workItemId;
  if (Number.isFinite(runId) && runId > 0) env.CASCADE_RUN_ID = String(runId);
  return env;
}

function cleanupRunHelperConfig(runId) {
  const id = Number(runId);
  if (!Number.isFinite(id) || id <= 0) return;
  try {
    fs.unlinkSync(helperConfigPathForRun(id));
  } catch { /* ignore */ }
}

/** True when cascade-chat send ran during this run (helper config flag). */
function readUsedChatSend(runId) {
  const id = Number(runId);
  if (!Number.isFinite(id) || id <= 0) return false;
  try {
    const raw = fs.readFileSync(helperConfigPathForRun(id), 'utf8');
    const parsed = JSON.parse(raw);
    // Ghost files that only contain { usedChatSend: true } (no vault/channel)
    // must not suppress the run bubble — that left empty "(message)" shells.
    if (!parsed || !parsed.usedChatSend) return false;
    const hasContext = Boolean(
      String(parsed.chatChannelId || parsed.vaultId || parsed.token || '').trim(),
    );
    return hasContext;
  } catch {
    return false;
  }
}

/**
 * Emit terminal status. When the agent already posted via cascade-chat send,
 * set suppressChatBody so the run-linked bubble does not also show stdout.
 */
function emitTerminalStatus(emit, runId, status, summary, sessionId) {
  const suppressChatBody = status === 'completed' && readUsedChatSend(runId);
  emit('status', {
    status,
    summary: summary || (status === 'completed' ? '' : status === 'canceled' ? 'Run canceled.' : 'Agent failed.'),
    ...(sessionId ? { sessionId } : {}),
    ...(suppressChatBody ? { suppressChatBody: true } : {}),
  });
}

/** True when this run was triggered from a chat channel (vs a note pane). */
function isChatRun(opts) {
  return Boolean(String(opts && opts.chatChannelId || opts?.chat?.channelId || '').trim());
}

/** One-line capability note for non-chat runs. Chat runs carry this in the user prompt. */
function noteCapabilityContext(opts) {
  const helperDir = resolveWrapperDir();
  const vaultId = String(opts && opts.vaultId || '').trim();
  const vaultLine = vaultId ? ` Vault: ${vaultId}.` : '';
  return `Live notes: \`cascade-note\` (not local .md; creates unlisted by default — use \`--listed\` only if the user asks for sidebar); durable memory: \`cascade-note memory\`; optional scratchpad: \`cascade-scratchpad jot\` for reusable root causes, decisions, or dead ends. Read and improve useful task-vault knowledge with judgment, including unexpected connections; preserve uncertainty and existing work within authorized scope.${vaultLine} Helpers on PATH and in ${helperDir}.`;
}

/** Permission rules for helper names plus the absolute paths agents may discover. */
function helperAllowedTools() {
  const helperDir = resolveWrapperDir();
  const commands = new Set();
  for (const name of HELPER_NAMES) {
    commands.add(name);
    commands.add(path.join(helperDir, name));
    commands.add(path.join(USER_BIN_DIR, name));
  }
  return [...commands].flatMap((command) => [
    `Bash(${command})`,
    `Bash(${command} *)`,
  ]);
}



// Live Claude CLI processes, keyed by runId, so cancellation can stop them.
const activeClaudeProcesses = new Map();
const canceledClaudeRuns = new Set();
const CLAUDE_STARTUP_TIMEOUT_MS = 45_000;

// Map Claude CLI stream message types to the run_event types expected
// by the chat renderer.
function classifySdkMessage(message) {
  if (message.type === 'assistant') return 'text';
  if (message.type === 'result') return 'result';
  if (message.type === 'system') return 'system';
  return message.type || 'message';
}

/** Emit a harness/terminal chunk for the chat terminal pane. */
function emitHarness(emit, data) {
  if (!data) return;
  emit('harness', { data: String(data) });
}

function formatToolInput(input) {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

/** One-line tool detail for the ordinary run trace (never raw protocol JSON). */
function formatToolHarnessPreview(input) {
  if (input == null) return '';
  let detail = '';
  if (typeof input === 'string') {
    detail = input;
  } else if (typeof input === 'object') {
    for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description']) {
      if (typeof input[key] === 'string' && input[key].trim()) {
        detail = input[key];
        break;
      }
    }
    if (!detail && !('_raw' in input)) detail = formatToolInput(input);
  } else {
    detail = String(input);
  }
  const oneLine = detail.replace(/\s+/g, ' ').trim();
  return oneLine.length > 200 ? `${oneLine.slice(0, 199)}…` : oneLine;
}

/**
 * Emit a machine-readable `# cascade-stats …` harness line for the chat UI.
 * Merges whatever fields we have (usage, context, rate limits) — the client
 * keeps the latest non-null values per field.
 */
function emitCascadeStats(emit, stats) {
  if (!emit || !stats || typeof stats !== 'object') return;
  // Drop undefined so the JSON stays compact and easy to merge.
  const clean = {};
  for (const [key, value] of Object.entries(stats)) {
    if (value !== undefined && value !== null && value !== '') clean[key] = value;
  }
  if (Object.keys(clean).length === 0) return;
  try {
    emitHarness(emit, `\x1b[2m# cascade-stats ${JSON.stringify(clean)}\x1b[0m\r\n`);
  } catch { /* ignore */ }
}

/** Pull context-window / turn / cost fields off a Claude CLI result message. */
function statsFromClaudeResult(message, model) {
  const usage = message.usage || {};
  const modelUsage = message.modelUsage && typeof message.modelUsage === 'object'
    ? message.modelUsage
    : {};
  // Prefer the entry matching the run model; else first modelUsage row.
  let mu = modelUsage[model];
  if (!mu) {
    const keys = Object.keys(modelUsage);
    mu = keys.length ? modelUsage[keys[0]] : null;
  }
  const contextWindow = numOrUndef(mu?.contextWindow);
  // Approximate filled context from last-turn API usage when the CLI doesn't
  // give an explicit total. Cache-read + input ≈ tokens in the window.
  const inputTokens = numOrUndef(usage.input_tokens) ?? numOrUndef(mu?.inputTokens);
  const outputTokens = numOrUndef(usage.output_tokens) ?? numOrUndef(mu?.outputTokens);
  const cacheRead = numOrUndef(usage.cache_read_input_tokens) ?? numOrUndef(mu?.cacheReadInputTokens);
  const cacheWrite = numOrUndef(usage.cache_creation_input_tokens) ?? numOrUndef(mu?.cacheCreationInputTokens);
  let contextUsed = null;
  if (inputTokens != null || cacheRead != null) {
    contextUsed = (inputTokens || 0) + (cacheRead || 0);
  }
  return {
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    totalCostUsd: numOrUndef(message.total_cost_usd) ?? numOrUndef(mu?.costUSD),
    numTurns: numOrUndef(message.num_turns),
    durationMs: numOrUndef(message.duration_ms),
    durationApiMs: numOrUndef(message.duration_api_ms),
    contextWindow,
    contextUsed: contextUsed ?? undefined,
    maxOutputTokens: numOrUndef(mu?.maxOutputTokens),
  };
}

function numOrUndef(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

/** Normalize a Claude rate_limit_event into cascade-stats fields. */
function statsFromRateLimitInfo(info) {
  if (!info || typeof info !== 'object') return null;
  const out = {
    rateLimitStatus: info.status || undefined,
    rateLimitType: info.rateLimitType || undefined,
    rateLimitUtilization: numOrUndef(info.utilization),
    rateLimitResetsAt: info.resetsAt != null
      ? (typeof info.resetsAt === 'number'
        ? new Date(info.resetsAt * (info.resetsAt < 1e12 ? 1000 : 1)).toISOString()
        : String(info.resetsAt))
      : undefined,
    overageStatus: info.overageStatus || undefined,
    overageInUse: info.isUsingOverage === true || info.overageInUse === true ? true : undefined,
  };
  if (Object.values(out).every((v) => v === undefined)) return null;
  return out;
}

function expandHome(input) {
  const value = String(input || '').trim();
  if (!value) return '';
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function normalizeClaudeEffort(value, fallback = 'medium') {
  const effort = String(value || '').trim().toLowerCase();
  return ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort) ? effort : fallback;
}

function isMissingClaudeSession(error) {
  return /no conversation found with session id/i.test(error instanceof Error ? error.message : String(error || ''));
}

function resolveAgentCwd(inputCwd, vaultRoot) {
  const expanded = expandHome(inputCwd);
  if (expanded) {
    const resolved = path.resolve(expanded);
    try {
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) return resolved;
    } catch {
      // fall through
    }
  }
  const root = String(vaultRoot || '').trim();
  if (root) {
    const resolvedRoot = path.resolve(root);
    try {
      if (fs.existsSync(resolvedRoot) && fs.statSync(resolvedRoot).isDirectory()) return resolvedRoot;
    } catch {
      // fall through
    }
  }
  return os.homedir();
}

let warnedStaleCliAgentBuildAt = 0;

/**
 * CLI agents run from `dist/`, never from the TypeScript sources. Editing
 * `cli-agents/cli-agent.ts` without rebuilding therefore changes nothing at
 * runtime, and the symptom is indistinguishable from the fix not working. Say
 * so out loud instead of silently running last build's code.
 */
function warnIfCliAgentBuildIsStale(modPath, builtMtimeMs) {
  const srcPath = path.join(__dirname, '..', 'cli-agents', 'cli-agent.ts');
  let srcMtimeMs = 0;
  try { srcMtimeMs = fs.statSync(srcPath).mtimeMs; } catch { return; }
  if (!builtMtimeMs || srcMtimeMs <= builtMtimeMs) return;
  // Once a minute is enough; this is checked before every CLI launch.
  if (Date.now() - warnedStaleCliAgentBuildAt < 60_000) return;
  warnedStaleCliAgentBuildAt = Date.now();
  console.warn(
    `[agent-runner] STALE BUILD: ${srcPath} is newer than ${modPath}. `
    + 'CLI agents are running the previous build — run `npm run build` to apply your changes.',
  );
}

async function loadCliAgentModule() {
  const modPath = path.join(__dirname, '..', 'dist', 'cli-agents', 'cli-agent.js');
  // Bust cache when dist rebuilds so harness fixes apply without killing Electron.
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(modPath).mtimeMs; } catch { /* ignore */ }
  warnIfCliAgentBuildIsStale(modPath, mtimeMs);
  if (!cliAgentModulePromise) {
    cliAgentModuleMtimeMs = mtimeMs;
    const href = pathToFileURL(modPath).href + `?t=${mtimeMs || Date.now()}`;
    cliAgentModulePromise = import(href);
  } else if (cliAgentModuleMtimeMs !== mtimeMs && activeCliAgentModules.size === 0) {
    // A cache-busted ESM import creates a second module singleton. Shut down
    // the idle warm app-server before replacing it; otherwise both children
    // retain writer leases for different copies of the same session.
    const previousModule = cliAgentModulePromise;
    cliAgentModuleMtimeMs = mtimeMs;
    const href = pathToFileURL(modPath).href + `?t=${mtimeMs || Date.now()}`;
    cliAgentModulePromise = (async () => {
      // A build can fail to import while this checkout is being edited. Its
      // rejected promise must not prevent loading the next corrected build.
      const previous = await previousModule.catch(() => null);
      previous?.shutdownPersistentCliAgents?.();
      return import(href);
    })();
  }
  const mod = await cliAgentModulePromise;
  // Run before every CLI launch, not just module import. That makes recovery
  // deterministic in tests and also cleans up a prior runner host that died
  // without requiring an entire Electron relaunch.
  if (typeof mod.reapOrphanedCliAgentProcesses === 'function') {
    const reaped = await mod.reapOrphanedCliAgentProcesses();
    if (Array.isArray(reaped) && reaped.length > 0) {
      console.warn(`[agent-runner] reaped orphaned CLI runs after desktop crash: ${reaped.join(', ')}`);
    }
  }
  return mod;
}

/**
 * Run Claude locally via the installed CLI, translating its JSON message stream into
 * the same run_events the renderer already understands. Auth comes from this
 * machine's `claude` login / ANTHROPIC_API_KEY.
 */
async function runClaudeLocally(opts, emit) {
  const runId = Number(opts.runId);
  const helperEnv = buildRunHelperEnv(opts);
  const cwd = resolveAgentCwd(opts.cwd, opts.vaultRoot);
  const model = (typeof opts.model === 'string' && opts.model.trim()) ? opts.model.trim() : CLAUDE_DEFAULT_MODEL;
  const chatRun = isChatRun(opts);
  const effort = normalizeClaudeEffort(
    opts.reasoningEffort,
    normalizeClaudeEffort(chatRun ? CLAUDE_CHAT_EFFORT : CLAUDE_EFFORT),
  );
  const resumeSessionId = (typeof opts.resumeSessionId === 'string' && opts.resumeSessionId) ? opts.resumeSessionId : undefined;
  const images = Array.isArray(opts.images)
    ? opts.images.filter((im) => im && typeof im.media_type === 'string' && typeof im.data === 'string')
    : [];

  // With images, send a structured user message (text + image blocks);
  // otherwise a plain string prompt.
  const claudePrompt = images.length
    ? [
        { type: 'text', text: opts.prompt },
        ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } })),
      ]
    : opts.prompt;

  const args = [
    '--print',
    '--verbose',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--model', model,
    '--effort', effort,
    '--permission-mode', opts.yolo ? 'bypassPermissions' : 'acceptEdits',
    '--allowedTools', helperAllowedTools().join(','),
    '--append-system-prompt', chatRun
      ? `${CHAT_BREVITY_CONTEXT} ${CHAT_CONTEXT_TOOL_CONTEXT}`
      : `${CLAUDE_AGENT_CONTEXT} ${noteCapabilityContext(opts)}`,
    ...(opts.yolo ? ['--allow-dangerously-skip-permissions'] : []),
    ...(resumeSessionId ? ['--resume', resumeSessionId] : []),
  ];
  if (images.length) args.push('--input-format', 'stream-json');
  else args.push(String(claudePrompt));

  const { createRequestTiming } = await loadCliAgentModule();
  const timing = createRequestTiming(emit, 'claude_cli_stdout');
  const child = spawn(process.env.CLAUDE_BIN || 'claude', args, {
    cwd,
    env: { ...process.env, ...helperEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.once('data', () => timing.firstResponse());
  activeClaudeProcesses.set(runId, child);
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => {
    child.once('error', (error) => { timing.complete('launch_failed'); resolve({ error }); });
    child.once('close', (code, signal) => {
      timing.complete(signal ? 'signaled' : code === 0 ? 'completed' : 'failed');
      resolve({ code, signal });
    });
  });
  if (images.length) {
    child.stdin.end(`${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: claudePrompt },
      parent_tool_use_id: null,
      session_id: resumeSessionId || '',
    })}\n`);
  } else {
    child.stdin.end();
  }
  const stream = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

  let sawClaudeMessage = false;
  let startupTimedOut = false;
  const startupTimer = setTimeout(() => {
    if (sawClaudeMessage || canceledClaudeRuns.has(runId)) return;
    startupTimedOut = true;
    try { child.kill('SIGTERM'); } catch { /* best effort */ }
  }, CLAUDE_STARTUP_TIMEOUT_MS);
  let summary = '';
  let streamedText = '';
  let latestAssistantText = '';
  let sessionId;
  // Tracks whether the previous streamed block was text, so a new text block
  // (a fresh turn, typically split off by a tool call in between) gets a
  // paragraph break instead of being glued onto the prior turn's text.
  let lastBlockWasText = false;
  let harnessInThinking = false;
  // Accumulate tool_use JSON from stream deltas so the chat UI gets structured
  // tool cards (assistant complete messages are skipped to avoid double text).
  /** @type {{ id: string, name: string, json: string } | null} */
  let pendingTool = null;
  emitHarness(emit, `\x1b[2m# claude-code ${model} · ${cwd}\x1b[0m\r\n`);
  emitCascadeStats(emit, { model });
  try {
    for await (const line of stream) {
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { continue; }
      sawClaudeMessage = true;
      clearTimeout(startupTimer);
      if (message.session_id && message.session_id !== sessionId) {
        sessionId = message.session_id;
        emit('session', { sessionId });
      }

      // Subscription rate-limit telemetry (claude.ai plans). Sparse but useful.
      if (message.type === 'rate_limit_event') {
        const rl = statsFromRateLimitInfo(message.rate_limit_info);
        if (rl) emitCascadeStats(emit, rl);
        continue;
      }

      // Partial streaming: translate token-level deltas into the same
      // { message: { content: [...] } } shape the chat accumulators expect,
      // routing thinking_delta → a thinking block and text_delta → a text
      // block. The assembled `assistant` message is skipped below so its
      // content isn't appended a second time on top of these deltas.
      // Also tee a human-readable transcript into the harness terminal pane.
      if (message.type === 'stream_event') {
        const ev = message.event;
        if (ev?.type === 'message_start') {
          // Keep the latest inference's answer separate from earlier progress
          // narration. The terminal summary becomes the clean chat body.
          latestAssistantText = '';
        } else if (ev?.type === 'content_block_start') {
          const block = ev.content_block;
          const blockType = block?.type;
          if (blockType === 'thinking' || blockType === 'redacted_thinking') {
            if (!harnessInThinking) {
              emitHarness(emit, '\x1b[2m# thinking\x1b[0m\r\n');
              harnessInThinking = true;
            }
            if (blockType === 'redacted_thinking') {
              emit('text', { message: { content: [{ type: 'redacted_thinking' }] } });
              emitHarness(emit, '\x1b[2m[redacted]\x1b[0m');
              lastBlockWasText = false;
            }
          } else if (blockType === 'tool_use') {
            harnessInThinking = false;
            const name = block?.name || 'tool';
            const id = block?.id || `tool-${Date.now()}`;
            pendingTool = { id, name, json: '' };
            // Emit early so the timeline shows the tool while args stream in.
            emit('text', {
              message: {
                content: [{ type: 'tool_use', id, name, input: block?.input && Object.keys(block.input).length ? block.input : {} }],
              },
            });
            const inputPreview = formatToolInput(block?.input);
            emitHarness(emit, `\x1b[36m▶ ${name}\x1b[0m${inputPreview ? ` ${inputPreview.slice(0, 200)}` : ''}\r\n`);
            lastBlockWasText = false;
          } else if (blockType === 'text') {
            if (harnessInThinking) {
              emitHarness(emit, '\r\n');
              harnessInThinking = false;
            }
            if (lastBlockWasText) {
              // Separate this turn's text from the previous one.
              emit('text', { chatVisible: true, message: { content: [{ type: 'text', text: '\n\n' }] } });
              emitHarness(emit, '\r\n\r\n');
              streamedText += '\n\n';
            }
          }
        } else if (ev?.type === 'content_block_delta') {
          const delta = ev.delta;
          if (delta?.type === 'thinking_delta' && delta.thinking) {
            emit('text', { message: { content: [{ type: 'thinking', thinking: delta.thinking }] } });
            emitHarness(emit, `\x1b[2m${delta.thinking}\x1b[0m`);
            lastBlockWasText = false;
          } else if (delta?.type === 'text_delta' && delta.text) {
            // Thinking uses the distinct structured block above; text deltas
            // are assistant-visible prose and can stream into chat.
            emit('text', { chatVisible: true, message: { content: [{ type: 'text', text: delta.text }] } });
            emitHarness(emit, delta.text);
            streamedText += delta.text;
            latestAssistantText += delta.text;
            lastBlockWasText = true;
          } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
            if (pendingTool) pendingTool.json += delta.partial_json;
            // Partial JSON is protocol framing, not a readable progress line.
            // The completed structured tool_use below owns the parsed input.
          }
        } else if (ev?.type === 'content_block_stop') {
          if (harnessInThinking) {
            emitHarness(emit, '\r\n');
            harnessInThinking = false;
          }
          if (pendingTool) {
            let input = {};
            if (pendingTool.json) {
              try {
                input = JSON.parse(pendingTool.json);
              } catch {
                input = { _raw: pendingTool.json };
              }
            }
            const inputPreview = formatToolHarnessPreview(input);
            if (inputPreview) {
              emitHarness(emit, `\r\n\x1b[36m▶ ${pendingTool.name}\x1b[0m ${inputPreview}\r\n`);
            }
            emit('text', {
              message: {
                content: [{
                  type: 'tool_use',
                  id: pendingTool.id,
                  name: pendingTool.name,
                  input,
                }],
              },
            });
            pendingTool = null;
          }
        }
        continue;
      }

      // The complete assistant message duplicates the streamed deltas above.
      if (message.type === 'assistant') continue;

      // Tool results and other non-streamed messages → harness + structured events.
      if (message.type === 'user' && message.message?.content) {
        const content = Array.isArray(message.message.content) ? message.message.content : [];
        for (const block of content) {
          if (block?.type === 'tool_result') {
            const body = typeof block.content === 'string'
              ? block.content
              : formatToolInput(block.content);
            const flag = block.is_error ? '\x1b[31m✗' : '\x1b[32m✓';
            const preview = String(body || '').slice(0, 4000);
            emitHarness(emit, `${flag} tool_result\x1b[0m\r\n${preview}\r\n`);
            if (block.is_error) {
              // Auto-capture tool friction into the scratchpad journal (papercut).
              void import(pathToFileURL(path.join(resolveWrapperDir(), 'auto-papercut.mjs')).href)
                .then((mod) => mod.autoPapercut(preview, { tool: 'tool_result' }))
                .catch(() => {});
            }
          }
        }
      } else if (message.type === 'result') {
        emitHarness(emit, `\x1b[2m# result ${message.subtype || message.result || 'done'}\x1b[0m\r\n`);
        emitCascadeStats(emit, statsFromClaudeResult(message, model));
      } else if (message.type === 'system') {
        emitHarness(emit, `\x1b[2m# system ${message.subtype || ''}\x1b[0m\r\n`);
      }

      emit(classifySdkMessage(message), message);
      if (message.type === 'result') summary = message.result || message.subtype || summary;
    }
    const { code, signal, error: launchError } = await exited;
    if (launchError) throw launchError;
    if (code !== 0 && !canceledClaudeRuns.has(runId) && !startupTimedOut) {
      throw new Error(stderr.trim() || `Claude CLI exited with ${signal || `code ${code}`}.`);
    }
  } catch (error) {
    throw error;
  } finally {
    clearTimeout(startupTimer);
    activeClaudeProcesses.delete(runId);
  }
  if (canceledClaudeRuns.has(runId)) {
    const error = new Error('Run canceled.');
    error.cascadeCanceled = true;
    throw error;
  }
  if (startupTimedOut) {
    const error = new Error('Claude produced no startup event; retrying the session.');
    error.cascadeStartupTimeout = true;
    throw error;
  }
  // Chat runs prefer streamed assistant text over the CLI's generic result.
  // Non-chat note runs keep the CLI result as the summary for the run list.
  if (chatRun && (latestAssistantText.trim() || streamedText.trim())) {
    return { summary: latestAssistantText.trim() || streamedText.trim(), sessionId };
  }
  return { summary: summary || streamedText.trim() || '', sessionId };
}

/**
 * Start an agent run locally. Events are delivered via `sendEvent`.
 * Resolves when the run finishes (success or failure).
 */
async function startLocalAgentRun(opts, sendEvent) {
  const runId = Number(opts.runId);
  if (!Number.isFinite(runId)) throw new Error('Invalid run id');

  const agent = String(opts.agent || '').trim();
  const rawPrompt = String(opts.prompt || '').trim();
  if (!agent) throw new Error('Agent is required');
  if (!rawPrompt) throw new Error('Prompt is required');

  const preparedPrompt = renderInlineSvgAttachments(rawPrompt, opts.inlineSvgs);
  const prompt = preparedPrompt.prompt;
  const images = [
    ...(Array.isArray(opts.images) ? opts.images : []),
    ...preparedPrompt.images,
  ];

  let seq = 0;
  const emit = (type, payload) => {
    sendEvent({
      runId,
      seq: ++seq,
      type,
      payload_json: JSON.stringify(payload),
    });
  };

  emit('status', { status: 'running' });
  const heartbeat = setInterval(() => emit('heartbeat', {}), 15_000);
  heartbeat.unref?.();

  if (agent === 'claude-code') {
    let resume = typeof opts.resumeSessionId === 'string' ? opts.resumeSessionId : undefined;
    let runPrompt = prompt;
    let startupRetries = 0;
    let staleSessionRetried = false;
    canceledClaudeRuns.delete(runId);
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        try {
          const result = await runClaudeLocally({ ...opts, prompt: runPrompt, images, resumeSessionId: resume }, emit);
          emitTerminalStatus(emit, runId, 'completed', result.summary, result.sessionId);
          return { sessionId: result.sessionId };
        } catch (error) {
          if (error?.cascadeCanceled || canceledClaudeRuns.has(runId)) {
            emitTerminalStatus(emit, runId, 'canceled', 'Run canceled.', error?.cascadeSessionId);
            return { canceled: true };
          }
          if (error?.cascadeStartupTimeout && startupRetries < 1) {
            startupRetries += 1;
            emitHarness(emit, '\x1b[2m# Claude did not start — retrying once\x1b[0m\r\n');
            continue;
          }
          // Session ids are local to the owner's Claude installation. If an
          // agent was previously misrouted to another machine, discard that
          // foreign id and start the requested turn fresh once.
          if (resume && !staleSessionRetried && isMissingClaudeSession(error)) {
            staleSessionRetried = true;
            resume = undefined;
            runPrompt = prompt;
            emitHarness(emit, '\x1b[2m# Claude session is not present on this machine — starting fresh\x1b[0m\r\n');
            continue;
          }
          const message = error instanceof Error ? error.message : String(error);
          emitTerminalStatus(emit, runId, 'failed', message, error?.cascadeSessionId);
          throw error;
        }
      }
    } finally {
      clearInterval(heartbeat);
      canceledClaudeRuns.delete(runId);
      cleanupRunHelperConfig(runId);
      preparedPrompt.cleanup();
    }
  }

  let cliModule;
  try {
    cliModule = await loadCliAgentModule();
    const { runCliAgent } = cliModule;
    activeCliAgentModules.set(runId, cliModule);
    const selfContained = opts.contextMode === 'self-contained';
    const helperEnv = selfContained ? {} : buildRunHelperEnv(opts);
    const cwd = resolveAgentCwd(opts.cwd, opts.vaultRoot);
    const env = { ...process.env, ...helperEnv };

    const result = await runCliAgent({
      agent,
      context: isChatRun(opts) || selfContained ? '' : `${CLAUDE_AGENT_CONTEXT} ${noteCapabilityContext(opts)}`,
      userPrompt: prompt,
      cwd,
      resumeSessionId: typeof opts.resumeSessionId === 'string' ? opts.resumeSessionId : undefined,
      images,
      model: typeof opts.model === 'string' ? opts.model : undefined,
      reasoningEffort: typeof opts.reasoningEffort === 'string' ? opts.reasoningEffort : undefined,
      priorityServiceTier: opts.priorityServiceTier === true,
      sandbox: selfContained && opts.sandbox === 'read-only' ? 'read-only' : undefined,
      yolo: opts.yolo === true,
      hermesProfile: typeof opts.hermesProfile === 'string' ? opts.hermesProfile : undefined,
      hermesSafeMode: opts.hermesSafeMode === true,
      runId,
      emit,
      env,
    });
    emitTerminalStatus(emit, runId, 'completed', result.summary || '', result.sessionId);
    return { sessionId: result.sessionId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (canceledCliRuns.has(runId)) {
      emitTerminalStatus(emit, runId, 'canceled', 'Run canceled.');
      return {};
    }
    emitTerminalStatus(emit, runId, 'failed', message);
    throw error;
  } finally {
    canceledCliRuns.delete(runId);
    clearInterval(heartbeat);
    if (activeCliAgentModules.get(runId) === cliModule) activeCliAgentModules.delete(runId);
    cleanupRunHelperConfig(runId);
    preparedPrompt.cleanup();
  }
}

const canceledCliRuns = new Set();

async function cancelLocalAgentRun(runId) {
  const id = Number(runId);

  // Claude CLI runs: terminate the live child process.
  const claudeProcess = activeClaudeProcesses.get(id);
  if (claudeProcess) {
    canceledClaudeRuns.add(id);
    try { claudeProcess.kill('SIGTERM'); } catch { /* ignore */ }
    activeClaudeProcesses.delete(id);
    return true;
  }

  const mod = activeCliAgentModules.get(id) || await loadCliAgentModule();
  if (activeCliAgentModules.has(id)) canceledCliRuns.add(id);
  // Antigravity keeps polling transcript.jsonl after agentapi exits — flag it.
  let flagged = false;
  if (typeof mod.cancelAntigravityRun === 'function') {
    try { mod.cancelAntigravityRun(id); flagged = true; } catch { /* ignore */ }
  }
  if (typeof mod.cancelCliAgentRun === 'function') {
    try {
      if (mod.cancelCliAgentRun(id)) return true;
    } catch { /* fall through to legacy direct-child cancellation */ }
  }
  const child = mod.activeCliProcesses?.get(id);
  if (child) {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    mod.activeCliProcesses.delete(id);
    return true;
  }
  return flagged;
}

/** Reap detached CLI groups left behind by a prior crashed Electron main. */
async function reapOrphanedLocalAgentRuns() {
  await loadCliAgentModule();
}

module.exports = {
  startLocalAgentRun,
  cancelLocalAgentRun,
  reapOrphanedLocalAgentRuns,
  buildRunHelperEnv,
  cleanupRunHelperConfig,
  chatTriggeringMessageId,
  helperAllowedTools,
  normalizeClaudeEffort,
  formatToolHarnessPreview,
  renderInlineSvgAttachments,
  isMissingClaudeSession,
  resolveAgentCwd,
  setNoteApiConfig,
};
