import { beforeEach, describe, expect, it } from 'vitest';
import { documentCommands } from '../commands/document';
import { modifierCommands } from '../commands/modifier';
import { runCommand, type AnyCommand, type CommandContext } from '../commands/registry';
import { sceneCommands } from '../commands/scene';
import { createPrimitive } from '../mesh/primitives';
import { parseProject, serializeProject } from '../project';
import { activeDoc, createAppState } from '../state';
import type { AppState, DocState, Modifier, PolyMesh, SceneObject, Transform, Vec3 } from '../types';
import { array } from './array';
import { transformMatrix } from './boolean';
import { evaluateObject } from './evaluate';
import { isClosedManifold, volume } from './testing';

const cube = createPrimitive('cube');

/** A cube with edge length 0.4 around `centre`. */
function smallCube(centre: Vec3): PolyMesh {
  const mesh = createPrimitive('cube', { size: 0.4 });
  return { ...mesh, positions: mesh.positions.map((v, i) => v + centre[i % 3]) };
}

/** Centre of copy `i` of an array of meshes with `vertices` vertices each. */
function centre(mesh: PolyMesh, i: number, vertices = 8): Vec3 {
  const c: Vec3 = [0, 0, 0];
  for (let v = i * vertices; v < (i + 1) * vertices; v++) for (let a = 0; a < 3; a++) c[a] += mesh.positions[v * 3 + a] / vertices;
  return c;
}

function expectVec(actual: readonly number[], expected: readonly number[], digits = 12) {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((v, i) => expect(actual[i], `component ${i} of ${JSON.stringify(actual)}`).toBeCloseTo(v, digits));
}

/** The array modifier as it was before it could rotate. */
function oldArray(mesh: PolyMesh, count: number, offset: Vec3): PolyMesh {
  const vertexCount = mesh.positions.length / 3;
  const positions: number[] = [];
  const faces: number[][] = [];
  for (let i = 0; i < count; i++) {
    for (let p = 0; p < mesh.positions.length; p++) positions.push(mesh.positions[p] + i * offset[p % 3]);
    for (const face of mesh.faces) faces.push(face.map((v) => v + i * vertexCount));
  }
  return { positions, faces };
}

function object(mesh: PolyMesh, modifiers: Modifier[], transform: Partial<Transform> = {}): SceneObject {
  return {
    id: 'a',
    name: 'a',
    visible: true,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], ...transform },
    mesh,
    modifiers,
    smooth: false,
    groupId: null,
    materialId: null,
  };
}

function scene(obj: SceneObject): DocState {
  return {
    objects: { [obj.id]: obj },
    order: [obj.id],
    groups: {},
    groupOrder: [],
    materials: {},
    textures: {},
    selection: [],
    activeId: null,
    edit: null,
  };
}

const arrayModifier = (fields: Partial<Extract<Modifier, { type: 'array' }>>): Modifier => ({
  id: 'array',
  enabled: true,
  type: 'array',
  count: 2,
  offset: [0, 0, 0],
  rotation: [0, 0, 0],
  pivot: [0, 0, 0],
  offsetSpace: 'local',
  ...fields,
});

/** Local positions taken to world space. */
function toWorld(positions: readonly number[], transform: Transform): number[] {
  const m = transformMatrix(transform);
  const out: number[] = [];
  for (let i = 0; i < positions.length; i += 3) {
    for (let r = 0; r < 3; r++) out.push(m[r * 4] * positions[i] + m[r * 4 + 1] * positions[i + 1] + m[r * 4 + 2] * positions[i + 2] + m[r * 4 + 3]);
  }
  return out;
}

