import { beforeEach, describe, expect, it } from 'vitest';
import { groupWithDescendants, objectsInGroup } from '../groups';
import { parseProject, serializeProject } from '../project';
import { activeDoc, createAppState } from '../state';
import type { AppState, DocState } from '../types';
import { commands } from './index';
import { runCommand, type AnyCommand, type CommandContext } from './registry';

const byId = new Map<string, AnyCommand>(commands.map((c) => [c.id, c]));

let app: AppState;
const ctx: CommandContext = {
  get: () => app,
  set: (update) => {
    app = update(app);
  },
  services: { viewport: null, exporter: null },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function run(id: string, params?: unknown): Promise<any> {
  const def = byId.get(id);
  if (!def) throw new Error(`Unknown command ${id}`);
  return runCommand(def, ctx, params);
}

const doc = () => activeDoc(app);
const state = (): DocState => doc().state;
const groupOf = (id: string) => state().objects[id].groupId;
const parentOf = (id: string) => state().groups[id].parentId;

async function add(params: Record<string, unknown> = {}): Promise<string> {
  return (await run('scene.add_primitive', { type: 'plane', ...params })).id;
}

async function group(ids: string[], params: Record<string, unknown> = {}): Promise<string> {
  return (await run('group.create', { ids, ...params })).id;
}

/** Everything the brief calls an invariant, plus the pre-existing ones that group commands touch. */
function invariantErrors(s: DocState): string[] {
  const errors: string[] = [];
  const groupIds = Object.keys(s.groups);
  if (new Set(s.groupOrder).size !== s.groupOrder.length) errors.push('groupOrder has duplicates');
  if ([...s.groupOrder].sort().join() !== [...groupIds].sort().join()) errors.push('groupOrder != keys of groups');
  if (new Set(s.order).size !== s.order.length) errors.push('order has duplicates');
  if ([...s.order].sort().join() !== Object.keys(s.objects).sort().join()) errors.push('order != keys of objects');
  for (const [key, g] of Object.entries(s.groups)) {
    if (g.id !== key) errors.push(`group ${key} has id ${g.id}`);
    if (g.parentId !== null && !s.groups[g.parentId]) errors.push(`group ${key}: dangling parentId`);
    const seen = new Set<string>();
    for (let cur: string | null = key; cur !== null && s.groups[cur]; cur = s.groups[cur].parentId) {
      if (seen.has(cur)) {
        errors.push(`group ${key}: cycle`);
        break;
      }
      seen.add(cur);
    }
  }
  const names = Object.values(s.groups).map((g) => g.name);
  if (new Set(names).size !== names.length) errors.push('group names are not unique');
  for (const obj of Object.values(s.objects)) {
    if (obj.groupId !== null && !s.groups[obj.groupId]) errors.push(`object ${obj.id}: dangling groupId`);
  }
  for (const id of s.selection) if (!s.objects[id]) errors.push(`selection has deleted object ${id}`);
  if (s.activeId !== null && !s.selection.includes(s.activeId)) errors.push('activeId is not selected');
  if (s.edit && !s.objects[s.edit.objectId]) errors.push('edit mode on a deleted object');
  return errors;
}

/** Runs a mutating command and checks that it is exactly one undo step that undo/redo restore by identity. */
async function expectUndoable(id: string, params: unknown): Promise<unknown> {
  const before = state();
  const past = doc().past.length;
  const result = await run(id, params);
  const after = state();
  expect(after).not.toBe(before);
  expect(doc().past).toHaveLength(past + 1);
  expect(invariantErrors(after)).toEqual([]);
  await run('history.undo');
  expect(state()).toBe(before);
  await run('history.redo');
  expect(state()).toBe(after);
  return result;
}

beforeEach(() => {
  app = createAppState();
});

describe('registration', () => {
  it('registers all group commands with unique ids', () => {
    const ids = commands.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id.startsWith('group.')).sort()).toEqual([
      'group.create',
      'group.delete',
      'group.list',
      'group.move',
      'group.rename',
      'group.select',
      'group.set_visible',
      'group.ungroup',
    ]);
  });

  it('new documents have no groups', () => {
    expect(state().groups).toEqual({});
    expect(state().groupOrder).toEqual([]);
  });
});

