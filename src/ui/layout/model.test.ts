import { describe, expect, it } from 'vitest';
import {
  closePanel,
  defaultColumnWidth,
  defaultLayout,
  isNoopMove,
  isPanelOpen,
  locatePanel,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  MIN_GROUP_HEIGHT,
  movePanel,
  openPanel,
  parseLayout,
  reconcile,
  resetGroupWeights,
  resizeGroupPair,
  setCollapsed,
  setColumnWidth,
  togglePanel,
  type DockLayout,
  type PanelDefaults,
} from './model';

// The built-in panels' defaults (see panels.tsx), reduced to what the model needs.
const defs: PanelDefaults[] = [
  { id: 'projects', side: 'left', column: 'projects', group: 'projects', order: 10, width: 248, open: false },
  { id: 'library', side: 'left', column: 'library', group: 'library', order: 20, width: 272, open: false },
  { id: 'outliner', side: 'right', column: 'sidebar', group: 'top', order: 30, width: 272, weight: 2 },
  { id: 'item-inputs', side: 'right', column: 'sidebar', group: 'top', order: 31, width: 272, weight: 2 },
  { id: 'properties', side: 'right', column: 'sidebar', group: 'bottom', order: 40, width: 272, weight: 3 },
  { id: 'paint', side: 'right', column: 'sidebar', group: 'bottom', order: 41, width: 272, weight: 3 },
];
const def = (id: string) => defs.find((d) => d.id === id);

/** Columns and groups as panel ids: `[[['a', 'b'], ['c']]]` = one column, two groups. */
const shape = (layout: DockLayout, side: 'left' | 'right') => layout[side].map((c) => c.groups.map((g) => g.panels));

describe('default layout', () => {
  it('reproduces the fixed editor layout', () => {
    const layout = defaultLayout(defs);
    expect(shape(layout, 'left')).toEqual([]);
    expect(shape(layout, 'right')).toEqual([[['outliner', 'item-inputs'], ['properties', 'paint']]]);
    expect(layout.right[0].width).toBe(272);
    expect(layout.right[0].groups.map((g) => g.weight)).toEqual([2, 3]);
    expect(Object.keys(layout.closed).sort()).toEqual(['library', 'projects']);
    expect(layout.known).toEqual(defs.map((d) => d.id));
  });

  it('opens default-closed panels at their default place, each in its own column, in order', () => {
    let layout = defaultLayout(defs);
    layout = openPanel(layout, 'library', def('library'));
    layout = openPanel(layout, 'projects', def('projects'));
    expect(shape(layout, 'left')).toEqual([[['projects']], [['library']]]);
    expect(layout.left.map((c) => c.width)).toEqual([248, 272]);
    expect(layout.closed).toEqual({});
  });
});

describe('open and close', () => {
  it('reopens a closed panel where it was', () => {
    let layout = defaultLayout(defs);
    layout = closePanel(layout, 'outliner');
    expect(isPanelOpen(layout, 'outliner')).toBe(false);
    expect(shape(layout, 'right')).toEqual([[['item-inputs'], ['properties', 'paint']]]);
    layout = openPanel(layout, 'outliner');
    expect(shape(layout, 'right')).toEqual([[['item-inputs', 'outliner'], ['properties', 'paint']]]);
    expect(locatePanel(layout, 'outliner')!.group.active).toBe('outliner');
  });

  it('recreates the group and column of a closed panel when they are gone', () => {
    let layout = defaultLayout(defs);
    layout = closePanel(layout, 'outliner');
    layout = closePanel(layout, 'item-inputs');
    expect(shape(layout, 'right')).toEqual([[['properties', 'paint']]]);
    layout = openPanel(layout, 'outliner');
    expect(shape(layout, 'right')).toEqual([[['outliner'], ['properties', 'paint']]]);
    for (const id of ['outliner', 'properties', 'paint']) layout = closePanel(layout, id);
    expect(layout.right).toEqual([]);
    layout = openPanel(layout, 'properties');
    expect(shape(layout, 'right')).toEqual([[['properties']]]);
    expect(layout.right[0].width).toBe(272);
  });

  it('brings an open panel to the front and expands its group', () => {
    let layout = defaultLayout(defs);
    const bottom = locatePanel(layout, 'paint')!.group.id;
    layout = setCollapsed(layout, bottom, true);
    layout = openPanel(layout, 'paint');
    const at = locatePanel(layout, 'paint')!;
    expect(at.group.active).toBe('paint');
    expect(at.group.collapsed).toBe(false);
  });

  it('toggles', () => {
    let layout = defaultLayout(defs);
    layout = togglePanel(layout, 'projects', def('projects'));
    expect(isPanelOpen(layout, 'projects')).toBe(true);
    layout = togglePanel(layout, 'projects', def('projects'));
    expect(isPanelOpen(layout, 'projects')).toBe(false);
  });

  it('leaves the layout as it is when nothing changes', () => {
    const layout = defaultLayout(defs);
    expect(closePanel(layout, 'projects')).toBe(layout);
    expect(openPanel(layout, 'outliner')).toBe(layout);
    expect(openPanel(layout, 'unknown')).toBe(layout);
  });

  it('never edits the layout it is given', () => {
    const layout = defaultLayout(defs);
    const copy = structuredClone(layout);
    closePanel(layout, 'outliner');
    movePanel(layout, 'properties', { kind: 'column', side: 'left', index: 0 });
    setColumnWidth(layout, 'sidebar', 400);
    expect(layout).toEqual(copy);
  });
});

