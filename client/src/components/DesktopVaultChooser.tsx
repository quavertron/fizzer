import { useState } from 'react';
import { FizzerMark } from './FizzerMark';
import type { Vault } from '../api';

type DesktopBridge = {
  connectRemoteInstance?: (input: { origin: string; username: string; password: string }) => Promise<{ success: boolean; error?: string }>;
};

type Props = {
  vaults: Vault[];
  activeVaultId: string | null;
  onSelect: (id: string) => void;
  onCreate: (name: string) => Promise<boolean>;
  onContinue: () => void;
};

export function DesktopVaultChooser({ vaults, activeVaultId, onSelect, onCreate, onContinue }: Props) {
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [origin, setOrigin] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const bridge = (window as unknown as { electronAPI?: DesktopBridge }).electronAPI;

  const submitCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    if (await onCreate(name)) {
      setName('');
      setCreateOpen(false);
    }
    setBusy(false);
  };

  const submitRemote = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!bridge?.connectRemoteInstance) return;
    setBusy(true);
    setError('');
    try {
      const result = await bridge.connectRemoteInstance({ origin, username, password });
      if (!result.success) setError(result.error || 'Could not connect to the remote instance');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not connect to the remote instance');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="desktop-chooser-shell">
      <section className="desktop-chooser-panel" aria-labelledby="desktop-chooser-title">
        <div className="auth-brand"><FizzerMark size={28} /><h1>Fizzer</h1></div>
        <div className="desktop-chooser-intro">
          <span className="surface-kicker">Desktop workspace</span>
          <h2 id="desktop-chooser-title">Choose a vault</h2>
          <p>Your local vaults and connected online instances live here.</p>
        </div>
        <div className="desktop-chooser-vaults" aria-label="Local vaults">
          {vaults.map((vault) => (
            <button key={vault.id} type="button" className={vault.id === activeVaultId ? 'is-active' : ''} onClick={() => onSelect(vault.id)}>
              <strong>{vault.name}</strong><small>Local vault</small>
            </button>
          ))}
          {!vaults.length && <p className="desktop-chooser-empty">No local vaults yet.</p>}
        </div>
        <div className="desktop-chooser-actions">
          {createOpen ? (
            <form onSubmit={submitCreate} className="desktop-chooser-form">
              <label htmlFor="desktop-new-vault">Vault name</label>
              <input id="desktop-new-vault" value={name} onChange={(event) => setName(event.target.value)} autoFocus required />
              <div><button type="submit" disabled={busy}>Create vault</button><button type="button" onClick={() => setCreateOpen(false)}>Cancel</button></div>
            </form>
          ) : <button type="button" onClick={() => setCreateOpen(true)}>＋ Create local vault</button>}
          {!remoteOpen ? <button type="button" onClick={() => setRemoteOpen(true)}>↗ Join online vault</button> : (
            <form onSubmit={submitRemote} className="desktop-chooser-form desktop-remote-form">
              <label htmlFor="desktop-remote-origin">Drop link or IP:port</label>
              <input id="desktop-remote-origin" value={origin} onChange={(event) => setOrigin(event.target.value)} placeholder="https://vault.example.com or 192.168.1.20:4000" autoFocus required />
              <label htmlFor="desktop-remote-username">Username</label>
              <input id="desktop-remote-username" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required />
              <label htmlFor="desktop-remote-password">Password</label>
              <input id="desktop-remote-password" value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" required />
              {error && <p className="error" role="alert">{error}</p>}
              <div><button type="submit" disabled={busy}>{busy ? 'Connecting…' : 'Connect'}</button><button type="button" onClick={() => { setRemoteOpen(false); setError(''); }}>Cancel</button></div>
            </form>
          )}
        </div>
        <button type="button" className="desktop-chooser-continue" onClick={onContinue} disabled={!vaults.length}>Open selected vault</button>
      </section>
    </main>
  );
}
