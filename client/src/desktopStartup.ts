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
  const [open, setOpen] = useState(desktop);
  const resolvedOwner = useRef<string | null>(null);
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
      resolvedOwner.current = null;
      setOpen(true);
      return;
    }
    if (!listingReady || resolvedOwner.current === ownerId) return;
    resolvedOwner.current = ownerId;
    setOpen(!canRestoreDesktopSelection(selection.current, ownerId, window.location.origin, activeVaultId, vaults));
  }, [desktop, ownerId, activeVaultId, vaults, listingReady]);
  return {
    open,
    choose: () => setOpen(true),
    continue: () => { remember(activeVaultId); setOpen(false); },
    remember,
    reset: () => {
      selection.current = null;
      resolvedOwner.current = null;
      try { localStorage.removeItem(DESKTOP_SELECTION_KEY); } catch { /* optional persistence */ }
      setOpen(desktop);
    },
  };
}
