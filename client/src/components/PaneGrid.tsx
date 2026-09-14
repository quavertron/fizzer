/**
 * @file PaneGrid.tsx — Recursive renderer for the tiling pane layout
 *
 * Walks a {@link LayoutNode} tree (see `../layout/tree.ts`) and renders it as
 * nested flex rows/columns with resizable dividers. Each leaf pane shows its own
 * tab strip plus the active tab's content (provided by the parent via
 * `renderContent`). Tabs can be dragged between panes; dropping near a pane edge
 * splits it, dropping in the centre (or on the strip) docks the tab into it.
 *
 * @component
 */

import { Fragment, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { FileText, ExternalLink, X, Hash, LayoutDashboard, PanelLeftClose, PanelLeftOpen, Plus, Sparkles } from 'lucide-react';
import type { Tab } from './TabBar';
import { NOTE_DND_TYPE } from '../docEmbeds';
import { usePopupMenu } from '../ui/popupMenu';
import { isPane, type DropSide, type LayoutNode, type PaneNode, type SplitNode } from '../layout/tree';
import {
  acquireInteractionLock,
  bindDragGesture,
  releaseInteractionLock,
} from '../ui/interactionLocks';

/** Tab-strip context menu. Portaled to body so `.tab-bar` overflow cannot clip it. */
type TabStripMenu =
  | { kind: 'new'; x: number; y: number }
  | { kind: 'tab'; x: number; y: number; tabId: string };

const DRAG_MIME = 'application/x-cascade-tab';

export interface TabDragPayload {
  tabId: string;
  fromPaneId: string;
}

interface PaneGridProps {
  node: LayoutNode;
  openTabs: Tab[];
  focusedPaneId: string;
  onFocusPane: (paneId: string) => void;
  onSelectTab: (paneId: string, tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onCloseOtherTabs: (tabIds: string[], keepTabId: string) => void;
  /** A tab was dropped onto a pane; `index` only applies to `center` drops. */
  onDropTab: (payload: TabDragPayload, targetPaneId: string, side: DropSide, index?: number) => void;
  onDropNote: (noteId: string, targetPaneId: string, side: DropSide, index?: number) => void;
  onResize: (splitId: string, sizes: number[]) => void;
  onCreateNote?: (paneId: string) => void;
  onCreateTab?: (paneId: string) => void;
  onCreateChat?: (paneId: string) => void;
  onOpenSuperkanban?: (paneId: string) => void;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  /** Only the first (top-left) pane owns the global sidebar toggle. */
  showSidebarToggle?: boolean;
  onPopOut?: (tabId: string) => void;
  /** A tab was dragged and released outside any pane; `screenX/screenY` are the
   *  drop point in screen pixels so the parent can pop it out at the cursor. */
  onDetachTab?: (tabId: string, screenX: number, screenY: number) => void;
  renderContent: (tab: Tab, paneId: string) => ReactNode;
}

const MIN_FRACTION = 0.12;

export function tabInsertionIndex(
  orderedIds: string[],
  movingId: string,
  targetId: string,
  placement: 'before' | 'after',
) {
  if (movingId === targetId) return orderedIds.indexOf(movingId);
  const withoutMoving = orderedIds.filter((id) => id !== movingId);
  const targetIndex = withoutMoving.indexOf(targetId);
  if (targetIndex < 0) return withoutMoving.length;
  return targetIndex + (placement === 'after' ? 1 : 0);
}

function readPayload(event: DragEvent): TabDragPayload | null {
  try {
    const raw = event.dataTransfer.getData(DRAG_MIME);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TabDragPayload;
    if (typeof parsed.tabId === 'string' && typeof parsed.fromPaneId === 'string') return parsed;
    return null;
  } catch {
    return null;
  }
}

/** Map pointer position within a rect to a drop side (centre vs the 4 edges). */
function sideFromPosition(rect: DOMRect, clientX: number, clientY: number): DropSide {
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  const edge = 0.25;
  // Pick the nearest edge only when clearly outside the centre box.
  const distances: Array<{ side: DropSide; d: number }> = [
    { side: 'left', d: x },
    { side: 'right', d: 1 - x },
    { side: 'top', d: y },
    { side: 'bottom', d: 1 - y },
  ];
  distances.sort((a, b) => a.d - b.d);
  const nearest = distances[0];
  if (nearest.d > edge) return 'center';
  return nearest.side;
}

function TabIcon({ type }: { type: Tab['type'] }) {
  if (type === 'chat') return <Hash size={13} className="text-secondary" style={{ marginRight: 6 }} />;
  if (type === 'superkanban') return <LayoutDashboard size={13} className="text-tertiary" style={{ marginRight: 6 }} />;
  if (type === 'new') return <Sparkles size={13} className="text-tertiary" style={{ marginRight: 6 }} />;
  return <FileText size={13} className="text-tertiary" style={{ marginRight: 6 }} />;
}

// ─── Per-pane tab strip ─────────────────────────────────────────
function PaneTabStrip({
  pane,
  openTabs,
  isFocused,
  onSelectTab,
  onCloseTab,
  onCloseOtherTabs,
  onDropTab,
  onDropNote,
  onCreateTab,
  onCreateNote,
  onCreateChat,
  onOpenSuperkanban,
  onPopOut,
  onDetachTab,
  sidebarOpen,
  onToggleSidebar,
  showSidebarToggle,
}: {
  pane: PaneNode;
  openTabs: Tab[];
  isFocused: boolean;
  onSelectTab: (paneId: string, tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onCloseOtherTabs: (tabIds: string[], keepTabId: string) => void;
  onDropTab: PaneGridProps['onDropTab'];
  onDropNote: PaneGridProps['onDropNote'];
  onCreateTab?: (paneId: string) => void;
  onCreateNote?: (paneId: string) => void;
  onCreateChat?: (paneId: string) => void;
  onOpenSuperkanban?: (paneId: string) => void;
  onPopOut?: (tabId: string) => void;
  onDetachTab?: (tabId: string, screenX: number, screenY: number) => void;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  showSidebarToggle?: boolean;
}) {
  const tabs = pane.tabIds
    .map((id) => openTabs.find((t) => t.id === id))
    .filter((t): t is Tab => Boolean(t));

  const [contextMenu, setContextMenu] = useState<TabStripMenu | null>(null);
  const contextMenuRef = usePopupMenu<HTMLDivElement>(contextMenu);
  const [tabDropHint, setTabDropHint] = useState<{ tabId: string; placement: 'before' | 'after' } | null>(null);

  // Only listen while open (and after the opening gesture settles). A permanent
  // window click listener can dismiss the menu in the same right-click that opened it.
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    const timer = window.setTimeout(() => {
      window.addEventListener('pointerdown', close);
      window.addEventListener('click', close);
      window.addEventListener('scroll', close, true);
    }, 0);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [contextMenu]);

  const handleContextMenu = (e: React.MouseEvent, tabId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      kind: 'tab',
      x: e.clientX,
      y: e.clientY,
      tabId,
    });
  };

  const closeMenu = () => setContextMenu(null);

  const handleDragStart = (event: DragEvent, tabId: string) => {
    const payload: TabDragPayload = { tabId, fromPaneId: pane.id };
    event.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
    // Let the sidebar accept an open (including unlisted/implicit) note tab as
    // a note drop. Its move endpoint also promotes unlisted notes to listed.
    event.dataTransfer.setData(NOTE_DND_TYPE, tabId);
    event.dataTransfer.effectAllowed = 'move';
  };

  const handleStripDrop = (event: DragEvent, index?: number) => {
    const payload = readPayload(event);
    const noteId = event.dataTransfer.getData(NOTE_DND_TYPE);
    if (!payload && !noteId) return;
    event.preventDefault();
    event.stopPropagation();
    setTabDropHint(null);
    if (payload) onDropTab(payload, pane.id, 'center', index);
    else onDropNote(noteId, pane.id, 'center', index);
  };

  const allowDrop = (event: DragEvent) => {
    if (event.dataTransfer.types.includes(DRAG_MIME) || event.dataTransfer.types.includes(NOTE_DND_TYPE)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    }
  };

  const handleTabDragOver = (event: DragEvent, tabId: string) => {
    if (!event.dataTransfer.types.includes(DRAG_MIME) && !event.dataTransfer.types.includes(NOTE_DND_TYPE)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    const rect = event.currentTarget.getBoundingClientRect();
    const placement = event.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
    setTabDropHint((current) => current?.tabId === tabId && current.placement === placement
      ? current
      : { tabId, placement });
  };

  const handleTabDrop = (event: DragEvent, targetTabId: string) => {
    const payload = readPayload(event);
    const noteId = event.dataTransfer.getData(NOTE_DND_TYPE);
    if (!payload && !noteId) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const placement = event.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
    setTabDropHint(null);
    const movingId = payload?.tabId ?? noteId;
    if (movingId === targetTabId) return;
    const index = tabInsertionIndex(pane.tabIds, movingId, targetTabId, placement);
    if (payload) onDropTab(payload, pane.id, 'center', index);
    else onDropNote(noteId, pane.id, 'center', index);
  };

  return (
    <div
      className={`tab-bar pane-tab-bar${isFocused ? ' is-focused' : ''}`}
      onDragOver={allowDrop}
      onDrop={(e) => handleStripDrop(e)}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setTabDropHint(null);
      }}
    >
      {showSidebarToggle && (
        <button
          id="sidebar-toggle-tab-btn"
          type="button"
          className="tab-sidebar-toggle"
          onClick={onToggleSidebar}
          title={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
          aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
        >
          {sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
        </button>
      )}
      {tabs.map((tab) => {
        const displayedTitle = tab.type === 'chat' ? tab.title.replace(/^#/, '') : tab.title;
        return (
        <button
          key={tab.id}
          className={`tab-item${tab.id === pane.activeTabId ? ' active' : ''}${
            tabDropHint?.tabId === tab.id ? ` is-drop-${tabDropHint.placement}` : ''
          }`}
          draggable
          onDragStart={(e) => handleDragStart(e, tab.id)}
          onDragEnd={(e) => {
            setTabDropHint(null);
            // dropEffect 'none' = released outside any pane drop target → detach
            // into its own window (the main process ignores in-window releases).
            if (e.dataTransfer.dropEffect === 'none') {
              onDetachTab?.(tab.id, e.screenX, e.screenY);
            }
          }}
          onDragOver={(e) => handleTabDragOver(e, tab.id)}
          onDrop={(e) => handleTabDrop(e, tab.id)}
          onClick={() => onSelectTab(pane.id, tab.id)}
          onContextMenu={(e) => handleContextMenu(e, tab.id)}
          onAuxClick={(e) => {
            if (e.button === 1) {
              e.preventDefault();
              onCloseTab(tab.id);
            }
          }}
          title={displayedTitle}
        >
          {tab.dirty && <span className="tab-dirty" />}
          <span className="tab-icon"><TabIcon type={tab.type} /></span>
          <span className="tab-title">{displayedTitle || 'Untitled'}</span>
          {onPopOut && (
            <span
              className="tab-popout"
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                onPopOut(tab.id);
              }}
              title="Open in new window"
            >
              <ExternalLink size={11} />
            </span>
          )}
          <span
            className="tab-close"
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onCloseTab(tab.id);
            }}
            title="Close tab"
          >
            ×
          </span>
        </button>
        );
      })}
      {onCreateTab && (
        <button
          type="button"
          className="tab-new-btn"
          onClick={() => onCreateTab(pane.id)}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setContextMenu({ kind: 'new', x: event.clientX, y: event.clientY });
          }}
          title="New tab (right-click for options)"
          aria-label="New tab"
        >
          <Plus size={14} />
        </button>
      )}
      {/* Portaled: `.tab-bar` uses overflow-x/y that clips in-strip fixed menus. */}
      {contextMenu && createPortal(
        <div
          ref={contextMenuRef}
          className="tab-context-menu"
          role="menu"
          aria-label={contextMenu.kind === 'new' ? 'New tab options' : 'Tab options'}
          style={{
            top: `${contextMenu.y}px`,
            left: `${contextMenu.x}px`,
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          {([
            contextMenu.kind === 'new' && onCreateChat
              ? { icon: <Hash size={13} />, label: 'New channel', action: () => onCreateChat(pane.id) }
              : null,
            contextMenu.kind === 'new' && onCreateNote
              ? { icon: <FileText size={13} />, label: 'New note', action: () => onCreateNote(pane.id) }
              : null,
            contextMenu.kind === 'new' && onOpenSuperkanban
              ? { icon: <LayoutDashboard size={13} />, label: 'Superkanban', action: () => onOpenSuperkanban(pane.id) }
              : null,
            contextMenu.kind === 'tab' && onPopOut
              ? { icon: <ExternalLink size={13} />, label: 'Pop out', action: () => onPopOut(contextMenu.tabId) }
              : null,
            contextMenu.kind === 'tab'
              ? { icon: <X size={13} />, label: 'Close tab', action: () => onCloseTab(contextMenu.tabId) }
              : null,
            contextMenu.kind === 'tab'
              ? { icon: <X size={13} />, label: 'Close others', action: () => onCloseOtherTabs(pane.tabIds, contextMenu.tabId), disabled: pane.tabIds.length <= 1 }
              : null,
          ] as ({ icon: ReactNode; label: string; action: () => void; disabled?: boolean } | null)[])
            .filter((item): item is { icon: ReactNode; label: string; action: () => void; disabled?: boolean } => item !== null)
            .map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  closeMenu();
                  item.action();
                }}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
        </div>,
        document.body,
      )}
    </div>
  );
}

