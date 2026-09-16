import { describe, expect, it } from 'vitest';

import { vaultSelectionConnectorPath, vaultSelectionTargetId } from '../components/Sidebar';

describe('vault selection connector', () => {
  it('builds one closed ribbon in sidebar-local coordinates', () => {
    expect(vaultSelectionConnectorPath(
      { left: 10, right: 310, top: 20, bottom: 620 },
      { left: 16, right: 60, top: 40, bottom: 76 },
      { left: 86, right: 300, top: 110, bottom: 142 },
    )).toBe(
      'M 47 20 L 50 20 C 73.8 20, 63 90, 76 90 L 76 122 C 63 122, 73.8 56, 50 56 L 47 56 Z',
    );
  });

  it('keeps an above-target ribbon broad while preserving both attachments', () => {
    const path = vaultSelectionConnectorPath(
      { left: 10, right: 310, top: 20, bottom: 620 },
      { left: 16, right: 60, top: 130, bottom: 166 },
      { left: 86, right: 300, top: 40, bottom: 72 },
    );
    const points = path.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    const [underpaintX, underpaintTop, startX, startTop, firstControlX, , landingControlX, , endX, endTop,
      lineEndX, endBottom, returnControlX, , returnOuterControlX, , returnEndX, startBottom] = points;
    expect([underpaintX, underpaintTop]).toEqual([startX - 3, startTop]);
    const horizontalRun = endX - startX;

    expect([startX, startTop, endX, endTop, lineEndX, endBottom, returnEndX, startBottom])
      .toEqual([50, 110, 76, 20, 76, 52, 50, 146]);
    expect(firstControlX - startX).toBeLessThanOrEqual(horizontalRun);
    expect(firstControlX - startX).toBeLessThanOrEqual(64);
    expect(endX - landingControlX).toBeGreaterThan(0);
    expect(endX - landingControlX).toBeLessThanOrEqual(16);
    expect(returnControlX).toBe(landingControlX);
    expect(returnOuterControlX).toBe(firstControlX);
  });
});


describe('steep ribbon nonintersection regression', () => {
  for (const offset of [-500, -200, -150, 150, 200, 500]) {
    it(`never reverses horizontal direction or crosses edges at offset ${offset}`, () => {
      const path = vaultSelectionConnectorPath(
        { left: 0, right: 310, top: 0, bottom: 1000 },
        { left: 16, right: 60, top: 300, bottom: 336 },
        { left: 86, right: 300, top: 300 + offset, bottom: 332 + offset },
      );
      const p = path.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
      const [, , x0, y0, x1, , x2, y2, x3, y3, , bottom3, , , , bottom0] = p;
      expect(x1).toBeGreaterThanOrEqual(x0);
      expect(x1).toBeLessThanOrEqual(x3);
      expect(x2).toBeGreaterThanOrEqual(x0);
      expect(x2).toBeLessThanOrEqual(x3);
      let priorX = x0;
      for (let i = 1; i <= 1000; i++) {
        const t = i / 1000, u = 1 - t;
        const x = u ** 3 * x0 + 3 * u ** 2 * t * x1 + 3 * u * t ** 2 * x2 + t ** 3 * x3;
        // Both edges share strictly monotone x and positive vertical separation,
        // so they cannot self-intersect or intersect one another.
        expect(x).toBeGreaterThan(priorX);
        priorX = x;
        const top = (u ** 3 + 3 * u ** 2 * t) * y0 + (3 * u * t ** 2 + t ** 3) * y2;
        const bottom = (u ** 3 + 3 * u ** 2 * t) * bottom0 + (3 * u * t ** 2 + t ** 3) * bottom3;
        expect(bottom).toBeGreaterThan(top);
      }
      expect(y2).toBe(y3);
    });
  }
});

describe('vault selection target', () => {
  const folders = [
    { id: 'outer', parent_id: null },
    { id: 'inner', parent_id: 'outer' },
  ];
  const channel = { id: 'chat', folder_id: 'inner', content_preview: 'cascade://chat-channel' };

  it('anchors an open channel to its own visible row when expanded', () => {
    expect(vaultSelectionTargetId(channel, folders, new Set(['outer', 'inner'])))
      .toBe('note-chat');
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
    expect(vaultSelectionTargetId({ ...channel, content_preview: 'A note' }, folders, new Set(['outer', 'inner'])))
      .toBe('note-chat');
  });

  it('does not loop on malformed folder ancestry', () => {
    expect(vaultSelectionTargetId(channel, [{ id: 'inner', parent_id: 'inner' }], new Set()))
      .toBe('folder-inner');
  });
});
