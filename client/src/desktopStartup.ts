import { useEffect, useRef, useState } from 'react';

export const DESKTOP_SELECTION_KEY = 'fizzer_desktop_selection_v1';
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
    setState({ ownerId, phase: canRestoreDesktopSelection(selection.current, ownerId, window.location.origin, activeVaultId, vaults) ? 'workspace' : 'chooser' });
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