describe('group.create', () => {
  it('moves the given objects into a new top-level group', async () => {
    const a = await add();
    const b = await add();
    const c = await add();
    const result = await run('group.create', { ids: [a, c] });
    expect(result).toMatchObject({ id: expect.any(String), name: 'Gruppe', parentId: null, childGroupIds: [] });
    expect(result.objectIds).toHaveLength(2);
    expect(state().groups).toEqual({ [result.id]: { id: result.id, name: 'Gruppe', parentId: null } });
    expect(state().groupOrder).toEqual([result.id]);
    expect([groupOf(a), groupOf(b), groupOf(c)]).toEqual([result.id, null, result.id]);
    // The flat object order and the selection are untouched.
    expect(state().order).toEqual([a, b, c]);
    expect(state().selection).toEqual([c]);
  });

  it('defaults to the selection and makes names unique among all groups', async () => {
    const a = await add();
    const b = await add();
    await run('scene.select', { ids: [a, b] });
    const g1 = await run('group.create');
    expect([groupOf(a), groupOf(b)]).toEqual([g1.id, g1.id]);
    // Same name in a different parent still gets a suffix.
    const g2 = await run('group.create', { ids: [], parentId: g1.id });
    const g3 = await run('group.create', { ids: [], name: 'Gruppe' });
    expect([g1.name, g2.name, g3.name]).toEqual(['Gruppe', 'Gruppe.001', 'Gruppe.002']);
    expect(state().groupOrder).toEqual([g1.id, g2.id, g3.id]);
  });

  it('creates an empty group for an empty id list or an empty selection', async () => {
    const a = await add();
    const g = await group([], { name: 'Leer' });
    expect(state().groups[g]).toEqual({ id: g, name: 'Leer', parentId: null });
    expect(groupOf(a)).toBeNull();
    await run('scene.select', { ids: [] });
    const h = (await run('group.create')).id;
    expect(objectsInGroup(state(), h)).toEqual([]);
  });

  it('nests inside the group shared by all objects, else goes to top level', async () => {
    const a = await add();
    const b = await add();
    const c = await add();
    const outer = await group([a, b]);
    const inner = await group([a]);
    expect(parentOf(inner)).toBe(outer);
    expect(groupOf(a)).toBe(inner);
    // a is in `inner`, b in `outer`: no shared group.
    const mixed = await group([a, b]);
    expect(parentOf(mixed)).toBeNull();
    // b (in a group) and c (top level) do not share one either.
    expect(parentOf(await group([b, c]))).toBeNull();
  });

  it('an explicit parentId wins, including null', async () => {
    const a = await add();
    const outer = await group([a]);
    const other = await group([]);
    expect(parentOf(await group([a], { parentId: other }))).toBe(other);
    expect(parentOf(await group([a], { parentId: null }))).toBeNull();
    expect(parentOf(outer)).toBeNull();
  });

  it('rejects unknown objects and parents without changing anything', async () => {
    const a = await add();
    const before = app;
    await expect(run('group.create', { ids: [a, 'nope'] })).rejects.toThrow(/Object "nope" does not exist/);
    await expect(run('group.create', { ids: [a], parentId: 'nope' })).rejects.toThrow(/Group "nope" does not exist/);
    await expect(run('group.create', { ids: [a], name: '' })).rejects.toThrow();
    expect(app).toBe(before);
  });

  it('is one undo step', async () => {
    const a = await add();
    const b = await add();
    await expectUndoable('group.create', { ids: [a, b, a] });
    await run('history.undo');
    expect(state().groups).toEqual({});
    expect([groupOf(a), groupOf(b)]).toEqual([null, null]);
  });
});

describe('group.ungroup', () => {
  it('moves objects and child groups to the parent and removes the group', async () => {
    const a = await add();
    const b = await add();
    const c = await add();
    const outer = await group([a, b, c], { name: 'Aussen' });
    const mid = await group([b, c], { name: 'Mitte' });
    const inner = await group([c], { name: 'Innen' });
    expect([parentOf(mid), parentOf(inner)]).toEqual([outer, mid]);

    await expectUndoable('group.ungroup', { id: mid });
    expect(state().groups[mid]).toBeUndefined();
    expect(state().groupOrder).toEqual([outer, inner]);
    expect(parentOf(inner)).toBe(outer);
    expect([groupOf(a), groupOf(b), groupOf(c)]).toEqual([outer, outer, inner]);
    expect(state().order).toEqual([a, b, c]);
  });

  it('a top-level group releases its contents to top level', async () => {
    const a = await add();
    const outer = await group([a]);
    const inner = await group([], { parentId: outer });
    await run('group.ungroup', { id: outer });
    expect(groupOf(a)).toBeNull();
    expect(parentOf(inner)).toBeNull();
    expect(state().groupOrder).toEqual([inner]);
  });

  it('rejects unknown ids', async () => {
    const before = app;
    await expect(run('group.ungroup', { id: 'nope' })).rejects.toThrow(/Group "nope" does not exist/);
    expect(app).toBe(before);
  });
});

