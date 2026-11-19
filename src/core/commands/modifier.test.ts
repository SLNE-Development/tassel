import { beforeEach, describe, expect, it } from 'vitest';
import { boundingBox } from '../mesh/polymesh';
import { evaluateObject, initModifiers } from '../modifiers/evaluate';
import { cutCube, isClosedManifold, volume } from '../modifiers/testing';
import { parseProject, serializeProject } from '../project';
import { activeDoc, createAppState, withDoc } from '../state';
import type { AppState, DocState, PolyMesh } from '../types';
import { documentCommands } from './document';
import { modifierCommands } from './modifier';
import { runCommand, type AnyCommand, type CommandContext } from './registry';
import { sceneCommands } from './scene';

const byId = new Map<string, AnyCommand>([...documentCommands, ...sceneCommands, ...modifierCommands].map((c) => [c.id, c]));

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
const modifiers = (id: string) => state().objects[id].modifiers;
const evaluated = (id: string) => evaluateObject(state(), id);

async function add(type = 'cube', params: Record<string, unknown> = {}): Promise<string> {
  return (await run('scene.add_primitive', { type, ...params })).id;
}

/** Replaces an object's base mesh without going through a command. */
function setMesh(id: string, mesh: PolyMesh): void {
  const s = state();
  app = withDoc(app, { ...doc(), state: { ...s, objects: { ...s.objects, [id]: { ...s.objects[id], mesh } } } });
}

beforeEach(() => {
  app = createAppState();
});

describe('modifier.add', () => {
  it('adds modifiers with defaults to the active object, in order', async () => {
    const a = await add();
    const mirror = await run('modifier.add', { type: 'mirror' });
    const subdivision = await run('modifier.add', { type: 'subdivision' });
    const array = await run('modifier.add', { type: 'array' });
    const boolean = await run('modifier.add', { type: 'boolean' });
    expect(modifiers(a)).toEqual([
      { id: mirror.id, enabled: true, type: 'mirror', axes: { x: true, y: false, z: false }, mergeDistance: 0.001 },
      { id: subdivision.id, enabled: true, type: 'subdivision', levels: 1 },
      { id: array.id, enabled: true, type: 'array', count: 2, offset: [2, 0, 0], rotation: [0, 0, 0], pivot: [0, 0, 0], offsetSpace: 'local' },
      { id: boolean.id, enabled: true, type: 'boolean', operation: 'difference', targetId: null },
    ]);
    expect(new Set(modifiers(a).map((m) => m.id)).size).toBe(4);
    expect(mirror).toEqual({ id: expect.any(String), objectId: a });
    expect(boolean).toEqual({ id: expect.any(String), objectId: a, error: expect.stringMatching(/No target/) });
  });

  it('takes the type parameters flat and an explicit object', async () => {
    const a = await add();
    const b = await add();
    await run('modifier.add', { objectId: a, type: 'mirror', axes: { y: true }, mergeDistance: 0.01 });
    await run('modifier.add', { objectId: a, type: 'array', count: 3, offset: [0, 3, 0] });
    await run('modifier.add', { objectId: a, type: 'boolean', operation: 'union', targetId: b });
    expect(modifiers(a)).toMatchObject([
      { type: 'mirror', axes: { x: true, y: true, z: false }, mergeDistance: 0.01 },
      { type: 'array', count: 3, offset: [0, 3, 0] },
      { type: 'boolean', operation: 'union', targetId: b },
    ]);
    expect(modifiers(b)).toEqual([]);
  });

  it('rejects invalid input without changing anything', async () => {
    const a = await add();
    const before = app;
    await expect(run('modifier.add', { type: 'mirror', levels: 2 })).rejects.toThrow(/"levels" is not a parameter of a mirror modifier/);
    await expect(run('modifier.add', { type: 'subdivision', levels: 9 })).rejects.toThrow();
    await expect(run('modifier.add', { type: 'bend' })).rejects.toThrow();
    await expect(run('modifier.add', { type: 'boolean', targetId: a })).rejects.toThrow(/its own/);
    await expect(run('modifier.add', { type: 'boolean', targetId: 'nope' })).rejects.toThrow(/does not exist/);
    await expect(run('modifier.add', { objectId: 'nope', type: 'mirror' })).rejects.toThrow(/does not exist/);
    expect(app).toBe(before);
    await run('scene.select', { ids: [] });
    await expect(run('modifier.add', { type: 'mirror' })).rejects.toThrow(/no active object/);
  });

  it('is one undo step', async () => {
    const a = await add();
    const { id } = await run('modifier.add', { type: 'subdivision', levels: 2 });
    expect(doc().past).toHaveLength(2);
    expect(evaluated(a).mesh.faces).toHaveLength(96);
    await run('history.undo');
    expect(modifiers(a)).toEqual([]);
    expect(evaluated(a).mesh).toBe(state().objects[a].mesh);
    await run('history.redo');
    expect(modifiers(a)).toMatchObject([{ id, levels: 2 }]);
  });

  it('evaluates a boolean right away, without a separate initModifiers call', async () => {
    const a = await add();
    const b = await add('cube', { position: [1, 0, 0] });
    const result = await run('modifier.add', { objectId: a, type: 'boolean', targetId: b });
    expect(result).toEqual({ id: expect.any(String), objectId: a });
    expect(volume(evaluated(a).mesh)).toBeCloseTo(4, 4);

    const plane = await add('plane');
    const failed = await run('modifier.add', { objectId: a, type: 'boolean', targetId: plane });
    expect(failed.error).toMatch(/target mesh is not a closed manifold/);
    expect(evaluated(a).errors).toEqual({ [failed.id]: failed.error });
    expect(volume(evaluated(a).mesh)).toBeCloseTo(4, 4);
  });
});

