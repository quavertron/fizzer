import { useSyncExternalStore } from 'react';
import type { connectVaultSocket } from './socket';

export type AwatchEvent = {
  id: string; kind: string; agent: string; author?: string; conflict_agent?: string;
  result?: string; tool?: string; detail?: string; file: string;
  conflict_line_start?: number; conflict_line_end?: number;
  line_start?: number; line_end?: number; old_lines?: string[]; new_lines?: string[];
  timestamp: number; truncated?: boolean;
};
export type ActivityPacket = { vaultId: string; events: AwatchEvent[]; cursor?: { epoch: string; seq: number }; gap?: boolean; status?: string };
const empty = { events: [] as AwatchEvent[], connected: false, status: 'Connecting to activity…', gap: '' };
type Snapshot = typeof empty;
type Feed = { snapshot: Snapshot; cursor?: ActivityPacket['cursor']; listeners: Set<() => void> };
const feeds = new Map<string, Feed>();
export const activityKey = (vaultId: string, origin = '') => JSON.stringify([origin.replace(/\/+$/, ''), vaultId]);
function feed(key: string): Feed {
  let value = feeds.get(key);
  if (!value) { value = { snapshot: empty, listeners: new Set() }; feeds.set(key, value); }
  return value;
}
function update(value: Feed, change: Partial<Snapshot>) {
  value.snapshot = { ...value.snapshot, ...change };
  value.listeners.forEach(listener => listener());
}
export function attachActivity(socket: ReturnType<typeof connectVaultSocket>, vaultId: string, key: string) {
  const value = feed(key);
  const connect = () => {
    update(value, { connected: false, status: 'Waiting for the server activity feed…' });
    socket.emit('awatch:replay', vaultId, value.cursor || {});
  };
  const disconnect = () => update(value, { connected: false, status: 'Reconnecting to activity…' });
  const receive = (packet: ActivityPacket) => {
    if (packet.vaultId !== vaultId) return;
    const seen = new Set(value.snapshot.events.map(event => event.id));
    const events = [...value.snapshot.events];
    for (const event of packet.events || []) {
      if (!seen.has(event.id)) { events.push(event); seen.add(event.id); }
    }
    const epoch = packet.cursor?.epoch;
    if (epoch) events.sort((a, b) => {
      const aCurrent = a.id.startsWith(epoch + ':'), bCurrent = b.id.startsWith(epoch + ':');
      if (aCurrent && bCurrent) return Number(a.id.slice(epoch.length + 1)) - Number(b.id.slice(epoch.length + 1));
      return Number(aCurrent) - Number(bCurrent);
    });
    let bytes = 0;
    const retained: AwatchEvent[] = [];
    for (const event of events.slice(-500).reverse()) {
      bytes += JSON.stringify(event).length * 2;
      if (bytes > 16 * 1024 * 1024) break;
      retained.push(event);
    }
    if (packet.cursor && (packet.cursor.epoch !== value.cursor?.epoch || packet.cursor.seq >= value.cursor.seq)) value.cursor = packet.cursor;
    update(value, { connected: !packet.status, events: retained.reverse(), status: packet.status || '', ...(packet.gap ? { gap: 'Some older activity could not be replayed.' } : {}) });
  };
  socket.on('vault:activity', receive);
  socket.on('connect', connect);
  socket.on('disconnect', disconnect);
  if (socket.connected) connect();
  return () => {
    socket.off('vault:activity', receive);
    socket.off('connect', connect);
    socket.off('disconnect', disconnect);
    value.cursor = undefined;
    update(value, empty);
    feeds.delete(key);
  };
}
export function useActivity(key: string) {
  const value = feed(key);
  return useSyncExternalStore(listener => { value.listeners.add(listener); return () => { value.listeners.delete(listener); }; }, () => value.snapshot);
}
