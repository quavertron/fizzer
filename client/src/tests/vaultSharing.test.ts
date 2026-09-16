import { describe, expect, it } from 'vitest';
import { vaultDetailsLabel, type Vault } from '../api';
import { vaultOptionLabel } from '../components/Sidebar';

const vault = (overrides: Partial<Vault> = {}): Vault => ({
  id: 'v1',
  name: 'Team notes',
  root_path: '/tmp/v1',
  created_at: '2026-01-01 00:00:00',
  ...overrides,
});

describe('vault privacy labels', () => {
  it('never labels a public single-member vault private', () => {
    expect(vaultDetailsLabel(vault({ visibility: 'public', memberCount: 1, role: 'owner' }))).toBe('Public · 1 member · owner');
  });
  it('keeps private visibility separate from collaboration', () => {
    expect(vaultDetailsLabel(vault({ visibility: 'private', memberCount: 3, role: 'viewer' }))).toBe('Private · 3 members · viewer');
  });

  it('keeps unknown fields explicit for newly created vaults', () => {
    expect(vaultOptionLabel(vault())).toBe('Team notes · Visibility unknown · Member count unknown · Role unknown');
  });
});
