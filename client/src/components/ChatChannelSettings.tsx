import { useCallback, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { api, type NoteSummary } from '../api';
import { ChatWorkspacePanel } from './ChatWorkspacePanel';

export function ChatChannelSettings({
  channelId,
  channelName,
  vaultId,
  notes,
  onOpenNote,
  onCwdChange,
  onClose,
}: {
  channelId: string;
  channelName: string;
  vaultId?: string;
  notes: NoteSummary[];
  onOpenNote?: (id: string) => void;
  onCwdChange: (cwd: string) => void;
  onClose: () => void;
}) {
  const [channelCwd, setChannelCwd] = useState('');
  const [channelCwdSaved, setChannelCwdSaved] = useState(false);
  const [channelKanbanNoteId, setChannelKanbanNoteId] = useState('');

  useEffect(() => {
    if (!vaultId || !channelId) return;
    let alive = true;
    api<{ settings: { cwd: string; kanbanNoteId?: string } }>(`/api/vaults/${vaultId}/channels/${channelId}/settings`)
      .then((d) => {
        if (!alive) return;
        const cwd = d.settings?.cwd ?? '';
        setChannelCwd(cwd);
        setChannelKanbanNoteId(d.settings?.kanbanNoteId ?? '');
        onCwdChange(cwd);
      })
      .catch(() => { /* keep current value */ });
    return () => { alive = false; };
  }, [vaultId, channelId, onCwdChange]);

  const saveChannelCwd = useCallback(async (override?: string) => {
    if (!vaultId) return;
    const next = (override ?? channelCwd).trim();
    if (override !== undefined) setChannelCwd(next);
    try {
      const d = await api<{ settings: { cwd: string; kanbanNoteId?: string } }>(
        `/api/vaults/${vaultId}/channels/${channelId}/settings`,
        { method: 'PUT', body: JSON.stringify({ cwd: next }) },
      );
      const cwd = d.settings?.cwd ?? '';
      setChannelCwd(cwd);
      setChannelKanbanNoteId(d.settings?.kanbanNoteId ?? '');
      onCwdChange(cwd);
      setChannelCwdSaved(true);
      window.setTimeout(() => setChannelCwdSaved(false), 1500);
    } catch { /* ignore — transient save failure */ }
  }, [vaultId, channelId, channelCwd, onCwdChange]);

  const cascadeBridge = Reflect.get(window, 'cascade');
  const selectDirectory = cascadeBridge && typeof cascadeBridge === 'object'
    ? Reflect.get(cascadeBridge, 'selectDirectory')
    : undefined;
  const canSelectDirectory = typeof selectDirectory === 'function';

  const chooseChannelCwd = useCallback(async () => {
    if (!canSelectDirectory) return;
    try {
      const selected = await selectDirectory();
      if (typeof selected !== 'string' || !selected) return;
      setChannelCwd(selected);
      await saveChannelCwd(selected);
    } catch {
      // Keep the current input when the native dialog is unavailable or fails.
    }
  }, [canSelectDirectory, saveChannelCwd, selectDirectory]);

  return (
    <div className="chat-channel-settings-panel">
      <div className="chat-channel-settings-heading">
        <strong>Project setup</strong>
        <button type="button" onClick={onClose} aria-label="Close settings"><X size={12} /></button>
      </div>
      <label htmlFor={`chat-cwd-${channelId}`}>Project folder</label>
      <div className="chat-channel-cwd">
        <input
          id={`chat-cwd-${channelId}`}
          value={channelCwd}
          onChange={(e) => setChannelCwd(e.target.value)}
          onBlur={() => void saveChannelCwd()}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
          placeholder="~/project"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
        <button
          type="button"
          className="chat-channel-board-link"
          disabled={!canSelectDirectory}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => { void chooseChannelCwd(); }}
          title="Choose a project folder"
        >
          Browse
        </button>
        {channelCwdSaved && <span className="chat-channel-cwd-saved">saved</span>}
      </div>
      <p>Where agents work in this channel. You can add this later.</p>
      <details className="chat-project-tools" open={Boolean(channelCwd || channelKanbanNoteId)}>
        <summary>Developer tools <span>board, work items, and isolated workspaces</span></summary>
        <label htmlFor={`chat-board-${channelId}`}>Project board</label>
        <div className="chat-channel-board-row">
          <select
            id={`chat-board-${channelId}`}
            value={channelKanbanNoteId}
            onChange={(event) => {
              const next = event.target.value;
              setChannelKanbanNoteId(next);
              if (!vaultId) return;
              void api<{ settings?: { kanbanNoteId?: string } }>(`/api/vaults/${vaultId}/channels/${channelId}/settings`, {
                method: 'PUT',
                body: JSON.stringify({ kanbanNoteId: next || null }),
              }).then((d) => {
                setChannelKanbanNoteId(d.settings?.kanbanNoteId ?? '');
              }).catch(() => { /* keep local */ });
            }}
          >
            <option value="">None — pointer only when set</option>
            {notes
              .filter((note) => /kanban-plugin\s*:/.test(note.content_preview || ''))
              .map((note) => (
                <option key={note.id} value={note.id}>{note.title}</option>
              ))}
          </select>
          {channelKanbanNoteId && onOpenNote && (
            <button
              type="button"
              className="chat-channel-board-link"
              onClick={() => onOpenNote(channelKanbanNoteId)}
            >
              Open
            </button>
          )}
          <button
            type="button"
            className="chat-channel-board-link"
            onClick={() => {
              if (!vaultId) return;
              void api<{ settings?: { kanbanNoteId?: string } }>(`/api/vaults/${vaultId}/channels/${channelId}/settings`, {
                method: 'PUT',
                body: JSON.stringify({ createInternalKanban: true }),
              }).then((d) => {
                setChannelKanbanNoteId(d.settings?.kanbanNoteId ?? '');
              }).catch(() => { /* keep local */ });
            }}
          >
            Internal board
          </button>
        </div>
        <p className="chat-channel-board-hint">
          Optional pointer to a vault board. Superkanban collates every board.
        </p>
        <ChatWorkspacePanel
          channelId={channelId}
          channelName={channelName}
          vaultId={vaultId}
          cwd={channelCwd}
          onUseWorkspace={(path) => { void saveChannelCwd(path); }}
        />
      </details>
    </div>
  );
}
