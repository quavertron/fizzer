/**
 * Agent harness panel — structured transcript in a terminal-like stream.
 *
 * Renders parsed thinking / tools / meta as sequential harness lines
 * (not raw JSONL, not a product "timeline" UI). Optional Raw tab shows
 * the true process/protocol buffer in xterm when needed.
 */

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, lazy, Suspense, type RefObject } from 'react';
import { ChevronRight, Square, TerminalSquare } from 'lucide-react';
import {
  buildHarnessActivity,
  buildHeaderStatChips,
  formatContextLine,
  formatCostUsd,
  formatDurationMs,
  formatRateLimitLine,
  formatRateLimitWindowLines,
  formatTokenCount,
  formatTurnsLine,
  hasRunActivity,
  hasUsageStats,
  isHarnessPromptDump,
  liveActivityHeadline,
  summarizeActivity,
  toolResultPreview,
  type ActivityItem,
  type HarnessActivity,
  type RunStats,
} from '../chat/harnessActivity';
// xterm is only mounted behind the Raw tab, so it does not belong in the
// initial chunk — load it when the user actually switches to raw output.
const HarnessTerminal = lazy(() =>
  import('./HarnessTerminal').then((m) => ({ default: m.HarnessTerminal })),
);
import type { ChatMessage } from '../chat/types';
import { workTraceOutput } from '../chat/workTrace';
import { ThinkingSpinner } from './ThinkingSpinner';
import { api } from '../api';

const SCROLL_PIN_PX = 48;
const EDGE_PX = 2;

function isPinnedToBottom(el: HTMLElement, slack = SCROLL_PIN_PX): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
}

function scrollToBottom(el: HTMLElement | null | undefined) {
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}

/** Scroll once after layout; repeated updates naturally coalesce before paint. */
function scrollToBottomSoon(el: HTMLElement | null | undefined) {
  if (!el) return;
  requestAnimationFrame(() => scrollToBottom(el));
}

function isScrollableY(el: HTMLElement): boolean {
  if (el.scrollHeight <= el.clientHeight + 1) return false;
  const oy = getComputedStyle(el).overflowY;
  return oy === 'auto' || oy === 'scroll' || oy === 'overlay' || el.classList.contains('chat-messages');
}

function findScrollParent(el: HTMLElement): HTMLElement | null {
  let p: HTMLElement | null = el.parentElement;
  while (p) {
    if (isScrollableY(p)) return p;
    p = p.parentElement;
  }
  return null;
}

function atScrollEdge(el: HTMLElement, deltaY: number): boolean {
  if (deltaY > 0) return el.scrollTop + el.clientHeight >= el.scrollHeight - EDGE_PX;
  if (deltaY < 0) return el.scrollTop <= EDGE_PX;
  return false;
}

/** Push leftover scroll into the nearest parent scroller (harness → chat). */
function chainScrollDelta(el: HTMLElement, deltaY: number): boolean {
  if (!deltaY || !atScrollEdge(el, deltaY)) return false;
  let parent = findScrollParent(el);
  let remaining = deltaY;
  while (parent && remaining !== 0) {
    if (!atScrollEdge(parent, remaining)) {
      parent.scrollTop += remaining;
      return true;
    }
    // Parent also at edge — walk up (thinking → harness → chat).
    const next = findScrollParent(parent);
    if (!next) {
      parent.scrollTop += remaining;
      return true;
    }
    parent = next;
  }
  return false;
}

/**
 * Wheel-only edge chaining into parent scrollers (thinking → harness → chat).
 * Touch chaining used non-passive touchmove + preventDefault and stuttered the
 * main list; mobile relies on CSS overscroll-behavior instead.
 */
function useScrollChain(ref: RefObject<HTMLElement | null>, active = true) {
  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;

    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return; // pinch-zoom
      if (!atScrollEdge(el, event.deltaY)) return;
      if (chainScrollDelta(el, event.deltaY)) {
        event.preventDefault();
      }
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
    };
  }, [ref, active]);
}

function previewInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input.trim();
  if (typeof input !== 'object') return String(input);
  const rec = input as Record<string, unknown>;
  if (typeof rec.command === 'string') return rec.command;
  if (typeof rec.file_path === 'string') return rec.file_path;
  if (typeof rec.path === 'string') return rec.path;
  if (typeof rec.pattern === 'string') return rec.pattern;
  if (typeof rec.query === 'string') return rec.query;
  if (typeof rec.message === 'string') return rec.message;
  try {
    const s = JSON.stringify(input);
    return s.length > 240 ? `${s.slice(0, 239)}…` : s;
  } catch {
    return String(input);
  }
}

function indentBlock(text: string, prefix = '  '): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => (line.length ? `${prefix}${line}` : prefix.trimEnd()));
}

/** Collapsible thinking block rendered as terminal-style dim lines. */
function ThinkingBlock({
  text,
  defaultOpen,
  live,
}: {
  text: string;
  defaultOpen?: boolean;
  live?: boolean;
}) {
  const [open, setOpen] = useState(Boolean(defaultOpen || live));
  const preRef = useRef<HTMLPreElement>(null);
  const pinRef = useRef(true);
  // Live thinking can grow many times per second; paint a throttled snapshot
  // so we don't re-split multi-KB strings into lines on every chunk.
  const [paintText, setPaintText] = useState(text);
  useEffect(() => {
    if (!live) {
      setPaintText(text);
      return;
    }
    const timer = window.setTimeout(() => setPaintText(text), 90);
    return () => window.clearTimeout(timer);
  }, [text, live]);

  const lines = paintText.trim() ? indentBlock(paintText.trim()) : [];
  const firstLine = lines[0]?.replace(/^\s+/, '') || '';
  const collapsedPreview = firstLine.startsWith('{') ? '' : firstLine;
  const more = lines.length > 1 ? ` (+${lines.length - 1} lines)` : '';

  useEffect(() => {
    if (live) pinRef.current = true;
  }, [live]);

  // Thinking body is its own scroll container (max-height). Follow the tail
  // while live / pinned — outer panel scroll alone never moves this.
  useLayoutEffect(() => {
    if (!open) return;
    const pre = preRef.current;
    if (!pre) return;
    if (live || pinRef.current) scrollToBottomSoon(pre);
  }, [paintText, open, live, lines.length]);

  // Bind after fold opens so the <pre> exists.
  useScrollChain(preRef, open);

  return (
    <div className="crp-term-block crp-term-thinking">
      <button
        type="button"
        className="crp-term-fold"
        // Keep fold expand local: don't bubble to message selection / panel chrome.
        onClick={(event) => {
          event.stopPropagation();
          setOpen((v) => !v);
        }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {live
          ? <ThinkingSpinner className="crp-term-mark thinking-spinner-live" title="Thinking" />
          : <span className="crp-term-mark dim">·</span>}
        {!open && (
          <span className="crp-term-fold-preview dim">
            {live && !collapsedPreview ? 'Thinking…' : collapsedPreview}
            {more}
          </span>
        )}
        {open && <span className="crp-term-fold-preview" />}
        <ChevronRight size={12} className={`crp-term-fold-chevron${open ? ' open' : ''}`} />
      </button>
      {open && (
        <pre
          ref={preRef}
          className={`crp-term-pre dim${live ? ' is-thinking-live' : ''}`}
          onScroll={(event) => {
            pinRef.current = isPinnedToBottom(event.currentTarget);
          }}
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {lines.join('\n')}
        </pre>
      )}
    </div>
  );
}

function ToolBlock({
  item,
  defaultOpen,
}: {
  item: ActivityItem;
  defaultOpen?: boolean;
}) {
  const tool = item.tool!;
  const [open, setOpen] = useState(Boolean(defaultOpen || tool.status === 'running'));
  const preRef = useRef<HTMLPreElement>(null);
  const pinRef = useRef(true);
  const inputLine = previewInput(tool.input);
  const result = toolResultPreview(tool.result, 3000);
  const hasBody = Boolean(result || (tool.status === 'running' && !result));
  const mark = tool.status === 'error' ? '✗' : tool.status === 'running' ? '…' : '✓';
  const markClass = tool.status === 'error' ? 'err' : tool.status === 'running' ? 'run' : 'ok';
  const live = tool.status === 'running';

  useEffect(() => {
    if (live) {
      setOpen(true);
      pinRef.current = true;
    }
  }, [live]);

  useLayoutEffect(() => {
    if (!open || !hasBody) return;
    if (live || pinRef.current) scrollToBottomSoon(preRef.current);
  }, [result, open, hasBody, live]);

  useScrollChain(preRef, open && hasBody);

  return (
    <div className={`crp-term-block crp-term-tool status-${tool.status}`}>
      <button
        type="button"
        className="crp-term-fold"
        onClick={(event) => {
          event.stopPropagation();
          if (hasBody) setOpen((v) => !v);
        }}
        onPointerDown={(event) => event.stopPropagation()}
        disabled={!hasBody}
      >
        <span className={`crp-term-mark ${markClass}`}>{mark}</span>
        <span className="crp-term-tag tool">{tool.name || item.title}</span>
        {inputLine && <span className="crp-term-fold-preview">{inputLine}</span>}
        {hasBody && (
          <ChevronRight size={12} className={`crp-term-fold-chevron${open ? ' open' : ''}`} />
        )}
      </button>
      {open && hasBody && (
        <pre
          ref={preRef}
          className={`crp-term-pre ${tool.isError ? 'err' : 'muted'}`}
          onScroll={(event) => {
            pinRef.current = isPinnedToBottom(event.currentTarget);
          }}
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {result
            ? indentBlock(result).join('\n')
            : '  …'}
        </pre>
      )}
    </div>
  );
}

/** Trailing `# …` meta lines for usage / context / turns / limits. */
function buildMetaLines(stats: RunStats, isRunning: boolean): string[] {
  const lines: string[] = [];
  const primary: string[] = [];
  if (stats.model) primary.push(stats.model);

  const ctx = formatContextLine(stats);
  if (ctx) primary.push(ctx);

  const turns = formatTurnsLine(stats);
  if (turns) primary.push(turns);

  const tokIn = formatTokenCount(stats.inputTokens);
  const tokOut = formatTokenCount(stats.outputTokens);
  if (tokIn || tokOut) primary.push(`${tokIn || '?'}→${tokOut || '?'} tok`);

  if (stats.cacheReadTokens != null && stats.cacheReadTokens > 0) {
    const cr = formatTokenCount(stats.cacheReadTokens);
    if (cr) primary.push(`cache ${cr}`);
  }

  const cost = formatCostUsd(stats.totalCostUsd);
  if (cost) primary.push(cost);

  const dur = formatDurationMs(stats.durationMs);
  if (dur) primary.push(dur);

  if (stats.toolCount > 0) {
    primary.push(`${stats.toolCount} tool${stats.toolCount === 1 ? '' : 's'}`);
  }

  if (primary.length) lines.push(primary.join(' · '));
  else if (isRunning) lines.push('running');

  const limitLine = formatRateLimitLine(stats);
  if (limitLine) lines.push(limitLine);

  // Only dump multi-window detail when we have more than the primary summary.
  const windows = formatRateLimitWindowLines(stats);
  if (windows.length > 1) {
    for (const w of windows) {
      if (w !== limitLine) lines.push(w);
    }
  }

  return lines;
}

function StructuredTranscript({
  activity,
  isRunning,
}: {
  activity: HarnessActivity;
  isRunning: boolean;
}) {
  const { stats, items } = activity;
  // A command/cwd pair is a verified process launch even when the provider
  // has not emitted a thinking or tool event yet (common for Hermes/Akron).
  const hasStructured = items.length > 0 || stats.hasThinking || Boolean(stats.command || stats.model || stats.cwd);
  const metaLines = buildMetaLines(stats, isRunning);
  const lastIdx = items.length - 1;

  // If we only have thinkingText and no items, synthesize one block.
  const renderItems = items.length > 0
    ? items
    : activity.thinkingText
      ? [{
          id: 'thinking-only',
          kind: 'thinking' as const,
          title: 'Thinking',
          text: activity.thinkingText,
        }]
      : [];

  return (
    <div className="crp-term-stream" role="log" aria-label="Agent harness output">
      {hasStructured && (stats.command || stats.model || stats.cwd) && (
        <div className="crp-term-line meta">
          {stats.command
            ? <span className="dim">$ {stats.command}</span>
            : (
              <span className="dim">
                # {stats.model || 'agent'}
                {stats.cwd ? ` · ${stats.cwd}` : ''}
              </span>
            )}
        </div>
      )}

      {renderItems.length === 0 && (
        <div className="crp-term-line dim">
          {isRunning
            ? (hasStructured ? 'waiting for provider output…' : 'Starting…')
            : 'no structured output'}
        </div>
      )}

      {renderItems.map((item, index) => {
        if (item.kind === 'thinking') {
          const dump = isHarnessPromptDump(item.text);
          if (dump && !(isRunning && index === lastIdx)) return null;
          if (dump) {
            return (
              <div key={item.id} className="crp-term-line dim">thinking…</div>
            );
          }
          return (
            <ThinkingBlock
              key={item.id}
              text={item.text || ''}
              defaultOpen={false}
              live={isRunning && index === lastIdx}
            />
          );
        }
        if (item.kind === 'tool' && item.tool) {
          return (
            <ToolBlock
              key={item.id}
              item={item}
              defaultOpen={isRunning && (index === lastIdx || item.tool.status === 'running')}
            />
          );
        }
        if (item.text) {
          return (
            <div key={item.id} className="crp-term-line">
              {item.text}
            </div>
          );
        }
        return null;
      })}

      {stats.exitCode != null && stats.exitCode !== '' && (
        <div className="crp-term-line meta dim"># exit {stats.exitCode}</div>
      )}
      {/* Always show usage lines when we have them — mid-run (max turns /
          rate limits) and after completion (ctx, turns, cost). */}
      {metaLines.map((line, i) => (
        <div key={`meta-${i}`} className="crp-term-line meta dim"># {line}</div>
      ))}
      {isRunning && (
        <div className="crp-term-line run-cursor" aria-hidden="true">
          <span className="crp-term-cursor">█</span>
        </div>
      )}
    </div>
  );
}

function StopRunButton({
  onStop,
}: {
  onStop: () => unknown;
}) {
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState('');
  return (
    <button
      type="button"
      className={`crp-stop${stopping ? ' is-stopping' : ''}`}
      disabled={stopping}
      onClick={async (event) => {
        event.stopPropagation();
        if (stopping) return;
        setStopping(true);
        setError('');
        try {
          if (await onStop() === false) setError('Could not stop. Try again.');
        } catch (error) {
          setError(error instanceof Error ? error.message : 'Could not stop. Try again.');
        } finally {
          setStopping(false);
        }
      }}
      title={error || 'Stop run'}
      aria-label="Stop run"
    >
      <Square size={11} fill="currentColor" />
      {stopping ? 'Stopping' : 'Stop'}
    </button>
  );
}

export const CascadeRunPanel = memo(function CascadeRunPanel({
  message,
  onCancelRun,
  forceOpen = false,
  onContentGrow,
  vaultId,
  onHydrateMessage,
}: {
  message: ChatMessage;
  onCancelRun: (runId: number) => void;
  forceOpen?: boolean;
  /** Notify parent (main chat scroller) when harness content height grows. */
  onContentGrow?: () => void;
  vaultId?: string;
  /** Merge a full message payload (harness log) after expand-fetch. */
  onHydrateMessage?: (message: ChatMessage) => void;
}) {
  const isRunning = message.status === 'running';
  const publicOutput = workTraceOutput(message);
  const isQueued = message.status === 'queued' || message.status === 'sending';
  const canStopQueued = isQueued && message.id.startsWith('agent-dispatch-')
    && (message.runId != null || Boolean(vaultId && onHydrateMessage));
  const canExpand = hasRunActivity(message);
  // Live work appears as a lightweight activity bubble until the operator
  // asks for the complete thinking/tool trace. Selection still force-opens it.
  const [open, setOpen] = useState(forceOpen);
  const [showRaw, setShowRaw] = useState(false);
  const [hydrating, setHydrating] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** User is following the tail of the outer harness scroller. */
  const pinBottomRef = useRef(true);
  const onContentGrowRef = useRef(onContentGrow);
  onContentGrowRef.current = onContentGrow;
  const onHydrateRef = useRef(onHydrateMessage);
  onHydrateRef.current = onHydrateMessage;

  // List API omits harness_log — pull full message once when the user expands.
  useEffect(() => {
    if (!open || isRunning) return;
    if (message.harnessLog) return;
    if (!message.hasHarness && !(message.blocks?.some((b) => b.type === 'thinking' || b.type === 'tool_use'))) {
      // Still may want full blocks if list truncated thinking — fetch when hasHarness only
    }
    if (!message.hasHarness) return;
    if (!vaultId || !message.channelId || !message.id) return;
    let cancelled = false;
    setHydrating(true);
    void api<{ message: ChatMessage }>(
      `/api/vaults/${vaultId}/channels/${message.channelId}/messages/${encodeURIComponent(message.id)}`,
    )
      .then((data) => {
        if (cancelled || !data.message) return;
        onHydrateRef.current?.(data.message);
      })
      .catch(() => { /* keep slim payload */ })
      .finally(() => {
        if (!cancelled) setHydrating(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, isRunning, message.harnessLog, message.hasHarness, message.channelId, message.id, message.blocks, vaultId]);

  // Heavy parse only when open or live — collapsed closed panels were parsing
  // full harness logs for every agent message during list scroll.
  const activity = useMemo(() => {
    if (!isRunning && !open) return null;
    return buildHarnessActivity(message);
  }, [message, isRunning, open]);
  const hasStructuredActivity = Boolean(activity && (
    activity.items.length > 0
    || activity.stats.hasThinking
    || activity.stats.command
    || activity.stats.model
    || activity.stats.cwd
  ));
  const live = useMemo(() => {
    if (!activity || !isRunning || !hasStructuredActivity) return null;
    const headline = liveActivityHeadline(activity);
    return headline.verb === 'thinking' ? null : headline;
  }, [activity, isRunning, hasStructuredActivity]);
  const summary = useMemo(
    () => {
      if (message.status === 'failed') return message.body?.trim() || 'Agent failed.';
      if (message.status === 'canceled') return message.body?.trim() || 'Run canceled.';
      if (isQueued) return 'Queued';
      if (isRunning) return publicOutput || (live?.detail ? `${live.verb} ${live.detail}` : hasStructuredActivity ? 'Working' : 'Starting…');
      return activity ? summarizeActivity(activity, false) : 'trace';
    },
    [activity, isRunning, isQueued, publicOutput, live, hasStructuredActivity, message.body, message.status],
  );
  const statChips = useMemo(
    () => (activity ? buildHeaderStatChips(activity.stats) : []),
    [activity],
  );
  const showUsage = activity ? (hasUsageStats(activity.stats) || statChips.length > 0) : false;
  // Harness body → main chat when already at top/bottom.
  useScrollChain(bodyRef, Boolean(open && canExpand && activity));

  // Fingerprint content growth (length alone misses same-length edits; items
  // grow thinking in-place without changing items.length).
  const scrollEpoch = useMemo(() => {
    if (!activity) return 0;
    let n = activity.thinkingText.length;
    for (const item of activity.items) {
      n += (item.text?.length || 0) + (item.tool?.result?.length || 0) + 1;
    }
    n += activity.stats.toolCount * 17 + (activity.stats.numTurns || 0);
    // Coarse harness length — avoid re-scrolling on every stats byte.
    n += Math.floor((activity.rawLog.length || 0) / 256);
    return n;
  }, [activity]);

  // Selecting a message opens its harness, but must not pin it open: gating the
  // render on `open || forceOpen` made the toggle silently do nothing for as
  // long as the message stayed selected, so a finished panel could not be closed.
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);

  useLayoutEffect(() => {
    if (!activity || !isRunning || !open || showRaw) return;
    if (!pinBottomRef.current) return;
    scrollToBottomSoon(bodyRef.current);
  }, [scrollEpoch, isRunning, open, showRaw, activity]);

  // Keep the main chat panel pinned when harness/thinking expands — including
  // the collapsed live header, not only an expanded trace.
  useLayoutEffect(() => {
    if (!isRunning && !open) return;
    onContentGrowRef.current?.();
  }, [scrollEpoch, open, activity, isRunning, summary]);

  if (!isRunning && !isQueued && !canExpand) return null;

  const hasStructured = hasStructuredActivity;
  // Raw CLI/JSONL is a diagnostic fallback, not a live transcript. Showing it
  // before structured events arrive flashes prompts and protocol frames.
  const useRaw = Boolean(activity && (showRaw || (!isRunning && !hasStructured && activity.stats.hasRaw)));

  return (
    <div
      className={`cascade-run-panel ${open ? 'open' : ''} ${isRunning ? 'is-running' : 'is-settled'}${message.status === 'failed' ? ' is-failed' : ''}${message.status === 'canceled' ? ' is-canceled' : ''}`}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="crp-header">
        {canStopQueued && (
          <StopRunButton key={message.id} onStop={async () => {
            if (message.runId != null) return onCancelRun(message.runId);
            await api(`/api/vaults/${vaultId}/channels/${message.channelId}/messages/${encodeURIComponent(message.id)}?queuedOnly=true`, { method: 'DELETE' });
            onHydrateRef.current?.({ ...message, status: 'canceled', body: '' });
          }} />
        )}
        <button
          type="button"
          className="crp-toggle"
          onClick={(event) => {
            event.stopPropagation();
            if (canExpand) setOpen((v) => !v);
          }}
          disabled={!canExpand}
          aria-expanded={open && canExpand}
          aria-label={`${open ? 'Collapse' : 'Inspect'} activity`}
          title={showUsage
            ? statChips.map((c) => c.title || c.label).join('\n')
            : summary}
        >
          <TerminalSquare size={13} className="crp-toggle-icon" />
          <span className="crp-toggle-label">Activity</span>
          <span className="crp-toggle-summary">
            {hydrating ? 'loading…' : isQueued ? 'Queued' : publicOutput ? (
              <span className="crp-live-detail">{publicOutput}</span>
            ) : live?.detail ? (
              <>
                <span className="crp-live-verb">{live.verb}</span>
                <span className="crp-live-detail">{live.detail}</span>
              </>
            ) : summary}
          </span>
          {statChips.length > 0 && (
            <span className="crp-stat-chips" aria-label="Run usage stats">
              {statChips.map((chip) => (
                <span
                  key={chip.id}
                  className={`crp-stat-chip${chip.warn ? ' is-warn' : ''}`}
                  title={chip.title || chip.label}
                >
                  {chip.label}
                </span>
              ))}
            </span>
          )}
          {(isRunning || isQueued) && <ThinkingSpinner className="crp-spinner" title={isQueued ? 'Queued' : 'Working'} />}
          {canExpand && <ChevronRight size={13} className="crp-chevron" />}
        </button>
        {isRunning && message.runId != null && (
          <StopRunButton key={message.runId} onStop={() => onCancelRun(message.runId!)} />
        )}
      </div>

      {open && canExpand && activity && (
        <div className="crp-shell">
          <div
            className="crp-term"
            ref={bodyRef}
            onScroll={(event) => {
              // While running, only keep following if the user is near the tail.
              pinBottomRef.current = isPinnedToBottom(event.currentTarget);
            }}
          >
            {useRaw ? (
              <div className="crp-raw-wrap">
                <Suspense fallback={null}>
                  <HarnessTerminal content={activity.rawLog || activity.thinkingText} active={isRunning} />
                </Suspense>
              </div>
            ) : (
              <StructuredTranscript activity={activity} isRunning={isRunning} />
            )}
          </div>
          {activity.stats.hasRaw && hasStructured && (
            <div className="crp-term-footer">
              <button
                type="button"
                className="crp-raw-toggle"
                onClick={() => setShowRaw((v) => !v)}
              >
                {showRaw ? 'structured' : 'raw buffer'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