describe('docking', () => {
  it('moves a panel into another group as a tab', () => {
    let layout = defaultLayout(defs);
    const top = locatePanel(layout, 'outliner')!.group.id;
    layout = movePanel(layout, 'properties', { kind: 'tab', groupId: top });
    expect(shape(layout, 'right')).toEqual([[['outliner', 'item-inputs', 'properties'], ['paint']]]);
    expect(locatePanel(layout, 'properties')!.group.active).toBe('properties');
  });

  it('inserts a tab at a position', () => {
    let layout = defaultLayout(defs);
    const top = locatePanel(layout, 'outliner')!.group.id;
    layout = movePanel(layout, 'paint', { kind: 'tab', groupId: top, index: 0 });
    expect(shape(layout, 'right')[0][0]).toEqual(['paint', 'outliner', 'item-inputs']);
  });

  it('splits a group, sharing its height', () => {
    let layout = defaultLayout(defs);
    const bottom = locatePanel(layout, 'properties')!.group.id;
    layout = movePanel(layout, 'outliner', { kind: 'split', groupId: bottom, edge: 'bottom' });
    expect(shape(layout, 'right')).toEqual([[['item-inputs'], ['properties', 'paint'], ['outliner']]]);
    expect(layout.right[0].groups.map((g) => g.weight)).toEqual([2, 1.5, 1.5]);
    layout = movePanel(layout, 'item-inputs', { kind: 'split', groupId: bottom, edge: 'top' });
    expect(shape(layout, 'right')).toEqual([[['item-inputs'], ['properties', 'paint'], ['outliner']]]);
  });

  it('moves a panel to a new column on the other side', () => {
    let layout = defaultLayout(defs);
    layout = movePanel(layout, 'outliner', { kind: 'column', side: 'left', index: 0 });
    expect(shape(layout, 'left')).toEqual([[['outliner']]]);
    expect(layout.left[0].width).toBe(272);
    expect(shape(layout, 'right')).toEqual([[['item-inputs'], ['properties', 'paint']]]);
  });

  it('keeps column positions when the moved panel leaves its own column empty', () => {
    let layout = defaultLayout(defs);
    layout = openPanel(layout, 'projects', def('projects'));
    layout = openPanel(layout, 'library', def('library'));
    // Library (column 1) to the far left: its own column disappears, the new one comes first.
    layout = movePanel(layout, 'library', { kind: 'column', side: 'left', index: 0 });
    expect(shape(layout, 'left')).toEqual([[['library']], [['projects']]]);
    // Projects (column 1) next to the centre (index 2, past its own column).
    layout = movePanel(layout, 'library', { kind: 'column', side: 'left', index: 2 });
    expect(shape(layout, 'left')).toEqual([[['projects']], [['library']]]);
  });

  it('docks a closed panel directly and forgets its old place', () => {
    let layout = defaultLayout(defs);
    layout = movePanel(layout, 'projects', { kind: 'column', side: 'right', index: 1 }, def('projects'));
    expect(shape(layout, 'right')).toEqual([[['outliner', 'item-inputs'], ['properties', 'paint']], [['projects']]]);
    expect(layout.closed.projects).toBeUndefined();
    expect(layout.right[1].width).toBe(248);
  });

  it('recognises moves that change nothing', () => {
    let layout = defaultLayout(defs);
    layout = openPanel(layout, 'projects', def('projects'));
    const own = locatePanel(layout, 'projects')!.group.id;
    expect(isNoopMove(layout, 'projects', { kind: 'tab', groupId: own })).toBe(true);
    expect(isNoopMove(layout, 'projects', { kind: 'split', groupId: own, edge: 'top' })).toBe(true);
    expect(isNoopMove(layout, 'projects', { kind: 'column', side: 'left', index: 0 })).toBe(true);
    expect(isNoopMove(layout, 'projects', { kind: 'column', side: 'left', index: 1 })).toBe(true);
    expect(isNoopMove(layout, 'projects', { kind: 'column', side: 'right', index: 0 })).toBe(false);
    const top = locatePanel(layout, 'outliner')!.group.id;
    expect(isNoopMove(layout, 'outliner', { kind: 'split', groupId: top, edge: 'top' })).toBe(false);
    expect(movePanel(layout, 'projects', { kind: 'tab', groupId: own })).toBe(layout);
  });

  it('never duplicates or loses a panel', () => {
    let layout = defaultLayout(defs);
    const top = () => locatePanel(layout, 'outliner')!.group.id;
    const steps = [
      () => movePanel(layout, 'properties', { kind: 'tab', groupId: top() }),
      () => movePanel(layout, 'paint', { kind: 'column', side: 'left', index: 0 }),
      () => movePanel(layout, 'outliner', { kind: 'split', groupId: locatePanel(layout, 'paint')!.group.id, edge: 'top' }),
      () => closePanel(layout, 'item-inputs'),
      () => movePanel(layout, 'item-inputs', { kind: 'column', side: 'right', index: 0 }),
      () => openPanel(layout, 'library', def('library')),
    ];
    for (const step of steps) {
      layout = step();
      const placed = (['left', 'right'] as const).flatMap((side) => layout[side].flatMap((c) => c.groups.flatMap((g) => g.panels)));
      expect(new Set(placed).size).toBe(placed.length);
      for (const id of Object.keys(layout.closed)) expect(placed).not.toContain(id);
      expect([...placed, ...Object.keys(layout.closed)].sort()).toEqual(defs.map((d) => d.id).sort());
      for (const side of ['left', 'right'] as const) for (const column of layout[side]) expect(column.groups.length).toBeGreaterThan(0);
    }
  });
});

