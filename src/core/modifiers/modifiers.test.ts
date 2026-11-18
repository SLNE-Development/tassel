import { describe, expect, it } from 'vitest';
import { boundingBox } from '../mesh/polymesh';
import { createPrimitive } from '../mesh/primitives';
import { edgeFaces } from '../mesh/topology';
import type { DocState, Modifier, PolyMesh, SceneObject, Transform } from '../types';
import { array } from './array';
import { evaluateObject, initModifiers } from './evaluate';
import { mirror } from './mirror';
import { subdivide } from './subdivide';
import { cutCube, isClosedManifold, volume } from './testing';

const cube = createPrimitive('cube');
const X = { x: true, y: false, z: false };

function object(id: string, mesh: PolyMesh, modifiers: Modifier[] = [], transform: Partial<Transform> = {}): SceneObject {
  return {
    id,
    name: id,
    visible: true,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], ...transform },
    mesh,
    modifiers,
    smooth: false,
    groupId: null,
  };
}

function scene(...objects: SceneObject[]): DocState {
  return {
    objects: Object.fromEntries(objects.map((o) => [o.id, o])),
    order: objects.map((o) => o.id),
    groups: {},
    groupOrder: [],
    selection: [],
    activeId: null,
    edit: null,
  };
}

const bool = (operation: 'union' | 'difference' | 'intersect', targetId: string | null, id = 'bool'): Modifier => ({
  id,
  enabled: true,
  type: 'boolean',
  operation,
  targetId,
});
const mirrorX: Modifier = { id: 'mirror', enabled: true, type: 'mirror', axes: X, mergeDistance: 0.001 };
const subdiv: Modifier = { id: 'subdiv', enabled: true, type: 'subdivision', levels: 1 };

function expectBounds(mesh: PolyMesh, min: number[], max: number[]): void {
  const box = boundingBox(mesh)!;
  min.forEach((v, i) => expect(box.min[i]).toBeCloseTo(v, 5));
  max.forEach((v, i) => expect(box.max[i]).toBeCloseTo(v, 5));
}

// Must stay the first test: it needs the WASM not to be loaded yet.
describe('before initModifiers', () => {
  it('skips booleans with an error, and evaluates them once it has resolved', async () => {
    const state = scene(object('a', cube, [bool('difference', 'b')]), object('b', cube, [], { position: [1, 0, 0] }));
    const before = evaluateObject(state, 'a');
    expect(before.mesh).toBe(cube);
    expect(before.errors).toEqual({ bool: expect.stringContaining('still loading') });
    await initModifiers();
    await initModifiers();
    const after = evaluateObject(state, 'a');
    expect(after).not.toBe(before);
    expect(after.errors).toEqual({});
    expect(volume(after.mesh)).toBeCloseTo(4, 4);
  });
});

