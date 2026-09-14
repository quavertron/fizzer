import { describe, expect, it } from 'vitest';

import { vaultSelectionConnectorPath } from '../components/Sidebar';

describe('vault selection connector', () => {
  it('builds one closed ribbon in sidebar-local coordinates', () => {
    expect(vaultSelectionConnectorPath(
      { left: 10, right: 310, top: 20, bottom: 620 },
      { left: 16, right: 60, top: 40, bottom: 76 },
      { left: 86, right: 300, top: 110, bottom: 142 },
    )).toBe(
      'M 50 20 C 63 20, 63 90, 76 90 L 76 122 C 63 122, 63 56, 50 56 Z',
    );
  });
});
