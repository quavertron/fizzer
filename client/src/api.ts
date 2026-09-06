/**
 * @file api.ts — Typed fetch wrapper and shared domain types
 *
 * Provides a generic `api<T>()` function that wraps `fetch` with:
 * - HttpOnly session-cookie authentication (with one-release bearer migration)
 * - JSON Content-Type headers
 * - Error extraction from server JSON responses
 * - Legacy-token cleanup after a successful cookie migration
 *
 * Also exports all shared domain types (User, Vault, Folder, Note, etc.)
 * and date formatting utilities used across the client.
 *
 * @module
 */

/* ═══════════════════════════════════════════════════════════
   Cascade Notes — Types & API Client
   ═══════════════════════════════════════════════════════════ */

/** Authenticated user record. */
export type User = { id: number; username: string; displayName: string; avatarUrl: string };

/** Vault membership roles, ordered from most to least privileged. */
export type VaultRole = 'owner' | 'editor' | 'viewer';

/** A member of a shared vault. */
export type VaultMember = {
  userId: number;
  username: string;
  displayName: string;
  avatarUrl: string;
  role: VaultRole;
  createdAt: string;
};

/**
 * A vault (workspace) containing folders and notes. `role` and `memberCount`
 * come from `GET /api/vaults` and are absent on a freshly created vault.
 */
export type Vault = {
  id: string;
  name: string;
  root_path: string;
  created_at: string;
  role?: VaultRole | null;
  memberCount?: number;
  visibility?: 'private' | 'public';
};

/** Discovery, membership, and permission are independent facts. */
export function vaultDetailsLabel(vault: Vault): string {
  return [
    vault.visibility === 'public' ? 'Public' : vault.visibility === 'private' ? 'Private' : 'Visibility unknown',
    vault.memberCount == null ? 'Member count unknown' : `${vault.memberCount} ${vault.memberCount === 1 ? 'member' : 'members'}`,
    vault.role || 'Role unknown',
  ].join(' · ');
}

/** A folder within a vault; supports nesting via `parent_id`. */
export type Folder = {
  id: string;
  vault_id: string;
  parent_id: string | null;
  name: string;
  position: number;
  created_at: string;
};

/** Lightweight note metadata returned in list endpoints (no full content). */
export type NoteSummary = {
  id: string;
  vault_id: string;
  folder_id: string | null;
  title: string;
  content_preview: string;
  is_pinned: number;
  is_archived: number;
  is_listed: number;
  position: number;
  word_count: number;
  created_at: string;
  updated_at: string;
  tags: string[];
};

/** Full note record including markdown content and file path. */
export type Note = NoteSummary & {
  content: string;
  file_path: string;
};

/** Public publish metadata for a note. */
export type NotePublishInfo = {
  published: boolean;
  slug?: string;
  url?: string;
  published_at?: string;
  updated_at?: string;
};

/** A full-text search result with a ranked snippet. */
export type SearchResult = {
  id: string;
  title: string;
  snippet: string;
  rank?: number;
  score?: number;
  type?: 'note' | 'chat';
  channelId?: string;
  timestamp?: string;
};

export type CommunityUpdateKind = 'mention' | 'reply' | 'message' | 'note';

export type CommunityUpdateItem = {
  id: string;
  kind: CommunityUpdateKind;
  vaultId: string;
  vaultName: string;
  targetId: string;
  targetTitle: string;
  sourceId: string;
  messageId?: string;
  actor: string;
  actorDisplayName: string;
  preview: string;
  timestamp: string;
};

export type CommunityUpdates = {
  groups: Array<{
    vaultId: string;
    vaultName: string;
    unreadCount: number;
    items: CommunityUpdateItem[];
  }>;
  counts: {
    total: number;
    directMessages: number;
    byVault: Record<string, number>;
    byTarget: Record<string, number>;
  };
  truncated: boolean;
};

/* ─── API Client ─────────────────────────────────────────── */