describe('mirror', () => {
  it('turns an open half cube into the closed cube', () => {
    const half = cutCube([0]);
    expect(half.faces).toHaveLength(5);
    expect(isClosedManifold(half)).toBe(false);
    const out = mirror(half, X, 0.001);
    expect(out.positions).toHaveLength(12 * 3);
    expect(out.faces).toHaveLength(10);
    expect(isClosedManifold(out)).toBe(true);
    expect(boundingBox(out)).toEqual({ min: [-1, -1, -1], max: [1, 1, 1] });
    expect(volume(out)).toBeCloseTo(8);
  });

  it('snaps vertices within the merge distance onto the plane and leaves others apart', () => {
    const half = cutCube([0]);
    const near = { ...half, positions: half.positions.map((v, i) => (i % 3 === 0 && v === 0 ? 0.0005 : v)) };
    const welded = mirror(near, X, 0.001);
    expect(isClosedManifold(welded)).toBe(true);
    expect(welded.positions).toHaveLength(12 * 3);
    const apart = mirror(near, X, 0.0001);
    expect(isClosedManifold(apart)).toBe(false);
    expect(apart.positions).toHaveLength(16 * 3);
  });

  it('drops faces lying in the mirror plane', () => {
    const closedHalf = { ...cube, positions: cube.positions.map((v, i) => (i % 3 === 0 && v < 0 ? 0 : v)) };
    const out = mirror(closedHalf, X, 0.001);
    expect(out.faces).toHaveLength(10);
    expect(isClosedManifold(out)).toBe(true);
    expect(volume(out)).toBeCloseTo(8);
  });

  it('mirrors on two and three axes', () => {
    const quarter = mirror(cutCube([0, 1]), { x: true, y: true, z: false }, 0.001);
    expect(quarter.positions).toHaveLength(18 * 3);
    expect(quarter.faces).toHaveLength(16);
    expect(isClosedManifold(quarter)).toBe(true);
    expect(boundingBox(quarter)).toEqual({ min: [-1, -1, -1], max: [1, 1, 1] });
    expect(volume(quarter)).toBeCloseTo(8);

    const eighth = mirror(cutCube([0, 1, 2]), { x: true, y: true, z: true }, 0.001);
    expect(eighth.positions).toHaveLength(27 * 3);
    expect(eighth.faces).toHaveLength(24);
    expect(isClosedManifold(eighth)).toBe(true);
    expect(volume(eighth)).toBeCloseTo(8);
  });

  it('mirrors a mesh away from the plane into a separate, outward-facing copy', () => {
    const moved = { ...cube, positions: cube.positions.map((v, i) => (i % 3 === 0 ? v + 3 : v)) };
    const out = mirror(moved, X, 0.001);
    expect(out.faces).toHaveLength(12);
    expect(isClosedManifold(out)).toBe(true);
    expect(volume(out)).toBeCloseTo(16);
    expectBounds(out, [-4, -1, -1], [4, 1, 1]);
  });
});

