import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoteSaving, noteSaveStatus } from '../noteSaving';
import { WorkspaceStore, reconcileWorkspaceNoteContent, type WorkspaceNote } from '../workspace';
import { emptySession } from '../chat/session';
import { ApiError, setActiveVaultOrigin, registerVaultOrigin, unregisterVaultOrigin } from '../api';
const note = (content = 'original', revision = 'note-v1:1') => ({ id: 'a', content, revision, title: 'A', vault_id: 'v' } as WorkspaceNote);
function fixture(write = vi.fn(async (_v: string, _id: string, content: string) => note(content, 'note-v1:2'))) {
  const store = new WorkspaceStore(emptySession());
  store.switchVault('v');
  store.openTab({ id: 'a', title: 'A', type: 'note', dirty: false });
  store.set('noteContents', { a: reconcileWorkspaceNoteContent(undefined, note()) });
  return { store, write, saving: new NoteSaving(store, write) };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); setActiveVaultOrigin(); unregisterVaultOrigin('v'); });
describe('note persistence scheduling', () => {
  it('debounces bursts and immediate save cancels the timer and duplicate submission', async () => {
    vi.useFakeTimers();
    const { store, saving, write } = fixture();
    saving.change('v', 'a', 'first'); saving.change('v', 'a', 'latest');
    expect(noteSaveStatus(store.active.noteContents.a)).toBe('Unsaved changes');
    const first = saving.save('v', 'a');
    expect(saving.save('v', 'a')).toBe(first);
    await first; await vi.runAllTimersAsync();
    expect(write).toHaveBeenCalledExactlyOnceWith('v', 'a', 'latest', 'note-v1:1');
    expect(noteSaveStatus(store.active.noteContents.a)).toBe('Saved');
  });
  it('serializes newer edits using acknowledgement revision after close, reopen and vault switch', async () => {
    let release!: (n: WorkspaceNote) => void;
    const write = vi.fn().mockImplementationOnce(() => new Promise<WorkspaceNote>(r => { release = r; }))
      .mockImplementationOnce(async (_v, _id, content) => note(content, 'note-v1:3'));
    const { store, saving } = fixture(write);
    saving.change('v', 'a', 'submitted'); const pending = saving.save('v', 'a');
    saving.change('v', 'a', 'newer');
    store.closeTabs(['a']);
    store.openTab({ id: 'a', title: 'A', type: 'note', dirty: false });
    store.set('noteContents', prev => ({ a: reconcileWorkspaceNoteContent(prev.a, note('remote', 'note-v1:9')) }));
    expect(store.active.noteContents.a.draft).toBe('newer');
    store.switchVault('other'); release(note('submitted', 'note-v1:2')); await pending;
    expect(write.mock.calls).toEqual([['v', 'a', 'submitted', 'note-v1:1'], ['v', 'a', 'newer', 'note-v1:2']]);
    expect(store.active.noteContents).toEqual({});
    expect(store.workspaces.v.noteContents.a.draft).toBe('newer');
    expect(saving.hasUnresolved()).toBe(false);
  });
  it.each([500, 409, 428, 403, 404])('retains drafts after %s, without retry loops or blind rebases', async status => {
    vi.useFakeTimers();
    const write = vi.fn().mockRejectedValueOnce(new ApiError('fixture failure', status)).mockImplementation(async (_v, _id, content) => note(content));
    const { store, saving } = fixture(write);
    saving.change('v', 'a', 'unsaved'); await expect(saving.save('v', 'a')).rejects.toThrow();
    saving.change('v', 'a', 'newest'); await vi.runAllTimersAsync();
    store.closeTabs(['a']);
    expect(store.active.noteContents.a.draft).toBe('newest');
    expect(store.active.noteContents.a.baseRevision).toBe('note-v1:1');
    expect(saving.hasUnresolved()).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    if (status === 500) { await saving.save('v', 'a'); expect(write).toHaveBeenLastCalledWith('v', 'a', 'newest', 'note-v1:1'); }
    else { await expect(saving.save('v', 'a')).rejects.toThrow(); expect(write).toHaveBeenCalledTimes(1); }
  });
  it('fences logout and removed/recreated workspaces, and warns on unresolved unload', async () => {
    let release!: (n: WorkspaceNote) => void;
    const { store, saving } = fixture(vi.fn(() => new Promise<WorkspaceNote>(r => { release = r; })));
    saving.change('v', 'a', 'draft'); const pending = saving.save('v', 'a');
    const event = { preventDefault: vi.fn(), returnValue: undefined };
    saving.protectUnload(event as unknown as BeforeUnloadEvent); expect(event.preventDefault).toHaveBeenCalledOnce();
    store.reset(); store.switchVault('v');
    store.set('noteContents', { a: reconcileWorkspaceNoteContent(undefined, note('new account')) });
    release(note('draft')); await pending;
    expect(store.active.noteContents.a.draft).toBe('new account');
  });
  it('ignores a removed note lifetime even if the same vault/id is recreated', async () => {
    let release!: (n: WorkspaceNote) => void;
    const write = vi.fn().mockImplementationOnce(() => new Promise<WorkspaceNote>(r => { release = r; }))
      .mockImplementationOnce(async (_v, _id, content) => note(content, 'note-v1:21'));
    const { store, saving } = fixture(write);
    saving.change('v', 'a', 'old'); const old = saving.save('v', 'a');
    store.retain(new Set()); store.switchVault(null); store.switchVault('v');
    store.set('noteContents', { a: reconcileWorkspaceNoteContent(undefined, note('fresh', 'note-v1:20')) });
    saving.change('v', 'a', 'replacement'); await saving.save('v', 'a');
    release(note('old', 'note-v1:2')); await old;
    expect(store.active.noteContents.a.draft).toBe('replacement');
    expect(store.active.noteContents.a.baseRevision).toBe('note-v1:21');
  });
  it('routes queued local and remote saves to their own instance after a vault switch', async () => {
    vi.stubGlobal('localStorage', { removeItem: vi.fn() });
    vi.stubGlobal('window', { location: { origin: 'https://local.invalid' } });
    const fetch = vi.fn(async (_url, options) => ({ ok: true, json: async () => ({ note: note(JSON.parse(options.body).content, 'note-v1:2') }) }));
    vi.stubGlobal('fetch', fetch);
    const { store } = fixture();
    const saving = new NoteSaving(store);
    saving.change('v', 'a', 'local draft');
    setActiveVaultOrigin('https://other.invalid'); store.switchVault('other');
    await saving.save('v', 'a');
    expect(fetch.mock.calls[0][0]).toBe('/api/notes/a');
    registerVaultOrigin('v', 'https://original.invalid');
    saving.change('v', 'a', 'remote draft');
    await saving.save('v', 'a');
    expect(fetch.mock.calls[1][0]).toBe('https://original.invalid/api/notes/a');
    saving.dispose();
  });
  it('does not submit without write permission', async () => {
    const { store, saving, write } = fixture(); saving.canWrite = () => false;
    saving.change('v', 'a', 'forbidden');
    expect(store.active.noteContents.a.draft).toBe('original');
    await expect(saving.save('v', 'a')).rejects.toThrow('read only'); expect(write).not.toHaveBeenCalled();
  });
});
