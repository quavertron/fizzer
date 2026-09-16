import { describe, expect, it } from 'vitest';
import { chatMessageStore } from '../chat/messageStore';
import type { ChatMessage } from '../chat/types';

describe('queued activity is not provider execution', () => {
  it.each(['queued', 'sending', 'running'] as const)('keeps unbound %s work visible but not orange', status => {
    const channelId = `unbound-${status}`;
    const row: ChatMessage = { id: channelId, channelId, actorUserId: 1, agentId: 'hermes', author: 'Along', body: 'Queued...', createdAt: '2026-09-15T23:05:58Z', status, runId: JSON.parse('null') };
    chatMessageStore.setActivityUserId(1);
    chatMessageStore.set(channelId, [row]);
    expect(chatMessageStore.getAgentActivity()[channelId]).toBe('queued');
    expect(chatMessageStore.getChannel(channelId)).toEqual([row]);
    chatMessageStore.set(channelId, [{ ...row, status: 'running', runId: 123 }]);
    expect(chatMessageStore.getAgentActivity()[channelId]).toBe('running');
    chatMessageStore.set(channelId, [{ ...row, status: 'failed', runId: 123 }]);
    expect(chatMessageStore.getAgentActivity()[channelId]).toBeUndefined();
    chatMessageStore.remove(channelId);
  });

  it('genuine running work wins over retained queues; failure falls back to queued', () => {
    const channelId = 'mixed-queue';
    const row: ChatMessage = { id: 'pending', channelId, actorUserId: 1, agentId: 'codex', author: 'Sol', body: 'Queued...', createdAt: '2026-09-15T15:40:59Z', status: 'queued', runId: JSON.parse('null') };
    const running = { ...row, id: 'running', status: 'running' as const, runId: 124 };
    chatMessageStore.setActivityUserId(1);
    chatMessageStore.set(channelId, [row, running]);
    expect(chatMessageStore.getAgentActivity()[channelId]).toBe('running');
    chatMessageStore.set(channelId, [row, { ...running, status: 'failed' }]);
    expect(chatMessageStore.getAgentActivity()[channelId]).toBe('queued');
    chatMessageStore.set(channelId, [{ ...row, status: 'canceled' }]);
    expect(chatMessageStore.getAgentActivity()[channelId]).toBeUndefined();
    chatMessageStore.remove(channelId);
  });
});