describe('subdivision', () => {
  it('level 1 of a cube: 26 vertices, 24 quads, closed', () => {
    const out = subdivide(cube, 1);
    expect(out.positions).toHaveLength(26 * 3);
    expect(out.faces).toHaveLength(24);
    expect(out.faces.every((f) => f.length === 4)).toBe(true);
    expect(isClosedManifold(out)).toBe(true);
    // Corner (n = 3): (F + 2R + (n - 3) P) / n = 5/9; face points stay in the face centres.
    expectBounds(out, [-1, -1, -1], [1, 1, 1]);
    expect(Math.max(...out.positions.slice(0, 24).map(Math.abs))).toBeCloseTo(5 / 9);
  });

  it('shrinks a cube towards a sphere-like shape and keeps it closed and outward facing', () => {
    const spread = (mesh: PolyMesh) => {
      const radii: number[] = [];
      for (let i = 0; i < mesh.positions.length; i += 3) radii.push(Math.hypot(...mesh.positions.slice(i, i + 3)));
      return Math.max(...radii) / Math.min(...radii);
    };
    const levels = [1, 2, 3].map((n) => subdivide(cube, n));
    expect(levels[1].positions).toHaveLength(98 * 3);
    expect(levels[1].faces).toHaveLength(96);
    expect(levels[2].faces).toHaveLength(384);
    levels.forEach((mesh) => expect(isClosedManifold(mesh)).toBe(true));
    const sizes = levels.map((mesh) => boundingBox(mesh)!.max[0]);
    expect(sizes[0]).toBeCloseTo(1);
    expect(sizes[1]).toBeLessThan(sizes[0]);
    expect(sizes[2]).toBeLessThan(sizes[1]);
    expect(spread(levels[2])).toBeLessThan(1.05);
    expect(spread(levels[2])).toBeLessThan(spread(levels[0]));
    const volumes = levels.map(volume);
    expect(volumes[2]).toBeGreaterThan(0);
    expect(volumes[2]).toBeLessThan(volumes[0]);
    expect(volumes[0]).toBeLessThan(8);
  });

  it('handles triangles and n-gons', () => {
    const out = subdivide(createPrimitive('cylinder', { segments: 5 }), 1);
    // 10 vertices, 15 edges, 7 faces (5 quads and two pentagons).
    expect(out.positions).toHaveLength((10 + 15 + 7) * 3);
    expect(out.faces).toHaveLength(5 * 4 + 2 * 5);
    expect(isClosedManifold(out)).toBe(true);
    const tris = subdivide(createPrimitive('ico_sphere', { subdivisions: 0 }), 1);
    expect(tris.faces).toHaveLength(60);
    expect(isClosedManifold(tris)).toBe(true);
  });

  it('subdivides an open plane with boundary rules', () => {
    const plane = createPrimitive('plane');
    const one = subdivide(plane, 1);
    expect(one.positions).toHaveLength(9 * 3);
    expect(one.faces).toHaveLength(4);
    // Border edge points are edge midpoints; corners move to 3/4 P + 1/8 (a + b) (cubic B-spline).
    expectBounds(one, [-1, 0, -1], [1, 0, 1]);
    expect(one.positions.slice(0, 12).map(Math.abs)).toEqual([0.75, 0, 0.75, 0.75, 0, 0.75, 0.75, 0, 0.75, 0.75, 0, 0.75]);
    const out = subdivide(plane, 3);
    expect(out.faces).toHaveLength(64);
    expect(out.positions.every((v, i) => i % 3 !== 1 || v === 0)).toBe(true);
    const usage = [...edgeFaces(out).values()].map((faces) => faces.length);
    expect(usage.filter((n) => n === 1)).toHaveLength(4 * 8);
    expect(usage.every((n) => n === 1 || n === 2)).toBe(true);
  });

  it('keeps the border of an open mesh independent of its interior, and straight borders straight', () => {
    // 2 x 2 quads, vertex 4 in the middle.
    const grid = (height: number): PolyMesh => {
      const positions: number[] = [];
      for (let z = 0; z < 3; z++) for (let x = 0; x < 3; x++) positions.push(x, x === 1 && z === 1 ? height : 0, z);
      return { positions, faces: [[0, 3, 4, 1], [1, 4, 5, 2], [3, 6, 7, 4], [4, 7, 8, 5]] };
    };
    const flat = subdivide(grid(0), 2);
    const raised = subdivide(grid(5), 2);
    const border = [...edgeFaces(flat)].filter(([, faces]) => faces.length === 1).flatMap(([key]) => key.split(':').map(Number));
    expect(new Set(border).size).toBe(32);
    for (const v of border) expect(raised.positions.slice(v * 3, v * 3 + 3)).toEqual(flat.positions.slice(v * 3, v * 3 + 3));
    expect(Math.max(...raised.positions.filter((_, i) => i % 3 === 1))).toBeGreaterThan(1);
    // The middle vertices of each side have collinear border neighbours and do not move.
    for (const v of [1, 3, 5, 7]) expect(flat.positions.slice(v * 3, v * 3 + 3)).toEqual(grid(0).positions.slice(v * 3, v * 3 + 3));
    expectBounds(flat, [0, 0, 0], [2, 0, 2]);
  });
});

describe('array', () => {
  it('creates count copies, each offset further', () => {
    const out = array(cube, 3, [2.5, 0, 1]);
    expect(out.positions).toHaveLength(3 * 8 * 3);
    expect(out.faces).toHaveLength(18);
    expect(boundingBox(out)).toEqual({ min: [-1, -1, -1], max: [6, 1, 3] });
    expect(out.positions.slice(48, 51)).toEqual([cube.positions[0] + 5, cube.positions[1], cube.positions[2] + 2]);
    expect(out.faces[12]).toEqual(cube.faces[0].map((v) => v + 16));
    expect(volume(out)).toBeCloseTo(24);
    expect(isClosedManifold(out)).toBe(true);
  });

  it('count 1 is the mesh itself', () => {
    expect(array(cube, 1, [2, 0, 0])).toEqual(cube);
  });
});

