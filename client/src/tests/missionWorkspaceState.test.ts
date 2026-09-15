import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../chat/types';
import {
  completeMissionDraftSave,
  mergeMissionTraceMessages,
  missionTraceKey,
  reconcileMissionDraft,
} from '../components/MissionWorkspace';

function message(id: string, partial: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    channelId: 'channel-1',
    author: 'worker',
    body: 'initial output',
    createdAt: '2026-09-07T00:00:00.000Z',
    ...partial,
  };
}

describe('mission workspace draft and trace state', () => {
  it('keeps a dirty draft and its original base revision across refreshes', () => {
    const previous = { draft: 'local edits', baseRevision: 'note-v1:4', dirty: true };
    expect(reconcileMissionDraft(previous, { content: 'collaborator edits', revision: 'note-v1:5' })).toEqual(previous);
    expect(reconcileMissionDraft(undefined, { content: 'server text', revision: 'note-v1:7' })).toEqual({
      draft: 'server text',
      baseRevision: 'note-v1:7',
      dirty: false,
    });
  });

  it('advances the saved baseline without erasing text typed during an in-flight save', () => {
    expect(completeMissionDraftSave(
      { draft: 'newer local text', baseRevision: 'note-v1:4', dirty: true },
      'submitted text',
      { content: 'submitted text', revision: 'note-v1:5' },
    )).toEqual({ draft: 'newer local text', baseRevision: 'note-v1:5', dirty: true });
    expect(completeMissionDraftSave(
      { draft: 'submitted text', baseRevision: 'note-v1:4', dirty: true },
      'submitted text',
      { content: 'submitted text', revision: 'note-v1:5' },
    )).toEqual({ draft: 'submitted text', baseRevision: 'note-v1:5', dirty: false });
  });

  it('keeps trace selections distinct by attempt/run and applies live updates over snapshots', () => {
    expect(missionTraceKey({ id: 'task-1', attempt: 1, runId: 9 })).toBe('task-1:1:9');
    expect(missionTraceKey({ id: 'task-1', attempt: 2, runId: 10 })).not.toBe('task-1:1:9');
    const snapshot = [message('trace-1', { body: 'stored output', harnessLog: 'tool: stored' })];
    const live = [message('trace-1', { body: 'live output', status: 'running' })];
    const merged = mergeMissionTraceMessages(snapshot, live);
    expect(merged).toEqual([
      expect.objectContaining({ id: 'trace-1', body: 'live output', status: 'running', harnessLog: 'tool: stored' }),
    ]);
  });
});
