import { isLiveAgentStatus } from './runBlocks';
/**
 * Collapse multi-agent / mission channel chatter into a work-trace partition.
 *
 * Humans and single agent answers stay full chat bubbles. Consecutive agent
 * (and Cascade system) messages form a work run: intermediates become compact
 * TUI-style lines; the last settled non-worker answer stays a full bubble.
 */

import { canGroupChatMessages } from './shared';
import type { ChatMessage } from './types';
import { humanizeActivityLine, previewStructuredDetail, recentActivityLines, recentActivityText, stripTerminalNoise } from './harnessActivity';
export { humanizeActivityLine } from './harnessActivity';

export interface ChatMessageGroup {
  messages: ChatMessage[];
}

export type TranscriptSegment =
  | { kind: 'group'; group: ChatMessageGroup }
  | {
      kind: 'work';
      /** Stable key for React (first message id in the raw run). */
      id: string;
      /** Compact TUI lines. */
      trace: ChatMessage[];
      /** Full-weight bubbles after the trace (final answer, live run, mission). */
      fullGroups: ChatMessageGroup[];
      /** User-facing answers that follow the compact work stream. */
      updateGroups: ChatMessageGroup[];
      /** Empty persisted agent shell that owns a system-only trace. */
      carrier?: ChatMessage;
    };

/** A persisted, empty agent row used to give system workflow status a home. */
export function isWorkTraceCarrier(message: Pick<ChatMessage, 'id' | 'body' | 'agentId' | 'registrationId'>): boolean {
  return String(message.id || '').startsWith('agent-trace-')
    && !String(message.body || '').trim()
    && Boolean(message.agentId || message.registrationId);
}

export function isSystemCascadeMessage(message: Pick<ChatMessage, 'id' | 'author'>): boolean {
  return message.author === 'Cascade' || String(message.id || '').startsWith('sys-mission-');
}

/** Message belongs in the agent work stream rather than human conversation. */
export function isWorkTraceMessage(
  message: Pick<ChatMessage, 'id' | 'author' | 'agentId' | 'registrationId'>,
  agentAuthors?: ReadonlySet<string>,
): boolean {
  if (message.agentId || message.registrationId) return true;
  if (isSystemCascadeMessage(message)) return true;
  if (agentAuthors && message.author && agentAuthors.has(message.author)) return true;
  return false;
}

/** Always a compact line — never the user-facing final answer. */
export function isForcedWorkTraceLine(
  message: Pick<ChatMessage, 'id' | 'author' | 'missionTaskId'>,
): boolean {
  if (message.missionTaskId) return true;
  return isSystemCascadeMessage(message);
}

function truncateActivity(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * Mission peeks are user-facing, not terminals. Preserve useful reasoning and
 * tool progress while translating ANSI/control bytes and streamed tool JSON
 * into ordinary one-line prose.
 */
export function workTraceHarnessPreview(harness: string, max = 110): string {
  const lines = recentActivityLines(harness);
  const candidates: string[] = [];
  let inReasoning = false;
  let inToolInput = false;
  let toolResultBody = false;
  let lastTool = '';

  for (const line of lines) {
    if (/^#\s*thinking\b/i.test(line)) {
      inReasoning = true;
      inToolInput = false;
      toolResultBody = false;
      candidates.push('thinking…');
      continue;
    }

    const toolStart = line.match(/^[▶>]\s+(\S+)(?:\s+(.*))?$/);
    if (toolStart) {
      inReasoning = false;
      inToolInput = true;
      toolResultBody = false;
      lastTool = toolStart[1];
      const detail = previewStructuredDetail(toolStart[2], 70);
      candidates.push(detail ? `${lastTool} ${detail}` : lastTool);
      continue;
    }

    const toolEnd = line.match(/^([✓✗xX])\s*tool_result\b/i);
    if (toolEnd) {
      inReasoning = false;
      inToolInput = false;
      toolResultBody = true;
      candidates.push(`${lastTool || 'tool'} ${/^[✗xX]$/.test(toolEnd[1]) ? 'failed' : 'done'}`);
      continue;
    }

    if (line.startsWith('# ')) {
      inReasoning = false;
      inToolInput = false;
      toolResultBody = false;
      const human = humanizeActivityLine(line);
      if (human && !/^session (started|finished)$/i.test(human)) candidates.push(human);
      continue;
    }

    const namedTool = line.match(/^(Bash|Edit|Read|Write|Search|Glob|Grep|WebFetch|WebSearch)\b(?:\s+(.*))?$/);
    if (namedTool) {
      inReasoning = false;
      inToolInput = false;
      toolResultBody = false;
      lastTool = namedTool[1];
      const detail = previewStructuredDetail(namedTool[2], 70);
      candidates.push(detail ? `${lastTool} ${detail}` : lastTool);
      continue;
    }
    if (toolResultBody) continue;

    if (inReasoning) {
      const human = humanizeActivityLine(line);
      if (human) candidates.push(human);
      continue;
    }

    if (inToolInput) {
      if (line.startsWith('{')) {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          const detail = previewStructuredDetail(parsed, 70);
          if (detail) candidates.push(`${lastTool || 'Tool'} ${detail}`);
        } catch {
          // A live protocol chunk can end mid-JSON. Keep the tool name until the
          // completed structured input arrives; never paint the fragment.
        }
      }
      continue;
    }

    // Structured provider events are safe only after humanization. Arbitrary
    // terminal prose is intentionally ignored and falls back to the chat body.
    if (line.startsWith('{') || line.startsWith('$ ')) {
      const human = humanizeActivityLine(line);
      if (!human || /^session (started|finished)$/i.test(human)) continue;
      if (human === 'working…' && candidates.length > 0) continue;
      candidates.push(human);
    }
  }

  return truncateActivity(candidates[candidates.length - 1] || '', max);
}