describe('boolean', () => {
  const evaluate = (state: DocState, id = 'a') => {
    const result = evaluateObject(state, id);
    expect(result.errors).toEqual({});
    expect(isClosedManifold(result.mesh)).toBe(true);
    expect(result.mesh.faces.every((f) => f.length === 3)).toBe(true);
    return result.mesh;
  };
  const shifted = object('b', cube, [], { position: [1, 0, 0] });

  it('difference, union and intersect of two overlapping cubes', () => {
    const difference = evaluate(scene(object('a', cube, [bool('difference', 'b')]), shifted));
    expect(volume(difference)).toBeCloseTo(4, 4);
    expectBounds(difference, [-1, -1, -1], [0, 1, 1]);
    const union = evaluate(scene(object('a', cube, [bool('union', 'b')]), shifted));
    expect(volume(union)).toBeCloseTo(12, 4);
    expectBounds(union, [-1, -1, -1], [2, 1, 1]);
    const intersect = evaluate(scene(object('a', cube, [bool('intersect', 'b')]), shifted));
    expect(volume(intersect)).toBeCloseTo(4, 4);
    expectBounds(intersect, [0, -1, -1], [1, 1, 1]);
  });

  it('works in the local space of the object: position', () => {
    const a = object('a', cube, [bool('difference', 'b')], { position: [10, 5, 0] });
    const b = object('b', cube, [], { position: [11, 5, 0] });
    const mesh = evaluate(scene(a, b));
    expect(volume(mesh)).toBeCloseTo(4, 4);
    expectBounds(mesh, [-1, -1, -1], [0, 1, 1]);
  });

  it('works in the local space of the object: scale', () => {
    // a covers world [-2, 2]^3; b covers x [1, 3], y/z [-1, 1], which is x [0.5, 1.5] and y/z [-0.5, 0.5] in a's space.
    const a = object('a', cube, [bool('intersect', 'b')], { scale: [2, 2, 2] });
    const b = object('b', cube, [], { position: [2, 0, 0] });
    const mesh = evaluate(scene(a, b));
    expect(volume(mesh)).toBeCloseTo(0.5, 4);
    expectBounds(mesh, [0.5, -0.5, -0.5], [1, 0.5, 0.5]);
  });

  it('works in the local space of the object: rotation of the object', () => {
    // Rotating a by 90° around Y maps its local +Z onto world +X.
    const a = object('a', cube, [bool('difference', 'b')], { rotation: [0, 90, 0] });
    const mesh = evaluate(scene(a, shifted));
    expect(volume(mesh)).toBeCloseTo(4, 4);
    expectBounds(mesh, [-1, -1, -1], [1, 1, 0]);
  });

  it('honours rotation and non-uniform scale of the target', () => {
    // Two squares of side 2, one turned by 45°, overlap in an octagon of area 8 (sqrt(2) - 1).
    const turned = object('b', cube, [], { rotation: [0, 45, 0] });
    const octagon = evaluate(scene(object('a', cube, [bool('intersect', 'b')]), turned));
    expect(volume(octagon)).toBeCloseTo(16 * (Math.SQRT2 - 1), 4);

    // Euler XYZ: the target's Z rotation is applied first, then X. A 4 x 2 x 2 box (scaled along X),
    // turned 90° around Z, stands along Y; tilted 90° around X it lies along Z.
    const box = object('b', cube, [], { rotation: [90, 0, 90], scale: [2, 1, 1], position: [0, 0, 1] });
    const mesh = evaluate(scene(object('a', cube, [bool('union', 'b')]), box));
    expectBounds(mesh, [-1, -1, -1], [1, 1, 3]);
    expect(volume(mesh)).toBeCloseTo(16, 4);
  });

  it('handles a mirrored (negatively scaled) target', () => {
    const flipped = object('b', cube, [], { position: [1, 0, 0], scale: [-1, 1, 1] });
    expect(volume(evaluate(scene(object('a', cube, [bool('difference', 'b')]), flipped)))).toBeCloseTo(4, 4);
  });

  it('uses the evaluated mesh of the target', () => {
    const half = object('b', cutCube([0]), [mirrorX], { position: [1, 0, 0] });
    const mesh = evaluate(scene(object('a', cube, [bool('intersect', 'b')]), half));
    expect(volume(mesh)).toBeCloseTo(4, 4);
  });

  it('cuts concave faces correctly', () => {
    // An L-shaped prism (concave top and bottom faces) of volume 3 * 2, height 2.
    const outline = [0, 0, 2, 0, 2, 1, 1, 1, 1, 2, 0, 2];
    const positions: number[] = [];
    for (const y of [0, 2]) for (let i = 0; i < 12; i += 2) positions.push(outline[i], y, -outline[i + 1]);
    const faces = [[0, 1, 2, 3, 4, 5], [11, 10, 9, 8, 7, 6]];
    faces[0].reverse();
    faces[1].reverse();
    for (let i = 0; i < 6; i++) faces.push([i, (i + 1) % 6, 6 + ((i + 1) % 6), 6 + i]);
    const shape: PolyMesh = { positions, faces };
    expect(isClosedManifold(shape)).toBe(true);
    expect(volume(shape)).toBeCloseTo(6);
    const far = object('b', cube, [], { position: [10, 0, 0] });
    expect(volume(evaluate(scene(object('a', shape, [bool('difference', 'b')]), far)))).toBeCloseTo(6, 4);
    // The notch of the L (x, -z in [1, 2]) must stay empty.
    const notch = object('b', cube, [], { position: [1.5, 1, -1.5], scale: [0.5, 2, 0.5] });
    expect(volume(evaluate(scene(object('a', shape, [bool('union', 'b')]), notch)))).toBeCloseTo(6 + 4, 4);
  });

  it('skips the modifier with an error when it cannot work', () => {
    const errorOf = (state: DocState, id = 'a') => {
      const result = evaluateObject(state, id);
      expect(result.mesh).toBe(state.objects[id].mesh);
      return result.errors.bool;
    };
    expect(errorOf(scene(object('a', cube, [bool('union', null)])))).toMatch(/No target/);
    expect(errorOf(scene(object('a', cube, [bool('union', 'gone')])))).toMatch(/does not exist/);
    expect(errorOf(scene(object('a', cube, [bool('union', 'a')])))).toMatch(/its own/);

    const cycle = scene(object('a', cube, [bool('union', 'b')]), object('b', cube, [bool('union', 'a')]));
    expect(errorOf(cycle, 'a')).toMatch(/cycle/);
    expect(errorOf(cycle, 'b')).toMatch(/cycle/);
    const longCycle = scene(
      object('a', cube, [bool('union', 'b')]),
      object('b', cube, [bool('union', 'c')]),
      object('c', cube, [bool('union', 'a')]),
    );
    for (const id of ['a', 'b', 'c']) expect(errorOf(longCycle, id)).toMatch(/cycle/);

    const plane = createPrimitive('plane');
    expect(errorOf(scene(object('a', plane, [bool('union', 'b')]), shifted))).toMatch(/^The mesh is not a closed manifold/);
    expect(errorOf(scene(object('a', cube, [bool('union', 'b')]), object('b', plane)))).toMatch(/^The target mesh is not a closed manifold/);
    expect(errorOf(scene(object('a', cube, [bool('union', 'b')], { scale: [1, 0, 1] }), shifted))).toMatch(/scale of zero/);
  });

  it('a disabled modifier breaks a cycle, and the rest of the stack still runs after an error', () => {
    const off = { ...bool('union', 'a'), enabled: false };
    const state = scene(object('a', cube, [bool('union', 'b')]), object('b', cube, [off], { position: [1, 0, 0] }));
    expect(volume(evaluate(state))).toBeCloseTo(12, 4);

    const result = evaluateObject(scene(object('a', cube, [bool('union', 'gone'), subdiv])), 'a');
    expect(Object.keys(result.errors)).toEqual(['bool']);
    expect(result.mesh.faces).toHaveLength(24);
  });
});

