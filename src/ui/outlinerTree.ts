// Pure helpers for the outliner tree: the visible rows and what a drag-and-drop means for the document.
import { groupWithDescendants, objectsInGroup } from '../core/groups';
import type { DocState } from '../core/types';

export type RowKind = 'group' | 'object';

export interface RowRef {
  kind: RowKind;
  id: string;
}

export interface TreeRow extends RowRef {
  depth: number;
}

type TreeState = Pick<DocState, 'objects' | 'order' | 'groups' | 'groupOrder'>;

/**
 * The rows of the outliner from top to bottom: per level first the groups (each followed by its
 * contents unless collapsed), then the objects.
 */
export function buildRows(state: TreeState, collapsed: Readonly<Record<string, boolean>>): TreeRow[] {
  const childGroups = new Map<string | null, string[]>();
  for (const id of state.groupOrder) {
    const parent = state.groups[id].parentId;
    const list = childGroups.get(parent);
    if (list) list.push(id);
    else childGroups.set(parent, [id]);
  }
  const childObjects = new Map<string | null, string[]>();
  for (const id of state.order) {
    const parent = state.objects[id].groupId;
    const list = childObjects.get(parent);
    if (list) list.push(id);
    else childObjects.set(parent, [id]);
  }
  const rows: TreeRow[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const id of childGroups.get(parent) ?? []) {
      rows.push({ kind: 'group', id, depth });
      if (!collapsed[id]) walk(id, depth + 1);
    }
    for (const id of childObjects.get(parent) ?? []) rows.push({ kind: 'object', id, depth });
  };
  walk(null, 0);
  return rows;
}

/** Rows as primitive keys ("g:id:depth" / "o:id:depth"), so that a shallow comparison detects changes. */
export const rowKey = (row: TreeRow): string => `${row.kind === 'group' ? 'g' : 'o'}:${row.id}:${row.depth}`;

export function parseRowKey(key: string): TreeRow {
  const [kind, id, depth] = key.split(':');
  return { kind: kind === 'g' ? 'group' : 'object', id, depth: Number(depth) };
}

export type Coverage = 'none' | 'some' | 'all';

const coverage = (hits: number, total: number): Coverage => (hits === 0 ? 'none' : hits === total ? 'all' : 'some');

/** What a group row shows about its objects (nested ones included). */
export function groupSummary(state: DocState, id: string): { count: number; selected: Coverage; visible: Coverage } {
  const ids = objectsInGroup(state, id);
  const selection = new Set(state.selection);
  return {
    count: ids.length,
    selected: coverage(ids.filter((o) => selection.has(o)).length, ids.length),
    visible: coverage(ids.filter((o) => state.objects[o].visible).length, ids.length),
  };
}

/** The group and its ancestors, innermost first. */
export function groupPath(state: Pick<DocState, 'groups'>, id: string | null): string[] {
  const path: string[] = [];
  for (let current = id; current !== null && state.groups[current]; current = state.groups[current].parentId) path.push(current);
  return path;
}

export interface Payload {
  objectIds: string[];
  groupIds: string[];
}

/**
 * What dragging a row moves. An unselected row moves alone. A selected object row moves all selected
 * objects. A selected group row moves every fully selected group as a whole (the outermost ones) plus
 * the selected objects outside of them.
 */
export function dragPayload(state: DocState, row: RowRef): Payload {
  const selection = new Set(state.selection);
  if (row.kind === 'object') {
    return { objectIds: selection.has(row.id) ? state.order.filter((id) => selection.has(id)) : [row.id], groupIds: [] };
  }
  const full = (id: string) => {
    const ids = objectsInGroup(state, id);
    return ids.length > 0 && ids.every((o) => selection.has(o));
  };
  if (!full(row.id)) return { objectIds: [], groupIds: [row.id] };
  const fullGroups = new Set(state.groupOrder.filter(full));
  const groupIds = state.groupOrder.filter((id) => {
    const parent = state.groups[id].parentId;
    return fullGroups.has(id) && (parent === null || !fullGroups.has(parent));
  });
  const covered = new Set(groupIds.flatMap((id) => objectsInGroup(state, id)));
  return { objectIds: state.order.filter((id) => selection.has(id) && !covered.has(id)), groupIds };
}

/** Where the pointer is: on a row (`part` = which third / half of it), or on the empty area below the rows. */
export type DropPosition = { row: TreeRow; part: 'before' | 'into' | 'after' } | null;

export type Drop =
  /** Into a group (or to top level), at the end. */
  | { kind: 'into'; targetGroupId: string | null }
  /** Between rows: in front of `row` or behind it, among the siblings of its kind. */
  | { kind: 'line'; row: TreeRow; after: boolean; targetGroupId: string | null; index: number };

export interface DropResult {
  drop: Drop;
  /** False for a group dropped into itself or one of its descendants. */
  valid: boolean;
  /** False if the drop would leave everything where it is. */
  changes: boolean;
}

const parentOf = (state: TreeState, row: RowRef): string | null =>
  row.kind === 'group' ? state.groups[row.id].parentId : state.objects[row.id].groupId;

/** Turns a pointer position into the `group.move` it stands for. */
export function resolveDrop(state: TreeState, payload: Payload, position: DropPosition): DropResult {
  const check = (drop: Drop, changes: boolean): DropResult => {
    const target = drop.targetGroupId;
    const valid = target === null || !payload.groupIds.some((id) => groupWithDescendants(state, id).has(target));
    return { drop, valid, changes };
  };
  const into = (targetGroupId: string | null): DropResult =>
    check(
      { kind: 'into', targetGroupId },
      payload.objectIds.some((id) => state.objects[id].groupId !== targetGroupId) ||
        payload.groupIds.some((id) => state.groups[id].parentId !== targetGroupId),
    );

  if (!position) return into(null);
  const { row, part } = position;
  if (row.kind === 'group' && part === 'into') return into(row.id);

  const parent = parentOf(state, row);
  // Reordering works within one kind; anything else just moves into the row's parent.
  const moved = row.kind === 'group' ? payload.groupIds : payload.objectIds;
  const others = row.kind === 'group' ? payload.objectIds : payload.groupIds;
  if (moved.length === 0 || others.length > 0) return into(parent);

  const siblings =
    row.kind === 'group'
      ? state.groupOrder.filter((id) => state.groups[id].parentId === parent)
      : state.order.filter((id) => state.objects[id].groupId === parent);
  const movedSet = new Set(moved);
  const slot = siblings.indexOf(row.id) + (part === 'after' ? 1 : 0);
  const index = siblings.slice(0, slot).filter((id) => !movedSet.has(id)).length;
  const rest = siblings.filter((id) => !movedSet.has(id));
  const next = [...rest.slice(0, index), ...moved, ...rest.slice(index)];
  const changes = next.length !== siblings.length || next.some((id, i) => id !== siblings[i]);
  return check({ kind: 'line', row, after: part === 'after', targetGroupId: parent, index }, changes);
}
