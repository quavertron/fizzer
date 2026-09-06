/**
 * @file messageStore.ts — External per-channel chat message store.
 *
 * Chat transcripts stream at ~20 React commits/sec per active agent run. Holding
 * `messagesByChannel` in App-level `useState` meant every token re-rendered the
 * entire App shell (sidebar tree, pane grid, note editors, toolbar) even though
 * only one ChatView cared. This store keeps messages out of App's render path:
 * writes are plain function calls (no prop drilling), and only the ChatView(s)
 * subscribed — via {@link useChannelMessages} / `useSyncExternalStore` — to the
 * mutated channel re-render. The App component never re-renders on a token.
 *
 * Snapshots are referentially stable: a channel's array identity changes only
 * when its contents change, and absent channels share a frozen empty array, so
 * `useSyncExternalStore` bails out correctly.
 */

import { useCallback, useSyncExternalStore } from 'react';
import type { ChatMessage } from './types';
import { api, ApiError } from '../api';
import { isLiveAgentStatus, type ChatMessageSnapshotBaseline } from './runBlocks';

/** Keep live rows outside the recent window until their individual lookup settles. */
export async function fetchChatMessageSnapshot(
  vaultId: string,
  channelId: string,
  baseline: ChatMessageSnapshotBaseline,
  signal?: AbortSignal,
): Promise<ChatMessage[]> {
  const path = `/api/vaults/${vaultId}/channels/${channelId}/messages`;
  const { messages = [], beforeSeq } = await api<{ messages: ChatMessage[]; beforeSeq?: number }>(`${path}?detail=list&limit=120`, { signal });
  signal?.throwIfAborted();
  const ids = new Set(messages.map((message) => message.id));
  const missing = [...baseline.ids.values()].filter((message) => (
    message.seq != null && !ids.has(message.id)
    && isLiveAgentStatus(message.status)
    && !(message.runId != null && message.runId < 0)
  ));
  const confirmed = await Promise.all(missing.map(async (message) => {
    try {
      return (await api<{ message: ChatMessage }>(`${path}/${encodeURIComponent(message.id)}`, { signal })).message;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      return message;
    }
  }));
  signal?.throwIfAborted();
  // The snapshot is authoritative only within its raw database window. Older
  // loaded pages are not deletions; realtime still applies explicit removals.
  const older = [...baseline.ids.values()].filter(message => (
    beforeSeq != null && message.seq != null && message.seq < beforeSeq
    && !isLiveAgentStatus(message.status) && !ids.has(message.id)
  ));
  return [...older, ...confirmed.filter((message): message is ChatMessage => message != null), ...messages];
}

const EMPTY: ChatMessage[] = Object.freeze([]) as unknown as ChatMessage[];

type Listener = () => void;

export type ChannelAgentActivity = 'running' | 'finished';

function isRunningAgent(message: ChatMessage): boolean {
  return Boolean(message.agentId) && isLiveAgentStatus(message.status);
}

function isFinishedAgent(message: ChatMessage): boolean {
  return Boolean(message.agentId)
    && !isLiveAgentStatus(message.status)
    && message.status !== 'failed'
    && message.status !== 'canceled'
    && message.body.trim().length > 0
    && !/^Thinking(?:\.{3}|…)$/.test(message.body.trim());
}

// Checkpoint envelopes still reach the dispatcher; they are never conversation.
function visibleMessages(messages: ChatMessage[]): ChatMessage[] {
  const hidden = (message: ChatMessage) => message.id.startsWith('sys-next-')
    || (Boolean(message.agentId) && !isLiveAgentStatus(message.status)
      && ['', 'Thinking...'].includes(message.body.trim()));
  return messages.some(hidden) ? messages.filter(message => !hidden(message)) : messages;
}

class ChatMessageStore {
  private channels = new Map<string, ChatMessage[]>();
  private listeners = new Map<string, Set<Listener>>();
  private agentActivity: Readonly<Record<string, ChannelAgentActivity>> = Object.freeze({});
  private agentActivityListeners = new Set<Listener>();

  /** Current messages for a channel; a shared frozen array when none are cached. */
  getChannel(channelId: string): ChatMessage[] {
    return this.channels.get(channelId) ?? EMPTY;
  }

  /** Distinguishes "loaded, empty" from "never loaded" (callers gate optimistic
   *  inserts on this so they never seed an unopened channel). */
  hasChannel(channelId: string): boolean {
    return this.channels.has(channelId);
  }

  /**
   * Replace a channel's list via an immutable updater. If the updater returns the
   * same array reference (the established "no change" signal), nothing is emitted
   * and no subscriber re-renders.
   */
  update(channelId: string, updater: (prev: ChatMessage[]) => ChatMessage[]): void {
    const hadChannel = this.channels.has(channelId);
    const prev = this.getChannel(channelId);
    const updated = updater(prev);
    const next = visibleMessages(updated);
    if (next === prev) return;
    this.channels.set(channelId, next);
    this.reconcileAgentActivity(channelId, prev, next, hadChannel);
    this.emit(channelId);
  }

