/**
 * @file Sidebar.tsx — Folder tree navigation and vault controls
 *
 * Renders the left sidebar panel containing:
 * - Inset vault rail beside the folder/channel tree
 * - Quick-action buttons (new note, new folder, search)
 * - Vault management dialog for create/join and selected-vault management
 * - Recursive folder tree with expandable folders and note items
 * - User info footer with logout
 *
 * Organisation gestures:
 * - Right-click a note or folder for a context menu (move/delete/rename/new).
 * - Drag a note or folder onto a folder (or the "Notes" header) to move it.
 *
 * Notes and folders keep their explicit drag order within each parent.
 *
 * @component
 */

import { memo, useState, useMemo, useEffect, useLayoutEffect, useRef } from 'react';
import { vaultDetailsLabel, type CommunityUpdates, type Vault, type Folder, type NoteSummary, type User } from '../api';
import { NOTE_DND_TYPE, noteEmbedMarkdown } from '../docEmbeds';
import { usePopupMenu } from '../ui/popupMenu';
import {
  YOUTUBE_EMBED_CONTROL_EVENT,
  YOUTUBE_EMBED_STATE_EVENT,
  type YouTubeEmbedControlDetail,
  type YouTubeEmbedStateDetail,
} from '../mediaLinks';
import { CHAT_NOTE_MARKER } from '../chat/shared';
import type { ChannelAgentActivity } from '../chat/messageStore';
import {
  Folder as FolderIcon, FolderOpen, FileText, Pin, Edit2, FolderPlus,
  Search, ChevronRight, MoreHorizontal, PanelLeftClose, LogOut, Trash2, FilePlus, FolderInput, Pencil, RefreshCw,
  Hash, Unlink, ShieldCheck, SkipBack, Play, Pause, SkipForward, Music2, Plus, LogIn, Compass, Mail, Settings, X,
} from 'lucide-react';

export function vaultOptionLabel(vault: Vault): string {
  return `${vault.name} · ${vaultDetailsLabel(vault)}`;
}

const FOLDER_DND_TYPE = 'application/x-cascade-folder';
const ROOT_DROP_ID = '__root__';

interface SidebarProps {
  user: User;
  vaults: Vault[];
  activeVaultId: string | null;
  folders: Folder[];
  notes: NoteSummary[];
  activeNoteId: string | null;
  updateCounts: CommunityUpdates['counts'];
  agentActivity: Readonly<Record<string, ChannelAgentActivity>>;
  channelVaultIds: Readonly<Record<string, string>>;
  showAgentMemory: boolean;
  onSelectVault: (id: string) => void;
  onCreateVault: (name: string) => Promise<boolean>;
  vaultListLoading?: boolean;
  vaultListError?: string;
  onRetryVaults?: () => void;
  onManageVault: (id: string) => void;
  onJoinVault: (inviteLink: string) => Promise<boolean>;
  onOpenPublicVaults: () => void;
  onOpenDirectMessages: () => void;
  onSelectNote: (id: string) => void;
  onOpenNoteInNewTab: (id: string) => void;
  onNewNote: () => void;
  onCreateChannel: (folderId?: string | null) => Promise<{ id: string; title: string } | undefined>;
  onNewNoteInFolder: (folderId: string | null) => void;
  onSearch: () => void;
  onCollapse: () => void;
  onLogout: () => void;
  onOpenAccount: () => void;
  isOwner?: boolean;
  onOpenAdmin?: () => void;
  onDeleteNote: (id: string) => void;
  onMoveNote: (id: string, folderId: string | null, position?: number) => void;
  onUnlistNote: (id: string) => void;
  onMoveFolder: (id: string, parentId: string | null, position: number) => void;
  onCreateFolder: (parentId?: string | null) => Promise<Folder | undefined>;
  onRenameFolder: (id: string, name: string) => void;
  onRenameNote: (id: string, title: string) => Promise<void>;
  onDeleteFolder: (id: string) => void;
}

type ContextMenu =
  | { x: number; y: number; kind: 'note'; id: string }
  | { x: number; y: number; kind: 'folder'; id: string }
  | { x: number; y: number; kind: 'vault'; id: string }
  | { x: number; y: number; kind: 'root' };

type ElectronUpdateAPI = {
  updateAndRestart?: () => Promise<{ success: boolean; refreshing?: boolean; error?: string }>;
  onUpdateFailed?: (callback: (payload: { error?: string }) => void) => () => void;
};

type DropPlacement = 'before' | 'inside' | 'after';

/** Final insertion index after removing the dragged item from its old slot. */
export function sidebarInsertionIndex(
  orderedIds: string[],
  movingId: string,
  targetId: string,
  placement: Exclude<DropPlacement, 'inside'>,
) {
  const withoutMoving = orderedIds.filter((id) => id !== movingId);
  const targetIndex = withoutMoving.indexOf(targetId);
  if (targetIndex < 0) return withoutMoving.length;
  return targetIndex + (placement === 'after' ? 1 : 0);
}

export function sortSidebarNotes(notes: NoteSummary[]) {
  return [...notes].sort((a, b) =>
    a.position - b.position
    || new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
    || a.title.localeCompare(b.title),
  );
}

type ConnectorBox = Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>;

export function vaultSelectionConnectorPath(
  sidebarBox: ConnectorBox,
  vaultBox: ConnectorBox,
  noteBox: ConnectorBox,
) {
  const startX = vaultBox.right - sidebarBox.left;
  const endX = noteBox.left - sidebarBox.left;
  const bendX = startX + (endX - startX) / 2;
  const startTop = vaultBox.top - sidebarBox.top;
  const startBottom = vaultBox.bottom - sidebarBox.top;
  const endTop = noteBox.top - sidebarBox.top;
  const endBottom = noteBox.bottom - sidebarBox.top;
  return `M ${startX} ${startTop} C ${bendX} ${startTop}, ${bendX} ${endTop}, ${endX} ${endTop} `
    + `L ${endX} ${endBottom} C ${bendX} ${endBottom}, ${bendX} ${startBottom}, ${startX} ${startBottom} Z`;
}