describe('group.delete', () => {
  it('deletes the group, nested groups and all objects inside', async () => {
    const a = await add();
    const b = await add();
    const c = await add();
    const d = await add();
    const outer = await group([a, b]);
    const inner = await group([b]);
    const innermost = await group([], { parentId: inner });
    const other = await group([c]);
    await run('scene.select', { ids: [a, c, b] });

    const result = (await expectUndoable('group.delete', { id: outer })) as { deletedGroups: string[]; deletedObjects: string[] };
    expect(result.deletedGroups.sort()).toEqual([outer, inner, innermost].sort());
    expect(result.deletedObjects).toEqual([a, b]);
    expect(state().order).toEqual([c, d]);
    expect(Object.keys(state().objects).sort()).toEqual([c, d].sort());
    expect(state().groupOrder).toEqual([other]);
    expect(Object.keys(state().groups)).toEqual([other]);
    // The active object was deleted: it falls back to the last remaining selected one.
    expect(state().selection).toEqual([c]);
    expect(state().activeId).toBe(c);

    await run('history.undo');
    expect(state().order).toEqual([a, b, c, d]);
    expect(state().groupOrder).toEqual([outer, inner, innermost, other]);
    expect(state().selection).toEqual([a, c, b]);
  });

  it('deleting a nested group keeps its parent and siblings', async () => {
    const a = await add();
    const b = await add();
    const outer = await group([a, b]);
    const inner = await group([b]);
    await run('group.delete', { id: inner });
    expect(state().order).toEqual([a]);
    expect(state().groupOrder).toEqual([outer]);
    expect(groupOf(a)).toBe(outer);
  });

  it('leaves edit mode when the edited object is deleted, and only then', async () => {
    const a = await add();
    const b = await add();
    const ga = await group([a]);
    const gb = await group([b]);
    await run('edit.enter', { id: a });
    expect(state().edit?.objectId).toBe(a);
    await run('group.delete', { id: gb });
    expect(state().edit?.objectId).toBe(a);
    await run('group.delete', { id: ga });
    expect(state().edit).toBeNull();
    expect(state().selection).toEqual([]);
    expect(state().activeId).toBeNull();
    expect(invariantErrors(state())).toEqual([]);
    // Undo brings the object and the edit session back.
    await run('history.undo');
    expect(state().edit?.objectId).toBe(a);
  });

  it('rejects unknown ids', async () => {
    const before = app;
    await expect(run('group.delete', { id: 'nope' })).rejects.toThrow(/Group "nope" does not exist/);
    expect(app).toBe(before);
  });
});

describe('group.rename', () => {
  it('renames, keeps names unique and may keep its own name', async () => {
    const g = await group([], { name: 'Haus' });
    const h = await group([], { name: 'Garten', parentId: g });
    expect(await run('group.rename', { id: h, name: 'Haus' })).toEqual({ id: h, name: 'Haus.001' });
    expect(await run('group.rename', { id: g, name: 'Haus' })).toEqual({ id: g, name: 'Haus' });
    expect(await expectUndoable('group.rename', { id: h, name: 'Dach' })).toEqual({ id: h, name: 'Dach' });
    expect(state().groups[h]).toEqual({ id: h, name: 'Dach', parentId: g });
  });

  it('group names do not collide with object names', async () => {
    await add({ name: 'Haus' });
    expect((await run('group.create', { ids: [], name: 'Haus' })).name).toBe('Haus');
  });

  it('rejects unknown ids and empty names', async () => {
    const g = await group([]);
    const before = app;
    await expect(run('group.rename', { id: 'nope', name: 'X' })).rejects.toThrow(/Group "nope" does not exist/);
    await expect(run('group.rename', { id: g, name: '' })).rejects.toThrow();
    expect(app).toBe(before);
  });
});

