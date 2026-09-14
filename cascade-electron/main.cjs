/**
 * @file main.cjs — Electron main process entry point
 *
 * Creates the main BrowserWindow, handles desktop IPC and keyboard shortcuts,
 * and manages the application lifecycle. Provides
 * navigation security guards that restrict loading to the operator-selected Fizzer
 * instance. Keyboard shortcuts are intercepted at the main-process level
 * and forwarded to the renderer via IPC when Chromium would otherwise
 * swallow them. Packaged builds start a private loopback Fizzer instance;
 * development loads Vite unless explicitly opted into the embedded runtime.
 *
 * @module cascade-electron/main
 */

// ═══════════════════════════════════════════════════════════════
// IMPORTS & CONFIG
// ═══════════════════════════════════════════════════════════════

const { app, BrowserWindow, ipcMain, session, Menu, shell, clipboard, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const {
  isSameOrigin,
  rendererUrlForOrigin,
  resolveInstanceOrigin,
  shouldUseEmbeddedBackend,
} = require('./instance-origin.cjs');
const { startEmbeddedBackend } = require('./embedded-backend.cjs');
const { launchMacOSInstaller, prepareMacOSUpdate } = require('./macos-updater.cjs');
const { installDesktopShellPath } = require('./shell-path.cjs');

// Finder/Dock launches receive launchd's minimal PATH instead of the user's
// shell PATH. Repair it before runner/probe modules capture CLI binary names.
installDesktopShellPath({ packaged: app.isPackaged });

const explicitUserDataDir = process.env.CASCADE_USER_DATA_DIR || process.env.CASCADE_ELECTRON_DATA_DIR;
if (explicitUserDataDir) {
  const userDataDir = path.resolve(explicitUserDataDir);
  fs.mkdirSync(userDataDir, { recursive: true });
  app.setPath('userData', userDataDir);
}

const { startLocalAgentRun, cancelLocalAgentRun, reapOrphanedLocalAgentRuns } = require('./agent-runner.cjs');
const { connectDesktopRunner, disconnectDesktopRunner, isDesktopRunnerConnected } = require('./desktop-runner-host.cjs');
const { collectPlanUsage } = require('./plan-usage.cjs');
const { AgentRunState, settleCancelAcknowledgement } = require('./agent-run-state.cjs');
const { collectLocalAgents } = require('./local-agents.cjs');
const worktrees = require('./worktrees.cjs');
const APP_NAME = 'Fizzer';
const USE_EMBEDDED_BACKEND = shouldUseEmbeddedBackend({ packaged: app.isPackaged });
let INSTANCE_ORIGIN = USE_EMBEDDED_BACKEND ? null : resolveInstanceOrigin({ packaged: app.isPackaged });
let APP_URL = INSTANCE_ORIGIN ? rendererUrlForOrigin(INSTANCE_ORIGIN) : null;
// Same as client `--bg-base` (hsl(225, 12%, 7%)). Set on every window so the
// shell is never Chromium's default white while the hosted page is loading.
const APP_BACKGROUND = '#101014';
app.setName(APP_NAME);

// Suppress GLib-GObject and GTK warnings on Linux.
if (process.platform === 'linux') {
  process.env.G_MESSAGES_DEBUG = '';
  process.env.GTK_DEBUG = '';
}

// Packaged builds get the Fizzer gem from the bundle's own icon (.icns/.ico),
// but Linux windows and unpackaged launches have to be told explicitly or they
// fall back to the stock Electron logo.
const APP_ICON = path.join(__dirname, 'assets', 'icon.png');

let mainWindow;
let desktopUpdateInProgress = false;
let embeddedBackend;
let appQuitting = false;
const agentRunState = new AgentRunState();
// Removed: dead `serverProcess` variable — it was declared but never assigned,
// and the corresponding `if (serverProcess) serverProcess.kill()` in the
// 'closed' handler was therefore unreachable.

// ═══════════════════════════════════════════════════════════════
// WINDOW CREATION
// ═══════════════════════════════════════════════════════════════

/**
 * Checks whether the app is running in development mode.
 * Returns `true` when launched via `electron .` (i.e. not packaged).
 *
 * @returns {boolean}
 */
function isDevelopmentMode() {
  return !app.isPackaged;
}

/**
 * Application menu. No Debug menu — reload, DevTools, and zoom live on
 * keyboard shortcuts in configureWindow (Ctrl/Cmd+R, Ctrl/Cmd+Shift+I, etc.).
 *
 * macOS still needs App/Edit/Window roles so Cmd+C/V/X/A work. Linux/Windows
 * get no menu bar (clipboard works on webContents without Edit roles).
 *
 * @returns {Electron.Menu | null}
 */
function buildApplicationMenu() {
  if (process.platform !== 'darwin') return null;

  return Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ]);
}

