import { useEffect, useState } from 'react';
import { FizzerMark } from './FizzerMark';
import type { Vault } from '../api';

type DesktopBridge = {
  listConnections?: () => Promise<{ id: string; name: string; origin: string }[]>;
  openConnection?: (input: { id: string; origin: string }) => Promise<{ success: boolean; error?: string }>;
  connectRemoteInstance?: (input: { origin: string; username: string; password: string }) => Promise<{ success: boolean; error?: string; origin?: string; vaults?: Vault[] }>;
  acceptRemoteInvite?: (input: { inviteUrl: string; username?: string; password?: string }) => Promise<{ success: boolean; vault?: Vault; error?: string }>;
};

type Props = {
  vaults: Vault[];
  activeVaultId: string | null;
  onSelect: (id: string) => void;
  onCreate: (name: string) => Promise<boolean>;
  onContinue: () => void;
  onConnectLocal?: () => void;
};

export function DesktopVaultChooser({ vaults, activeVaultId, onSelect, onCreate, onContinue, onConnectLocal }: Props) {
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [origin, setOrigin] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [connections, setConnections] = useState<{ id: string; name: string; origin: string }[]>([]);
  const bridge = (window as unknown as { electronAPI?: DesktopBridge }).electronAPI;
  const serverKind = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname) ? 'local' : 'remote';
  const refreshConnections = () => bridge?.listConnections?.().then(setConnections).catch(() => {});
  useEffect(() => { void refreshConnections(); }, []);
  const openConnection = async (connection: { id: string; origin: string }) => {
    setBusy(true);
    setError('');
    try {
      const result = await bridge?.openConnection?.(connection);
      if (!result?.success) setError(result?.error || 'Could not open this instance.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not open this instance.'); }
    finally { setBusy(false); }
  };

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
    setBusy(true);
    setError('');
    try {
      if (origin.includes('/vault-invite/')) {
        if (!bridge?.acceptRemoteInvite) {
          throw new Error('Remote invite redemption is not supported in this shell');
        }
        const result = await bridge.acceptRemoteInvite({
          inviteUrl: origin,
          username: username || undefined,
          password: password || undefined,
        });
        if (!result.success) {
          setError(result.error || 'Could not join remote vault');
          return;
        }
        if (result.vault) {
          await openConnection({ id: result.vault.id, origin: new URL(origin).origin });
        }
        setRemoteOpen(false);
        setOrigin('');
        setUsername('');
        setPassword('');
      } else {
        if (!bridge?.connectRemoteInstance) return;
        const result = await bridge.connectRemoteInstance({ origin, username, password });
        if (!result.success) {
          setError(result.error || 'Could not connect to the remote instance');
          return;
        }
        // Open the authenticated server even if there are no vaults yet. Its
        // normal chooser can create the first vault through POST /api/vaults.
        if (result.origin) await openConnection({ id: result.vaults?.[0]?.id || '', origin: result.origin });
        setRemoteOpen(false);
        setOrigin('');
        setUsername('');
        setPassword('');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not connect to the remote instance');
    } finally {
      void refreshConnections();
      setBusy(false);
    }
  };

  const isInviteLink = origin.includes('/vault-invite/');

  return (
    <main className="desktop-chooser-shell">
      <section className="desktop-chooser-panel" aria-labelledby="desktop-chooser-title">
        <div className="auth-brand"><FizzerMark size={28} /><h1>Fizzer</h1></div>
        <div className="desktop-chooser-intro">
          <span className="surface-kicker">Desktop workspace</span>
          <h2 id="desktop-chooser-title">Choose a vault</h2>
          <p>Your local vaults and connected online instances live here.</p>
        </div>
        <div className="desktop-chooser-vaults" aria-label="Vaults">
          {vaults.map((vault) => {
            const instanceOrigin = vault.origin || (!['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname) ? window.location.origin : '');
            const isRemote = Boolean(instanceOrigin);
            let originHost = '';
            if (instanceOrigin) {
              try { originHost = new URL(instanceOrigin).host; } catch { originHost = instanceOrigin; }
            }
            return (
              <button key={vault.id} type="button" className={vault.id === activeVaultId ? 'is-active' : ''} onClick={() => onSelect(vault.id)}>
                <strong>{vault.name}</strong>
                <small>{isRemote ? `☁ Remote (${originHost})` : '⌂ Local vault'}</small>
              </button>
            );
          })}
          {!vaults.length && <p className="desktop-chooser-empty">No vaults yet.</p>}
          {connections.filter(connection => connection.origin !== window.location.origin).map(connection => (
            <button key={`${connection.origin}/${connection.id}`} type="button" disabled={busy} onClick={() => void openConnection(connection)}>
              <strong>{connection.name}</strong><small>Remote ({connection.origin})</small>
            </button>
          ))}
        </div>
        {error && !remoteOpen && <p className="error" role="alert">{error}</p>}
        <div className="desktop-chooser-actions">
          {onConnectLocal ? <button type="button" onClick={onConnectLocal}>Connect to {serverKind} server ({window.location.host})</button> : createOpen ? (
            <form onSubmit={submitCreate} className="desktop-chooser-form">
              <label htmlFor="desktop-new-vault">Vault name</label>
              <input id="desktop-new-vault" value={name} onChange={(event) => setName(event.target.value)} autoFocus required />
              <div><button type="submit" disabled={busy}>Create vault</button><button type="button" onClick={() => setCreateOpen(false)}>Cancel</button></div>
            </form>
          ) : <button type="button" onClick={() => setCreateOpen(true)}>＋ Create {serverKind} vault</button>}
          {!remoteOpen ? <button type="button" onClick={() => setRemoteOpen(true)}>↗ Connect to remote server</button> : (
            <form onSubmit={submitRemote} className="desktop-chooser-form desktop-remote-form">
              <label htmlFor="desktop-remote-origin">Drop invite link or origin / LAN IP</label>
              <input id="desktop-remote-origin" value={origin} onChange={(event) => setOrigin(event.target.value)} placeholder="https://cscd.online/vault-invite/... or 192.168.1.20:4000" autoFocus required />
              <label htmlFor="desktop-remote-username">Username {!isInviteLink && '(required)'}</label>
              <input id="desktop-remote-username" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required={!isInviteLink} />
              <label htmlFor="desktop-remote-password">Password {!isInviteLink && '(required)'}</label>
              <input id="desktop-remote-password" value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" required={!isInviteLink} />
              {error && <p className="error" role="alert">{error}</p>}
              <div><button type="submit" disabled={busy}>{busy ? 'Connecting…' : (isInviteLink ? 'Join Vault' : 'Connect')}</button><button type="button" onClick={() => { setRemoteOpen(false); setError(''); }}>Cancel</button></div>
            </form>
          )}
        </div>
        <button type="button" className="desktop-chooser-continue" onClick={onContinue} disabled={!vaults.length}>Open selected vault</button>
      </section>
    </main>
  );
}
