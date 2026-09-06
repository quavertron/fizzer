import { useEffect, useMemo, useState, type MouseEvent, type ReactNode, type CSSProperties } from 'react';
import { ChevronRight, History, Loader2, Square } from 'lucide-react';
import { api } from '../api';
import { reportWorkItemGitState, workspaceBridge } from '../chat/workspaces';
import { formatChatTime } from '../chat/time';
import type { ChatMessage, ChatMission, ChatMissionEvent, ChatMissionTask } from '../chat/types';
import { ChatTaskReview } from './ChatTaskReview';
import { SwipeToReply } from './SwipeToReply';
import { ThinkingSpinner } from './ThinkingSpinner';
import { missionAccent, missionShortName, type MissionMessageIdentity } from '../chat/missionIdentity';

export function MissionMessageLabel({ identity }: { identity: MissionMessageIdentity }) {
  return <div className="chat-mission-identity" data-mission-id={identity.id}
    style={{ '--mission-accent': missionAccent(identity.id) } as CSSProperties} title={identity.title}>
    <span className="chat-mission-identity-name">{missionShortName(identity.title)}</span>
    <span className="chat-mission-identity-role">{identity.role}</span>
  </div>;
}

function missionTaskChangeChips(task: ChatMissionTask, fileCount?: number): Array<{ label: string; tone?: 'ok' | 'warn' | 'idle'; title?: string; href?: string }> {
  const chips: Array<{ label: string; tone?: 'ok' | 'warn' | 'idle'; title?: string; href?: string }> = [];
  if (task.branch || task.baseCommit) {
    const base = task.baseCommit ? task.baseCommit.slice(0, 7) : task.workspaceMode || 'base unknown';
    chips.push({ label: `${task.branch || 'workspace'} → ${base}`, tone: 'idle', title: task.worktreePath || undefined });
  }
  const reportedFiles = task.gitState?.changedFiles;
  const files = fileCount ?? reportedFiles;
  if (files != null) chips.push({ label: `${files} file${files === 1 ? '' : 's'}`, tone: files ? 'idle' : 'ok' });
  if (task.verification) chips.push({ label: 'evidence recorded', tone: 'ok', title: task.verification });
  else if (task.workItemStatus === 'review' || task.workItemStatus === 'done') chips.push({ label: 'unverified', tone: 'warn' });
  if (task.reviewState === 'in_review') chips.push({ label: task.prState ? `PR ${task.prState}` : 'in review', tone: 'ok', href: task.prUrl });
  else if (task.reviewState === 'requested') chips.push({ label: 'review requested', tone: 'warn' });
  else if (task.reviewState === 'ready') chips.push({ label: 'reviewed', tone: 'ok' });
  if (task.workItemStatus === 'review' || task.workItemStatus === 'done') {
    chips.push(task.reviewReady
      ? { label: 'ready for feedback', tone: 'ok', title: 'Workspace review is ready. Deployment requires separate live revision verification.' }
      : { label: 'review blocked', tone: 'warn', title: task.reviewBlockers?.join('\n') });
  }
  return chips;
}

function missionEventLabel(event: ChatMissionEvent) {
  if (event.kind === 'mission_created') return 'Mission opened';
  if (event.kind === 'task_added') return 'Task added';
  if (event.kind === 'task_dispatched') return 'Task dispatched';
  if (event.kind === 'task_started') return 'Task started';
  if (event.kind === 'task_retried') return 'Task retried';
  if (event.kind === 'mission_completed') return 'Mission completed';
  if (event.kind === 'mission_canceled') return 'Mission canceled';
  if (event.fromStatus && event.toStatus && event.fromStatus !== event.toStatus) {
    return `${event.fromStatus} → ${event.toStatus}`;
  }
  return event.toStatus || event.kind.replace(/_/g, ' ');
}