/** Resolve the renderer URL pinned to the main-process-selected instance. */
function getAppBaseUrl() {
  if (!APP_URL) throw new Error('Fizzer local backend has not started');
  return APP_URL;
}

function getProjectRoot() {
  return path.resolve(__dirname, '..');
}

function getDesktopDownloadUrl() {
  return process.env.CASCADE_DESKTOP_DOWNLOAD_URL || 'https://cscd.online/download';
}

function canSelfUpdateFromSource() {
  if (app.isPackaged) return false;
  return fs.existsSync(path.join(getProjectRoot(), '.git'));
}

function runUpdateCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      env: process.env,
    });
    let output = '';
    const appendOutput = (chunk) => {
      output = (output + chunk.toString()).slice(-16_000);
    };
    child.stdout.on('data', appendOutput);
    child.stderr.on('data', appendOutput);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        const rendered = [command, ...args].join(' ');
        reject(new Error(`${rendered} failed with exit code ${code}.\n${output}`.trim()));
      }
    });
  });
}

async function updateDesktopInPlace() {
  const root = getProjectRoot();
  const gitBin = process.platform === 'win32' ? 'git.exe' : 'git';
  const unmerged = await runUpdateCommand(gitBin, ['diff', '--name-only', '--diff-filter=U'], root);
  if (unmerged.trim()) {
    throw new Error(`Resolve existing checkout conflicts before retrying Update. Saved work remains in git stash list.\n${unmerged.trim()}`);
  }
  let upstream;
  try {
    upstream = (await runUpdateCommand(gitBin, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], root)).trim();
  } catch {
    upstream = 'origin/master';
  }
  await runUpdateCommand(gitBin, ['fetch', ...(upstream === 'origin/master' ? ['origin'] : [])], root);
  const target = (await runUpdateCommand(gitBin, ['rev-parse', upstream], root)).trim();
  // A stash snapshot writes Git objects without removing work or changing the
  // index. Check the incoming merge before touching the shared checkout.
  const snapshot = (await runUpdateCommand(gitBin, ['stash', 'create'], root)).trim();
  if (snapshot) {
    try {
      await runUpdateCommand(gitBin, ['merge-tree', '--write-tree', '--merge-base=HEAD', target, snapshot], root);
    } catch (error) {
      throw new Error(`Update conflicts with local work. Checkout was left unchanged; reconcile these changes before retrying Update.\n${error.message}`);
    }
  }

  // The desktop shell loads its UI from its selected instance, but its local
  // agent runner imports the generated dist/cli-agents module. dist is ignored,
  // so a source pull alone leaves CLI/harness fixes dormant until somebody
  // happens to build manually. Rebuild in place; it does not terminate main or
  // active agent processes.
  // Stash local changes so a dirty tree cannot abort the update. Rebase keeps
  // real local commits while also recovering when the same patch was merged
  // upstream under a different commit id (a common outcome of parallel agent
  // work); --ff-only permanently wedged the update button in that state.
  const stashOut = await runUpdateCommand(gitBin, ['stash', 'push', '--include-untracked', '-m', 'Fizzer desktop update backup'], root);
  const didStash = !/No local changes to save/i.test(stashOut);
  const backup = didStash
    ? (await runUpdateCommand(gitBin, ['rev-parse', 'stash@{0}'], root)).trim()
    : null;
  let updateError;
  try {
    await runUpdateCommand(gitBin, ['rebase', target], root);
  } catch (error) {
    // A conflicted rebase must not remain half-open when we restore the user's
    // uncommitted work below.
    try { await runUpdateCommand(gitBin, ['rebase', '--abort'], root); } catch { /* no rebase in progress */ }
    updateError = error;
  }
  if (backup) {
    try {
      // Apply the exact backup; never consume another stash created during the build.
      await runUpdateCommand(gitBin, ['stash', 'apply', backup], root);
    } catch (error) {
      throw new Error([
        updateError?.message,
        `Local work restoration failed. Backup ${backup} is retained in git stash list (including untracked files). Resolve checkout conflicts before retrying Update; do not drop the backup until your work is recovered.`,
        error.message,
      ].filter(Boolean).join('\n\n'));
    }
    const latest = (await runUpdateCommand(gitBin, ['rev-parse', 'stash@{0}'], root)).trim();
    if (latest === backup) await runUpdateCommand(gitBin, ['stash', 'drop', 'stash@{0}'], root);
  }
  if (updateError) throw updateError;
  const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  await runUpdateCommand(npmBin, ['run', 'build'], root);
}

