import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ArrowDown, ArrowUp, ChevronsDownUp, ChevronsUpDown, Search, Trash2 } from 'lucide-react';
import { emptyCounts, eventDiff, type Analysis, type ChangeCounts } from '../awatchDiff';

import { useActivity, type AwatchEvent } from '../activity';
export type { AwatchEvent } from '../activity';

export function eventLabel(event: AwatchEvent) {
  if (event.kind === 'lock' && event.result === 'released') return 'Lock released';
  if (event.kind === 'lock') return event.result === 'conflict' ? 'Lock conflict' : event.result === 'shared' ? 'Shared lock' : event.result === 'rejected' ? 'Lock rejected' : 'Lock granted';
  if (event.kind === 'tool') return event.tool || 'Tool activity';
  return 'File edited';
}

const EventDiff = memo(function EventDiff({ event, analysis }: { event: AwatchEvent; analysis?: Analysis }) {
  if (!analysis) return <p className="awatch-detail">Analyzing change…</p>;
  if (analysis.error) return <p className="awatch-detail">{analysis.error}</p>;
  const lines = analysis.lines || [];
  if (!lines.length) return <p className="awatch-detail">No text changes.</p>;
  const offset = Math.max(0, (event.line_start || 1) - 1);
  return <div className="awatch-diff" aria-label="File diff">
    <pre><code>{lines.slice(0, 600).map((line, row) => <span key={row} className={line.startsWith('@@') ? 'awatch-diff-hunk' : line.startsWith('+') ? 'awatch-added' : line.startsWith('-') ? 'awatch-removed' : ''}>{(line.startsWith('@@') ? line.replace(/([+-])(\d+)/g, (_, sign, n) => sign + (Number(n) + offset)) : line) + '\n'}</span>)}</code></pre>
    {lines.length > 600 && <p className="awatch-detail">Diff preview limited to 600 lines.</p>}
  </div>;
});

function Counts({ counts }: { counts: ChangeCounts }) {
  return <span className="awatch-counts" aria-label={`${counts.adds} added, ${counts.moves} moved, ${counts.mods} modified, ${counts.dels} deleted`}>
    <span className="awatch-added" title="Added lines">+{counts.adds}</span>{' '}
    <span className="awatch-moved" title="Moved lines">*{counts.moves}</span>{' '}
    <span className="awatch-modified" title="Modified lines">~{counts.mods}</span>{' '}
    <span className="awatch-removed" title="Deleted lines">−{counts.dels}</span>
  </span>;
}

const EventLine = memo(function EventLine({ event, analysis, expanded, toggle }: { event: AwatchEvent; analysis?: Analysis; expanded: boolean; toggle: () => void }) {
  const hasDiff = Boolean(event.old_lines?.length || event.new_lines?.length);
  const counts = event.kind === 'edit' ? analysis?.counts : undefined;
  const date = new Date(event.timestamp * 1000);
  return <div className={'awatch-event' + (event.result === 'conflict' ? ' awatch-conflict' : '')}>
    <div className="awatch-event-meta">
      {hasDiff && <button className="awatch-toggle" type="button" aria-label={`${expanded ? 'Collapse' : 'Expand'} diff for ${event.file}`} aria-expanded={expanded} onClick={toggle}>{expanded ? '▾' : '▸'}</button>}
      {Number.isFinite(date.getTime()) && <><time dateTime={date.toISOString()}>{date.toLocaleTimeString([], { hour12: false })}</time>{' '}</>}
      <span className="awatch-event-kind">{eventLabel(event)}</span>{' '}
      <span>[{event.author || event.agent || 'Agent'}]</span>{' '}
      {event.file && <span className="awatch-file" title={event.file}>{event.file}</span>}
      {event.line_start && event.line_end && event.line_end < 2147483647
        ? <span className="awatch-range">:{event.line_start}{event.line_end !== event.line_start ? `–${event.line_end}` : ''}</span> : null}
      {counts && <> <Counts counts={counts} /></>}
    </div>
    {(analysis?.detail || event.detail) && <p className="awatch-detail">{analysis?.detail || event.detail}</p>}
    {event.truncated && <p className="awatch-detail">Large change: diff preview is truncated.</p>}
    {hasDiff && expanded && <EventDiff event={event} analysis={analysis} />}
  </div>;
});

