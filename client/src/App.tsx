import { WorkspaceStore } from './workspace';
import { findEmbeddedNote } from './docEmbeds';
import { useEffect, useSyncExternalStore, useState, useCallback, useRef, useMemo, lazy, Suspense, type CSSProperties, type ReactNode } from 'react';
import { Sidebar } from './components/Sidebar';
import { type Tab } from './components/TabBar';
import {
  acquireInteractionLock,
  bindDragGesture,
  installInteractionLockRecovery,
  releaseInteractionLock,
} from './ui/interactionLocks';

// CodeMirror (editor core plus every language mode via @codemirror/language-data)
// is the heaviest dependency in the app and is only needed once a note tab is
// actually open — keep it out of the initial chunk.
// Keep run controls available when a deploy replaces unloaded menu chunks.
import { SessionManager } from './components/SessionManager';
const NoteEditor = lazy(() =>
  import('./components/NoteEditor').then((m) => ({ default: m.NoteEditor })),
);
const ChatView = lazy(() =>
  import('./components/ChatView').then((m) => ({ default: m.ChatView })),
);
const SearchOverlay = lazy(() =>
  import('./components/SearchOverlay').then((m) => ({ default: m.SearchOverlay })),
);
const CommandPalette = lazy(() =>
  import('./components/CommandPalette').then((m) => ({ default: m.CommandPalette })),
);
const AdminPanel = lazy(() =>
  import('./components/AdminPanel').then((m) => ({ default: m.AdminPanel })),
);
const SuperkanbanView = lazy(() =>
  import('./components/SuperkanbanView').then((m) => ({ default: m.SuperkanbanView })),
);
const AccountSettings = lazy(() =>
  import('./components/AccountSettings').then((m) => ({ default: m.AccountSettings })),
);
const DiscoveryDmsModal = lazy(() =>
  import('./components/DiscoveryDmsModal').then((m) => ({ default: m.DiscoveryDmsModal })),
);
const UpdatesModal = lazy(() =>
  import('./components/UpdatesModal').then((m) => ({ default: m.UpdatesModal })),
);
const AndroidUpdatePrompt = lazy(() =>
  import('./components/AndroidUpdatePrompt').then((m) => ({ default: m.AndroidUpdatePrompt })),
);
const OrbitGraph = lazy(() =>
  import('./components/OrbitGraph').then((m) => ({ default: m.OrbitGraph })),
);
const DocumentationAssistant = lazy(() =>
  import('./components/DocumentationAssistant').then((m) => ({ default: m.DocumentationAssistant })),
);
import type {
  ChatAgentRegistration,
  ChatChannelPresence,
  ChatMessage,
  DesktopRunnerHealth,
  SharedChatNote,
  VaultAgent,
} from './chat/types';
import { vaultAgentMembershipPayload } from './chat/agents';
import {
  CHAT_NOTE_MARKER,
  createChatAgentRegistrationId,
  applyLocalUserProfile,
  mergeChatPresence,
} from './chat/shared';
import { useChatDispatch } from './chat/dispatch';
import { NewsTicker } from './components/NewsTicker';
import { ModalShell } from './components/ModalShell';
import { PaneGrid, type TabDragPayload } from './components/PaneGrid';
import type { WorkItem } from './chat/workItems';
import type { DiscoveryTab } from './components/DiscoveryDmsModal';
import { ErrorBoundary } from './components/ErrorBoundary';
import * as Layout from './layout/tree';
import type { LayoutNode } from './layout/tree';
import { api, ApiError, type CommunityUpdateItem, type CommunityUpdates, type User, type Vault, type Folder, type NoteSummary, type Note } from './api';
import { connectVaultSocket } from './socket';
import { ensureDesktopRunnerHost, startDesktopRunnerHost, stopDesktopRunnerHost } from './desktopRunnerHost';
import {
  agentsAfterLoadFailure,
  agentLabel,
  CHAT_AGENT_MODEL_PRESETS,
  CHAT_AGENTS,
  normalizeChatCwd,
  type AgentId,
} from './chat/agents';
import { normalizeMention } from './chat/mentions';
import {
  applyRemoteChatMessage,
  captureChatMessageSnapshotBaseline,
  newId,
  reconcileChatMessageSnapshot,
  type ChatMessageSnapshotBaseline,
} from './chat/runBlocks';
import {
  CHAT_STORAGE_KEY,
  loadChatState,
  loadPersistedSession,
  readLegacyLocalChatMessages,
  SESSION_STORAGE_KEY,
  workspaceSession,
  type ChatState,
  type PersistedSession,
} from './chat/session';
import { chatMessageStore, fetchChatMessageSnapshot, useAgentActivity } from './chat/messageStore';
import { Activity, Bell, Download, PanelLeftOpen, Sparkles, Users } from 'lucide-react';
import { FizzerMark } from './components/FizzerMark';

/**
 * @file App.tsx — Root component for Cascade
 *
 * Orchestrates application state and the tiling workspace. `openTabs` is the
 * global registry of tab content (notes and chat channels); a recursive
 * {@link LayoutNode} tree (see `layout/tree.ts`) describes how those tabs are
 * arranged into draggable, resizable panes. Note bodies are held per-tab in
 * `noteContents` so any number of note panes can be edited independently.
 *
 * Pure chat helpers live under `./chat/*` (session, agents, mentions, run blocks).
 * Chat mutations live in `useChatDispatch`; the server schedules agent runs.
 *
 * @component
 */

function isMobileViewport(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches;
}

// Share transcript fetches across rapid remounts.
const loadChatMessagesInflight = new Map<string, Promise<{
  channelId: string;
  messages: ChatMessage[];
  baseline: ChatMessageSnapshotBaseline;
}>>();

/** Stable empty so ChatView memo doesn't bust when a channel has no agents yet. */
const EMPTY_CHAT_AGENTS: ChatAgentRegistration[] = [];
const EMPTY_CHAT_PRESENCE: ChatChannelPresence = { participants: [], online: [], owner: '', profiles: {} };
const AVAILABLE_CHAT_AGENTS = CHAT_AGENTS.map((agent) => ({
  ...agent,
  models: CHAT_AGENT_MODEL_PRESETS[agent.id],
}));
const EMPTY_COMMUNITY_UPDATES: CommunityUpdates = {
  groups: [],
  counts: { total: 0, directMessages: 0, byVault: {}, byTarget: {} },
  truncated: false,
};