/** Reload every renderer without terminating the Electron main process. */
function refreshDesktopWindows() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.reloadIgnoringCache();
  }
}

/** Send an IPC message to every live window. */
function broadcastToWindows(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function isAllowedNavigation(url) {
  return isSameOrigin(url, INSTANCE_ORIGIN);
}

function isSafeExternalUrl(url) {
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * Shared per-window wiring: navigation guards, external-window blocking, and
 * keyboard shortcuts. Applied to the main window and every popped-out pane
 * window so they behave identically.
 */
function configureWindow(win) {
  // Linux/Windows attach the application menu to each window. Even with
  // Menu.setApplicationMenu(null), a leftover window menu bar (e.g. old Debug)
  // can stick until we explicitly clear it per-window.
  if (process.platform !== 'darwin') {
    try { win.setMenu(null); } catch { /* ignore */ }
    try { win.setMenuBarVisibility(false); } catch { /* ignore */ }
    try { win.setAutoHideMenuBar(true); } catch { /* ignore */ }
  }

  // Renderer OOM/crashes leave a dead shell unless we reload. Keep agents alive
  // in main; only bounce the webContents (same path as Ctrl/Cmd+R).
  win.webContents.on('render-process-gone', (_event, details) => {
    const reason = details?.reason || 'unknown';
    const exitCode = details?.exitCode;
    console.error('[Main] render-process-gone', { windowId: win.id, reason, exitCode });
    // clean-exit is a normal teardown (window close / app quit) — do not reload.
    if (reason === 'clean-exit' || win.isDestroyed() || win.webContents.isDestroyed()) return;
    setTimeout(() => {
      if (win.isDestroyed() || win.webContents.isDestroyed()) return;
      win.webContents.reloadIgnoringCache();
    }, 250);
  });

  const guardNavigation = (event, url) => {
    try {
      if (!isAllowedNavigation(url)) {
        event.preventDefault();
        if (isSafeExternalUrl(url)) void shell.openExternal(url);
        else console.log('[Main] Blocked navigation to:', url);
      }
    } catch {
      event.preventDefault();
    }
  };
  win.webContents.on('will-navigate', guardNavigation);
  win.webContents.on('will-redirect', guardNavigation);

  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (!isAllowedNavigation(url)) {
        if (isSafeExternalUrl(url)) void shell.openExternal(url);
        else console.log('[Main] Blocked window open to:', url);
        return { action: 'deny' };
      }
    } catch {
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // No native Electron/Chromium right-click menu (Inspect Element, Back, etc.).
  // In-app React menus (sidebar/chat) use DOM handlers and still work.
  win.webContents.on('context-menu', (event) => {
    event.preventDefault();
  });
  win.on('system-context-menu', (event) => {
    event.preventDefault();
  });

  // Local keyboard shortcuts (only fire while this window is focused).
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const isMac = process.platform === 'darwin';
    const modifier = isMac ? input.meta : input.control;

    if (modifier && input.code === 'KeyR' && !input.shift) {
      event.preventDefault();
      win.webContents.reload();
    } else if (modifier && input.code === 'KeyR' && input.shift) {
      event.preventDefault();
      app.relaunch();
      app.quit();
    } else if ((modifier && input.shift && input.code === 'KeyI') || input.code === 'F12') {
      event.preventDefault();
      win.webContents.toggleDevTools();
    } else if (modifier && (input.code === 'Equal' || input.code === 'NumpadAdd')) {
      event.preventDefault();
      win.webContents.setZoomLevel(win.webContents.getZoomLevel() + 0.5);
    } else if (modifier && (input.code === 'Minus' || input.code === 'NumpadSubtract')) {
      event.preventDefault();
      win.webContents.setZoomLevel(win.webContents.getZoomLevel() - 0.5);
    } else if (modifier && (input.code === 'Digit0' || input.code === 'Numpad0')) {
      event.preventDefault();
      win.webContents.setZoomLevel(0);
    } else if (modifier && input.code === 'KeyN' && !input.shift) {
      // Chromium reserves Ctrl+N; intercept and forward to the renderer.
      event.preventDefault();
      win.webContents.send('shortcut', 'new-note');
    } else if (modifier && input.code === 'Backslash' && !input.shift) {
      event.preventDefault();
      win.webContents.send('shortcut', 'toggle-sidebar');
    }
  });
}