describe('modifier.update', () => {
  it('changes only the given parameters', async () => {
    const a = await add();
    const { id } = await run('modifier.add', { type: 'mirror' });
    const first = modifiers(a)[0];
    await run('modifier.update', { modifierId: id, axes: { z: true, x: false } });
    expect(modifiers(a)).toEqual([{ ...first, axes: { x: false, y: false, z: true } }]);
    await run('modifier.update', { modifierId: id, mergeDistance: 0.5, enabled: false });
    expect(modifiers(a)).toEqual([{ ...first, axes: { x: false, y: false, z: true }, mergeDistance: 0.5, enabled: false }]);
    await run('modifier.update', { objectId: a, modifierId: id, enabled: true });
    expect(modifiers(a)[0]).toMatchObject({ enabled: true, mergeDistance: 0.5 });

    await run('history.undo');
    expect(modifiers(a)[0].enabled).toBe(false);
    await run('history.undo');
    await run('history.undo');
    expect(modifiers(a)).toEqual([first]);
  });

  it('keeps the other modifiers and their identity', async () => {
    const a = await add();
    const one = await run('modifier.add', { type: 'subdivision' });
    const two = await run('modifier.add', { type: 'array' });
    const before = modifiers(a);
    await run('modifier.update', { modifierId: two.id, count: 4 });
    expect(modifiers(a)[0]).toBe(before[0]);
    expect(modifiers(a)).toMatchObject([{ id: one.id }, { id: two.id, count: 4, offset: [2, 0, 0] }]);
    expect(evaluated(a).mesh.faces).toHaveLength(24 * 4);
  });

  it('disabling skips the modifier', async () => {
    const a = await add();
    const { id } = await run('modifier.add', { type: 'subdivision' });
    await run('modifier.update', { modifierId: id, enabled: false });
    expect(evaluated(a).mesh).toBe(state().objects[a].mesh);
  });

  it('rejects invalid input', async () => {
    const a = await add();
    const { id } = await run('modifier.add', { type: 'array' });
    const before = app;
    await expect(run('modifier.update', { modifierId: id, levels: 2 })).rejects.toThrow(/not a parameter of a array modifier/);
    await expect(run('modifier.update', { modifierId: id, count: 0 })).rejects.toThrow();
    await expect(run('modifier.update', { modifierId: 'nope', count: 3 })).rejects.toThrow(/has no modifier/);
    expect(app).toBe(before);
    expect(modifiers(a)).toHaveLength(1);
  });

  it('reports a boolean cycle as an error and clears the target with null', async () => {
    const a = await add();
    const b = await add('cube', { position: [1, 0, 0] });
    const onA = await run('modifier.add', { objectId: a, type: 'boolean', targetId: b });
    const onB = await run('modifier.add', { objectId: b, type: 'boolean', targetId: a });
    expect(onB.error).toMatch(/cycle/);
    expect(evaluated(a).errors[onA.id]).toMatch(/cycle/);
    expect(await run('modifier.update', { objectId: b, modifierId: onB.id, targetId: null })).toEqual({
      id: onB.id,
      objectId: b,
      error: expect.stringMatching(/No target/),
    });
    expect(evaluated(a).errors).toEqual({});
    expect(volume(evaluated(a).mesh)).toBeCloseTo(4, 4);
    expect(await run('modifier.update', { objectId: a, modifierId: onA.id, operation: 'union' })).toEqual({ id: onA.id, objectId: a });
    expect(volume(evaluated(a).mesh)).toBeCloseTo(12, 4);
  });
});