describe('group.move', () => {
  it('moves objects into a group and back to top level', async () => {
    const a = await add();
    const b = await add();
    const c = await add();
    const g = await group([]);
    await expectUndoable('group.move', { objectIds: [a, b], targetGroupId: g });
    expect([groupOf(a), groupOf(b), groupOf(c)]).toEqual([g, g, null]);
    await run('group.move', { objectIds: [a], targetGroupId: null });
    expect(groupOf(a)).toBeNull();
    expect((await run('group.list')).rootObjectIds).toEqual([c, a]);
  });

  it('index positions objects among their new siblings; default is the end', async () => {
    const [a, b, c, d, e] = [await add(), await add(), await add(), await add(), await add()];
    const g = await group([b, d]);
    const members = async () => (await run('group.list')).groups[0].objectIds;
    expect(await members()).toEqual([b, d]);

    await run('group.move', { objectIds: [e], targetGroupId: g, index: 1 });
    expect(await members()).toEqual([b, e, d]);
    await run('group.move', { objectIds: [a], targetGroupId: g, index: 0 });
    expect(await members()).toEqual([a, b, e, d]);
    await run('group.move', { objectIds: [c], targetGroupId: g });
    expect(await members()).toEqual([a, b, e, d, c]);
    // Reordering inside the same group; the index does not count the moved items.
    await run('group.move', { objectIds: [d, a], targetGroupId: g, index: 1 });
    expect(await members()).toEqual([b, d, a, e, c]);
    await run('group.move', { objectIds: [b], targetGroupId: g, index: 99 });
    expect(await members()).toEqual([d, a, e, c, b]);
    expect([...state().order].sort()).toEqual([a, b, c, d, e].sort());
  });

  it('reorders top-level objects among top-level objects only', async () => {
    const [a, b, c, d] = [await add(), await add(), await add(), await add()];
    await group([b]);
    await run('group.move', { objectIds: [d], targetGroupId: null, index: 1 });
    // Siblings at top level are a, c: d goes in front of c.
    expect((await run('group.list')).rootObjectIds).toEqual([a, d, c]);
    expect(state().order).toEqual([a, b, d, c]);
  });

  it('moves and reorders groups', async () => {
    const g1 = await group([], { name: 'A' });
    const g2 = await group([], { name: 'B' });
    const g3 = await group([], { name: 'C' });
    const g4 = await group([], { name: 'D' });
    const children = async (id: string) =>
      (await run('group.list')).groups.find((g: { id: string }) => g.id === id).childGroupIds;

    await expectUndoable('group.move', { groupIds: [g2, g3], targetGroupId: g1 });
    expect([parentOf(g2), parentOf(g3)]).toEqual([g1, g1]);
    expect(await children(g1)).toEqual([g2, g3]);
    await run('group.move', { groupIds: [g4], targetGroupId: g1, index: 1 });
    expect(await children(g1)).toEqual([g2, g4, g3]);
    await run('group.move', { groupIds: [g3], targetGroupId: g1, index: 0 });
    expect(await children(g1)).toEqual([g3, g2, g4]);
    await run('group.move', { groupIds: [g2], targetGroupId: null, index: 0 });
    expect(parentOf(g2)).toBeNull();
    expect(state().groupOrder.filter((id) => parentOf(id) === null)).toEqual([g2, g1]);
    expect(invariantErrors(state())).toEqual([]);
  });

  it('moves objects and groups together', async () => {
    const a = await add();
    const g = await group([]);
    const h = await group([]);
    await run('group.move', { objectIds: [a], groupIds: [h], targetGroupId: g });
    expect(groupOf(a)).toBe(g);
    expect(parentOf(h)).toBe(g);
  });

  it('rejects moving a group into itself or a descendant', async () => {
    const a = await add();
    const g1 = await group([a]);
    const g2 = await group([a]);
    const g3 = await group([a]);
    expect([parentOf(g2), parentOf(g3)]).toEqual([g1, g2]);
    const before = app;
    await expect(run('group.move', { groupIds: [g1], targetGroupId: g1 })).rejects.toThrow(/cannot be moved into itself/);
    await expect(run('group.move', { groupIds: [g1], targetGroupId: g2 })).rejects.toThrow(/nested inside it/);
    await expect(run('group.move', { groupIds: [g1], targetGroupId: g3 })).rejects.toThrow(/nested inside it/);
    // All or nothing: the valid part of the request is not applied either.
    await expect(run('group.move', { objectIds: [a], groupIds: [g3, g2], targetGroupId: g3 })).rejects.toThrow();
    expect(app).toBe(before);
    // Moving a descendant up is fine.
    await run('group.move', { groupIds: [g3], targetGroupId: g1 });
    expect(parentOf(g3)).toBe(g1);
  });

  it('rejects unknown ids and empty requests', async () => {
    const a = await add();
    const g = await group([]);
    const before = app;
    await expect(run('group.move', { objectIds: ['nope'], targetGroupId: g })).rejects.toThrow(/Object "nope" does not exist/);
    await expect(run('group.move', { groupIds: ['nope'], targetGroupId: null })).rejects.toThrow(/Group "nope" does not exist/);
    await expect(run('group.move', { objectIds: [a], targetGroupId: 'nope' })).rejects.toThrow(/Group "nope" does not exist/);
    await expect(run('group.move', { targetGroupId: g })).rejects.toThrow(/Nothing to move/);
    await expect(run('group.move', { objectIds: [a] })).rejects.toThrow();
    await expect(run('group.move', { objectIds: [a], targetGroupId: g, index: -1 })).rejects.toThrow();
    expect(app).toBe(before);
  });
});