describe('sizes', () => {
  it('clamps column widths', () => {
    const layout = defaultLayout(defs);
    expect(setColumnWidth(layout, 'sidebar', 10).right[0].width).toBe(MIN_COLUMN_WIDTH);
    expect(setColumnWidth(layout, 'sidebar', 5000).right[0].width).toBe(MAX_COLUMN_WIDTH);
    expect(setColumnWidth(layout, 'sidebar', 333.4).right[0].width).toBe(333);
    expect(setColumnWidth(layout, 'sidebar', 272)).toBe(layout);
    expect(setColumnWidth(layout, 'nope', 300)).toBe(layout);
  });

  it('resizes two groups within their combined weight, keeping a minimum height', () => {
    const layout = defaultLayout(defs);
    const [top, bottom] = layout.right[0].groups.map((g) => g.id);
    const weights = (l: DockLayout) => l.right[0].groups.map((g) => g.weight);
    expect(weights(resizeGroupPair(layout, top, bottom, 250, 500))).toEqual([2.5, 2.5]);
    const [a, b] = weights(resizeGroupPair(layout, top, bottom, 0, 500));
    expect(a / (a + b)).toBeCloseTo(MIN_GROUP_HEIGHT / 500);
    expect(a + b).toBeCloseTo(5);
    const [c] = weights(resizeGroupPair(layout, top, bottom, 900, 500));
    expect(c / 5).toBeCloseTo(1 - MIN_GROUP_HEIGHT / 500);
    // In a column too short for two minimums, each keeps half.
    expect(weights(resizeGroupPair(layout, top, bottom, 0, 100))).toEqual([2.5, 2.5]);
  });

  it('resets widths and heights to the defaults', () => {
    let layout = defaultLayout(defs);
    const [top, bottom] = layout.right[0].groups.map((g) => g.id);
    layout = resizeGroupPair(layout, top, bottom, 100, 500);
    layout = resetGroupWeights(layout, 'sidebar', defs);
    expect(layout.right[0].groups.map((g) => g.weight)).toEqual([2, 3]);
    layout = openPanel(layout, 'projects', def('projects'));
    expect(defaultColumnWidth(layout.left[0], defs)).toBe(248);
    expect(defaultColumnWidth(layout.right[0], defs)).toBe(272);
  });

  it('collapses and expands groups', () => {
    let layout = defaultLayout(defs);
    const top = layout.right[0].groups[0].id;
    layout = setCollapsed(layout, top, true);
    expect(layout.right[0].groups[0].collapsed).toBe(true);
    expect(setCollapsed(layout, top, true)).toBe(layout);
    expect(setCollapsed(layout, top, false).right[0].groups[0].collapsed).toBe(false);
  });
});

