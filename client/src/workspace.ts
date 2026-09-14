import * as Layout from './layout/tree';
import type { Tab } from './components/TabBar';
import type { Note } from './api';
import { emptyWorkspace, type PersistedSession, type PersistedWorkspace } from './chat/session';

export type Workspace = PersistedWorkspace & { noteContents: Record<string, { note: Note; draft: string }> };
type Update<T> = T | ((previous: T) => T);
const createWorkspace = (): Workspace => ({ ...emptyWorkspace(), noteContents: {} });

/** One synchronous authority for handlers, React, and inactive vaults. */
export class WorkspaceStore {
  private listeners = new Set<() => void>();
  private empty = createWorkspace();
  private revision = 0;
  epoch = 0;
  activeVaultId: string | null;
  workspaces: Record<string, Workspace>;
  constructor(session: PersistedSession) {
    this.activeVaultId = session.activeVaultId;
    this.workspaces = Object.fromEntries(Object.entries(session.workspacesByVault)
      .map(([id, workspace]) => [id, { ...workspace, noteContents: {} }]));
  }
  get active() { return this.activeVaultId ? this.workspaces[this.activeVaultId] ?? this.empty : this.empty; }
  get focusedPane() { return Layout.findPane(this.active.layout, this.active.focusedPaneId) ?? Layout.getFirstPane(this.active.layout); }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.revision;
  private notify() { this.revision++; this.listeners.forEach((listener) => listener()); }
  update(update: (workspace: Workspace) => Workspace, vaultId = this.activeVaultId) {
    if (!vaultId || !this.workspaces[vaultId]) return;
    const previous = this.workspaces[vaultId];
    const next = update(previous);
    if (next === previous) return;
    const focusedPaneId = Layout.findPane(next.layout, next.focusedPaneId)?.id ?? Layout.getFirstPane(next.layout).id;
    const openTabs = next.openTabs.map((tab) => {
      const entry = next.noteContents[tab.id];
      const dirty = entry ? entry.draft !== entry.note.content : false;
      return tab.dirty === dirty ? tab : { ...tab, dirty };
    });
    this.workspaces = { ...this.workspaces, [vaultId]: { ...next, openTabs, focusedPaneId } };
    this.notify();
  }
  set = <K extends keyof Workspace>(key: K, value: Update<Workspace[K]>) => {
    this.update((workspace) => ({ ...workspace, [key]: typeof value === 'function' ? (value as (previous: Workspace[K]) => Workspace[K])(workspace[key]) : value }));
  };
  switchVault(id: string | null) {
    if (id === this.activeVaultId) return;
    if (id && !this.workspaces[id]) this.workspaces = { ...this.workspaces, [id]: createWorkspace() };
    this.activeVaultId = id;
    this.notify();
  }
  retain(ids: Set<string>) {
    this.workspaces = Object.fromEntries(Object.entries(this.workspaces).filter(([id]) => ids.has(id)));
    this.notify();
  }
  reset() {
    this.epoch++;
    this.workspaces = {};
    this.activeVaultId = null;
    this.empty = createWorkspace();
    this.notify();
  }
  closeTabs(ids: string[]) {
    const closing = new Set(ids);
    this.update((workspace) => ({
      ...workspace,
      openTabs: workspace.openTabs.filter((tab) => !closing.has(tab.id)),
      noteContents: Object.fromEntries(Object.entries(workspace.noteContents).filter(([id]) => !closing.has(id))),
      layout: Layout.simplify(ids.reduce((layout, id) => Layout.removeTab(layout, id), workspace.layout)),
    }));
  }
  openTab(tab: Tab, mode: 'open' | 'replace' = 'open', paneId?: string) {
    this.update((workspace) => {
      const existing = paneId ? null : Layout.findPaneByTab(workspace.layout, tab.id);
      const pane = existing ?? (paneId ? Layout.findPane(workspace.layout, paneId) : this.focusedPane) ?? this.focusedPane;
      const oldId = !existing && mode === 'replace' ? pane.activeTabId : null;
      const closing = oldId && oldId !== tab.id ? oldId : null;
      let layout = existing ? Layout.setActiveTab(workspace.layout, pane.id, tab.id)
        : Layout.addTabToPane(Layout.removeTab(workspace.layout, tab.id), pane.id, tab.id);
      if (closing) layout = Layout.removeTab(layout, closing);
      const tabs = workspace.openTabs.filter((item) => item.id !== closing);
      return {
        ...workspace,
        openTabs: tabs.some((item) => item.id === tab.id) ? tabs.map((item) => item.id === tab.id ? tab : item) : [...tabs, tab],
        noteContents: closing ? Object.fromEntries(Object.entries(workspace.noteContents).filter(([id]) => id !== closing)) : workspace.noteContents,
        layout: Layout.simplify(layout), focusedPaneId: pane.id,
      };
    });
  }
  completeSave(vaultId: string, tabId: string, draft: string, note: Note, epoch: number) {
    if (epoch !== this.epoch) return;
    this.update((workspace) => {
      const entry = workspace.noteContents[tabId];
      if (!entry) return workspace;
      const nextDraft = entry.draft === draft ? note.content : entry.draft;
      return { ...workspace,
        noteContents: { ...workspace.noteContents, [tabId]: { note, draft: nextDraft } },
        openTabs: workspace.openTabs.map((tab) => tab.id === tabId ? { ...tab, title: note.title } : tab),
      };
    }, vaultId);
  }
}
