/**
 * @file preload.cjs — Electron preload / context bridge
 *
 * Bridges the main process and the renderer via `contextBridge.exposeInMainWorld`
 * so the hosted renderer never has direct access to Node or Electron internals.
 *
 * Exposed API surface:
 *  - Desktop windows and shortcuts
 *  - Local agent runner and plan usage
 *  - Worktree and update helpers
 *
 * @module cascade-electron/preload
 */

const { contextBridge, ipcRenderer } = require('electron');

// Expose safe IPC methods to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  // ── Windows ─────────────────────────────────────────────────
  /**
   * Pop a tab out into its own OS window. Resolves with `{ popped }`: true when
   * the drop point was outside the current window (a new window was created),
   * false when it was inside (caller should keep the tab where it is).
   */
  popOutTab: ({ tab, screenX, screenY }) => ipcRenderer.invoke('window:popOutTab', { tab, screenX, screenY }),
  /**
   * Merge a popped-out tab back into the window under the drop point (defaults to
   * the main window). Resolves `{ merged }`: true closes this popout window.
   */
  mergeTab: ({ tab, screenX, screenY }) => ipcRenderer.invoke('window:mergeTab', { tab, screenX, screenY }),
  /**
   * Subscribe to a tab being merged back into this window from a popout.
   * Returns an unsubscribe function.
   */
  onAdoptTab: (callback) => {
    const listener = (_event, tab) => callback(tab);
    ipcRenderer.on('window:adoptTab', listener);
    return () => ipcRenderer.removeListener('window:adoptTab', listener);
  },

  // ── Shortcuts ────────────────────────────────────────────────
  /**
   * Subscribe to keyboard shortcuts forwarded from the main process.
   * Returns an unsubscribe function.
   */
  onShortcut: (callback) => {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on('shortcut', listener);
    return () => ipcRenderer.removeListener('shortcut', listener);
  },

  // ── Desktop agent runner relay ──────────────────────────────
  /** Configure main-process helper env (token/url) after login. */
  setRunnerToken: ({ token, apiUrl }) => ipcRenderer.invoke('runner:setToken', { token, apiUrl }),
  clearRunnerToken: () => ipcRenderer.invoke('runner:clearToken'),
  getRunnerStatus: () => ipcRenderer.invoke('runner:status'),
  /** Read locally authenticated Claude, Codex, and Grok plan usage. */
  getRunnerPlanUsage: () => ipcRenderer.invoke('runner:planUsage'),
  /** Inspect local Claude/Codex sessions and caption them through local Ollama. */
  getLocalAgents: ({ template } = {}) => ipcRenderer.invoke('orbit:getLocalAgents', { template }),
  readClipboardImage: () => ipcRenderer.invoke('clipboard:readImage'),
  // Local CLI execution (renderer hosts /runners; main spawns agents).
  startAgentRun: (opts) => ipcRenderer.invoke('agent:start', opts),
  cancelAgentRun: (runId) => ipcRenderer.invoke('agent:cancel', runId),
  getAgentRunState: (afterSeq = 0) => ipcRenderer.invoke('agent:getState', afterSeq),
  acknowledgeAgentEvent: (receipt) => ipcRenderer.invoke('agent:acknowledge', receipt),
  onAgentEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('agent:event', listener);
    return () => ipcRenderer.removeListener('agent:event', listener);
  },

  // ── Task workspaces (git worktrees) + pull requests ─────────
  // Isolated per-channel checkouts so parallel agents stop overwriting each
  // other. Creating, removing, pushing, and opening a PR are all explicit.
  listWorktrees: (dir) => ipcRenderer.invoke('worktree:list', { dir }),
  getWorktreeStatus: (dir) => ipcRenderer.invoke('worktree:status', { dir }),
  getWorktreeDiff: (dir) => ipcRenderer.invoke('worktree:diff', { dir }),
  getWorktreeFileDiff: (opts) => ipcRenderer.invoke('worktree:fileDiff', opts),
  createWorktree: (opts) => ipcRenderer.invoke('worktree:create', opts),
  prepareWorktree: (opts) => ipcRenderer.invoke('worktree:prepare', opts),
  removeWorktree: (opts) => ipcRenderer.invoke('worktree:remove', opts),
  createWorktreePullRequest: (opts) => ipcRenderer.invoke('worktree:createPullRequest', opts),
  getWorktreePullRequest: (dir) => ipcRenderer.invoke('worktree:pullRequest', { dir }),

  // ── App Update ──────────────────────────────────────────────
  // Stable bridge name retained for compatibility; updates now refresh in place.
  updateAndRestart: () => ipcRenderer.invoke('app:updateAndRestart'),
  onUpdateFailed: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('app:updateFailed', listener);
    return () => ipcRenderer.removeListener('app:updateFailed', listener);
  },
});
