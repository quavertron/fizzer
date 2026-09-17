import { useEffect, useState } from 'react';

export type ServerConnection = {
  id: string;
  name: string;
  origin: string;
  local?: boolean;
  hasSession?: boolean;
};

type DesktopBridge = {
  listConnections?: () => Promise<ServerConnection[]>;
  openConnection?: (input: { id: string; origin: string }) => Promise<{ success: boolean; error?: string }>;
};

declare global {
  interface Window {
    electronAPI?: DesktopBridge;
  }
}

/**
 * Server picker for the desktop login screen. Lists every server the shell has
 * signed into before (plus "This Mac" for the embedded backend) and lets the
 * user jump to one or type a new address. Picking a server navigates the whole
 * shell to that origin — a stored session resumes silently, otherwise the
 * target serves its own login form.
 */
export function ServerPicker() {
  const desktop = window.electronAPI;
  const [servers, setServers] = useState<ServerConnection[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    desktop?.listConnections?.()
      .then((list) => { if (alive) setServers(Array.isArray(list) ? list : []); })
      .catch(() => { if (alive) setServers([]); });
    return () => { alive = false; };
  }, []);

  if (!desktop?.openConnection) return null;

  const others = (servers ?? []).filter((server) => server.origin !== window.location?.origin);

  const open = async (origin: string, id = '') => {
    if (busy || !origin.trim()) return;
    setBusy(true);
    setError('');
    try {
      const result = await desktop.openConnection!({ id, origin: origin.trim() });
      if (!result?.success) setError(result?.error || 'Could not reach that server.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not reach that server.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-servers">
      <span className="auth-servers-label">Server</span>
      <p className="auth-servers-current">{window.location?.host}</p>
      {others.map((server) => (
        <button
          key={server.origin}
          type="button"
          className="auth-server"
          disabled={busy}
          onClick={() => void open(server.origin, server.id)}
        >
          <strong>{server.name}</strong>
          <small>{server.hasSession ? 'Signed in' : 'Sign in required'}</small>
        </button>
      ))}
      {adding ? (
        <div className="auth-server-add">
          <input
            value={address}
            placeholder="host[:port] or https://…"
            aria-label="Server address"
            autoComplete="off"
            disabled={busy}
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void open(address);
              }
            }}
          />
          <div>
            <button type="button" disabled={busy || !address.trim()} onClick={() => void open(address)}>Connect</button>
            <button type="button" disabled={busy} onClick={() => { setAdding(false); setAddress(''); setError(''); }}>Cancel</button>
          </div>
        </div>
      ) : (
        <button type="button" className="link-button auth-server-add-toggle" disabled={busy} onClick={() => setAdding(true)}>
          Use a different server…
        </button>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
