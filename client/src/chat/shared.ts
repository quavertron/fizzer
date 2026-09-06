import type {
  ChatChannelPresence,
  ChatMessage,
} from './types';

export const CHAT_NOTE_MARKER = 'cascade://chat-channel';
const CHAT_MESSAGE_GROUP_WINDOW_MS = 90_000;

export function createChatAgentRegistrationId() {
  return `reg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Preserve cached profiles when lean presence events omit that heavier map. */
export function mergeChatPresence(
  prior: ChatChannelPresence | undefined,
  incoming: Partial<ChatChannelPresence>,
): ChatChannelPresence {
  const nextProfiles = incoming.profiles && Object.keys(incoming.profiles).length > 0
    ? { ...(prior?.profiles || {}), ...incoming.profiles }
    : (prior?.profiles || incoming.profiles || {});
  return {
    participants: incoming.participants ?? prior?.participants ?? [],
    online: incoming.online ?? prior?.online ?? [],
    owner: incoming.owner || prior?.owner || '',
    profiles: nextProfiles,
  };
}

type LocalUserProfile = {
  id: number;
  username: string;
  displayName: string;
  avatarUrl: string;
};

/**
 * Presence snapshots omit avatarUrl on purpose (inline photos are huge).
 * Paint the signed-in user's session photo onto every channel profile map.
 */
export function applyLocalUserProfile(
  presence: ChatChannelPresence,
  user: LocalUserProfile | null | undefined,
): ChatChannelPresence {
  if (!user?.username) return presence;
  const existing = presence.profiles?.[user.username];
  return {
    ...presence,
    profiles: {
      ...presence.profiles,
      [user.username]: {
        id: user.id,
        username: user.username,
        displayName: user.displayName || existing?.displayName || user.username,
        avatarUrl: user.avatarUrl || existing?.avatarUrl || '',
      },
    },
  };
}

/** Keep a burst compact, but never fold a later conversational turn into it. */
export function canGroupChatMessages(a: ChatMessage, b: ChatMessage) {
  if (a.author.trim() !== b.author.trim()) return false;
  const aKey = a.registrationId ?? a.agentId ?? null;
  const bKey = b.registrationId ?? b.agentId ?? null;
  if (aKey !== bKey) return false;
  const elapsed = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  return Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= CHAT_MESSAGE_GROUP_WINDOW_MS;
}

export function canMergeChatMessages(a: ChatMessage, b: ChatMessage) {
  if (!canGroupChatMessages(a, b)) return false;
  if (a.status === 'running' || b.status === 'running') return false;
  if (a.replyTo || b.replyTo) return false;
  if (a.forwardedFrom || b.forwardedFrom) return false;
  if ((a.images?.length ?? 0) > 0 || (b.images?.length ?? 0) > 0) return false;
  if ((a.attachments?.length ?? 0) > 0 || (b.attachments?.length ?? 0) > 0) return false;
  return true;
}

/** Internal checkpoint metadata is never chat prose, including partial streamed markers. */
export function stripChatControlMarkers(body: string): string {
  return body.replace(/<!--\s*fizzer-next(?:-none|-feedback)?:[^<>]*?(?:-->|$)/g, '').trim();
}