/**
 * Creates the main application window with security-hardened webPreferences.
 * Loads the selected local, hosted, or development instance.
 */
function createWindow() {
  // Always install (or clear) the app menu before windows open.
  Menu.setApplicationMenu(buildApplicationMenu());

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: APP_ICON,
    backgroundColor: APP_BACKGROUND,
    // Never show a menu bar on Linux/Windows (Debug used to live here in
    // unpackaged launches). macOS uses the system menu bar via setApplicationMenu.
    autoHideMenuBar: process.platform !== 'darwin',
    // Keep the renderer warm while unfocused so alt-tab back doesn't wait on
    // Chromium's background timer/rAF throttle before first paint.
    backgroundThrottling: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });

  configureWindow(mainWindow);

  // Load immediately. The embedded service has already passed its health
  // check; configured remote origins are left to Chromium's network stack.
  const baseUrl = getAppBaseUrl();
  console.log('[Main] Loading app URL:', baseUrl);
  mainWindow.loadURL(baseUrl);

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || (app.isPackaged && !USE_EMBEDDED_BACKEND)) return;
    console.error('[Main] Failed to load app URL:', errorCode, errorDescription, validatedURL);
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.loadURL(getAppBaseUrl());
    }, 1000);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * Open a note tab that was dragged out of a window into its own OS window.
 * The tab descriptor rides in the URL hash; the renderer detects `#popout=`
 * and renders a single-tab workspace.
 */
function createPaneWindow(descriptor, bounds) {
  const win = new BrowserWindow({
    width: (bounds && bounds.width) || 900,
    height: (bounds && bounds.height) || 680,
    x: bounds && bounds.x,
    y: bounds && bounds.y,
    icon: APP_ICON,
    backgroundColor: APP_BACKGROUND,
    autoHideMenuBar: process.platform !== 'darwin',
    backgroundThrottling: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });

  configureWindow(win);
  const hash = '#popout=' + encodeURIComponent(JSON.stringify(descriptor));
  win.loadURL(getAppBaseUrl() + hash);
  return win;
}

// ═══════════════════════════════════════════════════════════════
// WINDOW IPC HANDLERS
// ═══════════════════════════════════════════════════════════════

/**
 * Pop a tab out into its own OS window when it was dragged and released outside
 * the sending window. `screenX/screenY` are the drop point in screen pixels;
 * if they fall inside the sender's bounds we treat it as an in-window drop and
 * do nothing (`popped: false`), so the renderer keeps the tab where it is.
 */