describe('modifier.move and modifier.remove', () => {
  it('reorders the stack', async () => {
    const a = await add();
    setMesh(a, cutCube([0]));
    const mirror = (await run('modifier.add', { type: 'mirror' })).id;
    const subdivision = (await run('modifier.add', { type: 'subdivision' })).id;
    const array = (await run('modifier.add', { type: 'array' })).id;
    const ids = () => modifiers(a).map((m) => m.id);
    const mirrorFirst = evaluated(a).mesh;

    expect(await run('modifier.move', { modifierId: mirror, index: 1 })).toEqual({ index: 1 });
    expect(ids()).toEqual([subdivision, mirror, array]);
    expect(evaluated(a).mesh.positions).not.toEqual(mirrorFirst.positions);
    expect(await run('modifier.move', { modifierId: array, index: 0 })).toEqual({ index: 0 });
    expect(ids()).toEqual([array, subdivision, mirror]);
    expect(await run('modifier.move', { modifierId: array, index: 99 })).toEqual({ index: 2 });
    expect(ids()).toEqual([subdivision, mirror, array]);

    const past = doc().past.length;
    await run('modifier.move', { modifierId: array, index: 2 });
    expect(doc().past).toHaveLength(past);
    await run('history.undo');
    expect(ids()).toEqual([array, subdivision, mirror]);
    await run('history.undo');
    await run('history.undo');
    expect(ids()).toEqual([mirror, subdivision, array]);
    expect(evaluated(a).mesh).toBe(mirrorFirst);
    await expect(run('modifier.move', { modifierId: 'nope', index: 0 })).rejects.toThrow(/has no modifier/);
  });

  it('removes a modifier', async () => {
    const a = await add();
    const one = (await run('modifier.add', { type: 'subdivision' })).id;
    const two = (await run('modifier.add', { type: 'array' })).id;
    await run('modifier.remove', { modifierId: one });
    expect(modifiers(a).map((m) => m.id)).toEqual([two]);
    expect(evaluated(a).mesh.faces).toHaveLength(12);
    await expect(run('modifier.remove', { modifierId: one })).rejects.toThrow(/has no modifier/);
    await run('history.undo');
    expect(modifiers(a).map((m) => m.id)).toEqual([one, two]);
  });
});

describe('modifier.apply', () => {
  it('bakes the modifier into the base mesh and removes it', async () => {
    const a = await add();
    setMesh(a, cutCube([0]));
    const base = state().objects[a].mesh;
    const mirror = (await run('modifier.add', { type: 'mirror' })).id;
    const subdivision = (await run('modifier.add', { type: 'subdivision' })).id;
    const before = evaluated(a).mesh;

    expect(await run('modifier.apply', { modifierId: mirror })).toEqual({ objectId: a, vertices: 12, faces: 10 });
    expect(modifiers(a).map((m) => m.id)).toEqual([subdivision]);
    expect(isClosedManifold(state().objects[a].mesh)).toBe(true);
    expect(boundingBox(state().objects[a].mesh)).toEqual({ min: [-1, -1, -1], max: [1, 1, 1] });
    expect(evaluated(a).mesh).toEqual(before);

    await run('history.undo');
    expect(state().objects[a].mesh).toBe(base);
    expect(modifiers(a).map((m) => m.id)).toEqual([mirror, subdivision]);

    // Applying a later modifier uses the base mesh, as if it were first in the stack.
    await run('modifier.apply', { modifierId: subdivision });
    expect(state().objects[a].mesh.faces).toHaveLength(20);
    expect(modifiers(a).map((m) => m.id)).toEqual([mirror]);
  });

  it('applies a boolean and no longer depends on the target', async () => {
    const a = await add();
    const b = await add('cube', { position: [1, 0, 0] });
    const { id } = await run('modifier.add', { objectId: a, type: 'boolean', targetId: b });
    await run('modifier.apply', { objectId: a, modifierId: id });
    expect(modifiers(a)).toEqual([]);
    await run('scene.delete_objects', { ids: [b] });
    expect(volume(state().objects[a].mesh)).toBeCloseTo(4, 4);
    expect(evaluated(a)).toEqual({ mesh: state().objects[a].mesh, errors: {} });
  });

  it('fails when the modifier cannot be evaluated', async () => {
    const a = await add();
    const { id } = await run('modifier.add', { type: 'boolean' });
    const before = app;
    await expect(run('modifier.apply', { modifierId: id })).rejects.toThrow(/No target/);
    await expect(run('modifier.apply', { modifierId: 'nope' })).rejects.toThrow(/has no modifier/);
    expect(app).toBe(before);
    expect(modifiers(a)).toHaveLength(1);
  });

  it('is refused while the object is in edit mode', async () => {
    const a = await add();
    const b = await add();
    const onA = (await run('modifier.add', { objectId: a, type: 'subdivision' })).id;
    const onB = (await run('modifier.add', { objectId: b, type: 'subdivision' })).id;
    const edit = { objectId: a, elementMode: 'vertex' as const, vertices: [], edges: [], faces: [] };
    app = withDoc(app, { ...doc(), state: { ...state(), edit } });
    const before = app;
    await expect(run('modifier.apply', { objectId: a, modifierId: onA })).rejects.toThrow(/edit mode/);
    expect(app).toBe(before);
    await run('modifier.apply', { objectId: b, modifierId: onB });
    expect(modifiers(b)).toEqual([]);
    expect(state().edit).toEqual(edit);
  });
});

