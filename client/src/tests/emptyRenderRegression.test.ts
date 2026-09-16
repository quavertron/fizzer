import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatWorkTrace } from '../components/ChatWorkTrace';
import { describe, expect, it } from 'vitest';
import { segmentTranscript } from '../chat/workTrace';
import { applyRemoteChatMessage } from '../chat/runBlocks';
import type { ChatMessage } from '../chat/types';

const row = (extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'agent-dispatch-empty', channelId: 'ch', author: 'Astra', agentId: 'codex',
  createdAt: '2026-09-08T07:40:00Z', body: '', ...extra,
});

describe('empty agent row regression', () => {
  it.each(['', '  ', '<!-- fizzer-next-none:done -->'])('omits settled shells with body %j', (body) => {
    expect(segmentTranscript([row({ body })])).toEqual([]);
  });
  it.each([{ hasHarness: true }, { harnessLog: '# thinking\nInspecting the code' },
    { blocks: [{ type: 'tool_use' as const, name: 'Read' }] }])('retains trace-only data behind a visible work control: %j', (detail) => {
    const message = row(detail);
    expect(applyRemoteChatMessage([], message)).toEqual([message]);
    const segments = segmentTranscript([message]);
    expect(segments).toHaveLength(1);
    expect(segments[0].kind).toBe('work');
    if (segments[0].kind === 'work') {
      expect(segments[0].trace).toEqual([message]);
      expect(segments[0].updateGroups).toEqual([]);
      const markup = renderToStaticMarkup(createElement(ChatWorkTrace, {
        trace: segments[0].trace, selectedMessageId: null, runningMessageState: new Map(),
        onCancelRun: () => {}, onContextMenu: () => {}, onReply: () => {},
      }));
      expect(markup).toContain('chat-work-trace-toggle');
      expect(markup).toContain('Show history');
    }
  });
  it.each([{ hasImages: true }, { attachments: [{ name: 'result.txt', media_type: 'text/plain', url: '/result.txt' }] },
    { status: 'failed' as const }, { status: 'running' as const },
    { status: 'sending' as const }, { status: 'queued' as const }])('preserves artifacts, failures and active work: %j', (extra) => {
    const message = row(extra);
    expect(applyRemoteChatMessage([], message)).toEqual([message]);
    expect(segmentTranscript([message])).toHaveLength(1);
  });
});
