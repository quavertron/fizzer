import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  addKanbanCard,
  addKanbanColumn,
  archiveCompletedKanbanCards,
  archiveKanbanCard,
  deleteKanbanCard,
  ensureKanbanFrontmatter,
  hasObsidianKanbanMarker,
  hasSuperkanbanMarker,
  initializeKanbanMarkdown,
  moveKanbanCard,
  parseKanbanMarkdown,
  renameKanbanCard,
  renameKanbanColumn,
  setSuperkanbanMarker,
  setKanbanColumnCompleteOnEntry,
  toggleKanbanCard,
  KanbanView,
} from '../components/KanbanView';
import {
  mergeKanbanSources,
  mergeLiveWorkIntoKanban,
  SuperkanbanView,
  workItemStatusToKanbanColumn,
  workItemsToLiveColumns,
} from '../components/SuperkanbanView';
import type { Note } from '../api';
import type { WorkItem } from '../chat/workItems';

const SAMPLE = [
  '---',
  'kanban-plugin: board',
  'superkanban: true',
  '---',
  '',
  '# Project',
  '',
  'Intro text stays untouched.',
  '',
  '## Backlog',
  '',
  '- [ ] Draft brief',
  '- Plain bullet',
  '',
  '## Done',
  '',
  '- [x] Ship prototype',
  '',
  '%% kanban:settings',
  '```',
  '{"kanban-plugin":"board"}',
  '```',
  '%%',
  '',
].join('\n');

const BOARD_NOTE: Note = {
  id: 'board-1',
  vault_id: 'vault-1',
  folder_id: null,
  title: 'Product board',
  content_preview: 'kanban-plugin: board superkanban: true',
  content: SAMPLE,
  file_path: 'Product board.md',
  is_pinned: 0,
  is_archived: 0,
  is_listed: 1,
  position: 0,
  word_count: 1,
  created_at: '',
  updated_at: '',
  tags: [],
};

