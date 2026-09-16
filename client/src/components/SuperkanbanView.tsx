import { LoadingIndicator } from './LoadingIndicator';
import { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AlertTriangle, LayoutDashboard, Loader2, Search } from 'lucide-react';
import { hasObsidianKanbanMarker, parseKanbanMarkdown, type KanbanCard } from './KanbanView';
import { ErrorBoundary } from './ErrorBoundary';
import { SafeMarkdownImage } from './ChatMarkdown';
import type { Note } from '../api';
import type { WorkItem, WorkItemStatus } from '../chat/workItems';

export interface SuperkanbanSource {
  id: string;
  title: string;
  content: string;
}

export interface SuperkanbanCard extends KanbanCard {
  sourceId: string;
  sourceTitle: string;
  /** Live work-item twin (mission-compiled or manual). */
  live?: boolean;
  workItemId?: string;
  branch?: string;
  workspaceMode?: string;
}

export interface SuperkanbanColumn {
  id: string;
  title: string;
  cards: SuperkanbanCard[];
}

function columnKey(title: string) {
  return title.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

const STANDARD_LANES = ['Backlog', 'Ready', 'In progress', 'Blocked', 'Review', 'Done'] as const;

function laneRank(title: string): number {
  const rank = STANDARD_LANES.indexOf(title as typeof STANDARD_LANES[number]);
  return rank < 0 ? STANDARD_LANES.length : rank;
}

function standardLane(title: string): string {
  const key = columnKey(title);
  if (/^(wishlist|ideas?|icebox|backlog)$/.test(key)) return 'Backlog';
  if (/^(ready|to do|todo|queued?|open)$/.test(key)) return 'Ready';
  if (/^(in progress|in-progress|doing|active|leased)$/.test(key)) return 'In progress';
  if (/^(blocked|waiting|stalled|on hold)$/.test(key)) return 'Blocked';
  if (/^(review|in review|reviewing|approval)$/.test(key)) return 'Review';
  if (/^(done|complete|completed|shipped|closed|archive)$/.test(key)) return 'Done';
  return title.trim();
}

export function isSuperkanbanSource(content: string): boolean {
  if (!hasObsidianKanbanMarker(content)) return false;
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || '';
  return /^superkanban\s*:\s*true\s*$/im.test(frontmatter)
    || /^cascade-channel\s*:/im.test(frontmatter);
}

/** Map durable work-item status onto familiar Kanban lanes. */
export function workItemStatusToKanbanColumn(status: WorkItemStatus | string): string {
  switch (status) {
    case 'in_progress':
    case 'leased':
      return 'In progress';
    case 'review':
      return 'Review';
    case 'blocked':
      return 'Blocked';
    case 'done':
      return 'Done';
    case 'canceled':
      return 'Done';
    case 'open':
    default:
      return 'Ready';
  }
}

/**
 * Project live work items (including mission-compiled twins) into Superkanban
 * columns so chat orchestration and the board share one surface.
 */
export function workItemsToLiveColumns(items: WorkItem[]): SuperkanbanColumn[] {
  const order = [...STANDARD_LANES];
  const byKey = new Map<string, SuperkanbanColumn>();
  for (const title of order) {
    const col: SuperkanbanColumn = { id: `live-${columnKey(title)}`, title, cards: [] };
    byKey.set(columnKey(title), col);
  }
  for (const item of items) {
    // Mission twins + accepted contracts always surface; other work needs a channel.
    if (item.sourceKind !== 'mission' && item.sourceKind !== 'contract' && !item.channelId) continue;
    const title = workItemStatusToKanbanColumn(item.status);
    const key = columnKey(title);
    let column = byKey.get(key);
    if (!column) {
      column = { id: `live-${key}`, title, cards: [] };
      byKey.set(key, column);
    }
    const budget = item.tokenBudget && item.tokenBudget > 0
      ? `${item.tokensUsed || 0}/${item.tokenBudget} tok`
      : '';
    const bits = [
      item.title,
      item.sourceKind === 'contract' ? '**contract**' : '',
      item.branch ? `\`${item.branch}\`` : '',
      item.workspaceMode === 'isolated' ? 'isolated' : '',
      budget,
      item.stopReason ? `stopped: ${item.stopReason}` : '',
      item.prUrl ? `[PR](${item.prUrl})` : '',
      item.contract ? `\n\n${item.contract.slice(0, 280)}${item.contract.length > 280 ? '…' : ''}` : '',
      item.summary ? `\n\n${item.summary}` : '',
    ].filter(Boolean);
    column.cards.push({
      id: `work:${item.id}`,
      lineIndex: -1,
      marker: '-',
      text: bits.join(' · ').replace(/ · \n\n/g, '\n\n'),
      checked: item.status === 'done',
      sourceId: item.id,
      sourceTitle: item.sourceKind === 'mission'
        ? 'Live mission work'
        : item.sourceKind === 'contract'
          ? 'Live contract'
          : 'Live work item',
      live: true,
      workItemId: item.id,
      branch: item.branch,
      workspaceMode: item.workspaceMode,
    });
  }
  return order
    .map((title) => byKey.get(columnKey(title))!)
    .filter((column) => column.cards.length > 0);
}

/**
 * Merge boards in sidebar order. Within each source board we retain its lane
 * order and card order; the first matching lane supplies the merged title.
 */
export function mergeKanbanSources(sources: SuperkanbanSource[]): SuperkanbanColumn[] {
  const columns: SuperkanbanColumn[] = [];
  const byKey = new Map<string, SuperkanbanColumn>();

  for (const source of sources) {
    if (!isSuperkanbanSource(source.content)) continue;
    for (const column of parseKanbanMarkdown(source.content).columns) {
      const title = standardLane(column.title);
      const key = columnKey(title);
      if (!key) continue;
      let merged = byKey.get(key);
      if (!merged) {
        merged = { id: `super-column-${columns.length}`, title, cards: [] };
        byKey.set(key, merged);
        columns.push(merged);
      }
      merged.cards.push(...column.cards.map((card) => ({
        ...card,
        id: `${source.id}:${card.id}`,
        sourceId: source.id,
        sourceTitle: source.title,
      })));
    }
  }
  return columns.sort((a, b) => {
    return laneRank(a.title) - laneRank(b.title);
  });
}

/** Fold live work-item columns into note-backed Superkanban columns. */
export function mergeLiveWorkIntoKanban(
  boardColumns: SuperkanbanColumn[],
  liveColumns: SuperkanbanColumn[],
): SuperkanbanColumn[] {
  if (liveColumns.length === 0) return boardColumns;
  const columns = boardColumns.map((column) => ({ ...column, cards: [...column.cards] }));
  const byKey = new Map(columns.map((column) => [columnKey(column.title), column]));
  for (const live of liveColumns) {
    const key = columnKey(live.title);
    let target = byKey.get(key);
    if (!target) {
      target = { id: live.id, title: live.title, cards: [] };
      byKey.set(key, target);
      columns.push(target);
    }
    // Live cards lead the lane so mission work is visible first.
    target.cards = [...live.cards, ...target.cards];
  }
  return columns;
}

interface SuperkanbanViewProps {
  notes: Note[];
  loading: boolean;
  error: string | null;
  onOpenNote: (id: string) => void;
  /** Durable work items for this vault (mission twins + channel work). */
  liveWorkItems?: WorkItem[];
}

export function SuperkanbanView({ notes, loading, error, onOpenNote, liveWorkItems }: SuperkanbanViewProps) {
  return (
    <ErrorBoundary label="Superkanban">
      <SuperkanbanViewInner
        notes={notes}
        loading={loading}
        error={error}
        onOpenNote={onOpenNote}
        liveWorkItems={liveWorkItems}
      />
    </ErrorBoundary>
  );
}

function SuperkanbanViewInner({
  notes,
  loading,
  error,
  onOpenNote,
  liveWorkItems = [],
}: SuperkanbanViewProps) {
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('all');
  const [showBacklog, setShowBacklog] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const allColumns = useMemo(() => {
    const boards = mergeKanbanSources((notes || []).map((note) => ({
      id: note.id,
      title: note.title,
      content: typeof note.content === 'string' ? note.content : '',
    })));
    return mergeLiveWorkIntoKanban(boards, workItemsToLiveColumns(liveWorkItems || []));
  }, [notes, liveWorkItems]);
  const sources = useMemo(() => Array.from(new Set(allColumns.flatMap((column) => (
    column.cards.map((card) => card.sourceTitle)
  )))).sort((a, b) => a.localeCompare(b)), [allColumns]);
  const columns = useMemo(() => {
    const visible = allColumns
      .map((column) => ({
        ...column,
        cards: source === 'all' ? column.cards : column.cards.filter((card) => card.sourceTitle === source),
      }))
      .filter((column) => showBacklog || columnKey(column.title) !== 'backlog')
      .filter((column) => showDone || columnKey(column.title) !== 'done');
    for (const title of STANDARD_LANES.slice(1, 5)) {
      if (!visible.some((column) => columnKey(column.title) === columnKey(title))) {
        visible.push({ id: `command-${columnKey(title)}`, title, cards: [] });
      }
    }
    return visible.sort((a, b) => laneRank(a.title) - laneRank(b.title));
  }, [allColumns, source, showBacklog, showDone]);
  const liveCount = (liveWorkItems || []).filter((item) => (
    item.sourceKind === 'mission' || item.sourceKind === 'contract'
  )).length;
  const hasSources = allColumns.length > 0;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const activeCount = allColumns.filter((column) => ['ready', 'in progress'].includes(columnKey(column.title))).reduce((sum, column) => sum + column.cards.length, 0);
  const blockedCount = allColumns.find((column) => columnKey(column.title) === 'blocked')?.cards.length || 0;
  const reviewCount = allColumns.find((column) => columnKey(column.title) === 'review')?.cards.length || 0;

  if (loading && !hasSources) {
    return (
      <div className="superkanban-empty is-loading" role="status">
        <LoadingIndicator label="Loading boards" />
      </div>
    );
  }
  if (error && !hasSources) {
    return (
      <div className="superkanban-empty is-error" role="alert">
        <AlertTriangle size={28} aria-hidden="true" />
        <strong>Boards unavailable</strong>
        <p>{error}</p>
      </div>
    );
  }
  if (!hasSources) {
    return (
      <div className="superkanban-empty">
        <LayoutDashboard size={32} aria-hidden="true" />
        <strong>No Kanban boards yet</strong>
        <p>
          Superkanban collates every board in the vault. Give a channel an orchestrator
          (it gets a local board automatically), or create any note with the Kanban format.
        </p>
      </div>
    );
  }

  return (
    <div className="kanban-view superkanban-view" aria-label="Superkanban" aria-busy={loading}>
      <div className="kanban-toolbar">
        <div className="superkanban-heading">
          <strong>Command center</strong>
          <span>{error ? 'Refresh failed' : loading ? 'Refreshing…' : 'Active work across the vault'}</span>
        </div>
        {(loading || error) && (
          <span
            className={`superkanban-sync-status${error ? ' is-error' : ''}`}
            role="status"
            title={error || 'Refreshing boards'}
          >
            {error
              ? <AlertTriangle size={12} aria-hidden="true" />
              : <Loader2 className="is-spinning" size={12} aria-hidden="true" />}
            {error ? 'Refresh failed' : 'Refreshing'}
          </span>
        )}
        <div className="kanban-search">
          <Search size={14} aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter all boards" aria-label="Filter Superkanban cards" />
        </div>
        <select className="superkanban-board-filter" value={source} onChange={(event) => setSource(event.target.value)} aria-label="Filter by board">
          <option value="all">All boards</option>
          {sources.map((title) => <option key={title} value={title}>{title}</option>)}
        </select>
      </div>
      <div className="superkanban-pulse" aria-label="Work summary">
        <span className="superkanban-stat"><strong>{activeCount}</strong><span>Active</span></span>
        <span className={`superkanban-stat${blockedCount ? ' is-alert' : ''}`}><strong>{blockedCount}</strong><span>Blocked</span></span>
        <span className="superkanban-stat"><strong>{reviewCount}</strong><span>In review</span></span>
        <span className="superkanban-stat"><strong>{sources.length}</strong><span>Boards{liveCount > 0 ? ` · ${liveCount} live` : ''}</span></span>
        <div className="superkanban-visibility">
          <button type="button" className={showBacklog ? 'is-active' : ''} aria-pressed={showBacklog} onClick={() => setShowBacklog((value) => !value)}>Backlog</button>
          <button type="button" className={showDone ? 'is-active' : ''} aria-pressed={showDone} onClick={() => setShowDone((value) => !value)}>Done</button>
        </div>
      </div>
      <div className="kanban-board">
        {columns.map((column) => {
          const cards = normalizedQuery
            ? column.cards.filter((card) => `${card.text} ${card.sourceTitle}`.toLocaleLowerCase().includes(normalizedQuery))
            : column.cards;
          return (
            <section className="kanban-column superkanban-column" key={column.id}>
              <header><strong>{column.title}</strong><span>{cards.length}</span></header>
              <div className="kanban-cards">
                {cards.map((card) => (
                  <article
                    className={`kanban-card${card.checked ? ' is-complete' : ''}${card.live ? ' is-live-work' : ''}`}
                    key={card.id}
                  >
                    <div className="kanban-card-title"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: SafeMarkdownImage }}>{card.text || ''}</ReactMarkdown></div>
                    {card.live ? (
                      <span className="superkanban-source is-live" title={card.branch || card.workItemId || 'Live work'}>
                        {card.sourceTitle}
                        {card.workspaceMode === 'isolated' ? ' · isolated' : ''}
                      </span>
                    ) : (
                      <button type="button" className="superkanban-source" onClick={() => onOpenNote(card.sourceId)} title={`Open ${card.sourceTitle}`}>
                        {card.sourceTitle}
                      </button>
                    )}
                  </article>
                ))}
                {cards.length === 0 && <div className="kanban-no-matches">{normalizedQuery ? 'No matches' : 'No cards'}</div>}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
