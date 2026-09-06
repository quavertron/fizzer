import { describe, expect, it } from 'vitest';
import {
  applyRemoteChatMessage,
  isEmptyChatMessage,
  captureChatMessageSnapshotBaseline,
  mergeRemoteChatMessage,
  reconcileChatMessageSnapshot,
  sortChatMessages,
} from '../chat/runBlocks';
import type { ChatMessage } from '../chat/types';

function chatMessage(id: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    channelId: 'channel-1',
    author: 'tester',
    body: '',
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('empty history content', () => {
  it.each([
    { hasImages: true }, { images: ['data:image/png;base64,eA=='] },
    { attachments: [{ name: 'evidence.txt', url: '/evidence.txt', mimeType: 'text/plain' }] },
    { mission: { id: 'mission' } }, { clarification: { questions: [] } }, { changeRequest: { files: [] } },
    { status: 'queued' }, { status: 'sending' }, { status: 'running' }, { status: 'failed' },
    { hasHarness: true }, { harnessLog: 'Verified revision' },
    { blocks: [{ type: 'text', text: 'Useful content' }] },
    { blocks: [{ type: 'tool_use', name: 'Read' }] },
  ])('retains useful content and active state: %j', (content) => {
    const row = chatMessage('retained', content as Partial<ChatMessage>);
    expect(isEmptyChatMessage(row)).toBe(false);
    expect(applyRemoteChatMessage([], row)).toEqual([row]);
  });

  it('drops whitespace, marker-only bodies and settled placeholders', () => {
    for (const body of ['', ' \n', '<!-- fizzer-next-none:handled -->', 'Thinking...', 'Queued...']) {
      const row = chatMessage('empty', { agentId: 'codex', body });
      expect(isEmptyChatMessage(row)).toBe(true);
      expect(applyRemoteChatMessage([], row)).toEqual([]);
    }
    expect(isEmptyChatMessage(chatMessage('empty'))).toBe(true);
    expect(isEmptyChatMessage(chatMessage('human', { body: 'Thinking...' }))).toBe(false);
  });
});

describe('sortChatMessages', () => {
  it('uses server sequence when client timestamps disagree', () => {
    const prompt = chatMessage('prompt', { seq: 41, createdAt: '2026-08-27T12:35:00.000Z' });
    const reply = chatMessage('reply', { seq: 42, createdAt: '2026-08-27T12:34:00.000Z' });

    expect(sortChatMessages([reply, prompt])).toEqual([prompt, reply]);
  });

  it('keeps timestamp order while an optimistic row has no sequence', () => {
    const prompt = chatMessage('prompt', { createdAt: '2026-08-27T12:34:00.000Z' });
    const shell = chatMessage('shell', { seq: 42, createdAt: '2026-08-27T12:34:00.001Z' });

    expect(sortChatMessages([shell, prompt])).toEqual([prompt, shell]);
  });
});

describe('mergeRemoteChatMessage media hydration', () => {
  it('keeps hydrated images when a reconnect returns a slim transcript row', () => {
    const image = 'data:image/png;base64,cGVyc2lzdGVk';
    const local = chatMessage('m1', { body: 'screenshot', images: [image], seq: 1 });
    const slimRemote = chatMessage('m1', { body: 'screenshot', hasImages: true, seq: 1 });

    const merged = mergeRemoteChatMessage(local, slimRemote);

    expect(merged.images).toEqual([image]);
    expect(merged.hasImages).toBeUndefined();
  });

  it('accepts full images when hydrating a slim transcript row', () => {
    const image = 'data:image/png;base64,aHlkcmF0ZWQ=';
    const slimLocal = chatMessage('m2', { hasImages: true, seq: 2 });
    const fullRemote = chatMessage('m2', { images: [image], seq: 2 });

    const merged = mergeRemoteChatMessage(slimLocal, fullRemote);

    expect(merged.images).toEqual([image]);
    expect(merged.hasImages).toBeUndefined();
  });
});

describe('mergeRemoteChatMessage authoritative projections', () => {
  it('inserts an authoritative message when its optimistic row is missing', () => {
    const remote = chatMessage('saved-after-race', {
      author: 'alice',
      body: 'This POST completed after transcript reconciliation.',
      seq: 12,
    });

    expect(applyRemoteChatMessage([], remote)).toEqual([remote]);
  });

  it('replaces optimistic content with the authoritative projection', () => {
    const local = chatMessage('m3', {
      body: 'The tests pass.',
      status: 'running',
      agentId: 'codex',
      runId: 9,
    });
    const remote = chatMessage('m3', {
      body: 'Thinking...',
      status: 'running',
      agentId: 'codex',
      runId: 9,
      seq: 44,
    });

    const merged = mergeRemoteChatMessage(local, remote);

    expect(merged.body).toBe(remote.body);
    expect(merged.status).toBe('running');
    expect(merged.seq).toBe(44);
    expect(merged.runId).toBe(9);
  });

  it('accepts shorter authoritative content instead of scoring text length', () => {
    const local = chatMessage('m4', {
      body: 'I checked both files and the leak is in the socket handler.',
      status: 'running',
      agentId: 'codex',
    });
    const remote = chatMessage('m4', {
      body: 'I checked both files',
      status: 'running',
      agentId: 'codex',
      seq: 8,
    });

    expect(mergeRemoteChatMessage(local, remote).body).toBe(remote.body);
    expect(mergeRemoteChatMessage(local, remote).seq).toBe(8);
  });

  it('lets a remote cancel settle a live local row', () => {
    const local = chatMessage('m5', {
      body: 'Still working on it.',
      status: 'running',
      agentId: 'codex',
      runId: 3,
    });
    const remote = chatMessage('m5', {
      body: 'Run canceled by user.',
      status: 'canceled',
      agentId: 'codex',
      runId: 3,
      seq: 12,
    });

    const merged = mergeRemoteChatMessage(local, remote);
    expect(merged.status).toBe('canceled');
    expect(merged.body).toBe('Run canceled by user.');
    expect(merged.seq).toBe(12);
  });

  it('removes a live answer when the server suppresses its settled shell', () => {
    const local = chatMessage('m6', {
      body: 'Here is the patch.',
      status: 'running',
      agentId: 'codex',
      runId: 5,
    });
    const remote = chatMessage('m6', {
      body: '',
      agentId: 'codex',
      runId: 5,
      seq: 20,
    });
    const next = applyRemoteChatMessage([local], remote);
    expect(next).toEqual([]);
  });

  it('does not delete a human prompt when an empty agent shell reuses its id', () => {
    const local = chatMessage('m-human', {
      author: 'alice',
      body: '@sol please ship the fix',
    });
    const remote = chatMessage('m-human', {
      author: 'Sol',
      body: 'Thinking...',
      agentId: 'codex',
      runId: 4,
    });
    const next = applyRemoteChatMessage([local], remote);
    expect(next).toHaveLength(1);
    expect(next[0].body).toBe('@sol please ship the fix');
    expect(next[0].agentId).toBeUndefined();
    expect(next[0].author).toBe('alice');
  });

  it('does not turn a human prompt into an agent row', () => {
    const local = chatMessage('m-human-2', {
      author: 'alice',
      body: 'look at this',
    });
    const remote = chatMessage('m-human-2', {
      author: 'Sol',
      body: 'I looked at this.',
      agentId: 'codex',
      registrationId: 'reg-sol',
      seq: 9,
    });
    const merged = mergeRemoteChatMessage(local, remote);
    expect(merged.body).toBe('look at this');
    expect(merged.author).toBe('alice');
    expect(merged.agentId).toBeUndefined();
    expect(merged.seq).toBe(9);
  });

  it('still removes a settled empty agent shell when the local row is not live', () => {
    const local = chatMessage('m7', {
      body: 'Thinking...',
      agentId: 'codex',
      runId: 5,
    });
    const remote = chatMessage('m7', {
      body: '',
      agentId: 'codex',
      runId: 5,
    });
    expect(applyRemoteChatMessage([local], remote)).toEqual([]);
  });
});

describe('reconcileChatMessageSnapshot request races', () => {
  it.each(['running', 'sending'] as const)('removes missing durable %s rows, but preserves concurrent changes', (status) => {
    const old = chatMessage('old', { seq: 3, agentId: 'codex', body: 'Thinking...', status });
    const baseline = captureChatMessageSnapshotBaseline([old]);
    expect(reconcileChatMessageSnapshot([old], [], baseline)).toEqual([]);
    const changed = { ...old, body: 'New projection' };
    expect(reconcileChatMessageSnapshot([changed], [], baseline)).toEqual([changed]);
  });

  it('does not resurrect a suppressed row from an in-flight snapshot', () => {
    const live = chatMessage('suppressed', { seq: 4, agentId: 'codex', body: 'Thinking...', status: 'running' });
    const baseline = captureChatMessageSnapshotBaseline([live]);
    expect(reconcileChatMessageSnapshot([], [live], baseline)).toEqual([]);
    expect(reconcileChatMessageSnapshot([live], [{ ...live, body: '', status: undefined }], baseline)).toEqual([]);
  });

  it.each(['full trace', undefined])('retains matching full blocks with harness %s but accepts full replacements', (harnessLog) => {
    const local = chatMessage('hydrated', { agentId: 'codex', body: 'Final', seq: 4,
      harnessLog, blocks: [{ type: 'text', text: 'x'.repeat(3_000) }] });
    const slim = { ...local, harnessLog: undefined, hasHarness: Boolean(harnessLog), blocks: [{ type: 'text' as const, text: `${'x'.repeat(1_999)}…` }] };
    const next = reconcileChatMessageSnapshot([local], [slim], captureChatMessageSnapshotBaseline([local]))[0];
    expect(next.blocks).toBe(local.blocks);
    expect(next.harnessLog).toBe(local.harnessLog);
    const full = { ...slim, harnessLog: '', blocks: [] };
    expect(applyRemoteChatMessage([next], full)[0]).toMatchObject({ harnessLog: '', blocks: [] });
  });

  it.each(['body', 'status', 'tool', 'input', 'live'] as const)('invalidates partial harness for a slim %s update', (change) => {
    const local = chatMessage('partial', { body: 'Thinking...', status: 'running', agentId: 'codex',
      harnessLog: 'partial trace', blocks: [{ type: 'tool_use', id: 't1', name: 'Read', input: { path: 'old' } }] });
    const remote = { ...local, harnessLog: undefined, hasHarness: true,
      ...(change === 'body' ? { body: 'More progress' } : {}),
      ...(change === 'status' ? { status: undefined, body: 'Final' } : {}),
      ...(change === 'tool' ? { blocks: [...local.blocks!, { type: 'tool_use' as const, id: 't2', name: 'Write' }] } : {}),
      ...(change === 'input' ? { blocks: [{ ...local.blocks![0], input: { path: 'new' } }] } : {}),
    };
    const next = mergeRemoteChatMessage(local, remote, true);
    expect(next.harnessLog).toBeUndefined();
    expect(next.blocks).toEqual(remote.blocks);
    expect(next.hasHarness).toBe(true);
  });

  it('keeps a projection received after the list request started, even when shorter', () => {
    const before = chatMessage('reply', { agentId: 'codex', body: 'Long preliminary answer', status: 'running', seq: 3 });
    const baseline = captureChatMessageSnapshotBaseline([before]);
    const final = { ...before, body: 'Done precisely.', status: undefined };
    expect(reconcileChatMessageSnapshot([final], [before], baseline)).toEqual([final]);
  });

  it('accepts a shorter settled answer from a reconnect snapshot', () => {
    const before = chatMessage('reply', { agentId: 'codex', body: 'Long preliminary answer', status: 'running', seq: 3 });
    const baseline = captureChatMessageSnapshotBaseline([before]);
    const final = { ...before, body: 'Done precisely.', status: undefined };
    expect(reconcileChatMessageSnapshot([before], [final], baseline)).toEqual([final]);
  });

  it('keeps a human prompt inserted while an older list request was in flight', () => {
    const old = chatMessage('old', { seq: 1, body: 'Earlier.' });
    const baseline = captureChatMessageSnapshotBaseline([old]);
    const prompt = chatMessage('new-human', {
      author: 'alice',
      body: '@sol fix the disappearing response',
    });

    expect(reconcileChatMessageSnapshot([old, prompt], [old], baseline)).toEqual([old, prompt]);
  });

  it('keeps a live agent answer missing from an older list snapshot', () => {
    const old = chatMessage('old', { seq: 1, body: 'Earlier.' });
    const live = chatMessage('agent-dispatch-live', {
      author: 'Sol',
      body: 'I found the stale snapshot race.',
      status: 'running',
      agentId: 'codex',
      registrationId: 'sol',
    });
    const baseline = captureChatMessageSnapshotBaseline([old, live]);

    expect(reconcileChatMessageSnapshot([old, live], [old], baseline)).toEqual([old, live]);
  });

  it('keeps a response that arrived and settled while the request was in flight', () => {
    const old = chatMessage('old', { seq: 1, body: 'Earlier.' });
    const baseline = captureChatMessageSnapshotBaseline([old]);
    const reply = chatMessage('agent-dispatch-settled', {
      author: 'Sol',
      body: 'Fixed and verified.',
      seq: 3,
      agentId: 'codex',
      registrationId: 'sol',
    });

    expect(reconcileChatMessageSnapshot([old, reply], [old], baseline)).toEqual([old, reply]);
  });

  it('still removes an authoritative row deleted while the renderer was offline', () => {
    const deleted = chatMessage('deleted', { seq: 2, body: 'Remove me.' });
    const baseline = captureChatMessageSnapshotBaseline([deleted]);

    expect(reconcileChatMessageSnapshot([deleted], [], baseline)).toEqual([]);
  });

  it('does not resurrect a completed empty agent shell', () => {
    const shell = chatMessage('agent-dispatch-empty', {
      body: '',
      agentId: 'codex',
      registrationId: 'sol',
    });
    const baseline = captureChatMessageSnapshotBaseline([shell]);

    expect(reconcileChatMessageSnapshot([shell], [], baseline)).toEqual([]);
  });
});
