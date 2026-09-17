import { describe, expect, it } from 'vitest';
import { applyRemoteChatMessage, captureChatMessageSnapshotBaseline, reconcileChatMessageSnapshot } from '../chat/runBlocks';
import type { ChatMessage } from '../chat/types';

const message: ChatMessage = { id: 'one', channelId: 'room', author: 'alice', body: 'Hello', createdAt: '2026-09-17', seq: 1 };
describe('reaction reconciliation', () => {
  it('retains newer reactions across a stale list response and ordinary streaming updates', () => {
    const local = {...message, reactions: {version: 2, items: {'😂': ['user:1', 'agent:one']}}};
    const stale = {...message, reactions: {version: 1, items: {'😂': ['user:1']}}};
    const rows = reconcileChatMessageSnapshot([local], [stale], captureChatMessageSnapshotBaseline([message]));
    expect(rows[0].reactions).toEqual(local.reactions);
    expect(applyRemoteChatMessage(rows, {...message, body: 'New content'})[0]).toMatchObject({body: 'New content', reactions: local.reactions});
  });
  it('accepts removal and reconciles the existing optimistic message identity', () => {
    const optimistic = {...message, seq: undefined, status: 'sending' as const};
    const saved = {...message, reactions: {version: 3, items: {}}};
    const rows = applyRemoteChatMessage([optimistic], saved);
    expect(rows).toEqual([saved]);
    expect(rows[0].status).toBeUndefined();
  });
});
