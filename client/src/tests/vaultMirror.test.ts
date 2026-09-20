import { afterEach, expect, it, vi } from 'vitest';
import { attachVaultMirror } from '../vaultMirror';

afterEach(() => vi.unstubAllGlobals());

it('uses the existing socket for matching changes and reconnect catch-up, then detaches', async () => {
  const request = vi.fn(async () => ({}));
  vi.stubGlobal('window', { electronAPI: { requestVaultMirror: request } });
  const listeners = new Map<string, Set<(data?: unknown) => void>>();
  const socket = {
    connected: true,
    on(name: string, fn: (data?: unknown) => void) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(fn);
    },
    off(name: string, fn: (data?: unknown) => void) { listeners.get(name)?.delete(fn); },
  };
  const emit = (name: string, data?: unknown) => listeners.get(name)?.forEach(fn => fn(data));
  const detach = attachVaultMirror(socket as unknown as Parameters<typeof attachVaultMirror>[0], 'vault-a');
  expect(request).toHaveBeenCalledTimes(1);
  emit('vault:filesChanged', { vaultId: 'vault-b' });
  expect(request).toHaveBeenCalledTimes(1);
  emit('vault:filesChanged', { vaultId: 'vault-a' });
  emit('connect');
  expect(request).toHaveBeenCalledTimes(3);
  expect(request).toHaveBeenLastCalledWith('vault-a');
  detach();
  emit('connect');
  expect(request).toHaveBeenCalledTimes(3);
});
