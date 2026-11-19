import { beforeEach, describe, expect, it } from 'vitest';
import { transformMatrix } from '../modifiers/boolean';
import { evaluateObject } from '../modifiers/evaluate';
import { isClosedManifold, volume } from '../modifiers/testing';
import { activeDoc, createAppState } from '../state';
import { applyMat, determinant } from '../transformMath';
import type { AppState, DocState, PolyMesh, Vec3 } from '../types';
import { commandsById } from './index';
import { runCommand, type CommandContext } from './registry';

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
  const def = commandsById.get(id);
  if (!def) throw new Error(`Unknown command ${id}`);
  return runCommand(def, ctx, params);
}

const doc = () => activeDoc(app);
const state = (): DocState => doc().state;
const obj = (id: string) => state().objects[id];

async function add(type = 'cube', params: Record<string, unknown> = {}): Promise<string> {
  return (await run('scene.add_primitive', { type, ...params })).id;
}

/** World-space positions of the object's evaluated mesh, one Vec3 per vertex. */
function worldVertices(id: string, s: DocState = state()): Vec3[] {
  const m = transformMatrix(s.objects[id].transform);
  const p = evaluateObject(s, id).mesh.positions;
  const out: Vec3[] = [];
  for (let i = 0; i < p.length; i += 3) out.push(applyMat(m, p[i], p[i + 1], p[i + 2]));
  return out;
}

/** Signed world-space volume as it is rendered: positive when the faces point outwards. */
function worldVolume(id: string): number {
  const o = obj(id);
  const mesh = evaluateObject(state(), id).mesh;
  const sign = determinant(transformMatrix(o.transform)) < 0 ? -1 : 1;
  return volume({ positions: worldVertices(id).flat(), faces: mesh.faces }) * sign;
}

function expectClose(actual: readonly number[], expected: readonly number[], digits = 5): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i], digits));
}

function expectSameVertices(actual: Vec3[], expected: Vec3[], digits = 5): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((v, i) => expectClose(v, expected[i], digits));
}

/** Runs the command, then checks that it was exactly one undo step and that undo / redo restore both states. */
async function expectOneUndoStep(command: () => Promise<unknown>): Promise<void> {
  const before = state();
  const steps = doc().past.length;
  await command();
  const after = state();
  expect(after).not.toBe(before);
  expect(doc().past).toHaveLength(steps + 1);
  await run('history.undo');
  expect(state()).toBe(before);
  await run('history.redo');
  expect(state()).toBe(after);
}

/** Checks that the command neither changes the document nor records history. */
async function expectUnchanged(command: () => Promise<unknown>): Promise<void> {
  const before = doc();
  await command();
  expect(doc().state).toBe(before.state);
  expect(doc().past).toBe(before.past);
}

const protoKeys = ['toString', 'constructor', '__proto__', 'hasOwnProperty'];

beforeEach(() => {
  app = createAppState();
});

describe('scene.transform_objects', () => {
  it('turns three cubes on the X axis onto the Z axis for 90° about Y, about the centre of their bounds', async () => {
    const ids = [await add('cube', { position: [-2, 0, 0] }), await add('cube'), await add('cube', { position: [2, 0, 0] })];
    const result = await run('scene.transform_objects', { ids, rotate: [0, 90, 0] });
    expect(ids.map((id) => obj(id).transform.position)).toEqual([
      [0, 0, 2],
      [0, 0, 0],
      [0, 0, -2],
    ]);
    for (const id of ids) {
      expect(obj(id).transform.rotation).toEqual([0, 90, 0]);
      expect(obj(id).transform.scale).toEqual([1, 1, 1]);
    }
    expect(result.ids).toEqual(ids);
    expect(result.pivot).toEqual([0, 0, 0]);
    expect(result.objects[0]).toEqual({ id: ids[0], name: 'Würfel', transform: obj(ids[0]).transform });
    expect(result.bounds).toEqual({ min: [-1, -1, -3], max: [1, 1, 3], center: [0, 0, 0], size: [2, 2, 6] });
  });

  it('applies scale, then rotation, then translation, about the given pivot', async () => {
    const id = await add('cube', { position: [1, 0, 0] });
    await run('scene.transform_objects', { ids: [id], pivot: [0, 0, 0], scale: 2, rotate: [0, 0, 90], translate: [0, 0, 5] });
    expect(obj(id).transform).toEqual({ position: [0, 2, 5], rotation: [0, 0, 90], scale: [2, 2, 2] });
  });

  it('scales non-uniformly along the world axes', async () => {
    const a = await add('cube', { position: [1, 1, 1] });
    await run('scene.transform_objects', { ids: [a], pivot: [0, 1, 1], scale: [3, 1, 1] });
    expect(obj(a).transform).toEqual({ position: [3, 1, 1], rotation: [0, 0, 0], scale: [3, 1, 1] });
  });

  it('reaches objects in nested groups through groupId (also by group name) and leaves the rest alone', async () => {
    const a = await add('cube');
    const b = await add('cube', { position: [4, 0, 0] });
    const c = await add('cube', { position: [8, 0, 0] });
    const outer = (await run('group.create', { ids: [a], name: 'Car' })).id;
    await run('group.create', { ids: [b], name: 'Wheels', parentId: outer });
    const result = await run('scene.transform_objects', { groupId: 'Car', translate: [0, 1, 0] });
    expect(result.ids).toEqual([a, b]);
    expect(obj(a).transform.position).toEqual([0, 1, 0]);
    expect(obj(b).transform.position).toEqual([4, 1, 0]);
    expect(obj(c).transform.position).toEqual([8, 0, 0]);
    // ids and groupId combine; a name pattern stands for all its matches.
    await run('scene.transform_objects', { ids: [c], groupId: outer, translate: [0, 1, 0] });
    expect([a, b, c].map((id) => obj(id).transform.position[1])).toEqual([2, 2, 1]);
    await run('scene.transform_objects', { ids: ['Würfel*'], translate: [0, -1, 0] });
    expect([a, b, c].map((id) => obj(id).transform.position[1])).toEqual([1, 1, 0]);
  });

  it('defaults to the selection, uses the evaluated mesh for the default pivot and keeps the selection', async () => {
    const a = await add('cube');
    // The array doubles the extent to x = -1 .. 5, so the centre of the bounds is x = 2.
    await run('modifier.add', { objectId: a, type: 'array', count: 2, offset: [4, 0, 0] });
    const result = await run('scene.transform_objects', { rotate: [0, 180, 0] });
    expect(result.pivot).toEqual([2, 0, 0]);
    expect(obj(a).transform.position).toEqual([4, 0, 0]);
    expect(state().selection).toEqual([a]);
  });

  it('is one undo step', async () => {
    const ids = [await add('cube'), await add('cube', { position: [3, 0, 0] })];
    await expectOneUndoStep(() => run('scene.transform_objects', { ids, rotate: [0, 0, 45], scale: [2, 1, 1], translate: [1, 2, 3] }));
  });

  it('rejects bad input', async () => {
    const a = await add('cube');
    await expect(run('scene.transform_objects', { ids: [a] })).rejects.toThrow('at least one of translate, rotate or scale');
    await expect(run('scene.transform_objects', { ids: [a], scale: [1, 0, 1] })).rejects.toThrow('must not be 0');
    await expect(run('scene.transform_objects', { ids: [a], translate: [0, Infinity, 0] })).rejects.toThrow();
    await expect(run('scene.transform_objects', { groupId: 'nope', translate: [0, 1, 0] })).rejects.toThrow('does not exist');
    const empty = (await run('group.create', { ids: [], name: 'Empty' })).id;
    await expect(run('scene.transform_objects', { groupId: empty, translate: [0, 1, 0] })).rejects.toThrow('contains no objects');
    await run('scene.select', { ids: [] });
    await expect(run('scene.transform_objects', { translate: [0, 1, 0] })).rejects.toThrow('nothing is selected');
    for (const id of protoKeys) {
      await expect(run('scene.transform_objects', { ids: [id], translate: [0, 1, 0] })).rejects.toThrow('does not exist');
      await expect(run('scene.transform_objects', { groupId: id, translate: [0, 1, 0] })).rejects.toThrow('does not exist');
    }
  });
});

