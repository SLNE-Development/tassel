import { z } from 'zod';
import { groupWithDescendants, objectsInGroup } from '../groups';
import { newId, uniqueName } from '../state';
import type { DocState, Group } from '../types';
import { defineCommand, docState, updateDocState } from './registry';

function requireGroup(state: DocState, id: string): Group {
  const group = state.groups[id];
  if (!group) throw new Error(`Group "${id}" does not exist`);
  return group;
}

function requireObjects(state: DocState, ids: readonly string[]): void {
  for (const id of ids) if (!state.objects[id]) throw new Error(`Object "${id}" does not exist`);
}

function groupNames(state: DocState, exceptId?: string): string[] {
  return Object.values(state.groups)
    .filter((g) => g.id !== exceptId)
    .map((g) => g.name);
}

/**
 * Takes `moved` out of `list` and puts it back in front of the `index`-th remaining sibling, or
 * at the end of the list if there is no such sibling.
 */
function reorder(
  list: readonly string[],
  moved: readonly string[],
  isSibling: (id: string) => boolean,
  index: number | undefined,
): string[] {
  const movedSet = new Set(moved);
  const rest = list.filter((id) => !movedSet.has(id));
  const before = index === undefined ? undefined : rest.filter(isSibling)[index];
  const at = before === undefined ? rest.length : rest.indexOf(before);
  return [...rest.slice(0, at), ...moved, ...rest.slice(at)];
}

