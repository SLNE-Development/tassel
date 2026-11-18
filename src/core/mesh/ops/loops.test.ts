import { describe, expect, it } from 'vitest';
import type { Edge, PolyMesh } from '../../types';
import { edges } from '../polymesh';
import { createPrimitive } from '../primitives';
import { edgeKey } from '../topology';
import { expectOutward, expectSolid, position, signedVolume, vertexCount } from './bevel-testkit';
import { edgeLoop, edgeRing, loopCut } from './loops';

const keys = (list: readonly Edge[]) => list.map(([a, b]) => edgeKey(a, b)).sort();

function expectEdgeList(mesh: PolyMesh, list: readonly Edge[]) {
  const all = new Set(keys(edges(mesh)));
  for (const [a, b] of list) {
    expect(a).toBeLessThan(b);
    expect(all.has(edgeKey(a, b)), `edge ${a}-${b} exists`).toBe(true);
  }
  expect(new Set(keys(list)).size, 'no duplicates').toBe(list.length);
}

/** Every vertex of the edges is used by exactly two of them: one or more closed loops. */
function expectClosedLoop(list: readonly Edge[]) {
  const uses = new Map<number, number>();
  for (const v of list.flat()) uses.set(v, (uses.get(v) ?? 0) + 1);
  expect([...uses.values()].every((n) => n === 2)).toBe(true);
}

const SEG = 8;
const MINOR = 6;
const torus = createPrimitive('torus', { segments: SEG, minorSegments: MINOR });
const torusAt = (i: number, k: number) => (i % SEG) * MINOR + (k % MINOR);
const cylinder = createPrimitive('cylinder', { segments: SEG });
const RINGS = 6;
const sphere = createPrimitive('uv_sphere', { segments: SEG, rings: RINGS });
const sphereAt = (ring: number, i: number) => 1 + (ring - 1) * SEG + (i % SEG);
const cube = createPrimitive('cube');

describe('edgeLoop', () => {
  it('closes around the torus in both directions', () => {
    const major = edgeLoop(torus, [torusAt(0, 0), torusAt(1, 0)]);
    expectEdgeList(torus, major);
    expectClosedLoop(major);
    expect(keys(major)).toEqual(keys(Array.from({ length: SEG }, (_, i) => [torusAt(i, 0), torusAt(i + 1, 0)] as Edge)));

    const minor = edgeLoop(torus, [torusAt(3, 2), torusAt(3, 3)]);
    expectEdgeList(torus, minor);
    expectClosedLoop(minor);
    expect(keys(minor)).toEqual(keys(Array.from({ length: MINOR }, (_, k) => [torusAt(3, k), torusAt(3, k + 1)] as Edge)));
  });

  it('gives the same loop for every edge of it and for either vertex order', () => {
    const loop = edgeLoop(torus, [torusAt(0, 0), torusAt(1, 0)]);
    for (const [a, b] of loop) {
      expect(keys(edgeLoop(torus, [a, b]))).toEqual(keys(loop));
      expect(keys(edgeLoop(torus, [b, a]))).toEqual(keys(loop));
    }
  });

  it('stops at vertices that do not have four edges (cube, cylinder cap)', () => {
    expect(edgeLoop(cube, [4, 5])).toEqual([[4, 5]]);
    expect(edgeLoop(cylinder, [0, SEG])).toEqual([[0, SEG]]); // side edge between the caps
    expect(edgeLoop(cylinder, [SEG, SEG + 1])).toEqual([[SEG, SEG + 1]]); // cap rim
  });

  it('runs along a cut cylinder and stops at the caps', () => {
    const cut = loopCut(cylinder, [0, SEG], 1);
    const around = edgeLoop(cut.mesh, cut.edges![0]);
    expect(keys(around)).toEqual(keys(cut.edges!));
    expectClosedLoop(around);
    // A side edge now continues across the new loop, from cap to cap.
    const middle = cut.edges!.flat().find((v) => position(cut.mesh, v).join() === '1,0,0')!; // above vertex 0
    const up = edgeLoop(cut.mesh, [0, middle]);
    expectEdgeList(cut.mesh, up);
    expect(up).toHaveLength(2);
    expect(new Set(up.flat())).toEqual(new Set([0, middle, SEG]));
  });

  it('uv_sphere: latitude loops close, meridians stop at the poles', () => {
    const latitude = edgeLoop(sphere, [sphereAt(2, 0), sphereAt(2, 1)]);
    expect(latitude).toHaveLength(SEG);
    expectClosedLoop(latitude);
    const meridian = edgeLoop(sphere, [sphereAt(2, 0), sphereAt(3, 0)]);
    expectEdgeList(sphere, meridian);
    expect(meridian).toHaveLength(RINGS); // pole to pole
    const south = vertexCount(sphere) - 1;
    expect(meridian.flat().filter((v) => v === 0 || v === south)).toHaveLength(2);
  });

  it('rejects an edge that does not exist', () => {
    expect(() => edgeLoop(cube, [0, 6])).toThrow(/not an edge/);
  });
});