  /** Legacy local runs have no vault projection or owning-channel lookup. */
  cancelLocalRun(runId: number): void {
    if (runId >= 0) return;
    for (const [channelId, messages] of this.channels) {
      if (!messages.some((message) => message.runId === runId)) continue;
      this.update(channelId, (messages) => messages.map((message) => (
        message.runId === runId && isLiveAgentStatus(message.status)
          ? { ...message, status: 'canceled', body: message.body === 'Thinking...' ? 'Run canceled by user.' : message.body }
          : message
      )));
    }
  }

  /** Set a channel's list outright (used by the load/reconcile path). */
  set(channelId: string, messages: ChatMessage[]): void {
    messages = visibleMessages(messages);
    if (this.channels.get(channelId) === messages) return;
    const hadChannel = this.channels.has(channelId);
    const previous = this.getChannel(channelId);
    this.channels.set(channelId, messages);
    this.reconcileAgentActivity(channelId, previous, messages, hadChannel);
    this.emit(channelId);
  }

  /** Forget a channel entirely (e.g. its note/channel was deleted). */
  remove(channelId: string): void {
    if (!this.channels.has(channelId)) return;
    this.channels.delete(channelId);
    this.setAgentActivity(channelId, null);
    this.emit(channelId);
  }

  /** Low-frequency shell signal: emits only when agent work starts or finishes,
   * never for each streamed token. */
  getAgentActivity(): Readonly<Record<string, ChannelAgentActivity>> {
    return this.agentActivity;
  }

  subscribeAgentActivity(listener: Listener): () => void {
    this.agentActivityListeners.add(listener);
    return () => this.agentActivityListeners.delete(listener);
  }

  /** Viewing a channel acknowledges completed work. Running work remains live. */
  clearFinishedAgentActivity(channelId: string): void {
    if (this.agentActivity[channelId] === 'finished') this.setAgentActivity(channelId, null);
  }

  subscribe(channelId: string, listener: Listener): () => void {
    let set = this.listeners.get(channelId);
    if (!set) {
      set = new Set();
      this.listeners.set(channelId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.listeners.delete(channelId);
    };
  }

  private emit(channelId: string): void {
    const set = this.listeners.get(channelId);
    if (!set) return;
    for (const listener of set) listener();
  }

  private reconcileAgentActivity(
    channelId: string,
    previous: ChatMessage[],
    next: ChatMessage[],
    hadChannel: boolean,
  ): void {
    if (next.some(isRunningAgent)) {
      this.setAgentActivity(channelId, 'running');
      return;
    }

    const previouslyRunning = previous.some(isRunningAgent)
      || this.agentActivity[channelId] === 'running';
    const previousIds = new Set(previous.map((message) => message.id));
    const receivedFinishedAgent = hadChannel
      && next.some((message) => !previousIds.has(message.id) && isFinishedAgent(message));
    if (previouslyRunning || receivedFinishedAgent) {
      const finishedTransition = previous.some((message) => isRunningAgent(message)
        && next.some((candidate) => candidate.id === message.id && isFinishedAgent(candidate)));
      const failedTransition = previous.some((message) => isRunningAgent(message)
        && next.some((candidate) => candidate.id === message.id
          && (candidate.status === 'failed' || candidate.status === 'canceled')));
      this.setAgentActivity(
        channelId,
        failedTransition && !finishedTransition && !receivedFinishedAgent ? null : 'finished',
      );
    }
  }

  private setAgentActivity(channelId: string, status: ChannelAgentActivity | null): void {
    if ((this.agentActivity[channelId] ?? null) === status) return;
    const next = { ...this.agentActivity };
    if (status) next[channelId] = status;
    else delete next[channelId];
    this.agentActivity = Object.freeze(next);
    for (const listener of this.agentActivityListeners) listener();
  }
}

export const chatMessageStore = new ChatMessageStore();

/** Subscribe a component to one channel's transcript. Re-renders only when that
 *  channel's messages change — never for unrelated channels or App shell churn. */
export function useChannelMessages(channelId: string): ChatMessage[] {
  const subscribe = useCallback(
    (cb: Listener) => chatMessageStore.subscribe(channelId, cb),
    [channelId],
  );
  const getSnapshot = useCallback(() => chatMessageStore.getChannel(channelId), [channelId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Subscribe the app shell to start/finish transitions without making it render
 * for the token stream itself. */
export function useAgentActivity(): Readonly<Record<string, ChannelAgentActivity>> {
  return useSyncExternalStore(
    (listener) => chatMessageStore.subscribeAgentActivity(listener),
    () => chatMessageStore.getAgentActivity(),
    () => chatMessageStore.getAgentActivity(),
  );
}