describe('group.select', () => {
  let a: string, b: string, c: string, d: string;
  let outer: string, inner: string, empty: string;
  beforeEach(async () => {
    [a, b, c, d] = [await add(), await add(), await add(), await add()];
    outer = await group([a, b, c]);
    inner = await group([b, c]);
    empty = await group([], { parentId: inner });
    await run('scene.select', { ids: [] });
  });

  it('replace selects everything inside recursively', async () => {
    await run('scene.select', { ids: [d] });
    expect(await run('group.select', { id: outer })).toEqual({ selection: [a, b, c], activeId: c });
    expect(state().selection).toEqual([a, b, c]);
    expect(await run('group.select', { id: inner })).toEqual({ selection: [b, c], activeId: c });
  });

  it('add and remove', async () => {
    await run('scene.select', { ids: [d] });
    await run('group.select', { id: inner, mode: 'add' });
    expect(state().selection).toEqual([d, b, c]);
    expect(state().activeId).toBe(c);
    await run('group.select', { id: outer, mode: 'add' });
    expect(state().selection).toEqual([d, b, c, a]);
    await run('scene.select', { ids: [d], mode: 'add' });
    await run('group.select', { id: inner, mode: 'remove' });
    expect(state().selection).toEqual([d, a]);
    // The active object was not removed, so it stays active.
    expect(state().activeId).toBe(d);
    await run('group.select', { id: outer, mode: 'remove' });
    await run('group.select', { id: outer, mode: 'add' });
    await run('group.select', { id: outer, mode: 'remove' });
    expect(state().selection).toEqual([d]);
    expect(state().activeId).toBe(d);
  });

  it('toggle selects all unless all are already selected', async () => {
    await run('scene.select', { ids: [d, b] });
    // Partly selected: select the rest.
    await run('group.select', { id: outer, mode: 'toggle' });
    expect(state().selection).toEqual([d, b, a, c]);
    // Fully selected: deselect them, the rest stays.
    await run('group.select', { id: outer, mode: 'toggle' });
    expect(state().selection).toEqual([d]);
    expect(state().activeId).toBe(d);
    await run('group.select', { id: inner, mode: 'toggle' });
    expect(state().selection).toEqual([d, b, c]);
  });

  it('an empty group selects nothing', async () => {
    await run('scene.select', { ids: [a] });
    await run('group.select', { id: empty, mode: 'add' });
    await run('group.select', { id: empty, mode: 'toggle' });
    await run('group.select', { id: empty, mode: 'remove' });
    expect(state().selection).toEqual([a]);
    expect(state().activeId).toBe(a);
    expect(await run('group.select', { id: empty })).toEqual({ selection: [], activeId: null });
  });

  it('exits edit mode when the active object changes, like scene.select', async () => {
    await run('edit.enter', { id: a });
    await run('group.select', { id: inner });
    expect(state().edit).toBeNull();
    // The edited object stays active when it is the last one of the group.
    await run('edit.enter', { id: c });
    await run('group.select', { id: outer });
    expect(state().edit?.objectId).toBe(c);
    expect(state().activeId).toBe(c);
  });

  it('is not an undo step and does not dirty the document', async () => {
    await run('document.mark_saved');
    const { past, future } = doc();
    await run('group.select', { id: outer });
    await run('group.select', { id: inner, mode: 'toggle' });
    expect(doc().past).toBe(past);
    expect(doc().future).toBe(future);
    expect(doc().dirty).toBe(false);
  });

  it('the selection drives the existing multi-object commands', async () => {
    await run('group.select', { id: inner });
    await run('scene.delete_objects');
    expect(state().order).toEqual([a, d]);
    // Deleting objects leaves their now empty group in place.
    expect(state().groupOrder).toEqual([outer, inner, empty]);
    expect(invariantErrors(state())).toEqual([]);
  });

  it('rejects unknown ids', async () => {
    const before = app;
    await expect(run('group.select', { id: 'nope' })).rejects.toThrow(/Group "nope" does not exist/);
    await expect(run('group.select', { id: outer, mode: 'invert' })).rejects.toThrow();
    expect(app).toBe(before);
  });
});

