// Name references in the existing command families, scene.list_objects filters, scene.select_by,
// material.replace and app.validate_commands.
import { beforeEach, describe, expect, it } from 'vitest';
import { activeDoc, createAppState } from '../state';
import type { AppState, BakeRequest, DocState } from '../types';
import { commands } from './index';
import { runCommand, type AnyCommand, type CommandContext } from './registry';

const byId = new Map<string, AnyCommand>(commands.map((c) => [c.id, c]));
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let app: AppState;
let bakes: BakeRequest[];
let framed: readonly string[] | null;
const ctx: CommandContext = {
  get: () => app,
  set: (update) => {
    app = update(app);
  },
  services: {
    viewport: {
      screenshot: async () => PNG,
      getCamera: () => ({ position: [0, 0, 5], target: [0, 0, 0] }),
      setCamera: () => {},
      setView: () => {},
      frame: (ids: readonly string[]) => {
        framed = ids;
      },
    } as unknown as CommandContext['services']['viewport'],
    exporter: null,
    baker: {
      async bake(_state, request) {
        bakes.push(request);
        return { data: PNG, coverage: 1, distance: 1 };
      },
    },
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function run(id: string, params?: unknown): Promise<any> {
  const def = byId.get(id);
  if (!def) throw new Error(`Unknown command ${id}`);
  return runCommand(def, ctx, params);
}

const doc = () => activeDoc(app);
const state = (): DocState => doc().state;
const obj = (id: string) => state().objects[id];

async function add(name: string, params: Record<string, unknown> = {}): Promise<string> {
  return (await run('scene.add_primitive', { type: 'cube', name, ...params })).id;
}

let belt1: string;
let belt2: string;
let wheel: string;
let steel: string;
let rubber: string;
let chassis: string;

beforeEach(async () => {
  app = createAppState();
  bakes = [];
  framed = null;
  belt1 = await add('Belt 1', { position: [2, 0, 0] });
  belt2 = await add('Belt 2', { position: [4, 0, 0] });
  wheel = await add('Wheel');
  steel = (await run('material.create', { name: 'Steel' })).id;
  rubber = (await run('material.create', { name: 'Rubber' })).id;
  chassis = (await run('group.create', { ids: [], name: 'Chassis' })).id;
});

describe('object, group and material names in the scene commands', () => {
  it('scene.* accept names and globs', async () => {
    expect((await run('scene.get_object', { id: 'Wheel' })).id).toBe(wheel);
    await expect(run('scene.get_object', { id: 'Belt *' })).rejects.toThrow(/matches 2 objects/);

    await run('scene.set_transform', { items: [{ id: 'Wheel', position: [0, 1, 0] }] });
    expect(obj(wheel).transform.position).toEqual([0, 1, 0]);
    await expect(run('scene.set_transform', { items: [{ id: 'Belt ?', position: [0, 1, 0] }] })).rejects.toThrow(/exactly one is needed/);

    await run('scene.set_visible', { ids: ['Belt *'], visible: false });
    expect([obj(belt1).visible, obj(belt2).visible, obj(wheel).visible]).toEqual([false, false, true]);
    await run('scene.set_smooth', { ids: ['Belt 1', wheel], smooth: true });
    expect([obj(belt1).smooth, obj(belt2).smooth, obj(wheel).smooth]).toEqual([true, false, true]);

    expect(await run('scene.select', { ids: ['Belt *'] })).toEqual({ selection: [belt1, belt2], activeId: belt2 });
    await expect(run('scene.select', { ids: ['Chain *'] })).rejects.toThrow(/does not exist/);
    expect(state().selection).toEqual([belt1, belt2]);

    expect((await run('scene.rename_object', { id: 'Wheel', name: 'Rad' })).id).toBe(wheel);
    expect(obj(wheel).name).toBe('Rad');

    const copies = (await run('scene.duplicate_objects', { ids: ['Belt *'], offset: [0, 0, 1] })).objects;
    expect(copies.map((c: { name: string }) => c.name)).toEqual(['Belt 1.001', 'Belt 2.001']);

    expect((await run('scene.delete_objects', { ids: ['Belt ?.001'] })).deleted).toHaveLength(2);
    expect(state().order).toEqual([belt1, belt2, wheel]);
  });

  it('scene.add_primitive takes the group and the material by name', async () => {
    const id = await add('Bolt', { groupId: 'Chassis', materialId: 'Ste*' });
    expect(obj(id).groupId).toBe(chassis);
    expect(obj(id).materialId).toBe(steel);
    await expect(add('Bolt', { groupId: 'chassis' })).rejects.toThrow('Group "chassis" does not exist');
  });

  it('group.* accept names', async () => {
    const belts = (await run('group.create', { ids: ['Belt *'], name: 'Belts', parentId: 'Chassis' })).id;
    expect(state().groups[belts].parentId).toBe(chassis);
    expect([obj(belt1).groupId, obj(belt2).groupId, obj(wheel).groupId]).toEqual([belts, belts, null]);

    await run('group.move', { objectIds: ['Wheel'], targetGroupId: 'Belts' });
    expect(obj(wheel).groupId).toBe(belts);
    await run('group.move', { groupIds: ['Belts'], targetGroupId: null });
    expect(state().groups[belts].parentId).toBeNull();
    await expect(run('group.move', { groupIds: ['Chassis'], targetGroupId: 'Chassis' })).rejects.toThrow(/cannot be moved into itself/);

    expect((await run('group.select', { id: 'Belts' })).selection).toEqual([belt1, belt2, wheel]);
    await run('group.set_visible', { id: 'Bel*', visible: false });
    expect(obj(belt1).visible).toBe(false);
    expect(await run('group.rename', { id: 'Belts', name: 'Riemen' })).toEqual({ id: belts, name: 'Riemen' });
    await run('group.ungroup', { id: 'Riemen' });
    expect(state().groups[belts]).toBeUndefined();
    expect(obj(belt1).groupId).toBeNull();
    expect((await run('group.delete', { id: 'Chassis' })).deletedGroups).toEqual([chassis]);

    await run('group.create', { ids: [], name: 'Wheels front' });
    await run('group.create', { ids: [], name: 'Wheels rear' });
    await expect(run('group.select', { id: 'Wheels *' })).rejects.toThrow(/matches 2 groups/);
  });

  it('material.* accept names', async () => {
    expect(await run('material.assign', { materialId: 'Steel', ids: ['Belt *'] })).toEqual({ materialId: steel, ids: [belt1, belt2] });
    expect(obj(belt1).materialId).toBe(steel);

    expect((await run('material.update', { id: 'Steel', metallic: 1 })).id).toBe(steel);
    expect(state().materials[steel].metallic).toBe(1);

    const copy = (await run('material.duplicate', { id: 'Rubber' })).id;
    expect(state().materials[copy].name).toBe('Rubber.001');
    await expect(run('material.update', { id: 'Rubber*', metallic: 1 })).rejects.toThrow(/matches 2 materials/);

    const paint = (await run('material.create', { name: 'Paint', assignTo: ['Wheel'] })).id;
    expect(obj(wheel).materialId).toBe(paint);

    expect(await run('material.delete', { id: 'Steel' })).toEqual({ deleted: steel, unassigned: [belt1, belt2] });
    expect(state().materials[steel]).toBeUndefined();
  });

  it('edit.enter accepts a name', async () => {
    expect((await run('edit.enter', { id: 'Belt 2' })).objectId).toBe(belt2);
    expect(state().edit?.objectId).toBe(belt2);
    await run('edit.exit');
    await expect(run('edit.enter', { id: 'Belt *' })).rejects.toThrow(/matches 2 objects/);
  });

  it('modifier.* accept names for the object and the boolean target', async () => {
    const { id } = await run('modifier.add', { objectId: 'Wheel', type: 'boolean', operation: 'difference', targetId: 'Belt 1' });
    expect(obj(wheel).modifiers).toEqual([expect.objectContaining({ id, type: 'boolean', targetId: belt1 })]);
    await run('modifier.update', { objectId: 'Wheel', modifierId: id, targetId: 'Belt 2' });
    expect(obj(wheel).modifiers[0]).toMatchObject({ targetId: belt2 });
    await expect(run('modifier.update', { objectId: 'Wheel', modifierId: id, targetId: 'Wheel' })).rejects.toThrow(/its own boolean target/);
    await expect(run('modifier.update', { objectId: 'Wheel', modifierId: id, targetId: 'Belt *' })).rejects.toThrow(/matches 2 objects/);
    await run('modifier.remove', { objectId: 'Whe*', modifierId: id });
    expect(obj(wheel).modifiers).toEqual([]);
  });

  it('uv.* accept a name', async () => {
    await run('uv.unwrap', { objectId: 'Wheel', method: 'box' });
    expect(obj(wheel).mesh.uvs).toBeTruthy();
    expect((await run('uv.get', { objectId: 'Wheel' })).charts).toBeGreaterThan(0);
    await run('uv.clear', { objectId: 'Wheel' });
    expect(obj(wheel).mesh.uvs).toBeFalsy();
  });

  it('bake.* accept names for the target, the sources and the included objects', async () => {
    await run('uv.unwrap', { objectId: 'Wheel', method: 'box' });
    await run('bake.normal', { targetId: 'Wheel', sourceIds: ['Belt *'], size: 16 });
    expect(bakes[0]).toMatchObject({ type: 'normal', targetId: wheel, sourceIds: [belt1, belt2] });
    expect(obj(wheel).materialId).not.toBeNull();
    await run('bake.ao', { targetId: wheel, includeIds: ['Belt 1', 'Wheel'], size: 16 });
    expect(bakes[1]).toMatchObject({ type: 'ao', targetId: wheel, includeIds: [belt1] });
    await expect(run('bake.normal', { targetId: 'Belt *', sourceIds: [wheel], size: 16 })).rejects.toThrow(/Target object: "Belt \*" matches 2 objects/);
    await expect(run('bake.normal', { targetId: 'Wheel', sourceIds: ['Chain *'], size: 16 })).rejects.toThrow(/Source object "Chain \*" does not exist/);
    await expect(run('bake.normal', { targetId: 'Wheel', sourceIds: ['Whe*'], size: 16 })).rejects.toThrow(/its own source/);
  });

  it('view.frame accepts names', async () => {
    await run('view.frame', { ids: ['Belt *'] });
    expect(framed).toEqual([belt1, belt2]);
    await expect(run('view.frame', { ids: ['nope'] })).rejects.toThrow('does not exist');
  });

  it('texture and paint commands take the material by name', async () => {
    ctx.services.imaging = { blank: async () => PNG, normalFromHeight: async () => PNG } as unknown as CommandContext['services']['imaging'];
    try {
      const created = await run('paint.create_texture', { width: 16, height: 16, materialId: 'Rubber', slot: 'baseColor' });
      expect(state().materials[rubber].maps.baseColor).toBe(created.id);
      await run('texture.normal_from_height', { sourceId: created.id, materialId: 'Steel' });
      expect(state().materials[steel].maps.normal).toEqual(expect.any(String));
    } finally {
      ctx.services.imaging = null;
    }
  });
});

describe('scene.list_objects', () => {
  let body: string;
  let bolt: string;

  beforeEach(async () => {
    // group.create leaves the outliner order as it is (group.move would put the moved objects last).
    body = (await run('group.create', { ids: [belt1], name: 'Body' })).id;
    await run('group.create', { ids: [belt2], name: 'Front', parentId: body });
    await run('material.assign', { materialId: steel, ids: [belt1, wheel] });
    bolt = await add('Bolt', { position: [10, 0, 0], scale: [2, 1, 1] });
    await run('scene.set_visible', { ids: [bolt], visible: false });
  });

  const idsOf = (result: { objects: { id: string }[] }) => result.objects.map((o) => o.id);

  it('lists everything without parameters, with the fields it always had plus total', async () => {
    const result = await run('scene.list_objects');
    expect(result.total).toBe(4);
    expect(idsOf(result)).toEqual([belt1, belt2, wheel, bolt]);
    expect(result.selection).toEqual(state().selection);
    expect(result.objects[0]).toMatchObject({
      id: belt1,
      name: 'Belt 1',
      visible: true,
      groupId: body,
      materialId: steel,
      transform: { position: [2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      vertices: 8,
      edges: 12,
      faces: 6,
    });
    expect(doc().past.length).toBeGreaterThan(0);
    const before = app;
    await run('scene.list_objects', { name: 'B*' });
    expect(app).toBe(before);
  });

  it('filters by name, group (recursive), material and visibility', async () => {
    expect(idsOf(await run('scene.list_objects', { name: 'Belt *' }))).toEqual([belt1, belt2]);
    expect(idsOf(await run('scene.list_objects', { name: 'B*' }))).toEqual([belt1, belt2, bolt]);
    expect(idsOf(await run('scene.list_objects', { name: 'belt *' }))).toEqual([]);
    expect(idsOf(await run('scene.list_objects', { groupId: body }))).toEqual([belt1, belt2]);
    expect(idsOf(await run('scene.list_objects', { groupId: 'Body' }))).toEqual([belt1, belt2]);
    expect(idsOf(await run('scene.list_objects', { groupId: 'Chassis' }))).toEqual([]);
    expect(idsOf(await run('scene.list_objects', { groupId: 'Front' }))).toEqual([belt2]);
    expect(idsOf(await run('scene.list_objects', { groupId: null }))).toEqual([wheel, bolt]);
    expect(idsOf(await run('scene.list_objects', { materialId: 'Steel' }))).toEqual([belt1, wheel]);
    expect(idsOf(await run('scene.list_objects', { materialId: null }))).toEqual([belt2, bolt]);
    expect(idsOf(await run('scene.list_objects', { visible: false }))).toEqual([bolt]);
    expect(idsOf(await run('scene.list_objects', { visible: true, materialId: steel, groupId: body }))).toEqual([belt1]);
    expect(await run('scene.list_objects', { name: 'Zzz*' })).toMatchObject({ total: 0, objects: [] });
    await expect(run('scene.list_objects', { groupId: 'nope' })).rejects.toThrow('Group "nope" does not exist');
    await expect(run('scene.list_objects', { materialId: 'nope' })).rejects.toThrow('Material "nope" does not exist');
  });

  it('pages through the filtered list', async () => {
    const first = await run('scene.list_objects', { limit: 3 });
    expect(first.total).toBe(4);
    expect(idsOf(first)).toEqual([belt1, belt2, wheel]);
    const second = await run('scene.list_objects', { offset: 3, limit: 3 });
    expect(second.total).toBe(4);
    expect(idsOf(second)).toEqual([bolt]);
    expect(idsOf(await run('scene.list_objects', { name: 'B*', offset: 1, limit: 1 }))).toEqual([belt2]);
    expect(await run('scene.list_objects', { offset: 99 })).toMatchObject({ total: 4, objects: [] });
    await expect(run('scene.list_objects', { limit: 0 })).rejects.toThrow();
    await expect(run('scene.list_objects', { offset: -1 })).rejects.toThrow();
  });

  it('adds world bounds on request', async () => {
    const plain = await run('scene.list_objects', { name: 'Bolt' });
    expect(plain.objects[0]).not.toHaveProperty('bounds');
    const result = await run('scene.list_objects', { name: 'Bolt', includeBounds: true });
    const { min, max } = result.objects[0].bounds;
    const size = max[1] - min[1];
    expect(min[0]).toBeCloseTo(10 - size);
    expect(max[0]).toBeCloseTo(10 + size);
    expect(min[1]).toBeCloseTo(-size / 2);
    expect(min[2]).toBeCloseTo(-size / 2);

    await run('scene.set_transform', { items: [{ id: bolt, rotation: [0, 0, 90], scale: [2, 1, 1] }] });
    const rotated = (await run('scene.list_objects', { name: 'Bolt', includeBounds: true })).objects[0].bounds;
    expect(rotated.max[1] - rotated.min[1]).toBeCloseTo(2 * size);
    expect(rotated.max[0] - rotated.min[0]).toBeCloseTo(size);

    // After modifiers: an array of 3 copies along x triples the extent.
    await run('scene.set_transform', { items: [{ id: bolt, rotation: [0, 0, 0], scale: [1, 1, 1] }] });
    await run('modifier.add', { objectId: bolt, type: 'array', count: 3, offset: [size, 0, 0] });
    const arrayed = (await run('scene.list_objects', { name: 'Bolt', includeBounds: true })).objects[0].bounds;
    expect(arrayed.max[0] - arrayed.min[0]).toBeCloseTo(3 * size);
  });
});

describe('scene.select_by', () => {
  beforeEach(async () => {
    await run('group.create', { ids: [belt1, belt2], name: 'Body' });
    await run('material.assign', { materialId: steel, ids: [belt2, wheel] });
    await run('scene.select', { ids: [wheel] });
  });

  it('selects by name, material and group', async () => {
    expect(await run('scene.select_by', { name: 'Belt *' })).toEqual({ matched: [belt1, belt2], selection: [belt1, belt2], activeId: belt2 });
    expect((await run('scene.select_by', { materialId: 'Steel' })).selection).toEqual([belt2, wheel]);
    expect((await run('scene.select_by', { materialId: null })).selection).toEqual([belt1]);
    expect((await run('scene.select_by', { groupId: 'Body' })).selection).toEqual([belt1, belt2]);
    expect((await run('scene.select_by', { groupId: null })).selection).toEqual([wheel]);
    expect((await run('scene.select_by', { groupId: 'Bo*', materialId: steel })).selection).toEqual([belt2]);
    expect(await run('scene.select_by', { groupId: chassis })).toEqual({ matched: [], selection: [], activeId: null });
  });

  it('combines with the selection by mode', async () => {
    expect((await run('scene.select_by', { name: 'Belt 1', mode: 'add' })).selection).toEqual([wheel, belt1]);
    expect((await run('scene.select_by', { name: 'Belt *', mode: 'toggle' })).selection).toEqual([wheel, belt2]);
    expect(await run('scene.select_by', { name: 'Wh*', mode: 'remove' })).toEqual({ matched: [wheel], selection: [belt2], activeId: belt2 });
    expect(await run('scene.select_by', { name: 'Zzz*' })).toEqual({ matched: [], selection: [], activeId: null });
  });

  it('is not an undo step, needs a filter and rejects unknown groups', async () => {
    const steps = doc().past.length;
    await run('scene.select_by', { name: 'Belt *' });
    expect(doc().past.length).toBe(steps);
    await expect(run('scene.select_by', {})).rejects.toThrow(/at least one of name, materialId, groupId/);
    await expect(run('scene.select_by', { groupId: 'nope' })).rejects.toThrow('Group "nope" does not exist');
    expect(state().selection).toEqual([belt1, belt2]);
  });

  it('leaves edit mode when the edited object is no longer the active one', async () => {
    await run('edit.enter', { id: wheel });
    await run('scene.select_by', { name: 'Belt 1' });
    expect(state().edit).toBeNull();
  });
});

describe('material.replace', () => {
  beforeEach(async () => {
    await run('material.assign', { materialId: steel, ids: [belt1, belt2] });
  });

  it('replaces a material on all objects in one undo step', async () => {
    const steps = doc().past.length;
    const selection = state().selection;
    expect(await run('material.replace', { from: 'Steel', to: 'Rubber' })).toEqual({ from: steel, to: rubber, ids: [belt1, belt2] });
    expect([obj(belt1).materialId, obj(belt2).materialId, obj(wheel).materialId]).toEqual([rubber, rubber, null]);
    expect(state().materials[steel]).toBeDefined();
    expect(state().selection).toEqual(selection);
    expect(doc().past.length).toBe(steps + 1);

    await run('history.undo');
    expect([obj(belt1).materialId, obj(belt2).materialId]).toEqual([steel, steel]);
    await run('history.redo');
    expect([obj(belt1).materialId, obj(belt2).materialId]).toEqual([rubber, rubber]);
  });

  it('can be limited to objects, and from / to may be null', async () => {
    expect((await run('material.replace', { from: steel, to: rubber, ids: ['Belt 2', wheel] })).ids).toEqual([belt2]);
    expect([obj(belt1).materialId, obj(belt2).materialId, obj(wheel).materialId]).toEqual([steel, rubber, null]);
    expect(await run('material.replace', { from: steel, to: null })).toEqual({ from: steel, to: null, ids: [belt1] });
    expect(obj(belt1).materialId).toBeNull();
    expect((await run('material.replace', { from: null, to: 'Steel' })).ids).toEqual([belt1, wheel]);
  });

  it('changes nothing and records no undo step when no object uses the material', async () => {
    const steps = doc().past.length;
    expect(await run('material.replace', { from: rubber, to: steel })).toEqual({ from: rubber, to: steel, ids: [] });
    expect(doc().past.length).toBe(steps);
  });

  it('rejects unknown materials, unknown objects and from = to', async () => {
    await expect(run('material.replace', { from: 'nope', to: rubber })).rejects.toThrow('Material "nope" does not exist');
    await expect(run('material.replace', { from: steel, to: 'toString' })).rejects.toThrow('does not exist');
    await expect(run('material.replace', { from: steel, to: rubber, ids: ['nope'] })).rejects.toThrow('Object "nope" does not exist');
    await expect(run('material.replace', { from: 'Steel', to: steel })).rejects.toThrow(/same material/);
    await expect(run('material.replace', { from: steel })).rejects.toThrow();
    expect(obj(belt1).materialId).toBe(steel);
  });
});

describe('app.validate_commands', () => {
  it('accepts valid commands without running them', async () => {
    const before = app;
    const result = await run('app.validate_commands', {
      commands: [
        { command: 'scene.add_primitive', params: { type: 'cube', name: 'New', position: [1, 2, 3] } },
        { command: 'scene.select_all' },
        { command: 'scene_set_visible', params: { ids: ['does not need to exist'], visible: false } },
        { command: 'material.assign', params: { materialId: '$ref', documentId: 'abc' } },
        { command: 'history.undo', params: null },
      ],
    });
    expect(result).toEqual({ valid: true, errors: [] });
    expect(app).toBe(before);
  });

  it('reports every invalid entry by index', async () => {
    const result = await run('app.validate_commands', {
      commands: [
        { command: 'scene.add_primitive', params: { type: 'cube' } },
        { command: 'scene.add_primitive', params: { type: 'dodecahedron', position: [1, 2] } },
        { command: 'scene.nope' },
        { command: 'toString' },
        { command: 'scene.set_visible', params: { ids: ['a'] } },
        { command: 'scene.set_visible', params: [1, 2] },
        { command: 'scene.select', params: { ids: [], documentId: 5 } },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.map((e: { index: number }) => e.index)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.errors[0].message).toMatch(/^scene\.add_primitive: invalid parameters:\n/);
    expect(result.errors[0].message).toContain('type');
    expect(result.errors[0].message).toContain('position');
    expect(result.errors[1].message).toBe('Unknown command "scene.nope"');
    expect(result.errors[2].message).toBe('Unknown command "toString"');
    expect(result.errors[3].message).toContain('visible');
    expect(result.errors[4].message).toBe('scene.set_visible: params must be an object');
    expect(result.errors[5].message).toBe('scene.select: documentId must be a string');
    expect(state().order).toHaveLength(3);
  });

  it('is not an undo step, validates its own shape and handles an empty list', async () => {
    expect(byId.get('app.validate_commands')!.history).toBe(false);
    expect(await run('app.validate_commands', { commands: [] })).toEqual({ valid: true, errors: [] });
    await expect(run('app.validate_commands', {})).rejects.toThrow();
    await expect(run('app.validate_commands', { commands: [{ params: {} }] })).rejects.toThrow();
    await expect(run('app.validate_commands', { commands: 'scene.select_all' })).rejects.toThrow();
  });
});

describe('descriptions', () => {
  it('say that names and globs are accepted where object ids are documented', () => {
    for (const [id, param] of [
      ['scene.delete_objects', 'ids'],
      ['scene.select', 'ids'],
      ['group.create', 'ids'],
      ['group.move', 'objectIds'],
      ['material.assign', 'ids'],
      ['material.replace', 'ids'],
      ['bake.normal', 'sourceIds'],
      ['bake.ao', 'includeIds'],
      ['view.frame', 'ids'],
    ]) {
      expect(byId.get(id)!.params.shape[param].description, `${id} ${param}`).toContain('ids, exact names or glob patterns such as "Belt *"');
    }
  });
});
