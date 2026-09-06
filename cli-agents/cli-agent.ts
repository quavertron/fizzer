/**
 * @file cli-agent.ts — local Codex/Grok/Antigravity/Copilot CLI wrappers
 *
 * Drives the locally-installed Codex and Grok agent CLIs as alternate
 * backends for AI-powered note editing. Both agents authenticate via the
 * user's own CLI logins (subscriptions) — no API keys needed.
 *
 * Each CLI is spawned as a child process in the vault directory with JSON
 * output mode enabled. Their JSONL event streams are translated on-the-fly
 * into a **unified event schema** the chat UI already renders:
 *
 * ```
 * emit('text', { message: { content: ContentBlock[] } })
 * emit('user', { message: { content: ContentBlock[] } })  // tool results
 *
 * ContentBlock =
 *   | { type: 'text', text: string }
 *   | { type: 'thinking', thinking?: string, text?: string }
 *   | { type: 'redacted_thinking' }
 *   | { type: 'tool_use', id, name, input }
 *   | { type: 'tool_result', tool_use_id, content, is_error? }
 * ```
 *
 * Terminal status is emitted by agent-runner.cjs (not this module):
 *   emit('status', { status: 'completed'|'failed'|'canceled', summary, sessionId? })
 *
 * ## Per-agent event fidelity
 *
 * | Agent        | text | thinking | tool_use | tool_result | images | resume |
 * |--------------|------|----------|----------|-------------|--------|--------|
 * | claude-code  | yes  | yes      | yes*     | yes*        | yes    | yes    |
 * | codex        | yes  | yes      | yes      | yes         | yes    | yes    |
 * | grok         | yes  | yes      | no†      | no†         | no     | yes    |
 * | copilot      | yes  | partial  | partial  | partial     | no     | yes    |
 * | hermes       | yes  | partial  | partial  | partial     | no     | yes    |
 * | antigravity  | yes  | yes‡     | yes‡     | yes‡       | no     | yes    |
 *
 * \* Claude tools surface via SDK messages; cascade-* helpers are auto-allowed.
 * † Grok runs tools silently — not surfaced in the JSONL stream.
 * ‡ Antigravity: transcript.jsonl → thinking/tool_use/tool_result + formatted harness.
 *
 * **Codex JSONL translation** (`codex exec --json`):
 *   - `thread.started`   → captures session id for conversation resume
 *   - `item.started`     → emits a `tool_use` block (Bash / Edit / etc.)
 *   - `item.completed`:
 *     - `agent_message`  → emits a `text` block
 *     - `reasoning`      → emits a `thinking` block
 *     - tool items       → emits a `tool_result` block (with is_error flag)
 *
 * **Grok JSONL translation** (`grok --output-format streaming-json`):
 *   - `thought` tokens   → accumulated, then flushed as a single `thinking` block
 *   - `text` tokens      → accumulated into the answer text
 *   - `end`              → emits final `text` block, captures session id
 *
 * @module cli-agents/cli-agent
 */

import { spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const activeCliProcesses = new Map<number, ChildProcess>();
const activePersistentCancels = new Map<number, () => void>();
const groupedCliProcesses = new Set<number>();
const agentProcessLeaseDir = process.env.CASCADE_AGENT_PROCESS_DIR
  || path.join(os.homedir(), '.cascade', 'agent-processes');

type AgentProcessLease = {
  version: 1;
  runId: number;
  ownerPid: number;
  ownerStartTicks: string;
  processGroupId: number;
  token: string;
  label: string;
};

function processStartTicks(pid: number): string {
  if (process.platform !== 'linux' || !Number.isInteger(pid) || pid <= 0) return '';
  try {
    // The command name can contain spaces and parentheses. Field 22 starts
    // twenty fields after the final ')' in /proc/<pid>/stat.
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19] || '';
  } catch {
    return '';
  }
}

function leasePath(runId: number): string {
  return path.join(agentProcessLeaseDir, `${runId}.json`);
}

function writeAgentProcessLease(lease: AgentProcessLease): void {
  fs.mkdirSync(agentProcessLeaseDir, { recursive: true, mode: 0o700 });
  const target = leasePath(lease.runId);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(lease), { mode: 0o600 });
  fs.renameSync(temporary, target);
}

function clearAgentProcessLease(runId: number): void {
  try { fs.unlinkSync(leasePath(runId)); } catch { /* already absent */ }
}

function processHasLeaseToken(pid: number, runId: number, token: string): boolean {
  if (process.platform !== 'linux') return false;
  try {
    const env = fs.readFileSync(`/proc/${pid}/environ`);
    const entries = env.toString().split('\0');
    return entries.includes(`CASCADE_RUN_ID=${runId}`)
      && entries.includes(`CASCADE_AGENT_PROCESS_TOKEN=${token}`);
  } catch {
    return false;
  }
}

function processGroupIdOf(pid: number): number {
  if (process.platform !== 'linux' || !Number.isInteger(pid) || pid <= 0) return 0;
  try {
    // Field 5 (pgrp) is the fourth whitespace-separated field after the
    // final ')' of /proc/<pid>/stat (comm may contain spaces/parens).
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    const pgid = Number(fields[3]);
    return Number.isInteger(pgid) && pgid > 1 ? pgid : 0;
  } catch {
    return 0;
  }
}

/**
 * Find a live process that still carries this run's ownership token.
 *
 * Prefer members of the recorded process group. The group leader can die while
 * hermes/bridge descendants remain (still token-bearing), so a leader-only
 * environ check would drop the lease and leave orphans.
 */
function findLeaseTokenProcess(runId: number, token: string, preferredPgid?: number): number {
  if (process.platform !== 'linux') return 0;
  if (preferredPgid && preferredPgid > 1 && processHasLeaseToken(preferredPgid, runId, token)) {
    return preferredPgid;
  }
  let names: string[] = [];
  try { names = fs.readdirSync('/proc'); } catch { return 0; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 1) continue;
    if (preferredPgid && preferredPgid > 1) {
      const pgid = processGroupIdOf(pid);
      if (pgid !== preferredPgid) continue;
    }
    if (processHasLeaseToken(pid, runId, token)) return pid;
  }
  // Preferred group emptied or leader-only PID reused: any token holder still
  // proves this run is live (and supplies a group to kill).
  if (preferredPgid && preferredPgid > 1) {
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      if (!Number.isInteger(pid) || pid <= 1) continue;
      if (processHasLeaseToken(pid, runId, token)) return pid;
    }
  }
  return 0;
}

function readAgentProcessLease(runId: number): AgentProcessLease | null {
  try {
    const lease = JSON.parse(fs.readFileSync(leasePath(runId), 'utf8')) as AgentProcessLease;
    const valid = lease?.version === 1
      && Number.isInteger(lease.runId) && lease.runId === runId
      && Number.isInteger(lease.ownerPid) && lease.ownerPid > 1
      && Number.isInteger(lease.processGroupId) && lease.processGroupId > 1
      && typeof lease.ownerStartTicks === 'string' && lease.ownerStartTicks.length > 0
      && typeof lease.token === 'string' && lease.token.length >= 16;
    return valid ? lease : null;
  } catch {
    return null;
  }
}

function processIsSameOwner(lease: AgentProcessLease): boolean {
  const currentStart = processStartTicks(lease.ownerPid);
  return Boolean(currentStart && currentStart === lease.ownerStartTicks);
}

function terminateProcessGroup(pgid: number): void {
  if (!Number.isInteger(pgid) || pgid <= 1 || process.platform === 'win32') return;
  try { process.kill(-pgid, 'SIGTERM'); } catch { /* already gone */ }
  const forceKill = setTimeout(() => {
    try { process.kill(-pgid, 0); process.kill(-pgid, 'SIGKILL'); } catch { /* settled */ }
  }, 5_000);
  forceKill.unref?.();
}

async function terminateProcessGroupHard(pgid: number): Promise<void> {
  if (!Number.isInteger(pgid) || pgid <= 1 || process.platform === 'win32') return;
  try { process.kill(-pgid, 'SIGTERM'); } catch { /* already gone */ }
  await new Promise((resolve) => setTimeout(resolve, 250));
  try { process.kill(-pgid, 0); process.kill(-pgid, 'SIGKILL'); } catch { /* settled */ }
}

/**
 * Kill detached CLI groups whose owning Electron main process crashed.
 *
 * Detached launchers survive a hard Electron exit and are adopted by PID 1.
 * The token check prevents a stale/forged lease from targeting an unrelated
 * process group after PID reuse.
 */
export async function reapOrphanedCliAgentProcesses(): Promise<number[]> {
  if (process.platform !== 'linux') return [];
  let files: string[] = [];
  try { files = fs.readdirSync(agentProcessLeaseDir).filter((name) => name.endsWith('.json')); } catch { return []; }
  const reaped: number[] = [];
  for (const file of files) {
    const target = path.join(agentProcessLeaseDir, file);
    let lease: AgentProcessLease | null = null;
    try { lease = JSON.parse(fs.readFileSync(target, 'utf8')) as AgentProcessLease; } catch { /* invalid lease */ }
    const valid = lease?.version === 1
      && Number.isInteger(lease.runId) && lease.runId > 0
      && Number.isInteger(lease.ownerPid) && lease.ownerPid > 1
      && Number.isInteger(lease.processGroupId) && lease.processGroupId > 1
      && typeof lease.ownerStartTicks === 'string' && lease.ownerStartTicks.length > 0
      && typeof lease.token === 'string' && lease.token.length >= 16;
    if (!valid || !lease) {
      try { fs.unlinkSync(target); } catch { /* ignore */ }
      continue;
    }
    if (processIsSameOwner(lease)) continue;
    const tokenPid = findLeaseTokenProcess(lease.runId, lease.token, lease.processGroupId);
    if (!tokenPid) {
      try { fs.unlinkSync(target); } catch { /* stale */ }
      continue;
    }
    const pgid = processGroupIdOf(tokenPid) || lease.processGroupId;
    await terminateProcessGroupHard(pgid);
    try { fs.unlinkSync(target); } catch { /* ignore */ }
    reaped.push(lease.runId);
  }
  return reaped;
}

function terminateCliProcess(child: ChildProcess, processGroup: boolean): void {
  if (processGroup && process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM');
      return;
    } catch { /* Fall through if the group already disappeared. */ }
  }
  try { child.kill('SIGTERM'); } catch { /* already settled */ }
}

function terminateCliProcessWithEscalation(child: ChildProcess, processGroup: boolean): void {
  terminateCliProcess(child, processGroup);
  const forceKill = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (processGroup && process.platform !== 'win32' && child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); return; } catch { /* fall through */ }
    }
    try { child.kill('SIGKILL'); } catch { /* already settled */ }
  }, 5_000);
  forceKill.unref?.();
}

/**
 * Stop a run using only its durable lease — used when module reload lost the
 * in-memory ChildProcess map, or when cancel races a reaped map entry.
 */
function cancelCliAgentRunFromLease(runId: number): boolean {
  if (process.platform !== 'linux') return false;
  const lease = readAgentProcessLease(runId);
  if (!lease) return false;
  const tokenPid = findLeaseTokenProcess(lease.runId, lease.token, lease.processGroupId);
  if (!tokenPid) {
    clearAgentProcessLease(runId);
    return false;
  }
  const pgid = processGroupIdOf(tokenPid) || lease.processGroupId;
  terminateProcessGroup(pgid);
  activeCliProcesses.delete(runId);
  groupedCliProcesses.delete(runId);
  clearAgentProcessLease(runId);
  return true;
}

/** Cancel one CLI run, including descendants of launchers such as Akron. */
export function cancelCliAgentRun(runId: number): boolean {
  const persistentCancel = activePersistentCancels.get(runId);
  if (persistentCancel) {
    persistentCancel();
    activePersistentCancels.delete(runId);
    return true;
  }
  const child = activeCliProcesses.get(runId);
  if (!child) return cancelCliAgentRunFromLease(runId);
  const processGroup = groupedCliProcesses.has(runId);
  terminateCliProcessWithEscalation(child, processGroup);
  activeCliProcesses.delete(runId);
  groupedCliProcesses.delete(runId);
  clearAgentProcessLease(runId);
  return true;
}

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export type AgentEmit = (type: 'text' | 'user' | 'harness' | 'session' | 'timing', payload: unknown) => void;
export type CliImage = { media_type: string; data: string };

/** Runner-clock observations, not provider queue or model execution measurements. */
export function createRequestTiming(emit: AgentEmit | undefined, boundary: string) {
  const requestId = randomBytes(12).toString('hex');
  const started = performance.now();
  let responded = false;
  let completed = false;
  const record = (phase: string, observation = { at: new Date().toISOString(), monotonic: performance.now() }, outcome?: string) => {
    emit?.('timing', { requestId, boundary, phase, observedAt: observation.at,
      elapsedMs: Math.max(0, observation.monotonic - started), ...(outcome ? { outcome } : {}) });
  };
  record('request_start');
  return {
    firstResponse(observation?: { at: string; monotonic: number }) {
      if (responded || completed) return;
      responded = true;
      record('first_response', observation);
    },
    complete(outcome: string, observation?: { at: string; monotonic: number }) {
      if (completed) return;
      completed = true;
      record('completion', observation, outcome);
    },
  };
}

/** Emit a raw harness/terminal chunk (stdout/stderr or formatted SDK lines). */
function emitHarness(emit: AgentEmit | undefined, data: string): void {
  if (!emit || !data) return;
  emit('harness', { data });
}

/** Machine-readable stats line for the harness header (token/ctx/cost chips). */
function emitCascadeStats(emit: AgentEmit | undefined, stats: Record<string, unknown>): void {
  if (!emit || !stats || typeof stats !== 'object') return;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stats)) {
    if (value !== undefined && value !== null && value !== '') clean[key] = value;
  }
  if (Object.keys(clean).length === 0) return;
  try {
    emitHarness(emit, `\x1b[2m# cascade-stats ${JSON.stringify(clean)}\x1b[0m\r\n`);
  } catch { /* ignore */ }
}

function numFromUnknown(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

/** Pull token fields from common CLI usage blobs. */
function statsFromUsageBlob(
  usage: Record<string, unknown> | null | undefined,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  if (!usage && Object.keys(extra).length === 0) return extra;
  const u = usage || {};
  const input = numFromUnknown(u.input_tokens ?? u.inputTokens ?? u.prompt_tokens);
  const cached = numFromUnknown(
    u.cached_input_tokens ?? u.cache_read_input_tokens ?? u.cacheReadTokens ?? u.cachedInputTokens,
  );
  const output = numFromUnknown(
    u.output_tokens
    ?? u.outputTokens
    ?? u.completion_tokens
    // Codex sometimes splits reasoning tokens out of output_tokens.
    ?? ((numFromUnknown(u.reasoning_output_tokens) != null || numFromUnknown(u.reasoningOutputTokens) != null)
      ? (numFromUnknown(u.output_tokens) || 0)
        + (numFromUnknown(u.reasoning_output_tokens) || numFromUnknown(u.reasoningOutputTokens) || 0)
      : undefined),
  );
  const total = numFromUnknown(u.total_tokens ?? u.totalTokens);
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cached,
    cacheWriteTokens: numFromUnknown(u.cache_creation_input_tokens ?? u.cacheWriteTokens),
    // Prefer explicit context totals; else input (+ cache) approximates window fill.
    contextUsed: total
      ?? (input != null || cached != null ? (input || 0) + (cached || 0) : undefined),
    totalCostUsd: numFromUnknown(u.total_cost_usd ?? u.cost_usd ?? u.cost),
    ...extra,
  };
}

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════

