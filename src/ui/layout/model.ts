// The dock layout: which panel sits where in the two sidebars, and how big things are.
//
// Pure data and functions (no React, no DOM), so the docking rules can be tested on their own. A
// sidebar is a row of columns; a column is a vertical stack of groups; a group shows its panels as
// tabs. Every operation returns a new layout and leaves the old one untouched.

export type Side = 'left' | 'right';
export const sides: readonly Side[] = ['left', 'right'];

export interface DockGroup {
  id: string;
  /** Panel ids, in tab order. */
  panels: string[];
  /** The panel in front (a tab); falls back to the first visible one when it is not shown. */
  active: string;
  /** Share of the column's height, relative to the other groups (flex-grow). */
  weight: number;
  /** Only the header is shown. */
  collapsed: boolean;
}

export interface DockColumn {
  id: string;
  /** CSS px (before the UI scale). */
  width: number;
  groups: DockGroup[];
}

/** Where a closed panel was, so that reopening puts it back. */
export interface PanelPlace {
  side: Side;
  columnId: string;
  columnIndex: number;
  groupId: string;
  groupIndex: number;
  width: number;
}

export interface DockLayout {
  version: 1;
  /** Columns left to right, on both sides. */
  left: DockColumn[];
  right: DockColumn[];
  /** Places of closed panels. A panel is open if it is in a group, closed if it is here. */
  closed: Record<string, PanelPlace>;
  /** Every panel this layout has heard of; panels registered later get their default place once. */
  known: string[];
}

/** Where a panel goes by default (from the panel registry). */
export interface PanelDefaults {
  id: string;
  side: Side;
  /** Panels with the same column key share a column. */
  column: string;
  /** Panels with the same group key share a group (as tabs). */
  group: string;
  /** Sorts columns (left to right), groups (top to bottom) and tabs by their first panel. */
  order: number;
  /** Width of the column (the widest of its panels wins). */
  width?: number;
  /** Height share of the group (the largest of its panels wins). */
  weight?: number;
  /** Open in the default layout (default: true). */
  open?: boolean;
}

export const MIN_COLUMN_WIDTH = 160;
export const MAX_COLUMN_WIDTH = 720;
export const DEFAULT_COLUMN_WIDTH = 272;
/** CSS px a group keeps when its neighbour is dragged over it (enough for the header and a few rows). */
export const MIN_GROUP_HEIGHT = 72;

export const clampWidth = (width: number): number =>
  Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Number.isFinite(width) ? width : DEFAULT_COLUMN_WIDTH)));

