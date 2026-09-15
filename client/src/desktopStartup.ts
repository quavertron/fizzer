import { useEffect, useRef, useState } from 'react';

export const DESKTOP_SELECTION_KEY = 'fizzer_desktop_selection_v1';

export async function rememberDesktopSession(remember?: () => Promise<void>): Promise<void> {
  try { await remember?.(); }
  catch { console.warn('Signed in, but the desktop could not save this server session.'); }
}

type RemoteInviteBridge = {
  acceptRemoteInvite?: (input: { inviteUrl: string }) => Promise<{ success: boolean; vault?: { id: string }; error?: string }>;
  openConnection?: (input: { id: string; origin: string }) => Promise<{ success: boolean; error?: string }>;
};

export async function acceptAndOpenRemoteInvite(bridge: RemoteInviteBridge, inviteUrl: string): Promise<void> {
  if (!bridge.acceptRemoteInvite || !bridge.openConnection) throw new Error('Remote connections are unavailable in this desktop.');
  const result = await bridge.acceptRemoteInvite({ inviteUrl });
  if (!result.success || !result.vault) throw new Error(result.error || 'Failed to accept remote invite');
  const opened = await bridge.openConnection({ id: result.vault.id, origin: new URL(inviteUrl).origin });
  if (!opened.success) throw new Error(opened.error || 'Could not open the remote vault');
}

type Selection = { ownerId: string; origin: string; vaultId: string };

export function readDesktopSelection(storage: Pick<Storage, 'getItem'>): Selection | null {
  try {
    const value = JSON.parse(storage.getItem(DESKTOP_SELECTION_KEY) || 'null');
    return value && ['ownerId', 'origin', 'vaultId'].every(key => typeof value[key] === 'string' && value[key]) ? value : null;
  } catch { return null; }
}

export function canRestoreDesktopSelection(selection: Selection | null, ownerId: string, origin: string, activeVaultId: string | null, vaults: { id: string }[]): boolean {
  return Boolean(selection && selection.ownerId === ownerId && selection.origin === origin
    && selection.vaultId === activeVaultId && vaults.some(vault => vault.id === selection.vaultId));
}

/** A selection is navigation, never authority: authenticate and list vaults first. */
export function useDesktopStartup(desktop: boolean, ownerId: string | null, activeVaultId: string | null, vaults: { id: string }[], listingReady: boolean) {
  const [state, setState] = useState<{ phase: 'pending' | 'chooser' | 'workspace'; ownerId: string | null }>({ phase: desktop ? 'pending' : 'workspace', ownerId: null });
  const selection = useRef(readDesktopSelection(localStorage));
  const remember = (vaultId: string | null) => {
    if (!desktop || !ownerId || !vaultId || !vaults.some(vault => vault.id === vaultId)) return;
    const value = { ownerId, origin: window.location.origin, vaultId };
    selection.current = value;
    try { localStorage.setItem(DESKTOP_SELECTION_KEY, JSON.stringify(value)); } catch { /* Storage unavailable: choose again next launch. */ }
  };
  useEffect(() => {
    if (!desktop) return;
    if (!ownerId) {
      if (state.ownerId || state.phase !== 'pending') setState({ phase: 'pending', ownerId: null });
      return;
    }
    if (!listingReady || state.ownerId === ownerId) return;
    const params = new URLSearchParams(window.location.search);
    const requestedVaultId = params.get('vault');
    const requestedVaultReady = requestedVaultId === activeVaultId && vaults.some(vault => vault.id === requestedVaultId);
    setState({ ownerId, phase: params.get('chooser') !== '1' && (requestedVaultReady || canRestoreDesktopSelection(selection.current, ownerId, window.location.origin, activeVaultId, vaults)) ? 'workspace' : 'chooser' });
  }, [desktop, ownerId, activeVaultId, vaults, listingReady, state]);
  return {
    pending: desktop && (!ownerId || state.ownerId !== ownerId || state.phase === 'pending'),
    open: state.phase === 'chooser',
    choose: () => setState({ ownerId, phase: 'chooser' }),
    continue: () => { remember(activeVaultId); setState({ ownerId, phase: 'workspace' }); },
    remember,
    reset: () => {
      selection.current = null;

      try { localStorage.removeItem(DESKTOP_SELECTION_KEY); } catch { /* optional persistence */ }
      setState({ ownerId: null, phase: desktop ? 'pending' : 'workspace' });
    },
  };
}