describe('edgeRing', () => {
  it('cube: the four parallel edges', () => {
    const ring = edgeRing(cube, [4, 5]);
    expectEdgeList(cube, ring);
    expect(keys(ring)).toEqual(keys([[4, 5], [6, 7], [2, 3], [0, 1]]));
  });

  it('closes around the torus in both directions', () => {
    const acrossMinor = edgeRing(torus, [torusAt(0, 0), torusAt(1, 0)]);
    expectEdgeList(torus, acrossMinor);
    expect(keys(acrossMinor)).toEqual(keys(Array.from({ length: MINOR }, (_, k) => [torusAt(0, k), torusAt(1, k)] as Edge)));
    const acrossMajor = edgeRing(torus, [torusAt(0, 0), torusAt(0, 1)]);
    expect(keys(acrossMajor)).toEqual(keys(Array.from({ length: SEG }, (_, i) => [torusAt(i, 0), torusAt(i, 1)] as Edge)));
  });

  it('cylinder: side edges ring around, a rim edge stops at the caps', () => {
    expect(keys(edgeRing(cylinder, [0, SEG]))).toEqual(keys(Array.from({ length: SEG }, (_, i) => [i, SEG + i] as Edge)));
    expect(keys(edgeRing(cylinder, [SEG, SEG + 1]))).toEqual(keys([[0, 1], [SEG, SEG + 1]]));
  });

  it('uv_sphere: stops at the pole triangles', () => {
    const ring = edgeRing(sphere, [sphereAt(3, 0), sphereAt(3, 1)]);
    expect(keys(ring)).toEqual(keys(Array.from({ length: RINGS - 1 }, (_, r) => [sphereAt(r + 1, 0), sphereAt(r + 1, 1)] as Edge)));
    expect(edgeRing(sphere, [sphereAt(3, 0), sphereAt(4, 0)])).toHaveLength(SEG);
    // An edge between two triangles is a ring of its own.
    expect(edgeRing(sphere, [0, sphereAt(1, 0)])).toEqual([[0, sphereAt(1, 0)]]);
  });

  it('rejects an edge that does not exist', () => {
    expect(() => edgeRing(cube, [0, 6])).toThrow(/not an edge/);
  });
});

