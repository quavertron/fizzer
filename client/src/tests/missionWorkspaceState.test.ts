import { describe, expect, it } from 'vitest';
import { restorePersistedSession } from '../chat/session';
import { reconcileWorkspaceNoteContent, type WorkspaceNote } from '../workspace';
import * as Layout from '../layout/tree';

describe('intentional mission-workspace rollback', () => {
  it('discards obsolete mission views without discarding ordinary conversation or note tabs', () => {
    const restored = restorePersistedSession({
      activeVaultId: 'v1',
      openTabs: [
        { id: 'mission:m1', title: 'Old workspace', type: 'mission' },
        { id: 'chat1', title: '#Existing room', type: 'chat' },
        { id: 'note1', title: 'Unrelated note', type: 'note' },
      ],
      activeTabId: 'mission:m1',
    });
    expect(restored.openTabs.map(tab => tab.id)).toEqual(['chat1', 'note1']);
    expect(Layout.getActiveTabIds(restored.layout)).not.toContain('mission:m1');
    expect(restored.openTabs[0].title).toBe('Existing room');
  });
  it('preserves the note editor revision guard and dirty draft across remote refresh', () => {
    const previous = { note: { id: 'note1', content: 'original', revision: 'r1' } as WorkspaceNote, draft: 'local edits', baseRevision: 'r1' };
    const incoming = { ...previous.note, content: 'remote edits', revision: 'r2' };
    expect(reconcileWorkspaceNoteContent(previous, incoming)).toEqual({ note: incoming, draft: 'local edits', baseRevision: 'r1' });
  });
});
