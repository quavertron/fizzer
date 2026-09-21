import { describe, it, expect } from 'vitest';
import { activityKey, attachActivity } from '../activity';
import type { connectVaultSocket } from '../socket';

describe('shared vault activity connection', () => {
  it('uses existing socket, resumes its cursor, and removes its handlers', () => {
    const handlers = new Map<string, (packet?: unknown) => void>();
    const sent: unknown[][] = [];
    const socket = {
      connected: true,
      on: (name: string, callback: (packet?: unknown) => void) => handlers.set(name, callback),
      off: (name: string) => handlers.delete(name),
      emit: (...args: unknown[]) => sent.push(args),
    };
    const detach = attachActivity(socket as unknown as ReturnType<typeof connectVaultSocket>, 'v1', activityKey('v1', 'https://one'));
    expect(sent).toEqual([['awatch:replay', 'v1', {}]]);
    handlers.get('vault:activity')?.({ vaultId: 'v2', events: [], cursor: { epoch: 'wrong', seq: 90 } });
    handlers.get('vault:activity')?.({ vaultId: 'v1', events: [], cursor: { epoch: 'test', seq: 10 } });
    handlers.get('vault:activity')?.({ vaultId: 'v1', events: [], cursor: { epoch: 'test', seq: 5 } });
    handlers.get('disconnect')?.();
    handlers.get('connect')?.();
    expect(sent.at(-1)).toEqual(['awatch:replay', 'v1', { epoch: 'test', seq: 10 }]);
    expect(activityKey('v1', 'https://one')).not.toEqual(activityKey('v1', 'https://two'));
    detach();
    expect(handlers.size).toBe(0);
  });
});
