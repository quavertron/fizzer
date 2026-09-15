import { describe, expect, it } from 'vitest';

import { vaultSelectionConnectorPath, vaultSelectionTargetId } from '../components/Sidebar';

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


describe('vault selection target', () => {
  const folders = [
    { id: 'outer', parent_id: null },
    { id: 'inner', parent_id: 'outer' },
  ];
  const channel = { id: 'chat', folder_id: 'inner', content_preview: 'cascade://chat-channel' };

  it('anchors an open channel to its containing folder even when expanded', () => {
    expect(vaultSelectionTargetId(channel, folders, new Set(['outer', 'inner'])))
      .toBe('folder-inner');
  });

  it('uses the nearest visible folder when ancestors collapse', () => {
    expect(vaultSelectionTargetId(channel, folders, new Set(['outer'])))
      .toBe('folder-inner');
    expect(vaultSelectionTargetId(channel, folders, new Set(['inner'])))
      .toBe('folder-outer');
  });

  it('preserves root channels and ordinary note selection', () => {
    expect(vaultSelectionTargetId({ ...channel, folder_id: null }, folders, new Set()))
      .toBe('note-chat');
    expect(vaultSelectionTargetId({ ...channel, content_preview: 'A note' }, folders, new Set()))
      .toBe('note-chat');
  });

  it('does not loop on malformed folder ancestry', () => {
    expect(vaultSelectionTargetId(channel, [{ id: 'inner', parent_id: 'inner' }], new Set()))
      .toBe('folder-inner');
  });
});
