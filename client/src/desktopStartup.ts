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

export function selectDesktopStartupVault(selection: Selection | null, ownerId: string, origin: string, vaults: { id: string }[], requestedVaultId: string | null = null): string | null {
  const accessible = (id: string | null) => id && vaults.some(vault => vault.id === id);
  if (accessible(requestedVaultId)) return requestedVaultId;
  if (selection?.ownerId === ownerId && selection.origin === origin && accessible(selection.vaultId)) return selection.vaultId;
  // Stable across server list ordering; never restore an unbound legacy pointer.
  return vaults.map(vault => vault.id).sort()[0] ?? null;
}

/** A selection is navigation, never authority: authenticate and list vaults first. */
export function useDesktopStartup(desktop: boolean, ownerId: string | null, activeVaultId: string | null, vaults: { id: string }[], listingReady: boolean, select: (id: string | null) => void) {
  const [resolvedOwner, setResolvedOwner] = useState<string | null>(null);
  const selection = useRef(readDesktopSelection(localStorage));
  const remember = (vaultId: string | null) => {
    if (!desktop || !ownerId || !vaultId || !vaults.some(vault => vault.id === vaultId)) return;
    const value = { ownerId, origin: window.location.origin, vaultId };
    selection.current = value;
    try { localStorage.setItem(DESKTOP_SELECTION_KEY, JSON.stringify(value)); } catch { /* optional persistence */ }
  };
  const activeAccessible = activeVaultId === null ? vaults.length === 0 : vaults.some(vault => vault.id === activeVaultId);
  useEffect(() => {
    if (!desktop) return;
    if (!ownerId) { setResolvedOwner(null); return; }
    if (!listingReady) return;
    if (resolvedOwner === ownerId && activeAccessible) return;
    const requested = resolvedOwner === ownerId ? null : new URLSearchParams(window.location.search).get('vault');
    select(selectDesktopStartupVault(selection.current, ownerId, window.location.origin, vaults, requested));
    setResolvedOwner(ownerId);
  }, [desktop, ownerId, vaults, listingReady, resolvedOwner, activeAccessible, select]);
  return {
    pending: desktop && (!ownerId || !listingReady || resolvedOwner !== ownerId || !activeAccessible),
    remember,
    reset: (preserveSelection = false) => {
      if (!preserveSelection) {
        selection.current = null;
        try { localStorage.removeItem(DESKTOP_SELECTION_KEY); } catch { /* optional persistence */ }
      }
      setResolvedOwner(null);
    },
  };
}