// ─── Single pane ────────────────────────────────────────────────
function Pane({
  pane,
  openTabs,
  focusedPaneId,
  onFocusPane,
  onSelectTab,
  onCloseTab,
  onCloseOtherTabs,
  onDropTab,
  onDropNote,
  onCreateTab,
  onCreateNote,
  onCreateChat,
  onOpenSuperkanban,
  onPopOut,
  onDetachTab,
  sidebarOpen,
  onToggleSidebar,
  showSidebarToggle,
  renderContent,
}: { pane: PaneNode } & Omit<PaneGridProps, 'node' | 'onResize'>) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [dropSide, setDropSide] = useState<DropSide | null>(null);
  // Keep visited tabs mounted (hidden) so switching doesn't remount ChatView /
  // NoteEditor and re-parse the whole transcript.
  const [mountedTabIds, setMountedTabIds] = useState<string[]>(() => (
    pane.activeTabId ? [pane.activeTabId] : []
  ));

  useEffect(() => {
    const active = pane.activeTabId;
    if (!active) return;
    setMountedTabIds((prev) => (prev.includes(active) ? prev : [...prev, active]));
  }, [pane.activeTabId]);

  useEffect(() => {
    // Drop keep-alives for tabs that left this pane.
    setMountedTabIds((prev) => {
      const next = prev.filter((id) => pane.tabIds.includes(id));
      return next.length === prev.length ? prev : next;
    });
  }, [pane.tabIds]);

  const handleDragOver = (event: DragEvent) => {
    if (!event.dataTransfer.types.includes(DRAG_MIME) && !event.dataTransfer.types.includes(NOTE_DND_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const el = contentRef.current;
    if (el) setDropSide(sideFromPosition(el.getBoundingClientRect(), event.clientX, event.clientY));
  };

  const handleDrop = (event: DragEvent) => {
    const payload = readPayload(event);
    const noteId = event.dataTransfer.getData(NOTE_DND_TYPE);
    setDropSide(null);
    if (!payload && !noteId) return;
    event.preventDefault();
    const el = contentRef.current;
    const side = el
      ? sideFromPosition(el.getBoundingClientRect(), event.clientX, event.clientY)
      : 'center';
    if (payload) onDropTab(payload, pane.id, side);
    else onDropNote(noteId, pane.id, side);
  };

  const mountedTabs = mountedTabIds
    .map((id) => openTabs.find((t) => t.id === id))
    .filter((t): t is Tab => Boolean(t));

  return (
    <div
      className={`editor-pane pane${pane.id === focusedPaneId ? ' is-focused' : ''}`}
      style={{ flex: 1, width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0, minHeight: 0 }}
      onMouseDownCapture={() => onFocusPane(pane.id)}
    >
      <PaneTabStrip
        pane={pane}
        openTabs={openTabs}
        isFocused={pane.id === focusedPaneId}
        onSelectTab={onSelectTab}
        onCloseTab={onCloseTab}
        onCloseOtherTabs={onCloseOtherTabs}
        onDropTab={onDropTab}
        onDropNote={onDropNote}
        onCreateTab={onCreateTab}
        onCreateNote={onCreateNote}
        onCreateChat={onCreateChat}
        onOpenSuperkanban={onOpenSuperkanban}
        onPopOut={onPopOut}
        onDetachTab={onDetachTab}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={onToggleSidebar}
        showSidebarToggle={showSidebarToggle}
      />
      <div
        ref={(el) => {
          contentRef.current = el;
        }}
        className="pane-content"
        style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
        onDragOver={handleDragOver}
        onDragLeave={() => setDropSide(null)}
        onDrop={handleDrop}
      >
        {mountedTabs.length === 0 ? (
          <div className="pane-empty">Empty pane</div>
        ) : (
          mountedTabs.map((tab) => {
            const active = tab.id === pane.activeTabId;
            return (
              <div
                key={tab.id}
                className="pane-tab-keepalive"
                aria-hidden={!active}
                style={{
                  display: 'flex',
                  position: active ? 'relative' : 'absolute',
                  inset: active ? undefined : 0,
                  visibility: active ? 'visible' : 'hidden',
                  pointerEvents: active ? 'auto' : 'none',
                  flex: 1,
                  minHeight: 0,
                  minWidth: 0,
                  flexDirection: 'column',
                  overflow: 'hidden',
                }}
              >
                {renderContent(tab, pane.id)}
              </div>
            );
          })
        )}
        {dropSide && <div className={`pane-dropzone pane-dropzone-${dropSide}`} />}
      </div>
    </div>
  );
}

// ─── Split (recursive) ──────────────────────────────────────────
function Split({ split, ...rest }: { split: SplitNode } & Omit<PaneGridProps, 'node'>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const isRow = split.direction === 'row';

  const startResize = (event: React.MouseEvent, dividerIndex: number) => {
    event.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const total = isRow ? rect.width : rect.height;
    const start = isRow ? event.clientX : event.clientY;
    const startSizes = [...split.sizes];

    acquireInteractionLock({ cursor: isRow ? 'col-resize' : 'row-resize' });

    bindDragGesture({
      onMove: (e) => {
        const current = isRow ? e.clientX : e.clientY;
        let deltaFraction = (current - start) / total;
        const a = startSizes[dividerIndex];
        const b = startSizes[dividerIndex + 1];
        // Clamp so neither adjacent child shrinks below the minimum.
        deltaFraction = Math.max(-(a - MIN_FRACTION), Math.min(b - MIN_FRACTION, deltaFraction));
        const next = [...startSizes];
        next[dividerIndex] = a + deltaFraction;
        next[dividerIndex + 1] = b - deltaFraction;
        rest.onResize(split.id, next);
      },
      onEnd: () => {
        releaseInteractionLock();
      },
    });
  };

  return (
    <div
      ref={containerRef}
      className="pane-split"
      style={{ display: 'flex', flexDirection: isRow ? 'row' : 'column', flex: 1, minWidth: 0, minHeight: 0, height: '100%', width: '100%' }}
    >
      {split.children.map((child, index) => (
        <Fragment key={child.id}>
          <div
            className="pane-split-child"
            style={{ display: 'flex', flexGrow: split.sizes[index] ?? 1, flexBasis: 0, minWidth: 0, minHeight: 0, overflow: 'hidden' }}
          >
            <PaneGrid node={child} {...rest} showSidebarToggle={Boolean(rest.showSidebarToggle && index === 0)} />
          </div>
          {index < split.children.length - 1 && (
            <div
              className={`pane-divider ${isRow ? 'pane-divider-vertical' : 'pane-divider-horizontal'}`}
              onMouseDown={(e) => startResize(e, index)}
              role="separator"
              aria-orientation={isRow ? 'vertical' : 'horizontal'}
              title="Drag to resize"
            />
          )}
        </Fragment>
      ))}
    </div>
  );
}

export function PaneGrid(props: PaneGridProps) {
  const { node, showSidebarToggle = true, ...rest } = props;
  if (isPane(node)) return <Pane pane={node} {...rest} showSidebarToggle={showSidebarToggle} />;
  return <Split split={node} {...rest} showSidebarToggle={showSidebarToggle} />;
}
