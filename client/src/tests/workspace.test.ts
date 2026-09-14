import { describe, expect, it } from 'vitest';
import { WorkspaceStore } from '../workspace';
import { emptySession, restorePersistedSession, workspaceSession } from '../chat/session';
import * as Layout from '../layout/tree';
import type { Note } from '../api';

const note = (content: string): Note => ({ id: 'note', title: 'Note', content } as Note);
const tab = (id: string, type: 'note' | 'chat' = 'note') => ({ id, title: id, type, dirty: false });
function fixture() {
  const store = new WorkspaceStore(emptySession());
  store.switchVault('a');
  store.openTab(tab('note'));
  store.set('noteContents', { note: { note: note('saved'), draft: 'submitted' } });
  return store;
}

describe('workspace authority', () => {
  it('targets the original vault and preserves newer edits on save completion', () => {
    const store = fixture();
    store.set('noteContents', { note: { note: note('saved'), draft: 'newer' } });
    store.switchVault('b');
    const second = store.active;
    store.completeSave('a', 'note', 'submitted', note('submitted'), store.epoch);
    expect(store.active).toBe(second);
    store.switchVault('a');
    expect(store.active.noteContents.note).toEqual({ note: note('submitted'), draft: 'newer' });
    expect(store.active.openTabs[0].dirty).toBe(true);
    store.completeSave('a', 'note', 'newer', note('newer'), store.epoch);
    expect(store.active.openTabs[0].dirty).toBe(false);
  });

  it('does not resurrect closed tabs, removed vaults, or logged-out drafts', () => {
    const store = fixture();
    const epoch = store.epoch;
    store.closeTabs(['note']);
    store.completeSave('a', 'note', 'submitted', note('submitted'), epoch);
    expect(store.active.noteContents).toEqual({});
    store.retain(new Set());
    store.completeSave('a', 'note', 'submitted', note('submitted'), epoch);
    expect(store.workspaces).toEqual({});
    store.reset();
    store.switchVault('a');
    store.openTab(tab('note'));
    store.set('noteContents', { note: { note: note('fresh'), draft: 'fresh' } });
    store.completeSave('a', 'note', 'submitted', note('submitted'), epoch);
    expect(store.active.noteContents.note.draft).toBe('fresh');
  });

  it('opens, replaces, focuses existing tabs and repairs collapsed pane focus', () => {
    const store = fixture();
    store.openTab(tab('chat', 'chat'));
    store.set('layout', Layout.splitPaneWithTab(store.active.layout, store.focusedPane.id, 'right', 'chat'));
    const chatPane = Layout.findPaneByTab(store.active.layout, 'chat')!;
    store.openTab(tab('chat', 'chat'), 'replace');
    expect(store.focusedPane.id).toBe(chatPane.id);
    store.openTab(tab('replacement'), 'replace');
    expect(store.active.openTabs.map((item) => item.id)).toEqual(['note', 'replacement']);
    store.closeTabs(['replacement']);
    expect(Layout.findPane(store.active.layout, store.active.focusedPaneId)).not.toBeNull();
    expect(store.active.openTabs.map((item) => item.id)).toEqual(['note']);
  });

  it('persists both vaults and legacy mirrors but never persists draft bodies', () => {
    const store = fixture();
    store.switchVault('b');
    store.openTab(tab('chat', 'chat'));
    const listings = { a: { notes: [{ id: 'note', title: 'Cached title', content_preview: 'Preview', vault_id: 'a', folder_id: null,
      is_pinned: 0, is_archived: 0, is_listed: 0, position: 0, word_count: 1, created_at: '', updated_at: '', tags: [] }], folders: [], savedAt: Date.now() } };
    const session = workspaceSession(store.activeVaultId, store.workspaces, listings);
    const serialized = JSON.stringify(session);
    expect(serialized).not.toMatch(/noteContents|submitted/);
    expect(session.openTabs).toEqual(store.active.openTabs);
    const restored = restorePersistedSession(JSON.parse(serialized));
    expect(restored.vaultListingsByVault).toEqual(listings);
    expect(restored.workspacesByVault.a.openTabs[0].id).toBe('note');
  });
});