export function AwatchPane({ activityKey }: { activityKey: string }) {
  const { events, status, gap, connected } = useActivity(activityKey);
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [follow, setFollow] = useState(true);
  const [expanded, setExpanded] = useState(true);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const list = useRef<HTMLDivElement>(null);
  const [analyses, setAnalyses] = useState<Map<AwatchEvent, Analysis>>(new Map());
  useEffect(() => {
    let active = true;
    void Promise.all(events.filter(event => event.kind === 'edit' || event.kind === 'lock').map(async event => [event, await eventDiff(event)] as const)).then(values => {
      if (active) setAnalyses(new Map(values));
    });
    return () => { active = false; };
  }, [events]);
  const toggleAll = () => { setExpanded(value => !value); setOverrides({}); };
  const jump = (bottom: boolean) => {
    setFollow(bottom);
    if (list.current) list.current.scrollTop = bottom ? list.current.scrollHeight : 0;
  };
  const recent = useMemo(() => events.filter(event => !cleared.has(event.id)), [events, cleared]);
  const totals = useMemo(() => {
    const counts = emptyCounts();
    let incomplete = false;
    for (const event of recent) if (event.kind === 'edit') {
      const change = analyses.get(event)?.counts;
      if (!change || event.truncated) incomplete = true;
      if (change) for (const key of ['adds', 'moves', 'mods', 'dels'] as const) counts[key] += change[key];
    }
    return { counts, incomplete, files: new Set(recent.map(e => e.file).filter(Boolean)).size, agents: new Set(recent.map(e => e.author || e.agent).filter(Boolean)).size };
  }, [recent, analyses]);

  const visible = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return events.filter(event => !cleared.has(event.id) && (!query || [event.file, event.agent, event.author, event.detail, eventLabel(event)].some(value => value?.toLowerCase().includes(query))));
  }, [events, filter, cleared]);
  useEffect(() => {
    if (follow && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [visible, follow, expanded, overrides, analyses]);

  return <section className="awatch-pane" aria-label="Awatch activity monitor" onKeyDown={event => {
    if ((event.target as HTMLElement).closest('input, textarea, [contenteditable="true"]')) return;
    if (event.ctrlKey && event.key.toLowerCase() === 'o') { event.preventDefault(); toggleAll(); }
    else if (event.key === 'Home' || event.key === 'g') { event.preventDefault(); jump(false); }
    else if (event.key === 'End' || event.key === 'G') { event.preventDefault(); jump(true); }
  }}>
    <div className="awatch-toolbar">
      <Activity size={14} aria-hidden="true" />
      <span className={connected ? 'awatch-live' : ''}>{connected ? 'Live' : 'Connecting'}</span>
      <label className="awatch-search"><Search size={13} aria-hidden="true" /><input aria-label="Filter Awatch activity" placeholder="Filter files or agents…" value={filter} onChange={event => setFilter(event.target.value)} /></label>
      <button type="button" aria-label={expanded ? 'Collapse all diffs' : 'Expand all diffs'} title="Toggle all diffs (Ctrl+O)" onClick={toggleAll}>{expanded ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />}</button>
      <button type="button" aria-label="Jump to first activity" title="Top (Home)" onClick={() => jump(false)}><ArrowUp size={14} /></button>
      <button type="button" aria-label="Follow latest activity" aria-pressed={follow} title="Follow latest activity (End)" onClick={() => follow ? setFollow(false) : jump(true)}><ArrowDown size={14} /></button>
      <button type="button" aria-label="Clear activity view" title="Clear this view" onClick={() => { setCleared(new Set(events.map(event => event.id))); }}><Trash2 size={14} /></button>
    </div>
    {(status || gap) && <div className="awatch-status" role="status">{gap || status}</div>}
    <div className="awatch-events" ref={list} tabIndex={0} aria-label="Activity log" onMouseDown={() => setFollow(false)} onScroll={() => {
      const element = list.current;
      if (element) setFollow(element.scrollHeight - element.scrollTop - element.clientHeight <= 40);
    }}>
      {visible.map(event => <EventLine key={event.id} event={event} analysis={analyses.get(event)} expanded={overrides[event.id] ?? expanded} toggle={() => setOverrides(value => ({ ...value, [event.id]: !(value[event.id] ?? expanded) }))} />)}
      {!visible.length && <div className="awatch-empty"><Activity size={24} /><strong>{filter ? 'No matching activity' : 'Watching for activity'}</strong><span>{filter ? 'Try another file or agent name.' : 'File edits and lock activity in this vault appear here.'}</span></div>}
    </div>
    <footer className="awatch-footer" aria-label="Activity statistics">
      <Counts counts={totals.counts} />{totals.incomplete && <span title="Some diff previews are truncated or unavailable">partial</span>}
      <span>{recent.length} events · {totals.files} files · {totals.agents} agents</span>
      <span>{filter ? `${visible.length} matching · ` : ''}{follow ? 'Following' : 'Paused'} · Recent activity</span>
    </footer>
  </section>;
}
