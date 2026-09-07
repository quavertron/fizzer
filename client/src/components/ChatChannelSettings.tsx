import { useCallback, useEffect, useRef, useState } from 'react';
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
  const contextKey = `${vaultId ?? ''}\u0000${channelId}`;
  const contextKeyRef = useRef(contextKey);
  contextKeyRef.current = contextKey;
  const contextGenerationRef = useRef(0);
  const mutationVersionRef = useRef(0);
  const cwdSaveSequenceRef = useRef(0);
  const kanbanSaveSequenceRef = useRef(0);

  useEffect(() => {
    const generation = ++contextGenerationRef.current;
    mutationVersionRef.current = 0;
    cwdSaveSequenceRef.current = 0;
    kanbanSaveSequenceRef.current = 0;
    setChannelCwd('');
    setChannelKanbanNoteId('');
    setChannelCwdSaved(false);
    if (!vaultId || !channelId) return;
    let alive = true;
    const initialMutationVersion = mutationVersionRef.current;
    api<{ settings: { cwd: string; kanbanNoteId?: string } }>(`/api/vaults/${vaultId}/channels/${channelId}/settings`)
      .then((d) => {
        if (!alive
          || contextGenerationRef.current !== generation
          || contextKeyRef.current !== contextKey
          || mutationVersionRef.current !== initialMutationVersion) return;
        const cwd = d.settings?.cwd ?? '';
        setChannelCwd(cwd);
        setChannelKanbanNoteId(d.settings?.kanbanNoteId ?? '');
        onCwdChange(cwd);
      })
      .catch(() => { /* keep current value */ });
    return () => { alive = false; };
  }, [vaultId, channelId, contextKey, onCwdChange]);
  const updateChannelCwd = useCallback((next: string) => {
    if (contextKeyRef.current !== contextKey) return;
    ++mutationVersionRef.current;
    setChannelCwd(next);
  }, [contextKey]);

  const saveChannelCwd = useCallback(async (override?: string) => {
    if (!vaultId || contextKeyRef.current !== contextKey) return;
    const requestContextKey = contextKey;
    const requestGeneration = contextGenerationRef.current;
    const requestSequence = ++cwdSaveSequenceRef.current;
    ++mutationVersionRef.current;
    const next = (override ?? channelCwd).trim();
    if (override !== undefined) setChannelCwd(next);
    try {
      const d = await api<{ settings: { cwd: string; kanbanNoteId?: string } }>(
        `/api/vaults/${vaultId}/channels/${channelId}/settings`,
        { method: 'PUT', body: JSON.stringify({ cwd: next }) },
      );
      if (contextGenerationRef.current !== requestGeneration
        || contextKeyRef.current !== requestContextKey
        || cwdSaveSequenceRef.current !== requestSequence) return;
      const cwd = d.settings?.cwd ?? '';
      setChannelCwd(cwd);
      onCwdChange(cwd);
      setChannelCwdSaved(true);
      window.setTimeout(() => {
        if (contextGenerationRef.current === requestGeneration && contextKeyRef.current === requestContextKey) {
          setChannelCwdSaved(false);
        }
      }, 1500);
    } catch { /* ignore — transient save failure */ }
  }, [vaultId, channelId, channelCwd, contextKey, onCwdChange]);

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
          onChange={(e) => updateChannelCwd(e.target.value)}
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
              const requestContextKey = contextKey;
              const requestGeneration = contextGenerationRef.current;
              const requestSequence = ++kanbanSaveSequenceRef.current;
              ++mutationVersionRef.current;
              setChannelKanbanNoteId(next);
              if (!vaultId) return;
              void api<{ settings?: { kanbanNoteId?: string } }>(`/api/vaults/${vaultId}/channels/${channelId}/settings`, {
                method: 'PUT',
                body: JSON.stringify({ kanbanNoteId: next || null }),
              }).then((d) => {
                if (contextGenerationRef.current !== requestGeneration
                  || contextKeyRef.current !== requestContextKey
                  || kanbanSaveSequenceRef.current !== requestSequence) return;
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