ipcMain.handle('window:popOutTab', async (event, { tab, screenX, screenY }) => {
  try {
    if (!tab || typeof tab.id !== 'string') throw new Error('Missing tab descriptor');
    const senderWin = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    const b = senderWin ? senderWin.getBounds() : { x: 0, y: 0, width: 0, height: 0 };
    const x = Number(screenX);
    const y = Number(screenY);
    const inside =
      Number.isFinite(x) && Number.isFinite(y) &&
      x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;

    if (inside) return { success: true, popped: false };

    const width = 900;
    const height = 680;
    const bounds = {
      width,
      height,
      x: Number.isFinite(x) ? Math.round(x - width / 2) : undefined,
      y: Number.isFinite(y) ? Math.round(y - 40) : undefined,
    };
    createPaneWindow(tab, bounds);
    return { success: true, popped: true };
  } catch (error) {
    console.error('[IPC] Failed to pop out tab:', error);
    return { success: false, error: error.message };
  }
});

/**
 * Merge a popped-out tab back into another window. Called when the popout's tab
 * is dragged and released outside the popout: the destination is the window
 * under the drop point (falling back to the main window), which is told to adopt
 * the tab; the now-empty popout window is closed.
 */
ipcMain.handle('window:mergeTab', async (event, { tab, screenX, screenY }) => {
  try {
    if (!tab || typeof tab.id !== 'string') throw new Error('Missing tab descriptor');
    const sender = BrowserWindow.fromWebContents(event.sender);
    const x = Number(screenX);
    const y = Number(screenY);
    const within = (b) => Number.isFinite(x) && Number.isFinite(y) && x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;

    // Releasing inside the popout itself is not a merge gesture.
    if (sender && !sender.isDestroyed() && within(sender.getBounds())) {
      return { success: true, merged: false };
    }

    const target =
      BrowserWindow.getAllWindows().find((w) => w !== sender && !w.isDestroyed() && within(w.getBounds())) ||
      (sender !== mainWindow && mainWindow && !mainWindow.isDestroyed() ? mainWindow : null);

    if (!target) return { success: true, merged: false };

    target.webContents.send('window:adoptTab', tab);
    target.focus();
    if (sender && !sender.isDestroyed()) sender.close();
    return { success: true, merged: true };
  } catch (error) {
    console.error('[IPC] Failed to merge tab:', error);
    return { success: false, error: error.message };
  }
});

// ═══════════════════════════════════════════════════════════════
// LOCAL AGENT IPC HANDLERS
// ═══════════════════════════════════════════════════════════════

/** Run a CLI agent (Grok, Codex, etc.) on this machine instead of the remote server. */
const localAgentRunPromises = new Map();
ipcMain.handle('agent:start', async (event, opts) => {
  try {
    const runId = Number(opts?.runId);
    if (!Number.isFinite(runId)) throw new Error('Invalid run id');
    // A renderer reload can make the server re-assert a delegation. The child
    // already owned by main must continue; never start a duplicate process.
    if (!agentRunState.start(runId)) return { success: true, alreadyRunning: true };
    const sendEvent = (payload) => {
      const eventPayload = agentRunState.record(payload);
      if (!eventPayload) return;
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
          window.webContents.send('agent:event', eventPayload);
        }
      }
    };
    const runPromise = startLocalAgentRun(opts, sendEvent).catch((error) => {
      console.error('[IPC] Local agent run failed:', error);
      agentRunState.cancel(runId);
    }).finally(() => {
      if (localAgentRunPromises.get(runId) === runPromise) localAgentRunPromises.delete(runId);
    });
    localAgentRunPromises.set(runId, runPromise);
    return { success: true };
  } catch (error) {
    console.error('[IPC] Failed to start local agent:', error);
    return { success: false, error: error.message };
  }
});

/** Cancel a locally running CLI agent process. */
ipcMain.handle('agent:cancel', async (_event, runId) => {
  try {
    const id = Number(runId);
    const running = localAgentRunPromises.get(id);
    const cancelled = await cancelLocalAgentRun(id);
    // Do not acknowledge steering until close/error cleanup has completed.
    // The CLI registry is cleared in the child's close handler just before the
    // owning promise settles; a Stop in that interval used to return false and
    // leave a terminal Akron run behind a stale "Could not cancel run" notice.
    const acknowledged = await settleCancelAcknowledgement(cancelled, running);
    agentRunState.cancel(runId);
    return { success: acknowledged };
  } catch (error) {
    console.error('[IPC] Failed to cancel local agent:', error);
    return { success: false, error: error.message };
  }
});