describe('boolean targets and the scene', () => {
  it('deleting the target leaves a no-op with an error; undo restores the result', async () => {
    const a = await add();
    const b = await add('cube', { position: [1, 0, 0] });
    const { id } = await run('modifier.add', { objectId: a, type: 'boolean', targetId: b });
    const cut = evaluated(a);
    await run('scene.delete_objects', { ids: [b] });
    expect(evaluated(a).mesh).toBe(state().objects[a].mesh);
    expect(evaluated(a).errors[id]).toMatch(/does not exist/);
    const info = await run('scene.get_object', { id: a });
    expect(info.errors).toEqual({ [id]: expect.stringMatching(/does not exist/) });
    expect(info.evaluated).toEqual({ vertices: 8, edges: 12, faces: 6, triangles: 12 });
    await run('history.undo');
    expect(evaluated(a)).toEqual(cut);
  });

  it('follows the target when it moves', async () => {
    const a = await add();
    const b = await add('cube', { position: [1, 0, 0] });
    await run('modifier.add', { objectId: a, type: 'boolean', targetId: b });
    await run('scene.set_transform', { items: [{ id: b, position: [1.5, 0, 0] }] });
    expect(volume(evaluated(a).mesh)).toBeCloseTo(6, 4);
    await run('scene.set_transform', { items: [{ id: b, position: [5, 0, 0] }] });
    expect(volume(evaluated(a).mesh)).toBeCloseTo(8, 4);
  });
});

describe('scene.get_object and scene.set_smooth', () => {
  it('get_object reports modifiers, smooth and the evaluated statistics', async () => {
    const a = await add();
    const plain = await run('scene.get_object', { id: a });
    expect(plain).toMatchObject({ vertices: 8, faces: 6, smooth: false, modifiers: [], errors: {} });
    expect(plain.evaluated).toEqual({ vertices: 8, edges: 12, faces: 6, triangles: 12 });

    const { id } = await run('modifier.add', { type: 'subdivision' });
    const before = app;
    const info = await run('scene.get_object', { id: a, includeMesh: true });
    expect(info).toMatchObject({ vertices: 8, edges: 12, faces: 6, triangles: 12, errors: {} });
    expect(info.modifiers).toEqual([{ id, enabled: true, type: 'subdivision', levels: 1 }]);
    expect(info.evaluated).toEqual({ vertices: 26, edges: 48, faces: 24, triangles: 48 });
    expect(info.mesh).toBe(state().objects[a].mesh);
    expect(app).toBe(before);
  });

  it('get_object evaluates booleans', async () => {
    const a = await add();
    const b = await add('cube', { position: [1, 0, 0] });
    await run('modifier.add', { objectId: a, type: 'boolean', targetId: b });
    const info = await run('scene.get_object', { id: a });
    expect(info.errors).toEqual({});
    expect(info.evaluated.faces).toBe(evaluated(a).mesh.faces.length);
    expect(info.evaluated.faces).toBeGreaterThan(6);
  });

  it('set_smooth changes the selection or the given objects, undoably', async () => {
    const a = await add();
    const b = await add();
    await run('scene.set_smooth', { smooth: true });
    expect([state().objects[a].smooth, state().objects[b].smooth]).toEqual([false, true]);
    await run('scene.set_smooth', { ids: [a, b], smooth: true });
    expect((await run('scene.get_object', { id: a })).smooth).toBe(true);
    await run('scene.set_smooth', { ids: [b], smooth: false });
    expect([state().objects[a].smooth, state().objects[b].smooth]).toEqual([true, false]);
    await run('history.undo');
    await run('history.undo');
    expect([state().objects[a].smooth, state().objects[b].smooth]).toEqual([false, true]);
    await expect(run('scene.set_smooth', { ids: ['nope'], smooth: true })).rejects.toThrow(/does not exist/);
    await run('scene.select', { ids: [] });
    await expect(run('scene.set_smooth', { smooth: true })).rejects.toThrow(/nothing is selected/);
  });

  it('duplicates keep their modifiers', async () => {
    const a = await add();
    await run('modifier.add', { type: 'subdivision' });
    const copy = (await run('scene.duplicate_objects', { offset: [3, 0, 0] })).objects[0].id;
    expect(modifiers(copy)).toEqual(modifiers(a));
    expect(evaluated(copy)).toBe(evaluated(a));
  });
});