export function isMp3Link(label: string, href: string) {
  const normalizedLabel = label.trim().toLowerCase();
  const normalizedHref = href.toLowerCase();
  return normalizedLabel.endsWith('.mp3')
    || normalizedHref.includes('audio/mpeg')
    || normalizedHref.split(/[?#]/)[0].endsWith('.mp3');
}

type MediaTrack =
  | { kind: 'audio'; name: string; url: string }
  | { kind: 'youtube'; name: string; url: string; videoId: string };

export const Sidebar = memo(function Sidebar({
  user,
  vaults,
  activeVaultId,
  folders,
  notes,
  activeNoteId,
  updateCounts,
  agentActivity,
  channelVaultIds,
  showAgentMemory,
  onSelectVault,
  onCreateVault,
  vaultListLoading,
  vaultListError,
  onRetryVaults,
  onManageVault,
  onJoinVault,
  onOpenPublicVaults,
  onOpenDirectMessages,
  onSelectNote,
  onOpenNoteInNewTab,
  onNewNote,
  onCreateChannel,
  onNewNoteInFolder,
  onSearch,
  onCollapse,
  onLogout,
  onOpenAccount,
  isOwner,
  onOpenAdmin,
  onDeleteNote,
  onMoveNote,
  onUnlistNote,
  onMoveFolder,
  onCreateFolder,
  onRenameFolder,
  onRenameNote,
  onDeleteFolder,
}: SidebarProps) {
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  // When the context menu shows the "Move to…" folder picker for a note.
  const [moveMenu, setMoveMenu] = useState(false);
  const contextMenuRef = usePopupMenu<HTMLDivElement>(contextMenu, moveMenu);
  // Folder currently being renamed inline (also used right after creation).
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [updating, setUpdating] = useState(false);
  const [vaultMenuOpen, setVaultMenuOpen] = useState(false);
  const [creatingVault, setCreatingVault] = useState(false);
  const [newVaultName, setNewVaultName] = useState('');
  const [creatingVaultBusy, setCreatingVaultBusy] = useState(false);
  const [vaultFormError, setVaultFormError] = useState('');
  const [joiningVault, setJoiningVault] = useState(false);
  const [vaultInviteLink, setVaultInviteLink] = useState('');
  const [joiningVaultBusy, setJoiningVaultBusy] = useState(false);
  const [audioTracks, setAudioTracks] = useState<MediaTrack[]>([]);
  const [audioTrackIndex, setAudioTrackIndex] = useState(0);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const vaultManagerRef = useRef<HTMLDivElement>(null);
  const [selectionConnector, setSelectionConnector] = useState('');
  const autoplayAudioRef = useRef(false);
  // Drop target highlight: a folder id, or ROOT_DROP_ID for the root area.
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ id: string; placement: DropPlacement } | null>(null);

  useEffect(() => {
    if (!vaultMenuOpen) return;
    const dialog = vaultManagerRef.current;
    const previous = document.activeElement as HTMLElement | null;
    dialog?.querySelector<HTMLElement>('input, button')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Tab' && dialog) {
        const items = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)'));
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
      if (event.key === 'Escape') setVaultMenuOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('keydown', onKeyDown); if (previous?.isConnected) previous.focus(); };
  }, [vaultMenuOpen]);

  const activeVault = useMemo(
    () => vaults.find((v) => v.id === activeVaultId),
    [vaults, activeVaultId],
  );

  const agentActivityByVault = useMemo(() => {
    const grouped: Record<string, ChannelAgentActivity> = {};
    for (const [channelId, status] of Object.entries(agentActivity)) {
      const vaultId = channelVaultIds[channelId]
        ?? (notes.some((note) => note.id === channelId) ? activeVaultId : null);
      if (!vaultId) continue;
      if (status === 'running' || !grouped[vaultId]) grouped[vaultId] = status;
    }
    return grouped;
  }, [activeVaultId, agentActivity, channelVaultIds, notes]);

  const activityKind = (agentStatus: ChannelAgentActivity | undefined, hasHumanUpdates: boolean) => (
    agentStatus === 'running'
      ? 'agent-running'
      : agentStatus === 'finished'
        ? 'agent-finished'
        : hasHumanUpdates
          ? 'human'
          : null
  );

  const activityLabel = (kind: ReturnType<typeof activityKind>) => (
    kind === 'agent-running'
      ? 'Agent work in progress'
      : kind === 'agent-finished'
        ? 'Finished agent work'
        : 'New human updates'
  );

  const activityDot = (kind: ReturnType<typeof activityKind>) => kind && (
    <span
      className={`activity-dot is-${kind}`}
      aria-label={activityLabel(kind)}
      title={activityLabel(kind)}
    />
  );

  const activeVaultHasTargetActivity = notes.some((note) => activityKind(
    agentActivity[note.id],
    (updateCounts.byTarget[note.id] || 0) > 0,
  ) !== null);

  useLayoutEffect(() => {
    const sidebar = sidebarRef.current;
    if (!sidebar || !activeVaultId || !activeNoteId) {
      setSelectionConnector('');
      return;
    }

    let frame = 0;
    let disposed = false;
    const updateConnector = () => {
      const vaultButton = sidebar.querySelector<HTMLElement>(`[data-vault-id="${activeVaultId}"]`);
      const noteButton = document.getElementById(`note-${activeNoteId}`);
      if (!vaultButton || !noteButton || !sidebar.contains(noteButton)) {
        setSelectionConnector((current) => current === '' ? current : '');
        return;
      }
      const next = vaultSelectionConnectorPath(
        sidebar.getBoundingClientRect(),
        vaultButton.getBoundingClientRect(),
        noteButton.getBoundingClientRect(),
      );
      setSelectionConnector((current) => current === next ? current : next);
    };

    const scheduleConnectorUpdate = () => {
      if (disposed || frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        updateConnector();
      });
    };

    // Measure immediately, then once more after the first committed frame.
    // The vault rail and note list can finish mounting without changing the
    // sidebar's own border box, so observing only the sidebar misses that
    // initial layout change.
    updateConnector();
    scheduleConnectorUpdate();
    const observer = new ResizeObserver(scheduleConnectorUpdate);
    observer.observe(sidebar);
    const vaultButton = sidebar.querySelector<HTMLElement>(`[data-vault-id="${activeVaultId}"]`);
    const noteButton = document.getElementById(`note-${activeNoteId}`);
    if (vaultButton) observer.observe(vaultButton);
    if (noteButton && sidebar.contains(noteButton)) observer.observe(noteButton);
    void document.fonts?.ready.then(scheduleConnectorUpdate);
    sidebar.addEventListener('scroll', scheduleConnectorUpdate, true);
    window.addEventListener('resize', scheduleConnectorUpdate);
    return () => {
      disposed = true;
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
      sidebar.removeEventListener('scroll', scheduleConnectorUpdate, true);
      window.removeEventListener('resize', scheduleConnectorUpdate);
    };
  }, [activeNoteId, activeVaultId, expandedFolders, folders, notes, vaults]);

  const visibleFolders = useMemo(() => {
    if (showAgentMemory) return folders;
    const hidden = new Set(folders.filter((folder) => folder.parent_id === null && folder.name === '_agent').map((folder) => folder.id));
    let changed = true;
    while (changed) {
      changed = false;
      for (const folder of folders) {
        if (folder.parent_id && hidden.has(folder.parent_id) && !hidden.has(folder.id)) {
          hidden.add(folder.id);
          changed = true;
        }
      }
    }
    return folders.filter((folder) => !hidden.has(folder.id));
  }, [folders, showAgentMemory]);

  const rootFolders = useMemo(
    () => visibleFolders.filter((f) => f.parent_id === null).sort((a, b) => a.position - b.position),
    [visibleFolders],
  );

  const listedNotes = useMemo(() => notes.filter((note) => note.is_listed !== 0), [notes]);

  const notesByFolder = useMemo(() => {
    const map = new Map<string | null, NoteSummary[]>();
    for (const note of listedNotes) {
      const key = note.folder_id;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(note);
    }
    for (const [key, arr] of map) map.set(key, sortSidebarNotes(arr));
    return map;
  }, [listedNotes]);

  const childFolders = useMemo(() => {
    const map = new Map<string | null, Folder[]>();
    for (const f of visibleFolders) {
      const key = f.parent_id;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(f);
    }
    for (const [, arr] of map) arr.sort((a, b) => a.position - b.position);
    return map;
  }, [visibleFolders]);

  // Flattened folder list (with depth) for the "Move to…" picker.
  const flatFolders = useMemo(() => {
    const out: { folder: Folder; depth: number }[] = [];
    const walk = (parentId: string | null, depth: number) => {
      for (const f of childFolders.get(parentId) ?? []) {
        out.push({ folder: f, depth });
        walk(f.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [childFolders]);

  const rootNotes = notesByFolder.get(null) ?? [];
  const countLabel = (count: number) => count >= 99 ? '99+' : String(count);

  // Close the context menu on any outside click or Escape.
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => { setContextMenu(null); setMoveMenu(false); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (contextMenu.kind === 'vault') {
        sidebarRef.current?.querySelector<HTMLElement>(`[data-vault-id="${contextMenu.id}"]`)?.focus();
      }
      close();
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [contextMenu]);

  useEffect(() => {
    const api = (window as unknown as { electronAPI?: ElectronUpdateAPI }).electronAPI;
    if (!api?.onUpdateFailed) return;
    return api.onUpdateFailed((payload) => {
      setUpdating(false);
      alert('Desktop update failed: ' + (payload?.error || 'Unknown error'));
    });
  }, []);

  useEffect(() => {
    const mediaTrackFor = (anchor: HTMLAnchorElement): MediaTrack | null => {
      const label = (anchor.textContent || '').trim();
      if (isMp3Link(label, anchor.href)) {
        return { kind: 'audio', name: (label || 'Audio').replace(/\.mp3$/i, ''), url: anchor.href };
      }
      return null;
    };
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest('a') : null;
      if (!(target instanceof HTMLAnchorElement) || !mediaTrackFor(target)) return;
      event.preventDefault();
      event.stopPropagation();
      const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a'));
      const seen = new Set<string>();
      const tracks = links.flatMap((anchor) => {
        const track = mediaTrackFor(anchor);
        if (!track || !anchor.href || seen.has(anchor.href)) return [];
        seen.add(anchor.href);
        return [track];
      });
      const index = Math.max(0, tracks.findIndex((track) => track.url === target.href));
      audioRef.current?.pause();
      autoplayAudioRef.current = true;
      setAudioTrackIndex(index);
      setAudioTracks(tracks);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  useEffect(() => {
    const track = audioTracks[audioTrackIndex];
    if (!track) return;
    if (track.kind === 'youtube') return;
    const audio = audioRef.current;
    if (!audio) return;
    audio.load();
    if (autoplayAudioRef.current) {
      void audio.play().catch(() => setAudioPlaying(false));
    }
  }, [audioTrackIndex, audioTracks]);

  useEffect(() => {
    const onEmbedState = (event: Event) => {
      const detail = (event as CustomEvent<YouTubeEmbedStateDetail>).detail;
      if (!detail?.videoId) return;
      if (detail.state === 1) {
        audioRef.current?.pause();
        setAudioTrackIndex(0);
        setAudioTracks([{ kind: 'youtube', name: detail.title || 'YouTube video', url: detail.url, videoId: detail.videoId }]);
      }
      setAudioPlaying(detail.state === 1);
    };
    window.addEventListener(YOUTUBE_EMBED_STATE_EVENT, onEmbedState);
    return () => window.removeEventListener(YOUTUBE_EMBED_STATE_EVENT, onEmbedState);
  }, []);

  function changeAudioTrack(offset: number, autoplay = audioPlaying) {
    if (audioTracks.length === 0) return;
    autoplayAudioRef.current = autoplay;
    setAudioTrackIndex((current) => (current + offset + audioTracks.length) % audioTracks.length);
  }

  function toggleAudioPlayback() {
    const track = audioTracks[audioTrackIndex];
    if (track?.kind === 'youtube') {
      const func = audioPlaying ? 'pauseVideo' : 'playVideo';
      window.dispatchEvent(new CustomEvent<YouTubeEmbedControlDetail>(YOUTUBE_EMBED_CONTROL_EVENT, {
        detail: { videoId: track.videoId, func },
      }));
      return;
    }
    const audio = audioRef.current;
    if (!audio || audioTracks.length === 0) return;
    if (audio.paused) void audio.play().catch(() => setAudioPlaying(false));
    else audio.pause();
  }

  function toggleFolder(folderId: string) {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }

  function expandFolder(folderId: string) {
    setExpandedFolders((prev) => new Set(prev).add(folderId));
  }

  function openMenu(e: React.MouseEvent, menu: ContextMenu) {
    e.preventDefault();
    e.stopPropagation();
    setMoveMenu(false);
    // Opens at the pointer; usePopupMenu clamps it back on-screen once measured.
    setContextMenu({ ...menu, x: e.clientX, y: e.clientY });
  }

  function startRename(folder: Folder) {
    setContextMenu(null);
    setEditingValue(folder.name);
    setEditingFolderId(folder.id);
  }

  function startRenameNote(note: NoteSummary) {
    setContextMenu(null);
    setEditingValue(note.title);
    setEditingNoteId(note.id);
  }

  function commitRename() {
    if (editingFolderId) {
      onRenameFolder(editingFolderId, editingValue);
      setEditingFolderId(null);
    } else if (editingNoteId) {
      void onRenameNote(editingNoteId, editingValue);
      setEditingNoteId(null);
    }
  }

  async function createFolder(parentId: string | null) {
    setContextMenu(null);
    if (parentId) expandFolder(parentId);
    const folder = await onCreateFolder(parentId);
    if (folder) startRename(folder);
  }

  async function createChannel(parentId: string | null) {
    setContextMenu(null);
    if (parentId) expandFolder(parentId);
    const channel = await onCreateChannel(parentId);
    if (channel) {
      setEditingValue(channel.title);
      setEditingNoteId(channel.id);
    }
  }

  // ─── Drag and drop ──────────────────────────────────────
  function noteDragProps(noteId: string) {
    return {
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        const note = notes.find((item) => item.id === noteId);
        e.dataTransfer.setData(NOTE_DND_TYPE, noteId);
        if (note) e.dataTransfer.setData('text/plain', noteEmbedMarkdown(note));
        e.dataTransfer.effectAllowed = 'copyMove';
      },
      onDragEnd: () => {
        setDragOverId(null);
        setDropHint(null);
      },
    };
  }

  function folderDragProps(folderId: string) {
    return {
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        e.dataTransfer.setData(FOLDER_DND_TYPE, folderId);
        e.dataTransfer.effectAllowed = 'move';
      },
      onDragEnd: () => {
        setDragOverId(null);
        setDropHint(null);
      },
    };
  }

  function isInvalidFolderTarget(folderId: string, targetFolderId: string | null) {
    if (folderId === targetFolderId) return true;
    let current = targetFolderId ? folders.find((f) => f.id === targetFolderId) : undefined;
    while (current) {
      if (current.parent_id === folderId) return true;
      current = current.parent_id ? folders.find((f) => f.id === current!.parent_id) : undefined;
    }
    return false;
  }

  function nextFolderPosition(parentId: string | null, movingFolderId: string) {
    return (childFolders.get(parentId) ?? []).filter((f) => f.id !== movingFolderId).length;
  }

  function rowPlacement(e: React.DragEvent, allowInside: boolean): DropPlacement {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = rect.height ? (e.clientY - rect.top) / rect.height : 0.5;
    if (!allowInside) return ratio < 0.5 ? 'before' : 'after';
    if (ratio < 0.25) return 'before';
    if (ratio > 0.75) return 'after';
    return 'inside';
  }

  function noteDropProps(targetNote: NoteSummary, siblings: NoteSummary[]) {
    return {
      onDragOver: (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes(NOTE_DND_TYPE)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        setDragOverId(null);
        setDropHint({ id: targetNote.id, placement: rowPlacement(e, false) });
      },
      onDragLeave: (e: React.DragEvent) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDropHint((current) => (current?.id === targetNote.id ? null : current));
      },
      onDrop: (e: React.DragEvent) => {
        const noteId = e.dataTransfer.getData(NOTE_DND_TYPE);
        if (!noteId) return;
        e.preventDefault();
        e.stopPropagation();
        if (noteId === targetNote.id) {
          setDropHint(null);
          return;
        }
        const placement = rowPlacement(e, false) as Exclude<DropPlacement, 'inside'>;
        const position = sidebarInsertionIndex(
          siblings.map((note) => note.id),
          noteId,
          targetNote.id,
          placement,
        );
        setDropHint(null);
        onMoveNote(noteId, targetNote.folder_id, position);
      },
    };
  }

  function folderDropProps(targetFolder: Folder, siblings: Folder[]) {
    return {
      onDragOver: (e: React.DragEvent) => {
        const isNote = e.dataTransfer.types.includes(NOTE_DND_TYPE);
        const isFolder = e.dataTransfer.types.includes(FOLDER_DND_TYPE);
        if (!isNote && !isFolder) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        const placement = isNote ? 'inside' : rowPlacement(e, true);
        setDragOverId(placement === 'inside' ? targetFolder.id : null);
        setDropHint({ id: targetFolder.id, placement });
      },
      onDragLeave: (e: React.DragEvent) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDragOverId((current) => (current === targetFolder.id ? null : current));
        setDropHint((current) => (current?.id === targetFolder.id ? null : current));
      },
      onDrop: (e: React.DragEvent) => {
        const noteId = e.dataTransfer.getData(NOTE_DND_TYPE);
        const folderId = e.dataTransfer.getData(FOLDER_DND_TYPE);
        if (!noteId && !folderId) return;
        e.preventDefault();
        e.stopPropagation();
        const placement = noteId ? 'inside' : rowPlacement(e, true);
        setDragOverId(null);
        setDropHint(null);

        if (noteId) {
          const targetNotes = notesByFolder.get(targetFolder.id) ?? [];
          onMoveNote(noteId, targetFolder.id, targetNotes.filter((note) => note.id !== noteId).length);
          expandFolder(targetFolder.id);
          return;
        }

        if (!folderId) return;
        if (placement === 'inside') {
          if (isInvalidFolderTarget(folderId, targetFolder.id)) return;
          onMoveFolder(folderId, targetFolder.id, nextFolderPosition(targetFolder.id, folderId));
          expandFolder(targetFolder.id);
          return;
        }

        const position = sidebarInsertionIndex(
          siblings.map((folder) => folder.id),
          folderId,
          targetFolder.id,
          placement,
        );
        onMoveFolder(folderId, targetFolder.parent_id, position);
      },
    };
  }

  function rootDropTargetProps() {
    const key = ROOT_DROP_ID;
    return {
      onDragOver: (e: React.DragEvent) => {
        const isNote = e.dataTransfer.types.includes(NOTE_DND_TYPE);
        const isFolder = e.dataTransfer.types.includes(FOLDER_DND_TYPE);
        if (!isNote && !isFolder) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setDropHint(null);
        if (dragOverId !== key) setDragOverId(key);
      },
      onDragLeave: () => setDragOverId((cur) => (cur === key ? null : cur)),
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        const noteId = e.dataTransfer.getData(NOTE_DND_TYPE);
        const folderId = e.dataTransfer.getData(FOLDER_DND_TYPE);
        setDragOverId(null);
        if (noteId) {
          onMoveNote(noteId, null, rootNotes.filter((note) => note.id !== noteId).length);
          return;
        }
        if (folderId) {
          onMoveFolder(folderId, null, nextFolderPosition(null, folderId));
        }
      },
    };
  }

  // Move-to-root drop handlers, shared by the "Notes" header and the empty
  // area of the folder tree.
  const rootDropProps = rootDropTargetProps();

  function dropClass(id: string) {
    if (dropHint?.id !== id) return '';
    return ` is-drop-${dropHint.placement}`;
  }

  /**
   * The inline rename field shared by folder and note rows. Only the Escape
   * behavior differs (which editing state to clear), passed as `onCancel`.
   */
  function renameInput(onCancel: () => void) {
    return (
      <input
        className="tree-rename-input"
        value={editingValue}
        autoFocus
        spellCheck={false}
        onChange={(e) => setEditingValue(e.target.value)}
        onBlur={commitRename}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
          else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        }}
      />
    );
  }

  /** Recursively render a folder row with its children. */
  function renderFolder(folder: Folder, depth: number) {
    const isExpanded = expandedFolders.has(folder.id);
    const folderNotes = notesByFolder.get(folder.id) ?? [];
    const subFolders = childFolders.get(folder.id) ?? [];
    const paddingLeft = 12 + depth * 14;
    const childCount = folderNotes.length + subFolders.length;

    return (
      <div key={folder.id}>
        {editingFolderId === folder.id ? (
          <div className="tree-item tree-editing" style={{ paddingLeft }}>
            <span className="tree-chevron"><ChevronRight size={14} /></span>
            <span className="tree-icon"><FolderIcon size={16} /></span>
            {renameInput(() => setEditingFolderId(null))}
          </div>
        ) : (
          <button
            id={`folder-${folder.id}`}
            className={`tree-item is-folder${dragOverId === folder.id ? ' drag-over' : ''}${dropClass(folder.id)}`}
            style={{ paddingLeft }}
            onClick={() => toggleFolder(folder.id)}
            onContextMenu={(e) => openMenu(e, { x: 0, y: 0, kind: 'folder', id: folder.id })}
            {...folderDragProps(folder.id)}
            {...folderDropProps(folder, childFolders.get(folder.parent_id) ?? [])}
          >
            <span className={`tree-chevron ${isExpanded ? 'expanded' : ''}`}><ChevronRight size={14} /></span>
            <span className="tree-icon">{isExpanded ? <FolderOpen size={16} /> : <FolderIcon size={16} />}</span>
            <span className="tree-label">{folder.name}</span>
            {childCount > 0 && <span className="tree-count">{childCount}</span>}
          </button>
        )}
        {isExpanded && (
          <div className="tree-children">
            {subFolders.map((sf) => renderFolder(sf, depth + 1))}
            {folderNotes.map((note) => renderNote(note, depth + 1))}
          </div>
        )}
      </div>
    );
  }

  /** Render a single note item in the sidebar tree. */
  function renderNote(note: NoteSummary, depth: number) {
    const paddingLeft = 12 + depth * 14 + 16;
    const isChatChannel = note.content_preview.trim().startsWith(CHAT_NOTE_MARKER);
    const noteActivity = activityKind(agentActivity[note.id], (updateCounts.byTarget[note.id] || 0) > 0);
    if (editingNoteId === note.id) {
      return (
        <div key={note.id} className="tree-item tree-editing" style={{ paddingLeft }}>
          <span className="tree-icon">{isChatChannel ? <Hash size={16} /> : <FileText size={16} />}</span>
          {renameInput(() => setEditingNoteId(null))}
        </div>
      );
    }
    return (
      <button
        key={note.id}
        id={`note-${note.id}`}
        className={`tree-item${isChatChannel ? ' is-channel' : ' is-note'}${note.id === activeNoteId ? ' active' : ''}${dropClass(note.id)}`}
        style={{ paddingLeft }}
        onClick={(e) => (e.metaKey || e.ctrlKey ? onOpenNoteInNewTab(note.id) : onSelectNote(note.id))}
        onContextMenu={(e) => openMenu(e, { x: 0, y: 0, kind: 'note', id: note.id })}
        {...noteDragProps(note.id)}
        {...noteDropProps(note, notesByFolder.get(note.folder_id) ?? [])}
      >
        <span className="tree-icon">{isChatChannel ? <Hash size={15} /> : <FileText size={15} />}</span>
        <span className="tree-label">{note.title || 'Untitled'}</span>
        {activityDot(noteActivity)}
        {note.is_pinned ? <span className="pin-icon"><Pin size={11} fill="currentColor" /></span> : null}
        {note.tags.length > 0 && (
          <span className="tree-tags">
            {note.tags.slice(0, 3).map((tag) => (
              <span key={tag} className="tag-dot" title={tag} />
            ))}
          </span>
        )}
      </button>
    );
  }

  const quickActions = [
    { id: 'new-note', title: 'New note', icon: <Edit2 size={15} />, onClick: onNewNote },
    { id: 'new-folder', title: 'New folder', icon: <FolderPlus size={15} />, onClick: () => { void createFolder(null); } },
    { id: 'new-channel', title: 'New channel', icon: <Hash size={15} />, onClick: () => { void createChannel(null); } },
    { id: 'search', title: 'Search', icon: <Search size={15} />, onClick: onSearch },
  ];
  const actionButtons = (location: string) => quickActions.map((action) => (
    <button key={action.id} id={`${action.id}-btn-${location}`} className="btn-icon" onClick={action.onClick} title={action.title}>{action.icon}</button>
  ));

  const submitNewVault = async () => {
    const name = newVaultName.trim();
    if (!name || creatingVaultBusy) return;
    setCreatingVaultBusy(true);
    const created = await onCreateVault(name);
    setCreatingVaultBusy(false);
    if (!created) { setVaultFormError('Could not create vault. Check the name and try again.'); return; }
    setVaultFormError('');
    setNewVaultName('');
    setCreatingVault(false);
    setVaultMenuOpen(false);
  };

  const submitJoinVault = async () => {
    const inviteLink = vaultInviteLink.trim();
    if (!inviteLink || joiningVaultBusy) return;
    setJoiningVaultBusy(true);
    const joined = await onJoinVault(inviteLink);
    setJoiningVaultBusy(false);
    if (!joined) { setVaultFormError('Could not join vault. Check the invite link and try again.'); return; }
    setVaultFormError('');
    setVaultInviteLink('');
    setJoiningVault(false);
    setVaultMenuOpen(false);
  };

  return (
    <aside ref={sidebarRef} className="sidebar" id="sidebar" style={{ gridColumn: 1 }}>
      <nav className="vault-rail" aria-label="Vaults">
        <div className="vault-rail-list">
          {vaults.map((vault) => {
            const vaultActivity = vault.id === activeVaultId && activeVaultHasTargetActivity
              ? null
              : activityKind(
                agentActivityByVault[vault.id],
                (updateCounts.byVault[vault.id] || 0) > 0,
              );
            const initials = vault.name
              .split(/\s+/)
              .filter(Boolean)
              .slice(0, 2)
              .map((part) => part[0])
              .join('')
              .toUpperCase() || 'V';
            return (
              <div className="vault-rail-item" key={vault.id}>
                <button
                  type="button"
                  className={`vault-rail-button${vault.id === activeVaultId ? ' is-active' : ''}`}
                  data-vault-id={vault.id}
                  onClick={() => onSelectVault(vault.id)}
                  onContextMenu={(event) => openMenu(event, { x: 0, y: 0, kind: 'vault', id: vault.id })}
                  onKeyDown={(event) => {
                    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
                    event.preventDefault();
                    const rect = event.currentTarget.getBoundingClientRect();
                    setContextMenu({ x: rect.right, y: rect.top, kind: 'vault', id: vault.id });
                  }}
                  aria-label={`Open vault ${vault.name}`}
                  aria-current={vault.id === activeVaultId ? 'page' : undefined}
                  title={vaultOptionLabel(vault)}
                >
                  <span className="vault-rail-initials" aria-hidden="true">{initials}</span>
                  {activityDot(vaultActivity)}
                </button>
                <button type="button" className="vault-rail-action vault-rail-options"
                  aria-label={`Options for ${vault.name}`} title={`Options for ${vault.name}`}
                  aria-haspopup="menu" aria-expanded={contextMenu?.kind === 'vault' && contextMenu.id === vault.id}
                  onClick={(event) => {
                    event.stopPropagation();
                    const rect = event.currentTarget.getBoundingClientRect();
                    setContextMenu({ x: rect.right, y: rect.top, kind: 'vault', id: vault.id });
                  }}>
                  <MoreHorizontal size={14} aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>
        <div className="vault-rail-actions">
          <button type="button" className="vault-rail-action" onClick={onOpenPublicVaults} aria-label="Browse public vaults" title="Browse public vaults">
            <Compass size={18} aria-hidden="true" />
          </button>
          <button type="button" className="vault-rail-action" onClick={() => { setCreatingVault(true); setJoiningVault(false); setVaultMenuOpen(true); }} aria-label="Create vault" title="Create vault">
            <Plus size={19} aria-hidden="true" />
          </button>
        </div>
      </nav>

      {selectionConnector && (
        <svg className="vault-selection-connector" aria-hidden="true">
          <path d={selectionConnector} />
        </svg>
      )}

      <div className="sidebar-panel">
      {/* Header */}
      <div className="sidebar-header">
        <div className="vault-name vault-current-label">
          <span className="vault-name-copy">
            <span className="vault-name-text">{activeVault?.name || 'Fizzer'}</span>
            <span className="vault-name-meta">
              {activeVault ? vaultDetailsLabel(activeVault) : 'Create or join a vault'}
              </span>
          </span>
        </div>
        <div className="sidebar-actions sidebar-actions-desktop" role="toolbar" aria-label="Sidebar actions">{actionButtons('desktop')}</div>
        <button className="btn-icon sidebar-mobile-collapse" onClick={onCollapse} title="Collapse sidebar"><PanelLeftClose size={16} /></button>
      </div>

      {vaultListError && <p role="alert">{vaultListError} <button type="button" onClick={onRetryVaults}>Retry vaults</button></p>}
      {vaultMenuOpen && (
        <div ref={vaultManagerRef} className="vault-manager-menu" role="dialog" aria-modal="true" aria-label="Vault workspace">
          <div className="vault-manager-shell">
            <div className="vault-manager-heading">
              <div><span>Add a vault</span><small>{vaults.length} {vaults.length === 1 ? 'vault' : 'vaults'}</small></div>
              <button type="button" className="vault-manager-close" onClick={() => setVaultMenuOpen(false)} aria-label="Close vault workspace"><X size={18} /></button>
            </div>

            <section className="vault-manager-section" aria-label="Vault status">
              {vaultListLoading ? <p role="status">Loading vaults…</p> : !vaults.length && !vaultListError ? <p>No vaults yet. Create a vault or join with an invite link below.</p> : null}
              {vaultListError && <p role="alert">{vaultListError} <button type="button" onClick={onRetryVaults}>Retry</button></p>}
            </section>

            {vaultFormError && <p role="alert">{vaultFormError}</p>}
            <section className="vault-manager-section" aria-labelledby="vault-manager-manage">
              <h2 className="vault-manager-section-title" id="vault-manager-manage">Create or join a vault</h2>
              <div className="vault-manager-action-grid" aria-label="Create or join a vault">
                <button type="button" className="vault-manager-action vault-manager-discover" onClick={() => { setVaultMenuOpen(false); onOpenPublicVaults(); }}>
                  <span className="vault-manager-action-icon" aria-hidden="true"><Compass size={28} /></span>
                  <span className="vault-manager-copy"><strong>Browse public vaults</strong><small>Find open communities</small></span>
                </button>
                {creatingVault ? (
                  <div className="vault-manager-create-form vault-manager-action-form">
                    <strong>New vault</strong>
                    <input
                      autoFocus
                      value={newVaultName}
                      placeholder="Vault name"
                      aria-label="New vault name"
                      disabled={creatingVaultBusy}
                      onChange={(event) => setNewVaultName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void submitNewVault();
                        if (event.key === 'Escape') {
                          setCreatingVault(false);
                          setNewVaultName('');
                        }
                      }}
                    />
                    <div className="vault-manager-form-actions">
                      <button type="button" onClick={() => { setCreatingVault(false); setNewVaultName(''); }}>Cancel</button>
                      <button type="button" disabled={!newVaultName.trim() || creatingVaultBusy} onClick={() => void submitNewVault()}>
                        {creatingVaultBusy ? 'Creating' : 'Create'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button type="button" className="vault-manager-action vault-manager-create" onClick={() => { setJoiningVault(false); setCreatingVault(true); }}>
                    <span className="vault-manager-action-icon" aria-hidden="true"><Plus size={28} /></span>
                    <span className="vault-manager-copy"><strong>New vault</strong><small>Start a private workspace</small></span>
                  </button>
                )}
                {joiningVault ? (
                  <div className="vault-manager-create-form vault-manager-action-form">
                    <strong>Join vault</strong>
                    <input
                      autoFocus
                      value={vaultInviteLink}
                      placeholder="Paste vault invite link"
                      aria-label="Vault invite link"
                      disabled={joiningVaultBusy}
                      onChange={(event) => setVaultInviteLink(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void submitJoinVault();
                        if (event.key === 'Escape') {
                          setJoiningVault(false);
                          setVaultInviteLink('');
                        }
                      }}
                    />
                    <div className="vault-manager-form-actions">
                      <button type="button" onClick={() => { setJoiningVault(false); setVaultInviteLink(''); }}>Cancel</button>
                      <button type="button" disabled={!vaultInviteLink.trim() || joiningVaultBusy} onClick={() => void submitJoinVault()}>
                        {joiningVaultBusy ? 'Joining' : 'Join'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button type="button" className="vault-manager-action vault-manager-join" onClick={() => { setCreatingVault(false); setJoiningVault(true); }}>
                    <span className="vault-manager-action-icon" aria-hidden="true"><LogIn size={28} /></span>
                    <span className="vault-manager-copy"><strong>Join vault</strong><small>Use an invite link</small></span>
                  </button>
                )}
              </div>
            </section>
          </div>
        </div>
      )}

      <div className="sidebar-actions sidebar-actions-mobile">{actionButtons('mobile')}</div>

      {/* Folder tree. The "Notes" header doubles as the move-to-root drop target. */}
      <div
        className={`sidebar-section-label ${dragOverId === ROOT_DROP_ID ? 'drag-over' : ''}`}
        onContextMenu={(e) => openMenu(e, { x: 0, y: 0, kind: 'root' })}
        {...rootDropProps}
      >
        Notes
      </div>
      <div
        className={`folder-tree ${dragOverId === ROOT_DROP_ID ? 'drag-over' : ''}`}
        id="folder-tree"
        onContextMenu={(e) => {
          if (e.target === e.currentTarget) openMenu(e, { x: 0, y: 0, kind: 'root' });
        }}
        // The whole empty tree area is a move-to-root drop target, not just the
        // "Notes" header. Guard on target === currentTarget so drops that land on
        // a folder/note row are handled by that row (and don't also fall to root).
        onDragOver={(e) => { if (e.target === e.currentTarget) rootDropProps.onDragOver(e); }}
        onDragLeave={rootDropProps.onDragLeave}
        onDrop={(e) => { if (e.target === e.currentTarget) rootDropProps.onDrop(e); }}
      >
        {rootFolders.map((folder) => renderFolder(folder, 0))}
        {rootNotes.map((note) => renderNote(note, 0))}

        {notes.length === 0 && folders.length === 0 && (
          <div className="palette-empty" style={{ padding: '24px 16px' }}>
            No notes yet. Create one to get started.
          </div>
        )}
      </div>

      {audioTracks.length > 0 && <div className="sidebar-audio-player">
        <audio
          ref={audioRef}
          src={audioTracks[audioTrackIndex]?.kind === 'audio' ? audioTracks[audioTrackIndex].url : undefined}
          onPlay={() => setAudioPlaying(true)}
          onPause={() => setAudioPlaying(false)}
          onEnded={() => {
            changeAudioTrack(1, true);
          }}
        />
        <div className="sidebar-audio-track" title={audioTracks[audioTrackIndex]?.name}>
          <Music2 size={14} />
          <span>{audioTracks[audioTrackIndex]?.name}</span>
        </div>
        <div className="sidebar-audio-controls">
          <button className="btn-icon" disabled={audioTracks.length === 0} onClick={() => changeAudioTrack(-1)} title="Previous track">
            <SkipBack size={15} fill="currentColor" />
          </button>
          <button className="btn-icon sidebar-audio-play" onClick={toggleAudioPlayback} title={audioPlaying ? 'Pause' : 'Play'}>
            {audioPlaying ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
          </button>
          <button className="btn-icon" disabled={audioTracks.length === 0} onClick={() => changeAudioTrack(1)} title="Next track">
            <SkipForward size={15} fill="currentColor" />
          </button>
          <button
            className="btn-icon"
            onClick={() => {
              audioRef.current?.pause();
              setAudioPlaying(false);
              setAudioTracks([]);
              setAudioTrackIndex(0);
            }}
            title="Close player"
            aria-label="Close player"
          >
            <X size={15} />
          </button>
        </div>
      </div>}

      {/* Footer */}
      <div className="sidebar-footer">
        <button type="button" className="user-info" onClick={onOpenAccount} title="Account settings">
          <div className="user-avatar">
            {user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : (user.displayName || user.username).charAt(0).toUpperCase()}
          </div>
          <span className="truncate">{user.displayName || user.username}</span>
        </button>
        <button
          id="direct-messages-btn"
          type="button"
          className="btn-icon sidebar-dm-button"
          onClick={onOpenDirectMessages}
          title="Messages"
          aria-label={updateCounts.directMessages > 0
            ? `${countLabel(updateCounts.directMessages)} unread direct messages`
            : 'Messages'}
        >
          <Mail size={16} />
          {updateCounts.directMessages > 0 && <span className="sidebar-dm-dot" aria-hidden="true" />}
        </button>
        <button
          className="btn-icon"
          title="Update desktop app"
          disabled={updating}
          onClick={async () => {
            const api = (window as unknown as { electronAPI?: ElectronUpdateAPI }).electronAPI;
            if (!api?.updateAndRestart) return;
            setUpdating(true);
            const result = await api.updateAndRestart();
            if (!result.success) {
              alert('Desktop update failed: ' + (result.error || 'Unknown error'));
              setUpdating(false);
            } else if (!result.refreshing) {
              setUpdating(false);
            }
          }}
        >
          <RefreshCw size={16} className={updating ? 'spin' : ''} />
        </button>
        {isOwner && onOpenAdmin && (
          <button className="btn-icon" onClick={onOpenAdmin} title="Admin">
            <ShieldCheck size={16} />
          </button>
        )}
        <button id="logout-btn" className="btn-icon" onClick={onLogout} title="Log out">
          <LogOut size={16} />
        </button>
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="tree-context-menu"
          role="menu"
          aria-label={
            contextMenu.kind === 'vault'
              ? 'Vault options'
              : contextMenu.kind === 'folder'
                ? 'Folder options'
                : contextMenu.kind === 'root'
                  ? 'Sidebar options'
                  : moveMenu
                    ? 'Move note to folder'
                    : 'Note options'
          }
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.kind === 'vault' && (() => {
            const vault = vaults.find((item) => item.id === contextMenu.id);
            if (!vault) return null;
            return <>
              <button type="button" role="menuitem" onClick={() => { setContextMenu(null); onSelectVault(vault.id); }}>
                <ChevronRight size={14} /> Open {vault.name}
              </button>
              <button type="button" role="menuitem" onClick={() => { setContextMenu(null); onManageVault(vault.id); }}>
                <Settings size={14} /> Manage {vault.name}
              </button>
            </>;
          })()}
          {contextMenu.kind === 'note' && !moveMenu && (
            <>
              {(() => {
                const note = notes.find((x) => x.id === contextMenu.id);
                const isChatChannel = note?.content_preview.trim().startsWith(CHAT_NOTE_MARKER);
                return (
                  <>
                    <button type="button" role="menuitem" onClick={() => { setContextMenu(null); onSelectNote(contextMenu.id); }}>
                      {isChatChannel ? <Hash size={14} /> : <FileText size={14} />} Open
                    </button>
                    <button type="button" role="menuitem" onClick={() => { setContextMenu(null); onOpenNoteInNewTab(contextMenu.id); }}>
                      <FilePlus size={14} /> Open in new tab
                    </button>
                  </>
                );
              })()}
              <button type="button" role="menuitem" onClick={() => { const n = notes.find((x) => x.id === contextMenu.id); if (n) startRenameNote(n); }}>
                <Pencil size={14} /> Rename
              </button>
              <button type="button" role="menuitem" onClick={() => setMoveMenu(true)}>
                <FolderInput size={14} /> Move to…
              </button>
              {!notes.find((x) => x.id === contextMenu.id)?.content_preview.trim().startsWith(CHAT_NOTE_MARKER) && (
                <button type="button" role="menuitem" onClick={() => { setContextMenu(null); onUnlistNote(contextMenu.id); }}>
                  <Unlink size={14} /> Remove from sidebar
                </button>
              )}
              <div className="menu-divider" role="separator" />
              <button type="button" role="menuitem" className="menu-danger" onClick={() => { setContextMenu(null); onDeleteNote(contextMenu.id); }}>
                <Trash2 size={14} /> Delete
              </button>
            </>
          )}

          {contextMenu.kind === 'note' && moveMenu && (
            <div className="menu-scroll">
              <button type="button" role="menuitem" onClick={() => { setContextMenu(null); onMoveNote(contextMenu.id, null); }}>
                <FolderIcon size={14} /> Root
              </button>
              {flatFolders.map(({ folder, depth }) => (
                <button
                  key={folder.id}
                  type="button"
                  role="menuitem"
                  style={{ paddingLeft: 12 + depth * 12 }}
                  onClick={() => { setContextMenu(null); onMoveNote(contextMenu.id, folder.id); expandFolder(folder.id); }}
                >
                  <FolderIcon size={14} /> {folder.name}
                </button>
              ))}
            </div>
          )}

          {contextMenu.kind === 'folder' && (
            <>
              <button type="button" role="menuitem" onClick={() => { setContextMenu(null); expandFolder(contextMenu.id); onNewNoteInFolder(contextMenu.id); }}>
                <FilePlus size={14} /> New note
              </button>
              <button type="button" role="menuitem" onClick={() => void createChannel(contextMenu.id)}>
                <Hash size={14} /> New channel
              </button>
              <button type="button" role="menuitem" onClick={() => createFolder(contextMenu.id)}>
                <FolderPlus size={14} /> New subfolder
              </button>
              <button type="button" role="menuitem" onClick={() => { const f = folders.find((x) => x.id === contextMenu.id); if (f) startRename(f); }}>
                <Pencil size={14} /> Rename
              </button>
              <div className="menu-divider" role="separator" />
              <button type="button" role="menuitem" className="menu-danger" onClick={() => { setContextMenu(null); onDeleteFolder(contextMenu.id); }}>
                <Trash2 size={14} /> Delete
              </button>
            </>
          )}

          {contextMenu.kind === 'root' && (
            <>
              <button type="button" role="menuitem" onClick={() => { setContextMenu(null); onNewNote(); }}>
                <FilePlus size={14} /> New note
              </button>
              <button type="button" role="menuitem" onClick={() => void createChannel(null)}>
                <Hash size={14} /> New channel
              </button>
              <button type="button" role="menuitem" onClick={() => createFolder(null)}>
                <FolderPlus size={14} /> New folder
              </button>
            </>
          )}
        </div>
      )}
      </div>
    </aside>
  );
});