const API_BASE = import.meta.env.VITE_API_URL || '';
const DATE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly data: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Generic typed fetch wrapper for the Cascade API.
 *
 * Sends the HttpOnly session cookie. Legacy JavaScript-readable credentials are
 * discarded instead of being attached to requests.
 *
 * @template T - Expected shape of the JSON response body
 * @param path - API path (e.g. `/api/vaults`)
 * @param options - Standard `RequestInit` options (method, body, headers, etc.)
 * @returns Parsed JSON response typed as `T`
 */
export async function api<T>(path: string, options: RequestInit = {}) {
  localStorage.removeItem('docs_token');
  const headers = {
    'Content-Type': 'application/json',
    'X-Cascade-Browser': '1',
    ...options.headers,
  };
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers, credentials: 'include' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const body = data && typeof data === 'object' ? data as Record<string, unknown> : {};
    throw new ApiError(
      typeof body.error === 'string' ? body.error : 'Request failed',
      res.status,
      body,
    );
  }
  return data as T;
}

/**
 * Format an ISO date string into a locale-appropriate medium date + short time.
 * Example output: "Jun 15, 2026, 3:45 PM"
 */
export function formatDate(value: string) {
  return DATE_TIME_FORMATTER.format(new Date(value));
}

/**
 * Format an ISO date string as a human-friendly relative time.
 * Returns "Just now", "5m ago", "3h ago", "2d ago", or falls back to
 * `formatDate()` for dates older than a week.
 */
export function formatRelativeDate(value: string) {
  const now = Date.now();
  const then = new Date(value).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return formatDate(value);
}
// ── Local agent graph (Orbit canvas) ───────────────────────────────
export type LocalAgentKind = 'claude' | 'codex';
export type LocalAgentState = 'active' | 'idle';
export type LocalAgentNode = {
  id: string;
  kind: LocalAgentKind;
  role: 'parent' | 'child';
  label: string;
  status: string;
  action: string;
  state: LocalAgentState;
  updatedAt: number;
  /** True when status came from the local caption model rather than a fallback. */
  captioned?: boolean;
  /** Present only for Cascade-spawned sessions: opens the Agent Sessions panel focused on this run. */
  activity?: { sessionId: string; title: string };
};
export type LocalAgentEdge = { from: string; to: string };
export type LocalAgentGraph = {
  nodes: LocalAgentNode[];
  edges: LocalAgentEdge[];
  scannedAt: number;
};

export type VaultGraphKind = 'note' | 'chat' | 'missing';
export type VaultGraphNode = {
  id: string;
  title: string;
  kind: VaultGraphKind;
  wordCount?: number;
  archived?: number;
};
export type VaultGraphEdge = { source: string; target: string; kind?: 'wikilink' | 'chat' };
export type VaultGraph = { nodes: VaultGraphNode[]; edges: VaultGraphEdge[] };

export async function fetchVaultGraph(vaultId: string): Promise<VaultGraph> {
  return api<VaultGraph>(`/api/vaults/${encodeURIComponent(vaultId)}/graph`);
}

/**
 * Fetch the running-agent graph. Scanning local logs + Ollama runs server-side
 * (the host that shares a machine with the agents); the editable prompt-note
 * template is sent along so the caption wording stays user-controlled.
 */
export async function fetchLocalAgents(template: string): Promise<LocalAgentGraph> {
  const electronAPI = (window as unknown as {
    electronAPI?: { getLocalAgents?: (input: { template: string }) => Promise<LocalAgentGraph> };
  }).electronAPI;
  if (electronAPI?.getLocalAgents) return electronAPI.getLocalAgents({ template });
  return api<LocalAgentGraph>('/api/local-agents', {
    method: 'POST',
    body: JSON.stringify({ template }),
  });
}

export async function appendOrbitCaption(noteId: string, node: Pick<LocalAgentNode, 'id' | 'label' | 'status'>): Promise<void> {
  await api(`/api/notes/${encodeURIComponent(noteId)}/orbit-caption`, {
    method: 'POST',
    body: JSON.stringify({ agentId: node.id, label: node.label, status: node.status }),
  });
}