/** Prefer the latest human-readable activity line (harness tails grow live). */
export function workTracePreview(body: string, max = 110): string {
  const lines = recentActivityLines(body);
  if (lines.length === 0) return '';

  // Scan newest-first so live harness tails surface the current step, not
  // the session-start protocol event that often leads the buffer.
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const human = humanizeActivityLine(lines[i]);
    if (!human) continue;
    // Pure lifecycle noise is only used if nothing better exists.
    if (/^session (started|finished)$/i.test(human) && i > 0) continue;
    return truncateActivity(human, max);
  }
  const fallback = humanizeActivityLine(lines[lines.length - 1] || lines[0] || '');
  return truncateActivity(fallback, max);
}

export function workTraceStatusLabel(message: Pick<ChatMessage, 'status' | 'body' | 'harnessLog'>): string {
  if (message.status === 'running') {
    const live = message.harnessLog
      ? workTraceHarnessPreview(message.harnessLog, 90)
      : workTracePreview(message.body || '', 90);
    if (live && !/^Thinking(?:\.{3}|…)$/i.test(live)) return live;
    return 'working…';
  }
  if (message.status === 'sending' || message.status === 'queued') return 'queued…';
  if (message.status === 'failed') return 'failed';
  if (isSteeringContinuationMessage(message)) return 'steered';
  if (message.status === 'canceled') return 'canceled';
  const outcome = recentActivityLines(message.body || '').find((line) => humanizeActivityLine(line));
  const preview = workTracePreview(outcome || '');
  return preview || '(empty)';
}

/** Durable steering sentinel: useful for presentation state, never user-facing prose. */
export function isSteeringContinuationMessage(
  message: Pick<ChatMessage, 'status' | 'body'>,
): boolean {
  return message.status === 'canceled'
    && /steered into the continuation below/i.test(message.body || '');
}

export type WorkTracePhase =
  | 'routing'
  | 'working'
  | 'waiting'
  | 'steering'
  | 'reviewing'
  | 'testing'
  | 'deploying'
  | 'blocked'
  | 'complete';

export interface WorkTraceDecal {
  phase: WorkTracePhase;
  label: string;
  mark: string;
}

const WORK_TRACE_DECALS: Record<WorkTracePhase, WorkTraceDecal> = {
  routing: { phase: 'routing', label: 'route', mark: '↗' },
  working: { phase: 'working', label: 'work', mark: '◌' },
  waiting: { phase: 'waiting', label: 'wait', mark: '⋯' },
  steering: { phase: 'steering', label: 'continued', mark: '↪' },
  reviewing: { phase: 'reviewing', label: 'review', mark: '◇' },
  testing: { phase: 'testing', label: 'test', mark: '✓' },
  deploying: { phase: 'deploying', label: 'deploy', mark: '↑' },
  blocked: { phase: 'blocked', label: 'blocked', mark: '!' },
  complete: { phase: 'complete', label: 'complete', mark: '✓' },
};