/**
 * Inactivity timeout (ms): a CLI agent is killed only after this long with
 * **no output at all** — not after this long running.
 *
 * This was a fixed wall-clock cap, which killed healthy long runs mid-stream:
 * Codex routinely works well past 10 minutes on one task, and a run that was
 * actively printing progress still got SIGTERMed. Resetting the timer on every
 * stdout/stderr chunk keeps the guarantee that matters — a wedged process is
 * still reaped, because a wedged process emits nothing — without capping how
 * long useful work may take.
 *
 * `RUNNER_CLI_TIMEOUT` is still honoured as an override for compatibility.
 */
const CLI_IDLE_TIMEOUT_MS = Number(
  process.env.RUNNER_CLI_IDLE_TIMEOUT || process.env.RUNNER_CLI_TIMEOUT || 1_800_000,
);
const CLI_PROGRESS_HEARTBEAT_MS = Math.max(10, Number(
  process.env.RUNNER_CLI_HEARTBEAT_MS || 15_000,
));
// Akron's local Grok bridge can hold an upstream stream open forever without a
// response byte. A short provider-silence bound prevents one wedged request
// from monopolizing the coordinator's sticky slot for the generic 30 minutes.
const AKRON_IDLE_TIMEOUT_MS = Math.max(1_000, Number(
  process.env.RUNNER_AKRON_IDLE_TIMEOUT_MS || 120_000,
));
// Hermes can spend meaningful time planning and initializing its provider
// bridge before its first byte. Keep a real wedge bound without making a
// substantial prompt look broken just because a greeting is much faster.
const HERMES_IDLE_TIMEOUT_MS = Math.max(1_000, Number(
  process.env.RUNNER_HERMES_IDLE_TIMEOUT_MS || 180_000,
));

class CliIdleTimeoutError extends Error {}

/**
 * Idle-timeout handle: `bump()` on every chunk of child output, `clear()` once
 * the process settles. Fires `onIdle` after CLI_IDLE_TIMEOUT_MS of silence.
 */
function createIdleTimer(
  onIdle: () => void,
  timeoutMs = CLI_IDLE_TIMEOUT_MS,
): { bump: () => void; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const bump = () => {
    clear();
    timer = setTimeout(onIdle, timeoutMs);
  };
  bump();
  return { bump, clear };
}

/**
 * Binary names are overridable via env for tests and non-PATH installs.
 * Resolved at call time — not module load — so `process.env.AKRON_BIN = fake`
 * after `import('./cli-agent.js')` still wins (Electron loads this module once
 * and caches it across runs).
 */
function resolveCliBin(envKey: string, fallback: string): string {
  const value = process.env[envKey];
  return (typeof value === 'string' && value.trim()) ? value : fallback;
}
/** Borders of the box-drawn reasoning panel Hermes prints on stdout under `-Q`. */
const HERMES_REASONING_OPEN = /^┌─+\s*Reasoning\s*─/;
const HERMES_REASONING_CLOSE = /^└─+┘?$/;
/**
 * Hermes exhausts its own internal retries and then exits 0 with a plain
 * "API call failed after N retries: HTTP 503 …" line as its answer. That is a
 * transient upstream-capacity error, not a real reply, so Cascade retries the
 * whole run rather than surfacing the 503 as the agent's message.
 */
const HERMES_UPSTREAM_UNAVAILABLE = /^(?:API call failed after \d+ retr(?:y|ies)\b|HTTP 5\d\d\b|(?:The )?requested model is temporarily unavailable\b)/i;
/**
 * True only when the upstream error *is* the entire reply.
 *
 * Matching the phrase anywhere would misfire on a real answer that discusses
 * HTTP 503 (a plausible question in this repo), silently discarding the model's
 * work and then spinning for the whole retry budget.
 */
function isHermesUpstreamFailure(output: string): boolean {
  const lines = output.trim().split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0 || lines.length > 2) return false;
  return lines.every((line) => HERMES_UPSTREAM_UNAVAILABLE.test(line));
}

const HERMES_UPSTREAM_RETRIES = Math.max(0, Number(process.env.RUNNER_HERMES_UPSTREAM_RETRIES || 50));
const HERMES_UPSTREAM_BACKOFF_MS = Math.max(250, Number(process.env.RUNNER_HERMES_UPSTREAM_BACKOFF_MS || 3_000));
// Cap the escalating backoff so a long retry streak keeps polling on a steady
// cadence instead of stretching to minutes between attempts.
const HERMES_UPSTREAM_BACKOFF_CAP_MS = Math.max(HERMES_UPSTREAM_BACKOFF_MS, Number(process.env.RUNNER_HERMES_UPSTREAM_BACKOFF_CAP_MS || 30_000));
export type CliAgentId = 'codex' | 'grok' | 'antigravity' | 'copilot' | 'hermes' | 'akron-grok' | 'omp' | 'pi';

const CLI_AGENT_LABELS: Record<CliAgentId, string> = {
  codex: 'Codex',
  grok: 'Grok',
  antigravity: 'Antigravity',
  copilot: 'Copilot',
  hermes: 'Hermes',
  'akron-grok': 'Akron --grok',
  omp: 'OMP',
  pi: 'Pi',
};

export function getCliAgentBin(agent: CliAgentId): string {
  switch (agent) {
    case 'codex':
      return resolveCliBin('CODEX_BIN', 'codex');
    case 'grok':
      return resolveCliBin('GROK_BIN', 'grok');
    case 'copilot':
      return resolveCliBin('COPILOT_BIN', 'copilot');
    case 'hermes':
      return resolveCliBin('HERMES_BIN', 'hermes');
    case 'akron-grok':
      return resolveCliBin('AKRON_BIN', 'akron');
    case 'omp':
      return resolveCliBin('OMP_BIN', 'omp');
    case 'pi':
      return resolveCliBin('PI_BIN', 'pi');
    case 'antigravity':
      return process.env.ANTIGRAVITY_BIN || path.join(os.homedir(), '.gemini', 'antigravity', 'bin', 'agentapi');
  }
}

const CLI_AVAILABILITY_CACHE_MS = 60_000;
const cliAvailabilityCache = new Map<string, { available: boolean; checkedAt: number }>();

function cliBinaryExists(bin: string): boolean {
  const cached = cliAvailabilityCache.get(bin);
  if (cached && Date.now() - cached.checkedAt < CLI_AVAILABILITY_CACHE_MS) {
    return cached.available;
  }
  let available = false;
  if (path.isAbsolute(bin)) {
    try {
      available = fs.existsSync(bin) && fs.statSync(bin).isFile();
    } catch {
      available = false;
    }
  } else {
    const result = spawnSync('which', [bin], { stdio: 'ignore' });
    available = result.status === 0;
  }
  cliAvailabilityCache.set(bin, { available, checkedAt: Date.now() });
  return available;
}

function unavailableCliMessage(agent: CliAgentId, bin: string): string {
  const variable = agent === 'akron-grok'
    ? 'AKRON_BIN'
    : `${agent.toUpperCase().replace('-', '_')}_BIN`;
  return `${CLI_AGENT_LABELS[agent]} ('${bin}') is not installed or not on PATH. CLI agents run in the Cascade desktop app on this computer — install the CLI locally, or set ${variable} for the desktop app.`;
}

export function getCliAgentAvailability(): Record<CliAgentId, { available: boolean; bin: string; message?: string }> {
  const availability = {} as Record<CliAgentId, { available: boolean; bin: string; message?: string }>;
  for (const agent of Object.keys(CLI_AGENT_LABELS) as CliAgentId[]) {
    const bin = getCliAgentBin(agent);
    const available = cliBinaryExists(bin);
    availability[agent] = available
      ? { available: true, bin }
      : {
        available: false,
        bin,
        message: unavailableCliMessage(agent, bin),
      };
  }
  return availability;
}

function assertCliAgentAvailable(agent: CliAgentId): void {
  // Launching one provider must not synchronously spawn `which` for every other
  // integration. Full availability remains available to the health endpoint.
  const bin = getCliAgentBin(agent);
  if (!cliBinaryExists(bin)) {
    throw new Error(unavailableCliMessage(agent, bin));
  }
}

interface CliAgentOpts {
  agent: CliAgentId;
  /** Minimal IDE-style context (selected note + vault). Prepended to the prompt. */
  context: string;
  userPrompt: string;
  cwd: string;
  /** Prior backend session id to resume, for conversation continuity. */
  resumeSessionId?: string;
  /** Pasted images to attach (Codex via -i; Grok has no image support). */
  images?: CliImage[];
  emit: AgentEmit;
  runId?: number;
  model?: string;
  /** Codex-only reasoning effort override. */
  reasoningEffort?: string;
  /** Codex-only priority processing override. */
  priorityServiceTier?: boolean;
  /** Codex-only sandbox override for isolated assistants. */
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  /** Run with permission prompts bypassed ("yolo"). For Codex this widens the
   * sandbox from workspace-write to danger-full-access. */
  yolo?: boolean;
  /** Hermes profile from the owner's local Hermes installation. */
  hermesProfile?: string;
  /** Ignore Hermes user configuration for this identity. */
  hermesSafeMode?: boolean;
  /** Explicit child-process environment from the desktop runner. */
  env?: NodeJS.ProcessEnv;
}

/** Maps MIME types to file extensions for temp image files. */
const IMG_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
  'image/gif': 'gif', 'image/webp': 'webp',
};

export interface CliAgentResult {
  summary: string;
  /** Backend session id for this run, to resume on the next turn. */
  sessionId?: string;
}

// ═══════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════

/**
 * Runs a CLI agent (Codex or Grok) against the vault and streams events.
 *
 * Prepends a short IDE-style context line (which note is open) to the user's
 * prompt, then delegates to the appropriate CLI runner. Returns a summary of
 * the agent's work and, if available, a session id for conversation resume.
 *
 * @param opts - Configuration including agent type, prompt, cwd, and emitter
 * @returns Summary text and optional session id for conversation continuity
 */
export async function runCliAgent(opts: CliAgentOpts): Promise<CliAgentResult> {
  assertCliAgentAvailable(opts.agent);

  // The CLIs are full agents in their own right; we only prepend a short
  // context line (which note is open), then pass the user's prompt verbatim.
  const prompt = opts.context
    ? `[Context: ${opts.context}]\n\n${opts.userPrompt}`
    : opts.userPrompt;
  if (opts.agent === 'codex') {
    return runCodex(prompt, opts.cwd, opts.emit, opts.resumeSessionId, opts.images || [], opts.runId, opts.model, opts.reasoningEffort, opts.priorityServiceTier, opts.yolo, opts.sandbox, opts.env);
  } else if (opts.agent === 'grok') {
    return runGrok(prompt, opts.cwd, opts.emit, opts.resumeSessionId, opts.runId, opts.model, opts.env);
  } else if (opts.agent === 'copilot') {
    return runCopilot(prompt, opts.cwd, opts.emit, opts.resumeSessionId, opts.runId, opts.model, opts.env);
  } else if (opts.agent === 'hermes') {
    return runHermes(prompt, opts.cwd, opts.emit, opts.resumeSessionId, opts.runId, opts.env, opts.model, opts.hermesProfile, opts.hermesSafeMode, opts.yolo);
  } else if (opts.agent === 'akron-grok') {
    return runAkronGrok(prompt, opts.cwd, opts.emit, opts.resumeSessionId, opts.runId, opts.env);
  } else if (opts.agent === 'omp') {
    return runOmp(prompt, opts.cwd, opts.emit, opts.resumeSessionId, opts.images || [], opts.runId, opts.model, opts.env);
  } else if (opts.agent === 'pi') {
    return runPi(prompt, opts.cwd, opts.emit, opts.resumeSessionId, opts.images || [], opts.runId, opts.model, opts.env);
  } else {
    return runAntigravity(
      prompt, opts.cwd, opts.emit, opts.resumeSessionId, opts.runId, opts.model, opts.yolo, opts.env,
    );
  }
}

// ═══════════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ═══════════════════════════════════════════════════════════════

/**
 * Writes base64-encoded images to a temp directory for CLI flags like `-i`.
 *
 * @param images - Array of base64-encoded images with MIME types
 * @returns Object with file paths and a cleanup function to remove them
 */
function writeTempImages(images: CliImage[]): { paths: string[]; cleanup: () => void } {
  if (!images.length) return { paths: [], cleanup: () => {} };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-img-'));
  const paths = images.map((img, i) => {
    const ext = IMG_EXT[img.media_type] || 'png';
    const file = path.join(dir, `image-${i}.${ext}`);
    fs.writeFileSync(file, Buffer.from(img.data, 'base64'));
    return file;
  });
  return { paths, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } } };
}

/**
 * Spawns a CLI process, streams its stdout line-by-line through `onLine`,
 * accumulates stderr, enforces a timeout, and resolves with a summary.
 *
 * Also tees raw stdout/stderr into harness events so the chat UI can render a
 * real terminal view of the headless process pipes (not a PTY — read-only).
 *
 * @param bin        - Binary name or path to execute
 * @param args       - CLI arguments
 * @param cwd        - Working directory (vault root)
 * @param onLine     - Callback invoked for each non-empty stdout line
 * @param getSummary - Called on success to produce the final summary string
 * @param label      - Human-readable label for error messages (e.g. 'Codex')
 * @returns The summary string from getSummary on success
 * @throws On timeout, non-zero exit code, or spawn failure
 */
