import { LoadingIndicator } from './LoadingIndicator';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type UIEvent,
} from 'react';
import {
  Activity,
  Bot,
  ChevronLeft,
  ExternalLink,
  Hash,
  Loader2,
  MessageSquarePlus,
  Radio,
  RefreshCw,
  Send,
  Square,
  Terminal,
  X,
} from 'lucide-react';
import { api, formatRelativeDate } from '../api';
import { agentLabel } from '../chat/agents';
import { stripTerminalNoise } from '../chat/harnessActivity';
import { normalizeChatRunBlocks } from '../chat/runBlocks';
import { ModalShell } from './ModalShell';

export type ActiveSession = {
  id: number;
  vault_id: string;
  vault_name: string;
  note_id: string | null;
  prompt: string;
  agent: string;
  conversation_id: string;
  session_id: string | null;
  status: 'queued' | 'running';
  started_at: string;
  model: string | null;
  message_id: string | null;
  channel_id: string | null;
  channel_title: string | null;
  author: string | null;
  registration_id: string | null;
  mention: string | null;
};

export type RunEvent = {
  id: number;
  seq: number;
  type: string;
  payload_json: string;
  ts: string;
};

export type SessionTimelineItem = {
  id: string;
  kind: 'status' | 'thinking' | 'response' | 'tool' | 'result';
  label: string;
  text: string;
  ts: string;
  error?: boolean;
};

type Props = {
  open: boolean;
  runnerOnline: boolean;
  /** When set (from an Orbit node click), auto-select the run with this agent session id. */
  focusSessionId?: string | null;
  onFocusHandled?: () => void;
  onClose: () => void;
  onOpenChat: (vaultId: string, channelId: string, channelTitle: string) => void | Promise<void>;
  onCancel: (runId: number) => boolean | void | Promise<boolean | void>;
  onInterrogate: (vaultId: string, channelId: string, message: string) => void | Promise<void>;
};

const MOBILE_QUERY = '(max-width: 720px)';