/** Best available workflow phase from durable status plus a conservative live-text overlay. */
export function workTracePhase(
  message: Pick<ChatMessage, 'id' | 'author' | 'body' | 'status' | 'missionTaskId' | 'harnessLog'>,
): WorkTracePhase {
  const text = stripTerminalNoise(
    `${recentActivityText(message.body)}\n${recentActivityText(message.harnessLog)}`,
  ).toLowerCase();
  // Steering cancel is intentional flow, not a hard block.
  if (isSteeringContinuationMessage(message)) return 'steering';
  if (message.status === 'failed') return 'blocked';
  if (message.status === 'queued' || message.status === 'sending') return 'routing';
  if (/\b(steer|redirect|change direction|supersed)/.test(text)) return 'steering';
  if (message.status === 'canceled') return 'blocked';
  if (isSystemCascadeMessage(message) || /\b(review|reconcil|ready for review)/.test(text)) return 'reviewing';
  if (isLiveAgentStatus(message.status)) {
    if (/\b(deploy|ship|release|production|prod\b)/.test(text)) return 'deploying';
    if (/\b(test|verify|verification|lint|runtime|regression|check)/.test(text)) return 'testing';
    if (/\b(wait|waiting|blocked on|dependency|agent busy)/.test(text)) return 'waiting';
    return 'working';
  }
  if (message.missionTaskId) return 'complete';
  return 'complete';
}

/** Ordered, de-duplicated workflow trail for the collapsed header. */
export function workTraceDecals(trace: ChatMessage[]): WorkTraceDecal[] {
  const phases: WorkTracePhase[] = [];
  for (const message of trace) {
    const phase = workTracePhase(message);
    if (phases[phases.length - 1] !== phase) phases.push(phase);
  }
  return phases.slice(-6).map((phase) => WORK_TRACE_DECALS[phase]);
}

/**
 * Within a consecutive agent/system run, decide which messages collapse.
 * Mission/media artifacts and the last settled non-worker answer stay full.
 * Live shells remain in the trace so operator-visible work does not recreate
 * the verbose stack this component exists to collapse.
 */
export function partitionWorkRun(
  messages: ChatMessage[],
): { trace: ChatMessage[]; full: ChatMessage[] } {
  if (messages.length === 0) return { trace: [], full: [] };

  // Lone ordinary reply → normal chat bubble (no work chrome).
  if (messages.length === 1 && !isForcedWorkTraceLine(messages[0])) {
    return { trace: [], full: messages };
  }

  const trace: ChatMessage[] = [];
  const full: ChatMessage[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const isLast = index === messages.length - 1;
    if (shouldRenderFullInWorkRun(message, isLast)) {
      full.push(message);
    } else {
      trace.push(message);
    }
  }

  return { trace, full };
}

function shouldRenderFullInWorkRun(
  message: ChatMessage,
  isLast: boolean,
): boolean {
  if (message.mission || message.changeRequest || message.clarification) return true;
  if (message.hasImages || message.images?.length || message.attachments?.length) return true;
  // Final user-facing answer of a multi-message run.
  if (
    isLast
    && message.status !== 'running'
    && message.status !== 'sending'
    && !isForcedWorkTraceLine(message)
  ) return true;
  return false;
}

function isDurableWorkArtifact(message: ChatMessage): boolean {
  return Boolean(message.mission || message.changeRequest || message.clarification
    || message.hasImages || message.images?.length || message.attachments?.length);
}

function groupMessages(messages: ChatMessage[]): ChatMessageGroup[] {
  const groups: ChatMessageGroup[] = [];
  for (const message of messages) {
    const last = groups[groups.length - 1];
    if (last && canGroupChatMessages(last.messages[last.messages.length - 1], message)) {
      last.messages.push(message);
    } else {
      groups.push({ messages: [message] });
    }
  }
  return groups;
}

/**
 * Split a sorted transcript into human groups and agent work runs.
 * Work runs with no compact lines fall back to ordinary groups.
 */
