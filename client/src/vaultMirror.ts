import type { connectVaultSocket } from './socket';

/** Reuse the chat connection; the main process owns credentials and rclone. */
export function attachVaultMirror(socket: ReturnType<typeof connectVaultSocket>, vaultId: string) {
  const api = (window as unknown as { electronAPI?: {
    requestVaultMirror?: (vaultId: string) => Promise<unknown>;
  } }).electronAPI;
  if (!api?.requestVaultMirror) return () => {};
  const refresh = () => { void api.requestVaultMirror!(vaultId).catch(error => console.error('Vault mirror:', error)); };
  const changed = (data: { vaultId: string }) => { if (data.vaultId === vaultId) refresh(); };
  socket.on('connect', refresh);
  socket.on('vault:filesChanged', changed);
  socket.on('vault:noteChanged', changed);
  socket.on('vault:noteCreated', changed);
  socket.on('vault:noteDeleted', changed);
  if (socket.connected) refresh();
  return () => {
    socket.off('connect', refresh);
    socket.off('vault:filesChanged', changed);
    socket.off('vault:noteChanged', changed);
    socket.off('vault:noteCreated', changed);
    socket.off('vault:noteDeleted', changed);
  };
}
