import type { AwatchEvent } from './activity';
export type ChangeCounts = { adds: number; moves: number; mods: number; dels: number };
export type Analysis = { lines?: string[]; counts?: ChangeCounts; detail?: string; error?: string };
export const emptyCounts = (): ChangeCounts => ({ adds: 0, moves: 0, mods: 0, dels: 0 });
const cache = new WeakMap<AwatchEvent, Promise<Analysis>>();
// Presentation adapter only; the Go engine owns alignment and classification.
export function eventDiff(event: AwatchEvent): Promise<Analysis> {
  let result = cache.get(event);
  if (!result) {
    const api = (window as unknown as { electronAPI?: { analyzeAwatch?: (input: unknown) => Promise<Analysis> } }).electronAPI;
    result = api?.analyzeAwatch
      ? api.analyzeAwatch({ ...event, old_lines: event.old_lines || [], new_lines: event.new_lines || [] }).catch(error => ({ error: String(error.message || error) }))
      : Promise.resolve({ error: 'Diff analysis requires the desktop Awatch Go engine.' });
    cache.set(event, result);
  }
  return result;
}
