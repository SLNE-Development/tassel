import type { DropTarget, Side } from './model';

// Where a panel dragged by its header lands, from what is under the pointer. Pure geometry, so it is
// tested on its own; the dock measures the elements and draws the returned highlight.

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface GroupBox {
  id: string;
  columnId: string;
  rect: Rect;
}

export interface ColumnBox {
  id: string;
  side: Side;
  /** Position in its sidebar (left to right). */
  index: number;
  rect: Rect;
}

export interface DockGeometry {
  groups: readonly GroupBox[];
  columns: readonly ColumnBox[];
  /** The centre (viewport): its left and right strips open a new column on that side. */
  centre: Rect;
  /** Number of columns per side (a new column next to the centre goes to the end of the left side and the start of the right one). */
  columnCount: Record<Side, number>;
}

export interface Drop {
  target: DropTarget;
  /** What to highlight (viewport px). */
  highlight: Rect;
}

/** Width of the strips at a column's sides that make a new column rather than a tab. */
export const COLUMN_EDGE = 28;
/** Width of the strips at the centre's sides that dock into that sidebar. */
export const CENTRE_EDGE = 72;
/** Share of a group's height at its top and bottom that splits it rather than adding a tab. */
export const SPLIT_SHARE = 0.28;

const inside = (r: Rect, x: number, y: number) => x >= r.left && x < r.left + r.width && y >= r.top && y < r.top + r.height;

export function dropAt(x: number, y: number, geometry: DockGeometry): Drop | null {
  for (const column of geometry.columns) {
    const r = column.rect;
    if (!inside(r, x, y)) continue;
    const edge = Math.min(COLUMN_EDGE, r.width / 4);
    if (x < r.left + edge)
      return { target: { kind: 'column', side: column.side, index: column.index }, highlight: { ...r, width: Math.min(r.width / 2, 2 * COLUMN_EDGE) } };
    if (x >= r.left + r.width - edge) {
      const width = Math.min(r.width / 2, 2 * COLUMN_EDGE);
      return { target: { kind: 'column', side: column.side, index: column.index + 1 }, highlight: { ...r, left: r.left + r.width - width, width } };
    }
    const group = geometry.groups.find((g) => g.columnId === column.id && inside(g.rect, x, y));
    if (!group) return null;
    const g = group.rect;
    const band = Math.min(g.height * SPLIT_SHARE, 96);
    if (y < g.top + band) return { target: { kind: 'split', groupId: group.id, edge: 'top' }, highlight: { ...g, height: g.height / 2 } };
    if (y >= g.top + g.height - band)
      return { target: { kind: 'split', groupId: group.id, edge: 'bottom' }, highlight: { ...g, top: g.top + g.height / 2, height: g.height / 2 } };
    return { target: { kind: 'tab', groupId: group.id }, highlight: g };
  }
  const c = geometry.centre;
  if (inside(c, x, y)) {
    const edge = Math.min(CENTRE_EDGE, c.width / 4);
    if (x < c.left + edge) return { target: { kind: 'column', side: 'left', index: geometry.columnCount.left }, highlight: { ...c, width: edge } };
    if (x >= c.left + c.width - edge) return { target: { kind: 'column', side: 'right', index: 0 }, highlight: { ...c, left: c.left + c.width - edge, width: edge } };
  }
  return null;
}
