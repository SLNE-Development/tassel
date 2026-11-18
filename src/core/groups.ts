// Pure helpers for the group tree (see `Group` in types.ts).
import type { DocState, Group, SceneObject } from './types';

/** The group itself and every group nested inside it. */
export function groupWithDescendants(state: Pick<DocState, 'groups'>, id: string): Set<string> {
  const result = new Set([id]);
  const stack = [id];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const group of Object.values(state.groups)) {
      if (group.parentId === current && !result.has(group.id)) {
        result.add(group.id);
        stack.push(group.id);
      }
    }
  }
  return result;
}

/** Ids of all objects inside the group, including nested groups, in outliner order. */
export function objectsInGroup(state: DocState, id: string): string[] {
  const inside = groupWithDescendants(state, id);
  return state.order.filter((objectId) => {
    const groupId = state.objects[objectId].groupId;
    return groupId !== null && inside.has(groupId);
  });
}

/**
 * Makes the group references of untrusted data valid: `groupId` / `parentId` that point at
 * nothing become null and parent cycles are cut (the first group of a cycle moves to top level).
 */
export function repairGroups(
  objects: Readonly<Record<string, SceneObject>>,
  groups: Readonly<Record<string, Group>>,
): { objects: Record<string, SceneObject>; groups: Record<string, Group> } {
  const fixedGroups: Record<string, Group> = {};
  for (const group of Object.values(groups)) {
    const dangling = group.parentId !== null && !(Object.hasOwn(groups, group.parentId));
    fixedGroups[group.id] = dangling ? { ...group, parentId: null } : group;
  }
  for (const id of Object.keys(fixedGroups)) {
    const seen = new Set([id]);
    let parent = fixedGroups[id].parentId;
    while (parent !== null && !seen.has(parent)) {
      seen.add(parent);
      parent = fixedGroups[parent].parentId;
    }
    // Only cut when the chain comes back to this group; a cycle further up is cut at its own members.
    if (parent === id) fixedGroups[id] = { ...fixedGroups[id], parentId: null };
  }
  const fixedObjects: Record<string, SceneObject> = {};
  for (const obj of Object.values(objects)) {
    const dangling = obj.groupId !== null && !(Object.hasOwn(fixedGroups, obj.groupId));
    fixedObjects[obj.id] = dangling ? { ...obj, groupId: null } : obj;
  }
  return { objects: fixedObjects, groups: fixedGroups };
}