describe('evaluateObject', () => {
  it('returns the base mesh itself without enabled modifiers', () => {
    const plain = scene(object('a', cube), object('b', cube, [{ ...subdiv, enabled: false }]));
    expect(evaluateObject(plain, 'a')).toEqual({ mesh: cube, errors: {} });
    expect(evaluateObject(plain, 'a').mesh).toBe(cube);
    expect(evaluateObject(plain, 'a')).toBe(evaluateObject(plain, 'a'));
    expect(evaluateObject(plain, 'b').mesh).toBe(cube);
    expect(() => evaluateObject(plain, 'nope')).toThrow(/does not exist/);
  });

  it('applies modifiers in stack order', () => {
    const half = cutCube([0]);
    const mirrorFirst = evaluateObject(scene(object('a', half, [mirrorX, subdiv])), 'a').mesh;
    const subdivFirst = evaluateObject(scene(object('a', half, [subdiv, mirrorX])), 'a').mesh;
    // Mirror first: the closed cube is smoothed. Subdivision first: the open half keeps its sharp border.
    expect(mirrorFirst).toEqual(subdivide(mirror(half, X, 0.001), 1));
    expect(subdivFirst).toEqual(mirror(subdivide(half, 1), X, 0.001));
    for (const mesh of [mirrorFirst, subdivFirst]) {
      expect(isClosedManifold(mesh)).toBe(true);
      expect(mesh.faces).toHaveLength(40);
    }
    expect(subdivFirst.positions).not.toEqual(mirrorFirst.positions);
    expect(volume(subdivFirst)).not.toBeCloseTo(volume(mirrorFirst), 2);
  });

  it('caches by identity', () => {
    const a = object('a', cube, [subdiv]);
    const other = object('other', cube);
    const state = scene(a, other);
    const first = evaluateObject(state, 'a');
    expect(evaluateObject(state, 'a')).toBe(first);
    // Unrelated changes: another object, and this object's name, visibility and transform.
    expect(evaluateObject(scene(a, { ...other, mesh: createPrimitive('plane') }), 'a')).toBe(first);
    const renamed = { ...a, name: 'x', visible: false, transform: { ...a.transform, position: [1, 2, 3] as [number, number, number] } };
    expect(evaluateObject(scene(renamed, other), 'a')).toBe(first);
    // Changes that matter.
    expect(evaluateObject(scene({ ...a, mesh: { ...cube } }), 'a')).not.toBe(first);
    const more = evaluateObject(scene({ ...a, modifiers: [{ ...subdiv, levels: 2 }] }), 'a');
    expect(more.mesh.faces).toHaveLength(96);
    expect(evaluateObject(state, 'a')).toBe(first);
  });

  it('re-evaluates a boolean when its target changes, and only then', () => {
    const a = object('a', cube, [bool('difference', 'b')]);
    const b = object('b', cube, [], { position: [1, 0, 0] });
    const state = scene(a, b);
    const first = evaluateObject(state, 'a');
    expect(evaluateObject(state, 'a')).toBe(first);
    expect(evaluateObject(scene(a, { ...b, name: 'cutter', visible: false }), 'a')).toBe(first);
    expect(evaluateObject(scene({ ...a, name: 'x' }, b, object('c', cube)), 'a')).toBe(first);

    const moved = evaluateObject(scene(a, { ...b, transform: { ...b.transform, position: [1.5, 0, 0] } }), 'a');
    expect(moved).not.toBe(first);
    expect(volume(moved.mesh)).toBeCloseTo(6, 4);
    const selfMoved = evaluateObject(scene({ ...a, transform: { ...a.transform, position: [-0.5, 0, 0] } }, b), 'a');
    expect(volume(selfMoved.mesh)).toBeCloseTo(6, 4);
    const reshaped = evaluateObject(scene(a, { ...b, modifiers: [{ ...subdiv, id: 's' }] }), 'a');
    expect(reshaped).not.toBe(first);
    expect(reshaped.errors).toEqual({});

    // Deleting the target turns the modifier into a no-op with an error.
    const deleted = evaluateObject(scene(a), 'a');
    expect(deleted.mesh).toBe(cube);
    expect(deleted.errors.bool).toMatch(/does not exist/);
    expect(evaluateObject(state, 'a').errors).toEqual({});
  });

  it('keeps duplicates that share mesh and modifiers apart', () => {
    const a = object('a', cube, [bool('difference', 'b')]);
    const copy = { ...a, id: 'copy', transform: { ...a.transform, position: [0.5, 0, 0] as [number, number, number] } };
    const state = scene(a, copy, object('b', cube, [], { position: [1, 0, 0] }));
    for (let i = 0; i < 2; i++) {
      expect(volume(evaluateObject(state, 'a').mesh)).toBeCloseTo(4, 4);
      expect(volume(evaluateObject(state, 'copy').mesh)).toBeCloseTo(2, 4);
    }
    expect(evaluateObject(state, 'a')).toBe(evaluateObject(state, 'a'));
    expect(evaluateObject(state, 'copy')).toBe(evaluateObject(state, 'copy'));
  });
});
