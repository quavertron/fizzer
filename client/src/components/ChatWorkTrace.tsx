import { isLiveAgentStatus } from '../chat/runBlocks';
/**
 * Compact TUI-style stream for multi-agent channel chatter.
 * Intermediates fold to mono lines; expand a line for full body + harness.
 *
 * Intentionally avoids importing runtime values from ChatView (circular).
 */

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import {
  workTraceAuthorKey,
  workTracePeek,
  isSteeringContinuationMessage,
  workTraceStatusLabel,
} from '../chat/workTrace';
import { hasRunActivity } from '../chat/harnessActivity';
import { CascadeRunPanel } from './CascadeRunPanel';
import { shouldRenderRunPanel } from './ChatGroupRow';
import { ChatQuoteRefs } from './ChatQuoteRefs';
import { SafeMarkdownImage } from './ChatMarkdown';
import { ThinkingSpinner } from './ThinkingSpinner';
import { SwipeToReply } from './SwipeToReply';
import type { ChatMessage } from '../chat/types';

const MARKDOWN_PLUGINS = [remarkGfm, remarkBreaks];
const WORK_TRACE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : WORK_TRACE_TIME_FORMATTER.format(date);
}

function statusMark(message: ChatMessage): { mark: string; className: string; live?: boolean } {
  if (message.status === 'failed') return { mark: '✗', className: 'err' };
  if (isSteeringContinuationMessage(message)) return { mark: '↪', className: 'steer' };
  if (message.status === 'canceled') return { mark: '✗', className: 'err' };
  if (isLiveAgentStatus(message.status)) return { mark: '…', className: 'run', live: true };
  if (message.missionTaskId) return { mark: '›', className: 'task' };
  if (String(message.id || '').startsWith('sys-mission-') || message.author === 'Cascade') {
    return { mark: '#', className: 'sys' };
  }
  return { mark: '·', className: 'ok' };
}

function WorkTraceBody({ body }: { body: string }) {
  const text = body.replace(/\\+`/g, '`');
  return (
    <div className="chat-work-line-md">
      <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS} components={{ img: SafeMarkdownImage }}>{text}</ReactMarkdown>
    </div>
  );
}