describe('persistence', () => {
  it('round-trips through JSON', () => {
    let layout = defaultLayout(defs);
    layout = movePanel(layout, 'outliner', { kind: 'column', side: 'left', index: 0 });
    layout = setColumnWidth(layout, 'sidebar', 320);
    layout = setCollapsed(layout, layout.right[0].groups[0].id, true);
    expect(parseLayout(JSON.parse(JSON.stringify(layout)))).toEqual(layout);
  });

  it('rejects what is not a layout', () => {
    for (const raw of [null, 1, 'x', [], {}, { version: 2, left: [], right: [] }, { version: 1, left: {}, right: [] }]) expect(parseLayout(raw)).toBeNull();
  });

  it('repairs damaged entries instead of failing', () => {
    const layout = parseLayout({
      version: 1,
      left: [{ id: 'c', width: 99999, groups: [{ id: 'g', panels: ['a', 7, 'b'], active: 'zzz', weight: -1 }, { id: 'empty', panels: [] }] }, 'junk'],
      right: [{ id: 'nogroups', groups: [] }],
      closed: { x: { side: 'up' }, y: { side: 'right', columnId: 'c2', groupId: 'g2', columnIndex: -3, groupIndex: 1.5 } },
    })!;
    expect(layout.left).toEqual([{ id: 'c', width: MAX_COLUMN_WIDTH, groups: [{ id: 'g', panels: ['a', 'b'], active: 'a', weight: 1, collapsed: false }] }]);
    expect(layout.right).toEqual([]);
    expect(Object.keys(layout.closed)).toEqual(['y']);
    expect(layout.closed.y.columnIndex).toBe(0);
    expect(layout.known.sort()).toEqual(['a', 'b', 'y']);
  });

  it('places panels registered after the layout was saved, once', () => {
    const old = defaultLayout(defs.filter((d) => d.id !== 'paint' && d.id !== 'library'));
    const history: PanelDefaults = { id: 'history', side: 'right', column: 'sidebar', group: 'history', order: 50, weight: 2 };
    let layout = reconcile(old, [...defs, history]);
    expect(shape(layout, 'right')).toEqual([[['outliner', 'item-inputs'], ['properties', 'paint'], ['history']]]);
    expect(layout.closed.library).toBeDefined();
    // Once known, closing it sticks across reconciles.
    layout = reconcile(closePanel(layout, 'history'), [...defs, history]);
    expect(isPanelOpen(layout, 'history')).toBe(false);
  });

  it('keeps panels that are not registered (yet) and drops duplicates', () => {
    const layout = defaultLayout(defs);
    const damaged = structuredClone(layout);
    damaged.right[0].groups[1].panels.push('outliner', 'from-a-plugin');
    damaged.closed.outliner = damaged.closed.projects;
    const fixed = reconcile(damaged, defs);
    expect(shape(fixed, 'right')).toEqual([[['outliner', 'item-inputs'], ['properties', 'paint', 'from-a-plugin']]]);
    expect(fixed.closed.outliner).toBeUndefined();
  });
});
