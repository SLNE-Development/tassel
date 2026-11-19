import { describe, expect, it } from 'vitest';
import { dropAt, type DockGeometry } from './dropZones';

// A 1000×600 window: one left column (0–250), the centre (250–728), one right column (728–1000) with two groups.
const geometry: DockGeometry = {
  columns: [
    { id: 'L', side: 'left', index: 0, rect: { left: 0, top: 0, width: 250, height: 600 } },
    { id: 'R', side: 'right', index: 0, rect: { left: 728, top: 0, width: 272, height: 600 } },
  ],
  groups: [
    { id: 'l1', columnId: 'L', rect: { left: 0, top: 0, width: 250, height: 600 } },
    { id: 'top', columnId: 'R', rect: { left: 728, top: 0, width: 272, height: 240 } },
    { id: 'bottom', columnId: 'R', rect: { left: 728, top: 240, width: 272, height: 360 } },
  ],
  centre: { left: 250, top: 0, width: 478, height: 600 },
  columnCount: { left: 1, right: 1 },
};

const target = (x: number, y: number) => dropAt(x, y, geometry)?.target ?? null;

describe('drop zones', () => {
  it('adds a tab in the middle of a group', () => {
    expect(target(860, 120)).toEqual({ kind: 'tab', groupId: 'top' });
    expect(target(860, 420)).toEqual({ kind: 'tab', groupId: 'bottom' });
  });

  it('splits near the top and bottom of a group', () => {
    expect(target(860, 10)).toEqual({ kind: 'split', groupId: 'top', edge: 'top' });
    expect(target(860, 230)).toEqual({ kind: 'split', groupId: 'top', edge: 'bottom' });
    expect(target(860, 250)).toEqual({ kind: 'split', groupId: 'bottom', edge: 'top' });
    expect(target(860, 590)).toEqual({ kind: 'split', groupId: 'bottom', edge: 'bottom' });
  });

  it('makes a new column at the sides of a column', () => {
    expect(target(5, 300)).toEqual({ kind: 'column', side: 'left', index: 0 });
    expect(target(245, 300)).toEqual({ kind: 'column', side: 'left', index: 1 });
    expect(target(732, 300)).toEqual({ kind: 'column', side: 'right', index: 0 });
    expect(target(995, 300)).toEqual({ kind: 'column', side: 'right', index: 1 });
  });

  it('docks into a sidebar from the edges of the centre', () => {
    expect(target(260, 300)).toEqual({ kind: 'column', side: 'left', index: 1 });
    expect(target(720, 300)).toEqual({ kind: 'column', side: 'right', index: 0 });
    expect(target(490, 300)).toBeNull();
  });

  it('works with empty sidebars', () => {
    const empty: DockGeometry = { columns: [], groups: [], centre: { left: 44, top: 0, width: 956, height: 600 }, columnCount: { left: 0, right: 0 } };
    expect(dropAt(50, 300, empty)?.target).toEqual({ kind: 'column', side: 'left', index: 0 });
    expect(dropAt(990, 300, empty)?.target).toEqual({ kind: 'column', side: 'right', index: 0 });
    expect(dropAt(10, 300, empty)).toBeNull();
  });

  it('highlights the area that the panel will take', () => {
    expect(dropAt(860, 10, geometry)?.highlight).toEqual({ left: 728, top: 0, width: 272, height: 120 });
    expect(dropAt(860, 420, geometry)?.highlight).toEqual(geometry.groups[2].rect);
  });
});