export default function App() {
  // ═══════════════════════════════════════════════════════════════
  // STATE
  // ═══════════════════════════════════════════════════════════════

  const persistedSessionRef = useRef<PersistedSession>(loadPersistedSession());

  // Auth state. `user` starts null, so we must not treat "not yet checked"
  // as logged out or the desktop shell flashes the login form on every boot.
  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [documentationAssistantOpen, setDocumentationAssistantOpen] = useState(false);
  const [accountInitialSection, setAccountInitialSection] = useState<'profile' | 'vault'>('profile');
  const [discoveryDmsOpen, setDiscoveryDmsOpen] = useState<DiscoveryTab | null>(null);
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const [orbitOpen, setOrbitOpen] = useState(false);
  const [authEpoch, setAuthEpoch] = useState(0);
  const [authMode, setAuthMode] = useState<'login' | 'register' | 'reset'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [authError, setAuthError] = useState('');
  const [authNotice, setAuthNotice] = useState('');

  // App data state
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [workspaceStore] = useState(() => new WorkspaceStore(persistedSessionRef.current));
  const [loadVaultDataInflight] = useState(() => new Map<string, Promise<void>>());
  const workspaceRevision = useSyncExternalStore(workspaceStore.subscribe, workspaceStore.getSnapshot);
  const activeVaultId = workspaceStore.activeVaultId;
  const initialVaultListing = persistedSessionRef.current.activeVaultId
    ? persistedSessionRef.current.vaultListingsByVault[persistedSessionRef.current.activeVaultId]
    : undefined;
  const [folders, setFolders] = useState<Folder[]>(initialVaultListing?.folders ?? []);
  const [notes, setNotes] = useState<NoteSummary[]>(initialVaultListing?.notes ?? []);
  const [chatState, setChatState] = useState<ChatState>(loadChatState);
  const [loadingChatChannels, setLoadingChatChannels] = useState<Record<string, boolean>>({});
  const [chatPresenceByChannel, setChatPresenceByChannel] = useState<Record<string, ChatChannelPresence>>({});
  const [channelVaultIds, setChannelVaultIds] = useState<Record<string, string>>({});
  const [communityUpdates, setCommunityUpdates] = useState<CommunityUpdates>(EMPTY_COMMUNITY_UPDATES);
  const [communityUpdatesLoading, setCommunityUpdatesLoading] = useState(false);
  const [communityUpdatesError, setCommunityUpdatesError] = useState('');
  const [showAgentMemory, setShowAgentMemory] = useState(() => localStorage.getItem('cascade_show_agent_memory') === '1');
  const agentActivity = useAgentActivity();

  const { openTabs, layout, focusedPaneId, noteContents } = workspaceStore.active;
  const setOpenTabs = useCallback((value: React.SetStateAction<Tab[]>) => workspaceStore.set('openTabs', value), [workspaceStore]);
  const setLayout = useCallback((value: React.SetStateAction<LayoutNode>) => workspaceStore.set('layout', value), [workspaceStore]);
  const setFocusedPaneId = useCallback((value: string) => workspaceStore.set('focusedPaneId', value), [workspaceStore]);
  const setNoteContents = useCallback((value: React.SetStateAction<typeof noteContents>) => workspaceStore.set('noteContents', value), [workspaceStore]);
  const [superkanbanNotes, setSuperkanbanNotes] = useState<Note[]>([]);
  const [superkanbanLiveWork, setSuperkanbanLiveWork] = useState<WorkItem[]>([]);
  const [superkanbanLoading, setSuperkanbanLoading] = useState(false);
  const [superkanbanError, setSuperkanbanError] = useState<string | null>(null);

  // UI panels state
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const railWidth = Number(localStorage.getItem('cascade_sidebar_w_vault_rail'));
    if (railWidth) return railWidth;
    const legacyWidth = Number(localStorage.getItem('cascade_sidebar_w')) || 268;
    return Math.min(540, legacyWidth + 58);
  });
  const [isResizing, setIsResizing] = useState(false);
  const mobileSidebarSwipeRef = useRef<{ x: number; y: number; at: number; pointerId: number } | null>(null);
  // Members panel open. Mobile starts closed (toolbar opens it like the folder
  // sidebar); desktop restores the previous expanded/collapsed rail preference.
  const [chatMembersOpen, setChatMembersOpen] = useState(() => {
    if (isMobileViewport()) {
      return false;
    }
    if (typeof localStorage !== 'undefined') {
      return localStorage.getItem('cascade_chat_users_collapsed') !== '1';
    }
    return true;
  });

  const [searchOpen, setSearchOpen] = useState(false);
  // Pending "jump to this chat message" target set when a chat search result is
  // opened; consumed by the matching ChatView, which scrolls to and highlights it.
  const [chatJumpTarget, setChatJumpTarget] = useState<{ channelId: string; messageId: string } | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [runnerHealth, setRunnerHealth] = useState<DesktopRunnerHealth | null>(null);
  const [sessionManagerOpen, setSessionManagerOpen] = useState(false);
  const [focusSessionId, setFocusSessionId] = useState<string | null>(null);
  const [vaultAgents, setVaultAgents] = useState<VaultAgent[]>([]);
  // ─── Derived focus state ────────────────────────────────────────
  const focusedPane = Layout.findPane(layout, focusedPaneId) ?? Layout.getFirstPane(layout);
  const activeTabId = focusedPane.activeTabId;
  const focusedTab = openTabs.find((tab) => tab.id === activeTabId) ?? null;
  const focusedIsChat = focusedTab?.type === 'chat';
  const vaultSidebarChannel = focusedIsChat
    ? focusedTab.id
    : notes.find((note) => note.content_preview.trim().startsWith(CHAT_NOTE_MARKER))?.id;
  const currentUsername = user?.username ?? '';
  // Refs mirror the latest state so event handlers stay stable (no dep churn)
  // and never read a stale closure during drags / async work.
  const activeVaultIdRef = useMemo(() => ({ get current() { return workspaceStore.activeVaultId; } }), [workspaceStore]);
  const notesRef = useRef(notes); notesRef.current = notes;
  const chatStateRef = useRef(chatState); chatStateRef.current = chatState;
  const vaultSocketRef = useRef<ReturnType<typeof connectVaultSocket> | null>(null);
  const joinedChatChannelsRef = useRef<Set<string>>(new Set());
  const acceptedInviteTokenRef = useRef<string | null>(null);
  // Debounce socket-driven soft vault reloads (note create/change/delete bursts).
  const socketVaultReloadTimerRef = useRef<number | null>(null);
  const communityRefreshTimerRef = useRef<number | null>(null);
  const vaultListingsRef = useRef({ ...persistedSessionRef.current.vaultListingsByVault });
  const chatSnapshotControllerRef = useRef(new AbortController());
  useEffect(() => {
    const controller = new AbortController();
    chatSnapshotControllerRef.current = controller;
    return () => controller.abort();
  }, []);

  const clearWorkspacePanels = useCallback(() => {
    const listing = workspaceStore.activeVaultId ? vaultListingsRef.current[workspaceStore.activeVaultId] : undefined;
    notesRef.current = listing?.notes ?? [];
    setFolders(listing?.folders ?? []);
    setNotes(listing?.notes ?? []);
    setVaultAgents([]);
    setSuperkanbanNotes([]);
    setSuperkanbanLiveWork([]);
    setSuperkanbanLoading(false);
    setSuperkanbanError(null);
    setChatJumpTarget(null);
  }, [workspaceStore]);

  const switchVaultWorkspace = useCallback((nextVaultId: string | null) => {
    if (workspaceStore.activeVaultId === nextVaultId) return;
    workspaceStore.switchVault(nextVaultId);
    clearWorkspacePanels();
  }, [workspaceStore, clearWorkspacePanels]);

  const resetVaultWorkspaces = useCallback(() => {
    workspaceStore.reset();
    loadVaultDataInflight.clear();
    vaultListingsRef.current = {};
    clearWorkspacePanels();
  }, [workspaceStore, clearWorkspacePanels]);

  useEffect(() => {
    const id = window.setTimeout(() => localStorage.setItem('cascade_sidebar_w_vault_rail', String(sidebarWidth)), 150);
    return () => clearTimeout(id);
  }, [sidebarWidth]);

  useEffect(() => {
    if (isMobileViewport()) {
      setSidebarOpen(false);
      setChatMembersOpen(false);
    }
  }, []);

  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    // Desktop rail preference; mobile always starts closed so skip overwriting
    // with false when the user is on a phone.
    if (isMobileViewport()) return;
    localStorage.setItem('cascade_chat_users_collapsed', chatMembersOpen ? '0' : '1');
  }, [chatMembersOpen]);

  const persistWorkspaceSession = useCallback(() => {
    const session = workspaceSession(workspaceStore.activeVaultId, workspaceStore.workspaces, vaultListingsRef.current);
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  }, []);

  // Persist after ordinary changes and synchronously when the desktop window
  // closes, including a quit immediately after switching vaults or pages.
  useEffect(() => {
    const id = window.setTimeout(persistWorkspaceSession, 250);
    return () => clearTimeout(id);
  }, [workspaceRevision, persistWorkspaceSession]);

  useEffect(() => {
    window.addEventListener('pagehide', persistWorkspaceSession);
    return () => window.removeEventListener('pagehide', persistWorkspaceSession);
  }, [persistWorkspaceSession]);

  useEffect(() => {
    const id = window.setTimeout(() => {
    const { registeredAgentsByChannel: _agents, ...persistedChat } = chatState;
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(persistedChat));
    }, 250);
    return () => clearTimeout(id);
  }, [chatState]);

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(id);
  }, [notice]);

  useEffect(() => {
    if (notes.length === 0) return;
    setOpenTabs((prev) => prev.map((tab) => {
      if (tab.type !== 'chat') return tab;
      const note = notes.find((item) => item.id === tab.id && item.content_preview.trim().startsWith(CHAT_NOTE_MARKER));
      return note ? { ...tab, title: note.title } : tab;
    }));
  }, [notes]);

  // Stuck body cursor/user-select (lost mouseup mid-resize) used to freeze
  // selection/clicks until a full app restart — recover on blur/Escape.
  useEffect(() => installInteractionLockRecovery(), []);

  /** Drag the sidebar divider. */
  const startResize = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startSidebar = sidebarWidth;
    const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
    setIsResizing(true);
    acquireInteractionLock({ cursor: 'col-resize' });
    bindDragGesture({
      onMove: (e) => {
        const delta = e.clientX - startX;
        setSidebarWidth(clamp(startSidebar + delta, 240, 540));
      },
      onEnd: () => {
        releaseInteractionLock();
        setIsResizing(false);
      },
    });
  }, [sidebarWidth]);

  // A left-edge gesture is deliberate enough to avoid stealing normal chat
  // swipes, but makes the hidden mobile drawer discoverable without hunting
  // for the tiny expand button.
  const beginMobileSidebarSwipe = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (!isMobileViewport() || sidebarOpen) return;
    if (event.pointerType !== 'touch') return;
    mobileSidebarSwipeRef.current = { x: event.clientX, y: event.clientY, at: Date.now(), pointerId: event.pointerId };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }, [sidebarOpen]);
  const finishMobileSidebarSwipe = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const start = mobileSidebarSwipeRef.current;
    mobileSidebarSwipeRef.current = null;
    if (!start || start.pointerId !== event.pointerId || !isMobileViewport() || sidebarOpen) return;
    const dx = event.clientX - start.x;
    const dy = Math.abs(event.clientY - start.y);
    if (Date.now() - start.at < 800 && dx >= 72 && dx > dy * 1.5) {
      setSidebarOpen(true);
      setChatMembersOpen(false);
    }
  }, [sidebarOpen]);

  // ═══════════════════════════════════════════════════════════════
  // DATA LOADING
  // ═══════════════════════════════════════════════════════════════

  const loadVaults = useCallback(async () => {
    const epoch = workspaceStore.epoch;
    try {
      const data = await api<{ vaults: Vault[] }>('/api/vaults');
      if (workspaceStore.epoch !== epoch) return;
      let nextVaults = data.vaults;
      if (nextVaults.length === 0) {
        const created = await api<{ vault: Vault }>('/api/vaults', {
          method: 'POST',
          body: JSON.stringify({ name: 'My Vault' }),
        });
        if (workspaceStore.epoch !== epoch) return;
        nextVaults = [created.vault];
      }
      setVaults(nextVaults);
      const restoredVaultId = activeVaultIdRef.current;
      const restoredVaultValid = restoredVaultId && nextVaults.some((vault) => vault.id === restoredVaultId);
      if (!restoredVaultValid) {
        switchVaultWorkspace(nextVaults[0].id);
      }

      // Drop workspaces the signed-in account can no longer access. This also
      // prevents an invalid persisted vault from surviving an account change.
      const accessibleIds = new Set(nextVaults.map((vault) => vault.id));
      workspaceStore.retain(accessibleIds);
    } catch (error) {
      console.error('Error loading vaults:', error);
    }
  }, [switchVaultWorkspace]);

  const loadCommunityUpdates = useCallback(async (quiet = false) => {
    const epoch = workspaceStore.epoch;
    if (!quiet) setCommunityUpdatesLoading(true);
    try {
      const data = await api<CommunityUpdates>(`/api/community/updates?limit=80${showAgentMemory ? '&includeAgentMemory=1' : ''}`);
      if (workspaceStore.epoch !== epoch) return;
      setCommunityUpdates(data);
      setCommunityUpdatesError('');
    } catch (error) {
      if (workspaceStore.epoch === epoch && !quiet) setCommunityUpdatesError(error instanceof Error ? error.message : 'Could not load updates');
    } finally {
      if (workspaceStore.epoch === epoch && !quiet) setCommunityUpdatesLoading(false);
    }
  }, [showAgentMemory]);

  const updateShowAgentMemory = useCallback((show: boolean) => {
    setShowAgentMemory(show);
    localStorage.setItem('cascade_show_agent_memory', show ? '1' : '0');
  }, []);

  const scheduleCommunityRefresh = useCallback((delay = 350) => {
    if (communityRefreshTimerRef.current != null) return;
    communityRefreshTimerRef.current = window.setTimeout(() => {
      communityRefreshTimerRef.current = null;
      void loadCommunityUpdates(true);
    }, delay);
  }, [loadCommunityUpdates]);

  const markCommunityTargetRead = useCallback(async (targetId: string) => {
    const epoch = workspaceStore.epoch;
    if (!targetId) return;
    try {
      await api('/api/community/updates/read', {
        method: 'POST',
        body: JSON.stringify({ targetId }),
      });
      if (workspaceStore.epoch === epoch) await loadCommunityUpdates(true);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) {
        console.error('Could not mark update read:', error);
      }
    }
  }, [loadCommunityUpdates]);

  const markAllCommunityUpdatesRead = useCallback(async () => {
    try {
      await api('/api/community/updates/read-all', { method: 'POST' });
      setCommunityUpdates(EMPTY_COMMUNITY_UPDATES);
      await loadCommunityUpdates(true);
    } catch (error) {
      setCommunityUpdatesError(error instanceof Error ? error.message : 'Could not mark updates read');
    }
  }, [loadCommunityUpdates]);

  useEffect(() => {
    if (!user) {
      setCommunityUpdates(EMPTY_COMMUNITY_UPDATES);
      return;
    }
    void loadCommunityUpdates();
    const timer = window.setInterval(() => void loadCommunityUpdates(true), 60_000);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') scheduleCommunityRefresh(150);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      if (communityRefreshTimerRef.current != null) {
        window.clearTimeout(communityRefreshTimerRef.current);
        communityRefreshTimerRef.current = null;
      }
    };
  }, [loadCommunityUpdates, scheduleCommunityRefresh, user]);

  const handleCreateVault = useCallback(async (name: string): Promise<boolean> => {
    if (!name.trim()) return false;
    try {
      const data = await api<{ vault: Vault }>('/api/vaults', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim() }),
      });
      setVaults((current) => [...current, data.vault]);
      switchVaultWorkspace(data.vault.id);
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not create vault');
      return false;
    }
  }, [switchVaultWorkspace]);

  const handleRenameVault = useCallback(async (id: string, name: string): Promise<boolean> => {
    const next = name.trim();
    if (!next) return false;
    try {
      const data = await api<{ vault: Vault }>(`/api/vaults/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: next }),
      });
      setVaults((current) => current.map((vault) => (
        vault.id === id ? { ...vault, name: data.vault.name } : vault
      )));
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not rename vault');
      return false;
    }
  }, []);

  const handleDeleteVault = useCallback(async (id: string): Promise<boolean> => {
    try {
      await api(`/api/vaults/${id}`, { method: 'DELETE' });
      const remaining = vaults.filter((vault) => vault.id !== id);
      setVaults(remaining);
      if (activeVaultIdRef.current === id) {
        switchVaultWorkspace(remaining[0]?.id ?? null);
      }
      await loadVaults();
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not delete vault');
      return false;
    }
  }, [loadVaults, switchVaultWorkspace, vaults]);

  useEffect(() => {
    let cancelled = false;
    let succeeded = false;
    let unauthorized = false;
    let attempt = 0;
    let timer: number | null = null;
    const tryAuth = () => {
      api<{ authenticated: boolean; user?: User; owner?: boolean }>('/api/session')
        .then((data) => {
          if (cancelled) return;
          if (!data.authenticated || !data.user) {
            unauthorized = true;
            stopDesktopRunnerHost();
            setAuthReady(true);
            return;
          }
          succeeded = true;
          setUser(data.user);
          setIsOwner(Boolean(data.owner));
          setAuthReady(true);
          void loadVaults();
        })
        .catch((error) => {
          if (cancelled) return;
          // A real 401 means no session. Transient network/deploy failures keep
          // retrying so an HttpOnly cookie is not mistaken for a logout.
          if (error instanceof ApiError && error.status === 401) {
            unauthorized = true;
            stopDesktopRunnerHost();
            setAuthReady(true);
            return;
          }
          attempt += 1;
          if (attempt > 6) return;
          timer = window.setTimeout(tryAuth, Math.min(1000 * 2 ** (attempt - 1), 15000));
        });
    };
    // If connectivity returns after the retries gave up, try again — a valid
    // token shouldn't strand the user on the login screen.
    const onReconnect = () => {
      if (cancelled || succeeded || unauthorized) return;
      attempt = 0;
      if (timer != null) window.clearTimeout(timer);
      tryAuth();
    };
    tryAuth();
    window.addEventListener('online', onReconnect);
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
      window.removeEventListener('online', onReconnect);
    };
  }, [loadVaults]);

  useEffect(() => {
    if (user) {
      // Renderer reloads are not logout. Main-process agents survive the page,
      // and the replacement renderer reconnects/reclaims them.
      startDesktopRunnerHost();
    }
  }, [user?.id]);

  // Poll desktop runner health for the chat agent sidebar.
  // Only commit setState when the payload actually changes — identical JSON
  // every 5s was re-rendering the whole chat tree and made idle hover laggy.
  useEffect(() => {
    if (!user) {
      setRunnerHealth(null);
      return;
    }
    let cancelled = false;
    let timer: number | null = null;
    const sameHealth = (a: DesktopRunnerHealth | null, b: DesktopRunnerHealth): boolean => {
      if (!a) return false;
      if (a.online !== b.online) return false;
      if (a.activeRuns !== b.activeRuns) return false;
      if (a.lastError !== b.lastError) return false;
      if (a.lastErrorAt !== b.lastErrorAt) return false;
      // lastSeenAt ticks on every runner socket event — ignore for UI identity
      // or the 12s health poll re-renders the whole chat tree while streaming.
      if (a.planUsage === b.planUsage) return true;
      try {
        return JSON.stringify(a.planUsage) === JSON.stringify(b.planUsage);
      } catch {
        return false;
      }
    };
    const mergePlanUsage = (
      prev: DesktopRunnerHealth['planUsage'],
      next: DesktopRunnerHealth['planUsage'],
    ): DesktopRunnerHealth['planUsage'] => {
      // Keep last good per-provider snapshot so meters don't vanish on a miss.
      const merged: NonNullable<DesktopRunnerHealth['planUsage']> = { ...(prev || {}) };
      if (!next) return Object.keys(merged).length ? merged : null;
      for (const [key, value] of Object.entries(next)) {
        if (value?.status === 'ok') merged[key] = value;
        else if (!merged[key]) merged[key] = value;
      }
      return merged;
    };
    const apply = (data: DesktopRunnerHealth) => {
      setRunnerHealth((prev) => {
        const withUsage: DesktopRunnerHealth = {
          ...data,
          planUsage: mergePlanUsage(prev?.planUsage ?? null, data.planUsage),
        };
        return sameHealth(prev, withUsage) ? prev : withUsage;
      });
    };
    const tick = async () => {
      // Skip network work while the tab is hidden; resume on visibilitychange.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      // Credential setup can race a self-host server boot/restart before the
      // runner socket exists. The setup helper is idempotent, so let this
      // existing health cadence recover that cold-start failure too.
      ensureDesktopRunnerHost();
      try {
        const data = await api<DesktopRunnerHealth>('/api/me/desktop-runner');
        if (!cancelled) apply(data);
      } catch {
        // A failed status request is transport-unknown, not proof that the
        // runner is offline. Keep the last confirmed snapshot (or null during
        // cold start) so a server/network blip cannot manufacture status UI.
      }
    };
    void tick();
    // 12s is plenty for a status pill; was 5s and forced full tree work.
    timer = window.setInterval(tick, 12_000);
    const onVis = () => {
      if (document.visibilityState === 'visible') void tick();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      if (timer != null) window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [user]);

  /** Chat channels currently open as tabs (not every chat note in the vault). */
  const openChatTabIds = useCallback((): string[] => {
    return workspaceStore.active.openTabs.filter((tab) => tab.type === 'chat').map((tab) => tab.id);
  }, []);

  /**
   * Resolve which chat channels a load call should touch: an explicit
   * `channelIds` list when given, otherwise only the open chat tabs that are
   * actually chat notes — never every channel note in the vault.
   */
  const resolveChatChannelIds = useCallback((
    noteList: NoteSummary[],
    channelIds?: string[],
  ): string[] => {
    if (channelIds?.length) return channelIds;
    const chatNoteIds = new Set(
      noteList
        .filter((note) => note.content_preview.trim().startsWith(CHAT_NOTE_MARKER))
        .map((note) => note.id),
    );
    return openChatTabIds().filter((id) => chatNoteIds.has(id));
  }, [openChatTabIds]);

  const loadChatAgentMembers = useCallback(async (
    vaultId: string,
    noteList: NoteSummary[],
    opts?: { channelIds?: string[] },
  ) => {
    const epoch = workspaceStore.epoch;
    // Membership hydrates on demand for open channels. The server projects the
    // vault roster during this request, so touching every unopened room turned
    // one vault refresh into an expensive mutation-heavy request fan-out.
    const finalIds = resolveChatChannelIds(noteList, opts?.channelIds);
    if (finalIds.length === 0) return;

    const results = await Promise.all(finalIds.map(async (channelId) => {
      try {
        const data = await api<{ agents: ChatAgentRegistration[] }>(`/api/vaults/${vaultId}/channels/${channelId}/agents`);
        return { channelId, agents: data.agents ?? [] };
      } catch {
        // A transient deploy/socket gap must not erase registrations that were
        // already loaded. Reply refs can still display an author-derived @name
        // without this list, but routing then finds no agent and silently posts
        // a reply with no run.
        return {
          channelId,
          agents: agentsAfterLoadFailure(chatStateRef.current.registeredAgentsByChannel[channelId]),
        };
      }
    }));

    if (workspaceStore.epoch !== epoch) return;
    setChatState((prev) => {
      const registeredAgentsByChannel = { ...prev.registeredAgentsByChannel };
      for (const { channelId, agents } of results) {
        registeredAgentsByChannel[channelId] = agents;
      }
      return { ...prev, registeredAgentsByChannel };
    });
  }, [resolveChatChannelIds]);

  const loadChatPresence = useCallback(async (
    vaultId: string,
    noteList: NoteSummary[],
    opts?: { channelIds?: string[] },
  ) => {
    const epoch = workspaceStore.epoch;
    const finalIds = resolveChatChannelIds(noteList, opts?.channelIds);
    if (finalIds.length === 0) return;

    const results = await Promise.all(finalIds.map(async (channelId) => {
      try {
        const data = await api<ChatChannelPresence>(`/api/vaults/${vaultId}/channels/${channelId}/presence`);
        return { channelId, participants: data.participants ?? [], online: data.online ?? [], owner: data.owner ?? '', profiles: data.profiles ?? {} };
      } catch {
        return { channelId, participants: [], online: [], owner: '', profiles: {} };
      }
    }));

    if (workspaceStore.epoch !== epoch) return;
    setChatPresenceByChannel((prev) => {
      const next = { ...prev };
      for (const { channelId, participants, online, owner, profiles } of results) {
        next[channelId] = { participants, online, owner, profiles };
      }
      return next;
    });
  }, [resolveChatChannelIds]);

  const loadChatMessages = useCallback(async (
    vaultId: string,
    noteList: NoteSummary[],
    opts?: { silent?: boolean; channelIds?: string[]; signal?: AbortSignal },
  ) => {
    const epoch = workspaceStore.epoch;
    const signal = opts?.signal ?? chatSnapshotControllerRef.current.signal;
    const channelIds = resolveChatChannelIds(noteList, opts?.channelIds);
    if (channelIds.length === 0) return;
    setChannelVaultIds((previous) => {
      if (channelIds.every((channelId) => previous[channelId] === vaultId)) return previous;
      const next = { ...previous };
      for (const channelId of channelIds) next[channelId] = vaultId;
      return next;
    });

    const legacyMessages = readLegacyLocalChatMessages();
    const silent = opts?.silent === true;
    // Only show "Loading…" for channels with no cached transcript. Silent
    // refreshes (app resume / focus) must never blank the open channel.
    if (!silent) {
      setLoadingChatChannels((prev) => {
        const next = { ...prev };
        for (const id of channelIds) {
          const cached = chatMessageStore.getChannel(id);
          if (cached.length === 0) next[id] = true;
        }
        return next;
      });
    }
    const loadChannels = async (ids: string[]) => {
      // Apply each channel as it lands so the focused tab can leave
      // "Loading messages…" without waiting on other open chat tabs.
      await Promise.all(ids.map(async (channelId) => {
        const hadChannel = chatMessageStore.hasChannel(channelId);
        const inflightKey = `${epoch}:${vaultId}:${channelId}`;
        let fetchOne = loadChatMessagesInflight.get(inflightKey);
        if (!fetchOne) {
          fetchOne = (async (): Promise<{
            channelId: string;
            messages: ChatMessage[];
            baseline: ChatMessageSnapshotBaseline;
          }> => {
            const baseline = captureChatMessageSnapshotBaseline(chatMessageStore.getChannel(channelId));
            try {
              let messages = await fetchChatMessageSnapshot(vaultId, channelId, baseline, signal);
              const local = legacyMessages[channelId] ?? [];
              if (messages.length === 0 && local.length > 0) {
                for (const message of local) {
                  if (signal.aborted || workspaceStore.epoch !== epoch) return { channelId, messages, baseline };
                  try {
                    await api(`/api/vaults/${vaultId}/channels/${channelId}/messages`, {
                      method: 'POST', body: JSON.stringify(message), signal,
                    });
                  } catch { /* Best-effort legacy migration. */ }
                }
                const refreshed = await api<{ messages: ChatMessage[] }>(
                  `/api/vaults/${vaultId}/channels/${channelId}/messages?detail=list&limit=120`,
                  { signal },
                );
                messages = refreshed.messages ?? [];
              }
              return { channelId, messages, baseline };
            } catch {
              // Keep whatever we already have on soft failure (resume offline).
              const cached = chatMessageStore.hasChannel(channelId)
                ? chatMessageStore.getChannel(channelId)
                : undefined;
              return { channelId, messages: cached ?? legacyMessages[channelId] ?? [], baseline };
            } finally {
              loadChatMessagesInflight.delete(inflightKey);
            }
          })();
          loadChatMessagesInflight.set(inflightKey, fetchOne);
        }

        const { messages, baseline } = await fetchOne;
        if (workspaceStore.epoch !== epoch || signal.aborted || chatSnapshotControllerRef.current.signal.aborted
          || (hadChannel && !chatMessageStore.hasChannel(channelId))) return;
        chatMessageStore.update(channelId, (existing) => {
          if (existing === messages) return existing;
          // Reconnect reconciliation intentionally fetches the slim transcript,
          // where data-URL images are represented only by `hasImages`. Merge it
          // over the live cache so a refresh cannot erase hydrated media or a
          // human/agent row that arrived after this request began.
          return reconcileChatMessageSnapshot(existing, messages, baseline);
        });
        setLoadingChatChannels((prev) => {
          if (!prev[channelId]) return prev;
          const next = { ...prev };
          delete next[channelId];
          return next;
        });
      }));
    };

    // Focused channel first so progressive apply paints the visible tab ASAP.
    const focusedId = workspaceStore.focusedPane.activeTabId;
    const ordered = focusedId && channelIds.includes(focusedId)
      ? [focusedId, ...channelIds.filter((id) => id !== focusedId)]
      : channelIds;
    await loadChannels(ordered);
  }, [resolveChatChannelIds]);

  const persistChatAgentMemberToServer = useCallback(async (vaultId: string, channelId: string, registration: ChatAgentRegistration) => {
    try {
      const fromVault = Boolean(registration.vaultAgentId);
      const endpoint = fromVault
        ? `/api/vaults/${vaultId}/channels/${channelId}/agents/from-vault`
        : `/api/vaults/${vaultId}/channels/${channelId}/agents`;
      const data = await api<{ registration: ChatAgentRegistration }>(endpoint, {
        method: fromVault ? 'POST' : 'PUT',
        body: JSON.stringify(registration),
      });
      return data.registration;
    } catch (error) {
      console.error('Failed to persist chat agent member:', error);
      setNotice(error instanceof Error ? error.message : 'Could not save agent member');
      return null;
    }
  }, []);

  const removeChatAgentMemberOnServer = useCallback(async (vaultId: string, channelId: string, registrationId: string) => {
    try {
      await api(`/api/vaults/${vaultId}/channels/${channelId}/agents/${registrationId}`, {
        method: 'DELETE',
      });
    } catch (error) {
      console.error('Failed to remove chat agent member:', error);
      setNotice(error instanceof Error ? error.message : 'Could not remove agent member');
    }
  }, []);

  const loadVaultAgents = useCallback(async (vaultId: string) => {
    const epoch = workspaceStore.epoch;
    try {
      const data = await api<{ agents: VaultAgent[] }>(`/api/vaults/${vaultId}/vault-agents`);
      if (workspaceStore.epoch === epoch && activeVaultIdRef.current === vaultId) setVaultAgents(data.agents ?? []);
    } catch {
      if (workspaceStore.epoch === epoch && activeVaultIdRef.current === vaultId) setVaultAgents([]);
    }
  }, []);

  const loadVaultData = useCallback(async (vaultId: string, opts?: { soft?: boolean }) => {
    const epoch = workspaceStore.epoch;
    const soft = opts?.soft === true;
    // Soft can ride a hard load already in flight (hard is a superset). Hard
    // only joins another hard — a soft in flight may have skipped loading UI.
    const hardKey = `${vaultId}:hard`;
    const softKey = `${vaultId}:soft`;
    const hardInflight = loadVaultDataInflight.get(hardKey);
    if (hardInflight) return hardInflight;
    if (soft) {
      const softInflight = loadVaultDataInflight.get(softKey);
      if (softInflight) return softInflight;
    }
    const inflightKey = soft ? softKey : hardKey;

    const run = (async () => {
      try {
        // Prefer the focused chat tab first so cold start paints useful
        // transcript ASAP; other open tabs hydrate after the shell settles.
        const openChats = openChatTabIds();
        const focusedChatId = workspaceStore.active.openTabs.find((t) => t.type === 'chat' && t.id === workspaceStore.focusedPane.activeTabId)?.id
          ?? openChats[0];
        const primaryChats = focusedChatId ? [focusedChatId] : [];
        const secondaryChats = openChats.filter((id) => id !== focusedChatId);
        const silent = soft;

        const foldersP = api<{ folders: Folder[] }>(`/api/vaults/${vaultId}/folders`);
        const notesP = api<{ notes: NoteSummary[] }>(`/api/vaults/${vaultId}/notes`);
        // Primary chat + vault agents must not gate notes-tree paint.
        const primaryChatP = !soft && primaryChats.length > 0
          ? Promise.all([
              loadChatMessages(vaultId, [], { silent, channelIds: primaryChats }),
              loadChatAgentMembers(vaultId, [], { channelIds: primaryChats }),
              loadChatPresence(vaultId, [], { channelIds: primaryChats }),
            ])
          : Promise.resolve();
        const vaultAgentsP = soft ? Promise.resolve() : loadVaultAgents(vaultId);

        const [folderData, noteData] = await Promise.all([foldersP, notesP]);
        if (workspaceStore.epoch !== epoch) return;
        const nextNotes = noteData.notes || [];
        const nextFolders = folderData.folders || [];
        vaultListingsRef.current = {
          ...vaultListingsRef.current,
          [vaultId]: { folders: nextFolders, notes: nextNotes, savedAt: Date.now() },
        };
        persistWorkspaceSession();
        // Background-prefetched vaults populate the instant-switch cache but
        // must never repaint whichever vault the user is currently viewing.
        if (activeVaultIdRef.current !== vaultId) return;
        notesRef.current = nextNotes;
        const channelIds = nextNotes
          .filter((note) => note.content_preview.trim().startsWith(CHAT_NOTE_MARKER))
          .map((note) => note.id);
        setChannelVaultIds((previous) => {
          if (channelIds.every((channelId) => previous[channelId] === vaultId)) return previous;
          const next = { ...previous };
          for (const channelId of channelIds) next[channelId] = vaultId;
          return next;
        });
        setFolders(nextFolders);
        setNotes(nextNotes);
        void primaryChatP.catch(() => undefined);
        void vaultAgentsP.catch(() => undefined);
        if (!soft && secondaryChats.length > 0) {
          // Defer background tabs one frame so the active channel can paint.
          window.setTimeout(() => {
            if (workspaceStore.epoch !== epoch || activeVaultIdRef.current !== vaultId) return;
            void loadChatMessages(vaultId, nextNotes, { silent: true, channelIds: secondaryChats }).catch(() => undefined);
            void loadChatAgentMembers(vaultId, nextNotes, { channelIds: secondaryChats }).catch(() => undefined);
            void loadChatPresence(vaultId, nextNotes, { channelIds: secondaryChats }).catch(() => undefined);
          }, 0);
        }
      } catch (error) {
        console.error('Error loading vault data:', error);
      } finally {
        if (workspaceStore.epoch === epoch) loadVaultDataInflight.delete(inflightKey);
      }
    })();

    loadVaultDataInflight.set(inflightKey, run);
    return run;
  }, [loadChatMessages, loadChatAgentMembers, loadChatPresence, loadVaultAgents, openChatTabIds, persistWorkspaceSession]);

  // The vault rail is navigation, so selecting any visible vault should feel
  // like switching tabs rather than beginning a fetch. Warm each uncached
  // notes/folders listing after the shell is ready; loadVaultData keeps these
  // lightweight soft reads isolated from the active vault's UI.
  useEffect(() => {
    if (!user || vaults.length === 0) return;
    const timer = window.setTimeout(() => {
      for (const vault of vaults) {
        if (vaultListingsRef.current[vault.id]) continue;
        void loadVaultData(vault.id, { soft: true });
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [user, vaults, loadVaultData]);

  /** Hydrate one chat channel when the user focuses its tab (skip if cached). */
  const ensureChatChannelLoaded = useCallback((channelId: string) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) return;
    const notesList = notesRef.current;
    // Restored chat tabs are typed in session before notes hydrate — don't wait
    // for the notes list to admit this is a channel.
    const isOpenChatTab = workspaceStore.active.openTabs.some((t) => t.id === channelId && t.type === 'chat');
    const isChatNote = notesList.some(
      (n) => n.id === channelId && n.content_preview.trim().startsWith(CHAT_NOTE_MARKER),
    );
    if (!isOpenChatTab && !isChatNote) return;

    // Cold-start vault load already hydrates every open chat tab. Joining that
    // work (via message inflight) is fine, but skip kicking a parallel
    // agents/presence wave that only races the same endpoints.
    if (
      isOpenChatTab
      && (loadVaultDataInflight.has(`${vaultId}:hard`) || loadVaultDataInflight.has(`${vaultId}:soft`))
    ) {
      return;
    }

    // Key presence (not length): empty channels are a valid cached result.
    // length===0 used to re-fetch on every notes/focus tick.
    const messagesCached = chatMessageStore.hasChannel(channelId);
    const agentsCached = Object.prototype.hasOwnProperty.call(
      chatStateRef.current.registeredAgentsByChannel,
      channelId,
    );
    // Messages already fetching for this channel (e.g. vault load) — don't
    // start a second agents/presence pass; vault load covers those too.
    if (!messagesCached && loadChatMessagesInflight.has(`${workspaceStore.epoch}:${vaultId}:${channelId}`)) {
      return;
    }
    if (messagesCached && agentsCached) return;

    const ids = [channelId];
    if (!messagesCached) {
      void loadChatMessages(vaultId, notesList, { channelIds: ids });
    }
    if (!agentsCached) {
      void loadChatAgentMembers(vaultId, notesList, { channelIds: ids });
    }
    void loadChatPresence(vaultId, notesList, { channelIds: ids });
  }, [loadChatMessages, loadChatAgentMembers, loadChatPresence]);

  // Hydrate the active chat channel whenever it's the focused tab and its
  // messages aren't loaded. Chat transcripts aren't persisted to localStorage
  // (mobile perf), so a backgrounded webview that reloads on resume — or any
  // cold load with a chat tab already restored from the layout — comes back
  // with no messages and never calls openChatChannel. Without this, the empty
  // "#channel" placeholder shows until the user interacts. ensureChatChannelLoaded
  // is idempotent (skips when already cached) and flags the channel as loading,
  // so ChatView shows "Loading messages…" instead of the empty state.
  useEffect(() => {
    if (!user || !activeVaultId) return;
    if (vaultSidebarChannel) ensureChatChannelLoaded(vaultSidebarChannel);
  }, [user, activeVaultId, notes, vaultSidebarChannel, ensureChatChannelLoaded]);

  /** Merge full message detail (harness log) after expand-fetch. */
  const handleOpenSharedChatNote = useCallback(async (
    channelId: string,
    messageId: string,
    title: string,
  ): Promise<SharedChatNote | null> => {
    try {
      const data = await api<{ notes: SharedChatNote[] }>(
        `/api/vaults/${activeVaultIdRef.current || 'none'}/channels/${channelId}/messages/${messageId}/embeds`,
      );
      return data.notes.find((note) => note.title.toLowerCase() === title.trim().toLowerCase()) ?? null;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not open shared note');
      return null;
    }
  }, []);

  // Normal resume: do NOT soft-reload the vault on every window focus (that was
  // thrashing network + React on alt-tab). Page Visibility only, and a soft
  // fetch only after a real background stretch or when data is missing.
  useEffect(() => {
    if (!user) return;

    /** How long away before a soft vault refresh is worth it. */
    const STALE_AFTER_MS = 60_000;
    let hiddenAt: number | null =
      typeof document !== 'undefined' && document.visibilityState === 'hidden'
        ? Date.now()
        : null;
    let lastSoftRefreshAt = 0;
    let resumeTimer: number | null = null;

    const reconnectSocketsIfNeeded = () => {
      // Never clearRunnerToken here — resume must not tear down /runners mid-agent.
      ensureDesktopRunnerHost();

      const vaultId = activeVaultIdRef.current;
      const vaultSocket = vaultSocketRef.current;
      if (vaultSocket && vaultId && !vaultSocket.connected) {
        vaultSocket.connect();
      }
    };

    const hydrateActiveChatIfEmpty = () => {
      // Chat transcripts aren't in localStorage; a cold/backgrounded resume can
      // restore the tab with an empty channel. ensureChatChannelLoaded is a
      // no-op when messages+agents are already cached.
      const activeId = workspaceStore.focusedPane.activeTabId;
      if (activeId && workspaceStore.active.openTabs.some((t) => t.id === activeId && t.type === 'chat')) {
        ensureChatChannelLoaded(activeId);
      }
    };

    const softRefreshIfStale = (awayMs: number) => {
      const vaultId = activeVaultIdRef.current;
      if (!vaultId) return;
      const now = Date.now();
      if (awayMs < STALE_AFTER_MS && now - lastSoftRefreshAt < STALE_AFTER_MS) return;
      lastSoftRefreshAt = now;
      void loadVaultData(vaultId, { soft: true });
    };

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        return;
      }
      // visible
      const awayMs = hiddenAt != null ? Date.now() - hiddenAt : 0;
      hiddenAt = null;
      reconnectSocketsIfNeeded();
      hydrateActiveChatIfEmpty();
      // Coalesce with any twin focus/pageshow events in the same tick.
      if (resumeTimer != null) window.clearTimeout(resumeTimer);
      resumeTimer = window.setTimeout(() => {
        resumeTimer = null;
        softRefreshIfStale(awayMs);
      }, 100);
    };

    const onOnline = () => {
      reconnectSocketsIfNeeded();
      softRefreshIfStale(STALE_AFTER_MS);
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    return () => {
      if (resumeTimer != null) window.clearTimeout(resumeTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
    };
  }, [user, loadVaultData, ensureChatChannelLoaded]);

  useEffect(() => {
    if (activeVaultId) {
      void loadVaultData(activeVaultId);
    } else {
      setFolders([]);
      setNotes([]);
      setVaultAgents([]);
    }
  }, [activeVaultId, loadVaultData]);

  // ═══════════════════════════════════════════════════════════════
  // CHAT CHANNEL OPERATIONS
  // ═══════════════════════════════════════════════════════════════

  const openChatChannel = useCallback((channelId: string, title: string, mode: 'open' | 'replace' = 'open') => {
    const name = title.trim() || 'chat';
    const tab: Tab = { id: channelId, title: name, type: 'chat', dirty: false };

    workspaceStore.openTab(tab, mode);
    ensureChatChannelLoaded(channelId);
  }, [ensureChatChannelLoaded, workspaceStore]);

  const acceptVaultInvite = useCallback(async (token: string): Promise<boolean> => {
    try {
      const data = await api<{ vaultId: string; name: string; role: string; alreadyMember?: boolean }>(
        `/api/vault-invites/${encodeURIComponent(token)}/accept`,
        { method: 'POST' },
      );
      await loadVaults();
      switchVaultWorkspace(data.vaultId);
      await loadVaultData(data.vaultId);
      setNotice(data.alreadyMember
        ? `You already have access to ${data.name}.`
        : `Joined ${data.name} as ${data.role}.`);
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not accept invite link');
      return false;
    }
  }, [loadVaultData, loadVaults, switchVaultWorkspace]);

  const handleJoinVault = useCallback(async (inviteLink: string): Promise<boolean> => {
    try {
      const parsed = new URL(inviteLink, window.location.origin);
      const match = parsed.pathname.match(/^\/vault-invite\/([^/]+)$/);
      if (!match) throw new Error('Paste a valid vault invite link');
      return await acceptVaultInvite(decodeURIComponent(match[1]));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Paste a valid vault invite link');
      return false;
    }
  }, [acceptVaultInvite]);

  // Redeem a vault share link. Unlike the chat invite above this joins the
  // vault itself, so the whole vault appears in the switcher.
  useEffect(() => {
    const match = window.location.pathname.match(/^\/vault-invite\/([^/]+)$/);
    const token = match ? decodeURIComponent(match[1]) : '';
    if (!token || !user || acceptedInviteTokenRef.current === token) return;
    acceptedInviteTokenRef.current = token;
    (async () => {
      if (await acceptVaultInvite(token)) {
        window.history.replaceState({}, '', '/app.html');
      }
    })();
  }, [acceptVaultInvite, user]);

  const handleCreateChannel = useCallback(async (folderId: string | null = null) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) return undefined;
    try {
      const data = await api<{ note: Note }>(`/api/vaults/${vaultId}/notes`, {
        method: 'POST',
        body: JSON.stringify({ title: 'new-channel', content: CHAT_NOTE_MARKER, folder_id: folderId ?? undefined }),
      });
      await loadVaultData(vaultId);
      if (activeVaultIdRef.current !== vaultId) return undefined;
      openChatChannel(data.note.id, data.note.title);
      return { id: data.note.id, title: data.note.title };
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not create channel');
      return undefined;
    }
  }, [loadVaultData, openChatChannel]);

  const handleRegisterChatAgent = useCallback((channelId: string, registration: ChatAgentRegistration, sourceVaultId?: string) => {
    const normalized = {
      ...registration,
      id: registration.id || createChatAgentRegistrationId(),
      vaultAgentId: registration.vaultAgentId || '',
      displayName: registration.displayName.trim() || agentLabel(registration.agentId as AgentId),
      mention: normalizeMention(registration.mention || registration.agentId),
      cwd: normalizeChatCwd(registration.cwd),
      orchestrator: registration.orchestrator === true,
      replyToEveryMessage: registration.replyToEveryMessage === true || registration.orchestrator === true,
      conversationId: registration.conversationId || newId('conv'),
    };
    setChatState((prev) => ({
      ...prev,
      registeredAgentsByChannel: {
        ...prev.registeredAgentsByChannel,
        [channelId]: [
          ...(prev.registeredAgentsByChannel[channelId] ?? []).filter((item) => item.id !== normalized.id),
          normalized,
        ],
      },
    }));
    // A run may finish after the user has switched vaults. Persist session
    // adoption back to the vault that launched it, never whichever vault is
    // currently visible.
    const vaultId = sourceVaultId || activeVaultIdRef.current;
    if (vaultId) {
      void persistChatAgentMemberToServer(vaultId, channelId, normalized).then((saved) => {
        if (saved) {
          setChatState((prev) => ({
            ...prev,
            registeredAgentsByChannel: {
              ...prev.registeredAgentsByChannel,
              [channelId]: [
                ...(prev.registeredAgentsByChannel[channelId] ?? []).filter((item) => (
                  item.id !== normalized.id
                  && item.id !== saved.id
                  && (!saved.vaultAgentId || item.vaultAgentId !== saved.vaultAgentId)
                )),
                saved,
              ],
            },
          }));
        }
        void loadVaultAgents(vaultId);
        // Re-project vault-wide so every room picks up the new member.
        void loadChatAgentMembers(vaultId, notesRef.current);
      });
    }
  }, [persistChatAgentMemberToServer, loadVaultAgents, loadChatAgentMembers]);

  const handleRemoveChatAgent = useCallback((channelId: string, registrationId: string) => {
    setChatState((prev) => ({
      ...prev,
      registeredAgentsByChannel: {
        ...prev.registeredAgentsByChannel,
        [channelId]: (prev.registeredAgentsByChannel[channelId] ?? []).filter((item) => item.id !== registrationId),
      },
    }));
    const vaultId = activeVaultIdRef.current;
    if (vaultId) {
      void removeChatAgentMemberOnServer(vaultId, channelId, registrationId).then(() => {
        void loadVaultAgents(vaultId);
      });
    }
  }, [removeChatAgentMemberOnServer, loadVaultAgents]);

  const handleUpsertVaultAgent = useCallback(async (input: Partial<VaultAgent> & { agentId: string }) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) throw new Error('No active vault');
    const data = await api<{ agent: VaultAgent }>(`/api/vaults/${vaultId}/vault-agents`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
    const agent = data.agent;
    setVaultAgents((prev) => {
      const rest = prev.filter((a) => a.id !== agent.id);
      return [...rest, agent].sort((a, b) => (a.displayName || a.mention).localeCompare(b.displayName || b.mention));
    });
    // Sync identity into any loaded channel memberships
    setChatState((prev) => {
      const next = { ...prev.registeredAgentsByChannel };
      for (const [chId, regs] of Object.entries(next)) {
        next[chId] = regs.map((r) => (
          r.vaultAgentId === agent.id
            ? {
                ...r,
                agentId: agent.agentId,
                displayName: agent.displayName,
                avatarUrl: agent.avatarUrl,
                mention: agent.mention,
                model: agent.model,
                cwd: agent.cwd,
                contextPrompt: agent.contextPrompt,
              }
            : r
        ));
      }
      return { ...prev, registeredAgentsByChannel: next };
    });
    // PUT vault-agents projects into every channel server-side; refresh client
    // maps so no room keeps a stale shorter roster.
    void loadChatAgentMembers(vaultId, notesRef.current);
    return agent;
  }, [loadChatAgentMembers]);

  const handleDeleteVaultAgent = useCallback(async (vaultAgentId: string) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) return;
    await api(`/api/vaults/${vaultId}/vault-agents/${vaultAgentId}`, { method: 'DELETE' });
    setChatState((prev) => {
      const next: Record<string, ChatAgentRegistration[]> = {};
      for (const [chId, regs] of Object.entries(prev.registeredAgentsByChannel)) {
        next[chId] = regs.filter((r) => r.vaultAgentId !== vaultAgentId);
      }
      return { ...prev, registeredAgentsByChannel: next };
    });
  }, []);

  const handleDeleteAgentProfile = useCallback(async (vaultAgentId: string) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) return;
    await api(`/api/vaults/${vaultId}/vault-agents/${vaultAgentId}/profile`, { method: 'DELETE' });
    setVaultAgents((prev) => prev.filter((a) => a.id !== vaultAgentId));
    setChatState((prev) => {
      const next: Record<string, ChatAgentRegistration[]> = {};
      for (const [chId, regs] of Object.entries(prev.registeredAgentsByChannel)) {
        next[chId] = regs.filter((r) => r.vaultAgentId !== vaultAgentId);
      }
      return { ...prev, registeredAgentsByChannel: next };
    });
  }, []);

  const handleAddVaultAgentToChannel = useCallback(async (
    channelId: string,
    vaultAgentId: string,
    membership?: ChatAgentRegistration,
  ) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) throw new Error('No active vault');
    const data = await api<{ registration: ChatAgentRegistration }>(
      `/api/vaults/${vaultId}/channels/${channelId}/agents/from-vault`,
      {
        method: 'POST',
        body: JSON.stringify(vaultAgentMembershipPayload(vaultAgentId, membership)),
      },
    );
    const reg = data.registration;
    setChatState((prev) => ({
      ...prev,
      registeredAgentsByChannel: {
        ...prev.registeredAgentsByChannel,
        [channelId]: [
          ...(prev.registeredAgentsByChannel[channelId] ?? []).filter((item) => item.id !== reg.id && item.vaultAgentId !== vaultAgentId),
          reg,
        ],
      },
    }));
    void loadVaultAgents(vaultId);
    // from-vault only seats the agent on one channel; reload all rooms so the
    // vault-wide projection (server ensure) lands in client state everywhere.
    void loadChatAgentMembers(vaultId, notesRef.current);
  }, [loadVaultAgents, loadChatAgentMembers]);

  const handleInviteChatUser = useCallback(async (_channelId: string, username: string) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) throw new Error('No active vault');
    await api(`/api/vaults/${vaultId}/members`, {
      method: 'POST',
      body: JSON.stringify({ username, role: 'editor' }),
    });
    await loadVaultData(vaultId, { soft: true });
  }, [loadVaultData]);

  const handleRemoveChatParticipant = useCallback(async (channelId: string, username: string) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) return;
    try {
      await api(
        `/api/vaults/${vaultId}/channels/${channelId}/members/${encodeURIComponent(username)}`,
        { method: 'DELETE' },
      );
      await loadVaultData(vaultId, { soft: true });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not remove participant');
      throw error;
    }
  }, [loadVaultData]);

  const handleLeaveChatChannel = useCallback(async (_channelId: string) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId || !user || !window.confirm('Leave this vault?')) return;
    await api(`/api/vaults/${vaultId}/members/${user.id}`, { method: 'DELETE' });
    switchVaultWorkspace(null);
    workspaceStore.retain(new Set(Object.keys(workspaceStore.workspaces).filter((id) => id !== vaultId)));
    await loadVaults();
  }, [user, loadVaults, switchVaultWorkspace]);

  const {
    handleHydrateChatMessage,
    handleDeleteChatMessage,
    handleForwardChatMessage,
    handleCancelChatRun,
    handleSendChatMessage,
  } = useChatDispatch({
    activeVaultIdRef,
    notesRef,
    chatStateRef,
    setChatState,
    setNotice,
    user,
  });

  const closeTab = useCallback((tabId: string) => workspaceStore.closeTabs([tabId]), [workspaceStore]);
  const closeOtherTabs = useCallback((tabIds: string[], keepTabId: string) => {
    workspaceStore.closeTabs(tabIds.filter((id) => id !== keepTabId));
  }, [workspaceStore]);

  // Stable handle so socket/delete callbacks can close tabs without re-subscribing.
  const closeTabRef = useRef(closeTab); closeTabRef.current = closeTab;

  // ═══════════════════════════════════════════════════════════════
  // NOTE CONTENT
  // ═══════════════════════════════════════════════════════════════

  /** Fetch a note body into `noteContents` (no layout change). Self-heals stale tabs. */
  const loadNoteContent = useCallback(async (noteId: string) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) return;
    const epoch = workspaceStore.epoch;
    try {
      const data = await api<{ note: Note }>(`/api/notes/${noteId}`);
      if (workspaceStore.epoch !== epoch || activeVaultIdRef.current !== vaultId
        || !workspaceStore.active.openTabs.some((tab) => tab.id === noteId)) return;

      // Shortcut URL check
      const content = data.note.content.trim();
      if (content.startsWith(CHAT_NOTE_MARKER)) {
        closeTab(noteId);
        openChatChannel(noteId, data.note.title);
        return;
      }

      setNoteContents((prev) => {
        const existing = prev[noteId];
        const isDirty = existing ? existing.draft !== existing.note.content : false;
        return { ...prev, [noteId]: { note: data.note, draft: isDirty ? existing!.draft : data.note.content } };
      });
      setOpenTabs((prev) => prev.map((t) => (t.id === noteId ? { ...t, title: data.note.title, type: 'note' } : t)));
    } catch (error) {
      if (workspaceStore.epoch !== epoch || activeVaultIdRef.current !== vaultId) return;
      console.error('Error loading note:', error);
      workspaceStore.closeTabs([noteId]);
      setNotice('That note could not be opened — it may have been moved or deleted. Refreshing the list.');
      if (activeVaultIdRef.current) void loadVaultData(activeVaultIdRef.current);
    }
  }, [loadVaultData, closeTab, openChatChannel]);

  /** Fetch every board body + live mission/work items for the aggregate tab. */
  const loadSuperkanban = useCallback(async () => {
    // Previews are whitespace-collapsed by the API, so detect the marker here
    // and validate the complete note body again inside mergeKanbanSources.
    const boardSummaries = notesRef.current.filter((note) => (
      /kanban-plugin\s*:/.test(note.content_preview)
      && (/superkanban\s*:\s*true/i.test(note.content_preview) || /cascade-channel\s*:/i.test(note.content_preview))
    ));
    const vaultId = activeVaultIdRef.current;
    setSuperkanbanLoading(true);
    setSuperkanbanError(null);
    try {
      const [fetched, live] = await Promise.all([
        Promise.all(boardSummaries.map(async (summary) => {
          const data = await api<{ note: Note }>(`/api/notes/${summary.id}`);
          return data.note;
        })),
        vaultId
          ? api<{ items: WorkItem[] }>(
            `/api/vaults/${vaultId}/work-items`,
          ).then((data) => data.items || []).catch(() => [] as WorkItem[])
          : Promise.resolve([] as WorkItem[]),
      ]);
      if (activeVaultIdRef.current !== vaultId) return;
      setSuperkanbanNotes(fetched);
      setSuperkanbanLiveWork(live);
    } catch (error) {
      if (activeVaultIdRef.current !== vaultId) return;
      console.error('Error loading Superkanban:', error);
      setSuperkanbanError('Could not load all Kanban boards. Try reopening this tab.');
    } finally {
      if (activeVaultIdRef.current === vaultId) setSuperkanbanLoading(false);
    }
  }, []);

  const openSuperkanban = useCallback((paneId: string) => {
    const id = `superkanban:${activeVaultIdRef.current ?? 'current'}`;
    const tab: Tab = { id, title: 'Superkanban', type: 'superkanban', dirty: false };
    workspaceStore.openTab(tab, 'open', paneId);
    void loadSuperkanban();
  }, [loadSuperkanban]);

  /**
   * Open a note: ensure it has a tab, focus the pane that already shows it, or
   * place it in the focused pane. `replace` swaps the focused pane's active tab
   * only when the note is not already open (used by single-click in the sidebar).
   */
  const openNote = useCallback((noteId: string, mode: 'open' | 'replace' = 'open') => {
    // Check if the note is a shortcut URL in the summary list
    const summary = notesRef.current.find((n) => n.id === noteId);
    if (summary) {
      const preview = summary.content_preview.trim();
      if (preview.startsWith(CHAT_NOTE_MARKER)) {
        openChatChannel(noteId, summary.title, mode);
        return;
      }
    }

    workspaceStore.openTab({ id: noteId, title: summary?.title || 'Untitled Note', type: 'note', dirty: false }, mode);

    void loadNoteContent(noteId);
  }, [loadNoteContent, openChatChannel]);

  // A vault with no restored active page should still open somewhere useful.
  // Prefer its last open tab if one survives, then its first chat, then its
  // first note. This runs when vault data arrives, not when a user closes the
  // final tab, so an intentional empty workspace remains possible.
  useEffect(() => {
    if (!activeVaultId || notes.length === 0) return;
    const availableIds = new Set(notes.map((note) => note.id));
    const hasSelectedPage = Layout.getActiveTabIds(workspaceStore.active.layout)
      .some((id) => {
        const tab = workspaceStore.active.openTabs.find((candidate) => candidate.id === id);
        return Boolean(tab && (tab.type === 'new' || tab.type === 'superkanban' || availableIds.has(id)));
      });
    if (hasSelectedPage) return;

    const lastOpenTab = [...workspaceStore.active.openTabs].reverse().find((tab) => availableIds.has(tab.id));
    const fallback = lastOpenTab
      ? notes.find((note) => note.id === lastOpenTab.id)
      : notes.find((note) => note.content_preview.trim().startsWith(CHAT_NOTE_MARKER)) ?? notes[0];
    if (fallback) openNote(fallback.id, 'replace');
  }, [activeVaultId, notes, openNote]);

  useEffect(() => {
    if (!user || !focusedTab || (focusedTab.type !== 'note' && focusedTab.type !== 'chat')) return;
    chatMessageStore.clearFinishedAgentActivity(focusedTab.id);
    if (!(communityUpdates.counts.byTarget[focusedTab.id] > 0)) return;
    void markCommunityTargetRead(focusedTab.id);
  }, [agentActivity, communityUpdates.counts.byTarget, focusedTab?.id, focusedTab?.type, markCommunityTargetRead, user]);

  const openCommunityUpdate = useCallback(async (item: CommunityUpdateItem) => {
    const epoch = workspaceStore.epoch;
    const sourceVaultId = workspaceStore.activeVaultId;
    await markCommunityTargetRead(item.targetId);
    if (workspaceStore.epoch !== epoch || workspaceStore.activeVaultId !== sourceVaultId) return;
    setUpdatesOpen(false);
    if (activeVaultIdRef.current !== item.vaultId) {
      switchVaultWorkspace(item.vaultId);
      await loadVaultData(item.vaultId);
    }
    if (workspaceStore.epoch !== epoch || workspaceStore.activeVaultId !== item.vaultId) return;
    if (item.kind === 'note') {
      openNote(item.targetId);
      return;
    }
    openChatChannel(item.targetId, item.targetTitle);
    if (item.messageId) setChatJumpTarget({ channelId: item.targetId, messageId: item.messageId });
  }, [loadVaultData, markCommunityTargetRead, openChatChannel, openNote, switchVaultWorkspace]);

  /** Save a specific note tab's draft. */
  const saveNoteTab = useCallback(async (tabId: string) => {
    const vaultId = activeVaultIdRef.current;
    const entry = workspaceStore.active.noteContents[tabId];
    if (!vaultId || !entry) return;
    const epoch = workspaceStore.epoch;
    try {
      const data = await api<{ note: Note }>(`/api/notes/${tabId}`, {
        method: 'PUT',
        body: JSON.stringify({ content: entry.draft }),
      });
      workspaceStore.completeSave(vaultId, tabId, entry.draft, data.note, epoch);
      if (workspaceStore.epoch === epoch && workspaceStore.activeVaultId === vaultId) void loadVaultData(vaultId);
      return data.note;
    } catch (error) {
      console.error('Error saving note:', error);
      throw error;
    }
  }, [loadVaultData]);

  /** Save whichever note is in the focused pane (Ctrl+S, AI panel). */
  const handleSaveActiveNote = useCallback(() => {
    const tabId = workspaceStore.focusedPane.activeTabId;
    return tabId ? saveNoteTab(tabId) : Promise.resolve(undefined);
  }, [saveNoteTab]);

  /** Track edits to a note tab's body and update its dirty flag. */
  const handleNoteChange = useCallback((tabId: string, newContent: string) => {
    setNoteContents((prev) => {
      const entry = prev[tabId];
      if (!entry) return prev;
      return { ...prev, [tabId]: { ...entry, draft: newContent } };
    });
  }, []);

  /** Rename a note tab (title + on-disk file + wikilink references). */
  const renameNoteTab = useCallback(async (tabId: string, title: string) => {
    const vaultId = workspaceStore.activeVaultId;
    const epoch = workspaceStore.epoch;
    if (!vaultId) return;
    try {
      const data = await api<{ note: Note }>(`/api/notes/${tabId}/rename`, {
        method: 'POST',
        body: JSON.stringify({ title }),
      });
      if (workspaceStore.epoch !== epoch) return;
      workspaceStore.update((workspace) => ({ ...workspace,
        noteContents: workspace.noteContents[tabId] ? { ...workspace.noteContents, [tabId]: { ...workspace.noteContents[tabId], note: data.note } } : workspace.noteContents,
        openTabs: workspace.openTabs.map((tab) => tab.id === tabId ? { ...tab, title: data.note.title } : tab),
      }), vaultId);
      if (workspaceStore.activeVaultId === vaultId) void loadVaultData(vaultId);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Could not rename note');
      throw error; // let the editor revert its title draft
    }
  }, [loadVaultData]);

  // Per-tab callback caches so NoteEditor (React.memo'd) gets a referentially
  // stable onContentChange/onSave/onRename each render instead of a fresh
  // closure — otherwise every App re-render (e.g. on chat stream ticks) busts
  // the memo for every open note tab, not just the one that changed.
  const noteChangeHandlers = useRef(new Map<string, (content: string) => void>());
  const getNoteChangeHandler = useCallback((tabId: string) => {
    let fn = noteChangeHandlers.current.get(tabId);
    if (!fn) {
      fn = (content: string) => handleNoteChange(tabId, content);
      noteChangeHandlers.current.set(tabId, fn);
    }
    return fn;
  }, [handleNoteChange]);

  const noteSaveHandlers = useRef(new Map<string, () => Promise<Note | undefined>>());
  const getNoteSaveHandler = useCallback((tabId: string) => {
    let fn = noteSaveHandlers.current.get(tabId);
    if (!fn) {
      fn = () => saveNoteTab(tabId);
      noteSaveHandlers.current.set(tabId, fn);
    }
    return fn;
  }, [saveNoteTab]);

  const noteRenameHandlers = useRef(new Map<string, (title: string) => Promise<void>>());
  const getNoteRenameHandler = useCallback((tabId: string) => {
    let fn = noteRenameHandlers.current.get(tabId);
    if (!fn) {
      fn = (title: string) => renameNoteTab(tabId, title);
      noteRenameHandlers.current.set(tabId, fn);
    }
    return fn;
  }, [renameNoteTab]);

  const handleOpenWikilink = useCallback((title: string) => {
    const target = findEmbeddedNote(notesRef.current, title);
    if (target) openNote(target.id);
  }, [openNote]);

  const visibleChatChannelIds = useMemo(() => {
    const tabIds = Layout.getActiveTabIds(layout);
    return tabIds.filter((tabId) => openTabs.some((tab) => tab.id === tabId && tab.type === 'chat'));
  }, [layout, openTabs]);

  const syncChatPresenceRooms = useCallback((socket: ReturnType<typeof connectVaultSocket>) => {
    const joined = joinedChatChannelsRef.current;
    const visible = new Set(visibleChatChannelIds);
    for (const channelId of [...joined]) {
      if (!visible.has(channelId)) {
        socket.emit('leaveChatChannel', channelId);
        joined.delete(channelId);
      }
    }
    for (const channelId of visibleChatChannelIds) {
      if (!joined.has(channelId)) {
        socket.emit('joinChatChannel', channelId);
        joined.add(channelId);
      }
    }
  }, [visibleChatChannelIds]);

  // ═══════════════════════════════════════════════════════════════
  // SOCKET SETUP
  // ═══════════════════════════════════════════════════════════════

  useEffect(() => {
    if (!activeVaultId || !user) return;
    const controller = new AbortController();
    const socket = connectVaultSocket();
    vaultSocketRef.current = socket;
    const joinActiveVault = () => {
      socket.emit('joinVault', activeVaultId);
      syncChatPresenceRooms(socket);
    };
    const handleConnect = () => {
      joinActiveVault();
      scheduleCommunityRefresh(150);
      // Socket.IO rooms do not replay events emitted while this renderer was
      // disconnected. Reconcile every open transcript after a successful
      // (re)connect so a phone-started run cannot remain phone-only merely
      // because the desktop missed its create/update broadcasts.
      const channelIds = openChatTabIds();
      if (channelIds.length > 0) {
        void Promise.all([
          loadChatMessages(activeVaultId, notesRef.current, {
            silent: true,
            channelIds,
            signal: controller.signal,
          }),
          loadChatAgentMembers(activeVaultId, notesRef.current, { channelIds }),
        ]);
      }
    };
    socket.on('connect', handleConnect);
    if (socket.connected) handleConnect();

    // Soft + debounced: note events often arrive in bursts (agent saves, multi-
    // user edits). A hard full reload per event re-stacked cold-start work and
    // stretched "Loading messages…". Soft keeps the open transcript visible.
    const scheduleSoftVaultReload = () => {
      if (socketVaultReloadTimerRef.current != null) return;
      socketVaultReloadTimerRef.current = window.setTimeout(() => {
        socketVaultReloadTimerRef.current = null;
        if (activeVaultIdRef.current) void loadVaultData(activeVaultIdRef.current, { soft: true });
      }, 80);
    };
    const handleNoteChanged = (data: { noteId: string; vaultId: string }) => {
      if (data.vaultId !== activeVaultId) return;
      scheduleSoftVaultReload();
      // Refresh the body only if the note is open and has no unsaved edits.
      const entry = workspaceStore.active.noteContents[data.noteId];
      if (entry && entry.draft === entry.note.content) void loadNoteContent(data.noteId);
    };
    const handleNoteCreated = (data: { vaultId: string }) => {
      if (data.vaultId === activeVaultId) scheduleSoftVaultReload();
    };
    const handleNoteDeleted = (data: { noteId: string; vaultId: string }) => {
      if (data.vaultId !== activeVaultId) return;
      scheduleSoftVaultReload();
      chatMessageStore.remove(data.noteId);
      closeTabRef.current(data.noteId);
    };
    const handleChatMessageUpdated = (data: { vaultId: string; channelId: string; message: ChatMessage }) => {
      if (data.vaultId !== activeVaultId) return;
      chatMessageStore.update(data.channelId, (existing) => applyRemoteChatMessage(existing, data.message));
    };
    const handleChatMessageDeleted = (data: { vaultId: string; channelId: string; messageId: string }) => {
      if (data.vaultId !== activeVaultId) return;
      if (!chatMessageStore.hasChannel(data.channelId)) return;
      chatMessageStore.update(data.channelId, (existing) => {
        const next = existing.filter((message) => message.id !== data.messageId);
        return next.length === existing.length ? existing : next;
      });
    };
    const handleChatAgentMemberUpserted = (data: { vaultId: string; channelId: string; registration: ChatAgentRegistration }) => {
      if (data.vaultId !== activeVaultId) return;
      setChatState((prev) => {
        const existing = prev.registeredAgentsByChannel[data.channelId] ?? [];
        const filtered = existing.filter((item) => item.id !== data.registration.id);
        return {
          ...prev,
          registeredAgentsByChannel: {
            ...prev.registeredAgentsByChannel,
            [data.channelId]: [...filtered, data.registration],
          },
        };
      });
    };
    const handleVaultAgentUpserted = (data: { agent: VaultAgent }) => {
      const agent = data.agent;
      if (!agent || agent.vaultId !== activeVaultId) return;
      setVaultAgents((prev) => {
        const rest = prev.filter((item) => item.id !== agent.id);
        return [...rest, agent].sort((a, b) => (a.displayName || a.mention).localeCompare(b.displayName || b.mention));
      });
      setChatState((prev) => {
        const next = { ...prev.registeredAgentsByChannel };
        for (const [channelId, registrations] of Object.entries(next)) {
          next[channelId] = registrations.map((registration) => (
            registration.vaultAgentId === agent.id
              ? {
                  ...registration,
                  agentId: agent.agentId,
                  displayName: agent.displayName,
                  avatarUrl: agent.avatarUrl,
                  mention: agent.mention,
                  model: agent.model,
                  cwd: agent.cwd,
                  contextPrompt: agent.contextPrompt,
                }
              : registration
          ));
        }
        return { ...prev, registeredAgentsByChannel: next };
      });
    };
    const handleVaultAgentRemoved = (data: { agentId: string }) => {
      if (!data.agentId) return;
      setVaultAgents((prev) => prev.filter((agent) => agent.id !== data.agentId));
      setChatState((prev) => {
        const next: Record<string, ChatAgentRegistration[]> = {};
        for (const [channelId, registrations] of Object.entries(prev.registeredAgentsByChannel)) {
          next[channelId] = registrations.filter((registration) => registration.vaultAgentId !== data.agentId);
        }
        return { ...prev, registeredAgentsByChannel: next };
      });
    };
    const handleChatAgentMemberRemoved = (data: { vaultId: string; channelId: string; registrationId: string }) => {
      if (data.vaultId !== activeVaultId) return;
      setChatState((prev) => ({
        ...prev,
        registeredAgentsByChannel: {
          ...prev.registeredAgentsByChannel,
          [data.channelId]: (prev.registeredAgentsByChannel[data.channelId] ?? []).filter((item) => item.id !== data.registrationId),
        },
      }));
    };
    const handleChatPresence = (data: ChatChannelPresence & { vaultId: string; channelId: string }) => {
      if (data.vaultId !== activeVaultId) return;
      setChatPresenceByChannel((prev) => ({
        ...prev,
        [data.channelId]: mergeChatPresence(prev[data.channelId], data),
      }));
    };
    const handleUserProfileUpdated = (profile: User) => {
      if (profile.id === user?.id) setUser(profile);
      setChatPresenceByChannel((prev) => Object.fromEntries(Object.entries(prev).map(([channelId, presence]) => [
        channelId,
        {
          ...presence,
          profiles: { ...(presence.profiles || {}), [profile.username]: profile },
        },
      ])));
    };

    const handleCommunityChanged = () => scheduleCommunityRefresh();

    // Another member renamed the vault we are in; update the label in place.
    const handleVaultRenamed = (payload: { vaultId: string; name: string }) => {
      if (!payload?.vaultId || !payload.name) return;
      setVaults((current) => current.map((vault) => (
        vault.id === payload.vaultId ? { ...vault, name: payload.name } : vault
      )));
    };

    socket.on('community:changed', handleCommunityChanged);
    socket.on('vault:renamed', handleVaultRenamed);
    socket.on('vault:noteChanged', handleNoteChanged);
    socket.on('vault:noteCreated', handleNoteCreated);
    socket.on('vault:noteDeleted', handleNoteDeleted);
    socket.on('vault:chatMessageCreated', handleChatMessageUpdated);
    socket.on('vault:chatMessageUpdated', handleChatMessageUpdated);
    socket.on('vault:chatMessageDeleted', handleChatMessageDeleted);
    socket.on('vault:chatAgentMemberUpserted', handleChatAgentMemberUpserted);
    socket.on('vault:chatAgentMemberRemoved', handleChatAgentMemberRemoved);
    socket.on('vault:vaultAgentUpserted', handleVaultAgentUpserted);
    socket.on('vault:vaultAgentRemoved', handleVaultAgentRemoved);
    socket.on('vault:chatPresence', handleChatPresence);
    socket.on('vault:userProfileUpdated', handleUserProfileUpdated);
    return () => {
      controller.abort();
      if (socketVaultReloadTimerRef.current != null) {
        window.clearTimeout(socketVaultReloadTimerRef.current);
        socketVaultReloadTimerRef.current = null;
      }
      socket.off('connect', handleConnect);
      for (const channelId of [...joinedChatChannelsRef.current]) {
        socket.emit('leaveChatChannel', channelId);
      }
      joinedChatChannelsRef.current.clear();
      socket.emit('leaveVault', activeVaultId);
      vaultSocketRef.current = null;
      socket.off('community:changed', handleCommunityChanged);
      socket.off('vault:renamed', handleVaultRenamed);
      socket.off('vault:noteChanged', handleNoteChanged);
      socket.off('vault:noteCreated', handleNoteCreated);
      socket.off('vault:noteDeleted', handleNoteDeleted);
      socket.off('vault:chatMessageCreated', handleChatMessageUpdated);
      socket.off('vault:chatMessageUpdated', handleChatMessageUpdated);
      socket.off('vault:chatMessageDeleted', handleChatMessageDeleted);
      socket.off('vault:chatAgentMemberUpserted', handleChatAgentMemberUpserted);
      socket.off('vault:chatAgentMemberRemoved', handleChatAgentMemberRemoved);
      socket.off('vault:vaultAgentUpserted', handleVaultAgentUpserted);
      socket.off('vault:vaultAgentRemoved', handleVaultAgentRemoved);
      socket.off('vault:chatPresence', handleChatPresence);
      socket.off('vault:userProfileUpdated', handleUserProfileUpdated);
      socket.disconnect();
    };
  }, [activeVaultId, user?.id, authEpoch, loadVaultData, loadNoteContent, loadChatAgentMembers, loadChatMessages, openChatTabIds, openNote, syncChatPresenceRooms, scheduleCommunityRefresh]);

  useEffect(() => {
    const socket = vaultSocketRef.current;
    if (!socket?.connected || !activeVaultId) return;
    syncChatPresenceRooms(socket);
  }, [activeVaultId, syncChatPresenceRooms]);

  // Vault events are not replayed; this also runs if the socket never connects.
  useEffect(() => {
    if (!activeVaultId || !user) return;
    const controller = new AbortController();
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const activity = chatMessageStore.getAgentActivity();
        const channelIds = [...new Set([
          ...openChatTabIds(),
          ...notesRef.current.filter((note) => activity[note.id] === 'running').map((note) => note.id),
        ])];
        await loadChatMessages(activeVaultId, notesRef.current, { silent: true, channelIds, signal: controller.signal });
      } finally {
        refreshing = false;
      }
    };
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [activeVaultId, user?.id, authEpoch, loadChatMessages, openChatTabIds]);

  // ═══════════════════════════════════════════════════════════════
  // NOTE / FOLDER OPERATIONS
  // ═══════════════════════════════════════════════════════════════

  const createAndOpenNote = useCallback(async (paneId: string | null, folderId: string | null) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) return;
    try {
      const data = await api<{ note: Note }>(`/api/vaults/${vaultId}/notes`, {
        method: 'POST',
        body: JSON.stringify({ title: 'Untitled Note', content: '', folder_id: folderId ?? undefined }),
      });
      await loadVaultData(vaultId);
      if (activeVaultIdRef.current !== vaultId) return data.note;
      const targetPane = paneId ?? workspaceStore.focusedPane.id;
      const tab: Tab = { id: data.note.id, title: data.note.title, type: 'note', dirty: false };
      setNoteContents((prev) => ({ ...prev, [data.note.id]: { note: data.note, draft: data.note.content } }));
      workspaceStore.openTab(tab, 'open', targetPane);
      return data.note;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not create note');
      return undefined;
    }
  }, [loadVaultData]);

  const handleCreateNote = useCallback(() => createAndOpenNote(null, null), [createAndOpenNote]);

  const handleCreateNoteInPane = useCallback((paneId: string) => { void createAndOpenNote(paneId, null); }, [createAndOpenNote]);

  const handleCreateTabInPane = useCallback((paneId: string) => {
    const id = `new:${crypto.randomUUID()}`;
    const tab: Tab = { id, title: 'New tab', type: 'new', dirty: false };
    workspaceStore.openTab(tab, 'open', paneId);
  }, []);

  const handleCreateChatInPane = useCallback(async (paneId: string) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) return;
    try {
      const data = await api<{ note: Note }>(`/api/vaults/${vaultId}/notes`, {
        method: 'POST',
        body: JSON.stringify({ title: 'new-channel', content: CHAT_NOTE_MARKER }),
      });
      await loadVaultData(vaultId);
      if (activeVaultIdRef.current !== vaultId) return;
      const tab: Tab = { id: data.note.id, title: data.note.title || 'new-channel', type: 'chat', dirty: false };
      workspaceStore.openTab(tab, 'open', paneId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not create channel');
    }
  }, [loadVaultData]);

  const handleDeleteNote = useCallback(async (noteId: string) => {
    if (!window.confirm('Delete this note? This cannot be undone.')) return;
    try {
      const wasChatChannel = notesRef.current.find((note) => note.id === noteId)?.content_preview.trim().startsWith(CHAT_NOTE_MARKER);
      await api(`/api/notes/${noteId}`, { method: 'DELETE' });
      closeTabRef.current(noteId);
      if (wasChatChannel) chatMessageStore.remove(noteId);
      if (activeVaultIdRef.current) await loadVaultData(activeVaultIdRef.current);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not delete note');
    }
  }, [loadVaultData]);

  const handleMoveNote = useCallback(async (noteId: string, folderId: string | null, position?: number) => {
    try {
      await api(`/api/notes/${noteId}/move`, {
        method: 'POST',
        body: JSON.stringify({ folder_id: folderId, ...(position === undefined ? {} : { position }) }),
      });
      if (activeVaultIdRef.current) await loadVaultData(activeVaultIdRef.current);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not move note');
    }
  }, [loadVaultData]);

  const handleUnlistNote = useCallback(async (noteId: string) => {
    try {
      await api(`/api/notes/${noteId}/unlist`, { method: 'POST' });
      if (activeVaultIdRef.current) await loadVaultData(activeVaultIdRef.current);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not unlink note');
    }
  }, [loadVaultData]);

  const handleCreateFolder = useCallback(async (parentId: string | null = null) => {
    if (!activeVaultIdRef.current) return undefined;
    try {
      const data = await api<{ folder: Folder }>(`/api/vaults/${activeVaultIdRef.current}/folders`, {
        method: 'POST',
        body: JSON.stringify({ name: 'New Folder', parent_id: parentId ?? undefined }),
      });
      await loadVaultData(activeVaultIdRef.current);
      return data.folder;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not create folder');
      return undefined;
    }
  }, [loadVaultData]);

  const handleRenameFolder = useCallback(async (folderId: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      await api(`/api/folders/${folderId}`, { method: 'PATCH', body: JSON.stringify({ name: trimmed }) });
      if (activeVaultIdRef.current) await loadVaultData(activeVaultIdRef.current);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not rename folder');
    }
  }, [loadVaultData]);

  const handleMoveFolder = useCallback(async (folderId: string, parentId: string | null, position: number) => {
    try {
      await api(`/api/folders/${folderId}`, { method: 'PATCH', body: JSON.stringify({ parent_id: parentId, position }) });
      if (activeVaultIdRef.current) await loadVaultData(activeVaultIdRef.current);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not move folder');
    }
  }, [loadVaultData]);

  const handleDeleteFolder = useCallback(async (folderId: string) => {
    if (!window.confirm('Delete this folder? Notes inside it move to the parent folder.')) return;
    try {
      await api(`/api/folders/${folderId}`, { method: 'DELETE' });
      if (activeVaultIdRef.current) await loadVaultData(activeVaultIdRef.current);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not delete folder');
    }
  }, [loadVaultData]);

  const handleCreateNoteInFolder = useCallback((folderId: string | null) => { void createAndOpenNote(null, folderId); }, [createAndOpenNote]);

  const handleExecuteDirective = useCallback((text: string) => {
    const run = async () => {
      const vaultId = activeVaultIdRef.current;
      if (!vaultId) return;
      let channel = notesRef.current.find((note) => note.content_preview.trim().startsWith(CHAT_NOTE_MARKER));
      let channelInfo = channel ? { id: channel.id, title: channel.title } : null;
      if (!channel) {
        const data = await api<{ note: Note }>(`/api/vaults/${vaultId}/notes`, {
          method: 'POST',
          body: JSON.stringify({ title: 'agent-chat', content: CHAT_NOTE_MARKER }),
        });
        await loadVaultData(vaultId);
        channelInfo = { id: data.note.id, title: data.note.title };
      }
      if (!channelInfo) return;
      openChatChannel(channelInfo.id, channelInfo.title);
      handleSendChatMessage(channelInfo.id, `@claude ${text}`);
    };
    void run().catch((error) => {
      setNotice(error instanceof Error ? error.message : 'Could not start agent chat');
    });
  }, [handleSendChatMessage, loadVaultData, openChatChannel]);
  const handleReportProductFeedback = useCallback(async (body: string) => {
    await api('/api/product-feedback', {
      method: 'POST',
      body: JSON.stringify({
        body,
        source: 'documentation-assistant',
        surface: 'guide-assistant',
      }),
    });
  }, []);

  // ═══════════════════════════════════════════════════════════════
  // TAB / PANE MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  /** Select a tab inside a specific pane (per-pane strip click). */
  const selectTabInPane = useCallback((paneId: string, tabId: string) => {
    setLayout(Layout.setActiveTab(workspaceStore.active.layout, paneId, tabId));
    setFocusedPaneId(paneId);
    const tab = workspaceStore.active.openTabs.find((t) => t.id === tabId);
    if (tab?.type === 'note' && !workspaceStore.active.noteContents[tabId]) void loadNoteContent(tabId);
    if (tab?.type === 'chat') ensureChatChannelLoaded(tabId);
    if (tab?.type === 'superkanban') void loadSuperkanban();
  }, [loadNoteContent, ensureChatChannelLoaded, loadSuperkanban]);

  /** Handle a tab dropped onto a pane (drag-tile). */
  const handleDropTab = useCallback((payload: TabDragPayload, targetPaneId: string, side: Layout.DropSide, index?: number) => {
    const prev = workspaceStore.active.layout;
    const next = side === 'center'
      ? Layout.moveTab(prev, payload.tabId, targetPaneId, index)
      : Layout.splitPaneWithTab(prev, targetPaneId, side, payload.tabId);
    setLayout(next);
    const landed = Layout.findPaneByTab(next, payload.tabId);
    setFocusedPaneId(landed?.id ?? targetPaneId);
  }, []);

  /** Turn a sidebar note drag into a real tab, then dock or split it. */
  const handleDropNote = useCallback((noteId: string, targetPaneId: string, side: Layout.DropSide, index?: number) => {
    const summary = notesRef.current.find((note) => note.id === noteId);
    if (!summary) return;
    const isChat = summary.content_preview.trim().startsWith(CHAT_NOTE_MARKER);
    const tab: Tab = { id: noteId, title: summary.title || (isChat ? 'Channel' : 'Untitled Note'), type: isChat ? 'chat' : 'note', dirty: false };
    setOpenTabs((prev) => prev.some((item) => item.id === noteId)
      ? prev.map((item) => item.id === noteId ? { ...item, ...tab } : item)
      : [...prev, tab]);
    const prev = workspaceStore.active.layout;
    const next = side === 'center'
      ? Layout.addTabToPane(Layout.removeTab(prev, noteId), targetPaneId, noteId, index)
      : Layout.splitPaneWithTab(prev, targetPaneId, side, noteId);
    setLayout(Layout.simplify(next));
    const landed = Layout.findPaneByTab(next, noteId);
    setFocusedPaneId(landed?.id ?? targetPaneId);
    if (isChat) ensureChatChannelLoaded(noteId);
    else void loadNoteContent(noteId);
  }, [ensureChatChannelLoaded, loadNoteContent]);

  const handleResizeSplit = useCallback((splitId: string, sizes: number[]) => {
    setLayout(Layout.setSplitSizes(workspaceStore.active.layout, splitId, sizes));
  }, []);

  /**
   * A tab was dragged out of the window. Ask the main process to pop it into a
   * new OS window at the cursor; if it did (drop was outside this window), drop
   * the tab from this window's layout so it lives in exactly one place.
   */
  const handleDetachTab = useCallback((tabId: string, screenX: number, screenY: number) => {
    const electronAPI = (window as unknown as {
      electronAPI?: { popOutTab?: (input: { tab: Tab; screenX: number; screenY: number }) => Promise<{ success: boolean; popped?: boolean }> };
    }).electronAPI;
    if (!electronAPI?.popOutTab) return;
    const tab = workspaceStore.active.openTabs.find((t) => t.id === tabId);
    if (!tab) return;
    if (tab.type !== 'note') return;
    void electronAPI.popOutTab({ tab, screenX, screenY }).then((res) => {
      if (!res?.popped) return;
      workspaceStore.closeTabs([tabId]);
    });
  }, []);

  // Adopt a tab merged back in from a popped-out window (it was dragged onto
  // this window). Dock it into the focused pane and load its body if a note.
  useEffect(() => {
    const electronAPI = (window as unknown as {
      electronAPI?: { onAdoptTab?: (cb: (tab: Tab) => void) => () => void };
    }).electronAPI;
    if (!electronAPI?.onAdoptTab) return;
    return electronAPI.onAdoptTab((tab) => {
      if (!tab || typeof tab.id !== 'string') return;
      if (tab.type !== 'note') return;
      workspaceStore.openTab(tab);
      if (tab.type === 'note') void loadNoteContent(tab.id);
    });
  }, [loadNoteContent]);

  /** Split the focused pane to the right (Ctrl/Cmd+Shift+\). */
  const splitFocusedPane = useCallback(() => {
    const focused = workspaceStore.focusedPane;
    if (!focused.activeTabId) return;
    const next = Layout.splitPaneWithTab(workspaceStore.active.layout, focused.id, 'right', focused.activeTabId);
    setLayout(next);
    const landed = Layout.findPaneByTab(next, focused.activeTabId);
    if (landed) setFocusedPaneId(landed.id);
  }, []);

  // After login/reload and every vault switch, hydrate the visible note tabs in
  // that vault's restored workspace.
  useEffect(() => {
    if (!activeVaultId) return;
    Layout.getActiveTabIds(workspaceStore.active.layout).forEach((id) => {
      if (workspaceStore.active.openTabs.find((t) => t.id === id)?.type === 'note') void loadNoteContent(id);
    });
  }, [activeVaultId, loadNoteContent]);

  // ═══════════════════════════════════════════════════════════════
  // AUTH
  // ═══════════════════════════════════════════════════════════════

  async function submitAuth(event: React.FormEvent) {
    event.preventDefault();
    setAuthError('');
    setAuthNotice('');
    try {
      if (authMode === 'reset') {
        // Redeem an owner-issued reset token; the server logs us straight in.
        const data = await api<{ user: User; owner?: boolean }>('/api/auth/reset', {
          method: 'POST',
          body: JSON.stringify({ token: resetToken.trim(), newPassword: password }),
        });
        // Drop any prior user's workspace pointer so we never open their vault id.
        localStorage.removeItem(SESSION_STORAGE_KEY);
        resetVaultWorkspaces();
        localStorage.removeItem('docs_token');
        setUser(data.user);
        setIsOwner(Boolean(data.owner));
        setPassword('');
        setResetToken('');
        await loadVaults();
        setAuthReady(true);
        return;
      }
      const inviteMatch = window.location.pathname.match(/^\/(?:invite|vault-invite)\/([^/]+)$/);
      const inviteToken = inviteMatch ? decodeURIComponent(inviteMatch[1]) : '';
      const data = await api<{ user: User; owner?: boolean }>(`/api/auth/${authMode}`, {
        method: 'POST',
        body: JSON.stringify({ username, password, ...(authMode === 'register' && inviteToken ? { inviteToken } : {}) }),
      });
      // Account switch: never restore another user's activeVaultId / open tabs.
      localStorage.removeItem(SESSION_STORAGE_KEY);
      resetVaultWorkspaces();
      localStorage.removeItem('docs_token');
      setUser(data.user);
      setIsOwner(Boolean(data.owner));
      setPassword('');
      await loadVaults();
      setAuthReady(true);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Authentication failed');
    }
  }

  const handleLogout = () => {
    stopDesktopRunnerHost();
    void api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    localStorage.removeItem('docs_token');
    localStorage.removeItem(SESSION_STORAGE_KEY);
    setUser(null);
    setIsOwner(false);
    setAdminOpen(false);
    setVaults([]);
    resetVaultWorkspaces();
  };

  // ═══════════════════════════════════════════════════════════════
  // KEYBOARD SHORTCUTS
  // ═══════════════════════════════════════════════════════════════

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === 'p') { e.preventDefault(); setCommandPaletteOpen((v) => !v); }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); setSearchOpen((v) => !v); }
      if (mod && !e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); setSearchOpen(true); }
      if (mod && e.key === '\\' && !(e.altKey || e.shiftKey)) { e.preventDefault(); setSidebarOpen((v) => !v); }
      if (mod && !e.shiftKey && e.key === 'n') { e.preventDefault(); void handleCreateNote(); }
      if (mod && e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); void handleSaveActiveNote(); }
      if (mod && e.key.toLowerCase() === 'w') {
        e.preventDefault();
        const id = workspaceStore.focusedPane.activeTabId;
        if (id) closeTab(id);
      }
      if (mod && (e.altKey || e.shiftKey) && (e.key === '\\' || e.key === '|')) { e.preventDefault(); splitFocusedPane(); }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleCreateNote, handleSaveActiveNote, closeTab, splitFocusedPane]);

  // Chromium-reserved shortcuts forwarded from the Electron main process.
  useEffect(() => {
    const electronAPI = (window as unknown as { electronAPI?: { onShortcut?: (cb: (a: string) => void) => () => void } }).electronAPI;
    if (!electronAPI?.onShortcut) return;
    return electronAPI.onShortcut((action) => {
      if (action === 'new-note') void handleCreateNote();
      else if (action === 'toggle-sidebar') setSidebarOpen((v) => !v);
    });
  }, [handleCreateNote]);

  // ═══════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════

  // Stable identity so ChatView's memo is not defeated every render by an inline arrow.
  const handleChatJumpHandled = useCallback(() => setChatJumpTarget(null), []);

  /** Render the content of a tab inside its pane. */
  const renderTabContent = useCallback((tab: Tab): ReactNode => {
    if (tab.type === 'new') {
      return (
        <div className="new-tab-page">
          <div className="new-tab-mark"><Sparkles size={22} aria-hidden="true" /></div>
          <span className="surface-kicker">Open canvas</span>
          <strong>Make this space yours</strong>
          <span>Choose a note from the sidebar, or drag one onto an edge to work side by side.</span>
          <div className="new-tab-shortcuts" aria-label="Useful shortcuts">
            <span><kbd>Ctrl P</kbd> Open anything</span>
            <span><kbd>Ctrl N</kbd> New note</span>
          </div>
        </div>
      );
    }
    if (tab.type === 'superkanban') {
      return (
        <Suspense fallback={<div className="pane-empty">Loading board…</div>}>
          <SuperkanbanView
            notes={superkanbanNotes}
            loading={superkanbanLoading}
            error={superkanbanError}
            onOpenNote={openNote}
            liveWorkItems={superkanbanLiveWork}
          />
        </Suspense>
      );
    }
    if (tab.type === 'chat') {
      const channel = notes.find((note) => note.id === tab.id && note.content_preview.trim().startsWith(CHAT_NOTE_MARKER));
      const channelGone = notes.length > 0 && !channel && !loadingChatChannels[tab.id];
      if (channelGone) {
        return <div className="pane-empty">Channel not found</div>;
      }
      return (
        <Suspense fallback={<div className="pane-empty chat-loading-empty"><strong>Loading chat…</strong></div>}>
          <ChatView
            channelId={tab.id}
            channelName={channel?.title || tab.title}
            isLoadingMessages={loadingChatChannels[tab.id] === true}
            currentUser={currentUsername}
            presence={applyLocalUserProfile(chatPresenceByChannel[tab.id] ?? EMPTY_CHAT_PRESENCE, user)}
            availableAgents={AVAILABLE_CHAT_AGENTS}
            registeredAgents={chatState.registeredAgentsByChannel[tab.id] ?? EMPTY_CHAT_AGENTS}
            vaultAgents={vaultAgents}
            runnerHealth={runnerHealth}
            onRegisterAgent={handleRegisterChatAgent}
            onRemoveAgent={handleRemoveChatAgent}
            onUpsertVaultAgent={handleUpsertVaultAgent}
            onDeleteVaultAgent={handleDeleteVaultAgent}
            onDeleteAgentProfile={handleDeleteAgentProfile}
            onAddVaultAgentToChannel={handleAddVaultAgentToChannel}
            onInviteUser={handleInviteChatUser}
            onRemoveParticipant={handleRemoveChatParticipant}
            onLeaveChannel={handleLeaveChatChannel}
            onSendMessage={handleSendChatMessage}
            onDeleteMessage={handleDeleteChatMessage}
            onForwardMessage={handleForwardChatMessage}
            onCancelRun={handleCancelChatRun}
            notes={notes}
            onOpenNote={openNote}
            onOpenSharedNote={handleOpenSharedChatNote}
            membersOpen={chatMembersOpen}
            onMembersOpenChange={setChatMembersOpen}
            vaultId={activeVaultId || undefined}
            onHydrateMessage={handleHydrateChatMessage}
            jumpToMessageId={chatJumpTarget?.channelId === tab.id ? chatJumpTarget.messageId : undefined}
            onJumpHandled={handleChatJumpHandled}
            sidebarMode="hidden"
          />
        </Suspense>
      );
    }
    const entry = noteContents[tab.id];
    return (
      <ErrorBoundary label="Note">
        <Suspense fallback={<div className="editor-loading" />}>
          <NoteEditor
            note={entry?.note ?? null}
            content={entry?.draft ?? ''}
            onContentChange={getNoteChangeHandler(tab.id)}
            onSave={getNoteSaveHandler(tab.id)}
            onRename={getNoteRenameHandler(tab.id)}
            onExecuteDirective={handleExecuteDirective}
            onOpenWikilink={handleOpenWikilink}
            notes={notes}
            onOpenNote={openNote}
          />
        </Suspense>
      </ErrorBoundary>
    );
  }, [chatState.registeredAgentsByChannel, chatPresenceByChannel, currentUsername, user, loadingChatChannels, runnerHealth, vaultAgents, handleCancelChatRun, handleInviteChatUser, handleRemoveChatParticipant, handleLeaveChatChannel, handleRegisterChatAgent, handleRemoveChatAgent, handleUpsertVaultAgent, handleDeleteVaultAgent, handleDeleteAgentProfile, handleAddVaultAgentToChannel, handleSendChatMessage, handleForwardChatMessage, noteContents, notes, getNoteChangeHandler, getNoteSaveHandler, getNoteRenameHandler, handleExecuteDirective, handleOpenWikilink, openNote, chatMembersOpen, activeVaultId, handleHydrateChatMessage, handleOpenSharedChatNote, superkanbanNotes, superkanbanLiveWork, superkanbanLoading, superkanbanError, chatJumpTarget, handleChatJumpHandled]);

  if (!authReady) return <main className="auth-shell" id="auth-pending" />;

  if (!user) {
    const hasInvite = /^\/invite\/[^/]+$/.test(window.location.pathname);
    const inDesktopApp = Boolean((window as unknown as { electronAPI?: unknown }).electronAPI);
    return (
      <main className="auth-shell">
        <form className="auth-panel" id="auth-panel" onSubmit={submitAuth}>
          <div className="auth-brand" aria-label="Fizzer">
            <FizzerMark size={28} />
            <h1>Fizzer</h1>
          </div>
          <div className="auth-decal" aria-hidden="true" />
          <div className="auth-intro">
            <span className="surface-kicker">Shared intelligence</span>
            <strong>{authMode === 'register' ? 'Create your workspace' : authMode === 'reset' ? 'Recover your account' : 'Welcome back'}</strong>
            <p>One calm place for your team, notes, and local agents.</p>
          </div>
          {authMode === 'reset' ? (
            <>
              <p className="auth-hint">Paste the reset token the server owner gave you, then choose a new password.</p>
              <label htmlFor="reset-token">
                Reset token
                <input id="reset-token" value={resetToken} onChange={(e) => setResetToken(e.target.value)} autoComplete="off" autoFocus />
              </label>
              <label htmlFor="password">
                New password
                <input id="password" value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="new-password" />
              </label>
            </>
          ) : (
            <>
              <label htmlFor="username">
                Username
                <input id="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus />
              </label>
              <label htmlFor="password">
                Password
                <input id="password" value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete={authMode === 'login' ? 'current-password' : 'new-password'} />
              </label>
            </>
          )}
          <p className="auth-desktop-note">
            {inDesktopApp
              ? 'This desktop app can run your local agents after you sign in.'
              : 'Fizzer agents run on your own desktop app. You can join this invite here, then open it in Fizzer desktop to run agents.'}
            {!inDesktopApp && <> <a href="/download">Get Fizzer desktop</a></>}
          </p>
          {authNotice && <div className="auth-notice">{authNotice}</div>}
          {authError && <div className="error">{authError}</div>}
          <button id="auth-submit" type="submit">
            {authMode === 'login' ? 'Log in' : authMode === 'register' ? 'Create account' : 'Set new password'}
          </button>
          <button id="auth-toggle-mode" type="button" className="link-button" onClick={() => { setAuthError(''); setAuthNotice(''); setAuthMode(authMode === 'login' ? 'register' : 'login'); }}>
            {authMode === 'login' ? (hasInvite ? 'Create account for this invite' : 'Create account') : 'Already have an account? Log in'}
          </button>
          {authMode === 'login' && (
            <button type="button" className="link-button" onClick={() => { setAuthError(''); setAuthNotice(''); setAuthMode('reset'); }}>
              Forgot password?
            </button>
          )}
          {authMode === 'reset' && (
            <button type="button" className="link-button" onClick={() => { setAuthError(''); setAuthNotice(''); setAuthMode('login'); }}>
              Back to log in
            </button>
          )}
        </form>
      </main>
    );
  }

  const inDesktopApp = Boolean((window as unknown as { electronAPI?: unknown }).electronAPI);
  const showDesktopDownload = !inDesktopApp && runnerHealth != null && !runnerHealth.online;

  return (
    <main
      className={`app-shell ${sidebarOpen ? 'sidebar-open' : 'sidebar-closed'}`}
      style={{
        display: 'grid',
        '--sidebar-width': `${sidebarWidth}px`,
        overflow: 'hidden',
        transition: isResizing ? 'none' : undefined,
      } as CSSProperties}
    >
      {!sidebarOpen && (
        <div
          className="mobile-sidebar-swipe-edge"
          aria-hidden="true"
          onPointerDown={beginMobileSidebarSwipe}
          onPointerUp={finishMobileSidebarSwipe}
          onPointerCancel={() => { mobileSidebarSwipeRef.current = null; }}
        />
      )}
      {sidebarOpen && (
        <div className="resize-handle" style={{ left: sidebarWidth - 3 }} onMouseDown={startResize} role="separator" aria-orientation="vertical" aria-label="Resize sidebar" title="Drag to resize" />
      )}

      {/* Mobile only: dimmed stage dismisses the drawer on outside tap. */}
      {sidebarOpen && (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="Close sidebar"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <Sidebar
          user={user}
          isOwner={isOwner}
          onOpenAdmin={() => setAdminOpen(true)}
          vaults={vaults}
          activeVaultId={activeVaultId}
          folders={folders}
          notes={notes}
          activeNoteId={activeTabId}
          updateCounts={communityUpdates.counts}
          agentActivity={agentActivity}
          channelVaultIds={channelVaultIds}
          showAgentMemory={showAgentMemory}
          onSelectVault={switchVaultWorkspace}
          onCreateVault={handleCreateVault}
          onRenameVault={handleRenameVault}
          onDeleteVault={handleDeleteVault}
          onManageVault={(vaultId) => {
            switchVaultWorkspace(vaultId);
            setAccountInitialSection('vault');
            setAccountOpen(true);
          }}
          onJoinVault={handleJoinVault}
          onOpenPublicVaults={() => setDiscoveryDmsOpen('public')}
          onOpenDirectMessages={() => setDiscoveryDmsOpen('dms')}
          onSelectNote={(id) => {
            openNote(id, 'replace');
            if (isMobileViewport()) setSidebarOpen(false);
          }}
          onOpenNoteInNewTab={(id) => {
            openNote(id);
            if (isMobileViewport()) setSidebarOpen(false);
          }}
          onNewNote={() => {
            void handleCreateNote();
            if (isMobileViewport()) setSidebarOpen(false);
          }}
          onCreateChannel={async (folderId) => {
            const channel = await handleCreateChannel(folderId);
            if (isMobileViewport()) setSidebarOpen(false);
            return channel;
          }}
          onNewNoteInFolder={(folderId) => {
            void handleCreateNoteInFolder(folderId);
            if (isMobileViewport()) setSidebarOpen(false);
          }}
          onSearch={() => setSearchOpen(true)}
          onCollapse={() => setSidebarOpen(false)}
          onLogout={handleLogout}
          onOpenAccount={() => {
            setAccountInitialSection('profile');
            setAccountOpen(true);
          }}
          onDeleteNote={handleDeleteNote}
          onMoveNote={handleMoveNote}
          onUnlistNote={handleUnlistNote}
          onMoveFolder={handleMoveFolder}
          onCreateFolder={handleCreateFolder}
          onRenameFolder={handleRenameFolder}
          onRenameNote={renameNoteTab}
          onDeleteFolder={handleDeleteFolder}
      />
      <Suspense fallback={null}>
        <DocumentationAssistant
          open={documentationAssistantOpen}
          onOpen={() => setDocumentationAssistantOpen(true)}
          onClose={() => setDocumentationAssistantOpen(false)}
          vaultId={activeVaultId ?? vaults[0]?.id ?? null}
          runnerHealth={runnerHealth}
          onReportFeedback={handleReportProductFeedback}
        />
      </Suspense>

      {accountOpen && user && (
        <Suspense fallback={null}>
          <AccountSettings
            user={user}
            vaultId={activeVaultId}
            vaultName={vaults.find((vault) => vault.id === activeVaultId)?.name}
            initialSection={accountInitialSection}
            showAgentMemory={showAgentMemory}
            onShowAgentMemoryChange={updateShowAgentMemory}
            onClose={() => setAccountOpen(false)}
            onUserChanged={setUser}
            onSessionChanged={() => setAuthEpoch((value) => value + 1)}
            onMembershipChanged={() => { void loadVaults(); }}
          />
        </Suspense>
      )}

      {discoveryDmsOpen && (
        <Suspense fallback={null}>
          <DiscoveryDmsModal
            initialTab={discoveryDmsOpen}
            currentUsername={currentUsername}
            currentUser={user}
            updateCounts={communityUpdates.counts}
            onMarkRead={markCommunityTargetRead}
            onClose={() => setDiscoveryDmsOpen(null)}
            onVaultsChanged={loadVaults}
            onOpenLocation={async (vaultId, channelId, title) => {
              switchVaultWorkspace(vaultId);
              if (channelId) {
                await loadVaultData(vaultId);
                openChatChannel(channelId, title || 'Direct message');
              }
            }}
          />
        </Suspense>
      )}

      {/* Workspace */}
      <div className="workspace flex flex-col flex-1" style={{ height: '100%', overflow: 'hidden' }}>
        <div className="workspace-toolbar" style={{ alignItems: 'center', background: 'var(--bg-surface)', padding: '4px 8px', paddingTop: 'calc(4px + env(safe-area-inset-top))', gap: 4, borderBottom: '1px solid var(--border)' }}>
            {!sidebarOpen && (
              <button
                id="sidebar-expand-btn"
                type="button"
                className="btn-icon"
                onClick={() => { setSidebarOpen(true); setChatMembersOpen(false); }}
                title="Expand sidebar"
                aria-label="Expand sidebar"
              >
                <PanelLeftOpen size={16} />
              </button>
            )}
            <NewsTicker />
            {showDesktopDownload && (
              <a
                className="workspace-desktop-action"
                href="/download"
                title="Run local agents with Fizzer desktop"
                aria-label="Get desktop"
              >
                <Download size={13} aria-hidden="true" />
                <span>Get desktop</span>
              </a>
            )}
            <button
              id="orbit-btn"
              type="button"
              className="btn-icon"
              onClick={() => setOrbitOpen(true)}
              title="Graph"
              aria-label="Graph"
            >
              <svg width="16" height="16" viewBox="0 0 200 200" fill="none" stroke="currentColor" strokeWidth={10} aria-hidden="true">
                <mask id="orbit-cut">
                  <rect width="200" height="200" fill="white" />
                  <circle cx="160" cy="100" r="20" fill="black" />
                  <circle cx="100" cy="40" r="20" fill="black" />
                  <circle cx="40" cy="100" r="20" fill="black" />
                  <circle cx="100" cy="160" r="20" fill="black" />
                </mask>
                <circle cx="100" cy="100" r="60" mask="url(#orbit-cut)" />
                <circle cx="160" cy="100" r="20" />
                <circle cx="100" cy="40" r="20" />
                <circle cx="40" cy="100" r="20" />
                <circle cx="100" cy="160" r="20" />
              </svg>
            </button>
            <button
              id="community-updates-btn"
              type="button"
              className="btn-icon workspace-updates-btn"
              onClick={() => {
                setUpdatesOpen(true);
                void loadCommunityUpdates();
              }}
              title="Updates"
              aria-label={`${communityUpdates.counts.total || 'No'} unread updates`}
            >
              <Bell size={16} />
              {communityUpdates.counts.total > 0 && (
                <span className="workspace-updates-badge">
                  {communityUpdates.counts.total >= 99 ? '99+' : communityUpdates.counts.total}
                </span>
              )}
            </button>
            <button
              id="session-manager-btn"
              type="button"
              className="btn-icon workspace-session-btn"
              onClick={() => setSessionManagerOpen(true)}
              title="Inspect running AI sessions"
              aria-label="Inspect running AI sessions"
            >
              <Activity size={16} />
              {Boolean(runnerHealth?.activeRuns) && (
                <span className="workspace-session-badge">{runnerHealth!.activeRuns}</span>
              )}
            </button>
            {activeVaultId && vaultSidebarChannel && !chatMembersOpen && <button
              id="chat-members-expand-btn"
              type="button"
              className="btn-icon chat-members-toolbar-btn"
              onClick={() => {
                setChatMembersOpen(true);
                if (isMobileViewport()) setSidebarOpen(false);
              }}
              title="Show vault members"
              aria-label="Show vault members"
            >
              <Users size={16} />
            </button>}
        </div>

        <div className="flex-1" style={{ position: 'relative', display: 'flex', overflow: 'hidden' }}>
          <PaneGrid
            node={layout}
            openTabs={openTabs}
            focusedPaneId={focusedPaneId}
            onFocusPane={setFocusedPaneId}
            onSelectTab={selectTabInPane}
            onCloseTab={closeTab}
            onCloseOtherTabs={closeOtherTabs}
            onDropTab={handleDropTab}
            onDropNote={handleDropNote}
            onResize={handleResizeSplit}
            onCreateNote={handleCreateNoteInPane}
            onCreateTab={handleCreateTabInPane}
            onCreateChat={handleCreateChatInPane}
            onOpenSuperkanban={openSuperkanban}
            onDetachTab={handleDetachTab}
            sidebarOpen={sidebarOpen}
            onToggleSidebar={() => {
              setSidebarOpen((open) => {
                const next = !open;
                if (next && isMobileViewport()) setChatMembersOpen(false);
                return next;
              });
            }}
            renderContent={renderTabContent}
          />
          {activeVaultId && vaultSidebarChannel && (
            <Suspense fallback={null}>
              <ChatView
                channelId={vaultSidebarChannel}
                channelName={notes.find((note) => note.id === vaultSidebarChannel)?.title || 'Vault'}
                currentUser={currentUsername}
                presence={applyLocalUserProfile(chatPresenceByChannel[vaultSidebarChannel] ?? EMPTY_CHAT_PRESENCE, user)}
                availableAgents={AVAILABLE_CHAT_AGENTS}
                registeredAgents={chatState.registeredAgentsByChannel[vaultSidebarChannel] ?? EMPTY_CHAT_AGENTS}
                vaultAgents={vaultAgents}
                runnerHealth={runnerHealth}
                onRegisterAgent={handleRegisterChatAgent}
                onRemoveAgent={handleRemoveChatAgent}
                onUpsertVaultAgent={handleUpsertVaultAgent}
                onDeleteVaultAgent={handleDeleteVaultAgent}
                onDeleteAgentProfile={handleDeleteAgentProfile}
                onAddVaultAgentToChannel={handleAddVaultAgentToChannel}
                onInviteUser={handleInviteChatUser}
                onRemoveParticipant={handleRemoveChatParticipant}
                onLeaveChannel={handleLeaveChatChannel}
                onSendMessage={handleSendChatMessage}
                onCancelRun={handleCancelChatRun}
                notes={notes}
                onOpenNote={openNote}
                membersOpen={chatMembersOpen}
                onMembersOpenChange={setChatMembersOpen}
                vaultId={activeVaultId}
                sidebarMode="only"
              />
            </Suspense>
          )}
        </div>
      </div>
      {sessionManagerOpen && (
        <SessionManager
          open
          runnerOnline={Boolean(runnerHealth?.online)}
          focusSessionId={focusSessionId}
          onFocusHandled={() => setFocusSessionId(null)}
          onClose={() => { setFocusSessionId(null); setSessionManagerOpen(false); }}
          onOpenChat={async (vaultId, channelId, channelTitle) => {
            if (activeVaultIdRef.current !== vaultId) {
              switchVaultWorkspace(vaultId);
              await loadVaultData(vaultId);
            }
            openChatChannel(channelId, channelTitle);
            setSessionManagerOpen(false);
          }}
          onCancel={handleCancelChatRun}
          onInterrogate={async (vaultId, channelId, message) => {
            if (activeVaultIdRef.current !== vaultId) {
              switchVaultWorkspace(vaultId);
              await loadVaultData(vaultId);
            }
            await handleSendChatMessage(channelId, message);
          }}
        />
      )}

      {searchOpen && (
        <Suspense fallback={null}>
          <SearchOverlay
            open
            onClose={() => setSearchOpen(false)}
            vaultId={activeVaultId}
            onSelectNote={(id, messageId) => {
              openNote(id);
              if (messageId) setChatJumpTarget({ channelId: id, messageId });
            }}
          />
        </Suspense>
      )}
      {commandPaletteOpen && (
        <Suspense fallback={null}>
          <CommandPalette open onClose={() => setCommandPaletteOpen(false)} notes={notes} onSelectNote={(id) => openNote(id)} onCreateNote={handleCreateNote} />
        </Suspense>
      )}
      {orbitOpen && (
        <Suspense fallback={null}>
          <ModalShell
            backdropClassName="overlay-backdrop orbit-backdrop"
            dialogClassName="orbit-modal"
            ariaLabel="Graph"
            onClose={() => setOrbitOpen(false)}
          >
            <OrbitGraph
              vaultId={activeVaultId}
              onOpenNote={(id) => {
                setOrbitOpen(false);
                openNote(id);
              }}
            />
          </ModalShell>
        </Suspense>
      )}
      {updatesOpen && (
        <Suspense fallback={null}>
          <UpdatesModal
            open
            loading={communityUpdatesLoading}
            updates={communityUpdates}
            error={communityUpdatesError}
            onClose={() => setUpdatesOpen(false)}
            onRefresh={() => void loadCommunityUpdates()}
            onMarkAllRead={() => void markAllCommunityUpdatesRead()}
            onOpenItem={(item) => void openCommunityUpdate(item)}
          />
        </Suspense>
      )}
      {adminOpen && (
        <Suspense fallback={null}>
          <AdminPanel onClose={() => setAdminOpen(false)} />
        </Suspense>
      )}
      <Suspense fallback={null}><AndroidUpdatePrompt /></Suspense>

      {notice && <div className="toast" role="status">{notice}</div>}
    </main>
  );
}