function driveProcess(
  bin: string,
  args: string[],
  cwd: string,
  onLine: (line: string, carriageReturn?: boolean) => void,
  getSummary: () => string,
  label: string,
  runId?: number,
  emit?: AgentEmit,
  env?: NodeJS.ProcessEnv,
  /** Tee of stderr, for callers that must inspect a CLI's diagnostics after a
   *  zero-exit failure (e.g. Codex reporting a dead session). */
  onStderr?: (chunk: string) => void,
  hermes?: { onStderrLine: (line: string) => void; idleTimeoutMs: number },
): Promise<string> {
  const idleTimeoutMs = hermes?.idleTimeoutMs ?? CLI_IDLE_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const timing = createRequestTiming(emit, 'cli_process_stdout');
    let child;
    const leaseToken = hermes ? randomBytes(16).toString('hex') : undefined;
    if (hermes) emitHarness(emit, `\x1b[2m# launching ${label} harness\x1b[0m\r\n`);
    try {
      child = spawn(bin, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Hermes launchers own provider bridges and tool descendants.
        detached: Boolean(hermes) && process.platform !== 'win32',
        env: {
          ...(env ? { ...process.env, ...env } : process.env),
          ...(hermes ? {
            HERMES_CASCADE_EVENTS: '1',
            CASCADE_AGENT_PROCESS_TOKEN: leaseToken,
            ...(runId !== undefined ? { CASCADE_RUN_ID: String(runId) } : {}),
          } : {}),
        },
      });
      if (runId !== undefined) {
        activeCliProcesses.set(runId, child);
        if (hermes && process.platform !== 'win32') {
          groupedCliProcesses.add(runId);
          if (child.pid && process.platform === 'linux') {
            writeAgentProcessLease({
              version: 1,
              runId,
              ownerPid: process.pid,
              ownerStartTicks: processStartTicks(process.pid),
              processGroupId: child.pid,
              token: leaseToken!,
              label,
            });
          }
        }
      }
    } catch (err) {
      if (hermes && child) terminateCliProcessWithEscalation(child, process.platform !== 'win32');
      if (runId !== undefined) {
        activeCliProcesses.delete(runId);
        if (hermes) {
          groupedCliProcesses.delete(runId);
          clearAgentProcessLease(runId);
        }
      }
      timing.complete('launch_failed');
      reject(new Error(`Failed to launch ${label} ('${bin}'): ${err instanceof Error ? err.message : String(err)}`));
      return;
    }

    const cleanUpProcess = () => {
      if (runId !== undefined) {
        activeCliProcesses.delete(runId);
        if (hermes) {
          groupedCliProcesses.delete(runId);
          clearAgentProcessLease(runId);
        }
      }
    };

    emitHarness(emit, `\x1b[2m$ ${bin} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}\x1b[0m\r\n`);
    emitHarness(emit, `\x1b[2m# cwd ${cwd}\x1b[0m\r\n`);

    let stderr = '';
    let stdoutBuf = '';
    let stderrBuf = '';
    const consumeStderrLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (hermes && (trimmed.startsWith('{') || /^session_id:\s*/i.test(trimmed))) {
        try { hermes.onStderrLine(trimmed); } catch { /* ignore a single malformed event */ }
      } else {
        stderr += trimmed + '\n';
      }
    };
    let settled = false;
    let quietSince = Date.now();
    const heartbeat = hermes ? setInterval(() => {
      if (settled || Date.now() - quietSince < CLI_PROGRESS_HEARTBEAT_MS) return;
      const quietSeconds = Math.max(1, Math.round((Date.now() - quietSince) / 1_000));
      emitHarness(emit, `\x1b[2m# ${label} still working · ${quietSeconds}s without provider output\x1b[0m\r\n`);
    }, CLI_PROGRESS_HEARTBEAT_MS) : undefined;
    const idle = createIdleTimer(() => {
      if (!settled) {
        settled = true;
        timing.complete('idle_timeout');
        if (heartbeat) clearInterval(heartbeat);
        cleanUpProcess();
        if (hermes) terminateCliProcessWithEscalation(child, process.platform !== 'win32');
        else child.kill('SIGTERM');
        reject(new (hermes ? CliIdleTimeoutError : Error)(`${label} produced no output for ${idleTimeoutMs}ms and was stopped.`));
      }
    }, idleTimeoutMs);

    child.stdout.on('data', (d: Buffer | string) => {
      if (d.length) timing.firstResponse();
      const chunk = d.toString();
      quietSince = Date.now();
      idle.bump();
      emitHarness(emit, chunk);
      stdoutBuf += chunk;
      let nl = stdoutBuf.indexOf('\n');
      while (nl >= 0) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        // Hermes renders its reasoning box with CR-terminated lines (they are
        // meant to be redrawn in place) while the final answer ends with a bare
        // LF. trim() destroys that distinction, so report it separately.
        const carriageReturn = line.endsWith('\r');
        const trimmed = line.trim();
        if (trimmed) {
          try { onLine(trimmed, carriageReturn); } catch { /* ignore a single malformed line */ }
        }
        nl = stdoutBuf.indexOf('\n');
      }
    });

    child.stderr.on('data', (d: Buffer | string) => {
      const chunk = d.toString();
      quietSince = Date.now();
      idle.bump();
      if (!hermes) stderr += chunk;
      onStderr?.(chunk);
      emitHarness(emit, `\x1b[31m${chunk}\x1b[0m`);
      if (!hermes) return;
      stderrBuf += chunk;
      let nl = stderrBuf.indexOf('\n');
      while (nl >= 0) {
        const line = stderrBuf.slice(0, nl);
        stderrBuf = stderrBuf.slice(nl + 1);
        consumeStderrLine(line);
        nl = stderrBuf.indexOf('\n');
      }
    });

    child.on('error', (err) => {
      timing.complete('launch_failed');
      if (settled) return;
      settled = true;
      idle.clear();
      if (heartbeat) clearInterval(heartbeat);
      cleanUpProcess();
      reject(new Error(`${label} ('${bin}') could not be started: ${err.message}. Is it installed and on PATH?`));
    });

    child.on('close', (code, signal) => {
      timing.complete(signal ? 'signaled' : code === 0 ? 'completed' : 'failed');
      if (settled) return;
      settled = true;
      idle.clear();
      if (heartbeat) clearInterval(heartbeat);
      cleanUpProcess();
      const trailingOut = stdoutBuf.trim();
      if (trailingOut) {
        try { onLine(trailingOut); } catch { /* ignore */ }
      }
      consumeStderrLine(stderrBuf);
      emitHarness(emit, `\x1b[2m# exit ${code ?? '?'}\x1b[0m\r\n`);
      if (code === 0) {
        resolve(getSummary());
      } else {
        const detail = stderr.trim().split('\n').slice(-5).join('\n');
        reject(new Error(`${label} exited with code ${code}.${detail ? `\n${detail}` : ''}`));
      }
    });
  });
}

/** Truncates a string to `n` characters, appending an ellipsis if truncated. */
function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '\n…(truncated)' : s;
}