export const groupCommands = [
  defineCommand({
    id: 'group.create',
    title: 'Gruppieren',
    description:
      'Create a group and move objects into it. A group is an organisational folder without a transform of its own; groups can be nested, and group.select selects everything inside one so that the usual object commands act on all of it. ids defaults to the current selection and may be empty (creates an empty group). Without parentId the group is created inside the group that all given objects share, otherwise at top level. Names are made unique among all groups. Returns the new group id.',
    params: z.object({
      ids: z.array(z.string()).optional().describe('Object ids to put into the group. Defaults to the current selection.'),
      name: z.string().min(1).default('Gruppe'),
      parentId: z.string().nullable().optional().describe('Group to nest the new group in, null for top level.'),
    }),
    run(ctx, p) {
      const state = docState(ctx);
      const ids = [...new Set(p.ids ?? state.selection)];
      requireObjects(state, ids);
      let parentId: string | null;
      if (p.parentId !== undefined) {
        if (p.parentId !== null) requireGroup(state, p.parentId);
        parentId = p.parentId;
      } else {
        const shared = ids.length > 0 ? state.objects[ids[0]].groupId : null;
        parentId = ids.every((id) => state.objects[id].groupId === shared) ? shared : null;
      }
      const group: Group = { id: newId(), name: uniqueName(groupNames(state), p.name), parentId };
      updateDocState(ctx, (s) => {
        const objects = { ...s.objects };
        for (const id of ids) objects[id] = { ...objects[id], groupId: group.id };
        return { ...s, objects, groups: { ...s.groups, [group.id]: group }, groupOrder: [...s.groupOrder, group.id] };
      });
      return { id: group.id, name: group.name };
    },
  }),

  defineCommand({
    id: 'group.ungroup',
    title: 'Gruppierung aufheben',
    description:
      'Dissolve a group: its objects and child groups move up to its parent group (or to top level) and the group itself is removed. Nothing inside is deleted.',
    params: z.object({ id: z.string() }),
    run(ctx, p) {
      const { parentId } = requireGroup(docState(ctx), p.id);
      updateDocState(ctx, (s) => {
        const objects = { ...s.objects };
        for (const obj of Object.values(s.objects)) if (obj.groupId === p.id) objects[obj.id] = { ...obj, groupId: parentId };
        const groups = { ...s.groups };
        for (const g of Object.values(s.groups)) if (g.parentId === p.id) groups[g.id] = { ...g, parentId };
        delete groups[p.id];
        return { ...s, objects, groups, groupOrder: s.groupOrder.filter((id) => id !== p.id) };
      });
    },
  }),

  defineCommand({
    id: 'group.delete',
    title: 'Gruppe löschen',
    description:
      'Delete a group together with all groups nested in it and all objects inside. Use group.ungroup to remove only the group and keep its contents.',
    params: z.object({ id: z.string() }),
    run(ctx, p) {
      const state = docState(ctx);
      requireGroup(state, p.id);
      const goneGroups = groupWithDescendants(state, p.id);
      const goneObjects = new Set(objectsInGroup(state, p.id));
      updateDocState(ctx, (s) => {
        const objects = { ...s.objects };
        goneObjects.forEach((id) => delete objects[id]);
        const groups = { ...s.groups };
        goneGroups.forEach((id) => delete groups[id]);
        const selection = s.selection.filter((id) => !goneObjects.has(id));
        return {
          ...s,
          objects,
          order: s.order.filter((id) => !goneObjects.has(id)),
          groups,
          groupOrder: s.groupOrder.filter((id) => !goneGroups.has(id)),
          selection,
          activeId: s.activeId && !goneObjects.has(s.activeId) ? s.activeId : (selection.at(-1) ?? null),
        };
      });
      return { deletedGroups: [...goneGroups], deletedObjects: [...goneObjects] };
    },
  }),

  defineCommand({
    id: 'group.rename',
    title: 'Gruppe umbenennen',
    description: 'Rename a group. Names are made unique among all groups by appending .001, .002, ...',
    params: z.object({ id: z.string(), name: z.string().min(1) }),
    run(ctx, p) {
      const state = docState(ctx);
      requireGroup(state, p.id);
      const name = uniqueName(groupNames(state, p.id), p.name);
      updateDocState(ctx, (s) => ({ ...s, groups: { ...s.groups, [p.id]: { ...s.groups[p.id], name } } }));
      return { id: p.id, name };
    },
  }),

  defineCommand({
    id: 'group.move',
    title: 'In Gruppe verschieben',
    description:
      'Move objects and/or groups into a group (targetGroupId) or to top level (targetGroupId null). Also used to reorder: index is the position among the siblings of the same kind in the target (objects among its objects, groups among its child groups), counted without the moved items; default is the end. Several moved items keep the order in which they are given. A group cannot be moved into itself or into a group nested inside it.',
    params: z.object({
      objectIds: z.array(z.string()).default([]),
      groupIds: z.array(z.string()).default([]),
      targetGroupId: z.string().nullable(),
      index: z.number().int().min(0).optional(),
    }),
    run(ctx, p) {
      const state = docState(ctx);
      const objectIds = [...new Set(p.objectIds)];
      const groupIds = [...new Set(p.groupIds)];
      const target = p.targetGroupId;
      if (objectIds.length + groupIds.length === 0) throw new Error('Nothing to move: give objectIds and/or groupIds');
      requireObjects(state, objectIds);
      groupIds.forEach((id) => requireGroup(state, id));
      if (target !== null) {
        requireGroup(state, target);
        for (const id of groupIds) {
          if (groupWithDescendants(state, id).has(target)) {
            throw new Error(
              id === target
                ? `Group "${id}" cannot be moved into itself`
                : `Group "${id}" cannot be moved into "${target}", which is nested inside it`,
            );
          }
        }
      }
      updateDocState(ctx, (s) => {
        const objects = { ...s.objects };
        for (const id of objectIds) if (objects[id].groupId !== target) objects[id] = { ...objects[id], groupId: target };
        const groups = { ...s.groups };
        for (const id of groupIds) if (groups[id].parentId !== target) groups[id] = { ...groups[id], parentId: target };
        return {
          ...s,
          objects,
          order: objectIds.length > 0 ? reorder(s.order, objectIds, (id) => s.objects[id].groupId === target, p.index) : s.order,
          groups,
          groupOrder:
            groupIds.length > 0 ? reorder(s.groupOrder, groupIds, (id) => s.groups[id].parentId === target, p.index) : s.groupOrder,
        };
      });
    },
  }),

  defineCommand({
    id: 'group.select',
    title: 'Gruppe auswählen',
    description:
      'Select all objects inside a group, including those in nested groups. mode: replace (default), add, remove or toggle (deselects them if all are already selected, otherwise selects all). Afterwards the usual object commands (scene.set_transform, scene.delete_objects, ...) act on them through the selection. Leaves edit mode unless the edited object stays the active one.',
    params: z.object({ id: z.string(), mode: z.enum(['replace', 'add', 'remove', 'toggle']).default('replace') }),
    history: false,
    run(ctx, p) {
      const state = docState(ctx);
      requireGroup(state, p.id);
      const ids = objectsInGroup(state, p.id);
      const current = new Set(p.mode === 'replace' ? [] : state.selection);
      const remove = p.mode === 'remove' || (p.mode === 'toggle' && ids.every((id) => current.has(id)));
      for (const id of ids) {
        if (remove) current.delete(id);
        else current.add(id);
      }
      const selection = [...current];
      const activeId = remove
        ? state.activeId && current.has(state.activeId)
          ? state.activeId
          : (selection.at(-1) ?? null)
        : (ids.at(-1) ?? (state.activeId && current.has(state.activeId) ? state.activeId : (selection.at(-1) ?? null)));
      updateDocState(ctx, (s) => ({ ...s, selection, activeId, edit: s.edit && s.edit.objectId === activeId ? s.edit : null }));
      return { selection, activeId };
    },
  }),

  defineCommand({
    id: 'group.set_visible',
    title: 'Gruppe ein-/ausblenden',
    description: 'Show or hide all objects inside a group, including those in nested groups.',
    params: z.object({ id: z.string(), visible: z.boolean() }),
    run(ctx, p) {
      const state = docState(ctx);
      requireGroup(state, p.id);
      const ids = objectsInGroup(state, p.id);
      updateDocState(ctx, (s) => {
        const objects = { ...s.objects };
        for (const id of ids) if (objects[id].visible !== p.visible) objects[id] = { ...objects[id], visible: p.visible };
        return { ...s, objects };
      });
    },
  }),

  defineCommand({
    id: 'group.list',
    title: 'Gruppen auflisten',
    description:
      'The group tree of the active document. For every group: id, name, parentId (null at top level), objectIds and childGroupIds (direct members, in display order) and objectCount (all objects inside, including nested groups). rootObjectIds are the objects that are in no group. Object details come from scene.list_objects.',
    params: z.object({}),
    run(ctx) {
      const state = docState(ctx);
      return {
        groups: state.groupOrder.map((id) => ({
          ...state.groups[id],
          objectIds: state.order.filter((objectId) => state.objects[objectId].groupId === id),
          childGroupIds: state.groupOrder.filter((groupId) => state.groups[groupId].parentId === id),
          objectCount: objectsInGroup(state, id).length,
        })),
        rootObjectIds: state.order.filter((objectId) => state.objects[objectId].groupId === null),
      };
    },
  }),
];