describe('group.set_visible', () => {
  it('hides and shows everything inside recursively', async () => {
    const [a, b, c] = [await add(), await add(), await add()];
    const outer = await group([a, b]);
    await group([b]);
    const visible = () => [a, b, c].map((id) => state().objects[id].visible);

    await expectUndoable('group.set_visible', { id: outer, visible: false });
    expect(visible()).toEqual([false, false, true]);
    await run('scene.set_visible', { ids: [a], visible: true });
    await run('group.set_visible', { id: outer, visible: true });
    expect(visible()).toEqual([true, true, true]);
    await run('history.undo');
    expect(visible()).toEqual([true, false, true]);
  });

  it('rejects unknown ids', async () => {
    const before = app;
    await expect(run('group.set_visible', { id: 'nope', visible: false })).rejects.toThrow(/Group "nope" does not exist/);
    expect(app).toBe(before);
  });
});

describe('group.list', () => {
  it('returns the tree with direct members and recursive counts', async () => {
    const [a, b, c, d] = [await add(), await add(), await add(), await add()];
    const outer = await group([a, b, c], { name: 'Aussen' });
    const inner = await group([b, c], { name: 'Innen' });
    const empty = await group([], { name: 'Leer' });
    const before = app;
    expect(await run('group.list')).toEqual({
      groups: [
        { id: outer, name: 'Aussen', parentId: null, objectIds: [a], childGroupIds: [inner], objectCount: 3 },
        { id: inner, name: 'Innen', parentId: outer, objectIds: [b, c], childGroupIds: [], objectCount: 2 },
        { id: empty, name: 'Leer', parentId: null, objectIds: [], childGroupIds: [], objectCount: 0 },
      ],
      rootObjectIds: [d],
    });
    expect(app).toBe(before);
    expect(await run('group.list')).toMatchObject({ groups: expect.any(Array) });
  });

  it('is empty for a new document', async () => {
    expect(await run('group.list')).toEqual({ groups: [], rootObjectIds: [] });
  });
});

describe('existing scene commands', () => {
  it('list_objects and get_object include groupId', async () => {
    const a = await add();
    const b = await add();
    const g = await group([a]);
    const list = await run('scene.list_objects');
    expect(list.objects.map((o: { groupId: string | null }) => o.groupId)).toEqual([g, null]);
    expect((await run('scene.get_object', { id: a })).groupId).toBe(g);
    expect((await run('scene.get_object', { id: b })).groupId).toBeNull();
  });

  it('add_primitive takes an existing group', async () => {
    const g = await group([]);
    const a = await add({ groupId: g });
    expect(groupOf(a)).toBe(g);
    expect(groupOf(await add())).toBeNull();
    expect(groupOf(await add({ groupId: null }))).toBeNull();
    const before = app;
    await expect(add({ groupId: 'nope' })).rejects.toThrow(/Group "nope" does not exist/);
    expect(app).toBe(before);
    // Adding and duplicating keep the groups of the document.
    expect(state().groupOrder).toEqual([g]);
  });

  it('duplicate keeps copies in the group of their original', async () => {
    const a = await add();
    const b = await add();
    const g = await group([a]);
    const result = await run('scene.duplicate_objects', { ids: [a, b] });
    const [ca, cb] = result.objects.map((o: { id: string }) => o.id);
    expect([groupOf(ca), groupOf(cb)]).toEqual([g, null]);
    expect(state().groups[g]).toBeDefined();
    expect(objectsInGroup(state(), g)).toEqual([a, ca]);
    await run('history.undo');
    expect(objectsInGroup(state(), g)).toEqual([a]);
  });

  it('deleting objects leaves their groups in place', async () => {
    const a = await add();
    const g = await group([a]);
    await run('scene.delete_objects', { ids: [a] });
    expect(state().groups[g]).toEqual({ id: g, name: 'Gruppe', parentId: null });
    expect(state().groupOrder).toEqual([g]);
  });

  it('pure group changes do not disturb edit mode, not even for the edited object', async () => {
    const a = await add();
    const b = await add();
    await run('edit.enter', { id: a });
    await run('mesh.select_all');
    const edit = state().edit;
    const mesh = state().objects[a].mesh;
    expect(edit?.objectId).toBe(a);

    const g = await group([b]);
    const h = await group([a]);
    await run('group.rename', { id: g, name: 'Andere' });
    await run('group.move', { objectIds: [b], targetGroupId: h, index: 0 });
    await run('group.move', { groupIds: [g], targetGroupId: h });
    await run('group.move', { objectIds: [a], targetGroupId: null });
    await run('group.set_visible', { id: h, visible: false });
    await run('group.ungroup', { id: h });
    await run('group.list');
    expect(state().edit).toBe(edit);
    expect(state().selection).toEqual([a]);
    // The mesh of the edited object keeps its identity, so nothing has to be rebuilt.
    expect(state().objects[a].mesh).toBe(mesh);
  });

  it('unaffected objects keep reference identity', async () => {
    const a = await add();
    const b = await add();
    const objB = state().objects[b];
    const g = await group([a]);
    await run('group.rename', { id: g, name: 'X' });
    await run('group.set_visible', { id: g, visible: false });
    await run('group.move', { objectIds: [a], targetGroupId: null });
    await run('group.ungroup', { id: g });
    expect(state().objects[b]).toBe(objB);
  });
});