describe('project files', () => {
  it('round trips modifiers and smooth', async () => {
    await initModifiers();
    const a = await add();
    const b = await add('cube', { position: [1, 0, 0] });
    await run('modifier.add', { objectId: a, type: 'mirror', axes: { z: true }, mergeDistance: 0.02 });
    await run('modifier.add', { objectId: a, type: 'subdivision', levels: 2 });
    await run('modifier.add', { objectId: a, type: 'array', count: 3, offset: [0, 0, 4] });
    const { id } = await run('modifier.add', { objectId: a, type: 'boolean', operation: 'union', targetId: b });
    await run('modifier.update', { objectId: a, modifierId: id, enabled: false });
    await run('scene.set_smooth', { ids: [a], smooth: true });

    const loaded = parseProject(serializeProject(doc())).state;
    expect(loaded.objects).toEqual(state().objects);
    expect(loaded.order).toEqual(state().order);
    expect(loaded.objects[a].modifiers).toHaveLength(4);
    expect(loaded.objects[a].smooth).toBe(true);
    expect(evaluateObject(loaded, a).mesh).toEqual(evaluated(a).mesh);
  });

  it('loads boolean targets that point at missing objects', async () => {
    await initModifiers();
    const a = await add();
    const b = await add('cube', { position: [1, 0, 0] });
    const { id } = await run('modifier.add', { objectId: a, type: 'boolean', targetId: b });
    await run('scene.delete_objects', { ids: [b] });
    const loaded = parseProject(serializeProject(doc())).state;
    expect(loaded.objects[a].modifiers).toEqual([{ id, enabled: true, type: 'boolean', operation: 'difference', targetId: b }]);
    const result = evaluateObject(loaded, a);
    expect(result.mesh).toBe(loaded.objects[a].mesh);
    expect(result.errors[id]).toMatch(/does not exist/);
  });

  it('fills in defaults for files without modifiers and for sparse modifiers, and rejects broken ones', () => {
    const object = {
      id: 'a',
      name: 'A',
      visible: true,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      mesh: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], faces: [[0, 1, 2]] },
    };
    const file = (extra: object) => JSON.stringify({ format: 'tessel', version: 1, name: 'x', objects: [{ ...object, ...extra }] });
    expect(parseProject(file({})).state.objects.a).toMatchObject({ modifiers: [], smooth: false });
    const sparse = parseProject(file({ modifiers: [{ id: 'm', type: 'mirror' }, { id: 'b', type: 'boolean' }] })).state.objects.a;
    expect(sparse.modifiers).toEqual([
      { id: 'm', enabled: true, type: 'mirror', axes: { x: true, y: false, z: false }, mergeDistance: 0.001 },
      { id: 'b', enabled: true, type: 'boolean', operation: 'difference', targetId: null },
    ]);
    expect(() => parseProject(file({ modifiers: [{ id: 'm', type: 'twist' }] }))).toThrow(/Not a valid Tessel file/);
    expect(() => parseProject(file({ modifiers: [{ id: 'm', type: 'subdivision', levels: 50 }] }))).toThrow(/Not a valid Tessel file/);
  });
});
