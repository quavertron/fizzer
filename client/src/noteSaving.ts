import { api, ApiError, getVaultOrigin } from './api';
import { WorkspaceStore, type WorkspaceNote, type WorkspaceNoteContent } from './workspace';

export function noteSaveStatus(entry: WorkspaceNoteContent) {
  if (entry.saveError) return entry.saveError;
  if (entry.saving) return 'Saving…';
  return entry.draft !== entry.note.content ? 'Unsaved changes' : 'Saved';
}

/** Scheduling belongs to the workspace, not to the editor's lifetime. */
export class NoteSaving {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private pending = new Map<string, { promise: Promise<WorkspaceNote | undefined>; token: object }>();
  onSaved?: (vaultId: string, note: WorkspaceNote) => void;
  canWrite: (vaultId: string) => boolean = () => true;
  constructor(private store: WorkspaceStore, private write = async (vaultId: string, id: string, content: string, expectedRevision?: string) => {
    const origin = getVaultOrigin(vaultId);
    const data = await api<{ note: WorkspaceNote }>(`/api/notes/${id}`, {
      origin: origin?.origin ?? '', token: origin?.token,
      method: 'PUT', body: JSON.stringify({ content, expectedRevision }),
    });
    return data.note;
  }) {}
  private key(vaultId: string, id: string) { return JSON.stringify([this.store.epoch, vaultId, id]); }
  private patch(vaultId: string, id: string, patch: Partial<WorkspaceNoteContent>) {
    this.store.update(w => {
      const entry = w.noteContents[id];
      return entry ? { ...w, noteContents: { ...w.noteContents, [id]: { ...entry, ...patch } } } : w;
    }, vaultId);
  }
  change(vaultId: string, id: string, draft: string) {
    const entry = this.store.workspaces[vaultId]?.noteContents[id];
    if (!entry || !this.canWrite(vaultId) || entry.draft === draft) return;
    this.patch(vaultId, id, { draft });
    const key = this.key(vaultId, id);
    clearTimeout(this.timers.get(key));
    // Errors require deliberate retry; conflicts never adopt an unseen revision.
    if (entry.saveError || entry.saving) return;
    const epoch = this.store.epoch;
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      if (epoch === this.store.epoch && this.store.workspaces[vaultId]?.noteContents[id]?.note === entry.note) void this.save(vaultId, id).catch(() => {});
    }, 750));
  }
  save(vaultId: string, id: string): Promise<WorkspaceNote | undefined> {
    const key = this.key(vaultId, id);
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    const entry = this.store.workspaces[vaultId]?.noteContents[id];
    const pending = this.pending.get(key);
    if (pending && entry?.saveRequest === pending.token) return pending.promise;
    if (!entry) return Promise.resolve(undefined);
    if (entry.saveBlocked) return Promise.reject(new Error(entry.saveError));
    if (!this.canWrite(vaultId)) {
      this.patch(vaultId, id, { saveError: 'Read only — draft kept', saveBlocked: true });
      return Promise.reject(new Error('This vault is read only'));
    }
    if (entry.draft === entry.note.content && !entry.saveError) return Promise.resolve(entry.note);
    const epoch = this.store.epoch;
    const saveRequest = {};
    const current = () => epoch === this.store.epoch && this.store.workspaces[vaultId]?.noteContents[id]?.saveRequest === saveRequest;
    this.patch(vaultId, id, { saving: true, saveRequest, saveError: undefined });
    const request = this.write(vaultId, id, entry.draft, entry.baseRevision ?? entry.note.revision)
      .then(async note => {
        if (!current()) return undefined;
        this.store.completeSave(vaultId, id, entry.draft, note, epoch);
        this.pending.delete(key);
        this.onSaved?.(vaultId, note);
        const next = this.store.workspaces[vaultId]?.noteContents[id];
        if (next && next.draft !== next.note.content) return this.save(vaultId, id);
        return note;
      }).catch(error => {
        if (current()) {
          const status = error instanceof ApiError ? error.status : 0;
          const conflict = status === 409 || status === 428;
          this.patch(vaultId, id, {
            saving: false, saveBlocked: conflict || status === 403 || status === 404,
            saveError: conflict ? 'Conflict — draft kept; resolve changes before saving' : `Save failed — draft kept: ${error instanceof Error ? error.message : 'Retry save'}`,
          });
        }
        throw error;
      }).finally(() => { if (this.pending.get(key)?.promise === request) this.pending.delete(key); });
    this.pending.set(key, { promise: request, token: saveRequest });
    return request;
  }
  hasUnresolved() {
    return Object.values(this.store.workspaces).some(w => Object.values(w.noteContents).some(e => e.saving || e.saveError || e.draft !== e.note.content));
  }
  protectUnload = (event: BeforeUnloadEvent) => {
    if (this.hasUnresolved()) { event.preventDefault(); event.returnValue = ''; }
  };
  dispose() { this.timers.forEach(clearTimeout); this.timers.clear(); }
}
