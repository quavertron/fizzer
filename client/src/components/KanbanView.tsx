import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { SafeMarkdownImage } from './ChatMarkdown';
import {
  Archive,
  Check,
  ChevronDown,
  GripVertical,
  LayoutDashboard,
  MoreVertical,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { ErrorBoundary } from './ErrorBoundary';
import { KanbanInlineEditInput } from './KanbanInlineEditInput';

export interface KanbanCard {
  id: string;
  lineIndex: number;
  text: string;
  checked: boolean;
  marker: '-' | '*' | '+';
}

export interface KanbanColumn {
  id: string;
  title: string;
  rawTitle: string;
  maxItems: number;
  completeOnEntry: boolean;
  headingLineIndex: number;
  endLineIndex: number;
  cards: KanbanCard[];
}

export interface KanbanBoard {
  columns: KanbanColumn[];
  archive: KanbanCard[];
  archiveHeadingLineIndex: number | null;
  archiveMarkerLineIndex: number | null;
  hasObsidianMarker: boolean;
}

const HEADING = /^##\s+(.+?)\s*$/;
const CARD = /^\s*([-*+])\s+(?:\[([^\]])\]\s+)?(.+?)\s*$/;
const FRONTMATTER_KEY = /^kanban-plugin\s*:/m;
const SETTINGS_START = '%% kanban:settings';
const COMPLETE_ON_ENTRY = '<!-- fizzer:complete-on-entry -->';