function parsePayload(event: RunEvent): Record<string, unknown> {
  try {
    const parsed = JSON.parse(event.payload_json);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function readableJson(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function trimActivityText(value: string, max = 16_000): string {
  const cleaned = stripTerminalNoise(value).trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}\n…` : cleaned;
}

/**
 * Runs persist the fully assembled model prompt. The inspector should show the
 * human's request, not the stable agent header and injected workspace context.
 */
export function sessionRequestText(prompt: string): string {
  const withoutInjection = String(prompt || '').split(/\n\n\[Context:/, 1)[0].trim();
  const paragraphs = withoutInjection.split(/\n{2,}/);
  if (/^You are .+?\(@.+?\) in #/i.test(paragraphs[0] || '') && paragraphs.length > 1) {
    return paragraphs.slice(1).join('\n\n').trim();
  }
  return withoutInjection || 'No request text recorded.';
}

function appendTimelineText(
  items: SessionTimelineItem[],
  next: SessionTimelineItem,
): void {
  const last = items[items.length - 1];
  if (
    last
    && last.kind === next.kind
    && last.label === next.label
    && (next.kind === 'thinking' || next.kind === 'response')
  ) {
    last.text = trimActivityText(`${last.text}${next.text}`);
    last.ts = next.ts;
    return;
  }
  items.push(next);
}

/** Collapse token deltas into readable thinking/response/tool activity. */
export function buildSessionTimeline(events: RunEvent[]): SessionTimelineItem[] {
  const items: SessionTimelineItem[] = [];
  const toolIndex = new Map<string, number>();

  for (const event of events) {
    const payload = parsePayload(event);
    if (event.type === 'status') {
      const status = typeof payload.status === 'string' ? payload.status : 'status';
      const summary = typeof payload.summary === 'string' ? payload.summary : '';
      appendTimelineText(items, {
        id: `status-${event.id}`,
        kind: 'status',
        label: status,
        text: summary || (
          status === 'queued' ? 'Waiting for the desktop runner.'
            : status === 'running' ? 'Agent connected and working.'
              : `Run ${status}.`
        ),
        ts: event.ts,
        error: status === 'failed' || status === 'canceled',
      });
      continue;
    }

    if (event.type !== 'text' && event.type !== 'user') continue;
    const message = payload.message;
    const content = message && typeof message === 'object'
      ? (message as Record<string, unknown>).content
      : undefined;
    for (const block of normalizeChatRunBlocks(content)) {
      if (block.type === 'thinking') {
        appendTimelineText(items, {
          id: `thinking-${event.id}`,
          kind: 'thinking',
          label: 'Reasoning',
          text: block.redacted ? 'Reasoning was redacted by the provider.' : block.text || '',
          ts: event.ts,
        });
      } else if (block.type === 'text') {
        appendTimelineText(items, {
          id: `response-${event.id}`,
          kind: 'response',
          label: 'Response',
          text: block.text || '',
          ts: event.ts,
        });
      } else if (block.type === 'tool_use') {
        const key = block.id || `${event.id}-${block.name || 'tool'}`;
        const item: SessionTimelineItem = {
          id: `tool-${key}`,
          kind: 'tool',
          label: block.name || 'Tool',
          text: trimActivityText(readableJson(block.input)) || 'Running…',
          ts: event.ts,
        };
        const existing = toolIndex.get(key);
        if (existing == null) {
          toolIndex.set(key, items.length);
          items.push(item);
        } else {
          items[existing] = item;
        }
      } else if (block.type === 'tool_result') {
        items.push({
          id: `result-${event.id}-${items.length}`,
          kind: 'result',
          label: block.isError ? 'Tool error' : 'Tool result',
          text: trimActivityText(block.content || block.text || '') || 'No output.',
          ts: event.ts,
          error: block.isError,
        });
      }
    }
  }
  return items.filter((item) => item.text.trim());
}

export function sessionConsoleText(events: RunEvent[]): string {
  return trimActivityText(events.flatMap((event) => {
    if (event.type !== 'harness') return [];
    const data = parsePayload(event).data;
    return typeof data === 'string' ? [data] : [];
  }).join(''), 200_000);
}

function sessionName(session: ActiveSession): string {
  return session.author || agentLabel(session.agent);
}

function sessionHandle(session: ActiveSession): string {
  return (session.mention || session.author || session.agent).replace(/^@/, '');
}

function shortModel(model: string | null): string {
  if (!model) return 'Default model';
  const tail = model.split('/').pop() || model;
  return tail.length > 38 ? `${tail.slice(0, 36)}…` : tail;
}

function elapsedLabel(startedAt: string, now: number): string {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return '—';
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function TraceEmpty({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return <div className="session-manager-trace-empty">{icon}{children}</div>;
}

export function SessionManager({
  open,
  runnerOnline,
  focusSessionId,
  onFocusHandled,
  onClose,
  onOpenChat,
  onCancel,
  onInterrogate,
}: Props) {
  const [sessions, setSessions] = useState<ActiveSession[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [traceError, setTraceError] = useState('');
  const [loading, setLoading] = useState(false);
  const [traceLoading, setTraceLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [stoppingAll, setStoppingAll] = useState(false);
  const [stopNotice, setStopNotice] = useState('');
  const [stoppingId, setStoppingId] = useState<number | null>(null);
  const [view, setView] = useState<'activity' | 'console'>('activity');
  const [now, setNow] = useState(Date.now());
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const traceRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const sessionRequestRef = useRef(0);

  const refresh = useCallback(async (manual = false) => {
    if (!open) return;
    const request = ++sessionRequestRef.current;
    if (sessions.length === 0) setLoading(true);
    if (manual) setRefreshing(true);
    try {
      const response = await api<{ sessions: ActiveSession[] }>('/api/me/active-sessions');
      if (request !== sessionRequestRef.current) return;
      setSessions(response.sessions);
      setSelectedId((current) => {
        if (current != null && response.sessions.some((session) => session.id === current)) return current;
        const mobile = typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches;
        return mobile ? null : response.sessions[0]?.id ?? null;
      });
      setLastUpdatedAt(Date.now());
      setError('');
    } catch (err) {
      if (request === sessionRequestRef.current) {
        setError(err instanceof Error ? err.message : 'Could not load sessions');
      }
    } finally {
      if (request === sessionRequestRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [open, sessions.length]);

  useEffect(() => {
    if (!open) return;
    let stopped = false;
    let timer = 0;
    const poll = async () => {
      if (!document.hidden) await refresh();
      if (!stopped) timer = window.setTimeout(poll, 2_500);
    };
    void poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      sessionRequestRef.current += 1;
    };
  }, [open, refresh]);

  // An Orbit node click asks us to focus a specific agent session. Wait for it to
  // appear in the loaded list, then select it once and clear the request.
  useEffect(() => {
    if (!open || !focusSessionId) return;
    const match = sessions.find((session) => session.session_id === focusSessionId);
    if (match) {
      setSelectedId(match.id);
      onFocusHandled?.();
    }
  }, [open, focusSessionId, sessions, onFocusHandled]);

  useEffect(() => {
    if (!open || selectedId == null) {
      setEvents([]);
      setTraceError('');
      return;
    }
    let active = true;
    let timer = 0;
    let first = true;
    const poll = async () => {
      if (!document.hidden) {
        if (first) setTraceLoading(true);
        try {
          const response = await api<{ events: RunEvent[] }>(`/api/runs/${selectedId}/events`);
          if (active) {
            setEvents(response.events);
            setTraceError('');
          }
        } catch (err) {
          if (active) setTraceError(err instanceof Error ? err.message : 'Could not load this trace');
        } finally {
          first = false;
          if (active) setTraceLoading(false);
        }
      }
      if (active) timer = window.setTimeout(poll, 1_500);
    };
    setEvents([]);
    stickToBottomRef.current = true;
    void poll();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [open, selectedId]);

  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // Escape-to-close lives in ModalShell; this effect only manages focus.
    const previous = document.activeElement as HTMLElement | null;
    window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    return () => { previous?.focus?.(); };
  }, [open]);

  const selected = useMemo(
    () => sessions.find((session) => session.id === selectedId) ?? null,
    [sessions, selectedId],
  );
  const timeline = useMemo(() => buildSessionTimeline(events), [events]);
  const consoleText = useMemo(() => sessionConsoleText(events), [events]);
  const requestText = useMemo(() => selected ? sessionRequestText(selected.prompt) : '', [selected]);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const trace = traceRef.current;
      if (trace) trace.scrollTop = trace.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [events.length, timeline.length, view]);

  if (!open) return null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!selected?.channel_id || !draft.trim()) return;
    void onInterrogate(
      selected.vault_id,
      selected.channel_id,
      `@${sessionHandle(selected)} ${draft.trim()}`,
    );
    setDraft('');
  };

  const handleComposerKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  const stopAll = async () => {
    if (stoppingAll || stoppingId != null) return;
    setStoppingAll(true);
    setStopNotice('');
    try {
      const result = await api<{ stopped: number; missions: number; failed: number }>('/api/me/active-sessions/stop', { method: 'POST' });
      await refresh();
      setStopNotice(result.failed
        ? `${result.failed} sessions could not be stopped. Try again.`
        : 'Stop requested for your sessions. Queued work and missions are canceled.');
    } catch (err) {
      setStopNotice(err instanceof Error ? err.message : 'Could not stop all work');
    } finally {
      setStoppingAll(false);
    }
  };

  const stopSelected = async () => {
    if (!selected || stoppingId != null || stoppingAll) return;
    setStoppingId(selected.id);
    try {
      const stopped = await onCancel(selected.id);
      if (stopped === false) {
        setError('The session did not acknowledge the stop request.');
        return;
      }
      await refresh(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not stop session');
    } finally {
      setStoppingId(null);
    }
  };

  const handleTraceScroll = (event: UIEvent<HTMLDivElement>) => {
    const node = event.currentTarget;
    stickToBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
  };

  const selectRelative = (delta: number) => {
    if (sessions.length === 0) return;
    const current = sessions.findIndex((session) => session.id === selectedId);
    const next = current < 0
      ? 0
      : Math.max(0, Math.min(sessions.length - 1, current + delta));
    setSelectedId(sessions[next].id);
  };

  return (
    <ModalShell
      backdropClassName="session-manager-backdrop"
      dialogClassName="session-manager"
      ariaLabelledby="session-manager-title"
      onClose={onClose}
    >
        <header className="session-manager-header">
          <div className="session-manager-title">
            <div className="session-manager-mark" aria-hidden="true"><Activity size={17} /></div>
            <div>
              <div className="session-manager-kicker">RUN CONTROL</div>
              <h2 id="session-manager-title">Agent sessions</h2>
            </div>
          </div>
          <div className="session-manager-header-readouts">
            <span className={`session-manager-runner ${runnerOnline ? 'online' : 'offline'}`}>
              <Radio size={12} />
              runner {runnerOnline ? 'online' : 'offline'}
            </span>
            <span className="session-manager-count">
              <strong>{sessions.length}</strong>
              active
            </span>
            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={() => void stopAll()}
              disabled={stoppingAll || stoppingId != null}
              title="Stop all your sessions, missions and queued work across vaults"
            >
              {stoppingAll ? <Loader2 className="is-spinning" size={12} /> : <Square size={10} fill="currentColor" />}
              {stoppingAll ? 'Stopping all' : 'Stop all'}
            </button>
            <button
              type="button"
              className="btn-icon"
              onClick={() => void refresh(true)}
              title="Refresh sessions"
              aria-label="Refresh sessions"
              disabled={refreshing}
            >
              <RefreshCw className={refreshing ? 'is-spinning' : ''} size={15} />
            </button>
            <button
              ref={closeButtonRef}
              type="button"
              className="btn-icon"
              onClick={onClose}
              title="Close session manager"
              aria-label="Close session manager"
            >
              <X size={17} />
            </button>
          </div>
        </header>

        {stopNotice && <p role="status">{stopNotice}</p>}
        <div className={`session-manager-body${selected ? ' has-selection' : ''}`}>
          <nav
            className="session-manager-list"
            aria-label="Running AI sessions"
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                selectRelative(1);
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                selectRelative(-1);
              }
            }}
          >
            <div className="session-manager-list-head">
              <span>Active runs</span>
              <small>{lastUpdatedAt ? `synced ${formatRelativeDate(new Date(lastUpdatedAt).toISOString())}` : 'connecting…'}</small>
            </div>
            {error && (
              <div className="session-manager-error" role="alert">
                <strong>Sessions unavailable</strong>
                <span>{error}</span>
                <button type="button" className="btn btn-sm" onClick={() => void refresh(true)}>Try again</button>
              </div>
            )}
            {!error && loading && sessions.length === 0 && (
              <div className="session-manager-loading">
                <Loader2 className="is-spinning" size={18} />
                Reading active runs…
              </div>
            )}
            {!error && !loading && sessions.length === 0 && (
              <div className="session-manager-empty">
                <div className="session-manager-empty-mark"><Activity size={24} /></div>
                <strong>No active runs</strong>
                <span>Agents appear here as soon as they enter the queue.</span>
              </div>
            )}
            <div className="session-manager-items">
              {sessions.map((session) => {
                const request = sessionRequestText(session.prompt);
                const chosen = session.id === selectedId;
                return (
                  <button
                    type="button"
                    key={session.id}
                    className={`session-manager-item${chosen ? ' selected' : ''}`}
                    onClick={() => {
                      setSelectedId(session.id);
                      setView('activity');
                    }}
                    aria-current={chosen ? 'true' : undefined}
                  >
                    <span className="session-manager-avatar"><Bot size={15} /></span>
                    <span className="session-manager-item-main">
                      <span className="session-manager-item-line">
                        <strong>{sessionName(session)}</strong>
                        <em className={session.status}>{session.status}</em>
                      </span>
                      <span className="session-manager-item-request">{request}</span>
                      <span className="session-manager-item-meta">
                        {session.channel_title ? <><Hash size={10} />{session.channel_title}</> : 'note run'}
                        <i />
                        {session.vault_name}
                        <i />
                        {shortModel(session.model)}
                        <i />
                        {elapsedLabel(session.started_at, now)}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </nav>

          <main className="session-manager-detail">
            {selected ? (
              <>
                <div className="session-manager-summary">
                  <button
                    type="button"
                    className="btn-icon session-manager-mobile-back"
                    onClick={() => setSelectedId(null)}
                    aria-label="Back to active sessions"
                  >
                    <ChevronLeft size={18} />
                  </button>
                  <div className="session-manager-summary-copy">
                    <span className="session-manager-eyebrow">
                      <span className={`session-manager-live-dot ${selected.status}`} />
                      {selected.status === 'queued' ? 'Queued session' : 'Live session'}
                    </span>
                    <h3>{sessionName(selected)}</h3>
                    <p>
                      @{sessionHandle(selected)}
                      {selected.channel_title ? ` in #${selected.channel_title}` : ' · note operation'}
                    </p>
                  </div>
                  <div className="session-manager-actions">
                    {selected.channel_id && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => void onOpenChat(
                          selected.vault_id,
                          selected.channel_id!,
                          selected.channel_title || 'Chat',
                        )}
                      >
                        <ExternalLink size={13} /> Open chat
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      onClick={() => void stopSelected()}
                      disabled={stoppingAll || stoppingId === selected.id}
                    >
                      {stoppingId === selected.id
                        ? <Loader2 className="is-spinning" size={12} />
                        : <Square size={10} fill="currentColor" />}
                      {stoppingId === selected.id ? 'Stopping' : 'Stop'}
                    </button>
                  </div>
                </div>

                <div className="session-manager-readouts" aria-label="Session details">
                  <div><span>Run</span><strong>#{selected.id}</strong></div>
                  <div><span>Model</span><strong title={selected.model || 'Default model'}>{shortModel(selected.model)}</strong></div>
                  <div><span>Elapsed</span><strong>{elapsedLabel(selected.started_at, now)}</strong></div>
                  <div><span>Events</span><strong>{events.length}</strong></div>
                </div>

                <section className="session-manager-prompt">
                  <div className="session-manager-section-title">
                    <MessageSquarePlus size={12} />
                    Current request
                  </div>
                  <p>{requestText}</p>
                </section>

                <section className="session-manager-trace-shell">
                  <div className="session-manager-trace-head">
                    <div className="session-manager-trace-tabs" role="tablist" aria-label="Session output">
                      <button
                        type="button"
                        className={view === 'activity' ? 'selected' : ''}
                        onClick={() => setView('activity')}
                        role="tab"
                        aria-selected={view === 'activity'}
                      >
                        <Activity size={12} /> Activity
                        {timeline.length > 0 && <span>{timeline.length}</span>}
                      </button>
                      <button
                        type="button"
                        className={view === 'console' ? 'selected' : ''}
                        onClick={() => setView('console')}
                        role="tab"
                        aria-selected={view === 'console'}
                      >
                        <Terminal size={12} /> Console
                      </button>
                    </div>
                    <span className="session-manager-live-label">
                      <i /> live
                    </span>
                  </div>
                  <div
                    ref={traceRef}
                    className={`session-manager-trace ${view === 'console' ? 'is-console' : ''}`}
                    onScroll={handleTraceScroll}
                  >
                    {traceError && <div className="session-manager-trace-error">{traceError}</div>}
                    {traceLoading && events.length === 0 && (
                      <div className="session-manager-trace-empty"><LoadingIndicator label="Loading trace" /></div>
                    )}
                    {!traceLoading && view === 'activity' && timeline.length === 0 && (
                      <TraceEmpty icon={<Activity size={17} />}>Waiting for the first activity…</TraceEmpty>
                    )}
                    {view === 'activity' && timeline.map((item) => (
                      <article className={`session-manager-event is-${item.kind}${item.error ? ' is-error' : ''}`} key={item.id}>
                        <div className="session-manager-event-rail"><i /></div>
                        <div className="session-manager-event-content">
                          <header>
                            <span>{item.label}</span>
                            <time>{formatRelativeDate(item.ts)}</time>
                          </header>
                          <pre>{item.text}</pre>
                        </div>
                      </article>
                    ))}
                    {!traceLoading && view === 'console' && !consoleText && (
                      <TraceEmpty icon={<Terminal size={17} />}>No console output yet.</TraceEmpty>
                    )}
                    {view === 'console' && consoleText && <pre className="session-manager-console">{consoleText}</pre>}
                  </div>
                </section>

                {selected.channel_id ? (
                  <form className="session-manager-interrogate" onSubmit={submit}>
                    <div className="session-manager-composer-copy">
                      <label htmlFor={`session-manager-draft-${selected.id}`}>
                        Steer @{sessionHandle(selected)}
                      </label>
                      <span>Enter to send · Shift+Enter for a new line</span>
                    </div>
                    <div className="session-manager-composer-row">
                      <textarea
                        id={`session-manager-draft-${selected.id}`}
                        value={draft}
                        rows={1}
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={handleComposerKeyDown}
                        placeholder="Add context or redirect this run…"
                      />
                      <button type="submit" className="btn btn-primary" disabled={!draft.trim()} title="Send follow-up">
                        <Send size={13} /> Send
                      </button>
                    </div>
                  </form>
                ) : (
                  <div className="session-manager-note-run">
                    This run is attached to a note, so follow-ups stay in that note’s agent flow.
                  </div>
                )}
              </>
            ) : (
              <div className="session-manager-detail-empty">
                <div className="session-manager-empty-mark"><Activity size={24} /></div>
                <strong>Select a session</strong>
                <span>Inspect its request, model activity, tools, and console output.</span>
              </div>
            )}
          </main>
        </div>
    </ModalShell>
  );
}
