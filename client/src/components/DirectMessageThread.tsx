import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { api, type User } from '../api';
import { applyLocalUserProfile } from '../chat/shared';
import { chatMessageStore } from '../chat/messageStore';
import {
  applyRemoteChatMessage,
  captureChatMessageSnapshotBaseline,
  reconcileChatMessageSnapshot,
} from '../chat/runBlocks';
import { connectVaultSocket } from '../socket';
import type {
  ChatChannelPresence,
  ChatMediaAttachment,
  ChatMessage,
  ChatReplyRef,
} from '../chat/types';
import { ChatView } from './ChatView';

export type DirectMessageConversation = {
  user: {
    id: number;
    username: string;
    displayName: string;
    avatarUrl: string;
  };
  vaultId: string;
  channelId: string;
  title: string;
  createdAt: string;
};

type DirectMessageThreadProps = {
  conversation: DirectMessageConversation;
  currentUsername: string;
  currentUser?: User | null;
  onBack: () => void;
  onRead: (channelId: string) => void | Promise<void>;
};

const NO_AGENTS: [] = [];

function mergeMessage(channelId: string, message: ChatMessage) {
  const remote = { ...message, channelId };
  chatMessageStore.update(channelId, (messages) => applyRemoteChatMessage(messages, remote));
}