export function ChatMissionCard({
  mission,
  vaultId,
  channelId,
  traceContent,
  tracePeek,
  replyMessage,
  onReply,
  onContextMenu,
}: {
  mission: ChatMission;
  vaultId?: string;
  channelId?: string;
  /** Full work stream, rendered only while the mission is expanded. */
  traceContent?: ReactNode;
  /** Always-visible activity strip (collapsed + expanded). */
  tracePeek?: {
    live: boolean;
    summary: string;
    author: string;
    label: string;
    decals: Array<{ phase: string; label: string; mark: string }>;
    phase: string;
  } | null;
  /** Originating message for right-click reply (same as any other chat row). */
  replyMessage?: ChatMessage;
  onReply?: (message: ChatMessage) => void;
  onContextMenu?: (event: MouseEvent, message: ChatMessage) => void;
}) {
  const needsAttention = mission.status === 'attention' || mission.status === 'blocked';
  const [open, setOpen] = useState(needsAttention);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [events, setEvents] = useState<ChatMissionEvent[] | null>(null);
  const [historyError, setHistoryError] = useState('');
  const [stopping, setStopping] = useState(false);
  const [fileCounts, setFileCounts] = useState<ReadonlyMap<string, number>>(() => new Map());
  const bridge = useMemo(workspaceBridge, []);
  useEffect(() => {
    if (mission.status === 'attention' || mission.status === 'blocked') setOpen(true);
  }, [mission.status]);
  useEffect(() => {
    setEvents(null);
    setTimelineOpen(false);
    setHistoryError('');
  }, [mission.id]);
  useEffect(() => {
    if (!open || !bridge) return;
    const paths = [...new Set(mission.tasks
      .map((task) => task.worktreePath)
      .filter((path): path is string => Boolean(path)))];
    if (!paths.length) return;
    let cancelled = false;
    void Promise.all(paths.map(async (path) => {
      const result = await bridge.getWorktreeStatus(path);
      if (!result.ok) return null;
      const task = mission.tasks.find((candidate) => candidate.worktreePath === path);
      if (task?.workItemId) void reportWorkItemGitState(task.workItemId, result).catch(() => {});
      return [path, result.changedFiles.length] as const;
    })).then((results) => {
      if (cancelled) return;
      setFileCounts((previous) => {
        const next = new Map(previous);
        for (const result of results) if (result) next.set(result[0], result[1]);
        return next;
      });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [bridge, mission.tasks, open]);
  const done = mission.tasks.filter((task) => task.status === 'completed' || task.status === 'canceled').length;
  const total = mission.tasks.length;
  const terminal = mission.status === 'completed' || mission.status === 'canceled';
  const runningTask = mission.tasks.find((task) => task.status === 'running');
  const pendingTask = mission.tasks.find((task) => task.status === 'pending');
  const attentionTask = mission.tasks.find((task) => task.status === 'failed' || task.status === 'blocked');
  const live = !terminal && (Boolean(runningTask) || Boolean(!needsAttention && !attentionTask && tracePeek?.live && tracePeek.phase !== 'routing'));
  const statusLabel = terminal ? mission.status
    : needsAttention || attentionTask ? 'needs attention'
      : live ? 'working'
        : pendingTask ? 'queued'
          : mission.status === 'reviewing' ? 'awaiting review' : 'starting';
  const lead = mission.coordinatorMention || mission.coordinator;
  const peekAuthor = tracePeek?.author
    || (runningTask ? (runningTask.assigneeMention || runningTask.assignee) : '')
    || '';
  const peekLabel = (terminal ? mission.summary : '')
    || (!terminal && attentionTask ? attentionTask.summary || attentionTask.title : '')
    || (!terminal && tracePeek?.live ? tracePeek.label : '')
    || (runningTask ? runningTask.title : '')
    || (pendingTask ? `Queued · ${pendingTask.title}` : '')
    || (!terminal ? tracePeek?.label : '')
    || (!terminal ? 'Waiting for an agent update' : '');
  // Peek is collapsed-only activity exposure. When open, the stream/tasks are the UI.
  // Settled missions without useful activity text skip the second rail entirely.
  const showPeek = !open && Boolean(peekLabel) && (terminal || live || Boolean(tracePeek || runningTask || pendingTask || attentionTask));
  async function toggleTimeline() {
    const next = !timelineOpen;
    setTimelineOpen(next);
    if (!next || events || !vaultId || !channelId) return;
    setHistoryError('');
    try {
      const result = await api<{ events: ChatMissionEvent[] }>(
        `/api/vaults/${vaultId}/channels/${channelId}/missions/${mission.id}/history`,
      );
      setEvents(result.events || []);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : 'Could not load mission history');
    }
  }
  async function stopMission() {
    if (!vaultId || !channelId || stopping) return;
    setStopping(true);
    setHistoryError('');
    try {
      await api(`/api/vaults/${vaultId}/channels/${channelId}/missions/${mission.id}/finish`, {
        method: 'POST',
        body: JSON.stringify({
          coordinatorRegistrationId: mission.coordinatorMention || mission.coordinator,
          status: 'canceled',
          summary: 'Stopped by user.',
        }),
      });
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : 'Could not stop mission');
    } finally {
      setStopping(false);
    }
  }
  // Treat the mission chrome like a normal message: right-click opens the same
  // context menu (Reply/Forward/…) targeting the originating chat message.
  // Wire it on buttons too — some browsers only fire contextmenu on the target.
  const openMissionContextMenu = replyMessage && onContextMenu
    ? (event: MouseEvent) => onContextMenu(event, replyMessage)
    : undefined;
  const card = (
    <div
      className={`chat-mission-card is-${mission.status}${live ? ' is-live' : ''}${open ? ' is-open' : ''}`}
      data-mission-id={mission.id}
      style={{ '--mission-accent': missionAccent(mission.id) } as CSSProperties}
      data-open={open ? 'true' : 'false'}
      data-message-id={replyMessage?.id}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        setOpen((value) => !value);
      }}
      onContextMenu={openMissionContextMenu}
    >
      <div className="chat-mission-head">
        <button
          type="button"
          className="chat-mission-toggle"
          tabIndex={-1}
          onClick={() => setOpen((value) => !value)}
          onContextMenu={openMissionContextMenu}
        >
          {live
            ? <ThinkingSpinner className="chat-mission-whirl" title="Mission working" />
            : <span className="chat-mission-state" aria-hidden="true" />}
          <span className="chat-mission-kicker">Mission</span>
          <strong>{mission.title}</strong>
          <span className="chat-mission-status">{statusLabel}</span>
          <ChevronRight size={13} className={`chat-mission-chevron${open ? ' open' : ''}`} aria-hidden="true" />
        </button>
        {!terminal && vaultId && channelId && (
          <button
            type="button"
            className="chat-mission-stop"
            tabIndex={-1}
            onClick={(event) => {
              event.stopPropagation();
              void stopMission();
            }}
            onContextMenu={openMissionContextMenu}
            disabled={stopping}
            title="Stop mission"
          >
            {stopping ? <Loader2 className="is-spinning" size={11} /> : <Square size={10} fill="currentColor" />}
            {stopping ? 'Stopping' : 'Stop'}
          </button>
        )}
        {showPeek && (
          <button
            type="button"
            className={`chat-mission-peek${live ? ' is-live' : ''}`}
            tabIndex={-1}
            onClick={() => setOpen((value) => !value)}
            onContextMenu={openMissionContextMenu}
            aria-label={`Mission activity: ${peekAuthor ? `${peekAuthor} — ` : ''}${peekLabel}`}
          >
            {/* Empty gutter matches the status-dot column; header owns the spinner. */}
            <span className="chat-mission-peek-gutter" aria-hidden="true" />
            {peekAuthor && <span className="chat-mission-peek-author">{peekAuthor}</span>}
            <span className="chat-mission-peek-copy">
              {runningTask && tracePeek?.live && <span className="chat-mission-peek-task">{runningTask.title}</span>}
              <span className="chat-mission-peek-label">{peekLabel}</span>
            </span>
          </button>
        )}
      </div>
      {open && (
        <div className="chat-mission-content" onContextMenu={openMissionContextMenu}>
          <div className="chat-mission-stream">
            {traceContent && (
              <div className="chat-mission-trace">{traceContent}</div>
            )}
            <div className="chat-mission-plan">
              {lead && (
                <p className="chat-mission-lead">
                  Led by <strong>@{lead}</strong>
                  {total > 0 ? ` · ${done}/${total} agent tasks` : ''}
                </p>
              )}
              {mission.objective && <p className="chat-mission-objective">{mission.objective}</p>}
              {mission.tasks.length > 0 ? (
                <div className="chat-mission-tasks">
                  {mission.tasks.map((task) => (
                    <div className={`chat-mission-task is-${task.status}`} key={task.id}>
                      <span className="chat-mission-task-state" aria-label={task.status}>
                        {task.status === 'completed' ? '✓'
                          : task.status === 'failed' || task.status === 'blocked' ? '!'
                            : task.status === 'running' ? (
                              <ThinkingSpinner className="chat-mission-task-whirl" title="Task running" />
                            ) : '○'}
                      </span>
                      <div>
                        <strong>{task.title}</strong>
                        <span>
                          @{task.assigneeMention || task.assignee} · {task.status}
                          {task.parentTaskId ? ` · child of ${mission.tasks.find((parent) => parent.id === task.parentTaskId)?.title || task.parentTaskId}` : task.anonymous ? ' · subagent' : ''}
                          {task.joiningChildren ? ' · joining children' : ''}
                          {task.attempt > 0 ? ` · attempt ${task.attempt + 1}` : ''}
                          {task.queueReason === 'dependency' ? ` · waiting for ${task.waitingFor.length}` : ''}
                          {task.queueReason === 'dependency-attention' ? ' · waiting on review' : ''}
                          {task.queueReason === 'agent-busy' ? ' · agent busy' : ''}
                          {task.queueReason === 'queued' ? ' · queued' : ''}
                          {task.assigneeModel ? ` · ${task.assigneeModel}` : ''}
                          {task.reasoningEffort ? ` · ${task.reasoningEffort} effort` : ''}
                        </span>
                        {task.workItemId && (
                          <div className="chat-mission-chips">
                            {missionTaskChangeChips(task, task.worktreePath ? fileCounts.get(task.worktreePath) : undefined).map((chip, index) => (
                              chip.href ? (
                                <a key={`${chip.label}:${index}`} className={`chat-mission-chip is-${chip.tone || 'idle'}`} href={chip.href} target="_blank" rel="noreferrer" title={chip.title}>
                                  {chip.label}
                                </a>
                              ) : (
                                <span key={`${chip.label}:${index}`} className={`chat-mission-chip is-${chip.tone || 'idle'}`} title={chip.title}>
                                  {chip.label}
                                </span>
                              )
                            ))}
                          </div>
                        )}
                        {task.summary && <small>{task.summary}</small>}
                        {task.workItemId && task.worktreePath && (
                          <ChatTaskReview workItemId={task.workItemId} worktreePath={task.worktreePath} />
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <span className="chat-mission-empty">@{lead || mission.coordinator} is deciding how to handle this.</span>
              )}
              {mission.summary && <div className="chat-mission-summary">{mission.summary}</div>}
            </div>
          </div>
          {vaultId && channelId && (
            <div className="chat-mission-history">
              <button type="button" onClick={() => void toggleTimeline()}>
                <History size={12} />
                {timelineOpen ? 'Hide timeline' : 'Timeline'}
              </button>
              {timelineOpen && (
                <div className="chat-mission-timeline">
                  {events === null && !historyError && <span>Loading history…</span>}
                  {historyError && <span className="is-error">{historyError}</span>}
                  {events?.length === 0 && <span>No recorded events.</span>}
                  {events?.map((event) => (
                    <div className="chat-mission-event" key={event.id}>
                      <i aria-hidden="true" />
                      <div>
                        <strong>{missionEventLabel(event)}</strong>
                        <time dateTime={event.createdAt}>{formatChatTime(event.createdAt)}</time>
                        {event.title && event.title !== mission.title && <span>{event.title}</span>}
                        {event.attempt > 0 && <span>Attempt {event.attempt + 1}</span>}
                        {event.summary && <small>{event.summary}</small>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
  if (!replyMessage || !onReply) return card;
  return (
    <SwipeToReply
      className="chat-mission-swipe"
      onReply={() => onReply(replyMessage)}
      allowSwipeFrom=".chat-mission-toggle, .chat-mission-peek"
    >
      {card}
    </SwipeToReply>
  );
}
