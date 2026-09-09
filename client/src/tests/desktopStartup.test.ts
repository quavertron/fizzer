import { describe, expect, it } from 'vitest';
import { canRestoreDesktopSelection, readDesktopSelection } from '../desktopStartup';

const selection = { ownerId: '1', origin: 'https://cscd.online', vaultId: 'chosen' };
const vaults = [{ id: 'chosen' }];
describe('desktop selection binding', () => {
  it('restores only an explicit selection with current membership', () => {
    expect(canRestoreDesktopSelection(selection, '1', selection.origin, 'chosen', vaults)).toBe(true);
  });
  it.each([null, '', '{', '{}', '{"ownerId":1,"origin":"https://cscd.online","vaultId":"chosen"}'])('rejects missing, legacy or corrupt selection %s', raw => {
    expect(readDesktopSelection({ getItem: () => raw })).toBeNull();
  });
  it.each([
    ['2', selection.origin, 'chosen', vaults],
    ['1', 'https://other.example', 'chosen', vaults],
    ['1', selection.origin, 'moved', vaults],
    ['1', selection.origin, null, vaults],
    ['1', selection.origin, 'chosen', []],
  ] as const)('refuses changed identity/origin/pointer or deleted vault %#', (owner, origin, active, available) => {
    expect(canRestoreDesktopSelection(selection, owner, origin, active, [...available])).toBe(false);
  });
});