export function DirectMessageThread({
  conversation,
  currentUsername,
  currentUser,
  onBack,
  onRead,
}: DirectMessageThreadProps) {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [presence, setPresence] = useState<ChatChannelPresence>({
    participants: [currentUsername, conversation.user.username],
    online: [],
    profiles: {
      [conversation.user.username]: conversation.user,
    },
  });

  const threadLabel = `@${conversation.user.username}`;

  useEffect(() => {
    let alive = true;
    const baseline = captureChatMessageSnapshotBaseline(
      chatMessageStore.getChannel(conversation.channelId),
    );
    setLoading(true);
    setStatus('');
    setPresence({
      participants: [currentUsername, conversation.user.username],
      online: [],
      profiles: { [conversation.user.username]: conversation.user },
    });
    void Promise.all([
      api<{ messages: ChatMessage[] }>(
        `/api/vaults/${conversation.vaultId}/channels/${conversation.channelId}/messages?detail=list&limit=120`,
      ),
      Promise.resolve(onRead(conversation.channelId)),
    ]).then(([data]) => {
      if (!alive) return;
      const remote = (data.messages || [])
        .map((message) => ({ ...message, channelId: conversation.channelId }));
      chatMessageStore.update(conversation.channelId, (existing) => (
        reconcileChatMessageSnapshot(existing, remote, baseline)
      ));
    }).catch((error) => {
      if (alive) setStatus(error instanceof Error ? error.message : 'Could not load messages');
    }).finally(() => {
      if (alive) setLoading(false);
    });
    return () => { alive = false; };
  }, [conversation.channelId, conversation.user, conversation.vaultId, currentUsername, onRead]);

  useEffect(() => {
    const socket = connectVaultSocket();
    const join = () => {
      socket.emit('joinVault', conversation.vaultId);
      socket.emit('joinChatChannel', conversation.channelId);
    };
    const created = (data: { vaultId: string; channelId: string; message: ChatMessage }) => {
      if (data.vaultId !== conversation.vaultId || data.channelId !== conversation.channelId) return;
      mergeMessage(conversation.channelId, data.message);
      if (data.message.author !== currentUsername) void onRead(conversation.channelId);
    };
    const updated = (data: { vaultId: string; channelId: string; message: ChatMessage }) => {
      if (data.vaultId !== conversation.vaultId || data.channelId !== conversation.channelId) return;
      mergeMessage(conversation.channelId, data.message);
    };
    const deleted = (data: { vaultId: string; channelId: string; messageId: string }) => {
      if (data.vaultId !== conversation.vaultId || data.channelId !== conversation.channelId) return;
      chatMessageStore.update(conversation.channelId, (messages) => (
        messages.filter((message) => message.id !== data.messageId)
      ));
    };
    const presenceChanged = (data: ChatChannelPresence & { vaultId: string; channelId: string }) => {
      if (data.vaultId !== conversation.vaultId || data.channelId !== conversation.channelId) return;
      setPresence((previous) => ({
        participants: data.participants || previous.participants,
        online: data.online || previous.online,
        owner: data.owner || previous.owner,
        profiles: { ...(previous.profiles || {}), ...(data.profiles || {}) },
      }));
    };
    socket.on('connect', join);
    socket.on('vault:chatMessageCreated', created);
    socket.on('vault:chatMessageUpdated', updated);
    socket.on('vault:chatMessageDeleted', deleted);
    socket.on('vault:chatPresence', presenceChanged);
    if (socket.connected) join();
    return () => {
      socket.emit('leaveChatChannel', conversation.channelId);
      socket.emit('leaveVault', conversation.vaultId);
      socket.off('connect', join);
      socket.off('vault:chatMessageCreated', created);
      socket.off('vault:chatMessageUpdated', updated);
      socket.off('vault:chatMessageDeleted', deleted);
      socket.off('vault:chatPresence', presenceChanged);
      socket.disconnect();
    };
  }, [conversation.channelId, conversation.vaultId, currentUsername, onRead]);

  const sendMessage = useCallback((
    channelId: string,
    body: string,
    media: ChatMediaAttachment[] = [],
    replyTo?: ChatReplyRef,
  ) => {
    const trimmed = body.trim();
    if (!trimmed && media.length === 0) return;
    const images = media.filter((item) => item.media_type.startsWith('image/')).map((item) => item.url);
    const attachments = media
      .filter((item) => !item.media_type.startsWith('image/'))
      .map((item) => ({ name: item.name || 'attachment', media_type: item.media_type, url: item.url }));
    const candidate: ChatMessage = {
      id: `dm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      channelId,
      author: currentUsername,
      body: trimmed,
      createdAt: new Date().toISOString(),
      ...(images.length ? { images } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(replyTo ? { replyTo } : {}),
    };
    setStatus('');
    mergeMessage(channelId, candidate);
    void api<{ message: ChatMessage }>(
      `/api/vaults/${conversation.vaultId}/channels/${channelId}/messages`,
      { method: 'POST', body: JSON.stringify(candidate) },
    ).then((data) => {
      mergeMessage(channelId, data.message);
    }).catch((error) => {
      chatMessageStore.update(channelId, (messages) => messages.filter((message) => message.id !== candidate.id));
      setStatus(error instanceof Error ? error.message : 'Could not send message');
    });
  }, [conversation.vaultId, currentUsername, onRead]);

  const deleteMessage = useCallback(async (channelId: string, messageId: string) => {
    setStatus('');
    try {
      await api(`/api/vaults/${conversation.vaultId}/channels/${channelId}/messages/${encodeURIComponent(messageId)}`, {
        method: 'DELETE',
      });
      chatMessageStore.update(channelId, (messages) => messages.filter((message) => message.id !== messageId));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not delete message');
    }
  }, [conversation.vaultId]);

  const hydrateMessage = useCallback((message: ChatMessage) => {
    void api<{ message: ChatMessage }>(
      `/api/vaults/${conversation.vaultId}/channels/${conversation.channelId}/messages/${encodeURIComponent(message.id)}`,
    ).then((data) => mergeMessage(conversation.channelId, data.message)).catch(() => undefined);
  }, [conversation.channelId, conversation.vaultId]);

  return (
    <div className="dm-thread">
      <button type="button" className="dm-thread-back" onClick={onBack} aria-label="Back to conversations">
        <ArrowLeft size={16} />
      </button>
      <ChatView
        channelId={conversation.channelId}
        channelName={threadLabel}
        isLoadingMessages={loading}
        currentUser={currentUsername}
        currentUserId={currentUser?.id}
        presence={applyLocalUserProfile(presence, currentUser)}
        availableAgents={NO_AGENTS}
        registeredAgents={NO_AGENTS}
        onRegisterAgent={() => undefined}
        onRemoveAgent={() => undefined}
        onInviteUser={async () => undefined}
        onSendMessage={sendMessage}
        onDeleteMessage={deleteMessage}
        onCancelRun={() => undefined}
        onHydrateMessage={hydrateMessage}
        sidebarMode="hidden"
        directMessage
      />
      {status && <div className="dm-thread-status" role="status">{status}</div>}
    </div>
  );
}