describe('array: defaults', () => {
  const offsets: Vec3[] = [
    [2, 0, 0],
    [2.5, 0, 1],
    [0.1, -0.2, 0.3],
    [1 / 3, 1e-7, -7.77],
    [0, 0, 0],
  ];

  it('without the new fields the result is bit for bit what it used to be', () => {
    const meshes = [cube, createPrimitive('torus', { segments: 7, minorSegments: 5 }), smallCube([0.1, 0.2, 0.3])];
    for (const mesh of meshes) {
      for (const offset of offsets) {
        for (const count of [1, 2, 3, 17]) {
          const expected = oldArray(mesh, count, offset);
          expect(array(mesh, count, offset)).toEqual(expected);
          expect(array(mesh, count, offset, { rotation: [0, 0, 0], pivot: [0, 0, 0], offsetSpace: 'local' })).toEqual(expected);
          // A pivot alone does nothing, and the object's transform is of no interest to a local offset.
          const transform: Transform = { position: [1, 2, 3], rotation: [10, 20, 30], scale: [2, 3, 4] };
          expect(array(mesh, count, offset, { pivot: [5, 6, 7], transform })).toEqual(expected);
        }
      }
    }
  });

  it('a modifier stored without the new fields evaluates as before', () => {
    const old = { id: 'array', enabled: true, type: 'array', count: 4, offset: [0.3, 0, 1.1] } as unknown as Modifier;
    const state = scene(object(cube, [old], { rotation: [0, 45, 0], scale: [2, 2, 2] }));
    const result = evaluateObject(state, 'a');
    expect(result.errors).toEqual({});
    expect(result.mesh).toEqual(oldArray(cube, 4, [0.3, 0, 1.1]));
  });

  it('carries the UVs to every copy', () => {
    const mesh: PolyMesh = { ...cube, uvs: cube.faces.map((face) => face.flatMap((_, i) => [i, i + 0.5])) };
    for (const rotation of [[0, 0, 0], [0, 90, 0]] as Vec3[]) {
      const out = array(mesh, 3, [1, 0, 0], { rotation });
      expect(out.uvs).toHaveLength(18);
      expect(out.uvs).toEqual([...mesh.uvs!, ...mesh.uvs!, ...mesh.uvs!]);
    }
  });
});

describe('array: rotation', () => {
  it('a rotation without an offset places the copies on a circle (radial array)', () => {
    const n = 8;
    const out = array(smallCube([2, 0.5, 0]), n, [0, 0, 0], { rotation: [0, 360 / n, 0] });
    expect(out.positions).toHaveLength(n * 24);
    expect(out.faces).toHaveLength(n * 6);
    expect(isClosedManifold(out)).toBe(true);
    expect(volume(out)).toBeCloseTo(n * 0.4 ** 3, 12);
    for (let i = 0; i < n; i++) {
      const a = (i * 2 * Math.PI) / n;
      // Positive Y turns counter-clockwise seen from above: from +X towards -Z.
      expectVec(centre(out, i), [2 * Math.cos(a), 0.5, -2 * Math.sin(a)]);
    }
    // Every vertex keeps its distance from the axis and its height.
    for (let i = 0; i < out.positions.length; i += 3) {
      const source = (i % 24) + 0;
      expect(Math.hypot(out.positions[i], out.positions[i + 2])).toBeCloseTo(Math.hypot(out.positions[source], out.positions[source + 2]), 12);
      expect(out.positions[i + 1]).toBeCloseTo(out.positions[source + 1], 12);
    }
    // Each copy is turned, not only moved: its outer face keeps looking away from the axis.
    const first = centre(out, 0);
    expect(first[0]).toBeCloseTo(2, 12);
    const quarter = out.positions.slice(2 * 24, 3 * 24);
    expect(Math.max(...quarter.filter((_, i) => i % 3 === 2).map((z) => -z))).toBeCloseTo(2.2, 12);
  });

  it('copy i is the mesh transformed i times, so a full turn comes back to the start', () => {
    const mesh = smallCube([1, 0, 0]);
    const out = array(mesh, 13, [0, 0, 0], { rotation: [0, 30, 0] });
    expectVec(out.positions.slice(12 * 24), mesh.positions, 12);
    const long = array(mesh, 1000, [0, 0, 0], { rotation: [0, 36, 0] });
    expectVec(long.positions.slice(990 * 24, 991 * 24), mesh.positions, 10);
  });

  it('turns about the pivot', () => {
    const out = array(smallCube([0, 0, 0]), 4, [0, 0, 0], { rotation: [0, 90, 0], pivot: [1, 0, 0] });
    expectVec(centre(out, 0), [0, 0, 0]);
    expectVec(centre(out, 1), [1, 0, 1]);
    expectVec(centre(out, 2), [2, 0, 0]);
    expectVec(centre(out, 3), [1, 0, -1]);
    // About X and Z the same way (Euler XYZ in degrees, right-handed).
    expectVec(centre(array(smallCube([0, 1, 0]), 2, [0, 0, 0], { rotation: [90, 0, 0] }), 1), [0, 0, 1]);
    expectVec(centre(array(smallCube([1, 0, 0]), 2, [0, 0, 0], { rotation: [0, 0, 90] }), 1), [0, 1, 0]);
    expectVec(centre(array(smallCube([1, 0, 0]), 2, [0, 0, 0], { rotation: [0, 0, 90], pivot: [0, 5, 0] }), 1), [5, 6, 0]);
  });

  it('with a rotation and an offset every copy turns and moves relative to the previous one (a spiral)', () => {
    const out = array(smallCube([1, 0, 0]), 5, [0, 0.5, 0], { rotation: [0, 90, 0] });
    expectVec(centre(out, 1), [0, 0.5, -1]);
    expectVec(centre(out, 2), [-1, 1, 0]);
    expectVec(centre(out, 3), [0, 1.5, 1]);
    expectVec(centre(out, 4), [1, 2, 0]);
    // An offset across the axis is turned along: the step of copy 2 is the step of copy 1, turned.
    const across = array(smallCube([0, 0, 0]), 4, [1, 0, 0], { rotation: [0, 90, 0] });
    expectVec(centre(across, 1), [1, 0, 0]);
    expectVec(centre(across, 2), [1, 0, -1]);
    expectVec(centre(across, 3), [0, 0, -1]);
  });

  it('agrees with the object transform convention for combined Euler angles', () => {
    const rotation: Vec3 = [20, -35, 50];
    const mesh = smallCube([0.3, 0.7, -0.2]);
    const out = array(mesh, 2, [0, 0, 0], { rotation });
    expectVec(out.positions.slice(24), toWorld(mesh.positions, { position: [0, 0, 0], rotation, scale: [1, 1, 1] }));
  });
});