describe('Markdown-backed Kanban helpers', () => {
  it('uses an honest empty state before synthesizing standard Superkanban lanes', () => {
    const markup = renderToStaticMarkup(createElement(SuperkanbanView, {
      notes: [],
      loading: false,
      error: null,
      onOpenNote: () => {},
    }));
    expect(markup).toContain('No Kanban boards yet');
    expect(markup).not.toContain('Command center');
  });

  it.each([
    { loading: true, error: null, notice: 'Refreshing', hidden: 'Loading boards' },
    { loading: false, error: 'Network unavailable', notice: 'Refresh failed', hidden: 'Boards unavailable' },
  ])('keeps cached Superkanban content visible: $notice', ({ loading, error, notice, hidden }) => {
    const markup = renderToStaticMarkup(createElement(SuperkanbanView, {
      notes: [BOARD_NOTE],
      loading,
      error,
      onOpenNote: () => {},
    }));
    expect(markup).toContain('Command center');
    expect(markup).toContain(notice);
    expect(markup).not.toContain(hidden);
  });

  it('parses h2 sections and checklist or bullet cards', () => {
    const board = parseKanbanMarkdown(SAMPLE);
    expect(board.columns.map((column) => column.title)).toEqual(['Backlog', 'Done']);
    expect(board.columns[0].cards.map((card) => card.text)).toEqual(['Draft brief', 'Plain bullet']);
    expect(board.columns[1].cards[0].checked).toBe(true);
    expect(board.hasObsidianMarker).toBe(true);
  });

  it('moves and reorders cards without losing surrounding prose', () => {
    const board = parseKanbanMarkdown(SAMPLE);
    const next = moveKanbanCard(SAMPLE, board.columns[0].cards[0].id, board.columns[1].id);
    expect(next).toContain('Intro text stays untouched.');
    expect(parseKanbanMarkdown(next).columns[1].cards.map((card) => card.text))
      .toEqual(['Ship prototype', 'Draft brief']);

    const movedBoard = parseKanbanMarkdown(next);
    const reordered = moveKanbanCard(
      next,
      movedBoard.columns[1].cards[1].id,
      movedBoard.columns[1].id,
      movedBoard.columns[1].cards[0].id,
    );
    expect(parseKanbanMarkdown(reordered).columns[1].cards.map((card) => card.text))
      .toEqual(['Draft brief', 'Ship prototype']);
  });

  it('adds, renames, toggles, and deletes cards as ordinary Markdown', () => {
    let next = addKanbanCard(SAMPLE, parseKanbanMarkdown(SAMPLE).columns[0].id, 'Review copy');
    expect(next).toContain('- Plain bullet\n- [ ] Review copy\n\n## Done');
    let card = parseKanbanMarkdown(next).columns[0].cards.find((item) => item.text === 'Review copy')!;
    next = renameKanbanCard(next, card.id, 'Review final copy');
    card = parseKanbanMarkdown(next).columns[0].cards.find((item) => item.text === 'Review final copy')!;
    next = toggleKanbanCard(next, card.id);
    expect(next).toContain('- [x] Review final copy');
    card = parseKanbanMarkdown(next).columns[0].cards.find((item) => item.text === 'Review final copy')!;
    next = deleteKanbanCard(next, card.id);
    expect(next).not.toContain('Review final copy');
  });

  it('initializes an Obsidian-compatible board around existing note content', () => {
    const next = initializeKanbanMarkdown('# Existing');
    expect(next).toMatch(/^---\nkanban-plugin: board\nsuperkanban: true\n---\n\n# Existing\n\n## Backlog/);
    expect(next).toContain('%% kanban:settings\n```\n{"kanban-plugin":"board"}');
    expect(hasObsidianKanbanMarker(next)).toBe(true);
    expect(parseKanbanMarkdown(next).columns.map((column) => column.title)).toEqual([
      'Backlog', 'In progress', 'Blocked', 'Done',
    ]);
  });

  it('adds and renames WIP-limited columns before the settings footer', () => {
    let next = addKanbanColumn(SAMPLE, 'Blocked (2)');
    let column = parseKanbanMarkdown(next).columns.at(-1)!;
    expect(column.title).toBe('Blocked');
    expect(column.maxItems).toBe(2);
    expect(next.indexOf('## Blocked (2)')).toBeLessThan(next.indexOf('%% kanban:settings'));
    next = renameKanbanColumn(next, column.id, 'Waiting (3)');
    column = parseKanbanMarkdown(next).columns.at(-1)!;
    expect(column.title).toBe('Waiting');
    expect(column.maxItems).toBe(3);
  });

  it('adds the marker to existing frontmatter without replacing metadata', () => {
    const next = ensureKanbanFrontmatter(['---', 'tags: [project]', '---', '', '# Plan'].join('\n'));
    expect(next).toContain('tags: [project]\nkanban-plugin: board\nsuperkanban: true\n---');
    expect(hasObsidianKanbanMarker(next)).toBe(true);
  });

  it('lets an existing board opt into and out of the command center', () => {
    const legacy = SAMPLE.replace('superkanban: true\n', '');
    expect(hasSuperkanbanMarker(legacy)).toBe(false);
    const included = setSuperkanbanMarker(legacy, true);
    expect(hasSuperkanbanMarker(included)).toBe(true);
    expect(hasSuperkanbanMarker(setSuperkanbanMarker(included, false))).toBe(false);
  });

  it('shows the Superkanban control only when multiple boards exist', () => {
    const hidden = renderToStaticMarkup(createElement(KanbanView, {
      content: SAMPLE,
      onContentChange: () => {},
      showSuperkanbanToggle: false,
    }));
    expect(hidden).not.toContain('In Superkanban');

    const visible = renderToStaticMarkup(createElement(KanbanView, {
      content: SAMPLE,
      onContentChange: () => {},
      showSuperkanbanToggle: true,
    }));
    expect(visible).toContain('In Superkanban');
    expect(visible).not.toContain('command center');
  });

  it('keeps Add list in the toolbar so the board can fit the pane', () => {
    const markup = renderToStaticMarkup(createElement(KanbanView, {
      content: SAMPLE,
      onContentChange: () => {},
    }));
    const boardAt = markup.indexOf('class="kanban-board"');
    expect(boardAt).toBeGreaterThan(0);
    expect(markup.slice(0, boardAt)).toContain('kanban-add-column');
    expect(markup.slice(0, boardAt)).toContain('New Kanban list name');
    expect(markup.slice(boardAt)).not.toContain('kanban-add-column');
  });

  it('archives cards using the Obsidian thematic-break archive format', () => {
    const board = parseKanbanMarkdown(SAMPLE);
    let next = archiveKanbanCard(SAMPLE, board.columns[0].cards[0].id);
    expect(next).toContain('***\n\n## Archive');
    expect(parseKanbanMarkdown(next).archive.map((card) => card.text)).toEqual(['Draft brief']);
    expect(parseKanbanMarkdown(next).columns[0].cards.map((card) => card.text)).toEqual(['Plain bullet']);
    expect(next.indexOf('## Archive')).toBeLessThan(next.indexOf('%% kanban:settings'));

    next = archiveCompletedKanbanCards(next);
    expect(parseKanbanMarkdown(next).archive.map((card) => card.text))
      .toEqual(['Draft brief', 'Ship prototype']);
  });

  it('merges matching column names without changing board or card order', () => {
    const other = SAMPLE
      .replace('## Backlog', '##  backlog  ')
      .replace('Draft brief', 'Second board first')
      .replace('Plain bullet', 'Second board second');
    const columns = mergeKanbanSources([
      { id: 'first', title: 'First board', content: SAMPLE },
      { id: 'second', title: 'Second board', content: other },
    ]);
    expect(columns.map((column) => column.title)).toEqual(['Backlog', 'Done']);
    expect(columns[0].cards.map((card) => card.text))
      .toEqual(['Draft brief', 'Plain bullet', 'Second board first', 'Second board second']);
    expect(columns[0].cards.map((card) => card.sourceTitle))
      .toEqual(['First board', 'First board', 'Second board', 'Second board']);
  });

  it('only aggregates opted-in boards and normalizes lifecycle aliases', () => {
    const featureTest = SAMPLE.replace('superkanban: true\n', '').replace('# Project', '# Kanban Feature Test');
    const aliases = SAMPLE.replace('## Backlog', '## Wishlist').replace('## Done', '## Shipped');
    const columns = mergeKanbanSources([
      { id: 'test', title: 'Kanban Feature Test', content: featureTest },
      { id: 'product', title: 'Product', content: aliases },
    ]);
    expect(columns.map((column) => column.title)).toEqual(['Backlog', 'Done']);
    expect(columns.flatMap((column) => column.cards).every((card) => card.sourceTitle === 'Product')).toBe(true);
  });

  it('projects mission work items into Superkanban live columns', () => {
    const active: WorkItem = {
      id: 'wi-1', vaultId: 'v', channelId: 'ch', title: 'Ship isolation', brief: '',
      status: 'in_progress', priority: 0, sourceKind: 'mission', sourceId: 'task-1',
      assigneeRegistrationId: 'reg-1', leaseHolder: null, leaseExpiresAt: null,
      repository: '', baseCommit: '', branch: 'cascade/abc/ship-isolation',
      workspaceMode: 'isolated', worktreePath: '', prNumber: null, prUrl: '', prState: '',
      summary: '', verification: '', gitState: null, gitStateUpdatedAt: null,
      reviewReadiness: { ready: true, blockers: [] },
      dependsOn: [], runIds: [], createdBy: 1,
      createdAt: '', updatedAt: '',
    };
    const items: WorkItem[] = [active, {
      ...active,
      id: 'wi-2', title: 'Queued follow-up', status: 'open', sourceId: 'task-2',
      assigneeRegistrationId: null, branch: 'cascade/abc/queued',
    }];
    expect(workItemStatusToKanbanColumn('in_progress')).toBe('In progress');
    const live = workItemsToLiveColumns(items);
    expect(live.map((c) => c.title)).toEqual(['Ready', 'In progress']);
    expect(live[1].cards[0].text).toContain('Ship isolation');
    expect(live[1].cards[0].live).toBe(true);
    const boards = mergeKanbanSources([{ id: 'b1', title: 'Board', content: SAMPLE }]);
    const merged = mergeLiveWorkIntoKanban(boards, live);
    const ready = merged.find((c) => c.title === 'Ready')!;
    expect(ready.cards[0].sourceTitle).toBe('Live mission work');
    const backlog = merged.find((c) => c.title === 'Backlog')!;
    expect(backlog.cards.some((c) => c.text === 'Draft brief')).toBe(true);
  });

  it('preserves rich card text and parses empty columns', () => {
    const cards = [
      'Add MP4 embeds — accept already allows `video/*`; no real `<video>` render yet',
      'Cap anonymous mission fanout concurrency',
      'Deeper task-workspace roadmap — [[Cascade-native parallel workspaces and pull requests]]',
    ];
    const live = SAMPLE
      .replace('- [ ] Draft brief\n- Plain bullet', cards.map((text) => `- [ ] ${text}`).join('\n') + '\n  - durable work-item schema')
      .replace('## Done', '## In progress\n\n## Done');
    const board = parseKanbanMarkdown(live);
    expect(board.columns.map((c) => c.title)).toEqual(['Backlog', 'In progress', 'Done']);
    expect(board.columns[0].cards.map((c) => c.text)).toEqual(expect.arrayContaining(cards));
    expect(board.columns[1].cards).toEqual([]);
  });

  it('tolerates non-string content', () => {
    expect(parseKanbanMarkdown(undefined as unknown as string).columns).toEqual([]);
  });
});

describe('per-category completion on entry', () => {
  const original = '## Done\n\n* [ ] One\n+ Plain\n\n## Arbitrary (3)\n\n- [ ] Existing\n\n## Arbitrary (3)\n\n%% kanban:settings\n```\n{}\n```\n%%';
  const columns = (text: string) => parseKanbanMarkdown(text).columns;
  const enabled = () => setKanbanColumnCompleteOnEntry(original, columns(original)[1].id, true);

  it('defaults off and persists only the actual category across rename, add and section reorder', () => {
    expect(columns(original).every(c => !c.completeOnEntry)).toBe(true);
    let text = enabled();
    expect(columns(text).map(c => c.completeOnEntry)).toEqual([false, true, false]);
    expect(columns(text)[1].cards[0].checked).toBe(false);
    text = renameKanbanColumn(text, columns(text)[1].id, 'Accepted (4)');
    text = addKanbanColumn(text, 'New');
    const marked = columns(text)[1];
    const lines = text.split('\n');
    const section = lines.splice(marked.headingLineIndex, marked.endLineIndex - marked.headingLineIndex);
    lines.unshift(...section);
    text = lines.join('\n');
    expect(columns(text)[0]).toMatchObject({ title: 'Accepted', maxItems: 4, completeOnEntry: true });
    expect(columns(text).slice(1).every(c => !c.completeOnEntry)).toBe(true);
    text = setKanbanColumnCompleteOnEntry(text, columns(text)[0].id, false);
    expect(text).not.toContain('fizzer:complete-on-entry');
    expect(text).toContain('%% kanban:settings\n```\n{}');
  });

  it.each(['before', 'after', 'background'] as const)('completes entry via %s with manual checkbox semantics; exit never reopens', placement => {
    let text = enabled();
    let [source, target] = columns(text);
    const manual = toggleKanbanCard(text, source.cards[0].id);
    text = moveKanbanCard(text, source.cards[0].id, target.id,
      placement === 'background' ? undefined : target.cards[0].id,
      placement === 'background' ? undefined : placement);
    expect(text).toContain(manual.split('\n').find(line => line.includes('One')));
    [source, target] = columns(text);
    const moved = target.cards.find(c => c.text === 'One')!;
    expect(moved.checked).toBe(true);
    text = moveKanbanCard(text, moved.id, source.id);
    expect(columns(text)[0].cards.find(c => c.text === 'One')?.checked).toBe(true);
  });

  it('does not complete same-column reorders or entry into unmarked Done', () => {
    let text = enabled();
    let cols = columns(text);
    text = addKanbanCard(text, cols[1].id, 'Second');
    cols = columns(text);
    text = moveKanbanCard(text, cols[1].cards[0].id, cols[1].id, cols[1].cards[1].id, 'after');
    expect(columns(text)[1].cards.every(c => !c.checked)).toBe(true);
    cols = columns(text);
    text = moveKanbanCard(text, cols[1].cards[0].id, cols[0].id);
    expect(columns(text)[0].cards.every(c => !c.checked)).toBe(true);
  });

  it('keeps metadata next to empty headings when adding or moving and preserves plain bullet markers', () => {
    let text = setKanbanColumnCompleteOnEntry(original, columns(original)[2].id, true);
    let cols = columns(text);
    text = moveKanbanCard(text, cols[0].cards[1].id, cols[2].id);
    expect(columns(text)[2]).toMatchObject({ completeOnEntry: true, cards: [expect.objectContaining({ checked: true, marker: '+' })] });
    text = deleteKanbanCard(text, columns(text)[2].cards[0].id);
    text = addKanbanCard(text, columns(text)[2].id, 'New card');
    expect(columns(text)[2]).toMatchObject({ completeOnEntry: true, cards: [expect.objectContaining({ checked: false })] });
    expect(setKanbanColumnCompleteOnEntry(original, 'missing', true)).toBe(original);
  });
});