describe('scene.apply_transform', () => {
  it('bakes rotation and scale: the world-space vertices stay where they are and the faces keep pointing outwards', async () => {
    const id = await add('cone', { position: [1, 2, 3], rotation: [30, 40, 50], scale: [1, 2, -3], segments: 8 });
    const before = worldVertices(id);
    expect(worldVolume(id)).toBeGreaterThan(0);
    const result = await run('scene.apply_transform', { ids: [id] });
    expect(obj(id).transform).toEqual({ position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] });
    expectSameVertices(worldVertices(id), before);
    // The negative scale is gone, so the mesh itself must now be wound outwards.
    expect(volume(obj(id).mesh)).toBeGreaterThan(0);
    expect(isClosedManifold(obj(id).mesh)).toBe(true);
    expect(result.applied).toBe(1);
    expect(result.objects).toEqual([{ id, name: 'Kegel', transform: obj(id).transform }]);
  });

  it('bakes the position too when asked', async () => {
    const id = await add('cube', { position: [1, 2, 3], rotation: [0, 0, 90], scale: [2, 1, 1] });
    const before = worldVertices(id);
    const result = await run('scene.apply_transform', { position: true });
    expect(obj(id).transform).toEqual({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
    expectSameVertices(worldVertices(id), before);
    // 90° turns give clean coordinates: the cube spans x 0..2, y 0..4, z 2..4.
    expect(result.bounds).toEqual({ min: [0, 0, 2], max: [2, 4, 4], center: [1, 2, 3], size: [2, 4, 2] });
    expect(new Set(obj(id).mesh.positions)).toEqual(new Set([0, 2, 4]));
  });

  it('bakes any single part exactly, also rotation under a kept non-uniform scale', async () => {
    for (const part of ['position', 'rotation', 'scale']) {
      const id = await add('cone', { position: [1, 2, 3], rotation: [30, 40, 50], scale: [1, 2, 3], segments: 6 });
      const before = worldVertices(id);
      await run('scene.apply_transform', { ids: [id], position: false, rotation: false, scale: false, [part]: true });
      const t = obj(id).transform;
      expect(t.position).toEqual(part === 'position' ? [0, 0, 0] : [1, 2, 3]);
      expect(t.rotation).toEqual(part === 'rotation' ? [0, 0, 0] : [30, 40, 50]);
      expect(t.scale).toEqual(part === 'scale' ? [1, 1, 1] : [1, 2, 3]);
      expectSameVertices(worldVertices(id), before);
      expect(worldVolume(id)).toBeGreaterThan(0);
    }
  });

  it('keeps UVs and modifiers, and does nothing for an object that is already clean', async () => {
    const id = await add('cube', { scale: [2, 2, 2] });
    await run('uv.unwrap', { objectId: id, method: 'box' }).catch(() => run('uv.unwrap', { objectId: id }));
    await run('modifier.add', { objectId: id, type: 'array', count: 2, offset: [3, 0, 0] });
    const uvs = obj(id).mesh.uvs;
    expect(uvs).toBeDefined();
    await run('scene.apply_transform', { ids: [id] });
    expect(obj(id).mesh.uvs).toEqual(uvs);
    expect(obj(id).modifiers).toHaveLength(1);
    await expectUnchanged(async () => expect((await run('scene.apply_transform', { ids: [id] })).applied).toBe(0));
  });

  it('is one undo step for several objects', async () => {
    const ids = [await add('cube', { scale: [2, 1, 1] }), await add('cube', { rotation: [0, 45, 0] })];
    await expectOneUndoStep(() => run('scene.apply_transform', { ids }));
  });

  it('refuses edit mode, a kept zero scale and bad input', async () => {
    const id = await add('cube', { scale: [2, 1, 1] });
    await run('edit.enter', { id });
    await expect(run('scene.apply_transform', { ids: [id] })).rejects.toThrow('edit mode');
    await run('edit.exit');
    await expect(run('scene.apply_transform', { ids: [id], rotation: false, scale: false })).rejects.toThrow('Nothing to apply');
    const flat = await add('cube', { scale: [0, 1, 1], rotation: [0, 0, 30] });
    await expect(run('scene.apply_transform', { ids: [flat], scale: false })).rejects.toThrow('scale of 0');
    for (const key of protoKeys) await expect(run('scene.apply_transform', { ids: [key] })).rejects.toThrow('does not exist');
  });
});

describe('scene.mirror_objects', () => {
  const mirror = (v: Vec3, axis: number, at: number): Vec3 => v.map((c, i) => (i === axis ? 2 * at - c : c)) as Vec3;

  it('mirrors a rotated, non-uniformly scaled object exactly like mirroring its world-space vertices', async () => {
    for (const [axis, index] of [
      ['x', 0],
      ['y', 1],
      ['z', 2],
    ] as const) {
      const id = await add('cone', { position: [1, 2, 3], rotation: [30, 40, 50], scale: [1, 2, 3], segments: 6 });
      const expected = worldVertices(id).map((v) => mirror(v, index, 0.5));
      const pivot: Vec3 = [0.5, 0.5, 0.5];
      const result = await run('scene.mirror_objects', { ids: [id], axis, pivot, duplicate: false });
      expect(result.ids).toEqual([id]);
      expectSameVertices(worldVertices(id), expected, 4);
      // A proper transform again (the scale is untouched), with the faces still pointing outwards.
      expect(obj(id).transform.scale).toEqual([1, 2, 3]);
      expect(volume(obj(id).mesh)).toBeGreaterThan(0);
      expect(worldVolume(id)).toBeGreaterThan(0);
      expect(isClosedManifold(obj(id).mesh)).toBe(true);
    }
  });

  it('keeps an unrotated object unrotated and mirrors about the world origin by default', async () => {
    const id = await add('cone', { position: [3, 1, 0] });
    for (const axis of ['x', 'y', 'z']) await run('scene.mirror_objects', { ids: [id], axis, duplicate: false });
    expect(obj(id).transform).toEqual({ position: [-3, -1, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
    // Mirrored in Y: the apex now points down.
    const apex = worldVertices(id).at(-1)!;
    expectClose(apex, [-3, -2, 0]);
  });

  it('creates mirrored copies by default: selected, uniquely named, in the same group, originals untouched', async () => {
    const a = await add('cube', { position: [3, 0, 0], name: 'Wheel' });
    const b = await add('cube', { position: [5, 0, 1], name: 'Hub' });
    const group = (await run('group.create', { ids: [a], name: 'Left' })).id;
    const before = state();
    const result = await run('scene.mirror_objects', { ids: [a, b], axis: 'x', pivot: [1, 0, 0] });
    expect(result.objects.map((o: { name: string }) => o.name)).toEqual(['Wheel.001', 'Hub.001']);
    const [ca, cb] = result.ids;
    expect(state().order).toEqual([a, b, ca, cb]);
    expect(state().selection).toEqual([ca, cb]);
    expect(state().activeId).toBe(cb);
    expect(obj(a)).toBe(before.objects[a]);
    expect(obj(ca).transform.position).toEqual([-1, 0, 0]);
    expect(obj(cb).transform.position).toEqual([-3, 0, 1]);
    expect(obj(ca).groupId).toBe(group);
    expect(obj(cb).groupId).toBeNull();
    expect(result.bounds.min).toEqual([-4, -1, -1]);
    expect(result.bounds.max).toEqual([0, 1, 2]);
  });

  it('puts the copies into the given group', async () => {
    const a = await add('cube');
    const right = (await run('group.create', { ids: [], name: 'Right' })).id;
    const result = await run('scene.mirror_objects', { ids: [a], axis: 'x', groupId: 'Right' });
    expect(obj(result.ids[0]).groupId).toBe(right);
    await expect(run('scene.mirror_objects', { ids: [a], axis: 'x', groupId: right, duplicate: false })).rejects.toThrow('only used with duplicate');
  });

  it('mirrors UVs with their corners', async () => {
    // One triangle with a distinct UV per vertex.
    const src = await run('scene.add_mesh', {
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      faces: [[0, 1, 2]],
      uvs: [[0, 0, 1, 0, 0, 1]],
    });
    const copy = (await run('scene.mirror_objects', { ids: [src.id], axis: 'x' })).ids[0];
    const mesh = obj(copy).mesh;
    const uvOfVertex = new Map(mesh.faces[0].map((v, corner) => [v, mesh.uvs![0].slice(corner * 2, corner * 2 + 2)]));
    expect(uvOfVertex.get(0)).toEqual([0, 0]);
    expect(uvOfVertex.get(1)).toEqual([1, 0]);
    expect(uvOfVertex.get(2)).toEqual([0, 1]);
    // The winding is reversed, so the triangle still faces +Z.
    expect(mesh.faces[0]).toEqual([0, 2, 1]);
    expectSameVertices(worldVertices(copy), [
      [0, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
    ]);
  });

  it('mirrors array offsets and retargets booleans between mirrored objects', async () => {
    const a = await add('cube', { position: [3, 0, 0], rotation: [0, 0, 90] });
    await run('modifier.add', { objectId: a, type: 'array', count: 3, offset: [0, 2.5, 0] });
    const b = await add('cube', { position: [3, 0, 0], size: 1 });
    const { id: booleanId } = await run('modifier.add', { objectId: a, type: 'boolean', targetId: b });
    const expected = worldVertices(a).map((v) => mirror(v, 0, 0));
    const expectedCount = expected.length;
    const [ca, cb] = (await run('scene.mirror_objects', { ids: [a, b], axis: 'x' })).ids;
    const copied = obj(ca).modifiers;
    expect(copied.map((m) => m.type)).toEqual(['array', 'boolean']);
    expect(copied[1]).toMatchObject({ type: 'boolean', targetId: cb });
    expect(copied[1].id).not.toBe(booleanId);
    const world = worldVertices(ca);
    expect(world).toHaveLength(expectedCount);
    const box = (list: Vec3[]) => [0, 1, 2].map((i) => [Math.min(...list.map((v) => v[i])), Math.max(...list.map((v) => v[i]))]);
    box(world).forEach((range, i) => expectClose(range, box(expected)[i]));
  });

  it('is one undo step, with and without duplicate', async () => {
    const a = await add('cube', { position: [2, 0, 0], rotation: [10, 20, 30] });
    await expectOneUndoStep(() => run('scene.mirror_objects', { ids: [a], axis: 'z', pivot: [0, 0, 1] }));
    await expectOneUndoStep(() => run('scene.mirror_objects', { ids: [a], axis: 'y', duplicate: false }));
  });

  it('rejects bad input', async () => {
    const a = await add('cube');
    await expect(run('scene.mirror_objects', { ids: [a] })).rejects.toThrow();
    await expect(run('scene.mirror_objects', { ids: [a], axis: 'w' })).rejects.toThrow();
    await run('edit.enter', { id: a });
    await expect(run('scene.mirror_objects', { ids: [a], axis: 'x', duplicate: false })).rejects.toThrow('edit mode');
    for (const key of protoKeys) {
      await expect(run('scene.mirror_objects', { ids: [key], axis: 'x' })).rejects.toThrow('does not exist');
      await expect(run('scene.mirror_objects', { ids: [a], axis: 'x', groupId: key })).rejects.toThrow('does not exist');
    }
  });
});

describe('scene.add_mesh', () => {
  const tetra = {
    positions: [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    faces: [
      [0, 2, 1],
      [0, 1, 3],
      [1, 2, 3],
      [0, 3, 2],
    ],
  };
  // prettier-ignore
  const cubePositions = [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1];
  const cubeFaces = [
    [4, 5, 6, 7],
    [1, 0, 3, 2],
    [5, 1, 2, 6],
    [0, 4, 7, 3],
    [7, 6, 2, 3],
    [0, 1, 5, 4],
  ];

  it('creates a clean mesh from nested positions and reports statistics, bounds and no warnings', async () => {
    const result = await run('scene.add_mesh', { ...tetra, name: 'Tetra', position: [1, 0, 0], scale: 2 });
    expect(result).toMatchObject({
      id: expect.any(String),
      name: 'Tetra',
      vertices: 4,
      edges: 6,
      faces: 4,
      triangles: 4,
      transform: { position: [1, 0, 0], rotation: [0, 0, 0], scale: [2, 2, 2] },
      bounds: { min: [1, 0, 0], max: [3, 2, 2], center: [2, 1, 1], size: [2, 2, 2] },
      check: { closed: true, openEdges: 0, nonManifoldEdges: 0, flippedFaces: [], flippedFaceCount: 0 },
      warnings: [],
    });
    expect(obj(result.id).mesh).toEqual({ positions: tetra.positions.flat(), faces: tetra.faces });
    expect(state().selection).toEqual([result.id]);
    expect(state().activeId).toBe(result.id);
  });

  it('accepts flat positions, UVs, a group and a material by name, and smooth shading', async () => {
    const group = (await run('group.create', { ids: [], name: 'Parts' })).id;
    const material = (await run('material.create', { name: 'Steel' })).id;
    const uvs = cubeFaces.map(() => [0, 0, 1, 0, 1, 1, 0, 1]);
    const result = await run('scene.add_mesh', { positions: cubePositions, faces: cubeFaces, uvs, groupId: 'Parts', materialId: 'Steel', smooth: true });
    expect(result.name).toBe('Netz');
    expect(result.warnings).toEqual([]);
    expect(obj(result.id)).toMatchObject({ groupId: group, materialId: material, smooth: true });
    expect(obj(result.id).mesh.uvs).toEqual(uvs);
  });

  it('names the flipped face', async () => {
    const faces = cubeFaces.map((face, i) => (i === 2 ? [...face].reverse() : face));
    const result = await run('scene.add_mesh', { positions: cubePositions, faces });
    expect(result.check).toMatchObject({ closed: true, flippedFaces: [2], flippedFaceCount: 1 });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/Inconsistent winding: 1 face is wound opposite .*face index: 2\)/);
  });

  it('notices a mesh that is inside out', async () => {
    const result = await run('scene.add_mesh', { positions: cubePositions, faces: cubeFaces.map((face) => [...face].reverse()) });
    expect(result.check.flippedFaceCount).toBe(6);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('inside out');
  });

  it('reports open edges, non-manifold edges, faces without area and unused vertices', async () => {
    const open = await run('scene.add_mesh', { positions: cubePositions, faces: cubeFaces.slice(0, 5) });
    expect(open.check).toMatchObject({ closed: false, openEdges: 4, flippedFaceCount: 0 });
    expect(open.warnings).toHaveLength(1);
    expect(open.warnings[0]).toContain('not closed: 4 edges have only one face');

    // Three triangles around one edge, a zero-area triangle and a vertex nobody uses.
    const messy = await run('scene.add_mesh', {
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 2, 0, 0, 9, 9, 9],
      faces: [
        [0, 1, 2],
        [1, 0, 3],
        [0, 1, 4],
        [0, 1, 5],
      ],
    });
    expect(messy.check.nonManifoldEdges).toBe(1);
    const text = messy.warnings.join('\n');
    expect(text).toContain('1 edge is shared by more than two faces');
    expect(text).toContain('1 face has no area');
    expect(text).toContain('1 vertex is not used by any face');
  });

  it('validates the data', async () => {
    const bad = (params: Record<string, unknown>) => run('scene.add_mesh', { ...tetra, ...params });
    await expect(bad({ positions: [0, 0, 0, 1, 0, 0, 0, 1] })).rejects.toThrow('multiple of 3');
    await expect(bad({ faces: [[0, 1, 4]] })).rejects.toThrow('does not exist');
    await expect(bad({ faces: [[0, 1]] })).rejects.toThrow('Invalid mesh');
    await expect(bad({ faces: [[0, 1, 1, 0]] })).rejects.toThrow('face 0 [0, 1, 1, 0] needs at least 3 different vertices');
    await expect(bad({ faces: [] })).rejects.toThrow('at least 3 vertices and one face');
    await expect(bad({ faces: [[0, 1, -2]] })).rejects.toThrow();
    await expect(bad({ faces: [[0, 1, 2.5]] })).rejects.toThrow();
    await expect(bad({ positions: [0, 0, 0, 1, 0, 0, 0, NaN, 0] })).rejects.toThrow();
    await expect(bad({ positions: [[0, 0, 0], [1, 0], [0, 1, 0]] })).rejects.toThrow();
    await expect(bad({ positions: 'cube' })).rejects.toThrow();
    await expect(bad({ uvs: [[0, 0, 1, 0, 0, 1]] })).rejects.toThrow('one entry per face');
    await expect(bad({ uvs: tetra.faces.map(() => [0, 0, 1, 0]) })).rejects.toThrow('two numbers per face corner');
    await expect(bad({ scale: [1, 'x', 1] })).rejects.toThrow();
    for (const key of protoKeys) {
      await expect(bad({ groupId: key })).rejects.toThrow('does not exist');
      await expect(bad({ materialId: key })).rejects.toThrow('does not exist');
    }
    expect(state().order).toEqual([]);
    expect(doc().past).toHaveLength(0);
  });

  it('is one undo step', async () => {
    await expectOneUndoStep(() => run('scene.add_mesh', tetra));
  });
});

describe('scene.boolean', () => {
  it('cuts a temporary primitive out of the object and leaves no helper object', async () => {
    const id = await add('cube');
    const result = await run('scene.boolean', { objectId: id, cutter: { type: 'cube', size: 1, position: [1, 1, 1] } });
    expect(state().order).toEqual([id]);
    expect(volume(obj(id).mesh)).toBeCloseTo(8 - 0.125, 5);
    expect(isClosedManifold(obj(id).mesh)).toBe(true);
    expect(obj(id).modifiers).toEqual([]);
    expect(result).toMatchObject({ objectId: id, name: 'Würfel', operation: 'difference', applied: true, removed: [] });
    expect(result.targetId).toBeUndefined();
    expect(result.faces).toBe(obj(id).mesh.faces.length);
    expect(result.bounds).toEqual({ min: [-1, -1, -1], max: [1, 1, 1], center: [0, 0, 0], size: [2, 2, 2] });
    expect(state().selection).toEqual([id]);
  });

  it('places the cutter in world space, whatever the transform of the object', async () => {
    // The object spans x 3..7 in the world; the cutter takes away 0.5 x 1 x 1 at its +X end.
    const id = await add('cube', { position: [5, 0, 0], scale: [2, 1, 1] });
    await run('scene.boolean', { cutter: { type: 'cube', size: 1, position: [7, 0, 0] } });
    expect(worldVolume(id)).toBeCloseTo(16 - 0.5, 4);
    // Drilling through along Z with a rotated cylinder: a 16-gon prism of radius 0.5 and length 2.
    await run('scene.boolean', { objectId: id, cutter: { type: 'cylinder', radius: 0.5, height: 4, segments: 16, position: [4, 0, 0], rotation: [90, 0, 0] } });
    const hole = 0.5 * 16 * 0.25 * Math.sin((2 * Math.PI) / 16) * 2;
    expect(worldVolume(id)).toBeCloseTo(16 - 0.5 - hole, 4);
  });

  it('unions and intersects', async () => {
    const a = await add('cube');
    await run('scene.boolean', { objectId: a, operation: 'union', cutter: { type: 'cube', size: 1, position: [1, 1, 1] } });
    expect(volume(obj(a).mesh)).toBeCloseTo(8 + 1 - 0.125, 5);
    const b = await add('cube');
    await run('scene.boolean', { operation: 'intersect', cutter: { type: 'cube', size: 1, position: [1, 1, 1], scale: 1 } });
    expect(volume(obj(b).mesh)).toBeCloseTo(0.125, 5);
  });

  it('uses an existing object as target and removes it, unless keepTarget', async () => {
    const a = await add('cube');
    const b = await add('cube', { size: 1, position: [1, 1, 1], name: 'Cutter' });
    const c = await add('cube', { size: 1, position: [-1, -1, -1] });
    const first = await run('scene.boolean', { objectId: a, targetId: 'Cutter' });
    expect(first.removed).toEqual([b]);
    expect(state().order).toEqual([a, c]);
    expect(state().selection).toEqual([a]);
    expect(state().activeId).toBe(a);
    const second = await run('scene.boolean', { objectId: a, targetId: c, keepTarget: true });
    expect(second).toMatchObject({ removed: [], targetId: c });
    expect(state().order).toEqual([a, c]);
    expect(obj(c).visible).toBe(true);
    expect(volume(obj(a).mesh)).toBeCloseTo(8 - 0.25, 5);
    // keepTarget with a cutter turns the cutter into a real object.
    const third = await run('scene.boolean', { objectId: a, cutter: { type: 'cube', size: 1, position: [1, -1, 1] }, keepTarget: true });
    expect(state().order).toEqual([a, c, third.targetId]);
    expect(obj(third.targetId).transform.position).toEqual([1, -1, 1]);
  });

  it('adds a modifier and hides the target without apply', async () => {
    const a = await add('cube');
    const b = await add('cube', { size: 1, position: [1, 1, 1] });
    const result = await run('scene.boolean', { objectId: a, targetId: b, apply: false });
    expect(obj(a).modifiers).toEqual([{ id: result.modifierId, enabled: true, type: 'boolean', operation: 'difference', targetId: b }]);
    expect(obj(a).mesh.faces).toHaveLength(6);
    expect(obj(b).visible).toBe(false);
    expect(result).toMatchObject({ applied: false, targetId: b, removed: [] });
    expect(volume(evaluateObject(state(), a).mesh)).toBeCloseTo(8 - 0.125, 5);
    expect(result.faces).toBe(evaluateObject(state(), a).mesh.faces.length);

    const withCutter = await run('scene.boolean', { objectId: a, cutter: { type: 'cube', size: 1, position: [-1, -1, -1] }, apply: false });
    expect(state().order).toEqual([a, b, withCutter.targetId]);
    expect(obj(withCutter.targetId).visible).toBe(false);
    expect(volume(evaluateObject(state(), a).mesh)).toBeCloseTo(8 - 0.25, 5);
  });

  it('fails clearly and leaves the document unchanged when the boolean cannot be computed', async () => {
    const sheet = await add('plane');
    const cube = await add('cube');
    const cutter = { type: 'cube', size: 1 };
    await expectUnchanged(() => expect(run('scene.boolean', { objectId: sheet, cutter })).rejects.toThrow(/Boolean difference failed: The mesh is not a closed manifold.*The document was not changed/));
    await expectUnchanged(() => expect(run('scene.boolean', { objectId: sheet, cutter, apply: false })).rejects.toThrow('not a closed manifold'));
    await expectUnchanged(() => expect(run('scene.boolean', { objectId: cube, targetId: sheet })).rejects.toThrow('The target mesh is not a closed manifold'));
    // Nothing would remain.
    await expectUnchanged(() => expect(run('scene.boolean', { objectId: cube, cutter: { type: 'cube', size: 4 } })).rejects.toThrow('the result is empty'));
    await expectUnchanged(() => expect(run('scene.boolean', { objectId: cube, operation: 'intersect', cutter: { type: 'cube', position: [9, 0, 0] } })).rejects.toThrow('the result is empty'));
  });

  it('rejects bad input', async () => {
    const a = await add('cube');
    const b = await add('cube', { size: 1 });
    const cutter = { type: 'cube', size: 1 };
    await expect(run('scene.boolean', { objectId: a })).rejects.toThrow('exactly one of targetId or cutter');
    await expect(run('scene.boolean', { objectId: a, targetId: b, cutter })).rejects.toThrow('exactly one of targetId or cutter');
    await expect(run('scene.boolean', { objectId: a, targetId: a })).rejects.toThrow('its own boolean target');
    await expect(run('scene.boolean', { objectId: a, cutter: { type: 'teapot' } })).rejects.toThrow();
    await expect(run('scene.boolean', { objectId: a, cutter: { ...cutter, scale: [1, 0, 1] } })).rejects.toThrow('must not be 0');
    await expect(run('scene.boolean', { objectId: a, cutter, operation: 'xor' })).rejects.toThrow();
    for (const key of protoKeys) {
      await expect(run('scene.boolean', { objectId: key, cutter })).rejects.toThrow('does not exist');
      await expect(run('scene.boolean', { objectId: a, targetId: key })).rejects.toThrow('does not exist');
    }
    await run('edit.enter', { id: a });
    await expect(run('scene.boolean', { objectId: a, cutter })).rejects.toThrow('edit mode');
    await run('scene.select', { ids: [] });
    await expect(run('scene.boolean', { cutter })).rejects.toThrow('no active object');
  });

  it('is one undo step in every variant', async () => {
    const a = await add('cube');
    const b = await add('cube', { size: 1, position: [1, 1, 1] });
    await expectOneUndoStep(() => run('scene.boolean', { objectId: a, cutter: { type: 'cube', size: 1, position: [-1, 1, 1] } }));
    await expectOneUndoStep(() => run('scene.boolean', { objectId: a, cutter: { type: 'cube', size: 1, position: [-1, -1, 1] }, apply: false }));
    await expectOneUndoStep(() => run('scene.boolean', { objectId: a, targetId: b }));
  });
});

describe('scene.raycast', () => {
  it('hits a known point with the right normal, distance and face', async () => {
    const id = await add('cube');
    const result = await run('scene.raycast', { origin: [0.25, 5, -0.5], direction: [0, -10, 0] });
    expect(result).toEqual({
      hit: true,
      objectId: id,
      name: 'Würfel',
      point: [0.25, 1, -0.5],
      normal: [0, 1, 0],
      distance: 4,
      faceIndex: 4,
      frontFacing: true,
    });
  });

  it('finds the nearest object and respects hidden objects, ids and maxDistance', async () => {
    const ground = await add('cube', { name: 'Ground' });
    const roof = await add('cube', { name: 'Roof', position: [0, 5, 0] });
    const down = { origin: [0, 20, 0], direction: [0, -1, 0] };
    expect(await run('scene.raycast', down)).toMatchObject({ objectId: roof, point: [0, 6, 0], distance: 14 });
    expect(await run('scene.raycast', { ...down, ids: ['Ground'] })).toMatchObject({ objectId: ground, point: [0, 1, 0] });
    expect(await run('scene.raycast', { ...down, maxDistance: 13.9 })).toEqual({ hit: false });
    expect(await run('scene.raycast', { ...down, maxDistance: 14 })).toMatchObject({ objectId: roof });
    await run('scene.set_visible', { ids: [roof], visible: false });
    expect(await run('scene.raycast', down)).toMatchObject({ objectId: ground, distance: 19 });
    expect(await run('scene.raycast', { ...down, ids: [roof] })).toEqual({ hit: false });
    expect(await run('scene.raycast', { origin: [5, 20, 0], direction: [0, -1, 0] })).toEqual({ hit: false });
    expect(await run('scene.raycast', { origin: [0, 20, 0], direction: [0, 1, 0] })).toEqual({ hit: false });
  });

  it('reports the slope of a rotated surface in world space, and the outside of mirrored objects', async () => {
    await add('cube', { rotation: [0, 0, 45] });
    const slope = await run('scene.raycast', { origin: [0.5, 10, 0], direction: [0, -1, 0] });
    expectClose(slope.point, [0.5, Math.SQRT2 - 0.5, 0]);
    expectClose(slope.normal, [Math.SQRT1_2, Math.SQRT1_2, 0]);
    expect(slope.frontFacing).toBe(true);

    const mirrored = await add('cube', { position: [10, 0, 0], scale: [-1, 2, 1] });
    const top = await run('scene.raycast', { origin: [10, 9, 0], direction: [0, -1, 0], ids: [mirrored] });
    expect(top).toMatchObject({ point: [10, 2, 0], normal: [0, 1, 0], frontFacing: true });
    const inside = await run('scene.raycast', { origin: [10, 0, 0], direction: [1, 0, 0], ids: [mirrored] });
    expect(inside).toMatchObject({ point: [11, 0, 0], normal: [1, 0, 0], frontFacing: false, distance: 1 });
  });

  it('casts against the mesh after modifiers', async () => {
    const id = await add('cube');
    await run('modifier.add', { objectId: id, type: 'array', count: 2, offset: [5, 0, 0] });
    const result = await run('scene.raycast', { origin: [5, 9, 0], direction: [0, -1, 0] });
    expect(result).toMatchObject({ hit: true, objectId: id, point: [5, 1, 0], faceIndex: 10 });
  });

  it('changes nothing and rejects bad input', async () => {
    await add('cube');
    await expectUnchanged(() => run('scene.raycast', { origin: [0, 5, 0], direction: [0, -1, 0] }));
    await expect(run('scene.raycast', { origin: [0, 5, 0], direction: [0, 0, 0] })).rejects.toThrow('must not be [0, 0, 0]');
    await expect(run('scene.raycast', { origin: [0, 5, 0] })).rejects.toThrow();
    await expect(run('scene.raycast', { origin: [0, 5, 0], direction: [0, -1, 0], maxDistance: 0 })).rejects.toThrow();
    for (const key of protoKeys) await expect(run('scene.raycast', { origin: [0, 5, 0], direction: [0, -1, 0], ids: [key] })).rejects.toThrow('does not exist');
  });
});

describe('scene.get_bounds', () => {
  it('returns world boxes per object and their union', async () => {
    const a = await add('cube', { position: [3, 0, 0], scale: [1, 2, 1] });
    const b = await add('cube', { position: [0, 0, -4], rotation: [0, 90, 0], scale: [1, 1, 3], name: 'B' });
    await run('scene.set_visible', { ids: [b], visible: false });
    const result = await run('scene.get_bounds');
    expect(result).toEqual({
      objects: [
        { id: a, name: 'Würfel', visible: true, bounds: { min: [2, -2, -1], max: [4, 2, 1], center: [3, 0, 0], size: [2, 4, 2] } },
        { id: b, name: 'B', visible: false, bounds: { min: [-3, -1, -5], max: [3, 1, -3], center: [0, 0, -4], size: [6, 2, 2] } },
      ],
      bounds: { min: [-3, -2, -5], max: [4, 2, 1], center: [0.5, 0, -2], size: [7, 4, 6] },
    });
    expect((await run('scene.get_bounds', { ids: ['B'] })).bounds).toEqual(result.objects[1].bounds);
  });

  it('includes modifiers, and takes a group', async () => {
    const a = await add('cube');
    await run('modifier.add', { objectId: a, type: 'array', count: 3, offset: [2, 0, 0] });
    const b = await add('cube', { position: [0, 10, 0] });
    const group = (await run('group.create', { ids: [a], name: 'Row' })).id;
    const result = await run('scene.get_bounds', { groupId: group });
    expect(result.objects.map((o: { id: string }) => o.id)).toEqual([a]);
    expect(result.bounds).toEqual({ min: [-1, -1, -1], max: [5, 1, 1], center: [2, 0, 0], size: [6, 2, 2] });
    expect((await run('scene.get_bounds', { ids: [b], groupId: 'Row' })).objects).toHaveLength(2);
  });

  it('changes nothing, copes with an empty document and rejects unknown references', async () => {
    expect(await run('scene.get_bounds')).toEqual({ objects: [], bounds: null });
    await add('cube');
    await expectUnchanged(() => run('scene.get_bounds'));
    for (const key of protoKeys) {
      await expect(run('scene.get_bounds', { ids: [key] })).rejects.toThrow('does not exist');
      await expect(run('scene.get_bounds', { groupId: key })).rejects.toThrow('does not exist');
    }
  });
});

describe('scene.check_overlaps', () => {
  it('reports the pairs whose boxes overlap, with the overlap box and its volume', async () => {
    const a = await add('cube', { name: 'A' });
    const b = await add('cube', { name: 'B', position: [1.5, 0, 0] });
    const c = await add('cube', { name: 'C', position: [2, 1.5, 0] });
    await add('cube', { name: 'Far', position: [10, 0, 0] });
    const result = await run('scene.check_overlaps');
    // A-B overlap 0.5 x 2 x 2; B-C overlap 1.5 x 0.5 x 2; A and C only touch (x = 1).
    expect(result).toEqual({
      pairs: [
        { a: { id: a, name: 'A' }, b: { id: b, name: 'B' }, overlap: { min: [0.5, -1, -1], max: [1, 1, 1], size: [0.5, 2, 2] }, volume: 2 },
        { a: { id: b, name: 'B' }, b: { id: c, name: 'C' }, overlap: { min: [1, 0.5, -1], max: [2.5, 1, 1], size: [1.5, 0.5, 2] }, volume: 1.5 },
      ],
      total: 2,
      checked: 4,
    });
  });

  it('applies the tolerance, the limit, ids / groups and skips hidden objects by default', async () => {
    const a = await add('cube', { name: 'A' });
    const b = await add('cube', { name: 'B', position: [1.5, 0, 0] });
    const c = await add('cube', { name: 'C', position: [3.6, 0, 0] });
    const pairs = async (params: Record<string, unknown> = {}) =>
      (await run('scene.check_overlaps', params)).pairs.map((p: { a: { name: string }; b: { name: string } }) => p.a.name + p.b.name);
    expect(await pairs()).toEqual(['AB']);
    expect(await pairs({ tolerance: 0.5 })).toEqual([]);
    expect(await pairs({ tolerance: 0.49 })).toEqual(['AB']);
    // B ends at x = 2.5, C starts at 2.6: a gap of 0.1.
    expect(await pairs({ tolerance: -0.11 })).toEqual(['AB', 'BC']);
    const limited = await run('scene.check_overlaps', { tolerance: -0.11, limit: 1 });
    expect(limited.pairs).toHaveLength(1);
    expect(limited.total).toBe(2);
    expect(await pairs({ ids: [a, c] })).toEqual([]);
    const group = (await run('group.create', { ids: [a, b], name: 'G' })).id;
    expect((await run('scene.check_overlaps', { groupId: group })).checked).toBe(2);
    await run('scene.set_visible', { ids: [b], visible: false });
    expect(await pairs()).toEqual([]);
    expect(await pairs({ ids: [a, b] })).toEqual(['AB']);
  });

  it('changes nothing and rejects bad input', async () => {
    await add('cube');
    await expectUnchanged(() => run('scene.check_overlaps'));
    await expect(run('scene.check_overlaps', { limit: 0 })).rejects.toThrow();
    for (const key of protoKeys) {
      await expect(run('scene.check_overlaps', { ids: [key] })).rejects.toThrow('does not exist');
      await expect(run('scene.check_overlaps', { groupId: key })).rejects.toThrow('does not exist');
    }
  });
});

describe('richer results of existing commands', () => {
  it('scene.add_primitive and scene.duplicate_objects report transform and world bounds', async () => {
    const added = await run('scene.add_primitive', { type: 'cube', position: [1, 2, 3], scale: [1, 2, 1] });
    expect(added).toEqual({
      id: added.id,
      name: 'Würfel',
      transform: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 2, 1] },
      bounds: { min: [0, 0, 2], max: [2, 4, 4], center: [1, 2, 3], size: [2, 4, 2] },
    });
    const other = await add('cube', { position: [10, 0, 0] });
    const copies = await run('scene.duplicate_objects', { ids: [added.id, other], offset: [0, 10, 0] });
    expect(copies.objects).toEqual([
      {
        id: copies.objects[0].id,
        name: 'Würfel.002',
        transform: { position: [1, 12, 3], rotation: [0, 0, 0], scale: [1, 2, 1] },
        bounds: { min: [0, 10, 2], max: [2, 14, 4], center: [1, 12, 3], size: [2, 4, 2] },
      },
      {
        id: copies.objects[1].id,
        name: 'Würfel.003',
        transform: { position: [10, 10, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        bounds: { min: [9, 9, -1], max: [11, 11, 1], center: [10, 10, 0], size: [2, 2, 2] },
      },
    ]);
    expect(copies.bounds).toEqual({ min: [0, 9, -1], max: [11, 14, 4], center: [5.5, 11.5, 1.5], size: [11, 5, 5] });
    expect(state().selection).toEqual(copies.objects.map((o: { id: string }) => o.id));
  });

  it('duplicates of an object with a boolean modifier report the bounds of the evaluated mesh', async () => {
    const a = await add('cube');
    await run('scene.boolean', { objectId: a, operation: 'intersect', cutter: { type: 'cube', size: 1, position: [1, 1, 1] }, apply: false });
    const copies = await run('scene.duplicate_objects', { ids: [a] });
    expect(copies.objects[0].bounds).toEqual({ min: [0.5, 0.5, 0.5], max: [1, 1, 1], center: [0.75, 0.75, 0.75], size: [0.5, 0.5, 0.5] });
  });

  it('the modifier commands name the object', async () => {
    const a = await add('cube');
    await add('cube');
    const added = await run('modifier.add', { objectId: a, type: 'subdivision' });
    expect(added).toEqual({ id: expect.any(String), objectId: a });
    expect(await run('modifier.update', { objectId: a, modifierId: added.id, levels: 2 })).toEqual({ id: added.id, objectId: a });
    expect(await run('modifier.apply', { objectId: a, modifierId: added.id })).toMatchObject({ objectId: a, faces: 96 });
    const second = await run('modifier.add', { objectId: a, type: 'mirror' });
    expect(await run('modifier.remove', { objectId: a, modifierId: second.id })).toEqual({ objectId: a, modifierId: second.id });
  });

  it('edit.exit names the edited object, and mesh operations report the local bounds of the selection', async () => {
    const id = await add('cube', { position: [10, 0, 0], scale: [3, 3, 3] });
    expect(await run('edit.exit')).toEqual({ objectId: null });
    await run('edit.enter', { id });
    await run('edit.set_element_mode', { mode: 'face' });
    await run('mesh.select_by', { normal: [0, 1, 0] });
    // Local space: the transform of the object does not matter.
    const extruded = await run('mesh.extrude', { distance: 0.5 });
    expect(extruded.selectionBounds).toEqual({ min: [-1, 1.5, -1], max: [1, 1.5, 1] });
    const moved = await run('mesh.transform', { translate: [0, 1, 0], scale: [0.5, 1, 0.5] });
    expect(moved.selectionBounds).toEqual({ min: [-0.5, 2.5, -0.5], max: [0.5, 2.5, 0.5] });
    const inset = await run('mesh.inset', { thickness: 0.1 });
    expect(inset.selectionBounds.min).toEqual([-0.4, 2.5, -0.4]);
    const deleted = await run('mesh.delete');
    expect(deleted.selectionBounds).toBeNull();
    expect(await run('edit.exit')).toEqual({ objectId: id });
  });

  it('the group commands return the resulting group', async () => {
    const a = await add('cube');
    const b = await add('cube');
    const c = await add('cube');
    const outer = await run('group.create', { ids: [a, b], name: 'Outer' });
    expect(outer).toEqual({ id: outer.id, name: 'Outer', parentId: null, objectIds: [a, b], childGroupIds: [] });
    const inner = await run('group.create', { ids: [b], name: 'Inner' });
    expect(inner).toEqual({ id: inner.id, name: 'Inner', parentId: outer.id, objectIds: [b], childGroupIds: [] });
    expect(await run('group.move', { objectIds: [c], targetGroupId: inner.id, index: 0 })).toEqual({
      id: inner.id,
      name: 'Inner',
      parentId: outer.id,
      objectIds: [c, b],
      childGroupIds: [],
    });
    expect(await run('group.move', { groupIds: [inner.id], objectIds: [a], targetGroupId: null })).toEqual({
      id: null,
      name: null,
      parentId: null,
      objectIds: [a],
      childGroupIds: [outer.id, inner.id],
    });
    await run('group.move', { groupIds: [inner.id], targetGroupId: outer.id });
    await run('group.move', { objectIds: [a], targetGroupId: inner.id });
    expect(await run('group.ungroup', { id: inner.id })).toEqual({ id: inner.id, name: 'Inner', parentId: outer.id, objectIds: [c, b, a], childGroupIds: [] });
    expect(state().objects[a].groupId).toBe(outer.id);
  });
});