export function segmentTranscript(
  messages: ChatMessage[],
  options?: {
    agentAuthors?: ReadonlySet<string>;
  },
): TranscriptSegment[] {
  const agentAuthors = options?.agentAuthors;
  const segments: TranscriptSegment[] = [];
  let index = 0;

  while (index < messages.length) {
    const head = messages[index];
    if (isDurableWorkArtifact(head)) {
      segments.push({ kind: 'group', group: { messages: [head] } });
      index += 1;
      continue;
    }
    const headIsAgent = Boolean(head.agentId || head.registrationId)
      || Boolean(agentAuthors && head.author && agentAuthors.has(head.author));
    if (!headIsAgent && !isWorkTraceCarrier(head)) {
      const human: ChatMessage[] = [];
      while (index < messages.length) {
        const message = messages[index];
        const messageIsAgent = Boolean(message.agentId || message.registrationId)
          || Boolean(agentAuthors && message.author && agentAuthors.has(message.author));
        if (messageIsAgent || isWorkTraceCarrier(message)) break;
        human.push(messages[index]);
        index += 1;
      }
      for (const group of groupMessages(human)) {
        segments.push({ kind: 'group', group });
      }
      continue;
    }

    const work: ChatMessage[] = [];
    const identityKey = head.registrationId
      || `${head.agentId || 'agent'}:${workTraceAuthorKey(head).toLowerCase()}`;
    while (index < messages.length) {
      const message = messages[index];
      const messageIsAgent = Boolean(message.agentId || message.registrationId)
        || Boolean(agentAuthors && message.author && agentAuthors.has(message.author));
      const messageKey = message.registrationId
        || `${message.agentId || 'agent'}:${workTraceAuthorKey(message).toLowerCase()}`;
      // An empty persisted carrier may own the immediately following system
      // wake. Otherwise, agent boundaries are transcript boundaries: never
      // move one agent's response under another agent's header.
      const carrierWake = work.length === 1
        && isWorkTraceCarrier(work[0])
        && isSystemCascadeMessage(message);
      // A coordinator-created mission root is persisted as a durable chat
      // artifact with that coordinator's identity. Keep it in the live run
      // that created it; otherwise the transcript shows a second agent row
      // for what was only one dispatch. Unowned/cross-agent artifacts still
      // retain their own chronological row.
      const sameAgentMission = Boolean(message.mission)
        && messageIsAgent
        && messageKey === identityKey;
      if ((isDurableWorkArtifact(message) && !sameAgentMission)
        || ((!messageIsAgent || messageKey !== identityKey) && !carrierWake)) break;
      work.push(messages[index]);
      index += 1;
    }

    const { trace: rawTrace, full } = partitionWorkRun(work);
    // Mission wakes are system messages, but their empty coordinator shell is
    // a real agent message. Keep that shell as the visual owner rather than
    // rendering the workflow immediately beneath the preceding human turn.
    const carrier = rawTrace.find(isWorkTraceCarrier);
    const trace = carrier ? rawTrace.filter((message) => message.id !== carrier.id) : rawTrace;
    if (trace.length === 0) {
      for (const group of groupMessages(full.length ? full : work)) {
        segments.push({ kind: 'group', group });
      }
      continue;
    }

    // Artifacts remain inside this single-agent run only. Cross-agent and
    // mission boundaries were already split above to preserve chronology.
    const artifacts = full.filter(isDurableWorkArtifact);
    const finalReplies = full.filter((message) => !isDurableWorkArtifact(message));
    segments.push({
      kind: 'work',
      id: trace[0].id,
      trace,
      fullGroups: groupMessages(artifacts),
      updateGroups: groupMessages(finalReplies),
      ...(carrier ? { carrier } : {}),
    });
  }

  return segments;
}

export function workTraceAuthorKey(message: Pick<ChatMessage, 'author'>): string {
  return String(message.author || 'agent').trim() || 'agent';
}

export function workTraceSummary(trace: ChatMessage[]): string {
  if (trace.length === 0) return 'work';
  const authors: string[] = [];
  const seen = new Set<string>();
  for (const message of trace) {
    const key = workTraceAuthorKey(message).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    authors.push(workTraceAuthorKey(message));
    if (authors.length >= 3) break;
  }
  const more = new Set(trace.map((m) => workTraceAuthorKey(m).toLowerCase())).size - authors.length;
  const who = more > 0 ? `${authors.join(' · ')} +${more}` : authors.join(' · ');
  const live = trace.some((m) => isLiveAgentStatus(m.status));
  const n = trace.length;
  return live
    ? `${n} step${n === 1 ? '' : 's'} · ${who} · live`
    : `${n} step${n === 1 ? '' : 's'} · ${who}`;
}

/** Compact always-visible strip for collapsed mission cards. */
export interface WorkTracePeek {
  live: boolean;
  summary: string;
  author: string;
  label: string;
  decals: WorkTraceDecal[];
  phase: WorkTracePhase;
}

/**
 * Prefer the live step; fall back to the latest settled line so collapsed
 * mission chrome still reads as "working" rather than a static task counter.
 */
export function workTracePeek(trace: ChatMessage[]): WorkTracePeek | null {
  if (trace.length === 0) return null;
  const liveMessage = [...trace].reverse().find((message) => message.status === 'running')
    || [...trace].reverse().find((message) => isLiveAgentStatus(message.status));
  const attention = [...trace].reverse().find((message) => message.status === 'failed'
    || (message.status === 'canceled' && !isSteeringContinuationMessage(message)));
  const message = liveMessage || attention || trace[trace.length - 1];
  const live = Boolean(liveMessage);
  // Runtime prose belongs in the expanded trace, never the conversation preview.
  const label = live
    ? (message.status === 'running' ? 'Working…' : 'Queued…')
    : message.status === 'failed' ? 'Failed'
      : message.status === 'canceled' ? 'Canceled' : 'Work details';
  const decals = workTraceDecals(trace);
  const phase = workTracePhase(message);
  return {
    live,
    summary: workTraceSummary(trace),
    author: workTraceAuthorKey(message),
    label,
    decals,
    phase,
  };
}