let counter = 0;
/** A fresh id for a group or column made by the user (default ones are named after their key). */
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}${(counter++).toString(36)}`;

// ---- building ----------------------------------------------------------------------------------

/** The default layout of the given panels: what is shown where before the user changes anything. */
export function defaultLayout(defs: readonly PanelDefaults[]): DockLayout {
  const layout: DockLayout = { version: 1, left: [], right: [], closed: {}, known: defs.map((d) => d.id) };
  const sorted = [...defs].sort((a, b) => a.order - b.order);
  for (const def of sorted) {
    const place = defaultPlace(def, layout);
    if (def.open === false) layout.closed[def.id] = place;
    else insertAt(layout, def.id, place, def.weight ?? 1, true);
  }
  return layout;
}

function defaultPlace(def: PanelDefaults, layout: DockLayout): PanelPlace {
  const columns = layout[def.side];
  const columnIndex = columns.findIndex((c) => c.id === def.column);
  return {
    side: def.side,
    columnId: def.column,
    columnIndex: columnIndex < 0 ? columns.length : columnIndex,
    groupId: def.group,
    groupIndex: columnIndex < 0 ? 0 : columns[columnIndex].groups.length,
    width: def.width ?? DEFAULT_COLUMN_WIDTH,
  };
}

/** Puts a panel back at a remembered place: its group if that still exists, else a new group (and column) where it was. */
function insertAt(layout: DockLayout, panelId: string, place: PanelPlace, weight = 1, widen = false): void {
  const columns = layout[place.side];
  let column = columns.find((c) => c.id === place.columnId);
  if (!column) {
    column = { id: place.columnId, width: clampWidth(place.width), groups: [] };
    columns.splice(Math.min(Math.max(0, place.columnIndex), columns.length), 0, column);
  }
  const group = column.groups.find((g) => g.id === place.groupId);
  if (group) {
    group.panels.push(panelId);
    if (widen) {
      // Building the default layout: the group's first panel stays in front.
      group.weight = Math.max(group.weight, weight);
    } else {
      group.active = panelId;
      group.collapsed = false;
    }
  } else {
    column.groups.splice(Math.min(Math.max(0, place.groupIndex), column.groups.length), 0, {
      id: place.groupId,
      panels: [panelId],
      active: panelId,
      weight,
      collapsed: false,
    });
  }
  // A default column is as wide as its widest panel.
  if (widen) column.width = Math.max(column.width, clampWidth(place.width));
}

// ---- reading -----------------------------------------------------------------------------------

export interface PanelLocation {
  side: Side;
  column: DockColumn;
  columnIndex: number;
  group: DockGroup;
  groupIndex: number;
  index: number;
}

export function locatePanel(layout: DockLayout, panelId: string): PanelLocation | null {
  for (const side of sides) {
    const columns = layout[side];
    for (let ci = 0; ci < columns.length; ci++) {
      const groups = columns[ci].groups;
      for (let gi = 0; gi < groups.length; gi++) {
        const index = groups[gi].panels.indexOf(panelId);
        if (index >= 0) return { side, column: columns[ci], columnIndex: ci, group: groups[gi], groupIndex: gi, index };
      }
    }
  }
  return null;
}

export const isPanelOpen = (layout: DockLayout, panelId: string): boolean => locatePanel(layout, panelId) !== null;

export function locateGroup(layout: DockLayout, groupId: string): { side: Side; column: DockColumn; group: DockGroup; groupIndex: number } | null {
  for (const side of sides)
    for (const column of layout[side]) {
      const groupIndex = column.groups.findIndex((g) => g.id === groupId);
      if (groupIndex >= 0) return { side, column, group: column.groups[groupIndex], groupIndex };
    }
  return null;
}

// ---- editing -----------------------------------------------------------------------------------

/** A deep copy to edit (layouts are small). */
const clone = (layout: DockLayout): DockLayout => structuredClone(layout);

/** Drops empty groups and columns and repairs active tabs. */
function tidy(layout: DockLayout): DockLayout {
  for (const side of sides) {
    for (const column of layout[side]) {
      column.groups = column.groups.filter((g) => g.panels.length > 0);
      for (const group of column.groups) if (!group.panels.includes(group.active)) group.active = group.panels[0];
    }
    layout[side] = layout[side].filter((c) => c.groups.length > 0);
  }
  return layout;
}

/** Takes a panel out of its group (in place); returns where it was. */
function detach(layout: DockLayout, panelId: string): PanelPlace | null {
  const at = locatePanel(layout, panelId);
  if (!at) return null;
  at.group.panels.splice(at.index, 1);
  return {
    side: at.side,
    columnId: at.column.id,
    columnIndex: at.columnIndex,
    groupId: at.group.id,
    groupIndex: at.groupIndex,
    width: at.column.width,
  };
}

export function closePanel(layout: DockLayout, panelId: string): DockLayout {
  if (!isPanelOpen(layout, panelId)) return layout;
  const next = clone(layout);
  const place = detach(next, panelId)!;
  next.closed[panelId] = place;
  return tidy(next);
}

/**
 * Opens a panel where it was last (or at its default place), or brings it to the front if it is open
 * already: its tab becomes active and its group expands.
 */
export function openPanel(layout: DockLayout, panelId: string, defaults?: PanelDefaults): DockLayout {
  const at = locatePanel(layout, panelId);
  if (at) {
    if (at.group.active === panelId && !at.group.collapsed) return layout;
    const next = clone(layout);
    const group = locateGroup(next, at.group.id)!.group;
    group.active = panelId;
    group.collapsed = false;
    return next;
  }
  const next = clone(layout);
  const place = next.closed[panelId] ?? (defaults ? defaultPlace(defaults, next) : null);
  if (!place) return layout;
  delete next.closed[panelId];
  if (!next.known.includes(panelId)) next.known.push(panelId);
  insertAt(next, panelId, place, defaults?.weight ?? 1);
  return next;
}

export const togglePanel = (layout: DockLayout, panelId: string, defaults?: PanelDefaults): DockLayout =>
  isPanelOpen(layout, panelId) ? closePanel(layout, panelId) : openPanel(layout, panelId, defaults);

/** Where a dragged panel can be dropped. */
export type DropTarget =
  /** As a tab of a group (at `index`, default: last). */
  | { kind: 'tab'; groupId: string; index?: number }
  /** As a new group above or below a group, splitting its height. */
  | { kind: 'split'; groupId: string; edge: 'top' | 'bottom' }
  /** As a new column at `index` of a sidebar (columns run left to right on both sides). */
  | { kind: 'column'; side: Side; index: number };

export function sameTarget(a: DropTarget | null, b: DropTarget | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Whether dropping the panel there would change anything. */
export function isNoopMove(layout: DockLayout, panelId: string, target: DropTarget): boolean {
  const at = locatePanel(layout, panelId);
  if (!at) return false;
  const alone = at.group.panels.length === 1;
  if (target.kind === 'tab') return target.groupId === at.group.id && (alone || target.index === undefined || target.index === at.index);
  if (target.kind === 'split') return target.groupId === at.group.id && alone;
  // A new column next to its own column, when it is the only panel there already.
  return target.side === at.side && at.column.groups.length === 1 && alone && (target.index === at.columnIndex || target.index === at.columnIndex + 1);
}

/** Moves a panel (open or closed) to a drop target. */
export function movePanel(layout: DockLayout, panelId: string, target: DropTarget, defaults?: PanelDefaults): DockLayout {
  if (isNoopMove(layout, panelId, target)) return layout;
  const next = clone(layout);
  // Resolve the target before detaching: detaching can drop the panel's old group or column.
  const anchorColumn = target.kind === 'column' ? (next[target.side][target.index]?.id ?? null) : null;
  const source = detach(next, panelId);
  delete next.closed[panelId];
  if (!next.known.includes(panelId)) next.known.push(panelId);
  const width = source?.width ?? defaults?.width ?? DEFAULT_COLUMN_WIDTH;

  if (target.kind === 'column') {
    const columns = next[target.side];
    let index = anchorColumn === null ? columns.length : columns.findIndex((c) => c.id === anchorColumn);
    // The anchor was the panel's own column: it will be dropped by `tidy`, so insert before it.
    if (index < 0) index = Math.min(target.index, columns.length);
    const group: DockGroup = { id: uid('g'), panels: [panelId], active: panelId, weight: 1, collapsed: false };
    columns.splice(index, 0, { id: uid('c'), width: clampWidth(width), groups: [group] });
    return tidy(next);
  }

  const found = locateGroup(next, target.groupId);
  if (!found) return layout;
  if (target.kind === 'tab') {
    const panels = found.group.panels;
    panels.splice(Math.min(target.index ?? panels.length, panels.length), 0, panelId);
    found.group.active = panelId;
    found.group.collapsed = false;
  } else {
    const half = found.group.weight / 2;
    found.group.weight = half;
    const group: DockGroup = { id: uid('g'), panels: [panelId], active: panelId, weight: half, collapsed: false };
    found.column.groups.splice(found.groupIndex + (target.edge === 'bottom' ? 1 : 0), 0, group);
  }
  return tidy(next);
}

export function setActivePanel(layout: DockLayout, panelId: string): DockLayout {
  return openPanel(layout, panelId);
}

export function setCollapsed(layout: DockLayout, groupId: string, collapsed: boolean): DockLayout {
  const at = locateGroup(layout, groupId);
  if (!at || at.group.collapsed === collapsed) return layout;
  const next = clone(layout);
  locateGroup(next, groupId)!.group.collapsed = collapsed;
  return next;
}

export function setColumnWidth(layout: DockLayout, columnId: string, width: number): DockLayout {
  const value = clampWidth(width);
  for (const side of sides) {
    const index = layout[side].findIndex((c) => c.id === columnId);
    if (index < 0) continue;
    if (layout[side][index].width === value) return layout;
    const next = clone(layout);
    next[side][index].width = value;
    return next;
  }
  return layout;
}

/**
 * Resizes two neighbouring groups of a column: the first one gets `firstPx` of the `totalPx` both
 * have together, each keeping at least `MIN_GROUP_HEIGHT` (or half of the space, if that is less).
 * Their combined weight stays the same, so the other groups do not move.
 */
export function resizeGroupPair(layout: DockLayout, firstGroupId: string, secondGroupId: string, firstPx: number, totalPx: number): DockLayout {
  const a = locateGroup(layout, firstGroupId);
  const b = locateGroup(layout, secondGroupId);
  if (!a || !b || a.column !== b.column || totalPx <= 0) return layout;
  const min = Math.min(MIN_GROUP_HEIGHT, totalPx / 2);
  const ratio = Math.min(totalPx - min, Math.max(min, firstPx)) / totalPx;
  const sum = a.group.weight + b.group.weight;
  const next = clone(layout);
  locateGroup(next, firstGroupId)!.group.weight = sum * ratio;
  locateGroup(next, secondGroupId)!.group.weight = sum * (1 - ratio);
  return next;
}

/** The width a column had in the default layout (its widest default panel), for double-click resets. */
export function defaultColumnWidth(column: DockColumn, defs: readonly PanelDefaults[]): number {
  const widths = column.groups.flatMap((g) => g.panels).map((id) => defs.find((d) => d.id === id)?.width ?? DEFAULT_COLUMN_WIDTH);
  return clampWidth(Math.max(...widths));
}

/** Resets the heights of a column's groups to the panels' default weights. */
export function resetGroupWeights(layout: DockLayout, columnId: string, defs: readonly PanelDefaults[]): DockLayout {
  const next = clone(layout);
  for (const side of sides)
    for (const column of next[side])
      if (column.id === columnId)
        for (const group of column.groups) group.weight = Math.max(...group.panels.map((id) => defs.find((d) => d.id === id)?.weight ?? 1));
  return next;
}

/**
 * Brings a layout in line with the registered panels: panels it has never seen are put at their
 * default place (or remembered as closed), duplicates are dropped and sizes clamped. Panels it knows
 * but that are not registered (yet) are kept, so a layout survives a build without them.
 */
export function reconcile(layout: DockLayout, defs: readonly PanelDefaults[]): DockLayout {
  let next = clone(layout);
  const seen = new Set<string>();
  for (const side of sides)
    for (const column of next[side]) {
      column.width = clampWidth(column.width);
      for (const group of column.groups) {
        group.panels = group.panels.filter((id) => !seen.has(id) && (seen.add(id), true));
        if (!(group.weight > 0) || !Number.isFinite(group.weight)) group.weight = 1;
      }
    }
  for (const id of seen) delete next.closed[id];
  next = tidy(next);
  for (const def of [...defs].sort((a, b) => a.order - b.order)) {
    if (next.known.includes(def.id)) continue;
    next.known.push(def.id);
    if (seen.has(def.id) || next.closed[def.id]) continue;
    if (def.open === false) next.closed[def.id] = defaultPlace(def, next);
    else next = openPanel(next, def.id, def);
  }
  return next;
}

// ---- persistence -------------------------------------------------------------------------------

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isSide = (value: unknown): value is Side => value === 'left' || value === 'right';

function parseGroup(raw: unknown): DockGroup | null {
  if (!isObject(raw) || !isString(raw.id) || !Array.isArray(raw.panels)) return null;
  const panels = raw.panels.filter(isString);
  if (panels.length === 0) return null;
  return {
    id: raw.id,
    panels,
    active: isString(raw.active) && panels.includes(raw.active) ? raw.active : panels[0],
    weight: typeof raw.weight === 'number' && raw.weight > 0 && Number.isFinite(raw.weight) ? raw.weight : 1,
    collapsed: raw.collapsed === true,
  };
}

function parseColumn(raw: unknown): DockColumn | null {
  if (!isObject(raw) || !isString(raw.id) || !Array.isArray(raw.groups)) return null;
  const groups = raw.groups.map(parseGroup).filter((g): g is DockGroup => g !== null);
  if (groups.length === 0) return null;
  return { id: raw.id, width: clampWidth(typeof raw.width === 'number' ? raw.width : DEFAULT_COLUMN_WIDTH), groups };
}

function parsePlace(raw: unknown): PanelPlace | null {
  if (!isObject(raw) || !isSide(raw.side) || !isString(raw.columnId) || !isString(raw.groupId)) return null;
  const int = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0);
  return {
    side: raw.side,
    columnId: raw.columnId,
    columnIndex: int(raw.columnIndex),
    groupId: raw.groupId,
    groupIndex: int(raw.groupIndex),
    width: clampWidth(typeof raw.width === 'number' ? raw.width : DEFAULT_COLUMN_WIDTH),
  };
}

/** Reads a stored layout; null if it is not one (then the default applies). Never throws. */
export function parseLayout(raw: unknown): DockLayout | null {
  if (!isObject(raw) || raw.version !== 1 || !Array.isArray(raw.left) || !Array.isArray(raw.right)) return null;
  const closed: Record<string, PanelPlace> = {};
  if (isObject(raw.closed))
    for (const [id, value] of Object.entries(raw.closed)) {
      const place = parsePlace(value);
      if (place) closed[id] = place;
    }
  const columns = (list: unknown[]) => list.map(parseColumn).filter((c): c is DockColumn => c !== null);
  const layout: DockLayout = {
    version: 1,
    left: columns(raw.left),
    right: columns(raw.right),
    closed,
    known: Array.isArray(raw.known) ? raw.known.filter(isString) : [],
  };
  // Every panel that is placed or closed is known, whatever the stored list says.
  for (const side of sides) for (const column of layout[side]) for (const group of column.groups) for (const id of group.panels) if (!layout.known.includes(id)) layout.known.push(id);
  for (const id of Object.keys(closed)) if (!layout.known.includes(id)) layout.known.push(id);
  return layout;
}
