import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ClipboardList, Flag, Forward, Hash, History, MessageCircle, Reply, Trash2, X } from 'lucide-react';
import { api, type NoteSummary } from '../api';
import { normalizeMention } from '../chat/mentions';
import { createChannelWorkItem } from '../chat/workItems';
import { buildReplyPreview, buildReplyRef } from '../chat/replies';
import type {
  ChatAgentOption,
  ChatAgentRegistration,
  ChatChannelPresence,
  ChatMediaAttachment,
  ChatMessage,
  ChatMission,
  ChatReplyRef,
  DesktopRunnerHealth,
  SharedChatNote,
  VaultAgent,
} from '../chat/types';
import { ChatAgentPanel, type ChatAgentPanelHandle, planUsageProviderId } from './ChatAgentPanel';
import { ChatAvatar } from './ChatAvatar';
import { ChatChannelSettings } from './ChatChannelSettings';
import { ChatComposer, type ChatComposerHandle } from './ChatComposer';
import { ChatGroupRow, getRunningMessageState, getSteeringPromptLabels } from './ChatGroupRow';
import { ChatMissionCard } from './ChatMissionCard';
import { usePopupMenu } from '../ui/popupMenu';
import { ChatSidebarButtons } from './ChatSidebarButtons';
import { ChatWorkTrace } from './ChatWorkTrace';
import { ReportDialog } from './ReportDialog';
import { hasRunActivity } from '../chat/harnessActivity';
import { segmentTranscript, workTracePeek, type ChatMessageGroup } from '../chat/workTrace';
import { chatMessageStore, useChannelMessages } from '../chat/messageStore';
import { applyRemoteChatMessage, isLiveAgentStatus, sortChatMessages } from '../chat/runBlocks';
import {
  CHAT_NOTE_MARKER,
} from '../chat/shared';

export {
  canGroupChatMessages,
  canMergeChatMessages,
  CHAT_NOTE_MARKER,
  createChatAgentRegistrationId,
  mergeChatPresence,
} from '../chat/shared';
export type {
  ChatAgentOption,
  ChatAgentRegistration,
  ChatBlock,
  ChatChannelPresence,
  ChatForwardRef,
  ChatMediaAttachment,
  ChatMessage,
  ChatMission,
  ChatMissionEvent,
  ChatMissionTask,
  ChatMissionTaskStatus,
  ChatReplyRef,
  DesktopRunnerHealth,
  PlanUsage,
  PlanUsageWindow,
  SharedChatNote,
  VaultAgent,
} from '../chat/types';
export {
  CHAT_MEDIA_LIMIT,
  CHAT_MEDIA_MAX_BYTES,
  isMp4Attachment,
  isVideoMediaType,
  prepareReplyForSend,
} from './ChatComposer';
export { REASONING_EFFORTS, ReasoningEffortSelect } from './ChatAgentPanel';
export { ChatMediaEmbed } from './ChatMarkdown';
export {
  getRunningMessageState,
  getSteeringPromptLabels,
  shouldRenderRunPanel,
} from './ChatGroupRow';
export { buildReplyRef, resolveReplyMention } from '../chat/replies';

interface ChatViewProps {
  channelId: string;
  channelName: string;
  isLoadingMessages?: boolean;
  currentUser: string;
  presence: ChatChannelPresence;
  availableAgents: ChatAgentOption[];
  registeredAgents: ChatAgentRegistration[];
  vaultAgents?: VaultAgent[];
  runnerHealth?: DesktopRunnerHealth | null;
  onRegisterAgent: (channelId: string, registration: ChatAgentRegistration) => void;
  onRemoveAgent: (channelId: string, registrationId: string) => void;
  onUpsertVaultAgent?: (agent: Partial<VaultAgent> & { agentId: string }) => Promise<VaultAgent | void> | VaultAgent | void;
  onDeleteVaultAgent?: (vaultAgentId: string) => Promise<void> | void;
  onDeleteAgentProfile?: (vaultAgentId: string) => Promise<void> | void;
  onAddVaultAgentToChannel?: (
    channelId: string,
    vaultAgentId: string,
    membership?: ChatAgentRegistration,
  ) => Promise<void> | void;
  onInviteUser: (channelId: string, username: string) => Promise<void>;
  onRemoveParticipant?: (channelId: string, username: string) => Promise<void>;
  onLeaveChannel?: (channelId: string) => Promise<void>;
  onSendMessage: (channelId: string, body: string, media?: ChatMediaAttachment[], replyTo?: ChatReplyRef) => void;
  /** Delete a message for everyone (own messages, or any when you host the channel). */
  onDeleteMessage?: (channelId: string, messageId: string) => Promise<void> | void;
  /** Copy a message into another channel. Resolves once the copy is posted. */
  onForwardMessage?: (channelId: string, messageId: string, targetChannelId: string) => Promise<void>;
  onCancelRun: (runId: number) => void;
  notes?: NoteSummary[];
  onOpenNote?: (id: string) => void;
  onOpenSharedNote?: (channelId: string, messageId: string, title: string) => Promise<SharedChatNote | null>;
  /** When set, members panel open state is controlled by the app (workspace toolbar). */
  membersOpen?: boolean;
  onMembersOpenChange?: (open: boolean) => void;
  vaultId?: string;
  /** Merge a full message (e.g. harness log) after expand-fetch. */
  onHydrateMessage?: (message: ChatMessage) => void;
  /** When set, scroll to and highlight this message once it's in the list (e.g. from search). */
  jumpToMessageId?: string;
  /** Called after a jump target has been consumed so the parent can clear it. */
  onJumpHandled?: () => void;
  /** Mount the shared vault rail outside the channel content, or suppress the inline copy. */
  sidebarMode?: 'inline' | 'only' | 'hidden';
  /** Present the chat as a person-to-person thread, without channel/workspace chrome. */
  directMessage?: boolean;
}

// Stable fallback: an inline `= []` default would mint a new identity every
// render and defeat the notes-aware memo comparators below.
const EMPTY_NOTES: NoteSummary[] = [];

// Transcript stickiness:
// 1. The messages pane is the only viewport that owns "follow live".
// 2. Live traces expand that pane; they must not scroll inside themselves.
// 3. Size changes pin to bottom unless the user scrolled up.
// Slightly generous: stream growth often leaves a few px of lag for one frame;
// 24px was flapping sticky under fast agent output.
function isAtScrollBottom(element: HTMLElement, threshold = 48) {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
}

export function shouldSnapToRecentOnSend(element: HTMLElement, threshold = 600) {
  return isAtScrollBottom(element, threshold);
}

export function isPendingAgentRunShell(message: ChatMessage | undefined) {
  if (!message) return false;
  const belongsToAgent = Boolean(message.agentId || message.registrationId || message.runId != null);
  return belongsToAgent && isLiveAgentStatus(message.status);
}

export function shouldDetachStickyForWheel(deltaY: number) {
  return deltaY < 0;
}

export function shouldDetachStickyForTouch(startY: number | null, currentY: number | null) {
  return startY != null && currentY != null && currentY > startY + 4;
}

