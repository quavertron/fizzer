import { describe, expect, it, vi } from 'vitest';
import { chatMessageStore, fetchChatMessageSnapshot } from '../chat/messageStore';
import { api, ApiError } from '../api';
import { captureChatMessageSnapshotBaseline, reconcileChatMessageSnapshot } from '../chat/runBlocks';

vi.mock('../api', async (original) => ({ ...await original<typeof import('../api')>(), api: vi.fn() }));
import type { ChatMessage } from '../chat/types';

function message(id: string, channelId: string): ChatMessage {
  return { id, channelId, author: 'asdfasdf', body: id, createdAt: id };
}

describe('channel snapshot recovery', () => {
  const live: ChatMessage = { ...message('older-run', 'recovery'), seq: 1, agentId: 'codex', status: 'running' };
  const baseline = captureChatMessageSnapshotBaseline([live]);

  it.each([0, 120])('confirms omitted live rows even with %s recent rows and retries transient failures', async (count) => {
    const recent = Array.from({ length: count }, (_, i) => ({ ...message(`recent-${i}`, 'recovery'), seq: i + 2 }));
    vi.mocked(api).mockResolvedValueOnce({ messages: recent }).mockRejectedValueOnce(new ApiError('Unavailable', 503));
    expect(await fetchChatMessageSnapshot('vault', 'recovery', baseline)).toEqual([live, ...recent]);
    vi.mocked(api).mockResolvedValueOnce({ messages: recent }).mockRejectedValueOnce(new ApiError('Suppressed', 404));
    const recovered = await fetchChatMessageSnapshot('vault', 'recovery', baseline);
    expect(reconcileChatMessageSnapshot([live], recovered, baseline)).toEqual(recent);
  });

  it('hydrates older terminal rows without overwriting concurrent updates or resurrecting deletions', async () => {
    const final = { ...live, status: undefined, body: 'Short final.' };
    vi.mocked(api).mockResolvedValueOnce({ messages: [] }).mockResolvedValueOnce({ message: final });
    const recovered = await fetchChatMessageSnapshot('vault', 'recovery', baseline);
    expect(reconcileChatMessageSnapshot([live], recovered, baseline)).toEqual([final]);
    expect(reconcileChatMessageSnapshot([], recovered, baseline)).toEqual([]);
    const newer = { ...final, body: 'Newer projection' };
    expect(reconcileChatMessageSnapshot([newer], recovered, baseline)).toEqual([newer]);
  });

  it('discovers server-owned queued rows without an optimistic agent shell', async () => {
    const queued = { ...live, status: 'queued' as const, body: 'Queued...' };
    vi.mocked(api).mockResolvedValueOnce({ messages: [queued] });
    const empty = captureChatMessageSnapshotBaseline([]);
    const recovered = await fetchChatMessageSnapshot('vault', 'recovery', empty);
    expect(reconcileChatMessageSnapshot([], recovered, empty)).toEqual([queued]);
  });

  it('rejects late responses after cleanup even if the transport ignores abort', async () => {
    const controller = new AbortController();
    let resolve!: (value: unknown) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const recovery = fetchChatMessageSnapshot('vault', 'recovery', baseline, controller.signal);
    controller.abort();
    resolve({ messages: [live] });
    await expect(recovery).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('chatMessageStore', () => {
  it('distinguishes an unloaded channel from a loaded-empty one', () => {
    expect(chatMessageStore.hasChannel('never')).toBe(false);
    chatMessageStore.set('loaded-empty', []);
    expect(chatMessageStore.hasChannel('loaded-empty')).toBe(true);
    expect(chatMessageStore.getChannel('loaded-empty')).toEqual([]);
  });

  it('returns a stable reference until the channel actually changes', () => {
    chatMessageStore.set('stable', [message('a', 'stable')]);
    const first = chatMessageStore.getChannel('stable');
    // Updater returns the same array ref → treated as no-op.
    chatMessageStore.update('stable', (prev) => prev);
    expect(chatMessageStore.getChannel('stable')).toBe(first);
  });

  it('notifies only subscribers of the mutated channel — the isolation invariant', () => {
    chatMessageStore.set('chan-a', [message('a1', 'chan-a')]);
    chatMessageStore.set('chan-b', [message('b1', 'chan-b')]);
    const onA = vi.fn();
    const onB = vi.fn();
    const offA = chatMessageStore.subscribe('chan-a', onA);
    const offB = chatMessageStore.subscribe('chan-b', onB);

    chatMessageStore.update('chan-a', (prev) => [...prev, message('a2', 'chan-a')]);
    expect(onA).toHaveBeenCalledTimes(1);
    expect(onB).not.toHaveBeenCalled(); // a token in chan-a never touches chan-b

    // A no-op update (same ref) emits to nobody.
    chatMessageStore.update('chan-a', (prev) => prev);
    expect(onA).toHaveBeenCalledTimes(1);

    offA();
    offB();
  });

  it('forgets a channel on remove', () => {
    chatMessageStore.set('doomed', [message('d1', 'doomed')]);
    chatMessageStore.remove('doomed');
    expect(chatMessageStore.hasChannel('doomed')).toBe(false);
    expect(chatMessageStore.getChannel('doomed')).toEqual([]);
  });

  it('signals agent work only on start and finish transitions', () => {
    const channelId = 'activity-transition';
    chatMessageStore.set(channelId, [
      { ...message('old-agent', channelId), agentId: 'sol' },
    ]);
    expect(chatMessageStore.getAgentActivity()[channelId]).toBeUndefined();

    chatMessageStore.update(channelId, (messages) => [
      ...messages,
      { ...message('live-agent', channelId), agentId: 'sol', status: 'running' },
    ]);
    expect(chatMessageStore.getAgentActivity()[channelId]).toBe('running');

    chatMessageStore.update(channelId, (messages) => messages.map((item) => (
      item.id === 'live-agent' ? { ...item, body: 'Done', status: undefined } : item
    )));
    expect(chatMessageStore.getAgentActivity()[channelId]).toBe('finished');

    chatMessageStore.clearFinishedAgentActivity(channelId);
    expect(chatMessageStore.getAgentActivity()[channelId]).toBeUndefined();
  });

  it('does not mark canceled agent work as finished', () => {
    const channelId = 'activity-canceled';
    chatMessageStore.set(channelId, []);
    chatMessageStore.update(channelId, (messages) => [
      ...messages,
      { ...message('canceled-agent', channelId), agentId: 'sol', status: 'running' },
    ]);
    chatMessageStore.update(channelId, (messages) => messages.map((item) => (
      item.id === 'canceled-agent' ? { ...item, status: 'canceled' } : item
    )));
    expect(chatMessageStore.getAgentActivity()[channelId]).toBeUndefined();
  });
});
