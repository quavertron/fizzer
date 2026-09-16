import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type {
  ChatAgentRegistration,
  ChatMediaAttachment,
  ChatMessage,
  ChatReplyRef,
} from './types';
import { canMergeChatMessages } from './shared';
import { api, type NoteSummary } from '../api';
import { isLocalRunId, cancelLocalAgentRun } from '../localAgentRunner';
import {
  getMentionedRegistrations,
  isCompactCommand,
  normalizeMention,
  replyQuoteTargetsAgent,
  stripRegisteredAgentMentions,
} from './mentions';
import { applyRemoteChatMessage } from './runBlocks';
import type { ChatState } from './session';
import { chatMessageStore } from './messageStore';

type ChatDispatchRefs = {
  activeVaultIdRef: MutableRefObject<string | null>;
  notesRef: MutableRefObject<NoteSummary[]>;
  chatStateRef: MutableRefObject<ChatState>;
};

export function useChatDispatch({
  activeVaultIdRef,
  notesRef,
  chatStateRef,
  setChatState,
  setNotice,
  user,
}: ChatDispatchRefs & {
  setChatState: Dispatch<SetStateAction<ChatState>>;
  setNotice: Dispatch<SetStateAction<string | null>>;
  user: { username: string } | null;
}) {
  const persistChatMessageToServer = useCallback(async (
    vaultId: string,
    channelId: string,
    message: ChatMessage,
  ): Promise<{ dispatches?: { id: string }[] } | null> => {
    try {
      const data = await api<{
        message: ChatMessage;
        notice?: ChatMessage;
        agents?: ChatAgentRegistration[];
        dispatches?: { id: string }[];
      }>(`/api/vaults/${vaultId}/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify(message),
      });
      if (!data.message) return null;
      // A transcript refresh can race this POST. Even if an older snapshot
      // removed the optimistic row, the successful authoritative response must
      // put it back instead of silently accepting a server-only message.
      chatMessageStore.update(channelId, (existing) => {
        const messages = applyRemoteChatMessage(existing, data.message);
        return data.notice ? applyRemoteChatMessage(messages, data.notice) : messages;
      });
      if (data.agents) {
        setChatState((prev) => ({
          ...prev,
          registeredAgentsByChannel: {
            ...prev.registeredAgentsByChannel,
            [channelId]: data.agents!,
          },
        }));
      }
      return data;
    } catch (error) {
      console.error('Failed to persist chat message:', error);
      setNotice(error instanceof Error ? error.message : 'Could not save chat message');
      return null;
    }
  }, []);

  const handleHydrateChatMessage = useCallback((message: ChatMessage) => {
    const channelId = message.channelId;
    if (!channelId) return;
    chatMessageStore.update(channelId, (existing) => applyRemoteChatMessage(existing, message));
  }, []);

  const handleDeleteChatMessage = useCallback(async (channelId: string, messageId: string) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) return;
    try {
      await api(`/api/vaults/${vaultId}/channels/${channelId}/messages/${encodeURIComponent(messageId)}`, {
        method: 'DELETE',
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not delete message');
      return;
    }
    // Drop it locally too: the socket broadcast also removes it, but this keeps
    // the click responsive (and correct if the socket is currently down).
    if (!chatMessageStore.hasChannel(channelId)) return;
    chatMessageStore.update(channelId, (existing) => {
      const next = existing.filter((message) => message.id !== messageId);
      return next.length === existing.length ? existing : next;
    });
  }, []);

  /** Copy a message into another channel (Discord-style forward). */
  const handleForwardChatMessage = useCallback(async (
    channelId: string,
    messageId: string,
    targetChannelId: string,
  ) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) throw new Error('No active vault');
    const data = await api<{ message: ChatMessage }>(
      `/api/vaults/${vaultId}/channels/${channelId}/messages/${encodeURIComponent(messageId)}/forward`,
      { method: 'POST', body: JSON.stringify({ targetChannelId }) },
    );
    // Show it immediately in a cached target transcript; the socket broadcast
    // dedupes on id, so this is safe when the channel is also open elsewhere.
    if (chatMessageStore.hasChannel(targetChannelId)) {
      chatMessageStore.update(targetChannelId, (existing) => (
        existing.some((message) => message.id === data.message.id)
          ? existing
          : [...existing, data.message]
      ));
    }
    const target = notesRef.current.find((note) => note.id === targetChannelId);
    setNotice(`Forwarded to #${target?.title ?? 'channel'}`);
  }, []);

  const handleCancelChatRun = useCallback(async (runId: number): Promise<boolean> => {
    try {
      if (isLocalRunId(runId)) {
        // Negative run ids are legacy client-local runs (no longer started here).
        const cancelled = await cancelLocalAgentRun(runId);
        if (!cancelled) {
          setNotice('Could not cancel run');
          return false;
        }
        chatMessageStore.cancelLocalRun(runId);
      } else {
        const res = await api<{ success: boolean }>(`/api/runs/${runId}/cancel`, { method: 'POST' });
        if (!res.success) {
          setNotice('Could not cancel run');
          return false;
        }
      }
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not cancel run');
      return false;
    }
  }, []);

  const handleSendChatMessage = useCallback((
    channelId: string,
    body: string,
    media: ChatMediaAttachment[] = [],
    replyTo?: ChatReplyRef,
  ) => {
    const trimmed = body.trim();
    if ((!trimmed && media.length === 0) || !user) return;

    const channelRegistrations = chatStateRef.current.registeredAgentsByChannel[channelId] ?? [];
    const isClearCommand = (text: string) => /^\/(clear|reset)$/i.test(stripRegisteredAgentMentions(text, channelRegistrations).trim());

    const images = media.filter((item) => item.media_type.startsWith('image/')).map((item) => item.url);
    const attachments = media
      .filter((item) => !item.media_type.startsWith('image/'))
      .map((item) => ({ name: item.name || 'attachment', media_type: item.media_type, url: item.url }));

    const candidate: ChatMessage = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      channelId,
      author: user.username,
      body: trimmed,
      createdAt: new Date().toISOString(),
      ...(images.length > 0 ? { images } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(replyTo ? { replyTo } : {}),
    };

    const messages = chatMessageStore.getChannel(channelId);
    const last = messages[messages.length - 1];
    const typedSource = [trimmed, attachments.map((item) => item.name).join(' ')].filter(Boolean).join(' ');
    const replyTargetIsAgent = replyQuoteTargetsAgent(replyTo, messages);
    const hasAgentIntent = isClearCommand(trimmed) || Boolean(replyTo)
      || isCompactCommand(trimmed, channelRegistrations)
      || getMentionedRegistrations(typedSource, channelRegistrations, false).length > 0
      || channelRegistrations.some((registration) => registration.replyToEveryMessage);
    let outgoingMessage = candidate;
    let mergeTargetId: string | null = null;
    // A reply or dispatch intent gets its own durable row. Folding it into an
    // earlier PATCH can lose thread provenance, and would make orchestration
    // depend on a renderer staying alive long enough to launch the run.
    if (!hasAgentIntent && last && !isClearCommand(last.body) && canMergeChatMessages(last, candidate)) {
      mergeTargetId = last.id;
      outgoingMessage = {
        ...last,
        body: `${last.body}\n${trimmed}`,
        createdAt: candidate.createdAt,
      };
    }

    chatMessageStore.update(channelId, (channelMessages) => (
      mergeTargetId
        ? [...channelMessages.slice(0, -1), outgoingMessage]
        : [...channelMessages, candidate]
    ));

    const vaultId = activeVaultIdRef.current;
    void (async () => {
      if (!vaultId) return;
      if (mergeTargetId) {
        try {
          await api(`/api/vaults/${vaultId}/channels/${channelId}/messages/${mergeTargetId}`, {
            method: 'PATCH',
            body: JSON.stringify({ body: outgoingMessage.body, createdAt: outgoingMessage.createdAt }),
          });
        } catch (error) {
          setNotice(error instanceof Error ? error.message : 'Could not save chat message');
        }
        return;
      }
      const saved = await persistChatMessageToServer(vaultId, channelId, candidate);
      if (!saved) return;
      if (replyTargetIsAgent && (saved.dispatches?.length ?? 0) === 0) {
        const replyMention = normalizeMention(replyTo?.mention || '');
        if (replyMention) setNotice(`Could not route reply to @${replyMention}. Reconnect and try again.`);
      }

    })();
  }, [persistChatMessageToServer, user]);

  return {
    handleHydrateChatMessage,
    handleDeleteChatMessage,
    handleForwardChatMessage,
    handleCancelChatRun,
    handleSendChatMessage,
  };
}