export const ChatView = memo(function ChatView({
  channelId,
  channelName,
  isLoadingMessages = false,
  currentUser,
  presence,
  availableAgents,
  registeredAgents,
  vaultAgents = [],
  runnerHealth = null,
  onRegisterAgent,
  onRemoveAgent,
  onUpsertVaultAgent,
  onDeleteVaultAgent,
  onDeleteAgentProfile,
  onAddVaultAgentToChannel,
  onInviteUser,
  onRemoveParticipant,
  onLeaveChannel,
  onSendMessage,
  onDeleteMessage,
  onForwardMessage,
  onCancelRun,
  notes = EMPTY_NOTES,
  onOpenNote,
  onOpenSharedNote,
  membersOpen: membersOpenProp,
  onMembersOpenChange,
  vaultId,
  onHydrateMessage,
  jumpToMessageId,
  onJumpHandled,
  sidebarMode = 'inline',
  directMessage = false,
}: ChatViewProps) {
  // Messages come from an external per-channel store, not props: streaming tokens
  // then re-render only this ChatView, never the App shell. See messageStore.ts.
  const messages = useChannelMessages(channelId);
  const [usersCollapsedLocal, setUsersCollapsedLocal] = useState(() =>
    typeof localStorage !== 'undefined' && localStorage.getItem('cascade_chat_users_collapsed') === '1'
  );
  // Controlled from App toolbar when provided; otherwise local desktop rail state.
  const usersCollapsed = onMembersOpenChange
    ? !(membersOpenProp ?? false)
    : usersCollapsedLocal;
  const setUsersCollapsed = useCallback((value: boolean | ((prev: boolean) => boolean)) => {
    const next = typeof value === 'function' ? value(usersCollapsed) : value;
    if (onMembersOpenChange) {
      onMembersOpenChange(!next);
    } else {
      setUsersCollapsedLocal(next);
    }
  }, [onMembersOpenChange, usersCollapsed]);
  const [agentChrome, setAgentChrome] = useState({ inviteOpen: false, agentMenuOpen: false });
  const onAgentChromeChange = useCallback((chrome: { inviteOpen: boolean; agentMenuOpen: boolean }) => {
    setAgentChrome(chrome);
  }, []);
  // Channel-wide working directory: when set, every agent in the channel runs
  // from here (overrides each agent's own cwd, enforced server-side).
  const [channelCwd, setChannelCwd] = useState('');
  const [channelSettingsOpen, setChannelSettingsOpen] = useState(false);

  useEffect(() => {
    if (!vaultId || !channelId) return;
    let alive = true;
    api<{ settings: { cwd: string; kanbanNoteId?: string } }>(`/api/vaults/${vaultId}/channels/${channelId}/settings`)
      .then((d) => {
        if (!alive) return;
        setChannelCwd(d.settings?.cwd ?? '');
      })
      .catch(() => { /* keep current value */ });
    return () => { alive = false; };
  }, [vaultId, channelId]);

  // `override` lets the workspace panel repoint the channel at a worktree path
  // without waiting for the input's state round-trip.
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [jumpHighlightMessageId, setJumpHighlightMessageId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; message: ChatMessage } | null>(null);
  const [participantMenu, setParticipantMenu] = useState<{ x: number; y: number; username: string; action: 'remove' | 'leave' } | null>(null);
  const [reportMessage, setReportMessage] = useState<ChatMessage | null>(null);
  const contextMenuRef = usePopupMenu<HTMLDivElement>(contextMenu);
  const participantMenuRef = usePopupMenu<HTMLDivElement>(participantMenu);
  /** Delete is two-step in the context menu rather than a native confirm dialog. */
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [missionArchiveOpen, setMissionArchiveOpen] = useState(false);
  const [missionArchive, setMissionArchive] = useState<ChatMission[]>([]);
  const [missionArchiveBusy, setMissionArchiveBusy] = useState(false);
  const [missionArchiveError, setMissionArchiveError] = useState('');
  const loadMissionArchive = useCallback(async () => {
    if (!vaultId) return;
    setMissionArchiveBusy(true);
    setMissionArchiveError('');
    try {
      const result = await api<{ missions: ChatMission[] }>(
        `/api/vaults/${vaultId}/channels/${channelId}/missions`,
      );
      setMissionArchive(result.missions || []);
    } catch (error) {
      setMissionArchiveError(error instanceof Error ? error.message : 'Could not load missions');
    } finally {
      setMissionArchiveBusy(false);
    }
  }, [vaultId, channelId]);
  useEffect(() => {
    setMissionArchiveOpen(false);
    setMissionArchive([]);
    setMissionArchiveError('');
  }, [channelId]);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  /** Inner content wrapper — ResizeObserver watches height growth (harness, thinking). */
  const messagesContentRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const wasAtBottomRef = useRef(true);
  const scrollFrameRef = useRef<number | null>(null);
  const jumpHighlightTimerRef = useRef<number | null>(null);
  // null so the first mount counts as a channel change and force-scrolls to bottom.
  const previousChannelIdRef = useRef<string | null>(null);
  // True while we scroll programmatically, so the resulting scroll events aren't
  // mistaken for the user scrolling away from the bottom (which would unstick).
  const programmaticScrollRef = useRef(false);
  const programmaticClearRef = useRef<number | null>(null);
  const touchStartYRef = useRef<number | null>(null);
  // Armed only by a send made near the live edge. It bridges the separate
  // optimistic-human-message and agent-run-shell layout commits.
  const pendingSendFollowRef = useRef(false);
  const composerRef = useRef<ChatComposerHandle>(null);
  const agentPanelRef = useRef<ChatAgentPanelHandle>(null);
  const sortedMessages = useMemo(() => {
    // Persisted rows follow server commit order. Optimistic rows still use their
    // timestamps so a persisted agent shell cannot jump above its local prompt.
    const visible = messages.filter((message) => {
      if (isLiveAgentStatus(message.status)) return true;
      if (message.status === 'failed' || message.status === 'canceled') return true;
      if (message.body?.trim()) return true;
      if (message.images?.length || message.attachments?.length) return true;
      if (hasRunActivity(message)) return true;
      if (message.agentId || message.registrationId || message.runId != null) return false;
      return true;
    });
    return sortChatMessages(visible);
  }, [messages]);
  const historySentinelRef = useRef<HTMLDivElement | null>(null);
  const historyRequestRef = useRef<AbortController | null>(null);
  const historyCursorRef = useRef<number | null>(null);
  const historyAnchorRef = useRef<{ id: string; top: number } | null>(null);
  const [hasOlderHistory, setHasOlderHistory] = useState(true);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState('');
  useEffect(() => {
    historyCursorRef.current = null;
    historyAnchorRef.current = null;
    setHasOlderHistory(true);
    setLoadingHistory(false);
    setHistoryError('');
    return () => { historyRequestRef.current?.abort(); historyRequestRef.current = null; };
  }, [channelId]);

  const loadOlderHistory = useCallback(async () => {
    if (!vaultId || isLoadingMessages || !hasOlderHistory || historyRequestRef.current) return;
    const controller = new AbortController();
    historyRequestRef.current = controller;
    setLoadingHistory(true);
    setHistoryError('');
    const seqs = chatMessageStore.getChannel(channelId).flatMap(row => row.seq == null ? [] : [row.seq]);
    const cursor = historyCursorRef.current ?? (seqs.length ? Math.min(...seqs) : null);
    try {
      const page = await api<{ messages: ChatMessage[]; beforeSeq: number | null; hasMore: boolean }>(
        `/api/vaults/${vaultId}/channels/${channelId}/messages?detail=list&limit=120${cursor == null ? '' : `&beforeSeq=${cursor}`}`,
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      const root = messagesRef.current;
      const anchor = root && [...root.querySelectorAll<HTMLElement>('[data-message-id]')]
        .find(el => el.getBoundingClientRect().bottom > root.getBoundingClientRect().top);
      historyAnchorRef.current = anchor ? { id: anchor.dataset.messageId!, top: anchor.getBoundingClientRect().top } : null;
      historyCursorRef.current = page.beforeSeq;
      setHasOlderHistory(page.hasMore);
      chatMessageStore.update(channelId, rows => page.messages.reduce((merged, row) => (
        merged.some(existing => existing.id === row.id) ? merged : applyRemoteChatMessage(merged, row)
      ), rows));
    } catch (error) {
      if (!controller.signal.aborted) setHistoryError(error instanceof Error ? error.message : 'Could not load history');
    } finally {
      if (historyRequestRef.current === controller) {
        historyRequestRef.current = null;
        setLoadingHistory(false);
      }
    }
  }, [vaultId, channelId, isLoadingMessages, hasOlderHistory]);

  useLayoutEffect(() => {
    const anchor = historyAnchorRef.current;
    historyAnchorRef.current = null;
    if (!anchor || !messagesRef.current) return;
    const row = [...messagesRef.current.querySelectorAll<HTMLElement>('[data-message-id]')]
      .find(el => el.dataset.messageId === anchor.id);
    if (row) messagesRef.current.scrollTop += row.getBoundingClientRect().top - anchor.top;
  }, [messages]);

  useEffect(() => {
    const root = messagesRef.current;
    const sentinel = historySentinelRef.current;
    if (!root || !sentinel || !vaultId || !hasOlderHistory || loadingHistory || historyError || isLoadingMessages) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void loadOlderHistory();
    }, { root, rootMargin: '160px 0px 0px 0px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [vaultId, channelId, hasOlderHistory, loadingHistory, historyError, isLoadingMessages, loadOlderHistory]);

  // Grouping identity cache removed: transcript segments are recomputed with
  // message-ref equality via sortedMessages + segmentTranscript.
  // Lazily hydrate messages whose data-URL images the list payload stripped.
  // Track only in-flight work, not "ever hydrated": a reconnect can replace a
  // full message with another slim copy and must be allowed to hydrate it again.
  const hydratingImageIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!vaultId || !onHydrateMessage) return;
    for (const message of sortedMessages) {
      if (!message.hasImages || message.images?.length || hydratingImageIdsRef.current.has(message.id)) continue;
      // A dispatch shell exists before its run is accepted and therefore has no
      // persisted message to hydrate. Waiting for the server-owned replacement
      // avoids a noisy 404 when an offline desktop rejects the dispatch.
      if (message.id.startsWith('agent-dispatch-')) continue;
      hydratingImageIdsRef.current.add(message.id);
      void api<{ message: ChatMessage }>(
        `/api/vaults/${vaultId}/channels/${message.channelId}/messages/${encodeURIComponent(message.id)}`,
      )
        .then((data) => { if (data.message) onHydrateMessage(data.message); })
        .catch(() => {})
        .finally(() => { hydratingImageIdsRef.current.delete(message.id); });
    }
  }, [sortedMessages, vaultId, onHydrateMessage]);

  const runningMessageState = useMemo(() => {
    return getRunningMessageState(sortedMessages);
  }, [sortedMessages]);
  const steeringPromptLabels = useMemo(() => {
    return getSteeringPromptLabels(sortedMessages, registeredAgents, runningMessageState);
  }, [registeredAgents, runningMessageState, sortedMessages]);
  const registeredAgentRows = useMemo(() => registeredAgents.map((registration) => {
    const agent = availableAgents.find((option) => option.id === registration.agentId);
    return agent ? { ...agent, registration } : null;
  }).filter((agent): agent is ChatAgentOption & { registration: ChatAgentRegistration } => Boolean(agent)), [availableAgents, registeredAgents]);
  const agentAuthors = useMemo(() => new Set(
    registeredAgentRows.flatMap((agent) => [agent.label, agent.registration.displayName].filter(Boolean)),
  ), [registeredAgentRows]);
  // Collapse multi-agent chatter into TUI-style work traces between human turns.
  const transcriptSegments = useMemo(
    () => segmentTranscript(sortedMessages, { agentAuthors }),
    [agentAuthors, sortedMessages],
  );
  const registrationById = useMemo(() => {
    const byId = new Map<string, ChatAgentRegistration>();
    const byAgentOrName = new Map<string, ChatAgentRegistration>();
    for (const agent of registeredAgents) {
      byId.set(agent.id, agent);
      if (agent.agentId) byAgentOrName.set(agent.agentId, agent);
      if (agent.displayName) byAgentOrName.set(agent.displayName, agent);
    }
    return { byId, byAgentOrName };
  }, [registeredAgents]);
  const vaultAgentById = useMemo(() => {
    const map = new Map<string, VaultAgent>();
    for (const agent of vaultAgents) map.set(agent.id, agent);
    return map;
  }, [vaultAgents]);
  const canManageRegistration = useCallback((registration: ChatAgentRegistration) => {
    const identity = registration.vaultAgentId ? vaultAgentById.get(registration.vaultAgentId) : undefined;
    return Boolean(identity && identity.ownerUsername === currentUser);
  }, [currentUser, vaultAgentById]);
  const resolveMessageRegistration = (message: ChatMessage) =>
    message.registrationId
      ? registrationById.byId.get(message.registrationId)
      : registrationById.byAgentOrName.get(message.agentId ?? '') ?? registrationById.byAgentOrName.get(message.author);
  const getMessageAvatarKind = (message: ChatMessage): 'agent' | 'human' =>
    message.agentId || agentAuthors.has(message.author) ? 'agent' : 'human';
  const resolveHumanProfile = (author: string) => {
    const profiles = presence.profiles || {};
    if (profiles[author]) return profiles[author];
    // Profiles are keyed by username; some older rows used display names as author.
    return Object.values(profiles).find((profile) => profile.displayName === author);
  };
  const getMessageAvatarUrl = (message: ChatMessage) => {
    return resolveMessageRegistration(message)?.avatarUrl
      || resolveHumanProfile(message.author)?.avatarUrl
      || '';
  };
  const getMessageAuthorLabel = (message: ChatMessage) =>
    resolveMessageRegistration(message)?.displayName
      || resolveHumanProfile(message.author)?.displayName
      || message.author;
  const getMessageOwnerLabel = (message: ChatMessage) => {
    const registration = resolveMessageRegistration(message);
    const identity = registration?.vaultAgentId ? vaultAgentById.get(registration.vaultAgentId) : undefined;
    return identity?.ownerUsername || '';
  };
  const getMessagePlanUsage = (message: ChatMessage) => {
    const registration = resolveMessageRegistration(message);
    const identity = registration?.vaultAgentId ? vaultAgentById.get(registration.vaultAgentId) : undefined;
    // Runner usage is private to the assistant owner's local account. Do not
    // paint the viewer's limits onto another person's agent in a shared chat.
    if (!identity || identity.ownerUsername !== currentUser) return null;
    const agentId = message.agentId || registration?.agentId || '';
    return runnerHealth?.planUsage?.[planUsageProviderId(agentId)] || null;
  };
  const onlineUsers = useMemo(() => new Set(presence.online), [presence.online]);
  const humanMessageAuthors = useMemo(() => {
    const names = new Set<string>();
    for (const message of messages) {
      if (message.author === 'Cascade') continue;
      if (message.agentId || agentAuthors.has(message.author)) continue;
      if (message.author) names.add(message.author);
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b)).join('\n');
  }, [agentAuthors, messages]);
  const humanUsers = useMemo(() => {
    const names = new Set<string>(presence.participants);
    if (currentUser) names.add(currentUser);
    for (const name of humanMessageAuthors.split('\n')) {
      if (name) names.add(name);
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [currentUser, humanMessageAuthors, presence.participants]);
  const mentionableAliases = useMemo(() => {
    const aliases = new Set<string>();
    for (const registration of registeredAgents) {
      const mention = normalizeMention(registration.mention || registration.agentId);
      if (mention) aliases.add(mention);
    }
    for (const name of humanUsers) {
      if (name) aliases.add(name);
    }
    return Array.from(aliases);
  }, [humanUsers, registeredAgents]);
  const openSharedNote = useCallback(async (messageId: string, title: string) => {
    return await onOpenSharedNote?.(channelId, messageId, title) ?? null;
  }, [channelId, onOpenSharedNote]);

  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    // Only persist local (desktop) preference — mobile toolbar state is App-owned.
    if (!onMembersOpenChange) {
      localStorage.setItem('cascade_chat_users_collapsed', usersCollapsed ? '1' : '0');
    }
    if (usersCollapsed) {
      agentPanelRef.current?.closeChrome();
    }
  }, [usersCollapsed, onMembersOpenChange]);

  /** Suppress sticky pin for a short window after the user scrolls (RO noise). */
  const userScrollQuietUntilRef = useRef(0);
  /** Only trusted user gestures may detach sticky-bottom; layout scroll events may not. */
  const userScrollIntentUntilRef = useRef(0);

  /** Pin the scroller to the bottom now, flagging it as a programmatic scroll. */
  const scrollToBottom = useCallback(() => {
    const el = messagesRef.current;
    if (!el) return;
    // Never yank the list while the user is actively scrolling history.
    if (performance.now() < userScrollQuietUntilRef.current) return;
    if (!wasAtBottomRef.current && previousChannelIdRef.current === channelId) return;
    programmaticScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
    // Content often grows in the same frame as the pin (stream tokens, harness).
    // One follow-up rAF catches the race without a second RO cycle.
    requestAnimationFrame(() => {
      const scroller = messagesRef.current;
      if (!scroller) return;
      if (performance.now() < userScrollQuietUntilRef.current) return;
      if (!wasAtBottomRef.current && previousChannelIdRef.current === channelId) return;
      if (!isAtScrollBottom(scroller)) {
        programmaticScrollRef.current = true;
        scroller.scrollTop = scroller.scrollHeight;
      }
    });
    if (programmaticClearRef.current != null) clearTimeout(programmaticClearRef.current);
    programmaticClearRef.current = window.setTimeout(() => {
      programmaticClearRef.current = null;
      programmaticScrollRef.current = false;
    }, 120);
  }, [channelId]);

  const scrollToBottomIfSticky = useCallback(() => {
    if (!wasAtBottomRef.current) return;
    if (performance.now() < userScrollQuietUntilRef.current) return;
    if (scrollFrameRef.current != null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      if (wasAtBottomRef.current && performance.now() >= userScrollQuietUntilRef.current) {
        scrollToBottom();
      }
    });
  }, [scrollToBottom]);

  const sendMessage = useCallback((
    targetChannelId: string,
    body: string,
    media?: ChatMediaAttachment[],
    replyTo?: ChatReplyRef,
  ) => {
    const scroller = messagesRef.current;
    const shouldSnap = !scroller || shouldSnapToRecentOnSend(scroller);

    // Decide from the pre-send viewport. The optimistic message changes the
    // scroll height immediately afterward and would otherwise make a nearby
    // reader look too far away to follow their own message.
    wasAtBottomRef.current = shouldSnap;
    pendingSendFollowRef.current = shouldSnap;
    if (shouldSnap) {
      userScrollQuietUntilRef.current = 0;
      userScrollIntentUntilRef.current = 0;
    }

    onSendMessage(targetChannelId, body, media, replyTo);

    if (shouldSnap) {
      scrollToBottom();
      requestAnimationFrame(scrollToBottom);
    }
  }, [onSendMessage, scrollToBottom]);

  useLayoutEffect(() => {
    if (previousChannelIdRef.current !== channelId) {
      // New channel (or first mount): force the view to the bottom, re-pinning
      // across a few frames because markdown/images/widgets settle after paint.
      previousChannelIdRef.current = channelId;
      wasAtBottomRef.current = true;
      pendingSendFollowRef.current = false;
      userScrollQuietUntilRef.current = 0;
      scrollToBottom();
      requestAnimationFrame(scrollToBottom);
      const t1 = window.setTimeout(scrollToBottom, 60);
      const t2 = window.setTimeout(scrollToBottom, 200);
      return () => { clearTimeout(t1); clearTimeout(t2); };
    }

    const latest = sortedMessages.at(-1);
    if (pendingSendFollowRef.current && isPendingAgentRunShell(latest)) {
      // The runner card (status + Stop button) arrives after the user's row.
      // Reassert the live edge for that second commit, then ordinary sticky
      // tracking owns subsequent harness growth.
      pendingSendFollowRef.current = false;
      wasAtBottomRef.current = true;
      userScrollQuietUntilRef.current = 0;
      userScrollIntentUntilRef.current = 0;
      scrollToBottom();
      requestAnimationFrame(scrollToBottom);
      const settle = window.setTimeout(scrollToBottom, 80);
      return () => clearTimeout(settle);
    }
    scrollToBottomIfSticky();
  }, [sortedMessages, channelId, scrollToBottom, scrollToBottomIfSticky]);

  // Jump to a specific message (e.g. clicked from search). Waits until the
  // target is in this channel's list, force-mounts + highlights its group via
  // the selection state, then scrolls it to center. Auto-pin-to-bottom is
  // suppressed so the freshly-opened channel doesn't yank us back down.
  const jumpHandledRef = useRef<string | null>(null);
  const jumpTimersRef = useRef<{ raf: number; timer: number }>({ raf: 0, timer: 0 });

  // Select (which force-mounts the group out of its offscreen placeholder),
  // then centre it. Auto-pin-to-bottom is suppressed so a freshly opened
  // channel does not yank us back down.
  const runJumpToMessage = useCallback((targetId: string) => {
    setSelectedMessageId(targetId);
    setJumpHighlightMessageId(targetId);
    if (jumpHighlightTimerRef.current != null) clearTimeout(jumpHighlightTimerRef.current);
    jumpHighlightTimerRef.current = window.setTimeout(() => {
      jumpHighlightTimerRef.current = null;
      setJumpHighlightMessageId((current) => current === targetId ? null : current);
    }, 1300);
    wasAtBottomRef.current = false;
    pendingSendFollowRef.current = false;
    userScrollQuietUntilRef.current = performance.now() + 1200;
    const scrollToTarget = () => {
      const scroller = messagesRef.current;
      if (!scroller) return false;
      const selector = `[data-message-id="${(window.CSS?.escape ?? String)(targetId)}"]`;
      const el = scroller.querySelector<HTMLElement>(selector);
      if (!el) return false;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return true;
    };
    // The group may still be mounting from its offscreen placeholder; retry a
    // few frames so scrollIntoView runs against the settled layout.
    let tries = 0;
    const tick = () => {
      const done = scrollToTarget();
      tries += 1;
      if (!done || tries < 4) jumpTimersRef.current.timer = window.setTimeout(tick, 90);
    };
    cancelAnimationFrame(jumpTimersRef.current.raf);
    if (jumpTimersRef.current.timer) clearTimeout(jumpTimersRef.current.timer);
    jumpTimersRef.current.raf = requestAnimationFrame(tick);
  }, []);

  useEffect(() => () => {
    cancelAnimationFrame(jumpTimersRef.current.raf);
    if (jumpTimersRef.current.timer) clearTimeout(jumpTimersRef.current.timer);
  }, []);

  // Jump to a specific message opened from elsewhere (e.g. clicked from
  // search). Waits until the target is in this channel's list.
  useEffect(() => {
    if (!jumpToMessageId) { jumpHandledRef.current = null; return; }
    if (jumpHandledRef.current === jumpToMessageId) return;
    if (!sortedMessages.some((message) => message.id === jumpToMessageId)) return;
    jumpHandledRef.current = jumpToMessageId;
    runJumpToMessage(jumpToMessageId);
    onJumpHandled?.();
  }, [jumpToMessageId, sortedMessages, onJumpHandled, runJumpToMessage]);

  // Which reply quotes can actually scroll somewhere.
  const loadedMessageIds = useMemo(
    () => new Set(sortedMessages.map((message) => message.id)),
    [sortedMessages],
  );

  // Keep a bottom-following chat pinned when either its content grows or the
  // viewport shrinks (for example, when the reply banner mounts above the
  // composer). Watching content alone leaves the last rows below the fold.
  useEffect(() => {
    const content = messagesContentRef.current;
    const viewport = messagesRef.current;
    if ((!content && !viewport) || typeof ResizeObserver === 'undefined') return;
    let roFrame: number | null = null;
    const ro = new ResizeObserver(() => {
      // Coalesce RO storms (markdown/images/fonts) to one rAF — was a scroll jank source.
      if (roFrame != null) return;
      roFrame = requestAnimationFrame(() => {
        roFrame = null;
        scrollToBottomIfSticky();
      });
    });
    if (content) ro.observe(content);
    if (viewport) ro.observe(viewport);
    return () => {
      if (roFrame != null) cancelAnimationFrame(roFrame);
      ro.disconnect();
    };
  }, [channelId, scrollToBottomIfSticky]);

  useEffect(() => () => {
    if (scrollFrameRef.current != null) cancelAnimationFrame(scrollFrameRef.current);
    if (jumpHighlightTimerRef.current != null) clearTimeout(jumpHighlightTimerRef.current);
    if (programmaticClearRef.current != null) clearTimeout(programmaticClearRef.current);
  }, []);

  const updateBottomStickiness = useCallback(() => {
    const element = messagesRef.current;
    if (!element) return;
    // Once the reader leaves the live edge, the pin tolerance must not
    // reattach them during the first few pixels of a wheel/touch gesture.
    const atBottom = isAtScrollBottom(element, wasAtBottomRef.current ? 48 : 1);
    // Programmatic pins set scrollTop then fire scroll events. Content can also
    // grow mid-pin (agent stream / harness), leaving !atBottom without any user
    // gesture — that must NOT clear wasAtBottom or sticky follow dies for the
    // rest of the run. Only detach mid-pin when a real user intent is active.
    if (programmaticScrollRef.current) {
      if (!atBottom && performance.now() < userScrollIntentUntilRef.current) {
        programmaticScrollRef.current = false;
        wasAtBottomRef.current = false;
        userScrollQuietUntilRef.current = performance.now() + 220;
      }
      return;
    }
    // Content growth, scroll anchoring, and virtualization can emit scroll
    // events without user input. Those must not silently detach a bottom-pinned
    // desktop viewport before the agent response arrives.
    if (performance.now() >= userScrollIntentUntilRef.current) {
      if (atBottom) wasAtBottomRef.current = true;
      return;
    }
    wasAtBottomRef.current = atBottom;
    // While reading history, ignore ResizeObserver sticky pins briefly.
    if (!atBottom) {
      userScrollQuietUntilRef.current = performance.now() + 220;
    }
  }, []);

  // Native passive scroll listener — React's onScroll isn't passive and can
  // block compositor scrolling on long threads.
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    el.addEventListener('scroll', updateBottomStickiness, { passive: true });
    return () => el.removeEventListener('scroll', updateBottomStickiness);
  }, [channelId, updateBottomStickiness]);

  useEffect(() => {
    setContextMenu(null);
    setParticipantMenu(null);
  }, [channelId]);

  useEffect(() => {
    if (!lightboxSrc) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setLightboxSrc(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [lightboxSrc]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', close, true);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!participantMenu) return;
    const close = () => setParticipantMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', close, true);
    };
  }, [participantMenu]);

  const openAgentSettingsFromMessage = useCallback((message: ChatMessage, event: React.MouseEvent) => {
    event.stopPropagation();
    const registration = message.registrationId
      ? registrationById.byId.get(message.registrationId)
      : registrationById.byAgentOrName.get(message.agentId ?? '')
        ?? registrationById.byAgentOrName.get(message.author);
    if (!registration) return;
    if (!canManageRegistration(registration)) return;
    agentPanelRef.current?.openMemberSettings(registration);
  }, [canManageRegistration, registrationById]);

  const startReply = useCallback((message: ChatMessage) => {
    setContextMenu(null);
    // Focus after paint so the reply bar is mounted first (esp. mobile keyboard).
    composerRef.current?.startReply(buildReplyRef(message, registeredAgents));
  }, [registeredAgents]);

  const openMessageContextMenu = useCallback((event: React.MouseEvent, message: ChatMessage) => {
    event.preventDefault();
    event.stopPropagation();
    setDeleteArmed(false);
    setContextMenu({ x: event.clientX, y: event.clientY, message });
  }, []);

  const openParticipantContextMenu = useCallback((event: React.MouseEvent, username: string, action: 'remove' | 'leave') => {
    event.preventDefault();
    event.stopPropagation();
    setParticipantMenu({ x: event.clientX, y: event.clientY, username, action });
  }, []);

  /** Message queued for forwarding; drives the channel picker overlay. */
  const [forwardSource, setForwardSource] = useState<ChatMessage | null>(null);
  const [forwardQuery, setForwardQuery] = useState('');
  const [forwardError, setForwardError] = useState('');
  const [forwardingTo, setForwardingTo] = useState<string | null>(null);

  /** Chat channels in this vault, minus the one we are already reading. */
  const forwardTargets = useMemo(() => {
    const query = forwardQuery.trim().toLowerCase();
    return notes
      .filter((note) => note.content_preview.trim().startsWith(CHAT_NOTE_MARKER))
      .filter((note) => note.id !== channelId)
      .filter((note) => !query || note.title.toLowerCase().includes(query))
      .slice(0, 50);
  }, [notes, channelId, forwardQuery]);

  const startForward = useCallback((message: ChatMessage) => {
    setContextMenu(null);
    setForwardQuery('');
    setForwardError('');
    setForwardSource(message);
  }, []);

  const forwardTo = useCallback(async (targetChannelId: string) => {
    if (!forwardSource || !onForwardMessage) return;
    setForwardingTo(targetChannelId);
    setForwardError('');
    try {
      await onForwardMessage(forwardSource.channelId || channelId, forwardSource.id, targetChannelId);
      setForwardSource(null);
    } catch (error) {
      setForwardError(error instanceof Error ? error.message : 'Could not forward message');
    } finally {
      setForwardingTo(null);
    }
  }, [forwardSource, onForwardMessage, channelId]);

  const deleteMessage = useCallback((message: ChatMessage) => {
    setContextMenu(null);
    setDeleteArmed(false);
    void onDeleteMessage?.(message.channelId || channelId, message.id);
  }, [onDeleteMessage, channelId]);

  const toggleMessageSelection = useCallback((id: string) => {
    setSelectedMessageId((current) => (current === id ? null : id));
  }, []);

  const openLightbox = useCallback((src: string) => setLightboxSrc(src), []);

  return (
    <section className={`chat-view${sidebarMode === 'only' ? ' is-sidebar-only' : ''}${sidebarMode === 'hidden' ? ' is-sidebar-hidden' : ''}${directMessage ? ' is-direct-message' : ''}`}>
      {sidebarMode !== 'only' && <div className="chat-main">
        <header className="chat-header">
          <div className="chat-header-copy">
            <h2>{channelName}</h2>
            <span>{sortedMessages.filter(message => !isLiveAgentStatus(message.status)).length} messages loaded</span>
          </div>
          {vaultId && !directMessage && (
            <button
              type="button"
              className="chat-mission-archive-button"
              title="Mission history"
              aria-label="Open mission history"
              onClick={() => {
                setMissionArchiveOpen(true);
                void loadMissionArchive();
              }}
            >
              <History size={15} />
              <span>Missions</span>
            </button>
          )}
        </header>

        <div
          ref={messagesRef}
          className="chat-messages"
          role="log"
          aria-label={`${channelName} messages`}
          onTouchStart={(event) => {
            touchStartYRef.current = event.touches[0]?.clientY ?? null;
          }}
          onTouchMove={(event) => {
            const startY = touchStartYRef.current;
            const currentY = event.touches[0]?.clientY;
            // Only a finger moving down means "read older messages". A touch
            // at the bottom or an upward swipe must not disarm sticky-follow
            // just before a new agent row changes the layout.
            if (shouldDetachStickyForTouch(startY, currentY)) {
              wasAtBottomRef.current = false;
              userScrollQuietUntilRef.current = performance.now() + 220;
              pendingSendFollowRef.current = false;
              programmaticScrollRef.current = false;
              userScrollIntentUntilRef.current = performance.now() + 500;
            }
          }}
          onTouchEnd={() => { touchStartYRef.current = null; }}
          onWheel={(event) => {
            // Scrolling upward is the only wheel gesture that intentionally
            // detaches from the live edge. Downward wheel noise at the bottom
            // previously caused intermittent missed agent auto-scrolls.
            if (shouldDetachStickyForWheel(event.deltaY)) {
              wasAtBottomRef.current = false;
              userScrollQuietUntilRef.current = performance.now() + 220;
              pendingSendFollowRef.current = false;
              programmaticScrollRef.current = false;
              userScrollIntentUntilRef.current = performance.now() + 180;
            }
          }}
        >
          <div ref={messagesContentRef} className="chat-messages-content">
          {vaultId && <div ref={historySentinelRef} className="chat-history-sentinel">
            {hasOlderHistory ? <button type="button" disabled={loadingHistory || isLoadingMessages}
              onClick={() => void loadOlderHistory()}>{loadingHistory ? 'Loading older messages…' : historyError ? 'Retry older messages' : 'Load older messages'}</button>
              : <span>Beginning of conversation</span>}
            {historyError && <span role="alert">{historyError}</span>}
          </div>}
          {/* Never blank an already-loaded transcript for a background refresh. */}
          {isLoadingMessages && sortedMessages.length === 0 ? (
            <div className="chat-empty" aria-live="polite">
              <span className="chat-loading-dot" aria-hidden="true" />
              <strong>Loading messages…</strong>
            </div>
          ) : sortedMessages.length === 0 ? (
            <div className="chat-empty">
              {directMessage
                ? <MessageCircle size={28} className="chat-empty-icon" />
                : <Hash size={28} className="chat-empty-icon" />}
              <strong>{directMessage ? channelName : `#${channelName}`}</strong>
              <span className="chat-empty-hint">
                {directMessage ? 'No messages yet — say hello.' : 'No messages yet — say hello or @mention an agent to start.'}
              </span>
            </div>
          ) : (
            transcriptSegments.flatMap((segment) => {
              const renderGroupRow = (group: ChatMessageGroup) => {
                const head = group.messages[0];
                const groupSelected = selectedMessageId != null
                  && group.messages.some((message) => message.id === selectedMessageId);
                const groupJumpHighlighted = jumpHighlightMessageId != null
                  && group.messages.some((message) => message.id === jumpHighlightMessageId);
                const runKey = head.registrationId || head.agentId || '';
                const runState = runKey ? runningMessageState.get(runKey) : undefined;
                return (
                  <ChatGroupRow
                    key={head.id}
                    group={group}
                    selectedMessageId={groupSelected ? selectedMessageId : null}
                    jumpHighlightMessageId={groupJumpHighlighted ? jumpHighlightMessageId : null}
                    avatarKind={getMessageAvatarKind(head)}
                    avatarUrl={getMessageAvatarUrl(head)}
                    authorLabel={getMessageAuthorLabel(head)}
                    ownerLabel={getMessageOwnerLabel(head)}
                    planUsage={getMessagePlanUsage(head)}
                    latestRunningMessageId={runState?.latestId}
                    runningSiblingCount={runState?.count || 0}
                    steeringPromptLabels={steeringPromptLabels}
                    mentionableAliases={mentionableAliases}
                    notes={notes}
                    onOpenNote={onOpenNote}
                    onOpenSharedNote={openSharedNote}
                    onCancelRun={onCancelRun}
                    onToggleSelect={toggleMessageSelection}
                    onContextMenu={openMessageContextMenu}
                    onReply={startReply}
                    onJumpToMessage={runJumpToMessage}
                    loadedMessageIds={loadedMessageIds}
                    onLightbox={openLightbox}
                    onImageLoad={scrollToBottomIfSticky}
                    onAgentAvatarClick={
                      resolveMessageRegistration(head)
                        ? (event) => openAgentSettingsFromMessage(head, event)
                        : undefined
                    }
                    scrollRootRef={messagesRef}
                    vaultId={vaultId}
                    onHydrateMessage={onHydrateMessage}
                    contextMenuMessage={group.messages.find((message) => Boolean(message.mission))}
                  />
                );
              };
              if (segment.kind === 'work') {
                // A trace is always nested in an agent row. System notices
                // that start a run are attributed when persisted; older
                // unowned notices deliberately stay out of the transcript
                // instead of looking like progress on the human message.
                // Anchor a completed mission clump to its user-facing update,
                // not to an empty worker shell that happened to start the run.
                // This keeps the mission, mixed-agent trace, and outcome under
                // one coordinator header while preserving each trace author.
                const updateHost = segment.updateGroups.at(-1)?.messages.at(-1);
                const host = updateHost
                  || segment.carrier
                  || segment.trace.find((message) => message.registrationId || message.agentId);
                if (!host) return [];
                // A real carrier is persisted for system-only work. Existing
                // agent traces use the same empty shell shape at render time.
                const carrier = updateHost || !segment.carrier ? {
                  ...host,
                  id: `agent-trace-${segment.id}`,
                  body: '',
                  status: undefined,
                } : segment.carrier;
                const traceSelected = selectedMessageId != null
                  && segment.trace.some((message) => message.id === selectedMessageId);
                const traceJumpHighlighted = jumpHighlightMessageId != null
                  && segment.trace.some((message) => message.id === jumpHighlightMessageId);
                const missionArtifacts = [
                  ...(carrier.mission ? [carrier] : []),
                  ...segment.fullGroups
                  .flatMap((group) => group.messages)
                  .filter((message) => Boolean(message.mission)),
                ];
                const displayCarrier = carrier.mission ? { ...carrier, mission: undefined } : carrier;
                const carrierKey = displayCarrier.registrationId || displayCarrier.agentId || displayCarrier.author;
                const clumpedUpdateMessages: ChatMessage[] = [];
                const separateUpdateGroups: ChatMessageGroup[] = [];
                for (const group of segment.updateGroups) {
                  const head = group.messages[0];
                  const headKey = head.registrationId || head.agentId || head.author;
                  if (headKey === carrierKey) clumpedUpdateMessages.push(...group.messages);
                  else separateUpdateGroups.push(group);
                }
                const clumpedSelected = selectedMessageId != null
                  && clumpedUpdateMessages.some((message) => message.id === selectedMessageId);
                const missionHasTrace = missionArtifacts.length > 0 && segment.trace.length > 0;
                const workTrace = (
                  <ChatWorkTrace
                    trace={segment.trace}
                    selectedMessageId={traceSelected || clumpedSelected ? selectedMessageId : null}
                    onCancelRun={onCancelRun}
                    onContextMenu={openMessageContextMenu}
                    onReply={startReply}
                    vaultId={vaultId}
                    onHydrateMessage={onHydrateMessage}
                    runningMessageState={runningMessageState}
                    embedded={missionHasTrace}
                  />
                );
                const peek = workTracePeek(segment.trace);
                const unifiedMission = missionArtifacts.length > 0
                  ? missionArtifacts.map((message) => (
                    <ChatMissionCard
                      key={message.id}
                      mission={message.mission!}
                      vaultId={vaultId}
                      channelId={message.channelId}
                      traceContent={workTrace}
                      tracePeek={peek}
                      replyMessage={message}
                      onReply={startReply}
                      onContextMenu={openMessageContextMenu}
                    />
                  ))
                  : workTrace;
                const nodes: ReactNode[] = [
                  <ChatGroupRow
                    key={`work-${segment.id}`}
                    group={{ messages: [displayCarrier, ...clumpedUpdateMessages] }}
                    selectedMessageId={traceSelected ? selectedMessageId : null}
                    jumpHighlightMessageId={traceJumpHighlighted ? jumpHighlightMessageId : null}
                    avatarKind="agent"
                    avatarUrl={getMessageAvatarUrl(displayCarrier)}
                    authorLabel={getMessageAuthorLabel(displayCarrier)}
                    ownerLabel={getMessageOwnerLabel(displayCarrier)}
                    planUsage={getMessagePlanUsage(displayCarrier)}
                    latestRunningMessageId={undefined}
                    runningSiblingCount={0}
                    steeringPromptLabels={steeringPromptLabels}
                    mentionableAliases={mentionableAliases}
                    notes={notes}
                    onOpenNote={onOpenNote}
                    onOpenSharedNote={openSharedNote}
                    onCancelRun={onCancelRun}
                    onToggleSelect={toggleMessageSelection}
                    onContextMenu={openMessageContextMenu}
                    onReply={startReply}
                    onJumpToMessage={runJumpToMessage}
                    loadedMessageIds={loadedMessageIds}
                    onLightbox={openLightbox}
                    onImageLoad={scrollToBottomIfSticky}
                    onAgentAvatarClick={
                      resolveMessageRegistration(displayCarrier)
                        ? (event) => openAgentSettingsFromMessage(displayCarrier, event)
                        : undefined
                    }
                    scrollRootRef={messagesRef}
                    vaultId={vaultId}
                    onHydrateMessage={onHydrateMessage}
                    traceContent={unifiedMission}
                    traceAfterFirstMessage={clumpedUpdateMessages.length > 0}
                    contextMenuMessage={missionArtifacts[0]}
                  />,
                ];
                for (const group of segment.fullGroups) {
                  const messagesWithoutMissions = group.messages.filter((message) => !message.mission);
                  if (messagesWithoutMissions.length) nodes.push(renderGroupRow({ messages: messagesWithoutMissions }));
                }
                for (const group of separateUpdateGroups) nodes.push(renderGroupRow(group));
                return nodes;
              }

              return renderGroupRow(segment.group);
            })
          )}
          <div ref={endRef} className="chat-messages-end" aria-hidden="true" />
          </div>
        </div>

        <ChatComposer
          ref={composerRef}
          channelId={channelId}
          channelName={channelName}
          directMessage={directMessage}
          notes={notes}
          mentionableAliases={mentionableAliases}
          registeredAgents={registeredAgents}
          onSendMessage={sendMessage}
        />
      </div>}

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="chat-context-menu"
          role="menu"
          aria-label="Message options"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(event) => event.stopPropagation()}
        >
          <button type="button" role="menuitem" onClick={() => startReply(contextMenu.message)}>
            <Reply size={14} />
            Reply
          </button>
          {onForwardMessage && (
            <button type="button" role="menuitem" onClick={() => startForward(contextMenu.message)}>
              <Forward size={14} />
              Forward
            </button>
          )}
          {vaultId && !directMessage && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const message = contextMenu.message;
                setContextMenu(null);
                void createChannelWorkItem(vaultId, {
                  title: (message.body || 'Work item').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Work item',
                  brief: message.body || '',
                  channelId,
                  sourceKind: 'message',
                  sourceId: message.id,
                  repository: channelCwd || '',
                  workspaceMode: channelCwd ? 'isolated' : 'shared',
                }).catch(() => {
                  /* settings panel shows work items on next open */
                });
              }}
            >
              <ClipboardList size={14} />
              Add to kanban
            </button>
          )}
          {vaultId && !directMessage && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setReportMessage(contextMenu.message);
                setContextMenu(null);
              }}
            >
              <Flag size={14} />
              Report
            </button>
          )}
          {onDeleteMessage && (
            <>
              <div className="menu-divider" role="separator" />
              <button
                type="button"
                role="menuitem"
                className={`is-danger${deleteArmed ? ' is-armed' : ''}`}
                onClick={() => (deleteArmed ? deleteMessage(contextMenu.message) : setDeleteArmed(true))}
              >
                <Trash2 size={14} />
                {deleteArmed ? 'Delete for everyone?' : 'Delete'}
              </button>
            </>
          )}
        </div>
      )}

      {participantMenu && (
        <div
          ref={participantMenuRef}
          className="chat-context-menu"
          role="menu"
          aria-label="Participant options"
          style={{ top: participantMenu.y, left: participantMenu.x }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            className="is-danger"
            onClick={() => {
              const { action, username } = participantMenu;
              setParticipantMenu(null);
              if (action === 'remove') void onRemoveParticipant?.(channelId, username);
              else void onLeaveChannel?.(channelId);
            }}
          >
            {participantMenu.action === 'remove' ? <Trash2 size={14} /> : <X size={14} />}
            {participantMenu.action === 'remove' ? `Remove @${participantMenu.username} from channel` : 'Leave vault'}
          </button>
        </div>
      )}

      {sidebarMode !== 'hidden' && <aside
        className={`chat-users${usersCollapsed ? ' is-collapsed' : ''}`}
        aria-label="Chat users"
      >
        <ChatSidebarButtons
          collapsed={usersCollapsed}
          inviteSelected={agentChrome.inviteOpen}
          agentSelected={agentChrome.agentMenuOpen}
          settingsSelected={channelSettingsOpen}
          onToggleCollapsed={() => setUsersCollapsed((value) => !value)}
          onInvite={() => agentPanelRef.current?.toggleInvite()}
          onAgent={() => agentPanelRef.current?.openMenu()}
          onSettings={() => {
            setUsersCollapsed(false);
            setChannelSettingsOpen((open) => !open);
          }}
        />

        {!usersCollapsed && channelSettingsOpen && (
          <ChatChannelSettings
            channelId={channelId}
            channelName={channelName}
            vaultId={vaultId}
            notes={notes}
            onOpenNote={onOpenNote}
            onCwdChange={setChannelCwd}
            onClose={() => setChannelSettingsOpen(false)}
          />
        )}


        {!usersCollapsed && (
          <>
        <ChatAgentPanel
          ref={agentPanelRef}
          channelId={channelId}
          currentUser={currentUser}
          availableAgents={availableAgents}
          registeredAgents={registeredAgents}
          registeredAgentRows={registeredAgentRows}
          vaultAgents={vaultAgents}
          runnerHealth={runnerHealth}
          onRegisterAgent={onRegisterAgent}
          onRemoveAgent={onRemoveAgent}
          onUpsertVaultAgent={onUpsertVaultAgent}
          onDeleteVaultAgent={onDeleteVaultAgent}
          onDeleteAgentProfile={onDeleteAgentProfile}
          onAddVaultAgentToChannel={onAddVaultAgentToChannel}
          onInviteUser={onInviteUser}
          canManageRegistration={canManageRegistration}
          onExpandRail={() => {
            setUsersCollapsed(false);
            setChannelSettingsOpen(false);
          }}
          onChromeChange={onAgentChromeChange}
        >
        <div className="chat-users-title">People in this vault</div>
        {humanUsers.map((name) => {
          const isSelf = name === currentUser;
          const isOnline = isSelf || onlineUsers.has(name);
          const isOwner = name === presence.owner;
          const roleLabel = isOwner ? 'owner' : isSelf ? 'you' : isOnline ? 'online' : 'offline';
          const participantAction = presence.owner === currentUser && !isSelf && onRemoveParticipant
            ? 'remove'
            : isSelf && !isOwner && onLeaveChannel
              ? 'leave'
              : null;
          return (
          <div
            className={`chat-user chat-human${isOnline ? '' : ' is-offline'}${isSelf ? ' is-self' : ''}`}
            key={name}
            onContextMenu={participantAction
              ? (event) => openParticipantContextMenu(event, name, participantAction)
              : undefined}
          >
            <div className="chat-user-row">
              <ChatAvatar name={presence.profiles?.[name]?.displayName || name} kind="human" avatarUrl={presence.profiles?.[name]?.avatarUrl} size="sm" />
              <div className="chat-user-copy">
                <strong>{presence.profiles?.[name]?.displayName || name}</strong>
                {presence.profiles?.[name]?.displayName && presence.profiles?.[name]?.displayName !== name && <span className="chat-user-handle">@{name}</span>}
                <span className="chat-user-role">{roleLabel}</span>
              </div>
            </div>
          </div>
          );
        })}
        </ChatAgentPanel>
          </>
        )}
      </aside>}

      {missionArchiveOpen && (
        <div
          className="chat-mission-archive-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="chat-mission-archive-title"
          onClick={() => setMissionArchiveOpen(false)}
        >
          <section className="chat-mission-archive" onClick={(event) => event.stopPropagation()}>
            <header>
              <div>
                <strong id="chat-mission-archive-title">Mission history</strong>
                <span>Durable work in #{channelName}</span>
              </div>
              <div>
                <button type="button" disabled={missionArchiveBusy} onClick={() => void loadMissionArchive()}>
                  Refresh
                </button>
                <button type="button" title="Close" aria-label="Close mission history" onClick={() => setMissionArchiveOpen(false)}>
                  <X size={16} />
                </button>
              </div>
            </header>
            <div className="chat-mission-archive-list">
              {missionArchiveBusy && missionArchive.length === 0 && <div className="chat-mission-archive-empty">Loading missions…</div>}
              {missionArchiveError && <div className="chat-mission-archive-empty is-error">{missionArchiveError}</div>}
              {!missionArchiveBusy && !missionArchiveError && missionArchive.length === 0 && (
                <div className="chat-mission-archive-empty">No missions in this channel yet.</div>
              )}
              {missionArchive.map((mission) => (
                <ChatMissionCard key={mission.id} mission={mission} vaultId={vaultId} channelId={channelId} />
              ))}
            </div>
          </section>
        </div>
      )}

      {forwardSource && (
        <div
          className="chat-forward-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Forward message"
          onClick={() => setForwardSource(null)}
        >
          <div className="chat-forward-panel" onClick={(event) => event.stopPropagation()}>
            <div className="chat-forward-head">
              <strong>Forward message</strong>
              <button type="button" title="Cancel" onClick={() => setForwardSource(null)}>
                <X size={14} />
              </button>
            </div>
            <div className="chat-forward-preview">
              <strong>{forwardSource.author}</strong>
              <span>{buildReplyPreview(forwardSource)}</span>
            </div>
            <input
              className="chat-forward-search"
              value={forwardQuery}
              autoFocus
              placeholder="Search channels…"
              onChange={(event) => setForwardQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setForwardSource(null);
                if (event.key === 'Enter' && forwardTargets[0]) void forwardTo(forwardTargets[0].id);
              }}
            />
            <div className="chat-forward-list">
              {forwardTargets.length === 0 && (
                <div className="chat-forward-empty">No other channels</div>
              )}
              {forwardTargets.map((target) => (
                <button
                  key={target.id}
                  type="button"
                  className="chat-forward-target"
                  disabled={forwardingTo !== null}
                  onClick={() => void forwardTo(target.id)}
                >
                  <Hash size={13} />
                  <span>{target.title}</span>
                  {forwardingTo === target.id && <em>sending…</em>}
                </button>
              ))}
            </div>
            {forwardError && <div className="chat-forward-error">{forwardError}</div>}
          </div>
        </div>
      )}

      {lightboxSrc && (
        <div
          className="chat-lightbox"
          role="dialog"
          aria-modal="true"
          onClick={() => setLightboxSrc(null)}
        >
          <button
            type="button"
            className="chat-lightbox-close"
            title="Close"
            onClick={() => setLightboxSrc(null)}
          >
            <X size={20} />
          </button>
          <img
            src={lightboxSrc}
            alt=""
            className="chat-lightbox-image"
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      )}
      {reportMessage && vaultId && (
        <ReportDialog
          vaultId={vaultId}
          targetType="message"
          targetId={reportMessage.id}
          title={`message from ${reportMessage.author}`}
          onClose={() => setReportMessage(null)}
        />
      )}
    </section>
  );
});