describe('array: world-space offset', () => {
  const transform: Transform = { position: [5, 6, 7], rotation: [30, 45, 60], scale: [2, 0.5, 3] };

  it('lands at exact world positions on a rotated and scaled object', () => {
    const offset: Vec3 = [1, 2, 3];
    const modifier = arrayModifier({ count: 4, offset, offsetSpace: 'world' });
    const result = evaluateObject(scene(object(cube, [modifier], transform)), 'a');
    expect(result.errors).toEqual({});
    expect(result.mesh.faces).toHaveLength(24);
    const base = toWorld(cube.positions, transform);
    const world = toWorld(result.mesh.positions, transform);
    for (let i = 0; i < 4; i++) {
      expectVec(
        world.slice(i * 24, (i + 1) * 24),
        base.map((v, k) => v + i * offset[k % 3]),
        12,
      );
    }
    // The same offset taken as local lands somewhere else.
    const local = evaluateObject(scene(object(cube, [arrayModifier({ count: 4, offset })], transform)), 'a');
    expect(toWorld(local.mesh.positions, transform)[24]).not.toBeCloseTo(base[0] + 1, 3);
  });

  it('is the local offset for an object that is neither rotated nor scaled', () => {
    const state = scene(object(cube, [arrayModifier({ count: 3, offset: [2.5, 0, 1], offsetSpace: 'world' })], { position: [9, 9, 9] }));
    expectVec(evaluateObject(state, 'a').mesh.positions, oldArray(cube, 3, [2.5, 0, 1]).positions);
  });

  it('follows the rotation and scale of the object, but not its position', () => {
    const modifier = arrayModifier({ count: 2, offset: [1, 0, 0], offsetSpace: 'world' });
    const obj = object(cube, [modifier], transform);
    const first = evaluateObject(scene(obj), 'a');
    expect(evaluateObject(scene(obj), 'a')).toBe(first);
    // Moved: nothing to recompute.
    const moved = { ...obj, transform: { ...transform, position: [0, 0, 0] as Vec3 } };
    expect(evaluateObject(scene(moved), 'a')).toBe(first);
    // Turned or scaled: the local offset changes with it.
    const turned = { ...obj, transform: { ...transform, rotation: [0, 90, 0] as Vec3 } };
    const second = evaluateObject(scene(turned), 'a');
    expect(second).not.toBe(first);
    expectVec(toWorld(second.mesh.positions, turned.transform).slice(24, 27), toWorld(cube.positions, turned.transform).slice(0, 3).map((v, i) => v + (i === 0 ? 1 : 0)));
    const scaled = { ...obj, transform: { ...transform, scale: [4, 4, 4] as Vec3 } };
    expect(evaluateObject(scene(scaled), 'a')).not.toBe(first);
    // A local array does not care.
    const localObj = object(cube, [arrayModifier({ offset: [1, 0, 0] })], transform);
    const local = evaluateObject(scene(localObj), 'a');
    expect(evaluateObject(scene({ ...localObj, transform: turned.transform }), 'a')).toBe(local);
  });

  it('reports an object with a scale of zero instead of producing nonsense', () => {
    const modifier = arrayModifier({ offset: [1, 0, 0], offsetSpace: 'world' });
    const result = evaluateObject(scene(object(cube, [modifier], { scale: [1, 0, 1] })), 'a');
    expect(result.errors).toEqual({ array: 'The object has a scale of zero' });
    expect(result.mesh).toBe(cube);
    expect(() => array(cube, 2, [1, 0, 0], { offsetSpace: 'world' })).toThrow(/needs the transform/);
  });

  it('combines with a rotation: the step is the world offset, turned further by every copy', () => {
    const t: Transform = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [2, 2, 2] };
    const out = array(smallCube([0, 0, 0]), 3, [1, 0, 0], { rotation: [0, 90, 0], offsetSpace: 'world', transform: t });
    expectVec(toWorld(centre(out, 1), t), [1, 0, 0]);
    expectVec(toWorld(centre(out, 2), t), [1, 0, -1]);
  });
});

