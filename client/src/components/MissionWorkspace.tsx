import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AlertTriangle, ChevronRight, Clock3, Expand, History, MessageCircle, Plus, RefreshCw, Save, X } from 'lucide-react';
import type { User } from '../api';
import { ApiError } from '../api';
import type { ChatMessage } from '../chat/types';
import { mergeRemoteChatMessage } from '../chat/runBlocks';
import { useChannelMessages } from '../chat/messageStore';
import { NoteEditor } from './NoteEditor';
import {
  approveMission,
  createMissionNote,
  fetchMission,
  fetchMissionHistory,
  fetchMissionNote,
  fetchMissionTaskTrace,
  saveMissionNote,
  steerMissionTask,
  type MissionHistoryEvent,
  type MissionNote,
  type MissionNoteInput,
  type MissionNoteRef,
  type MissionRecord,
  type MissionTask,
} from '../missions';
import './MissionWorkspace.css';

export type MissionWorkspaceProps = {
  vaultId: string;
  missionId: string;
  currentUser: User;
  onOpenNote: (id: string) => void;
  renderChat: (channelId: string, channelName: string) => ReactNode;
  onMissionChanged?: () => void;
  /** Incremented by the owning App for socket/reconnect mission changes. */
  refreshToken?: number;
};

export type MissionDraftSnapshot = {
  draft: string;
  baseRevision?: string;
  dirty: boolean;
};

/** Keep a dirty draft anchored to its original revision during refresh. */
export function reconcileMissionDraft(
  previous: MissionDraftSnapshot | undefined,
  incoming: { content: string; revision?: string },
): MissionDraftSnapshot {
  if (previous?.dirty) return previous;
  return { draft: incoming.content, baseRevision: incoming.revision, dirty: false };
}

/** Apply a save response without erasing edits typed while the request ran. */
export function completeMissionDraftSave(
  previous: MissionDraftSnapshot,
  submitted: string,
  saved: { content: string; revision?: string },
): MissionDraftSnapshot {
  const unchanged = previous.draft === submitted;
  return {
    draft: unchanged ? saved.content : previous.draft,
    baseRevision: saved.revision ?? previous.baseRevision,
    dirty: !unchanged,
  };
}

export function missionTraceKey(task: Pick<MissionTask, 'id' | 'attempt' | 'runId'>): string {
  return `${task.id}:${task.attempt}:${task.runId ?? 'none'}`;
}

/** Merge a hydrated snapshot first, then apply authoritative socket updates. */
export function mergeMissionTraceMessages(snapshot: ChatMessage[], live: ChatMessage[]): ChatMessage[] {
  const merged = new Map(snapshot.map((message) => [message.id, message]));
  live.forEach((message) => {
    const previous = merged.get(message.id);
    if (!previous) {
      merged.set(message.id, message);
      return;
    }
    const next = mergeRemoteChatMessage(previous, message, true);
    // Socket/list projections intentionally omit heavy trace fields. Keep the
    // detail payload while still allowing live body/status/run metadata to win.
    if (previous.harnessLog && !message.harnessLog) next.harnessLog = previous.harnessLog;
    if (previous.blocks?.length && !message.blocks?.length) next.blocks = previous.blocks;
    if (previous.images?.length && !message.images?.length) next.images = previous.images;
    merged.set(message.id, next);
  });
  return [...merged.values()];
}

type MissionView = 'brief' | 'work' | 'history';
type NoteConflict = { current: MissionNote | null; draft: string; message: string };
type CreateNoteState = { kind: 'milestone' | 'feature'; parentNoteId: string | null; title: string } | null;
type MentionChooser = { mention: string; tasks: MissionTask[] } | null;

function missionNoteTitle(note: MissionNoteRef): string {
  return note.title.trim() || (note.kind === 'milestone' ? 'Untitled milestone' : note.kind === 'feature' ? 'Untitled feature' : 'Mission brief');
}

function taskWorkerLabel(task: MissionTask): string {
  return task.assigneeMention?.trim() || task.assignee?.trim() || 'worker';
}

function taskStatusLabel(task: MissionTask): string {
  if (task.status === 'running') return 'working';
  if (task.status === 'completed') return 'complete';
  if (task.status === 'failed') return 'failed';
  if (task.status === 'blocked') return 'blocked';
  if (task.status === 'canceled') return 'canceled';
  return task.queueReason || 'queued';
}

function eventDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function isMissionNote(value: unknown): value is MissionNote {
  if (!value || typeof value !== 'object') return false;
  const note = value as Partial<MissionNote>;
  return typeof note.id === 'string' && typeof note.content === 'string' && typeof note.title === 'string';
}

