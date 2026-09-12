import { describe, expect, it, vi } from 'vitest';
import { canRestoreDesktopSelection, readDesktopSelection, rememberDesktopSession, acceptAndOpenRemoteInvite } from '../desktopStartup';

it('continues successful login when desktop session persistence rejects', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await expect(rememberDesktopSession(async () => { throw new Error('EACCES'); })).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledOnce();
  } finally { warning.mockRestore(); }
});

it('opens an accepted invite on its remote server', async () => {
  const openConnection = vi.fn().mockResolvedValue({ success: true });
  const acceptRemoteInvite = vi.fn().mockResolvedValue({ success: true, vault: { id: 'remote-vault' } });
  await acceptAndOpenRemoteInvite({ acceptRemoteInvite, openConnection }, 'https://remote.example/vault-invite/invite');
  expect(openConnection).toHaveBeenCalledWith({ id: 'remote-vault', origin: 'https://remote.example' });
});

it('does not navigate after invite rejection and reports remote open failures', async () => {
  const openConnection = vi.fn().mockResolvedValue({ success: false, error: 'Session expired' });
  const acceptRemoteInvite = vi.fn().mockResolvedValue({ success: false, error: 'Invite expired' });
  const bridge = { acceptRemoteInvite, openConnection };
  await expect(acceptAndOpenRemoteInvite(bridge, 'https://remote.example/vault-invite/i')).rejects.toThrow('Invite expired');
  expect(openConnection).not.toHaveBeenCalled();
  acceptRemoteInvite.mockResolvedValue({ success: true, vault: { id: 'vault' } });
  await expect(acceptAndOpenRemoteInvite(bridge, 'https://remote.example/vault-invite/i')).rejects.toThrow('Session expired');
});

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
