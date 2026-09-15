import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';

type LocalSession = { id: string; title: string; cwd: string; updated_at: number };
type Page = { id: string; title: string; cwd: string; messages: unknown[]; nextOffset: number; snapshotEnd: number; hasMore: boolean };
type Bridge = {
  listCodexSessions: (options: { offset: number; search: string }) => Promise<{ sessions: LocalSession[]; nextOffset: number | null }>;
  readCodexSession: (options: { id: string; offset: number; snapshotEnd?: number }) => Promise<Page>;
};
const bridge = () => (window as unknown as { electronAPI?: Bridge }).electronAPI;

/** Copy a bounded snapshot; never subscribe to future transcript changes. */
export function useCodexImports(ownerId: string | null) {
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    return () => { generation.current += 1; };
  }, [ownerId]);
  const importSession = useCallback(async (id: string, vaultId: string) => {
    const current = generation.current;
    let offset = 0;
    let snapshotEnd: number | undefined;
    let imported: { channelId: string; title: string } | undefined;
    do {
      const page = await bridge()!.readCodexSession({ id, offset, snapshotEnd });
      if (current !== generation.current) throw new Error('Server session changed. Try again.');
      snapshotEnd = page.snapshotEnd;
      const result = await api<{ imported: { channelId: string; title: string; following: boolean; paused: boolean } }>(
        `/api/vaults/${encodeURIComponent(vaultId)}/import-codex-session`,
        { method: 'POST', body: JSON.stringify(page), signal: AbortSignal.timeout(15000) });
      if (current !== generation.current) throw new Error('Server session changed. Try again.');
      imported = result.imported;
      if (result.imported.paused) throw new Error('This session already has a run queued in Fizzer. Let it finish before importing again.');
      if (!result.imported.following || !page.hasMore) break;
      offset = page.nextOffset;
    } while (true);
    return imported!;
  }, []);
  return { importSession };
}

export function CodexSessionImport({ vaultId, onImport, onOpenChat }: {
  vaultId: string | null;
  onImport: (id: string, vaultId: string) => Promise<{ channelId: string; title: string }>;
  onOpenChat: (vaultId: string, channelId: string, title: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<LocalSession[]>([]);
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [next, setNext] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    let canceled = false;
    setBusy(true);
    const timer = setTimeout(() => {
      void bridge()!.listCodexSessions({ offset, search }).then(result => {
        if (!canceled) { setSessions(result.sessions); setNext(result.nextOffset); setError(''); }
      }).catch(err => { if (!canceled) setError(String(err.message || err)); })
        .finally(() => { if (!canceled) setBusy(false); });
    }, 200);
    return () => { canceled = true; clearTimeout(timer); };
  }, [open, offset, search]);
  if (!bridge()?.listCodexSessions) return null;
  return <section style={{ padding: '12px 20px', maxHeight: '40vh', overflow: 'auto' }}>
    <button className="btn" disabled={busy} onClick={() => setOpen(!open)}>Import local Codex session</button>
    {open && <>
      <p>Copy a session’s existing messages into this vault, then continue it in Fizzer. Other vault members can read imported messages. If Codex is still working elsewhere, wait for that turn to finish before continuing.</p>
      {!vaultId && <p>Open a vault first.</p>}
      <input aria-label="Search local Codex sessions" placeholder="Search sessions…" disabled={busy} value={search} onChange={event => { setSearch(event.target.value); setOffset(0); }} />
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">Loading…</p>}
      {!busy && sessions.length === 0 && <p>No local Codex sessions found.</p>}
      {sessions.map(session => <div key={session.id} style={{ marginTop: 8 }}>
        <button className="btn" disabled={busy || !vaultId} onClick={async () => {
          if (!vaultId) return;
          setBusy(true);
          try { const imported = await onImport(session.id, vaultId); await onOpenChat(vaultId, imported.channelId, imported.title); }
          catch (err) { setError(err instanceof Error ? err.message : 'Import failed.'); }
          finally { setBusy(false); }
        }}>{session.title || 'Untitled Codex session'}</button>
        <small style={{ display: 'block' }}>{session.cwd} · {new Date(session.updated_at * 1000).toLocaleString()}</small>
      </div>)}
      <button className="btn" disabled={busy || offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous</button>
      <button className="btn" disabled={busy || next === null} onClick={() => next !== null && setOffset(next)}>Next</button>
    </>}
  </section>;
}