describe('loopCut', () => {
  it('cube, one cut: 12 vertices, 10 faces, the new loop in the middle', () => {
    const result = loopCut(cube, [1, 2], 1); // vertical edge at x = 1, z = -1
    expectSolid(result.mesh, 2);
    expectOutward(result.mesh);
    expect(vertexCount(result.mesh)).toBe(12);
    expect(result.mesh.faces).toHaveLength(10);
    expect(result.mesh.faces.every((f) => f.length === 4)).toBe(true);
    expect(result.mesh.positions.slice(0, 24)).toEqual(cube.positions);
    for (let v = 8; v < 12; v++) {
      const [x, y, z] = position(result.mesh, v);
      expect([Math.abs(x), y, Math.abs(z)]).toEqual([1, 0, 1]);
    }
    expect(result.edges).toHaveLength(4);
    expectEdgeList(result.mesh, result.edges!);
    expectClosedLoop(result.edges!);
    expect(new Set(result.edges!.flat())).toEqual(new Set([8, 9, 10, 11]));
    expect(signedVolume(result.mesh)).toBeCloseTo(8, 12);
  });

  it('cube, three cuts: evenly spaced loops', () => {
    const result = loopCut(cube, [1, 2], 3);
    expectSolid(result.mesh, 2);
    expectOutward(result.mesh);
    expect(vertexCount(result.mesh)).toBe(8 + 4 * 3);
    expect(result.mesh.faces).toHaveLength(2 + 4 * 4);
    const heights = new Map<number, number>();
    for (let v = 8; v < 20; v++) {
      const [x, y, z] = position(result.mesh, v);
      expect([Math.abs(x), Math.abs(z)]).toEqual([1, 1]);
      heights.set(y, (heights.get(y) ?? 0) + 1);
    }
    expect([...heights].sort((a, b) => a[0] - b[0])).toEqual([[-0.5, 4], [0, 4], [0.5, 4]]);
    expect(result.edges).toHaveLength(12);
    expectEdgeList(result.mesh, result.edges!);
    expectClosedLoop(result.edges!);
    // Every new edge is horizontal: three separate loops.
    for (const [a, b] of result.edges!) expect(position(result.mesh, a)[1]).toBe(position(result.mesh, b)[1]);
    expect(signedVolume(result.mesh)).toBeCloseTo(8, 12);
  });

  it('torus: the cut closes on itself', () => {
    for (const cuts of [1, 2]) {
      const result = loopCut(torus, [torusAt(0, 0), torusAt(1, 0)], cuts);
      expectSolid(result.mesh, 0);
      expect(vertexCount(result.mesh)).toBe(SEG * MINOR + MINOR * cuts);
      expect(result.mesh.faces).toHaveLength(SEG * MINOR + MINOR * cuts);
      expect(result.edges).toHaveLength(MINOR * cuts);
      expectEdgeList(result.mesh, result.edges!);
      expectClosedLoop(result.edges!);
      expect(edgeLoop(result.mesh, result.edges![0])).toHaveLength(MINOR);
    }
  });

  it('cylinder side: a new loop between the caps', () => {
    const result = loopCut(cylinder, [0, SEG], 2);
    expectSolid(result.mesh, 2);
    expectOutward(result.mesh);
    expect(vertexCount(result.mesh)).toBe(SEG * 4);
    expect(result.mesh.faces).toHaveLength(SEG * 3 + 2);
    expect(result.edges).toHaveLength(SEG * 2);
    expectClosedLoop(result.edges!);
    expect(signedVolume(result.mesh)).toBeCloseTo(signedVolume(cylinder), 12);
  });

  it('open ring: the faces at its ends get the new vertices (cylinder caps)', () => {
    const result = loopCut(cylinder, [SEG, SEG + 1], 2);
    expectSolid(result.mesh, 2);
    expect(vertexCount(result.mesh)).toBe(SEG * 2 + 4);
    expect(result.mesh.faces).toHaveLength(SEG + 2 + 2);
    expect(result.mesh.faces.filter((f) => f.length === SEG + 2)).toHaveLength(2); // both caps
    expect(result.edges).toHaveLength(2);
    expectEdgeList(result.mesh, result.edges!);
    expect(signedVolume(result.mesh)).toBeCloseTo(signedVolume(cylinder), 12);
  });

  it('open ring: uv_sphere pole triangles become quads', () => {
    const result = loopCut(sphere, [sphereAt(3, 0), sphereAt(3, 1)], 1);
    expectSolid(result.mesh, 2);
    expectOutward(result.mesh);
    expect(vertexCount(result.mesh)).toBe(vertexCount(sphere) + RINGS - 1);
    expect(result.mesh.faces).toHaveLength(sphere.faces.length + RINGS - 2);
    expect(result.mesh.faces.filter((f) => f.length === 3)).toHaveLength(2 * SEG - 2);
    expect(result.edges).toHaveLength(RINGS - 2);
    expectEdgeList(result.mesh, result.edges!);
    expect(signedVolume(result.mesh)).toBeCloseTo(signedVolume(sphere), 12);
  });

  it('rejects unsuitable input', () => {
    expect(() => loopCut(cube, [0, 6], 1)).toThrow(/not an edge/);
    expect(() => loopCut(cube, [1, 2], 0)).toThrow(/cuts/);
    expect(() => loopCut(cube, [1, 2], 1.5)).toThrow(/cuts/);
    expect(() => loopCut(sphere, [0, sphereAt(1, 0)], 1)).toThrow(/no adjacent quad/);
  });

  it('does not modify its input', () => {
    const before = JSON.stringify(cube);
    loopCut(cube, [1, 2], 2);
    expect(JSON.stringify(cube)).toBe(before);
  });
});