describe('invariants under random command sequences', () => {
  // mulberry32: small seeded generator, so failures are reproducible.
  function generator(seed: number) {
    let t = seed;
    return () => {
      t = (t + 0x6d2b79f5) | 0;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  for (const seed of [1, 2, 3, 4, 5]) {
    it(`seed ${seed}`, async () => {
      const random = generator(seed);
      const int = (n: number) => Math.floor(random() * n);
      const pick = <T>(list: readonly T[]): T => list[int(list.length)];
      const some = <T>(list: readonly T[]): T[] => list.filter(() => random() < 0.4);
      const anyGroup = () => (state().groupOrder.length > 0 && random() < 0.8 ? pick(state().groupOrder) : null);
      const log: string[] = [];

      for (let step = 0; step < 250; step++) {
        const s = state();
        const g = s.groupOrder.length > 0 ? pick(s.groupOrder) : null;
        const ops: [string, unknown][] = [
          ['scene.add_primitive', { type: 'plane', groupId: anyGroup() }],
          ['group.create', { ids: some(s.order), name: pick(['Gruppe', 'A', 'B']) }],
          ['group.create', { ids: some(s.order), parentId: anyGroup() }],
          ['group.move', { objectIds: some(s.order), groupIds: some(s.groupOrder), targetGroupId: anyGroup(), index: pick([undefined, 0, 1, 5]) }],
          ['history.undo', {}],
          ['history.redo', {}],
        ];
        if (g !== null) {
          ops.push(
            ['group.ungroup', { id: g }],
            ['group.delete', { id: g }],
            ['group.rename', { id: g, name: pick(['Gruppe', 'A', 'B']) }],
            ['group.select', { id: g, mode: pick(['replace', 'add', 'remove', 'toggle']) }],
            ['group.set_visible', { id: g, visible: random() < 0.5 }],
            ['group.move', { groupIds: [g], targetGroupId: anyGroup() }],
          );
        }
        if (s.order.length > 0) {
          ops.push(
            ['scene.duplicate_objects', { ids: some(s.order).slice(0, 2).concat(pick(s.order)) }],
            ['scene.delete_objects', { ids: [pick(s.order)] }],
            ['edit.enter', { id: pick(s.order) }],
          );
        }
        const [id, params] = pick(ops);
        log.push(`${id} ${JSON.stringify(params)}`);
        const before = app;
        try {
          await run(id, params);
        } catch (error) {
          // The only expected failures are the documented rejections; they must not change anything.
          expect(String(error), log.slice(-3).join('\n')).toMatch(/cannot be moved into|Nothing to move/);
          expect(app).toBe(before);
        }
        expect(invariantErrors(state()), log.slice(-3).join('\n')).toEqual([]);
        // The file format keeps every reachable state intact.
        if (step % 25 === 0) {
          const parsed = parseProject(serializeProject(doc())).state;
          expect(parsed.groups).toEqual(state().groups);
          expect(parsed.groupOrder).toEqual(state().groupOrder);
          expect(parsed.objects).toEqual(state().objects);
        }
      }
      // The generator must actually have exercised nesting.
      expect(log.some((line) => line.startsWith('group.move'))).toBe(true);
    });
  }
});

describe('project files', () => {
  const triangle = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], faces: [[0, 1, 2]] };
  const object = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    name: id,
    visible: true,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    mesh: triangle,
    ...overrides,
  });
  const project = (objects: unknown[], groups?: unknown) =>
    JSON.stringify({ format: 'tessel', version: 1, name: 'Test', objects, ...(groups === undefined ? {} : { groups }) });

  it('round trips groups, their order and membership', async () => {
    const [a, b, c] = [await add(), await add(), await add()];
    const outer = await group([a, b], { name: 'Aussen' });
    const inner = await group([b], { name: 'Innen' });
    const empty = await group([], { name: 'Leer' });
    await run('group.move', { groupIds: [empty], targetGroupId: null, index: 0 });
    expect(state().groupOrder).toEqual([empty, outer, inner]);
    const source = state();

    const { json } = await run('document.serialize');
    expect(JSON.parse(json).groups).toEqual([
      { id: empty, name: 'Leer', parentId: null },
      { id: outer, name: 'Aussen', parentId: null },
      { id: inner, name: 'Innen', parentId: outer },
    ]);
    await run('document.load', { json });
    expect(state()).not.toBe(source);
    expect(state().groups).toEqual(source.groups);
    expect(state().groupOrder).toEqual(source.groupOrder);
    expect(state().objects).toEqual(source.objects);
    expect(state().order).toEqual([a, b, c]);
    expect(invariantErrors(state())).toEqual([]);
    expect((await run('document.serialize')).json).toBe(json);
    // The loaded document is editable.
    await run('group.delete', { id: outer });
    expect(state().order).toEqual([c]);
    expect(state().groupOrder).toEqual([empty]);
  });

  it('loads files written before groups existed', () => {
    const { state: loaded } = parseProject(project([object('a'), object('b')]));
    expect(loaded.groups).toEqual({});
    expect(loaded.groupOrder).toEqual([]);
    expect(loaded.order.map((id) => loaded.objects[id].groupId)).toEqual([null, null]);
  });

  it('a missing parentId means top level', () => {
    const { state: loaded } = parseProject(project([object('a', { groupId: 'g' })], [{ id: 'g', name: 'G' }]));
    expect(loaded.groups).toEqual({ g: { id: 'g', name: 'G', parentId: null } });
    expect(loaded.objects.a.groupId).toBe('g');
  });

  it('repairs dangling references instead of rejecting the file', () => {
    const { state: loaded } = parseProject(
      project(
        [object('a', { groupId: 'gone' }), object('b', { groupId: 'g' })],
        [
          { id: 'g', name: 'G', parentId: 'gone' },
          { id: 'h', name: 'H', parentId: 'g' },
        ],
      ),
    );
    expect(loaded.objects.a.groupId).toBeNull();
    expect(loaded.objects.b.groupId).toBe('g');
    expect(loaded.groups).toEqual({ g: { id: 'g', name: 'G', parentId: null }, h: { id: 'h', name: 'H', parentId: 'g' } });
    expect(loaded.groupOrder).toEqual(['g', 'h']);
    expect(invariantErrors(loaded)).toEqual([]);
  });

  it('breaks cycles and keeps the rest of the tree', () => {
    const { state: loaded } = parseProject(
      project(
        [object('a', { groupId: 'z' }), object('b', { groupId: 'self' })],
        [
          { id: 'tail', name: 'Tail', parentId: 'x' },
          { id: 'x', name: 'X', parentId: 'y' },
          { id: 'y', name: 'Y', parentId: 'z' },
          { id: 'z', name: 'Z', parentId: 'x' },
          { id: 'self', name: 'Self', parentId: 'self' },
          { id: 'ok', name: 'Ok', parentId: 'self' },
        ],
      ),
    );
    expect(invariantErrors(loaded)).toEqual([]);
    expect(loaded.groupOrder).toEqual(['tail', 'x', 'y', 'z', 'self', 'ok']);
    // Exactly one link of the x -> y -> z -> x cycle is cut; everything else is kept.
    expect(loaded.groups.x.parentId).toBeNull();
    expect(loaded.groups.y.parentId).toBe('z');
    expect(loaded.groups.z.parentId).toBe('x');
    expect(loaded.groups.tail.parentId).toBe('x');
    expect(loaded.groups.self.parentId).toBeNull();
    expect(loaded.groups.ok.parentId).toBe('self');
    expect([...groupWithDescendants(loaded, 'x')].sort()).toEqual(['tail', 'x', 'y', 'z']);
    expect(loaded.objects.a.groupId).toBe('z');
    expect(loaded.objects.b.groupId).toBe('self');
  });

  it('gives duplicate group ids a new id instead of dropping groups', () => {
    const { state: loaded } = parseProject(
      project(
        [object('a', { groupId: 'g' })],
        [
          { id: 'g', name: 'Erste', parentId: null },
          { id: 'g', name: 'Zweite', parentId: 'g' },
        ],
      ),
    );
    expect(loaded.groupOrder).toHaveLength(2);
    const [first, second] = loaded.groupOrder;
    expect(first).toBe('g');
    expect(second).not.toBe('g');
    expect(loaded.groups[second]).toEqual({ id: second, name: 'Zweite', parentId: 'g' });
    expect(loaded.objects.a.groupId).toBe('g');
    expect(invariantErrors(loaded)).toEqual([]);
  });

  it('still rejects malformed group data', () => {
    const invalid = /^Not a valid Tessel file: /;
    expect(() => parseProject(project([], {}))).toThrow(invalid);
    expect(() => parseProject(project([], [{ id: '', name: 'G' }]))).toThrow(invalid);
    expect(() => parseProject(project([], [{ id: 'g' }]))).toThrow(invalid);
    expect(() => parseProject(project([object('a', { groupId: 5 })]))).toThrow(invalid);
  });
});