const WorkTraceLine = memo(function WorkTraceLine({
  message,
  open,
  onToggle,
  onCancelRun,
  onContextMenu,
  onReply,
  selected,
  vaultId,
  onHydrateMessage,
  latestRunningMessageId,
}: {
  message: ChatMessage;
  open: boolean;
  onToggle: () => void;
  onCancelRun: (runId: number) => void;
  onContextMenu: (event: React.MouseEvent, message: ChatMessage) => void;
  onReply: (message: ChatMessage) => void;
  selected: boolean;
  vaultId?: string;
  onHydrateMessage?: (message: ChatMessage) => void;
  latestRunningMessageId?: string;
}) {
  const { mark, className, live: lineLive } = statusMark(message);
  const author = workTraceAuthorKey(message);
  const preview = workTraceStatusLabel(message);
  const isLatestRunning = message.status !== 'running' || latestRunningMessageId === message.id;
  const showHarness = shouldRenderRunPanel(message, open || selected, isLatestRunning)
    && (message.status === 'running' || hasRunActivity(message) || open || selected);

  return (
    <SwipeToReply
      className="chat-work-line-swipe"
      onReply={() => onReply(message)}
      allowSwipeFrom=".chat-work-line-fold"
    >
      <div
        className={`chat-work-line ${open ? 'is-open' : ''} ${selected ? 'is-selected' : ''} status-${message.status || 'done'}`}
        data-message-id={message.id}
        onContextMenu={(event) => onContextMenu(event, message)}
      >
        <button
          type="button"
          className="chat-work-line-fold"
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
          onContextMenu={(event) => onContextMenu(event, message)}
          title={preview}
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${author} work step: ${preview}`}
        >
          {lineLive
            ? <ThinkingSpinner className={`chat-work-mark ${className}`} title={preview} />
            : <span className={`chat-work-mark ${className}`} aria-hidden="true">{mark}</span>}
          <span className="chat-work-author">{author}</span>
          <span className="chat-work-preview">{preview}</span>
          <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
          <ChevronRight size={12} className={`chat-work-chevron${open ? ' open' : ''}`} />
        </button>
        {open && (
          <div className="chat-work-line-body">
            <ChatQuoteRefs message={message} />
            {message.body
              && !isSteeringContinuationMessage(message)
              && !(message.status === 'running' && /^Thinking(?:\.{3}|…)$/.test(message.body.trim()))
              && <WorkTraceBody body={message.body} />}
            {showHarness && (
              <CascadeRunPanel
                message={message}
                onCancelRun={onCancelRun}
                forceOpen={selected || open}
                vaultId={vaultId}
                onHydrateMessage={onHydrateMessage}
              />
            )}
          </div>
        )}
      </div>
    </SwipeToReply>
  );
});

export const ChatWorkTrace = memo(function ChatWorkTrace({
  trace,
  selectedMessageId,
  onCancelRun,
  onContextMenu,
  onReply,
  vaultId,
  onHydrateMessage,
  runningMessageState,
  /** Nested in a mission card: no outer chrome; stream is the mission body. */
  embedded = false,
  /** When true, skip the local collapse toggle and always show the stream. */
  forceOpen = false,
}: {
  trace: ChatMessage[];
  selectedMessageId: string | null;
  onCancelRun: (runId: number) => void;
  onContextMenu: (event: React.MouseEvent, message: ChatMessage) => void;
  onReply: (message: ChatMessage) => void;
  vaultId?: string;
  onHydrateMessage?: (message: ChatMessage) => void;
  runningMessageState: ReadonlyMap<string, { latestId: string; count: number }>;
  embedded?: boolean;
  forceOpen?: boolean;
}) {
  const live = trace.some((m) => isLiveAgentStatus(m.status));
  // Keep the current activity visible; expand the transcript on request.
  const [open, setOpen] = useState(forceOpen);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const pinBottomRef = useRef(true);
  const peek = useMemo(() => workTracePeek(trace), [trace]);
  const currentPhase = peek?.phase || 'working';
  const label = peek?.label && peek.label !== '(empty)'
    ? peek.label : live ? 'Working…' : 'Finished';
  const streamOpen = forceOpen || open;

  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);

  useEffect(() => {
    if (!selectedMessageId) return;
    if (!trace.some((m) => m.id === selectedMessageId)) return;
    setOpen(true);
    setExpandedIds((prev) => {
      if (prev.has(selectedMessageId)) return prev;
      const next = new Set(prev);
      next.add(selectedMessageId);
      return next;
    });
  }, [selectedMessageId, trace]);

  useLayoutEffect(() => {
    if (!streamOpen || !live || !pinBottomRef.current) return;
    const el = bodyRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [streamOpen, live, trace]);

  const toggleLine = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (trace.length === 0) return null;
  const replyTarget = trace[trace.length - 1];

  return (
    <SwipeToReply
      className="chat-work-trace-swipe"
      onReply={() => onReply(replyTarget)}
      allowSwipeFrom=".chat-work-trace-toggle"
    >
      <div
        className={[
          'chat-work-trace',
          `phase-${currentPhase}`,
          streamOpen ? 'is-open' : '',
          live ? 'is-live' : '',
          embedded ? 'is-embedded' : '',
          forceOpen ? 'is-forced-open' : '',
        ].filter(Boolean).join(' ')}
      >
        {!forceOpen && (
          <button
            type="button"
            className="chat-work-trace-toggle"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={streamOpen}
          >
            {live && <ThinkingSpinner className="chat-work-trace-spinner" title="Working" />}
            <span className={`chat-work-trace-summary${live ? ' chat-working-output' : ''}`} title={label}>
              {label}
            </span>
            <ChevronRight size={13} className={`chat-work-trace-chevron${streamOpen ? ' open' : ''}`} />
          </button>
        )}
        {streamOpen && (
          <div
            ref={bodyRef}
            className="chat-work-trace-body"
            role="log"
            aria-label="Agent work trace"
            onScroll={(event) => {
              const el = event.currentTarget;
              pinBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 48;
            }}
          >
            {trace.map((message) => {
              const runKey = message.registrationId || message.agentId || '';
              const runState = runKey ? runningMessageState.get(runKey) : undefined;
              return (
                <WorkTraceLine
                  key={message.id}
                  message={message}
                  open={expandedIds.has(message.id)}
                  onToggle={() => toggleLine(message.id)}
                  onCancelRun={onCancelRun}
                  onContextMenu={onContextMenu}
                  onReply={onReply}
                  selected={selectedMessageId === message.id}
                  vaultId={vaultId}
                  onHydrateMessage={onHydrateMessage}
                  latestRunningMessageId={runState?.latestId}
                />
              );
            })}
          </div>
        )}
      </div>
    </SwipeToReply>
  );
});