export function MissionWorkspace({
  vaultId,
  missionId,
  currentUser,
  onOpenNote,
  renderChat,
  onMissionChanged,
  refreshToken,
}: MissionWorkspaceProps) {
  const [mission, setMission] = useState<MissionRecord | null>(null);
  const [notes, setNotes] = useState<Record<string, MissionNote>>({});
  const [noteErrors, setNoteErrors] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [conflicts, setConflicts] = useState<Record<string, NoteConflict>>({});
  const [view, setView] = useState<MissionView>('brief');
  const [openMilestones, setOpenMilestones] = useState<Set<string>>(() => new Set());
  const [openFeatures, setOpenFeatures] = useState<Set<string>>(() => new Set());
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(true);
  const [history, setHistory] = useState<MissionHistoryEvent[] | null>(null);
  const [createNote, setCreateNote] = useState<CreateNoteState>(null);
  const [traceTaskId, setTraceTaskId] = useState<string | null>(null);
  const [traceFullscreen, setTraceFullscreen] = useState(false);
  const [traceMessages, setTraceMessages] = useState<Record<string, ChatMessage[]>>({});
  const [traceLoading, setTraceLoading] = useState<Record<string, boolean>>({});
  const [steerDraft, setSteerDraft] = useState('');
  const [steering, setSteering] = useState(false);
  const [steerError, setSteerError] = useState('');
  const [mentionChooser, setMentionChooser] = useState<MentionChooser>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [saving, setSaving] = useState<Set<string>>(() => new Set());
  const [creating, setCreating] = useState(false);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine);
  const loadSequence = useRef(0);
  const saveSequence = useRef<Record<string, number>>({});
  const dirtyRef = useRef<Set<string>>(new Set());
  const draftsRef = useRef<Record<string, string>>({});
  const draftBaseRef = useRef<Record<string, string>>({});
  const reviewedRevisionsRef = useRef<Record<string, string>>({});
  const initialLoadRef = useRef(true);
  const refreshTokenRef = useRef(refreshToken);
  const traceRequestRef = useRef<Record<string, number>>({});
  const historyRequestRef = useRef(0);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const channelMessages = useChannelMessages(mission?.channelId || '');

  draftsRef.current = drafts;

  const loadMission = useCallback(async (background = false) => {
    const sequence = ++loadSequence.current;
    if (background) setRefreshing(true);
    else setLoading(true);
    setError('');
    try {
      const loaded = await fetchMission(vaultId, missionId);
      if (sequence !== loadSequence.current) return;
      setMission(loaded);
      const loadedNotes = await Promise.all(loaded.notes.map(async (ref) => {
        try {
          return { ref, note: await fetchMissionNote(ref.noteId), error: '' };
        } catch (cause) {
          return { ref, note: null, error: cause instanceof Error ? cause.message : 'Could not load note' };
        }
      }));
      if (sequence !== loadSequence.current) return;
      const nextNotes: Record<string, MissionNote> = {};
      const nextNoteErrors: Record<string, string> = {};
      loadedNotes.forEach(({ ref, note, error: noteError }) => {
        if (note) nextNotes[note.id] = note;
        else nextNoteErrors[ref.noteId] = noteError;
      });
      const nextDrafts = { ...draftsRef.current };
      const nextBaseRevisions = { ...draftBaseRef.current };
      loaded.notes.forEach((ref) => {
        const incoming = nextNotes[ref.noteId];
        if (!incoming) return;
        const previous = draftsRef.current[ref.noteId] == null
          ? undefined
          : {
              draft: draftsRef.current[ref.noteId],
              baseRevision: draftBaseRef.current[ref.noteId],
              dirty: dirtyRef.current.has(ref.noteId),
            };
        const reconciled = reconcileMissionDraft(previous, incoming);
        nextDrafts[ref.noteId] = reconciled.draft;
        if (reconciled.baseRevision) nextBaseRevisions[ref.noteId] = reconciled.baseRevision;
      });
      draftsRef.current = nextDrafts;
      draftBaseRef.current = nextBaseRevisions;
      setNotes(nextNotes);
      setNoteErrors(nextNoteErrors);
      setDrafts(nextDrafts);
      // The first complete load is what the user reviewed. Later socket/
      // reconnect refreshes may update the incoming view, but keep the
      // previously reviewed revision so approval detects unseen changes.
      if (initialLoadRef.current) {
        reviewedRevisionsRef.current = Object.fromEntries(
          loaded.notes.flatMap((ref) => nextNotes[ref.noteId]?.revision
            ? [[ref.noteId, nextNotes[ref.noteId].revision!]]
            : []),
        );
        initialLoadRef.current = false;
      } else {
        loaded.notes.forEach((ref) => {
          if (!(ref.noteId in reviewedRevisionsRef.current) && nextNotes[ref.noteId]?.revision) {
            reviewedRevisionsRef.current[ref.noteId] = nextNotes[ref.noteId].revision!;
          }
        });
      }
      setHistory(null);
    } catch (cause) {
      if (sequence !== loadSequence.current) return;
      setError(cause instanceof Error ? cause.message : 'Could not load mission');
    } finally {
      if (sequence === loadSequence.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [missionId, vaultId]);

  useEffect(() => {
    dirtyRef.current = new Set();
    draftsRef.current = {};
    draftBaseRef.current = {};
    reviewedRevisionsRef.current = {};
    initialLoadRef.current = true;
    saveSequence.current = {};
    traceRequestRef.current = {};
    historyRequestRef.current += 1;
    refreshTokenRef.current = refreshToken;
    setNoteErrors({});
    setMission(null);
    setNotes({});
    setDrafts({});
    setMentionChooser(null);
    setConflicts({});
    setTraceTaskId(null);
    setTraceMessages({});
    setTraceLoading({});
    setSteerDraft('');
    setSteerError('');
    setOpenMilestones(new Set());
    setOpenFeatures(new Set());
    void loadMission();
  }, [loadMission, missionId, vaultId]);

  useEffect(() => {
    if (refreshTokenRef.current === refreshToken) return;
    refreshTokenRef.current = refreshToken;
    void loadMission(true);
  }, [loadMission, refreshToken]);
  useEffect(() => {
    const onOnline = () => {
      setOnline(true);
      void loadMission(true);
    };
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [loadMission]);

  useEffect(() => {
    if (!traceFullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setTraceFullscreen(false);
      restoreFocusRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [traceFullscreen]);

  const noteRefs = mission?.notes ?? [];
  const briefRef = noteRefs.find((note) => note.kind === 'mission') ?? null;
  const milestones = noteRefs.filter((note) => note.kind === 'milestone');
  const featuresByParent = useMemo(() => {
    const grouped = new Map<string, MissionNoteRef[]>();
    noteRefs.filter((note) => note.kind === 'feature').forEach((note) => {
      if (!note.parentNoteId) return;
      const bucket = grouped.get(note.parentNoteId) ?? [];
      bucket.push(note);
      grouped.set(note.parentNoteId, bucket);
    });
    return grouped;
  }, [noteRefs]);

  const dirtyNoteIds = [...dirtyRef.current];
  const tasks = mission?.tasks ?? [];
  const activeTasks = tasks.filter((task) => task.status === 'running').length;
  const pendingTasks = tasks.filter((task) => task.status === 'pending').length;
  const blockedTasks = tasks.filter((task) => task.status === 'blocked' || task.status === 'failed').length;
  const completedTasks = tasks.filter((task) => task.status === 'completed').length;

  const updateDraft = useCallback((noteId: string, content: string) => {
    dirtyRef.current.add(noteId);
    draftsRef.current = { ...draftsRef.current, [noteId]: content };
    setDrafts((previous) => ({ ...previous, [noteId]: content }));
    setConflicts((previous) => {
      if (!previous[noteId]) return previous;
      const next = { ...previous };
      delete next[noteId];
      return next;
    });
  }, []);

  const saveNote = useCallback(async (noteId: string) => {
    const reference = mission?.notes.find((note) => note.noteId === noteId);
    const current = notes[noteId];
    const content = draftsRef.current[noteId] ?? current?.content ?? '';
    const expectedRevision = draftBaseRef.current[noteId] ?? reference?.revision ?? current?.revision;
    if (!expectedRevision) {
      setError('This mission note has no revision; refresh before saving.');
      return false;
    }
    const requestSequence = (saveSequence.current[noteId] ?? 0) + 1;
    saveSequence.current[noteId] = requestSequence;
    setSaving((previous) => new Set(previous).add(noteId));
    setError('');
    try {
      const saved = await saveMissionNote(noteId, content, expectedRevision);
      if (saveSequence.current[noteId] !== requestSequence) return false;
      const latestDraft = draftsRef.current[noteId] ?? content;
      const next = completeMissionDraftSave({
        draft: latestDraft,
        baseRevision: expectedRevision,
        dirty: dirtyRef.current.has(noteId),
      }, content, saved);
      setNotes((previous) => ({ ...previous, [noteId]: saved }));
      setMission((previous) => previous && ({
        ...previous,
        notes: previous.notes.map((note) => note.noteId === noteId
          ? { ...note, revision: saved.revision ?? note.revision, title: saved.title || note.title }
          : note),
      }));
      draftBaseRef.current = { ...draftBaseRef.current, [noteId]: next.baseRevision ?? expectedRevision };
      draftsRef.current = { ...draftsRef.current, [noteId]: next.draft };
      setDrafts((previous) => ({ ...previous, [noteId]: next.draft }));
      if (next.dirty) dirtyRef.current.add(noteId);
      else dirtyRef.current.delete(noteId);
      if (saved.revision) reviewedRevisionsRef.current[noteId] = saved.revision;
      setConflicts((previous) => {
        const nextConflicts = { ...previous };
        delete nextConflicts[noteId];
        return nextConflicts;
      });
      setNotice(next.dirty ? 'Note saved; newer edits remain unsaved' : 'Note saved');
      onMissionChanged?.();
      return true;
    } catch (cause) {
      if (saveSequence.current[noteId] !== requestSequence) return false;
      if (cause instanceof ApiError && cause.status === 409) {
        const candidate = cause.data.currentNote ?? cause.data.note;
        const currentNote = isMissionNote(candidate) ? candidate : null;
        const latestDraft = draftsRef.current[noteId] ?? content;
        setConflicts((previous) => ({
          ...previous,
          [noteId]: { current: currentNote, draft: latestDraft, message: cause.message || 'This note changed elsewhere.' },
        }));
        if (currentNote) {
          setNotes((previous) => ({ ...previous, [noteId]: currentNote }));
          setMission((previous) => previous && ({
            ...previous,
            notes: previous.notes.map((note) => note.noteId === noteId
              ? { ...note, revision: currentNote.revision ?? note.revision, title: currentNote.title || note.title }
              : note),
          }));
        }
      } else {
        setError(cause instanceof Error ? cause.message : 'Could not save note');
      }
      return false;
    } finally {
      if (saveSequence.current[noteId] === requestSequence) {
        setSaving((previous) => {
          const next = new Set(previous);
          next.delete(noteId);
          return next;
        });
      }
    }
  }, [mission, notes, onMissionChanged]);

  const saveAllDirty = useCallback(async () => {
    for (const noteId of [...dirtyRef.current]) {
      if (!(await saveNote(noteId))) return false;
    }
    return true;
  }, [saveNote]);

  const handleApprove = useCallback(async () => {
    if (!mission || mission.phase !== 'planning' || approving) return;
    setApproving(true);
    setError('');
    try {
      if (!(await saveAllDirty())) return;
      // Approval must use the revisions rendered to this reviewer. A refresh
      // deliberately leaves existing entries untouched until the user reviews
      // the changed note, so the server can reject unseen collaborator edits.
      const expectedRevisions = Object.fromEntries(
        mission.notes.map((note) => [note.noteId, reviewedRevisionsRef.current[note.noteId] ?? note.revision]),
      );
      const approved = await approveMission(vaultId, mission.id, expectedRevisions);
      setMission(approved);
      approved.notes.forEach((note) => {
        reviewedRevisionsRef.current[note.noteId] = note.revision;
      });
      setNotice(`Approved by ${currentUser.displayName || currentUser.username}`);
      onMissionChanged?.();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        setError('Mission changed since you reviewed it. Review the updated notes before approving.');
        void loadMission(true);
      } else {
        setError(cause instanceof Error ? cause.message : 'Could not approve mission');
      }
    } finally {
      setApproving(false);
    }
  }, [approving, currentUser.displayName, currentUser.username, loadMission, mission, onMissionChanged, saveAllDirty, vaultId]);

  const handleCreateNote = useCallback(async () => {
    if (!createNote || !mission || !createNote.title.trim() || creating) return;
    const input: MissionNoteInput = {
      kind: createNote.kind,
      parentNoteId: createNote.parentNoteId,
      title: createNote.title.trim(),
      content: '## Open questions\n\n',
    };
    setCreating(true);
    setError('');
    try {
      await createMissionNote(vaultId, mission.id, input);
      setCreateNote(null);
      setNotice(`${input.kind === 'feature' ? 'Feature' : 'Milestone'} note created`);
      await loadMission(true);
      onMissionChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create mission note');
    } finally {
      setCreating(false);
    }
  }, [createNote, creating, loadMission, mission, onMissionChanged, vaultId]);

  const openHistory = useCallback(async () => {
    if (!mission || historyLoading) return;
    setView('history');
    if (history) return;
    const request = ++historyRequestRef.current;
    const load = loadSequence.current;
    setHistoryLoading(true);
    setError('');
    try {
      const events = await fetchMissionHistory(vaultId, mission.channelId, mission.id);
      if (request === historyRequestRef.current && load === loadSequence.current) setHistory(events);
    } catch (cause) {
      if (request === historyRequestRef.current && load === loadSequence.current) {
        setError(cause instanceof Error ? cause.message : 'Could not load mission history');
      }
    } finally {
      if (request === historyRequestRef.current) setHistoryLoading(false);
    }
  }, [history, historyLoading, mission, vaultId]);

  const hydrateTrace = useCallback(async (task: MissionTask) => {
    if (!mission?.channelId || !task.id) return;
    const key = missionTraceKey(task);
    if (traceMessages[key]) return;
    const request = (traceRequestRef.current[key] ?? 0) + 1;
    traceRequestRef.current[key] = request;
    setTraceLoading((previous) => ({ ...previous, [key]: true }));
    try {
      const exact = await fetchMissionTaskTrace(vaultId, mission.channelId, task.id, task.runId);
      if (traceRequestRef.current[key] !== request) return;
      setTraceMessages((previous) => ({ ...previous, [key]: exact }));
    } catch (cause) {
      if (traceRequestRef.current[key] === request) {
        setError(cause instanceof Error ? cause.message : 'Could not hydrate worker trace');
      }
    } finally {
      if (traceRequestRef.current[key] === request) {
        setTraceLoading((previous) => ({ ...previous, [key]: false }));
      }
    }
  }, [mission?.channelId, traceMessages, vaultId]);

  const openTrace = useCallback((task: MissionTask, trigger: HTMLElement | null) => {
    if (!task.id) return;
    restoreFocusRef.current = trigger;
    setView('work');
    setTraceTaskId(task.id);
    setSteerDraft('');
    setSteerError('');
    void hydrateTrace(task);
  }, [hydrateTrace]);

  const activeTraceTask = tasks.find((task) => task.id === traceTaskId) ?? null;
  useEffect(() => {
    if (!activeTraceTask) return;
    void hydrateTrace(activeTraceTask);
  }, [activeTraceTask, hydrateTrace]);

  const activeTraceMessages = activeTraceTask
    ? mergeMissionTraceMessages(
      traceMessages[missionTraceKey(activeTraceTask)] ?? [],
      channelMessages.filter((message) => message.missionTaskId === activeTraceTask.id
        || (activeTraceTask.runId != null && message.runId === activeTraceTask.runId)),
    )
    : [];
  const submitSteering = useCallback(async () => {
    if (!activeTraceTask || !mission?.channelId || !mission.coordinatorRegistrationId) {
      setSteerError('Coordinator steering is unavailable for this mission.');
      return;
    }
    const message = steerDraft.trim();
    if (!message || steering) return;
    setSteering(true);
    setSteerError('');
    try {
      await steerMissionTask(vaultId, mission.channelId, activeTraceTask.id, {
        coordinatorRegistrationId: mission.coordinatorRegistrationId,
        message,
        attempt: activeTraceTask.attempt,
        runId: activeTraceTask.runId,
      });
      setSteerDraft('');
      setNotice(`Steering sent to @${taskWorkerLabel(activeTraceTask)}`);
      onMissionChanged?.();
      void loadMission(true);
    } catch (cause) {
      setSteerError(cause instanceof Error ? cause.message : 'Could not steer worker');
    } finally {
      setSteering(false);
    }
  }, [activeTraceTask, loadMission, mission, onMissionChanged, steerDraft, steering, vaultId]);

  const renderNote = (reference: MissionNoteRef, compact = false) => {
    const note = notes[reference.noteId];
    const content = drafts[reference.noteId] ?? note?.content ?? '';
    const conflict = conflicts[reference.noteId];
    const incomingRevisionChanged = Boolean(
      dirtyRef.current.has(reference.noteId)
      && note?.revision
      && draftBaseRef.current[reference.noteId]
      && note.revision !== draftBaseRef.current[reference.noteId],
    );
    const workerTasks = tasks.filter((task) => task.briefNoteId === reference.noteId);
    const matchingWorkerTasks = (mention: string) => workerTasks.filter((task) => (
      taskWorkerLabel(task).replace(/^@/, '').toLocaleLowerCase() === mention.replace(/^@/, '').toLocaleLowerCase()
    ));
    const resolveWorkerMention = (mention: string): 'known' | 'ambiguous' | 'unknown' => {
      const matches = matchingWorkerTasks(mention);
      return matches.length === 1 ? 'known' : matches.length > 1 ? 'ambiguous' : 'unknown';
    };
    const onWorkerMention = (mention: string) => {
      const matches = matchingWorkerTasks(mention);
      if (matches.length === 1) void openTrace(matches[0], null);
      else if (matches.length > 1) setMentionChooser({ mention, tasks: matches });
    };
    if (!note) {
      if (noteErrors[reference.noteId]) {
        return <div className="mission-note-loading mission-note-load-error"><AlertTriangle size={15} /><span>{noteErrors[reference.noteId]}</span><button type="button" onClick={() => void loadMission(true)}>Retry</button></div>;
      }
      return <div className="mission-note-loading">Loading note…</div>;
    }
    return (
      <div className={`mission-note-editor${compact ? ' mission-note-editor-compact' : ''}`}>
        <NoteEditor
          note={note}
          content={content}
          onContentChange={(next) => updateDraft(reference.noteId, next)}
          onSave={() => saveNote(reference.noteId)}
          titleEditable={false}
          onOpenNote={onOpenNote}
          resolveWorkerMention={resolveWorkerMention}
          onWorkerMention={onWorkerMention}
        />
        <div className="mission-note-actions">
          {incomingRevisionChanged && !conflict && <span className="mission-muted" role="status">A newer server revision is loaded; your draft still saves against its original revision.</span>}
          {dirtyRef.current.has(reference.noteId) && <span className="mission-dirty">Unsaved changes</span>}
          {saving.has(reference.noteId) && <span className="mission-muted">Saving…</span>}
          {!saving.has(reference.noteId) && dirtyRef.current.has(reference.noteId) && (
            <button type="button" className="mission-save-button" onClick={() => void saveNote(reference.noteId)}><Save size={13} /> Save</button>
          )}
          <button type="button" className="mission-open-note" onClick={() => onOpenNote(reference.noteId)}>Open note</button>
        </div>
        {conflict && (
          <div className="mission-conflict" role="alert">
            <AlertTriangle size={15} />
            <div><strong>Note changed elsewhere.</strong><span>{conflict.message}</span></div>
            <button type="button" onClick={() => {
              const server = conflict.current;
              if (!server) return;
              dirtyRef.current.delete(reference.noteId);
              draftsRef.current = { ...draftsRef.current, [reference.noteId]: server.content };
              if (server.revision) {
                draftBaseRef.current = { ...draftBaseRef.current, [reference.noteId]: server.revision };
                reviewedRevisionsRef.current[reference.noteId] = server.revision;
              }
              setNotes((previous) => ({ ...previous, [reference.noteId]: server }));
              setDrafts((previous) => ({ ...previous, [reference.noteId]: server.content }));
              setMission((previous) => previous && ({
                ...previous,
                notes: previous.notes.map((note) => note.noteId === reference.noteId
                  ? { ...note, revision: server.revision ?? note.revision, title: server.title || note.title }
                  : note),
              }));
              setConflicts((previous) => { const next = { ...previous }; delete next[reference.noteId]; return next; });
            }}>Use server</button>
            <button type="button" onClick={() => {
              const serverRevision = conflict.current?.revision ?? reference.revision;
              if (serverRevision) {
                draftBaseRef.current = { ...draftBaseRef.current, [reference.noteId]: serverRevision };
              }
              if (conflict.current) setNotes((previous) => ({ ...previous, [reference.noteId]: conflict.current! }));
              updateDraft(reference.noteId, conflict.draft);
            }}>Keep draft</button>
          </div>
        )}
        {workerTasks.length > 0 && (
          <div className="mission-note-workers" aria-label="Workers assigned to this note">
            {workerTasks.map((task) => (
              <button
                type="button"
                key={task.id}
                className={`mission-worker-mention mission-worker-${task.status}`}
                title={`${task.title} · ${taskStatusLabel(task)}`}
                onClick={(event) => void openTrace(task, event.currentTarget)}
              >@{taskWorkerLabel(task)}</button>
            ))}
          </div>
        )}
      </div>
    );
  };

  if (loading && !mission) return <section className="mission-workspace mission-state"><RefreshCw className="mission-spin" size={18} /> Loading mission…</section>;
  if (!mission) {
    return <section className="mission-workspace mission-state mission-state-error"><AlertTriangle size={18} /><strong>{error || 'Mission unavailable'}</strong><button type="button" onClick={() => void loadMission()}>Retry</button></section>;
  }

  return (
    <section className="mission-workspace" aria-label={`Mission workspace: ${mission.title}`} aria-busy={refreshing}>
      <header className="mission-toolbar">
        <div className="mission-title"><span className="mission-mark" aria-hidden="true">◇</span><span>{mission.title}</span></div>
        <span className="mission-phase">{mission.phase}</span>
        <nav className="mission-tabs" aria-label="Mission views">
          <button type="button" className={view === 'brief' ? 'is-active' : ''} onClick={() => setView('brief')}>Brief</button>
          <button type="button" className={view === 'work' ? 'is-active' : ''} onClick={() => setView('work')}>Work</button>
        </nav>
        <button type="button" className="mission-live-summary" onClick={() => { setView('work'); const task = tasks.find((candidate) => candidate.status === 'running') ?? tasks.find((candidate) => candidate.status === 'pending'); if (task?.briefNoteId) setOpenFeatures((previous) => new Set(previous).add(task.briefNoteId!)); }}>
          <span className={`mission-live-dot${activeTasks ? ' is-live' : ''}`} /> {activeTasks} active · {pendingTasks} queued · {completedTasks} done
        </button>
        <button type="button" className="mission-icon-button" aria-expanded={detailsOpen} title="Mission details" onClick={() => setDetailsOpen((value) => !value)}><Clock3 size={15} /></button>
        <button type="button" className="mission-icon-button" aria-expanded={chatOpen} title={chatOpen ? 'Hide conversation' : 'Show conversation'} onClick={() => setChatOpen((value) => !value)}><MessageCircle size={15} /></button>
        <button type="button" className="mission-icon-button" aria-expanded={view === 'history'} title="Mission history" onClick={() => void openHistory()}><History size={15} /></button>
      </header>
      {detailsOpen && <div className="mission-details"><span>Status <strong>{mission.status}</strong></span><span>Phase <strong>{mission.phase}</strong></span><span>Assignments <strong>{completedTasks} complete · {activeTasks} active · {blockedTasks} blocked</strong></span><span>Updated <strong>{eventDate(mission.updatedAt)}</strong></span></div>}
      {!online && <div className="mission-offline" role="status"><AlertTriangle size={14} /> Offline. Drafts remain local; reconnect to refresh or save.</div>}
      {error && <div className="mission-error" role="alert"><AlertTriangle size={14} /> {error}<button type="button" onClick={() => void loadMission(true)}>Retry</button></div>}
      {notice && <div className="mission-notice" role="status">{notice}<button type="button" aria-label="Dismiss" onClick={() => setNotice('')}><X size={13} /></button></div>}
      <div className={`mission-layout${chatOpen ? '' : ' chat-hidden'}`}>
        <main className="mission-main">
          {view === 'brief' && (
            <section className="mission-view mission-brief-view" aria-label="Mission brief">
              {briefRef ? renderNote(briefRef) : <div className="mission-empty">This mission has no brief note.</div>}
              {mission.phase === 'planning' && (
                <div className="mission-approval-bar"><div><strong>Planning revision ready?</strong><span>Approval snapshots every linked note revision and starts execution.</span></div><button type="button" disabled={approving || dirtyNoteIds.length > 0 || !briefRef} onClick={() => void handleApprove()}>{approving ? 'Approving…' : 'Approve mission'}</button>{dirtyNoteIds.length > 0 && <small>Save your drafts before approving.</small>}</div>
              )}
            </section>
          )}
          {view === 'work' && (
            <section className="mission-view mission-work-view" aria-label="Mission work">
              <div className="mission-view-heading"><div><span className="mission-eyebrow">Milestones &amp; features</span><p>Editable plan notes, dependencies, open questions, and explicit assignment boundaries.</p></div><button type="button" onClick={() => setCreateNote({ kind: 'milestone', parentNoteId: null, title: '' })}><Plus size={14} /> Add milestone</button></div>
              {createNote?.kind === 'milestone' && <div className="mission-create-form"><input autoFocus value={createNote.title} placeholder="Milestone title" onChange={(event) => setCreateNote({ ...createNote, title: event.target.value })} onKeyDown={(event) => { if (event.key === 'Enter') void handleCreateNote(); }} /><button type="button" disabled={creating || !createNote.title.trim()} onClick={() => void handleCreateNote()}>{creating ? 'Creating…' : 'Create'}</button><button type="button" onClick={() => setCreateNote(null)}>Cancel</button></div>}
              {milestones.length === 0 && <div className="mission-empty">No milestones yet. Add one to shape the work.</div>}
              {milestones.map((milestone) => {
                const open = openMilestones.has(milestone.noteId);
                const features = featuresByParent.get(milestone.noteId) ?? [];
                return <article className={`mission-milestone${open ? ' is-open' : ''}`} key={milestone.noteId}>
                  <button type="button" className="mission-milestone-summary" aria-expanded={open} onClick={() => setOpenMilestones((previous) => { const next = new Set(previous); next.has(milestone.noteId) ? next.delete(milestone.noteId) : next.add(milestone.noteId); return next; })}><ChevronRight size={15} /><strong>{missionNoteTitle(milestone)}</strong><span>{features.length} feature{features.length === 1 ? '' : 's'}</span></button>
                  {open && <div className="mission-milestone-body">{renderNote(milestone)}<div className="mission-feature-heading"><span>Features</span><button type="button" onClick={() => setCreateNote({ kind: 'feature', parentNoteId: milestone.noteId, title: '' })}><Plus size={13} /> Add feature</button></div>{createNote?.kind === 'feature' && createNote.parentNoteId === milestone.noteId && <div className="mission-create-form"><input autoFocus value={createNote.title} placeholder="Feature title" onChange={(event) => setCreateNote({ ...createNote, title: event.target.value })} onKeyDown={(event) => { if (event.key === 'Enter') void handleCreateNote(); }} /><button type="button" disabled={creating || !createNote.title.trim()} onClick={() => void handleCreateNote()}>{creating ? 'Creating…' : 'Create'}</button><button type="button" onClick={() => setCreateNote(null)}>Cancel</button></div>}{features.map((feature) => { const featureOpen = openFeatures.has(feature.noteId); return <article className={`mission-feature${featureOpen ? ' is-open' : ''}`} key={feature.noteId}><button type="button" className="mission-feature-summary" aria-expanded={featureOpen} onClick={() => setOpenFeatures((previous) => { const next = new Set(previous); next.has(feature.noteId) ? next.delete(feature.noteId) : next.add(feature.noteId); return next; })}><ChevronRight size={14} /><strong>{missionNoteTitle(feature)}</strong></button>{featureOpen && <div className="mission-feature-body">{renderNote(feature, true)}</div>}</article>; })}</div>}
                </article>;
              })}
            </section>
          )}
          {view === 'history' && <section className="mission-view mission-history-view" aria-label="Mission history"><div className="mission-view-heading"><div><span className="mission-eyebrow">Recorded decisions &amp; evidence</span><p>Prior planning evidence, separate from live worker activity.</p></div><button type="button" onClick={() => setView('work')}>Back to work</button></div>{historyLoading && <div className="mission-empty">Loading history…</div>}{history && history.length === 0 && <div className="mission-empty">No recorded history yet.</div>}{history && history.length > 0 && <div className="mission-history-list">{history.map((event) => <div className="mission-history-event" key={event.id}><time>{eventDate(event.createdAt)}</time><div><strong>{event.title || event.kind}</strong><span>{event.summary}</span>{event.taskId && <code>task {event.taskId.slice(0, 8)}{event.runId != null ? ` · run ${event.runId}` : ''}</code>}</div></div>)}</div>}</section>}
        </main>
        {chatOpen && <aside className="mission-chat" aria-label="Mission conversation"><div className="mission-chat-header"><strong>Mission conversation</strong><button type="button" className="mission-icon-button" title="Hide conversation" onClick={() => setChatOpen(false)}><MessageCircle size={15} /></button></div><div className="mission-chat-body">{renderChat(mission.channelId, `${mission.title} conversation`)}</div></aside>}
      </div>
      {mentionChooser && <div className="mission-mention-chooser-backdrop" role="presentation" onMouseDown={() => setMentionChooser(null)}><section className="mission-mention-chooser" role="dialog" aria-label={`Choose worker for @${mentionChooser.mention}`} onMouseDown={(event) => event.stopPropagation()}><header><strong>@{mentionChooser.mention}</strong><button type="button" onClick={() => setMentionChooser(null)} aria-label="Close worker chooser"><X size={14} /></button></header>{mentionChooser.tasks.map((task) => <button type="button" key={task.id} onClick={(event) => { setMentionChooser(null); void openTrace(task, event.currentTarget); }}><span>@{taskWorkerLabel(task)}</span><small>{task.title} · {taskStatusLabel(task)}</small></button>)}</section></div>}
      {activeTraceTask && <section className={`mission-trace${traceFullscreen ? ' is-fullscreen' : ''}`} aria-label={`Worker trace for ${taskWorkerLabel(activeTraceTask)}`}>
        <header>
          <div><strong>@{taskWorkerLabel(activeTraceTask)}</strong><span>{activeTraceTask.title} · {taskStatusLabel(activeTraceTask)}{activeTraceTask.runId != null ? ` · run ${activeTraceTask.runId}` : ''}</span></div>
          <div>
            <button type="button" onClick={() => setTraceFullscreen((value) => !value)} title={traceFullscreen ? 'Exit fullscreen' : 'Open fullscreen'}><Expand size={14} /></button>
            <button type="button" onClick={() => { setTraceFullscreen(false); setTraceTaskId(null); restoreFocusRef.current?.focus(); }} title="Close trace"><X size={14} /></button>
          </div>
        </header>
        <div className="mission-trace-body" role="log">
          {traceLoading[missionTraceKey(activeTraceTask)] && <div className="mission-empty">Loading stored task trace…</div>}
          {!traceLoading[missionTraceKey(activeTraceTask)] && activeTraceMessages.length === 0 && <div className="mission-empty">No stored trace messages for this task yet.</div>}
          {activeTraceMessages.map((message) => (
            <article key={message.id}>
              <time>{eventDate(message.createdAt)}</time>
              <span className="mission-trace-status">{message.status || 'done'}</span>
              <div>
                {message.body && <p>{message.body}</p>}
                {message.blocks?.map((block, index) => (
                  block.text || block.redacted
                    ? <pre key={`${message.id}-block-${index}`} className={`mission-trace-block mission-trace-${block.type}`}>{block.redacted ? '[redacted]' : block.text}</pre>
                    : null
                ))}
                {message.harnessLog && <details open><summary>Harness log</summary><pre className="mission-trace-harness">{message.harnessLog}</pre></details>}
                {!message.body && !message.harnessLog && !(message.blocks?.some((block) => block.text || block.redacted)) && <p>(no public output)</p>}
              </div>
            </article>
          ))}
        </div>
        <form className="mission-trace-steering" onSubmit={(event) => { event.preventDefault(); void submitSteering(); }}>
          <textarea
            value={steerDraft}
            onChange={(event) => { setSteerDraft(event.target.value); setSteerError(''); }}
            placeholder="Send guidance to this worker…"
            aria-label="Worker steering message"
            rows={2}
            disabled={steering}
          />
          <button type="submit" disabled={steering || !steerDraft.trim() || !mission.coordinatorRegistrationId}>{steering ? 'Sending…' : 'Steer worker'}</button>
          {steerError && <span className="mission-error" role="alert">{steerError}</span>}
        </form>
      </section>}
    </section>
  );
}

export default MissionWorkspace;