function redactGrokDiagnostic(input: string): string {
  return input
    .replace(/"key_prefix":"[^"]*"/g, '"key_prefix":"[redacted]"')
    .replace(/"rt_prefix":"[^"]*"/g, '"rt_prefix":"[redacted]"')
    .replace(/key_prefix":"[^"]*"/g, 'key_prefix":"[redacted]"')
    .replace(/rt_prefix":"[^"]*"/g, 'rt_prefix":"[redacted]"')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]');
}

function extractGrokDiagnostic(debugFile: string): string | undefined {
  try {
    if (!fs.existsSync(debugFile)) return undefined;
    const raw = fs.readFileSync(debugFile, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean).slice(-300);
    const candidates: string[] = [];
    for (const line of lines) {
      try {
        const ev = JSON.parse(line);
        const status = ev?.ctx?.status_code ?? ev?.ctx?.http_status;
        const message = ev?.ctx?.message ?? ev?.ctx?.error;
        if (status || message || ev?.lvl === 'error') {
          candidates.push(redactGrokDiagnostic(JSON.stringify({
            level: ev?.lvl,
            message: ev?.msg,
            status,
            detail: message,
          })));
        }
      } catch {
        if (/api error|forbidden|permission-denied|unauthorized|rate|paywall|subscription/i.test(line)) {
          candidates.push(redactGrokDiagnostic(line));
        }
      }
    }
    const detail = candidates.slice(-3).join('\n');
    return detail || undefined;
  } catch {
    return undefined;
  }
}

// ═══════════════════════════════════════════════════════════════
// CODEX CLI
// ═══════════════════════════════════════════════════════════════

type JsonObject = Record<string, any>;
type CodexAppTurn = {
  threadId: string; turnId: string; runId?: number; emit: AgentEmit;
  resolve: (result: CliAgentResult) => void; reject: (error: Error) => void;
  summary: string; emittedText: boolean; emittedTools: Set<string>; agentText: Map<string, string>;
  idle: ReturnType<typeof createIdleTimer>;
  timing: ReturnType<typeof createRequestTiming>;
};

/** Long-lived protocol peer; avoids rebuilding Codex's app-server every turn. */
class CodexAppServerClient {
  private child?: ChildProcessWithoutNullStreams;
  private stdout = '';
  private stderr = '';
  private nextId = 1;
  private initialized?: Promise<void>;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private turns = new Map<string, CodexAppTurn>();
  private earlyNotifications = new Map<string, JsonObject[]>();
  private threadQueues = new Map<string, Promise<void>>();
  async run(options: {
    prompt: string; cwd: string; emit: AgentEmit; resumeId?: string; imagePaths: string[];
    runId?: number; model?: string; reasoningEffort?: string;
    priorityServiceTier?: boolean; sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
    yolo?: boolean; env?: NodeJS.ProcessEnv;
  }): Promise<CliAgentResult> {
    const threadId = typeof options.resumeId === 'string' ? options.resumeId.trim() : '';
    if (!threadId) return this.runUnlocked(options);

    // Codex permits only one writer per resumed thread. Keep retries and
    // rapid cancel/restart actions serialized until the prior turn settles.
    const previous = this.threadQueues.get(threadId) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.threadQueues.set(threadId, current);
    await previous;
    try {
      return await this.runUnlocked(options);
    } finally {
      release();
      if (this.threadQueues.get(threadId) === current) this.threadQueues.delete(threadId);
    }
  }

  private async runUnlocked(options: {
    prompt: string; cwd: string; emit: AgentEmit; resumeId?: string; imagePaths: string[];
    runId?: number; model?: string; reasoningEffort?: string;
    priorityServiceTier?: boolean; sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
    yolo?: boolean; env?: NodeJS.ProcessEnv;
  }): Promise<CliAgentResult> {
    await this.ensureStarted();
    const sandbox = options.sandbox || (options.yolo ? 'danger-full-access' : 'workspace-write');
    const common: JsonObject = {
      cwd: options.cwd,
      model: options.model || null,
      serviceTier: options.priorityServiceTier ? 'priority' : null,
      approvalPolicy: 'never',
      sandbox,
      config: {
        ...(sandbox === 'workspace-write' ? { sandbox_workspace_write: { network_access: true } } : {}),
        shell_environment_policy: { inherit: 'all', set: this.environmentOverrides(options.env) },
      },
    };
    let response = await this.openThread(options, common);
    let threadId = String(response?.thread?.id || options.resumeId || '');
    if (!threadId) throw new Error('Codex app-server did not return a thread id.');
    const turnParams = {
      threadId,
      input: [
        { type: 'text', text: options.prompt, text_elements: [] },
        ...options.imagePaths.map((imagePath) => ({ type: 'localImage', path: imagePath })),
      ],
      cwd: options.cwd,
      model: options.model || null,
      serviceTier: options.priorityServiceTier ? 'priority' : null,
      effort: normalizeCodexEffort(options.reasoningEffort),
      approvalPolicy: 'never',
    };
    const timing = createRequestTiming(options.emit, 'codex_app_server_turn');
    try {
      let started: JsonObject;
      try {
        started = await this.request('turn/start', turnParams);
      } catch (error) {
        if (!this.isActiveWriterError(error)) throw error;
        emitHarness(options.emit, '\x1b[33m# Codex left this thread busy — interrupting its unfinished turn\x1b[0m\r\n');
        const interrupted = await this.interruptActiveTurn(threadId);
        try {
          if (!interrupted) throw error;
          started = await this.requestWithActiveWriterRetry('turn/start', turnParams);
        } catch (retryError) {
          if (!this.isActiveWriterError(retryError)) throw retryError;
          void this.request('thread/unsubscribe', { threadId }).catch(() => {});
          emitHarness(options.emit, '\x1b[33m# Codex did not release that thread — continuing in a fresh session\x1b[0m\r\n');
          response = await this.request('thread/start', common);
          threadId = String(response?.thread?.id || '');
          if (!threadId) throw new Error('Codex app-server did not return a replacement thread id.');
          started = await this.request('turn/start', { ...turnParams, threadId });
        }
      }
      options.emit('session', { sessionId: threadId });
      emitHarness(options.emit, `\x1b[2m# codex app-server · ${options.cwd}\x1b[0m\r\n`);
      if (options.model) emitCascadeStats(options.emit, { model: options.model });
      const turnId = String(started?.turn?.id || '');
      if (!turnId) throw new Error('Codex app-server did not return a turn id.');
      return await new Promise<CliAgentResult>((resolve, reject) => {
        const idle = createIdleTimer(() => {
          void this.request('turn/interrupt', { threadId, turnId }).catch(() => {});
          this.finishTurn(turnId, new Error(`Codex produced no output for ${CLI_IDLE_TIMEOUT_MS}ms and was stopped.`));
        });
        this.turns.set(turnId, {
          threadId, turnId, runId: options.runId, emit: options.emit, resolve, reject,
          summary: '', emittedText: false, emittedTools: new Set(), agentText: new Map(), idle, timing,
        });
        if (options.runId !== undefined) activePersistentCancels.set(options.runId, () => {
          void this.request('turn/interrupt', { threadId, turnId }).catch(() => {});
        });
        const buffered = this.earlyNotifications.get(turnId) || [];
        this.earlyNotifications.delete(turnId);
        for (const message of buffered) this.onMessage(message);
      });
    } catch (error) {
      timing.complete('failed');
      throw error;
    }
  }

  private async openThread(options: {
    resumeId?: string; emit: AgentEmit;
  }, common: JsonObject): Promise<JsonObject> {
    if (!options.resumeId) return this.request('thread/start', common);
    const resumeParams = { threadId: options.resumeId, excludeTurns: true, ...common };
    try {
      return await this.request('thread/resume', resumeParams);
    } catch (error) {
      if (isDeadCodexSession(String(error))) {
        emitHarness(options.emit, '\x1b[33m# that session is gone from Codex\'s store — starting a fresh one\x1b[0m\r\n');
        return this.request('thread/start', common);
      }
      if (!this.isActiveWriterError(error)) throw error;
      emitHarness(options.emit, '\x1b[33m# Codex left this thread busy — interrupting its unfinished turn\x1b[0m\r\n');
      const interrupted = await this.interruptActiveTurn(options.resumeId);
      if (interrupted) {
        try {
          return await this.requestWithActiveWriterRetry('thread/resume', resumeParams);
        } catch (retryError) {
          if (!this.isActiveWriterError(retryError)) throw retryError;
        }
      }
      emitHarness(options.emit, '\x1b[33m# Codex did not release that thread — continuing in a fresh session\x1b[0m\r\n');
      return this.request('thread/start', common);
    }
  }

  private async interruptActiveTurn(threadId: string): Promise<boolean> {
    try {
      const response = await this.request('thread/read', { threadId, includeTurns: true });
      const turns = Array.isArray(response?.thread?.turns) ? response.thread.turns : [];
      const active = [...turns].reverse().find((turn) => turn?.status === 'inProgress' && turn?.id);
      if (!active) return false;
      await this.request('turn/interrupt', { threadId, turnId: active.id });
      return true;
    } catch {
      return false;
    }
  }

  private isActiveWriterError(error: unknown): boolean {
    return /active writer/i.test(String(error));
  }

  private async requestWithActiveWriterRetry(method: string, params: JsonObject): Promise<any> {
    let delayMs = 250;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        return await this.request(method, params);
      } catch (error) {
        if (!this.isActiveWriterError(error) || attempt === 7) throw error;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs = Math.min(delayMs * 2, 2_000);
      }
    }
    throw new Error(`Codex ${method} did not become available.`);
  }

  private environmentOverrides(env?: NodeJS.ProcessEnv): Record<string, string> {
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(env || {})) {
      if (typeof value === 'string' && process.env[key] !== value) clean[key] = value;
    }
    return clean;
  }

  private async ensureStarted(): Promise<void> {
    if (this.initialized) return this.initialized;
    this.initialized = new Promise<void>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(getCliAgentBin('codex'), ['app-server', '--stdio'], {
          cwd: os.homedir(), env: process.env, stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        reject(new Error(`Failed to launch Codex app-server: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      this.child = child;
      child.stdout.on('data', (chunk) => this.onStdout(chunk.toString()));
      child.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk.toString()).slice(-16_000); });
      child.on('error', (error) => this.onExit(child, new Error(`Codex app-server error: ${error.message}`)));
      child.on('exit', (code, signal) => this.onExit(child, new Error(`Codex app-server exited (${signal || code || 'unknown'}). ${this.stderr.trim()}`)));
      this.request('initialize', {
        clientInfo: { name: 'cascade-desktop', title: 'Cascade', version: '0.2.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      }).then(() => { this.notify('initialized'); resolve(); }, reject);
    });
    try { await this.initialized; } catch (error) { this.initialized = undefined; throw error; }
  }

  private request(method: string, params?: JsonObject): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (!this.child?.stdin.writable) return reject(new Error('Codex app-server is not running.'));
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  private notify(method: string): void {
    if (this.child?.stdin.writable) this.child.stdin.write(`${JSON.stringify({ method })}\n`);
  }

  private onStdout(chunk: string): void {
    this.stdout += chunk;
    let newline = this.stdout.indexOf('\n');
    while (newline >= 0) {
      const line = this.stdout.slice(0, newline).trim();
      this.stdout = this.stdout.slice(newline + 1);
      if (line) try { this.onMessage(JSON.parse(line)); } catch { /* ignore non-protocol output */ }
      newline = this.stdout.indexOf('\n');
    }
  }

  private onMessage(message: JsonObject): void {
    const observation = message.timingObservation || { at: new Date().toISOString(), monotonic: performance.now() };
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      return message.error
        ? pending.reject(new Error(message.error.message || JSON.stringify(message.error)))
        : pending.resolve(message.result);
    }
    if (message.id !== undefined && message.method) {
      const response = /requestApproval$/.test(message.method)
        ? { id: message.id, result: { decision: 'decline' } }
        : { id: message.id, error: { code: -32601, message: `Unsupported server request: ${message.method}` } };
      this.child?.stdin.write(`${JSON.stringify(response)}\n`);
      return;
    }
    const params = message.params || {};
    const turnId = String(params.turnId || params.turn?.id || '');
    // An explicit turn ID owns the event; a stale attempt must never fall
    // through to another active turn in the same conversation.
    const turn = turnId ? this.turns.get(turnId)
      : [...this.turns.values()].find((candidate) => candidate.threadId === params.threadId);
    if (turn && params.threadId && turn.threadId !== params.threadId) return;
    if (!turn) {
      if (turnId && ['item/started', 'item/completed', 'item/agentMessage/delta', 'turn/completed', 'error'].includes(message.method)) {
        const buffered = this.earlyNotifications.get(turnId) || [];
        buffered.push({ ...message, timingObservation: observation });
        this.earlyNotifications.set(turnId, buffered.slice(-100));
      }
      return;
    }
    turn.idle.bump();
    if (['item/started', 'item/completed'].includes(message.method)
      && params.item?.type && !['userMessage', 'contextCompaction'].includes(params.item.type)) {
      turn.timing.firstResponse(observation);
    }
    if (message.method === 'item/agentMessage/delta' && params.itemId && typeof params.delta === 'string' && params.delta) {
      turn.timing.firstResponse(observation);
      this.emitAgentText(turn, params.itemId, (turn.agentText.get(params.itemId) || '') + params.delta);
    } else if (message.method === 'item/started') this.emitItem(turn, params.item, false);
    else if (message.method === 'item/completed') this.emitItem(turn, params.item, true);
    else if (message.method === 'thread/tokenUsage/updated') emitCascadeStats(turn.emit, statsFromUsageBlob(params.tokenUsage || params.usage));
    else if (message.method === 'turn/completed') {
      const status = params.turn?.status;
      turn.timing.complete(status || 'failed', observation);
      this.finishTurn(turnId, status === 'completed' ? undefined : new Error(params.turn?.error?.message || `Codex turn ${status || 'failed'}.`));
    } else if (message.method === 'error') {
      // Stream errors are progress while Codex retries the same turn. Keep
      // ownership, heartbeat and cancellation alive until a terminal event.
      if (params.willRetry === true) {
        emitHarness(turn.emit, `${params.error?.message || params.message || 'Codex retrying.'}\r\n`);
        return;
      }
      turn.timing.complete('failed', observation);
      this.finishTurn(turnId, new Error(params.error?.message || params.message || 'Codex app-server error.'));
    }
  }

  private emitAgentText(turn: CodexAppTurn, itemId: string, text: string): void {
    const previous = turn.agentText.get(itemId);
    // Completion repeats the full item; only publish its not-yet-streamed suffix.
    const delta = previous === undefined ? text : text.startsWith(previous) ? text.slice(previous.length) : '';
    turn.agentText.set(itemId, text);
    if (!delta) return;
    turn.emit('text', { chatVisible: true, message: { content: [{ type: 'text',
      text: `${previous === undefined && turn.emittedText ? '\n\n' : ''}${delta}` }] } });
    turn.emittedText = true;
  }

  private emitItem(turn: CodexAppTurn, item: JsonObject | undefined, completed: boolean): void {
    if (!item?.type) return;
    if (item.type === 'agentMessage') {
      if (!completed) return;
      const text = String(item.text || '');
      if (text) {
        turn.summary = text;
        this.emitAgentText(turn, String(item.id || ''), text);
      }
      return;
    }
    if (item.type === 'reasoning') {
      if (!completed) return;
      const text = [...(item.summary || []), ...(item.content || [])].filter(Boolean).join('\n');
      if (text) turn.emit('text', { message: { content: [{ type: 'thinking', text }] } });
      return;
    }
    if (['userMessage', 'plan', 'contextCompaction'].includes(item.type) || !item.id) return;
    if (!turn.emittedTools.has(item.id)) {
      turn.emittedTools.add(item.id);
      turn.emit('text', { message: { content: [codexAppToolUseBlock(item)] } });
    }
    if (completed) {
      const output = item.aggregatedOutput ?? item.result ?? item.error ?? '';
      const isError = item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0);
      turn.emit('user', { message: { content: [{ type: 'tool_result', tool_use_id: item.id, content: truncate(typeof output === 'string' ? output : JSON.stringify(output), 8000), is_error: isError }] } });
    }
  }

  private finishTurn(turnId: string, error?: Error): void {
    const turn = this.turns.get(turnId);
    if (!turn) return;
    turn.timing.complete(error ? 'failed' : 'completed');
    this.turns.delete(turnId);
    turn.idle.clear();
    if (turn.runId !== undefined) activePersistentCancels.delete(turn.runId);
    // A loaded app-server thread owns an exclusive writer lease even while it
    // is idle. Release it after every turn so a rebuilt desktop module or a
    // second Cascade window can resume the conversation later.
    void this.request('thread/unsubscribe', { threadId: turn.threadId }).catch(() => {});
    if (error) turn.reject(error); else turn.resolve({ summary: turn.summary, sessionId: turn.threadId });
  }

  private onExit(child: ChildProcessWithoutNullStreams, error: Error): void {
    // A deliberate shutdown can be followed immediately by a replacement.
    // Ignore the old child's late exit event instead of tearing down the new
    // app-server that now occupies this client.
    if (this.child !== child) return;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const id of [...this.turns.keys()]) this.finishTurn(id, error);
    this.child = undefined; this.initialized = undefined; this.stdout = ''; this.stderr = ''; this.earlyNotifications.clear();
  }

  shutdown(): void {
    this.child?.kill('SIGTERM');
    this.child = undefined;
    this.initialized = undefined;
  }
}

const codexAppServer = new CodexAppServerClient();

/** Used by desktop shutdown and protocol tests; normal turns share one server. */
export function shutdownPersistentCliAgents(): void {
  codexAppServer.shutdown();
}

function normalizeCodexEffort(value?: string): string | null {
  const effort = String(value || '').trim().toLowerCase();
  return ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort) ? effort : null;
}

function codexAppToolUseBlock(item: JsonObject): JsonObject {
  if (item.type === 'commandExecution') return { type: 'tool_use', id: item.id, name: 'Bash', input: { command: item.command || '' } };
  if (item.type === 'fileChange') return { type: 'tool_use', id: item.id, name: 'Edit', input: { file_path: item.changes?.[0]?.path || '(files)' } };
  if (item.type === 'mcpToolCall') return { type: 'tool_use', id: item.id, name: `${item.server || 'mcp'}.${item.tool || 'tool'}`, input: item.arguments || {} };
  return { type: 'tool_use', id: item.id, name: String(item.tool || item.type), input: item.arguments || {} };
}

function persistentCodexEnabled(): boolean {
  return process.env.RUNNER_CODEX_PERSISTENT !== '0' && path.basename(getCliAgentBin('codex')) === 'codex';
}

/**
 * Runs the Codex CLI (`codex exec --json`) and translates its rich JSONL
 * event stream into Anthropic-style content blocks.
 *
 * Codex events → content block mapping:
 *   - `thread.started`              → captures session id
 *   - `item.started` (tool items)   → `{ type: 'tool_use', name, input }`
 *   - `item.completed` / agent_message → `{ type: 'text', text }`
 *   - `item.completed` / reasoning  → `{ type: 'thinking', text }`
 *   - `item.completed` / tool items → `{ type: 'tool_result', content, is_error }`
 *
 * @param prompt     - Full prompt (context + user prompt)
 * @param cwd        - Vault root path
 * @param emit       - Event emitter callback
 * @param resumeId   - Optional session id to resume a prior conversation
 * @param images     - Optional images to attach via `-i` flags
 * @returns Summary text and optional session id
 */
async function runCodex(
  prompt: string,
  cwd: string,
  emit: AgentEmit,
  resumeId?: string,
  images: CliImage[] = [],
  runId?: number,
  model?: string,
  reasoningEffort?: string,
  priorityServiceTier?: boolean,
  yolo?: boolean,
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access',
  env?: NodeJS.ProcessEnv,
): Promise<CliAgentResult> {
  const { paths: imagePaths, cleanup } = writeTempImages(images);
  if (persistentCodexEnabled()) {
    try {
      return await codexAppServer.run({
        prompt,
        cwd,
        emit,
        resumeId,
        imagePaths,
        runId,
        model,
        reasoningEffort,
        priorityServiceTier,
        yolo,
        sandbox,
        env: env ? { ...process.env, ...env } : process.env,
      });
    } finally {
      cleanup();
    }
  }
  // `-i/--image` is variadic, so it must come AFTER the positional prompt (and
  // session id on resume) or it swallows them. `codex exec resume` rejects
  // --sandbox, so the sandbox mode is set via -c instead.
  const imageArgs = imagePaths.flatMap((p) => ['-i', p]);
  const modelArgs = model ? ['--model', model] : [];
  const normalizedEffort = typeof reasoningEffort === 'string'
    ? reasoningEffort.trim().toLowerCase()
    : '';
  const reasoningEffortArgs = normalizedEffort === 'low' || normalizedEffort === 'medium' || normalizedEffort === 'high' || normalizedEffort === 'xhigh' || normalizedEffort === 'max' || normalizedEffort === 'ultra'
    ? ['-c', `model_reasoning_effort="${normalizedEffort}"`]
    : [];
  const serviceTierArgs = priorityServiceTier ? ['-c', 'service_tier="priority"'] : [];
  const sandboxMode = sandbox || (yolo ? 'danger-full-access' : 'workspace-write');
  const sandboxConfigArgs = sandboxMode === 'workspace-write'
    ? ['-c', 'sandbox_workspace_write.network_access=true']
    : [];
  const buildArgs = (resume?: string) => (resume
    ? ['exec', 'resume', '--json', '--skip-git-repo-check', '-c', `sandbox_mode=${sandboxMode}`, ...sandboxConfigArgs, ...reasoningEffortArgs, ...serviceTierArgs, ...modelArgs, resume, prompt, ...imageArgs]
    : ['exec', '--json', '--skip-git-repo-check', '--sandbox', sandboxMode, ...sandboxConfigArgs, ...reasoningEffortArgs, ...serviceTierArgs, ...modelArgs, prompt, ...imageArgs]);

  let summary = '';
  let sessionId: string | undefined;
  let emittedText = false; // prefix a paragraph break before later turns' text
  let turnCount = 0;
  const emittedTool = new Set<string>();
  const isToolItem = (type: string) => type !== 'agent_message' && type !== 'reasoning';

  if (model) emitCascadeStats(emit, { model });

  // Build a friendly tool_use block from a Codex item.
  const toolUseBlock = (item: any) => {
    if (item.type === 'command_execution') {
      return { type: 'tool_use', id: item.id, name: 'Bash', input: { command: item.command || '' } };
    }
    if (item.type === 'file_change') {
      const file = item.path || item.changes?.[0]?.path || '(files)';
      return { type: 'tool_use', id: item.id, name: 'Edit', input: { file_path: file } };
    }
    return { type: 'tool_use', id: item.id, name: String(item.type), input: {} };
  };

  const emitToolUse = (item: any) => {
    if (!item.id || emittedTool.has(item.id)) return;
    emittedTool.add(item.id);
    emit('text', { message: { content: [toolUseBlock(item)] } });
  };

  const onLine = (line: string) => {
    const ev = JSON.parse(line);
    const item = ev.item;
    // Usage can appear on turn.completed or nested event_msg token_count payloads.
    if (ev.type === 'turn.completed' && ev.usage && typeof ev.usage === 'object') {
      turnCount += 1;
      emitCascadeStats(emit, statsFromUsageBlob(ev.usage as Record<string, unknown>, {
        model,
        numTurns: turnCount,
      }));
    } else if (ev.type === 'event_msg' && ev.payload && typeof ev.payload === 'object') {
      const payload = ev.payload as Record<string, unknown>;
      if (payload.type === 'token_count') {
        const info = (payload.info && typeof payload.info === 'object')
          ? payload.info as Record<string, unknown>
          : payload;
        // Resumed Codex sessions report both cumulative and per-turn usage.
        // Show the latter so Cascade is comparable to an equivalent CLI turn.
        const usage = (info.last_token_usage && typeof info.last_token_usage === 'object')
          ? info.last_token_usage as Record<string, unknown>
          : (info.total_token_usage && typeof info.total_token_usage === 'object')
            ? info.total_token_usage as Record<string, unknown>
            : info;
        emitCascadeStats(emit, statsFromUsageBlob(usage, { model, numTurns: turnCount || undefined }));
      }
    } else if (ev.usage && typeof ev.usage === 'object') {
      emitCascadeStats(emit, statsFromUsageBlob(ev.usage as Record<string, unknown>, { model }));
    }

    switch (ev.type) {
      case 'thread.started':
        if (ev.thread_id) {
          sessionId = ev.thread_id;
          emit('session', { sessionId });
        }
        break;
      case 'item.started':
        if (item && isToolItem(item.type)) emitToolUse(item);
        break;
      case 'item.completed':
        if (!item) break;
        if (item.type === 'agent_message') {
          summary = item.text || summary;
          const text = item.text || '';
          // Codex reports reasoning separately as `reasoning` items. An
          // `agent_message` is therefore safe to render in chat immediately:
          // it is either an intentional progress update or the final answer,
          // not hidden chain-of-thought. Other adapters must opt in explicitly.
          emit('text', {
            chatVisible: true,
            message: { content: [{ type: 'text', text: (emittedText ? '\n\n' : '') + text }] },
          });
          if (text) emittedText = true;
        } else if (item.type === 'reasoning') {
          emit('text', { message: { content: [{ type: 'thinking', text: item.text || '' }] } });
        } else {
          emitToolUse(item); // ensure the card exists even if 'started' was missed
          const out = item.aggregated_output ?? item.output ?? '';
          const isError = typeof item.exit_code === 'number' && item.exit_code !== 0;
          emit('user', { message: { content: [{ type: 'tool_result', tool_use_id: item.id, content: truncate(String(out), 8000), is_error: isError }] } });
          if (isError) {
            void import('./auto-papercut.mjs')
              .then((mod) => mod.autoPapercut(String(out), { tool: String(item.type || item.name || 'tool') }))
              .catch(() => {});
          }
        }
        break;
      // turn.started handled above via usage path; no content blocks.
    }
  };

  // A resumable session lives in Codex's local rollout store, which Cascade
  // does not control: entries are pruned, absent on another machine, and gone
  // once `codex` state is cleared. Asking to resume one that is gone fails the
  // whole turn with "no rollout found for thread id …" — the agent answers
  // nothing at all, for a reason that has nothing to do with the request. The
  // session is an optimization, so lose it and start a new one instead.
  let stderrText = '';
  const collectStderr = (chunk: string) => { stderrText += chunk; };
  const drive = (attemptArgs: string[]) => driveProcess(
    getCliAgentBin('codex'), attemptArgs, cwd, onLine,
    () => summary || '',
    'Codex', runId, emit, env, collectStderr,
  );
  const retryFresh = async () => {
    emitHarness(emit, '\x1b[33m# that session is gone from Codex\'s store — starting a fresh one\x1b[0m\r\n');
    stderrText = '';
    return { summary: await drive(buildArgs(undefined)), sessionId };
  };

  try {
    let summaryText: string;
    try {
      summaryText = await drive(buildArgs(resumeId));
    } catch (error) {
      // The usual shape: codex exits non-zero and driveProcess rejects.
      if (resumeId && isDeadCodexSession(`${stderrText}\n${error instanceof Error ? error.message : String(error)}`)) {
        return await retryFresh();
      }
      throw error;
    }
    // The quieter shape: a zero exit with the complaint only on stderr, which
    // would otherwise complete the turn "successfully" with nothing said.
    if (resumeId && !sessionId && isDeadCodexSession(stderrText)) return await retryFresh();
    return { summary: summaryText, sessionId };
  } finally {
    cleanup();
  }
}

/** Codex's way of saying the session id we asked to resume no longer exists. */
function isDeadCodexSession(stderr: string): boolean {
  return /no rollout found|thread\/resume failed|session not found/i.test(stderr);
}

// ═══════════════════════════════════════════════════════════════
// GROK CLI
// ═══════════════════════════════════════════════════════════════

/**
 * Runs the Grok CLI (`grok --single --output-format streaming-json`) and
 * translates its streaming JSONL into Anthropic-style content blocks.
 *
 * Grok streams `thought` and `text` token chunks, then an `end` event.
 * Tool executions run silently (not surfaced in the stream), so we render
 * accumulated reasoning + the final answer. Disk changes are picked up by
 * the vault rescan afterwards.
 *
 * Grok events → content block mapping:
 *   - `thought` tokens → accumulated, flushed as `{ type: 'thinking', text }`
 *   - `text` tokens    → accumulated into the answer
 *   - `end`            → emits `{ type: 'text', text }`, captures session id
 *
 * @param prompt   - Full prompt (context + user prompt)
 * @param cwd      - Vault root path
 * @param emit     - Event emitter callback
 * @param resumeId - Optional session id to resume a prior conversation
 * @returns Summary text and optional session id
 */
async function runGrok(
  prompt: string,
  cwd: string,
  emit: AgentEmit,
  resumeId?: string,
  runId?: number,
  model?: string,
  env?: NodeJS.ProcessEnv,
): Promise<CliAgentResult> {
  const modelArgs = model ? ['--model', model] : [];
  const debugFile = path.join(os.tmpdir(), `cascade-grok-${runId ?? process.pid}-${Date.now()}.jsonl`);
  const baseArgs = ['--single', prompt, '--output-format', 'streaming-json', '--debug-file', debugFile, '--always-approve', '--cwd', cwd, ...modelArgs];
  const args = resumeId ? ['--resume', resumeId, ...baseArgs] : baseArgs;

  let text = '';
  let sessionId: string | undefined;
  // Separate a turn's answer from the previous one. Grok tools run silently, so
  // a `thought` (or any non-text event) between answers marks the boundary.
  let emittedText = false;
  let lastWasText = false;
  let thoughtChars = 0;
  let textChars = 0;

  if (model) emitCascadeStats(emit, { model });

  const onLine = (line: string) => {
    const ev = JSON.parse(line);
    // Any usage blob mid-stream → surface for harness chips.
    if (ev.usage && typeof ev.usage === 'object') {
      emitCascadeStats(emit, statsFromUsageBlob(ev.usage as Record<string, unknown>, { model }));
    }
    if (ev.type === 'thought') {
      const chunk = String(ev.data || '');
      thoughtChars += chunk.length;
      emit('text', { message: { content: [{ type: 'thinking', thinking: chunk }] } });
      lastWasText = false;
    } else if (ev.type === 'text') {
      const chunk = ev.data || '';
      const sep = (!lastWasText && emittedText) ? '\n\n' : '';
      emit('text', { message: { content: [{ type: 'text', text: sep + chunk }] } });
      text += sep + chunk;
      textChars += String(chunk).length;
      if (chunk) { emittedText = true; lastWasText = true; }
    } else if (ev.type === 'end') {
      if (ev.sessionId) sessionId = ev.sessionId;
      const usage = (ev.usage && typeof ev.usage === 'object')
        ? ev.usage as Record<string, unknown>
        : (ev.stats && typeof ev.stats === 'object' ? ev.stats as Record<string, unknown> : null);
      if (usage) {
        emitCascadeStats(emit, statsFromUsageBlob(usage, { model }));
      } else if (thoughtChars > 0 || textChars > 0) {
        // Rough char-based estimate when the CLI omits usage — labeled approx in UI via raw counts.
        // ~4 chars/token is a common heuristic for Latin text.
        const approxIn = Math.max(1, Math.round((prompt.length) / 4));
        const approxOut = Math.max(0, Math.round((thoughtChars + textChars) / 4));
        emitCascadeStats(emit, {
          model,
          inputTokens: approxIn,
          outputTokens: approxOut,
        });
      }
    }
  };

  try {
    const summaryText = await driveProcess(getCliAgentBin('grok'), args, cwd, onLine, () => text || '', 'Grok', runId, emit, env);
    return { summary: summaryText, sessionId };
  } catch (error) {
    const diagnostic = extractGrokDiagnostic(debugFile);
    const base = error instanceof Error ? error.message : String(error);
    throw new Error(diagnostic ? `${base}\n\nGrok diagnostic:\n${diagnostic}` : base);
  } finally {
    try { fs.unlinkSync(debugFile); } catch { /* ignore */ }
  }
}

// ═══════════════════════════════════════════════════════════════
// ANTIGRAVITY AGENT
// ═══════════════════════════════════════════════════════════════

/** agentapi only accepts these --model= tiers (not full IDE model enums). */
type AntigravityTier = 'flash_lite' | 'flash' | 'pro';
const ANTIGRAVITY_TIERS = new Set<string>(['flash_lite', 'flash', 'pro']);

/** Poll interval while watching transcript.jsonl. */
const AGY_POLL_MS = 400;
/**
 * Only treat "no new transcript lines" as done after a *final* planner
 * response (no tools). Mid-tool gaps used to kill runs at ~10s.
 */
const AGY_IDLE_AFTER_FINAL_POLLS = 8; // ~3.2s settle after final text
/** Surface a terminal tool denial promptly instead of showing Thinking for 3 minutes. */
const AGY_IDLE_AFTER_FAILED_TOOL_POLLS = 20; // ~8s for a recovery planner response
/** Surface an interactive permission block promptly instead of freezing for 3 minutes. */
const AGY_APPROVAL_STALL_POLLS = 15; // ~6s wait for approval
/** Hard ceiling if the agent stalls mid-tool forever (still far above old 10s). */
const AGY_STALL_POLLS = 450; // ~3 min with no new lines
/** Wait for transcript.jsonl after new-conversation / send-message. */
const AGY_TRANSCRIPT_WAIT_MS = 30_000;

type AgyTranscriptStep = {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  content?: string;
  tool_calls?: Array<{ id?: string; name?: string; args?: Record<string, unknown> }>;
};

function antigravityBin(): string {
  return process.env.ANTIGRAVITY_BIN || path.join(os.homedir(), '.gemini', 'antigravity', 'bin', 'agentapi');
}

function antigravityTranscriptPath(conversationId: string): string {
  const p1 = path.join(
    os.homedir(),
    '.gemini',
    'antigravity',
    'brain',
    conversationId,
    '.system_generated',
    'logs',
    'transcript.jsonl',
  );
  if (fs.existsSync(p1)) return p1;
  const p2 = path.join(
    os.homedir(),
    '.gemini',
    'antigravity-cli',
    'brain',
    conversationId,
    '.system_generated',
    'logs',
    'transcript.jsonl',
  );
  if (fs.existsSync(p2)) return p2;
  return p1;
}

/** Planner narration ("I will view…") is harness/thinking — not a chat reply. */
function agyIsPlannerMonologue(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^I will\b/i.test(t)) return true;
  if (/^I(?:'ll| am going to)\b/i.test(t)) return true;
  if (/^Let me\b/i.test(t)) return true;
  return false;
}

function resolveAntigravityProjectConfigPath(cwd: string, createIfMissing?: boolean): string | null {
  const projectsDir = path.join(os.homedir(), '.gemini', 'config', 'projects');
  const absCwd = path.resolve(cwd);
  if (fs.existsSync(projectsDir)) {
    for (const file of fs.readdirSync(projectsDir)) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(projectsDir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        if (content.includes(absCwd) || content.includes(`file://${absCwd}`)) return filePath;
      } catch { /* ignore */ }
    }
  }

  if (!createIfMissing) return null;

  try {
    fs.mkdirSync(projectsDir, { recursive: true });
    const id = randomUUID();
    const filePath = path.join(projectsDir, `${id}.json`);
    const initial = {
      id,
      name: path.basename(absCwd) || 'project',
      projectResources: {
        resources: [
          {
            gitFolder: {
              folderUri: `file://${absCwd}`,
              defaultBranch: 'master',
              allowWrite: true,
            },
          },
        ],
      },
    };
    fs.writeFileSync(filePath, `${JSON.stringify(initial, null, 2)}\n`);
    return filePath;
  } catch {
    return null;
  }
}

function patchAntigravityProjectConfig(filePath: string, cwd?: string, yolo?: boolean): void {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return;
  }

  const settings = (data.settings as Record<string, unknown>) || {};
  settings.fileAccessPolicy = 'AGENT_SETTING_POLICY_ALLOW';
  settings.autoExecutionPolicy = 'CASCADE_COMMANDS_AUTO_EXECUTION_EAGER';
  settings.artifactReviewMode = 'ARTIFACT_REVIEW_MODE_TURBO';
  if (yolo) settings.internetPolicy = 'AGENT_SETTING_POLICY_ALLOW';
  data.settings = settings;

  const grants = new Set<string>();
  const existing = data.permissionGrants as { permissionGrants?: { allow?: string[] } } | undefined;
  for (const g of existing?.permissionGrants?.allow || []) grants.add(g);

  // Wildcard permissions recognized by Antigravity language_server
  grants.add('read_file(*)');
  grants.add('write_file(*)');
  grants.add('command(*)');

  const home = os.homedir();
  const allowedDirs = [
    home,
    path.join(home, '.cascade'),
    path.join(home, '.local'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.config'),
    path.join(home, '.gitconfig'),
    cwd ? path.resolve(cwd) : '',
  ].filter(Boolean);

  const resources = (data.projectResources as { resources?: Array<{ gitFolder?: { folderUri?: string } }> })?.resources || [];
  for (const r of resources) {
    const u = r.gitFolder?.folderUri;
    if (u && u.startsWith('file://')) {
      allowedDirs.push(decodeURIComponent(u.replace(/^file:\/\//, '')));
    }
  }

  for (const dir of allowedDirs) {
    for (const prefix of ['read_file', 'write_file']) {
      grants.add(`${prefix}(${dir})`);
      grants.add(`${prefix}(${dir}/.env)`);
    }
  }

  for (const cmd of [
    'npm', 'node', 'npx', 'agentapi', 'curl', 'rg', 'git', 'bash', 'sh', 'zsh', 'tsx', 'tsc',
    'cascade-chat', 'cascade-note', 'cascade-scratchpad', 'find', 'ls', 'cat', 'grep',
    'which', 'cargo', 'mix', 'echo', 'head', 'tail', 'sed', 'awk', 'python3',
  ]) {
    grants.add(`command(${cmd})`);
  }
  data.permissionGrants = { permissionGrants: { allow: [...grants] } };

  try {
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
  } catch { /* ignore */ }
}

/**
 * Patch Antigravity project configs so Cascade hookup runs auto-approve
 * plans/commands instead of blocking on Seatbelt restrictions or IDE prompts.
 */
function ensureAntigravityCascadeHookup(cwd: string, yolo?: boolean): void {
  const projectsDir = path.join(os.homedir(), '.gemini', 'config', 'projects');
  if (fs.existsSync(projectsDir)) {
    for (const file of fs.readdirSync(projectsDir)) {
      if (!file.endsWith('.json') || file === 'outside-of-project.json') continue;
      patchAntigravityProjectConfig(path.join(projectsDir, file), cwd, yolo);
    }
  }
  const configPath = resolveAntigravityProjectConfigPath(cwd, true);
  if (configPath) {
    patchAntigravityProjectConfig(configPath, cwd, yolo);
  }
}

/** Best-effort LS call to unblock pending plan/permission prompts. */
function agyLsPost(endpoint: string, body: Record<string, unknown>): boolean {
  const discovered = discoverAntigravityEnv();
  const addr = discovered.ANTIGRAVITY_LS_ADDRESS || process.env.ANTIGRAVITY_LS_ADDRESS;
  const token = discovered.ANTIGRAVITY_CSRF_TOKEN || process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (!addr || !token) return false;
  const host = addr.includes('://') ? addr : `http://${addr}`;
  const url = `${host.replace(/\/$/, '')}/exa.language_server_pb.LanguageServerService/${endpoint}`;
  try {
    const result = spawnSync(
      'curl',
      [
        '-sS', '-m', '4',
        '-X', 'POST', url,
        '-H', 'Content-Type: application/json',
        '-H', `X-Codeium-Csrf-Token: ${token}`,
        '-d', JSON.stringify(body),
      ],
      { encoding: 'utf8', timeout: 6000 },
    );
    return result.status === 0;
  } catch {
    return false;
  }
}

function agyTryAutoApprove(conversationId: string): void {
  agyLsPost('ResolveOutstandingSteps', { cascadeId: conversationId });
}

/** Map configured model ids (slugs, enums, labels) to agentapi --model= tiers. */
export function resolveAntigravityModelTier(model?: string | null): AntigravityTier | undefined {
  if (!model || !String(model).trim()) return undefined;
  let raw = String(model).trim();
  if (raw.includes('|')) raw = raw.split('|')[0].trim();
  const lower = raw.toLowerCase();
  if (ANTIGRAVITY_TIERS.has(lower)) return lower as AntigravityTier;

  // GetAvailableModels slugs + enums + human labels.
  // Lite / extra-low → flash_lite
  if (
    /flash_lite|flash-lite|extra-low|flash.*\(low\)|m187\b|m50\b|gemini-2\.5-flash-lite|gemini-3\.1-flash-lite/i.test(raw)
  ) {
    return 'flash_lite';
  }
  // High flash / mid flash / generic flash → flash
  if (
    /flash.*\(high\)|flash.*\(medium\)|m132\b|m20\b|m18\b|m21\b|gemini-3-flash|gemini-3\.8-flash|gemini-3\.5-flash|gemini-2\.5-flash|gemini-3\.1-flash/i.test(raw)
    || lower === 'flash'
  ) {
    return 'flash';
  }
  // Pro family
  if (
    /gemini-2\.5-pro|gemini-3\.1-pro|gemini-pro|pro-high|pro-low|m36\b|m16\b|m37\b|\(high\)|\(low\)/i.test(raw)
    && /pro/i.test(raw)
  ) {
    return 'pro';
  }
  if (/\bpro\b/i.test(raw) && !/flash/i.test(raw)) return 'pro';
  // Claude / GPT-OSS / other cascade slots — agentapi only has tiers; use pro.
  if (/claude|opus|sonnet|gpt|oss|anthropic/i.test(raw)) return 'pro';
  if (/model_placeholder_m/i.test(raw)) return 'pro';
  return undefined;
}

/**
 * Discover Antigravity language_server HTTP address + CSRF + project id.
 * Prefer env, then /proc cmdline + language_server.log, then /proc environ.
 */
function discoverAntigravityEnv(cwd?: string): Record<string, string> {
  const env: Record<string, string> = { ANTIGRAVITY_AGENT: '1' };

  if (process.env.ANTIGRAVITY_PROJECT_ID) {
    env.ANTIGRAVITY_PROJECT_ID = process.env.ANTIGRAVITY_PROJECT_ID;
  } else {
    try {
      const projectsDir = path.join(os.homedir(), '.gemini', 'config', 'projects');
      if (fs.existsSync(projectsDir)) {
        const files = fs.readdirSync(projectsDir);
        let projectId: string | undefined;
        const searchCwd = cwd ? path.resolve(cwd) : process.cwd();
        for (const file of files) {
          if (!file.endsWith('.json')) continue;
          try {
            const filePath = path.join(projectsDir, file);
            const content = fs.readFileSync(filePath, 'utf-8');
            const data = JSON.parse(content) as { id?: string; name?: string };
            if (content.includes(searchCwd) || content.includes(`file://${searchCwd}`) || data.name === 'cascade') {
              projectId = data.id || file.replace(/\.json$/, '');
              break;
            }
          } catch { /* ignore */ }
        }
        if (!projectId) {
          const firstJson = files.find((f) => f.endsWith('.json'));
          if (firstJson) projectId = firstJson.replace(/\.json$/, '');
        }
        if (projectId) env.ANTIGRAVITY_PROJECT_ID = projectId;
      }
    } catch { /* ignore */ }
  }

  if (process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN) {
    env.ANTIGRAVITY_LS_ADDRESS = process.env.ANTIGRAVITY_LS_ADDRESS;
    env.ANTIGRAVITY_CSRF_TOKEN = process.env.ANTIGRAVITY_CSRF_TOKEN;
    return env;
  }

  let token: string | undefined;
  let port: string | undefined;

  // macOS has no /proc: inspect the running language_server via `ps` (for the
  // --csrf_token) and `lsof` (for its live listening port). The Antigravity log
  // records a random port but is unreliable across restarts, so trust the socket.
  if (process.platform === 'darwin') {
    try {
      const ps = spawnSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf-8' });
      const lines = (ps.stdout || '').split('\n');
      for (const l of lines) {
        // The real LS binary, not the "Antigravity Helper" Electron children.
        if (!/\/language_server(\s|$)/.test(l)) continue;
        const tokenMatch = l.match(/--csrf_token\s+(\S+)/);
        const pidMatch = l.match(/^\s*(\d+)\s/);
        if (!tokenMatch || !pidMatch) continue;
        token = tokenMatch[1];
        const pid = pidMatch[1];
        const lsof = spawnSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', pid], { encoding: 'utf-8' });
        const ports = [...(lsof.stdout || '').matchAll(/127\.0\.0\.1:(\d+)\s+\(LISTEN\)/g)]
          .map((m) => parseInt(m[1], 10))
          .filter((n) => Number.isFinite(n));
        // Probe ports to find the real HTTP/gRPC LanguageServerService endpoint.
        // The LS opens paired HTTPS/HTTP ports initially plus internal sandbox proxy ports later.
        // The real HTTP endpoint serves HTML with __APP_CONFIG__ and returns HTTP 200 on /.
        for (const p of ports) {
          try {
            const probe = spawnSync('curl', ['-s', '-m', '1', `http://127.0.0.1:${p}/`], { encoding: 'utf-8' });
            if (probe.stdout && (probe.stdout.includes('__APP_CONFIG__') || probe.stdout.includes('<!doctype html>'))) {
              port = String(p);
              break;
            }
          } catch { /* ignore */ }
        }
        if (!port && ports.length > 0) {
          port = String(ports.length > 1 ? ports[1] : ports[0]);
        }
        break;
      }
    } catch { /* fall through to /proc + log scanning below */ }

    if (port && token) {
      env.ANTIGRAVITY_LS_ADDRESS = `127.0.0.1:${port}`;
      env.ANTIGRAVITY_CSRF_TOKEN = token;
      return env;
    }
  }

  try {
    for (const file of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(file)) continue;
      try {
        const cmdline = fs.readFileSync(`/proc/${file}/cmdline`, 'utf-8');
        if (!cmdline.includes('language_server')) continue;
        const parts = cmdline.split('\0');
        const tokenIdx = parts.indexOf('--csrf_token');
        if (tokenIdx !== -1 && parts[tokenIdx + 1]) {
          token = parts[tokenIdx + 1];
          break;
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }

  try {
    const logPath = path.join(os.homedir(), '.config', 'Antigravity', 'logs', 'language_server.log');
    if (fs.existsSync(logPath)) {
      const content = fs.readFileSync(logPath, 'utf-8');
      const matches = [...content.matchAll(/Language server listening on random port at (\d+) for HTTP/g)];
      if (matches.length > 0) port = matches[matches.length - 1][1];
    }
  } catch { /* ignore */ }

  // Validate log port is actually open; fall back to /proc/net/tcp listeners later if needed.
  if (port && token) {
    env.ANTIGRAVITY_LS_ADDRESS = `localhost:${port}`;
    env.ANTIGRAVITY_CSRF_TOKEN = token;
    return env;
  }

  try {
    for (const file of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(file)) continue;
      try {
        const envContent = fs.readFileSync(`/proc/${file}/environ`, 'utf-8');
        const parts = envContent.split('\0');
        const addrVar = parts.find((p) => p.startsWith('ANTIGRAVITY_LS_ADDRESS='));
        const tokenVar = parts.find((p) => p.startsWith('ANTIGRAVITY_CSRF_TOKEN='));
        if (addrVar && tokenVar) {
          env.ANTIGRAVITY_LS_ADDRESS = addrVar.slice('ANTIGRAVITY_LS_ADDRESS='.length);
          env.ANTIGRAVITY_CSRF_TOKEN = tokenVar.slice('ANTIGRAVITY_CSRF_TOKEN='.length);
          break;
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }

  return env;
}

function agyToolFriendlyName(name: string): string {
  const n = (name || '').trim();
  const map: Record<string, string> = {
    list_dir: 'List Directory',
    list_directory: 'List Directory',
    view_file: 'View File',
    write_to_file: 'Write File',
    replace_file_content: 'Edit File',
    multi_replace_file_content: 'Edit File',
    grep_search: 'Search Workspace',
    run_command: 'Bash',
    search_web: 'Web Search',
    code_action: 'Code Action',
    generate_image: 'Generate Image',
    invoke_subagent: 'Subagent',
    ask_question: 'Ask Question',
    read_browser_page: 'Browser',
    open_browser_url: 'Browser',
  };
  return map[n] || map[n.toLowerCase()] || n || 'Tool';
}

function agyPreviewInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input.slice(0, 200);
  if (typeof input !== 'object') return String(input).slice(0, 200);
  const rec = input as Record<string, unknown>;
  for (const key of ['Command', 'command', 'DirectoryPath', 'FilePath', 'file_path', 'path', 'Query', 'pattern', 'Url', 'url']) {
    const v = rec[key];
    if (typeof v === 'string' && v.trim()) {
      // agentapi sometimes double-quotes JSON string values
      return v.replace(/^"+|"+$/g, '').slice(0, 200);
    }
  }
  try {
    return JSON.stringify(input).slice(0, 200);
  } catch {
    return '';
  }
}

function agyNormalizeToolArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (typeof v === 'string') {
      const unquoted = v.replace(/^"+|"+$/g, '');
      out[k] = unquoted;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Spawn agentapi (or other) and capture stdout; tees to harness; tracks cancel. */
function runCommand(
  bin: string,
  args: string[],
  cwd: string,
  runId?: number,
  emit?: AgentEmit,
  baseEnv?: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const discoveredEnv = discoverAntigravityEnv(cwd);
    const env = { ...(baseEnv || process.env), ...discoveredEnv };
    delete env.ANTIGRAVITY_CONVERSATION_ID;
    delete env.ANTIGRAVITY_SOURCE_METADATA;

    if (!env.ANTIGRAVITY_LS_ADDRESS || !env.ANTIGRAVITY_CSRF_TOKEN) {
      reject(new Error(
        'Antigravity language server not found (ANTIGRAVITY_LS_ADDRESS / CSRF). '
        + 'Open the Antigravity app and sign in, then retry.',
      ));
      return;
    }

    emitHarness(emit, `\x1b[2m$ ${bin} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}\x1b[0m\r\n`);
    emitHarness(emit, `\x1b[2m# antigravity ls ${env.ANTIGRAVITY_LS_ADDRESS} · project ${env.ANTIGRAVITY_PROJECT_ID || '?'}\x1b[0m\r\n`);

    const timing = createRequestTiming(emit, 'agentapi_process_stdout');
    let child: ChildProcess;
    try {
      child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      timing.complete('launch_failed');
      reject(new Error(`Failed to launch agentapi: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    if (runId !== undefined) activeCliProcesses.set(runId, child);

    let stdout = '';
    let stderr = '';
    let settled = false;
    const cleanup = () => {
      if (runId !== undefined) activeCliProcesses.delete(runId);
    };

    child.stdout?.on('data', (d: Buffer | string) => {
      if (d.length) timing.firstResponse();
      const chunk = d.toString();
      stdout += chunk;
      // agentapi returns one JSON blob — keep harness tidy (no full prompt dump)
    });
    child.stderr?.on('data', (d: Buffer | string) => {
      const chunk = d.toString();
      stderr += chunk;
      emitHarness(emit, `\x1b[31m${chunk}\x1b[0m`);
    });
    child.on('error', (err) => {
      timing.complete('launch_failed');
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`agentapi could not start: ${err.message}`));
    });
    child.on('close', (code, signal) => {
      timing.complete(signal ? 'signaled' : code === 0 ? 'completed' : 'failed');
      if (settled) return;
      settled = true;
      cleanup();
      emitHarness(emit, `\x1b[2m# agentapi exit ${code ?? '?'}\x1b[0m\r\n`);
      if (code === 0) {
        resolve(stdout);
      } else {
        const detail = (stderr || stdout).trim().slice(-800);
        reject(new Error(`agentapi exited ${code}${detail ? `: ${detail}` : ''}`));
      }
    });
  });
}

/**
 * Runs the Antigravity agent via agentapi + transcript.jsonl polling.
 * Emits structured text/thinking/tool blocks for the chat harness panel
 * (not raw JSONL dumps).
 */
async function runAntigravity(
  prompt: string,
  cwd: string,
  emit: AgentEmit,
  resumeId?: string,
  runId?: number,
  model?: string,
  yolo?: boolean,
  env?: NodeJS.ProcessEnv,
): Promise<CliAgentResult> {
  const bin = antigravityBin();
  assertCliAgentAvailable('antigravity');
  ensureAntigravityCascadeHookup(cwd, yolo);
  if (runId !== undefined) antigravityCancelFlags.delete(runId);

  // Snapshot line count before send-message so we only stream new turns.
  let processedLines = 0;
  if (resumeId) {
    const prior = antigravityTranscriptPath(resumeId);
    if (fs.existsSync(prior)) {
      processedLines = fs.readFileSync(prior, 'utf-8').split('\n').filter((l) => l.trim()).length;
    }
  }

  const tier = resolveAntigravityModelTier(model);
  const args: string[] = resumeId
    ? ['send-message', resumeId, prompt]
    : (() => {
        const a = ['new-conversation'];
        if (tier) a.push(`--model=${tier}`);
        a.push(prompt);
        return a;
      })();

  if (model && tier && model !== tier) {
    emitHarness(emit, `\x1b[2m# model ${model} → agentapi tier ${tier}\x1b[0m\r\n`);
  } else if (tier) {
    emitCascadeStats(emit, { model: tier });
  }

  let stdoutStr: string;
  try {
    stdoutStr = await runCommand(bin, args, cwd, runId, emit, env ? { ...process.env, ...env } : undefined);
  } catch (err) {
    throw new Error(`Failed to run agentapi: ${err instanceof Error ? err.message : String(err)}`);
  }

  let conversationId = '';
  try {
    const res = JSON.parse(stdoutStr) as {
      error?: string;
      response?: {
        newConversation?: { conversationId?: string };
        sendMessage?: { recipientId?: string };
      };
    };
    if (res.error) throw new Error(res.error);
    conversationId = res.response?.newConversation?.conversationId
      || res.response?.sendMessage?.recipientId
      || '';
  } catch (err) {
    if (err instanceof Error && !err.message.includes('JSON')) throw err;
    throw new Error(`Failed to parse agentapi JSON output: ${stdoutStr.slice(0, 500)}`);
  }
  if (!conversationId) {
    throw new Error(`No conversationId returned by agentapi: ${stdoutStr.slice(0, 500)}`);
  }

  emit('session', { sessionId: conversationId });

  emitHarness(emit, `\x1b[2m# conversation ${conversationId}\x1b[0m\r\n`);
  const transcriptPath = antigravityTranscriptPath(conversationId);

  // Wait for transcript file
  const waitDeadline = Date.now() + AGY_TRANSCRIPT_WAIT_MS;
  while (!fs.existsSync(transcriptPath)) {
    if (Date.now() > waitDeadline) {
      throw new Error(`Transcript file was not created at ${transcriptPath}`);
    }
    if (runId !== undefined && antigravityCancelFlags.has(runId)) {
      return { summary: 'Run canceled by user.', sessionId: conversationId };
    }
    await sleep(AGY_POLL_MS);
  }

  let summary = '';
  let done = false;
  let sawFinalPlanner = false;
  let idleAfterFinal = 0;
  let idleAfterFailedTool = 0;
  let stallPolls = 0;
  let approvePolls = 0;
  const pendingToolIds: string[] = [];
  const pendingSandboxBypassToolIds = new Set<string>();
  const emittedTools = new Set<string>();
  let emittedText = false;
  let failedToolError = '';

  const checkTranscript = (): void => {
    let content: string;
    try {
      content = fs.readFileSync(transcriptPath, 'utf-8');
    } catch {
      return;
    }
    const lines = content.split('\n').filter((l) => l.trim());
    if (lines.length <= processedLines) {
      stallPolls += 1;
      if (pendingToolIds.length > 0 && stallPolls >= 3 && stallPolls % 3 === 0) {
        agyTryAutoApprove(conversationId);
      }
      if (sawFinalPlanner) {
        idleAfterFinal += 1;
        if (idleAfterFinal >= AGY_IDLE_AFTER_FINAL_POLLS) done = true;
      } else if (failedToolError && pendingToolIds.length === 0) {
        idleAfterFailedTool += 1;
        if (idleAfterFailedTool >= AGY_IDLE_AFTER_FAILED_TOOL_POLLS) done = true;
      } else if (pendingSandboxBypassToolIds.size > 0 && stallPolls >= AGY_APPROVAL_STALL_POLLS) {
        const toolId = pendingToolIds.shift() || [...pendingSandboxBypassToolIds][0];
        pendingSandboxBypassToolIds.delete(toolId);
        const errMsg = 'Tool requested BypassSandbox which requires interactive IDE permission approval (unavailable in headless runner).';
        emit('user', {
          message: {
            content: [{
              type: 'tool_result',
              tool_use_id: toolId,
              content: errMsg,
              is_error: true,
            }],
          },
        });
        emitHarness(emit, `\x1b[31m✖ ${errMsg}\x1b[0m\r\n`);
        failedToolError = errMsg;
        done = true;
      } else if (stallPolls >= AGY_STALL_POLLS) {
        emitHarness(emit, `\x1b[33m# stall timeout after ${Math.round((AGY_STALL_POLLS * AGY_POLL_MS) / 1000)}s with no transcript progress\x1b[0m\r\n`);
        done = true;
      }
      return;
    }

    stallPolls = 0;
    idleAfterFinal = 0;
    idleAfterFailedTool = 0;

    for (let i = processedLines; i < lines.length; i++) {
      let step: AgyTranscriptStep;
      try {
        step = JSON.parse(lines[i]) as AgyTranscriptStep;
      } catch {
        continue;
      }

      const source = step.source || '';
      const type = (step.type || '').toUpperCase();
      const status = (step.status || '').toUpperCase();

      // Skip system noise in structured stream (still ignore raw dump).
      if (type === 'CONVERSATION_HISTORY' || type === 'USER_INPUT' || type === 'SYSTEM_MESSAGE') {
        continue;
      }

      if (source === 'MODEL' && type === 'PLANNER_RESPONSE') {
        // A new planner response means the model recovered from any prior
        // failed command and is continuing the turn.
        failedToolError = '';
        const text = (step.content || '').trim();
        const toolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
        const isThinking = toolCalls.length > 0 || agyIsPlannerMonologue(text);

        if (text) {
          if (isThinking) {
            // Monologue before tools → thinking only (never chat body / summary).
            emit('text', {
              message: { content: [{ type: 'thinking', thinking: text }] },
            });
            emitHarness(emit, `\x1b[2m# thinking\x1b[0m\r\n\x1b[2m${text.slice(0, 500)}\x1b[0m\r\n`);
          } else {
            summary = text;
            const sep = emittedText ? '\n\n' : '';
            emit('text', {
              message: { content: [{ type: 'text', text: sep + text }] },
            });
            emittedText = true;
            emitHarness(emit, `${text}\r\n`);
          }
        }

        for (const tc of toolCalls) {
          const toolId = tc.id || `agy-${conversationId}-${step.step_index ?? i}-${pendingToolIds.length}`;
          if (emittedTools.has(toolId)) continue;
          emittedTools.add(toolId);
          pendingToolIds.push(toolId);
          const name = agyToolFriendlyName(tc.name || 'tool');
          const input = agyNormalizeToolArgs(tc.args);
          const rawArgs = (tc.args && typeof tc.args === 'object') ? tc.args as Record<string, unknown> : {};
          const isBypass = String(input.BypassSandbox || rawArgs.BypassSandbox || '').toLowerCase() === 'true';
          if (isBypass) pendingSandboxBypassToolIds.add(toolId);
          emit('text', {
            message: {
              content: [{ type: 'tool_use', id: toolId, name, input }],
            },
          });
          const preview = agyPreviewInput(input);
          emitHarness(emit, `\x1b[36m▶ ${name}\x1b[0m${preview ? ` ${preview}` : ''}\r\n`);
        }

        // True completion: planner finished with no more tools.
        if (status === 'DONE' && toolCalls.length === 0) {
          sawFinalPlanner = true;
        } else {
          sawFinalPlanner = false;
        }
        continue;
      }

      // Tool results and other model steps
      if (source === 'MODEL' || source === 'SYSTEM') {
        if (type === 'ERROR_MESSAGE' || status === 'ERROR') {
          const msg = String(step.content || 'Antigravity error').slice(0, 2000);
          if (/denied permission|pending review|user interaction|awaiting approval/i.test(msg)) {
            agyTryAutoApprove(conversationId);
          }
          emitHarness(emit, `\x1b[31m✖ ${msg}\x1b[0m\r\n`);
          const toolId = pendingToolIds.shift();
          if (toolId) {
            pendingSandboxBypassToolIds.delete(toolId);
            emit('user', {
              message: {
                content: [{
                  type: 'tool_result',
                  tool_use_id: toolId,
                  content: truncate(msg, 8000),
                  is_error: true,
                }],
              },
            });
          }
          continue;
        }

        // Tool execution result steps (VIEW_FILE, RUN_COMMAND, …)
        if (type !== 'PLANNER_RESPONSE' && type !== 'EPHEMERAL_MESSAGE' && type !== 'CHECKPOINT') {
          const outText = String(step.content || '');
          const toolId = pendingToolIds.shift() || `agy-result-${step.step_index ?? i}`;
          pendingSandboxBypassToolIds.delete(toolId);
          const isPermissionDenied = /operation not permitted|permission denied|awaiting approval|user denied permission/i.test(outText);
          const commandFailed = /command exited with code\s+(?!0\b)\d+/i.test(outText);
          const isError = status === 'ERROR' || commandFailed || isPermissionDenied;
          if (isPermissionDenied) {
            agyTryAutoApprove(conversationId);
            failedToolError = outText.trim().slice(-2000) || `${type} permission denied`;
          } else {
            failedToolError = '';
          }
          emit('user', {
            message: {
              content: [{
                type: 'tool_result',
                tool_use_id: toolId,
                content: truncate(outText, 8000),
                is_error: isError,
              }],
            },
          });
          if (isError) {
            void import('./auto-papercut.mjs')
              .then((mod) => mod.autoPapercut(outText, { tool: String(type || 'tool') }))
              .catch(() => {});
          }
          const preview = outText.replace(/\s+/g, ' ').trim().slice(0, 160);
          emitHarness(emit, `${isError ? '\x1b[31m' : '\x1b[2m'}◀ ${type}${preview ? `: ${preview}` : ''}\x1b[0m\r\n`);
          sawFinalPlanner = false;
        }
      }
    }
    processedLines = lines.length;

    // If we already saw final planner and drained new lines, allow settle.
    if (sawFinalPlanner && pendingToolIds.length === 0) {
      idleAfterFinal = Math.max(idleAfterFinal, 1);
    }
  };

  while (!done) {
    if (runId !== undefined && antigravityCancelFlags.has(runId)) {
      return { summary: summary || 'Run canceled by user.', sessionId: conversationId };
    }
    // Desktop cancel kills the agentapi child; after that we only poll. Also
    // treat explicit cancel flag on the process map absence mid-wait as soft.
    try {
      checkTranscript();
    } catch { /* ignore single poll errors */ }
    approvePolls += 1;
    if (approvePolls % 15 === 0) agyTryAutoApprove(conversationId);
    if (!done) await sleep(AGY_POLL_MS);
  }

  if (failedToolError && !sawFinalPlanner) {
    throw new Error(`Antigravity stopped after a failed tool call:\n${failedToolError}`);
  }

  if (!emittedText || !summary.trim() || agyIsPlannerMonologue(summary)) {
    // No user-visible success placeholder — empty summary drops the chat shell.
    summary = '';
  }

  emitHarness(emit, `\x1b[2m# done · ${processedLines} transcript lines\x1b[0m\r\n`);
  if (runId !== undefined) antigravityCancelFlags.delete(runId);
  return { summary, sessionId: conversationId };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Set by cancel hooks so transcript polling stops promptly. */
const antigravityCancelFlags = new Set<number>();

/** Allow desktop cancel to stop transcript polling without a live child. */
export function cancelAntigravityRun(runId: number): void {
  antigravityCancelFlags.add(runId);
  const child = activeCliProcesses.get(runId);
  if (child) {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    activeCliProcesses.delete(runId);
  }
}

// ═══════════════════════════════════════════════════════════════
// COPILOT AGENT
// ═══════════════════════════════════════════════════════════════

/**
 * Runs the Copilot CLI and translates its JSONL event stream into content blocks.
 */
async function runCopilot(prompt: string, cwd: string, emit: AgentEmit, resumeId?: string, runId?: number, model?: string, env?: NodeJS.ProcessEnv): Promise<CliAgentResult> {
  const modelArgs = model ? ['--model', model] : [];
  const baseArgs = ['-p', prompt, '--output-format', 'json', '--yolo', ...modelArgs];
  const args = resumeId ? ['--session-id', resumeId, ...baseArgs] : baseArgs;

  let summary = '';
  let reasoningText = '';
  let sessionId: string | undefined;
  const emittedTool = new Set<string>();
  // Separate each answer turn from the previous one; reasoning/tool events
  // between turns reset the flag so the next text starts a new paragraph.
  let emittedText = false;
  let lastWasText = false;

  const getToolFriendlyName = (name: string) => {
    if (name === 'read' || name === 'view_file') return 'View File';
    if (name === 'write' || name === 'write_to_file' || name === 'create') return 'Write File';
    if (name === 'edit' || name === 'replace_file_content' || name === 'multi_replace_file_content') return 'Edit File';
    if (name === 'grep' || name === 'grep_search') return 'Search Workspace';
    if (name === 'bash' || name === 'run_command') return 'Bash';
    return name;
  };

  const onLine = (line: string) => {
    try {
      if (line.startsWith('{')) {
        const ev = JSON.parse(line);
        switch (ev.type) {
          case 'assistant.reasoning_delta':
            if (ev.data?.deltaContent) {
              reasoningText += ev.data.deltaContent;
              emit('text', { message: { content: [{ type: 'thinking', thinking: ev.data.deltaContent }] } });
              lastWasText = false;
            }
            break;
          case 'assistant.reasoning':
            if (ev.data?.content) {
              const hadDeltas = reasoningText.length > 0;
              reasoningText = ev.data.content;
              if (!hadDeltas) {
                emit('text', { message: { content: [{ type: 'thinking', thinking: ev.data.content }] } });
              }
              lastWasText = false;
            }
            break;
          case 'assistant.message_delta':
            if (ev.data?.deltaContent) {
              const sep = (!lastWasText && emittedText) ? '\n\n' : '';
              summary += sep + ev.data.deltaContent;
              emit('text', { message: { content: [{ type: 'text', text: sep + ev.data.deltaContent }] } });
              emittedText = true;
              lastWasText = true;
            }
            break;
          case 'assistant.message':
            if (ev.data) {
              if (ev.data.content) {
                const hadDeltas = summary.length > 0;
                summary = ev.data.content;
                if (!hadDeltas) {
                  const sep = (!lastWasText && emittedText) ? '\n\n' : '';
                  emit('text', { message: { content: [{ type: 'text', text: sep + ev.data.content }] } });
                  emittedText = true;
                  lastWasText = true;
                }
              }
              for (const req of ev.data.toolRequests || []) {
                if (req.toolCallId && !emittedTool.has(req.toolCallId)) {
                  emittedTool.add(req.toolCallId);
                  emit('text', {
                    message: {
                      content: [{
                        type: 'tool_use',
                        id: req.toolCallId,
                        name: getToolFriendlyName(req.name),
                        input: req.arguments || {}
                      }]
                    }
                  });
                  lastWasText = false;
                }
              }
            }
            break;
          case 'tool.execution_start':
            if (ev.data?.toolCallId && !emittedTool.has(ev.data.toolCallId)) {
              emittedTool.add(ev.data.toolCallId);
              emit('text', {
                message: {
                  content: [{
                    type: 'tool_use',
                    id: ev.data.toolCallId,
                    name: getToolFriendlyName(ev.data.toolName),
                    input: ev.data.arguments || {}
                  }]
                }
              });
              lastWasText = false;
            }
            break;
          case 'tool.execution_complete':
            if (ev.data?.toolCallId) {
              const out = ev.data.result?.content ?? ev.data.result?.detailedContent ?? '';
              const isError = ev.data.success === false;
              emit('user', {
                message: {
                  content: [{
                    type: 'tool_result',
                    tool_use_id: ev.data.toolCallId,
                    content: truncate(String(out), 8000),
                    is_error: isError
                  }]
                }
              });
              if (isError) {
                void import('./auto-papercut.mjs')
                  .then((mod) => mod.autoPapercut(String(out), { tool: String(ev.data.toolName || 'tool') }))
                  .catch(() => {});
              }
              lastWasText = false;
            }
            break;
          case 'result':
            if (ev.sessionId) {
              sessionId = ev.sessionId;
              emit('session', { sessionId });
            }
            break;
        }
      } else {
        summary = line;
        emit('text', { message: { content: [{ type: 'text', text: line + '\n' }] } });
      }
    } catch {
      summary = line;
      emit('text', { message: { content: [{ type: 'text', text: line + '\n' }] } });
    }
  };

  const summaryText = await driveProcess(getCliAgentBin('copilot'), args, cwd, onLine, () => summary || '', 'Copilot', runId, emit, env);
  return { summary: summaryText, sessionId: sessionId || resumeId };
}

// ═══════════════════════════════════════════════════════════════
// HERMES AGENT
// ═══════════════════════════════════════════════════════════════

/**
 * Runs the Hermes CLI and translates its output into content blocks.
 *
 * Both fresh and resumed turns go through `hermes chat -Q -q`, which keeps
 * stdout to the final response only and reports `session_id:` on stderr.
 *
 * Oneshot (`-z`) is deliberately not used for fresh runs: it is equally quiet
 * on stdout but never reports a session id, so nothing could be resumed and
 * every turn restarted cold. Hermes oneshot also ignores `--resume`, so the
 * `chat` path is the only one that can both open and extend a session.
 *
 * With `HERMES_CASCADE_EVENTS=1` it also streams reasoning deltas as NDJSON on stderr.
 */
async function runHermes(prompt: string, cwd: string, emit: AgentEmit, resumeId?: string, runId?: number, env?: NodeJS.ProcessEnv, model?: string, profile?: string, safeMode = false, yolo = false): Promise<CliAgentResult> {
  const modelArgs = model?.trim() ? ['-m', model.trim()] : [];
  const profileName = profile?.trim() || '';
  if (profileName && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profileName)) {
    throw new Error('Hermes profile must use letters, numbers, dots, underscores, or dashes.');
  }
  const profileArgs = profileName ? ['-p', profileName] : [];
  const postureArgs = [...(yolo ? ['--yolo'] : []), ...(safeMode ? ['--safe-mode'] : [])];
  const args = resumeId
    ? [...profileArgs, 'chat', '-Q', '--resume', resumeId, '-q', prompt, ...modelArgs, ...postureArgs]
    : [...profileArgs, 'chat', '-Q', '-q', prompt, ...modelArgs, ...postureArgs];

  let text = '';
  let sessionId: string | undefined = resumeId;

  // `-Q` suppresses the banner, spinner and tool previews but still renders a
  // box-drawn "Reasoning" panel on stdout. Left alone it lands in the chat
  // message as if it were the model's answer, so route it to thinking blocks
  // and keep it out of the summary.
  let inReasoning = false;
  const onStdoutLine = (line: string, carriageReturn?: boolean) => {
    if (HERMES_REASONING_OPEN.test(line)) {
      inReasoning = true;
      return;
    }
    if (inReasoning) {
      // The panel's body lines are CR-terminated; the first LF-terminated line
      // (or an explicit bottom border) is the real answer resuming.
      if (HERMES_REASONING_CLOSE.test(line)) {
        inReasoning = false;
        return;
      }
      if (carriageReturn) {
        emit('text', { message: { content: [{ type: 'thinking', thinking: line + '\n' }] } });
        return;
      }
      inReasoning = false;
    }
    text += line + '\n';
    // Keep the line break so multi-line output doesn't collapse onto one line.
    emit('text', { message: { content: [{ type: 'text', text: line + '\n' }] } });
  };

  const onStderrLine = (line: string) => {
    const quietSession = /^session_id:\s*(\S+)$/i.exec(line);
    if (quietSession) {
      sessionId = quietSession[1];
      emit('session', { sessionId });
      return;
    }
    if (!line.startsWith('{')) return;
    const ev = JSON.parse(line) as { type?: string; text?: string; id?: string };
    if (ev.type === 'reasoning.delta' && ev.text) {
      emit('text', { message: { content: [{ type: 'thinking', thinking: ev.text }] } });
    } else if (ev.type === 'session_id' && ev.id) {
      sessionId = ev.id;
      emit('session', { sessionId });
    }
  };

  let summaryText = '';
  const maxAttempts = Math.max(3, HERMES_UPSTREAM_RETRIES + 1);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      summaryText = await driveHermesProcess(
        getCliAgentBin('hermes'),
        args,
        cwd,
        onStdoutLine,
        onStderrLine,
        () => text.trim() || '',
        'Hermes',
        runId,
        emit,
        env,
        HERMES_IDLE_TIMEOUT_MS,
      );
    } catch (error) {
      if (!(error instanceof CliIdleTimeoutError) || attempt >= 2 || text.trim()) throw error;
      // No model or tool output means the first request was never observable;
      // a fresh provider bridge is safe to retry without duplicating work.
      emitHarness(emit, `\x1b[2m# provider returned no bytes; retrying Hermes (${attempt + 1}/2) with a fresh bridge\x1b[0m\r\n`);
      continue;
    }
    // Hermes exits 0 even when it only managed to print an upstream 503 as its
    // "answer". Treat that as transient and retry the whole turn with backoff
    // rather than handing the capacity error back as the reply.
    const upstreamFailure = isHermesUpstreamFailure(summaryText) || isHermesUpstreamFailure(text);
    if (upstreamFailure && attempt < HERMES_UPSTREAM_RETRIES) {
      const backoff = Math.min(HERMES_UPSTREAM_BACKOFF_CAP_MS, HERMES_UPSTREAM_BACKOFF_MS * (attempt + 1));
      emitHarness(emit, `\x1b[33m# hermes hit a transient upstream error (503); retrying (${attempt + 1}/${HERMES_UPSTREAM_RETRIES}) after ${Math.round(backoff / 1000)}s\x1b[0m\r\n`);
      // Discard the failed turn's output so the retry starts from a clean slate.
      text = '';
      inReasoning = false;
      summaryText = '';
      await sleep(backoff);
      continue;
    }
    break;
  }
  return { summary: summaryText, sessionId };
}

/**
 * Runs Akron's Grok-backed Hermes loop through its native launcher.
 *
 * Akron's `-z` path keeps stdout machine-readable while the launcher's local
 * Grok bridge supplies inference. The native Akron toolset exposes its typed
 * `scratchpad` adapter exactly once; Cascade's prompt formatter omits its
 * parallel cascade-scratchpad instructions for this provider.
 */
async function runAkronGrok(prompt: string, cwd: string, emit: AgentEmit, _resumeId?: string, runId?: number, env?: NodeJS.ProcessEnv): Promise<CliAgentResult> {
  const baseArgs = [
    '--grok',
    '-z',
    prompt,
    '--yolo',
  ];
  // Hermes oneshot owns a fresh session. Cascade injects recent channel
  // context on each cold run, so do not claim resumability that -z lacks.
  const args = baseArgs;

  let text = '';
  const onStdoutLine = (line: string) => {
    text += line + '\n';
    emit('text', { message: { content: [{ type: 'text', text: line + '\n' }] } });
  };

  const onStderrLine = (line: string) => {
    if (!line.startsWith('{')) return;
    const ev = JSON.parse(line) as { type?: string; text?: string };
    if (ev.type === 'reasoning.delta' && ev.text) {
      emit('text', { message: { content: [{ type: 'thinking', thinking: ev.text }] } });
    }
  };

  let summaryText = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      summaryText = await driveHermesProcess(
        getCliAgentBin('akron-grok'),
        args,
        cwd,
        onStdoutLine,
        onStderrLine,
        () => text.trim() || '',
        'Akron --grok',
        runId,
        emit,
        env,
        AKRON_IDLE_TIMEOUT_MS,
      );
      break;
    } catch (error) {
      if (!(error instanceof CliIdleTimeoutError) || attempt > 0) throw error;
      // Grok Build occasionally accepts a request but never returns its first
      // response byte. A fresh bridge/request succeeds in practice. Retrying is
      // safe here because Hermes emitted no provider or tool event whatsoever.
      emitHarness(emit, '\x1b[2m# provider returned no bytes; retrying Akron once with a fresh bridge\x1b[0m\r\n');
      text = '';
    }
  }
  return { summary: summaryText };
}

/** Like driveProcess, but also parses Hermes cascade NDJSON events from stderr. */
function driveHermesProcess(
  bin: string,
  args: string[],
  cwd: string,
  onStdoutLine: (line: string, carriageReturn?: boolean) => void,
  onStderrLine: (line: string) => void,
  getSummary: () => string,
  label: string,
  runId?: number,
  emit?: AgentEmit,
  env?: NodeJS.ProcessEnv,
  idleTimeoutMs = CLI_IDLE_TIMEOUT_MS,
): Promise<string> {
  return driveProcess(bin, args, cwd, onStdoutLine, getSummary, label, runId, emit, env,
    undefined, { onStderrLine, idleTimeoutMs });
}
// ═══════════════════════════════════════════════════════════════
// PI-FAMILY JSON EVENT AGENTS
// ═══════════════════════════════════════════════════════════════

/**
 * Runs the OMP CLI and translates its JSONL event stream into content blocks.
 */
async function runPiJsonAgent(
  bin: string,
  label: string,
  args: string[],
  cwd: string,
  emit: AgentEmit,
  runId?: number,
  env?: NodeJS.ProcessEnv,
): Promise<CliAgentResult> {
  let summary = '';
  let sessionId: string | undefined;
  const emittedTool = new Set<string>();
  let emittedText = false;
  let lastWasText = false;

  const getToolFriendlyName = (name: string) => {
    if (name === 'read' || name === 'view_file') return 'View File';
    if (name === 'write' || name === 'write_to_file' || name === 'create') return 'Write File';
    if (name === 'edit' || name === 'replace_file_content' || name === 'multi_replace_file_content') return 'Edit File';
    if (name === 'grep' || name === 'grep_search') return 'Search Workspace';
    if (name === 'bash' || name === 'run_command') return 'Bash';
    return name;
  };

  const onLine = (line: string) => {
    try {
      if (line.startsWith('{')) {
        const ev = JSON.parse(line);
        switch (ev.type) {
          case 'session':
            if (ev.id) {
              sessionId = ev.id;
              emit('session', { sessionId });
            }
            break;
          case 'message_update':
            if (ev.assistantMessageEvent) {
              const ame = ev.assistantMessageEvent;
              if (ame.type === 'thinking_delta' && ame.delta) {
                emit('text', { message: { content: [{ type: 'thinking', thinking: ame.delta }] } });
                lastWasText = false;
              } else if (ame.type === 'text_delta' && ame.delta) {
                const sep = (!lastWasText && emittedText) ? '\n\n' : '';
                summary += sep + ame.delta;
                emit('text', { message: { content: [{ type: 'text', text: sep + ame.delta }] } });
                emittedText = true;
                lastWasText = true;
              } else if (ame.type === 'toolcall_end' && ame.toolCall) {
                const tc = ame.toolCall;
                if (tc.id && !emittedTool.has(tc.id)) {
                  emittedTool.add(tc.id);
                  emit('text', {
                    message: {
                      content: [{
                        type: 'tool_use',
                        id: tc.id,
                        name: getToolFriendlyName(tc.name),
                        input: tc.arguments || {}
                      }]
                    }
                  });
                  lastWasText = false;
                }
              }
            }
            break;
          case 'tool_execution_start':
            if (ev.toolCallId && !emittedTool.has(ev.toolCallId)) {
              emittedTool.add(ev.toolCallId);
              emit('text', {
                message: {
                  content: [{
                    type: 'tool_use',
                    id: ev.toolCallId,
                    name: getToolFriendlyName(ev.toolName),
                    input: ev.args || {}
                  }]
                }
              });
              lastWasText = false;
            }
            break;
          case 'tool_execution_end':
            if (ev.toolCallId) {
              const out = ev.result?.content ?? ev.result?.detailedContent ?? '';
              let contentText = '';
              if (Array.isArray(out)) {
                contentText = out.map(o => typeof o === 'object' && o !== null ? (o.text || JSON.stringify(o)) : String(o)).join('\n');
              } else if (typeof out === 'string') {
                contentText = out;
              } else if (out && typeof out === 'object') {
                contentText = JSON.stringify(out);
              }
              const isError = ev.isError === true || ev.success === false;
              emit('user', {
                message: {
                  content: [{
                    type: 'tool_result',
                    tool_use_id: ev.toolCallId,
                    content: truncate(String(contentText || out), 8000),
                    is_error: isError
                  }]
                }
              });
              lastWasText = false;
            }
            break;
        }
      }
    } catch {
      // ignore
    }
  };

  const summaryText = await driveProcess(
    bin, args, cwd, onLine, () => summary || '', label, runId, emit, env,
  );
  return { summary: summaryText, sessionId };
}

async function runOmp(
  prompt: string, cwd: string, emit: AgentEmit, resumeId?: string,
  images: CliImage[] = [], runId?: number, model?: string, env?: NodeJS.ProcessEnv,
): Promise<CliAgentResult> {
  const { paths, cleanup } = writeTempImages(images);
  const baseArgs = [prompt, '--mode', 'json', '--allow-home', ...paths.map((file) => `@${file}`), ...(model ? ['--model', model] : [])];
  try {
    const result = await runPiJsonAgent(getCliAgentBin('omp'), 'OMP', resumeId ? ['--resume', resumeId, ...baseArgs] : baseArgs, cwd, emit, runId, env);
    return { ...result, sessionId: result.sessionId || resumeId };
  } finally {
    cleanup();
  }
}

async function runPi(
  prompt: string, cwd: string, emit: AgentEmit, resumeId?: string,
  images: CliImage[] = [], runId?: number, model?: string, env?: NodeJS.ProcessEnv,
): Promise<CliAgentResult> {
  const { paths, cleanup } = writeTempImages(images);
  const args = [
    '--mode', 'json', '--approve',
    ...(resumeId ? ['--session', resumeId] : []),
    ...(model ? ['--model', model] : []),
    ...paths.map((file) => `@${file}`),
    prompt,
  ];
  try {
    const result = await runPiJsonAgent(getCliAgentBin('pi'), 'Pi', args, cwd, emit, runId, env);
    return { ...result, sessionId: result.sessionId || resumeId };
  } finally {
    cleanup();
  }
}
