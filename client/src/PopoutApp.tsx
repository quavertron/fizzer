/**
 * @file PopoutApp.tsx — Standalone single-tab window
 *
 * Rendered (instead of the full workspace) when a tab has been dragged out of
 * the main window into its own OS window. It hosts exactly one note tab
 * full-bleed. Notes are re-fetched from the server (the auth token is shared
 * across windows via the same Electron session).
 *
 * A slim header doubles as a drag handle: dragging it out of this window and
 * releasing over the main window merges the tab back (the main process closes
 * this window and tells the target to adopt the tab).
 *
 * @component
 */

import { useEffect, useState, useSyncExternalStore, lazy, Suspense, type DragEvent } from 'react';
import type { Tab } from './components/TabBar';

// Same split as the main app: CodeMirror loads with the editor, not the shell.
const NoteEditor = lazy(() =>
  import('./components/NoteEditor').then((m) => ({ default: m.NoteEditor })),
);
import { api, type Vault } from './api';
import { WorkspaceStore, reconcileWorkspaceNoteContent, type WorkspaceNote } from './workspace';
import { emptySession } from './chat/session';
import { NoteSaving, noteSaveStatus } from './noteSaving';

type MergeApi = {
  mergeTab?: (input: { tab: Tab; screenX: number; screenY: number }) => Promise<{ success: boolean; merged?: boolean }>;
};

function getMergeApi(): MergeApi | undefined {
  return (window as unknown as { electronAPI?: MergeApi }).electronAPI;
}

export function PopoutApp({ descriptor }: { descriptor: Tab }) {
  const [store] = useState(() => new WorkspaceStore(emptySession()));
  const [saving] = useState(() => new NoteSaving(store));
  const [writable, setWritable] = useState(false);
  saving.canWrite = () => writable;
  useSyncExternalStore(store.subscribe, store.getSnapshot);
  const entry = store.active.noteContents[descriptor.id];
  const [error, setError] = useState<string | null>(null);
  const title = descriptor.title;

  useEffect(() => { document.title = title || 'Fizzer'; }, [title]);

  useEffect(() => {
    if (descriptor.type !== 'note') return;
    let cancelled = false;
    Promise.all([api<{ note: WorkspaceNote }>(`/api/notes/${descriptor.id}`), api<{ vaults: Vault[] }>('/api/vaults')])
      .then(([data, membership]) => {
        if (cancelled) return;
        store.switchVault(data.note.vault_id);
        store.set('noteContents', prev => ({ ...prev, [descriptor.id]: reconcileWorkspaceNoteContent(prev[descriptor.id], data.note) }));
        const role = membership.vaults.find(v => v.id === data.note.vault_id)?.role;
        setWritable(role === 'owner' || role === 'editor');
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load note');
      });
    return () => { cancelled = true; };
  }, [descriptor.id, descriptor.type]);

  const saveNote = () => store.activeVaultId ? saving.save(store.activeVaultId, descriptor.id) : Promise.resolve();
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!event.defaultPrevented && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (store.activeVaultId) void saving.save(store.activeVaultId, descriptor.id).catch(() => {});
      }
    };
    window.addEventListener('keydown', keydown);
    window.addEventListener('beforeunload', saving.protectUnload);
    return () => {
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('beforeunload', saving.protectUnload);
      saving.dispose();
    };
  }, [descriptor.id, saving, store]);

  // Merge back when the header is released outside this window (dropEffect none).
  const handleHeaderDragEnd = (event: DragEvent) => {
    if (event.dataTransfer.dropEffect !== 'none') return;
    const mergeApi = getMergeApi();
    if (!mergeApi?.mergeTab || saving.hasUnresolved()) return;
    const tab: Tab = { ...descriptor, title };
    void mergeApi.mergeTab({ tab, screenX: event.screenX, screenY: event.screenY });
  };

  let body;
  if (descriptor.type !== 'note') {
    body = <div className="pane-empty">This tab type can no longer be popped out.</div>;
  } else if (error) {
    body = <div className="pane-empty">{error}</div>;
  } else {
    body = (
      <Suspense fallback={<div className="editor-loading" />}>
        <NoteEditor note={entry?.note ?? null} content={entry?.draft ?? ''}
          onContentChange={draft => { if (store.activeVaultId) saving.change(store.activeVaultId, descriptor.id, draft); }}
          onSave={saveNote} saveStatus={entry ? noteSaveStatus(entry) : undefined}
          readOnly={!writable} titleEditable={false} />
      </Suspense>
    );
  }

  return (
    <div style={{ height: '100vh', width: '100vw', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div
        className="popout-bar"
        draggable
        onDragStart={(e) => { e.dataTransfer.setData('text/plain', descriptor.id); e.dataTransfer.effectAllowed = 'move'; }}
        onDragEnd={handleHeaderDragEnd}
        title="Drag into the main window to merge this tab back"
      >
        <span className="popout-bar-title">{title || 'Untitled'}</span>
        <span className="popout-bar-hint">drag to merge back</span>
      </div>
      <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {body}
      </div>
    </div>
  );
}