/** Restore main-owned runs and missed events after renderer reload/freeze. */
ipcMain.handle('agent:getState', async (_event, afterSeq = 0) => agentRunState.snapshot(afterSeq));
ipcMain.handle('agent:acknowledge', async (_event, { instanceId, seq } = {}) => (
  agentRunState.acknowledge(instanceId, seq)
));

/** Configure helper env for local agent children (renderer owns /runners socket). */
ipcMain.handle('runner:setToken', async (_event, { token, apiUrl } = {}) => {
  try {
    if (!isSameOrigin(apiUrl, INSTANCE_ORIGIN)) {
      throw new Error('Runner origin does not match the desktop instance selected at startup');
    }
    return connectDesktopRunner(token, INSTANCE_ORIGIN);
  } catch (error) {
    console.error('[IPC] Failed to configure desktop runner:', error);
    return { success: false, error: error.message };
  }
});

/** Clear helper env on logout. */
ipcMain.handle('runner:clearToken', async () => {
  try {
    await disconnectDesktopRunner();
    return { success: true };
  } catch (error) {
    console.error('[IPC] Failed to clear desktop runner:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('runner:status', async () => ({
  // Token present means main is configured; socket online is renderer-side.
  connected: isDesktopRunnerConnected(),
}));

ipcMain.handle('runner:planUsage', async () => {
  try {
    const grokCwd = path.join(app.getPath('userData'), 'usage-probe');
    fs.mkdirSync(grokCwd, { recursive: true });
    return { usage: await collectPlanUsage({ grokCwd }) };
  } catch (error) {
    console.error('[IPC] Failed to probe subscription usage:', error);
    return { usage: {}, error: error.message };
  }
});

/** Read local agent state and begin/refresh local Ollama captions. */
ipcMain.handle('orbit:getLocalAgents', async (_event, { template } = {}) => {
  try {
    return collectLocalAgents(typeof template === 'string' ? template : '');
  } catch (error) {
    console.error('[IPC] Failed to inspect local agents:', error);
    return { nodes: [], edges: [], scannedAt: Date.now(), error: error.message };
  }
});

ipcMain.handle('clipboard:readImage', async () => {
  const image = clipboard.readImage();
  if (image.isEmpty()) return null;
  const url = image.toDataURL();
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (!match) return null;
  return {
    media_type: match[1],
    data: match[2],
    url,
    name: 'clipboard-image.png',
  };
});

// ── Task workspaces (git worktrees) and pull requests ────────
// Git and `gh` only ever run in the main process; the renderer sends the
// channel's working directory and gets structured status back.
ipcMain.handle('worktree:list', async (_event, { dir } = {}) => worktrees.listWorkspaces(dir));
ipcMain.handle('worktree:status', async (_event, { dir } = {}) => worktrees.workspaceStatus(dir));
ipcMain.handle('worktree:diff', async (_event, { dir } = {}) => worktrees.workspaceDiff(dir));
ipcMain.handle('worktree:fileDiff', async (_event, opts = {}) => worktrees.workspaceFileDiff(opts));
ipcMain.handle('worktree:create', async (_event, opts = {}) => worktrees.createWorkspace(opts));
ipcMain.handle('worktree:prepare', async (_event, opts = {}) => worktrees.prepareWorkspace(opts));
ipcMain.handle('worktree:remove', async (_event, opts = {}) => worktrees.removeWorkspace(opts));
ipcMain.handle('worktree:prune', async (_event, opts = {}) => worktrees.pruneWorkspaces(opts));
ipcMain.handle('worktree:createPullRequest', async (_event, opts = {}) => worktrees.createPullRequest(opts));
ipcMain.handle('worktree:pullRequest', async (_event, { dir } = {}) => worktrees.pullRequestStatus(dir));

// ── Desktop app update ───────────────────────────────────────
// Keep the original channel name so updated hosted UI remains compatible with
// desktop shells that have not received the in-place updater yet.
ipcMain.handle('app:updateAndRestart', async () => {
  try {
    if (desktopUpdateInProgress) {
      return { success: false, error: 'A desktop update is already running.' };
    }

    if (!canSelfUpdateFromSource()) {
      if (process.platform === 'darwin' && app.isPackaged) {
        desktopUpdateInProgress = true;
        const update = await prepareMacOSUpdate({
          arch: process.arch,
          executablePath: app.getPath('exe'),
        });
        launchMacOSInstaller(update);
        setTimeout(() => app.quit(), 250);
        return { success: true, restarting: true };
      }

      const downloadUrl = getDesktopDownloadUrl();
      await shell.openExternal(downloadUrl);
      return {
        success: false,
        error: `This installed build cannot update itself yet. Opened ${downloadUrl} to download the latest desktop app.`,
      };
    }

    desktopUpdateInProgress = true;
    void updateDesktopInPlace()
      .then(() => {
        desktopUpdateInProgress = false;
        refreshDesktopWindows();
      })
      .catch((error) => {
        desktopUpdateInProgress = false;
        console.error('[IPC] Desktop update failed:', error);
        broadcastToWindows('app:updateFailed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });

    return { success: true, refreshing: true };
  } catch (error) {
    desktopUpdateInProgress = false;
    console.error('[IPC] Desktop update failed:', error);
    return { success: false, error: error.message };
  }
});

// ═══════════════════════════════════════════════════════════════
// APP LIFECYCLE
// ═══════════════════════════════════════════════════════════════

app.whenReady().then(async () => {
  // `npm start` runs from the generic Electron binary, whose dock tile is the
  // Electron logo until the running app overrides it.
  if (process.platform === 'darwin' && !app.isPackaged && app.dock) {
    try { app.dock.setIcon(APP_ICON); } catch { /* non-fatal: dev cosmetics */ }
  }

  if (USE_EMBEDDED_BACKEND) {
    embeddedBackend = await startEmbeddedBackend({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      projectRoot: getProjectRoot(),
      userDataDir: app.getPath('userData'),
    });
    INSTANCE_ORIGIN = embeddedBackend.origin;
    APP_URL = rendererUrlForOrigin(INSTANCE_ORIGIN);
    embeddedBackend.process.once('exit', (code, signal) => {
      if (appQuitting) return;
      dialog.showErrorBox(
        'Fizzer local service stopped',
        `The private local service exited (code ${code ?? 'none'}, signal ${signal ?? 'none'}). Reopen Fizzer to restart it.`,
      );
    });
  }

  // Allow app-shell permissions needed by the selected app instance.
  session.defaultSession.setPermissionCheckHandler(() => true);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(true);
  });

  createWindow();

  // Housekeeping after first paint. Reaping imports the CLI agent module and
  // prune walks every registered worktree — neither should hold the window.
  void reapOrphanedLocalAgentRuns().catch((error) => {
    console.error('[Main] Failed to reap orphaned agent processes:', error);
  });
  void worktrees.pruneWorkspaces().then((pruned) => {
    if (pruned.removed.length || pruned.forgotten.length) {
      console.log(
        `[Main] Pruned ${pruned.removed.length} finished task workspace(s)`
        + `${pruned.forgotten.length ? `, forgot ${pruned.forgotten.length} missing row(s)` : ''}`
        + `${pruned.kept.length ? `, kept ${pruned.kept.length}` : ''}`,
      );
    }
  }).catch((error) => {
    console.error('[Main] Failed to prune task workspaces:', error);
  });
}).catch((error) => {
  embeddedBackend?.stop();
  console.error('[Main] Failed to start Fizzer:', error);
  dialog.showErrorBox('Fizzer could not start', error instanceof Error ? error.message : String(error));
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  appQuitting = true;
  embeddedBackend?.stop();
  disconnectDesktopRunner();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});