describe('array: commands and project files', () => {
  const byId = new Map<string, AnyCommand>([...documentCommands, ...sceneCommands, ...modifierCommands].map((c) => [c.id, c]));
  let app: AppState;
  const ctx = {
    get: () => app,
    set: (update: (app: AppState) => AppState) => {
      app = update(app);
    },
    services: {},
  } as unknown as CommandContext;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const run = async (id: string, params?: unknown): Promise<any> => runCommand(byId.get(id)!, ctx, params);
  const state = () => activeDoc(app).state;

  beforeEach(() => {
    app = createAppState();
  });

  it('modifier.add and modifier.update take rotation, pivot and offsetSpace', async () => {
    const a = (await run('scene.add_primitive', { type: 'cube', size: 0.4, position: [3, 0, 0] })).id;
    const { id } = await run('modifier.add', { type: 'array', count: 6, offset: [0, 0, 0], rotation: [0, 60, 0], pivot: [-3, 0, 0] });
    expect(state().objects[a].modifiers).toEqual([
      { id, enabled: true, type: 'array', count: 6, offset: [0, 0, 0], rotation: [0, 60, 0], pivot: [-3, 0, 0], offsetSpace: 'local' },
    ]);
    // Six cubes on a circle of radius 3 around the world origin.
    const mesh = evaluateObject(state(), a).mesh;
    for (let i = 0; i < 6; i++) {
      const c = centre(mesh, i);
      expect(Math.hypot(c[0] + 3, c[2])).toBeCloseTo(3, 12);
    }
    expectVec(centre(mesh, 3), [-6, 0, 0]);

    await run('modifier.update', { modifierId: id, offsetSpace: 'world', offset: [0, 1, 0] });
    expect(state().objects[a].modifiers[0]).toMatchObject({ count: 6, rotation: [0, 60, 0], pivot: [-3, 0, 0], offsetSpace: 'world', offset: [0, 1, 0] });
    await run('history.undo');
    expect(state().objects[a].modifiers[0]).toMatchObject({ offsetSpace: 'local', offset: [0, 0, 0] });

    await expect(run('modifier.update', { modifierId: id, offsetSpace: 'global' })).rejects.toThrow();
    await expect(run('modifier.update', { modifierId: id, rotation: [0, Infinity, 0] })).rejects.toThrow();
    const mirror = (await run('modifier.add', { type: 'mirror' })).id;
    await expect(run('modifier.update', { modifierId: mirror, pivot: [1, 0, 0] })).rejects.toThrow(/not a parameter of a mirror modifier/);
  });

  it('survives a project round trip, and older files load with the defaults', async () => {
    const a = (await run('scene.add_primitive', { type: 'cube', rotation: [0, 30, 0], scale: [2, 1, 1] })).id;
    await run('modifier.add', { type: 'array', count: 5, offset: [0, 0.5, 0], rotation: [0, 72, 0], pivot: [1, 0, 0], offsetSpace: 'world' });
    const doc = activeDoc(app);
    const loaded = parseProject(serializeProject(doc)).state;
    expect(loaded.objects[a].modifiers).toEqual(state().objects[a].modifiers);
    expect(evaluateObject(loaded, a).mesh).toEqual(evaluateObject(state(), a).mesh);

    // A file written before the array modifier could rotate.
    const file = JSON.parse(serializeProject(doc));
    file.objects[0].modifiers = [{ id: 'old', enabled: true, type: 'array', count: 3, offset: [2, 0, 0] }];
    const old = parseProject(JSON.stringify(file)).state;
    expect(old.objects[a].modifiers).toEqual([
      { id: 'old', enabled: true, type: 'array', count: 3, offset: [2, 0, 0], rotation: [0, 0, 0], pivot: [0, 0, 0], offsetSpace: 'local' },
    ]);
    expect(evaluateObject(old, a).mesh).toEqual(oldArray(cube, 3, [2, 0, 0]));

    file.objects[0].modifiers = [{ id: 'bad', type: 'array', offsetSpace: 'sideways' }];
    expect(() => parseProject(JSON.stringify(file))).toThrow();
    file.objects[0].modifiers = [{ id: 'bad', type: 'array', rotation: [0, 'x', 0] }];
    expect(() => parseProject(JSON.stringify(file))).toThrow();
  });
});