function cleanSingleLine(value: string) {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function parseColumnTitle(rawTitle: string) {
  const match = rawTitle.match(/^(.*?)\s*\((\d+)\)$/);
  if (!match) return { title: rawTitle.trim(), maxItems: 0 };
  return { title: match[1].trim(), maxItems: Number(match[2]) };
}

function parseCard(line: string, lineIndex: number): KanbanCard | null {
  const match = line.match(CARD);
  if (!match) return null;
  return {
    id: `card-${lineIndex}`,
    lineIndex,
    text: match[3].trim(),
    checked: match[2]?.toLowerCase() === 'x',
    marker: match[1] as '-' | '*' | '+',
  };
}

export function hasObsidianKanbanMarker(content: string) {
  if (typeof content !== 'string' || !content) return false;
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return Boolean(frontmatter && FRONTMATTER_KEY.test(frontmatter[1]));
}

export function hasSuperkanbanMarker(content: string) {
  const frontmatter = typeof content === 'string'
    ? content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || ''
    : '';
  return /^superkanban\s*:\s*true\s*$/im.test(frontmatter);
}

export function setSuperkanbanMarker(content: string, enabled: boolean): string {
  const lines = content.split('\n');
  const frontmatterEnd = findFrontmatterEnd(lines);
  if (frontmatterEnd < 0) return content;
  const markerIndex = lines.slice(1, frontmatterEnd)
    .findIndex((line) => /^superkanban\s*:/.test(line));
  if (markerIndex >= 0) {
    const absoluteIndex = markerIndex + 1;
    if (enabled) lines[absoluteIndex] = 'superkanban: true';
    else lines.splice(absoluteIndex, 1);
  } else if (enabled) {
    lines.splice(frontmatterEnd, 0, 'superkanban: true');
  }
  return lines.join('\n');
}

export function parseKanbanMarkdown(content: string): KanbanBoard {
  // Never throw on open — bad/partial note bodies used to white-screen the pane.
  const safe = typeof content === 'string' ? content : '';
  const lines = safe.split('\n');
  const columns: KanbanColumn[] = [];
  const archive: KanbanCard[] = [];
  let activeColumn: KanbanColumn | null = null;
  let inArchive = false;
  let archiveHeadingLineIndex: number | null = null;
  let archiveMarkerLineIndex: number | null = null;

  lines.forEach((line, lineIndex) => {
    const heading = line.match(HEADING);
    if (heading) {
      let previousNonBlank = lineIndex - 1;
      while (previousNonBlank >= 0 && lines[previousNonBlank].trim() === '') previousNonBlank -= 1;
      const isArchive = heading[1].trim().toLowerCase() === 'archive'
        && previousNonBlank >= 0
        && lines[previousNonBlank].trim() === '***';

      if (activeColumn) {
        activeColumn.endLineIndex = isArchive ? previousNonBlank : lineIndex;
      }

      if (isArchive) {
        activeColumn = null;
        inArchive = true;
        archiveHeadingLineIndex = lineIndex;
        archiveMarkerLineIndex = previousNonBlank;
        return;
      }

      inArchive = false;
      const rawTitle = heading[1].trim();
      const parsedTitle = parseColumnTitle(rawTitle);
      activeColumn = {
        id: `column-${lineIndex}`,
        rawTitle,
        ...parsedTitle,
        completeOnEntry: lines[lineIndex + 1]?.trim() === COMPLETE_ON_ENTRY,
        headingLineIndex: lineIndex,
        endLineIndex: lines.length,
        cards: [],
      };
      columns.push(activeColumn);
      return;
    }

    const card = parseCard(line, lineIndex);
    if (!card) return;
    if (inArchive) archive.push(card);
    else activeColumn?.cards.push(card);
  });

  const settingsStart = lines.findIndex((line) => line.trim() === SETTINGS_START);
  const lastColumn = columns[columns.length - 1];
  if (settingsStart >= 0 && lastColumn && lastColumn.endLineIndex === lines.length) {
    lastColumn.endLineIndex = settingsStart;
  }

  return {
    columns,
    archive,
    archiveHeadingLineIndex,
    archiveMarkerLineIndex,
    hasObsidianMarker: hasObsidianKanbanMarker(safe),
  };
}

function cardLine(text: string, checked = false, marker: '-' | '*' | '+' = '-') {
  return `${marker} [${checked ? 'x' : ' '}] ${cleanSingleLine(text)}`;
}

function findFrontmatterEnd(lines: string[]) {
  if (lines[0]?.trim() !== '---') return -1;
  return lines.findIndex((line, index) => index > 0 && line.trim() === '---');
}

export function ensureKanbanFrontmatter(content: string): string {
  const lines = content.split('\n');
  const frontmatterEnd = findFrontmatterEnd(lines);
  if (frontmatterEnd >= 0) {
    const existingIndex = lines
      .slice(1, frontmatterEnd)
      .findIndex((line) => /^kanban-plugin\s*:/.test(line));
    if (existingIndex >= 0) return content;
    lines.splice(frontmatterEnd, 0, 'kanban-plugin: board', 'superkanban: true');
    return lines.join('\n');
  }

  const body = content.trimStart();
  return `---\nkanban-plugin: board\nsuperkanban: true\n---\n\n${body}`;
}

function settingsFooter() {
  return [
    '%% kanban:settings',
    '```',
    '{"kanban-plugin":"board"}',
    '```',
    '%%',
  ].join('\n');
}

export function initializeKanbanMarkdown(content: string): string {
  const withFrontmatter = ensureKanbanFrontmatter(content).trimEnd();
  const board = [
    '## Backlog',
    '',
    '## In progress',
    '',
    '## Blocked',
    '',
    '## Done',
    '',
    settingsFooter(),
    '',
  ].join('\n');
  return `${withFrontmatter}\n\n${board}`;
}

function firstFooterLine(content: string) {
  const board = parseKanbanMarkdown(content);
  if (board.archiveMarkerLineIndex != null) return board.archiveMarkerLineIndex;
  const settingsIndex = content.split('\n').findIndex((line) => line.trim() === SETTINGS_START);
  return settingsIndex >= 0 ? settingsIndex : content.split('\n').length;
}

export function addKanbanCard(content: string, columnId: string, text: string): string {
  const board = parseKanbanMarkdown(content);
  const column = board.columns.find((item) => item.id === columnId);
  if (!column || !cleanSingleLine(text)) return content;
  const lines = content.split('\n');
  let insertAt = (column.cards.at(-1)?.lineIndex ?? (column.headingLineIndex + Number(column.completeOnEntry))) + 1;
  // Empty Obsidian lanes conventionally keep one blank line below the heading.
  // For populated lanes, insert directly after the final card so the existing
  // blank line remains the separator before the next lane.
  if (!column.cards.length && lines[insertAt]?.trim() === '') insertAt += 1;
  lines.splice(insertAt, 0, cardLine(text));
  return lines.join('\n');
}

export function addKanbanColumn(content: string, title: string): string {
  const clean = cleanSingleLine(title);
  if (!clean) return content;
  const lines = content.split('\n');
  const insertAt = firstFooterLine(content);
  const section = [`## ${clean}`, '', ''];
  if (insertAt > 0 && lines[insertAt - 1]?.trim() !== '') section.unshift('');
  lines.splice(insertAt, 0, ...section);
  return lines.join('\n');
}

export function renameKanbanCard(content: string, cardId: string, text: string): string {
  const board = parseKanbanMarkdown(content);
  const card = [...board.columns.flatMap((column) => column.cards), ...board.archive]
    .find((item) => item.id === cardId);
  if (!card || !cleanSingleLine(text)) return content;
  const lines = content.split('\n');
  lines[card.lineIndex] = cardLine(text, card.checked, card.marker);
  return lines.join('\n');
}

export function renameKanbanColumn(content: string, columnId: string, title: string): string {
  const column = parseKanbanMarkdown(content).columns.find((item) => item.id === columnId);
  const clean = cleanSingleLine(title);
  if (!column || !clean) return content;
  const lines = content.split('\n');
  lines[column.headingLineIndex] = `## ${clean}`;
  return lines.join('\n');
}

export function setKanbanColumnCompleteOnEntry(content: string, columnId: string, enabled: boolean): string {
  const column = parseKanbanMarkdown(content).columns.find((item) => item.id === columnId);
  if (!column || column.completeOnEntry === enabled) return content;
  const lines = content.split('\n');
  lines.splice(column.headingLineIndex + 1, enabled ? 0 : 1, ...(enabled ? [COMPLETE_ON_ENTRY] : []));
  return lines.join('\n');
}

export function toggleKanbanCard(content: string, cardId: string): string {
  const board = parseKanbanMarkdown(content);
  const card = board.columns.flatMap((column) => column.cards).find((item) => item.id === cardId);
  if (!card) return content;
  const lines = content.split('\n');
  lines[card.lineIndex] = cardLine(card.text, !card.checked, card.marker);
  return lines.join('\n');
}

export function deleteKanbanCard(content: string, cardId: string): string {
  const board = parseKanbanMarkdown(content);
  const card = [...board.columns.flatMap((column) => column.cards), ...board.archive]
    .find((item) => item.id === cardId);
  if (!card) return content;
  const lines = content.split('\n');
  lines.splice(card.lineIndex, 1);
  return lines.join('\n');
}

export function deleteKanbanColumn(content: string, columnId: string): string {
  const column = parseKanbanMarkdown(content).columns.find((item) => item.id === columnId);
  if (!column) return content;
  const lines = content.split('\n');
  lines.splice(column.headingLineIndex, column.endLineIndex - column.headingLineIndex);
  return lines.join('\n');
}

export function moveKanbanCard(
  content: string,
  cardId: string,
  targetColumnId: string,
  targetCardId?: string,
  placement: 'before' | 'after' = 'before',
): string {
  const board = parseKanbanMarkdown(content);
  const source = board.columns.flatMap((column) => column.cards).find((item) => item.id === cardId);
  const target = board.columns.find((column) => column.id === targetColumnId);
  const targetCard = targetCardId
    ? target?.cards.find((item) => item.id === targetCardId)
    : undefined;
  if (!source || !target || targetCard?.id === source.id) return content;

  const lines = content.split('\n');
  // Use the same checkbox mutation as manual completion, in the same note edit
  // as the move. Persistence, permissions and conflicts remain note-save concerns.
  const entering = !target.cards.some((card) => card.id === source.id);
  const movedLine = entering && target.completeOnEntry && !source.checked
    ? toggleKanbanCard(content, source.id).split('\n')[source.lineIndex]
    : lines[source.lineIndex];
  let insertAt: number;
  if (targetCard) {
    insertAt = targetCard.lineIndex + (placement === 'after' ? 1 : 0);
  } else {
    insertAt = (target.cards.at(-1)?.lineIndex ?? (target.headingLineIndex + Number(target.completeOnEntry))) + 1;
  }

  lines.splice(source.lineIndex, 1);
  if (source.lineIndex < insertAt) insertAt -= 1;
  lines.splice(insertAt, 0, movedLine);
  return lines.join('\n');
}

function archiveCardIds(content: string, cardIds: string[]): string {
  const board = parseKanbanMarkdown(content);
  const wanted = new Set(cardIds);
  const cards = board.columns
    .flatMap((column) => column.cards)
    .filter((card) => wanted.has(card.id));
  if (!cards.length) return content;

  const lines = content.split('\n');
  const archivedLines = cards.map((card) => lines[card.lineIndex]);
  cards
    .map((card) => card.lineIndex)
    .sort((a, b) => b - a)
    .forEach((lineIndex) => lines.splice(lineIndex, 1));

  let next = lines.join('\n');
  const nextBoard = parseKanbanMarkdown(next);
  const nextLines = next.split('\n');
  if (nextBoard.archiveHeadingLineIndex != null) {
    let insertAt = nextBoard.archive.at(-1)?.lineIndex ?? nextBoard.archiveHeadingLineIndex;
    insertAt += 1;
    while (insertAt < nextLines.length && nextLines[insertAt]?.trim() === '') insertAt += 1;
    nextLines.splice(insertAt, 0, ...archivedLines);
    return nextLines.join('\n');
  }

  const settingsIndex = nextLines.findIndex((line) => line.trim() === SETTINGS_START);
  const insertAt = settingsIndex >= 0 ? settingsIndex : nextLines.length;
  const archiveSection = ['***', '', '## Archive', '', ...archivedLines, '', ''];
  if (insertAt > 0 && nextLines[insertAt - 1]?.trim() !== '') archiveSection.unshift('');
  nextLines.splice(insertAt, 0, ...archiveSection);
  next = nextLines.join('\n');
  return next;
}

export function archiveKanbanCard(content: string, cardId: string) {
  return archiveCardIds(content, [cardId]);
}

export function archiveCompletedKanbanCards(content: string) {
  const completeIds = parseKanbanMarkdown(content).columns
    .flatMap((column) => column.cards)
    .filter((card) => card.checked)
    .map((card) => card.id);
  return archiveCardIds(content, completeIds);
}

export function archiveKanbanColumnCards(content: string, columnId: string) {
  const column = parseKanbanMarkdown(content).columns.find((item) => item.id === columnId);
  return column ? archiveCardIds(content, column.cards.map((card) => card.id)) : content;
}

interface KanbanViewProps {
  content: string;
  onContentChange: (content: string) => void;
  showSuperkanbanToggle?: boolean;
}

type EditingValue = { id: string; value: string } | null;
type DropTarget = { cardId: string; placement: 'before' | 'after' } | null;

function CardMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>,
        img: SafeMarkdownImage,
        p: ({ children }) => <>{children}</>,
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

export function KanbanView({ content, onContentChange, showSuperkanbanToggle = false }: KanbanViewProps) {
  return (
    <ErrorBoundary label="Kanban">
      <KanbanViewInner content={content} onContentChange={onContentChange} showSuperkanbanToggle={showSuperkanbanToggle} />
    </ErrorBoundary>
  );
}

function KanbanViewInner({ content, onContentChange, showSuperkanbanToggle = false }: KanbanViewProps) {
  const board = useMemo(() => parseKanbanMarkdown(content), [content]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const drag = useRef<{ cardId: string; content: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget>(null);
  const [editingCard, setEditingCard] = useState<EditingValue>(null);
  const [editingColumn, setEditingColumn] = useState<EditingValue>(null);
  const [collapsedColumns, setCollapsedColumns] = useState<Set<string>>(new Set());
  const [columnMenu, setColumnMenu] = useState<string | null>(null);
  const [columnDraft, setColumnDraft] = useState('');
  const [search, setSearch] = useState('');

  // The column menu is a popup like the context menus: Escape and an outside
  // click must close it, not just a second press on its own trigger.
  useEffect(() => {
    if (!columnMenu) return;
    const close = () => setColumnMenu(null);
    // `KeyboardEvent` is React's synthetic type in this file; take the DOM one.
    const onKeyDown = (event: WindowEventMap['keydown']) => {
      if (event.key === 'Escape') close();
    };
    const timer = window.setTimeout(() => window.addEventListener('click', close), 0);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [columnMenu]);

  if (!board.columns.length) {
    return (
      <div className="kanban-empty">
        <div className="kanban-empty-icon">▦</div>
        <strong>Turn this note into an Obsidian-compatible board</strong>
        <p>Lists, cards, archive, and settings remain ordinary portable Markdown.</p>
        <button type="button" onClick={() => onContentChange(initializeKanbanMarkdown(content))}>
          <Plus size={14} /> Create board
        </button>
      </div>
    );
  }

  const commitCardEdit = () => {
    if (!editingCard) return;
    onContentChange(renameKanbanCard(content, editingCard.id, editingCard.value));
    setEditingCard(null);
  };

  const commitColumnEdit = () => {
    if (!editingColumn) return;
    onContentChange(renameKanbanColumn(content, editingColumn.id, editingColumn.value));
    setEditingColumn(null);
  };

  const submitCard = (event: FormEvent, column: KanbanColumn) => {
    event.preventDefault();
    const text = drafts[column.id]?.trim();
    if (!text) return;
    onContentChange(addKanbanCard(content, column.id, text));
    setDrafts((current) => ({ ...current, [column.id]: '' }));
  };

  const submitColumn = (event: FormEvent) => {
    event.preventDefault();
    if (!columnDraft.trim()) return;
    onContentChange(addKanbanColumn(content, columnDraft));
    setColumnDraft('');
  };

  const dropCardInColumn = (event: DragEvent, column: KanbanColumn) => {
    event.preventDefault();
    const cardId = drag.current?.content === content ? drag.current.cardId : null;
    if (cardId) onContentChange(moveKanbanCard(content, cardId, column.id));
    drag.current = null;
    setDropTarget(null);
  };

  const dropCardOnCard = (event: DragEvent, column: KanbanColumn, card: KanbanCard) => {
    event.preventDefault();
    event.stopPropagation();
    const cardId = drag.current?.content === content ? drag.current.cardId : null;
    if (cardId) {
      onContentChange(moveKanbanCard(
        content,
        cardId,
        column.id,
        card.id,
        dropTarget?.cardId === card.id ? dropTarget.placement : 'before',
      ));
    }
    drag.current = null;
    setDropTarget(null);
  };

  const completedCount = board.columns
    .flatMap((column) => column.cards)
    .filter((card) => card.checked).length;
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const inSuperkanban = hasSuperkanbanMarker(content);

  return (
    <div className="kanban-view" aria-label="Kanban board">
      <div className="kanban-toolbar">
        <div className="kanban-search">
          <Search size={14} aria-hidden="true" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search cards"
            aria-label="Search Kanban cards"
          />
          {search && (
            <button type="button" onClick={() => setSearch('')} aria-label="Clear search">
              <X size={12} />
            </button>
          )}
        </div>
        {showSuperkanbanToggle && (
          <button
            type="button"
            className={`kanban-command-toggle${inSuperkanban ? ' is-active' : ''}`}
            aria-pressed={inSuperkanban}
            onClick={() => onContentChange(setSuperkanbanMarker(content, !inSuperkanban))}
            title="Choose whether this board appears in Superkanban"
          >
            <LayoutDashboard size={14} />
            {inSuperkanban ? 'In Superkanban' : 'Add to Superkanban'}
          </button>
        )}
        <form className="kanban-add-column" onSubmit={submitColumn}>
          <input
            value={columnDraft}
            onChange={(event) => setColumnDraft(event.target.value)}
            placeholder="Add list…"
            aria-label="New Kanban list name"
          />
          <button type="submit" aria-label="Add Kanban list"><Plus size={14} /></button>
        </form>
        <button
          type="button"
          className="kanban-archive-complete"
          disabled={!completedCount}
          onClick={() => onContentChange(archiveCompletedKanbanCards(content))}
          title="Move checked cards to the Markdown archive"
        >
          <Archive size={14} />
          Archive completed
          {completedCount > 0 && <span>{completedCount}</span>}
        </button>
        {board.archive.length > 0 && (
          <span className="kanban-archive-count">{board.archive.length} archived</span>
        )}
      </div>

      <div className="kanban-board">
        {board.columns.map((column) => {
          const collapsed = collapsedColumns.has(column.id);
          const visibleCards = normalizedSearch
            ? column.cards.filter((card) => card.text.toLocaleLowerCase().includes(normalizedSearch))
            : column.cards;
          const exceeded = column.maxItems > 0 && column.cards.length > column.maxItems;
          return (
            <section
              className={`kanban-column${collapsed ? ' is-collapsed' : ''}`}
              key={column.id}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => dropCardInColumn(event, column)}
            >
              <header onDoubleClick={() => setEditingColumn({ id: column.id, value: column.rawTitle })}>
                <button
                  type="button"
                  className="kanban-column-collapse"
                  onClick={() => setCollapsedColumns((current) => {
                    const next = new Set(current);
                    if (next.has(column.id)) next.delete(column.id);
                    else next.add(column.id);
                    return next;
                  })}
                  aria-label={collapsed ? `Expand ${column.title}` : `Collapse ${column.title}`}
                >
                  <ChevronDown size={14} />
                </button>
                {editingColumn?.id === column.id ? (
                  <KanbanInlineEditInput
                    className="kanban-column-title-input"
                    value={editingColumn.value}
                    onChange={(value) => setEditingColumn({ id: column.id, value })}
                    onCommit={commitColumnEdit}
                    onCancel={() => setEditingColumn(null)}
                  />
                ) : (
                  <strong>{column.title}</strong>
                )}
                {column.completeOnEntry && <Check size={13} aria-label="Completes cards on entry" />}
                <span className={exceeded ? 'is-exceeded' : ''}>
                  {column.cards.length}{column.maxItems > 0 ? ` / ${column.maxItems}` : ''}
                </span>
                <button
                  type="button"
                  className="kanban-column-menu-button"
                  onClick={() => setColumnMenu((current) => current === column.id ? null : column.id)}
                  aria-label={`More options for ${column.title}`}
                  aria-haspopup="menu"
                  aria-expanded={columnMenu === column.id}
                >
                  <MoreVertical size={14} />
                </button>
                {columnMenu === column.id && (
                  <div className="kanban-column-menu" role="menu" aria-label={`${column.title} list options`}>
                    <button
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={column.completeOnEntry}
                      title="Check cards moved into this list. Existing cards stay unchanged."
                      onClick={() => {
                        onContentChange(setKanbanColumnCompleteOnEntry(content, column.id, !column.completeOnEntry));
                        setColumnMenu(null);
                      }}
                    >
                      <Check size={13} /> Complete cards on entry
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setEditingColumn({ id: column.id, value: column.rawTitle });
                        setColumnMenu(null);
                      }}
                    >
                      <Pencil size={13} /> Rename list
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={!column.cards.length}
                      onClick={() => {
                        onContentChange(archiveKanbanColumnCards(content, column.id));
                        setColumnMenu(null);
                      }}
                    >
                      <Archive size={13} /> Archive cards
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="is-danger"
                      onClick={() => {
                        if (window.confirm(`Delete “${column.title}” and its ${column.cards.length} card(s)?`)) {
                          onContentChange(deleteKanbanColumn(content, column.id));
                        }
                        setColumnMenu(null);
                      }}
                    >
                      <Trash2 size={13} /> Delete list
                    </button>
                  </div>
                )}
              </header>

              {!collapsed && (
                <>
                  <div className="kanban-cards">
                    {visibleCards.map((card) => (
                      <article
                        className={[
                          'kanban-card',
                          card.checked ? 'is-complete' : '',
                          dropTarget?.cardId === card.id ? `is-drop-${dropTarget.placement}` : '',
                        ].filter(Boolean).join(' ')}
                        key={card.id}
                        draggable={editingCard?.id !== card.id}
                        onDragStart={(event) => {
                          drag.current = { cardId: card.id, content };
                          event.dataTransfer.setData('text/cascade-kanban-card', card.id);
                          event.dataTransfer.effectAllowed = 'move';
                        }}
                        onDragOver={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          const rect = event.currentTarget.getBoundingClientRect();
                          setDropTarget({
                            cardId: card.id,
                            placement: event.clientY < rect.top + rect.height / 2 ? 'before' : 'after',
                          });
                        }}
                        onDrop={(event) => dropCardOnCard(event, column, card)}
                        onDragEnd={() => {
                          drag.current = null;
                          setDropTarget(null);
                        }}
                        onDoubleClick={() => setEditingCard({ id: card.id, value: card.text })}
                      >
                        <GripVertical size={14} className="kanban-card-grip" aria-hidden="true" />
                        <button
                          type="button"
                          className="kanban-card-check"
                          onClick={(event) => onContentChange(
                            event.metaKey || event.ctrlKey
                              ? archiveKanbanCard(content, card.id)
                              : toggleKanbanCard(content, card.id),
                          )}
                          title="Click to complete · Ctrl/Cmd-click to archive"
                          aria-label={card.checked ? 'Mark incomplete' : 'Mark complete'}
                        >
                          {card.checked && <Check size={12} />}
                        </button>
                        {editingCard?.id === card.id ? (
                          <KanbanInlineEditInput
                            className="kanban-card-title-input"
                            value={editingCard.value}
                            onChange={(value) => setEditingCard({ id: card.id, value })}
                            onCommit={commitCardEdit}
                            onCancel={() => setEditingCard(null)}
                          />
                        ) : (
                          <div className="kanban-card-title"><CardMarkdown text={card.text} /></div>
                        )}
                        <button
                          type="button"
                          className="kanban-card-delete"
                          onClick={() => onContentChange(archiveKanbanCard(content, card.id))}
                          aria-label={`Archive ${card.text}`}
                          title="Archive card"
                        >
                          <Archive size={12} />
                        </button>
                      </article>
                    ))}
                    {normalizedSearch && visibleCards.length === 0 && (
                      <div className="kanban-no-matches">No matching cards</div>
                    )}
                  </div>
                  <form className="kanban-add-card" onSubmit={(event) => submitCard(event, column)}>
                    <input
                      value={drafts[column.id] || ''}
                      onChange={(event) => setDrafts((current) => ({ ...current, [column.id]: event.target.value }))}
                      placeholder="Add a card…"
                      aria-label={`Add card to ${column.title}`}
                    />
                    <button type="submit" aria-label={`Add card to ${column.title}`}><Plus size={14} /></button>
                  </form>
                </>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
