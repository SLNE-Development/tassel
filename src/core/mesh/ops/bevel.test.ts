import { describe, expect, it } from 'vitest';
import type { Edge, PolyMesh, Vec3 } from '../../types';
import { edges as allEdges } from '../polymesh';
import { createPrimitive } from '../primitives';
import { bevelEdges } from './bevel';
import { expectOutward, expectSolid, outwardProblem, position, signedVolume, solidProblem, vertexCount } from './bevel-testkit';
import type { MeshOpResult } from './types';

interface Expectation {
  /** Euler characteristic, default 2. */
  euler?: number;
  /** Convex shape around the origin: normals must point outward and the volume must shrink. Default true. */
  convex?: boolean;
}

/** Bevels and runs every generic check; returns the result for case-specific expectations. */
function bevel(mesh: PolyMesh, edges: readonly Edge[], width: number, segments: number, { euler = 2, convex = true }: Expectation = {}): MeshOpResult {
  const before = JSON.stringify(mesh);
  const result = bevelEdges(mesh, edges, width, segments);
  expect(JSON.stringify(mesh), 'input untouched').toBe(before);
  expectSolid(result.mesh, euler);
  if (convex) {
    expectOutward(result.mesh, ledges(mesh, edges, result));
    expect(signedVolume(result.mesh)).toBeLessThan(signedVolume(mesh) - 1e-9);
  }
  expect(signedVolume(result.mesh)).toBeGreaterThan(0);
  // The selection is exactly the faces that were added; the original faces keep their indices.
  expect(result.faces).toEqual(Array.from({ length: result.mesh.faces.length - mesh.faces.length }, (_, i) => mesh.faces.length + i));
  expect(result.faces!.length).toBeGreaterThanOrEqual(edges.length * segments);
  expect(result.vertices).toBeUndefined();
  expect(result.edges).toBeUndefined();
  return result;
}

/**
 * Where a bevel ends at a vertex with further edges straight ahead, the vertex stays and the cap between
 * it and the end of the strip is a small step that faces along the surface, not away from the origin.
 * These caps are the new faces that still use an end vertex of a bevelled edge.
 */
function ledges(mesh: PolyMesh, edges: readonly Edge[], result: MeshOpResult) {
  const ends = new Set(edges.flat());
  const caps = new Set(result.mesh.faces.slice(mesh.faces.length).filter((f) => f.some((v) => ends.has(v) && position(result.mesh, v).join() === position(mesh, v).join())));
  return (face: readonly number[]) => caps.has(face);
}

const sizes = (mesh: PolyMesh) => {
  const out: Record<number, number> = {};
  for (const f of mesh.faces) out[f.length] = (out[f.length] ?? 0) + 1;
  return out;
};

/** Distance of p from the line through a with unit direction d. */
function lineDistance(p: Vec3, a: Vec3, d: Vec3): number {
  const r = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const t = r[0] * d[0] + r[1] * d[1] + r[2] * d[2];
  return Math.hypot(r[0] - t * d[0], r[1] - t * d[1], r[2] - t * d[2]);
}

/** Deterministic pseudo random numbers in [0, 1). */
function random(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
}

// Cube with size 2: 0 (-,-,-)  1 (+,-,-)  2 (+,+,-)  3 (-,+,-)  4 (-,-,+)  5 (+,-,+)  6 (+,+,+)  7 (-,+,+)
const cube = createPrimitive('cube');
const cubeEdges = allEdges(cube);
const top: Edge[] = [[6, 7], [2, 6], [2, 3], [3, 7]];

describe('bevel: cube', () => {
  it('one edge, one segment: 10 vertices, 7 faces, the new vertices exactly `width` from the old edge', () => {
    const w = 0.3;
    const result = bevel(cube, [[2, 6]], w, 1); // the edge x = 1, y = 1
    expect(vertexCount(result.mesh)).toBe(10);
    expect(result.mesh.faces).toHaveLength(7);
    expect(result.faces).toEqual([6]);
    expect(sizes(result.mesh)).toEqual({ 4: 5, 5: 2 });
    const strip = result.mesh.faces[6];
    expect(strip).toHaveLength(4);
    for (const v of strip) {
      const p = position(result.mesh, v);
      expect(lineDistance(p, [1, 1, 0], [0, 0, 1])).toBeCloseTo(w, 12);
      expect(Math.abs(p[2])).toBe(1);
      // On the top face or on the +X face.
      expect(p[0] === 1 || p[1] === 1).toBe(true);
    }
    expect(strip.map((v) => position(result.mesh, v).join()).sort()).toEqual(['0.7,1,-1', '0.7,1,1', '1,0.7,-1', '1,0.7,1']);
    // Everything else stays where it was.
    for (const v of [0, 1, 3, 4, 5, 7]) expect(position(result.mesh, v)).toEqual(position(cube, v));
    expect(signedVolume(result.mesh)).toBeCloseTo(8 - w * w, 12);
  });

  it('accepts the edge in either vertex order and ignores duplicates', () => {
    const a = bevelEdges(cube, [[2, 6]], 0.3, 1);
    expect(bevelEdges(cube, [[6, 2]], 0.3, 1)).toEqual(a);
    expect(bevelEdges(cube, [[6, 2], [2, 6]], 0.3, 1)).toEqual(a);
  });

  it('one edge, several segments: a quarter circle', () => {
    const w = 0.4;
    for (const segments of [2, 3, 6]) {
      const result = bevel(cube, [[2, 6]], w, segments);
      expect(vertexCount(result.mesh)).toBe(8 + 2 * segments);
      // The strip plus one cap per end that fills the gap between the old face and the arc.
      expect(result.mesh.faces).toHaveLength(6 + segments + 2);
      for (let s = 0; s < segments; s++) {
        const quad = result.mesh.faces[6 + s];
        expect(quad).toHaveLength(4);
        for (const v of quad) expect(lineDistance(position(result.mesh, v), [1 - w, 1 - w, 0], [0, 0, 1])).toBeCloseTo(w, 12);
      }
      // Rounder than a chamfer, but less than the sharp cube.
      expect(signedVolume(result.mesh)).toBeGreaterThan(8 - w * w + 1e-6);
      expect(signedVolume(result.mesh)).toBeLessThan(8 - (1 - Math.PI / 4) * w * w * 2);
    }
  });

  it('closed loop: the four edges of the top face', () => {
    const w = 0.25;
    const result = bevel(cube, top, w, 1);
    expect(vertexCount(result.mesh)).toBe(12);
    expect(result.mesh.faces).toHaveLength(10);
    expect(sizes(result.mesh)).toEqual({ 4: 10 });
    // The top face is inset by w, the sides end w below the top.
    expect(result.mesh.faces[4].map((v) => position(result.mesh, v).map(Math.abs))).toEqual(Array(4).fill([0.75, 1, 0.75]));
    const below = result.faces!.flatMap((f) => result.mesh.faces[f]).map((v) => position(result.mesh, v)).filter((p) => p[1] !== 1);
    expect(below).toHaveLength(8);
    for (const p of below) expect(p.map(Math.abs)).toEqual([1, 0.75, 1]);
  });

  it('closed loop with segments: neighbouring strips share their mitre profile', () => {
    const w = 0.4;
    for (const segments of [2, 4]) {
      const result = bevel(cube, top, w, segments);
      expect(vertexCount(result.mesh)).toBe(4 + 4 * (segments + 1));
      expect(result.mesh.faces).toHaveLength(6 + 4 * segments);
      expect(sizes(result.mesh)).toEqual({ 4: 6 + 4 * segments });
      // Every strip vertex lies on the rounded edge: w away from the axis of the fillet.
      for (const f of result.faces!) {
        for (const v of result.mesh.faces[f]) {
          const p = position(result.mesh, v).map(Math.abs);
          const dx = Math.max(0, p[0] - (1 - w));
          const dz = Math.max(0, p[2] - (1 - w));
          expect(Math.hypot(Math.max(dx, dz), p[1] - (1 - w))).toBeCloseTo(w, 12);
        }
      }
    }
  });

  it('all twelve edges: 24 vertices and 6 + 12 + 8 faces', () => {
    const w = 0.2;
    const result = bevel(cube, cubeEdges, w, 1);
    expect(vertexCount(result.mesh)).toBe(24);
    expect(result.mesh.faces).toHaveLength(26);
    expect(sizes(result.mesh)).toEqual({ 4: 18, 3: 8 });
    expect(result.faces).toHaveLength(20);
    for (let v = 0; v < 24; v++) {
      expect(position(result.mesh, v).map((c) => +Math.abs(c).toFixed(12)).sort()).toEqual([0.8, 0.8, 1]);
    }
    // Twelve edge prisms of w * w each are cut away; where three of them overlap in a corner the
    // planes x + y, y + z, x + z = w leave 3/4 w^3 less, and the flat corner triangle takes w^3 / 12 more.
    expect(signedVolume(result.mesh)).toBeCloseTo(8 - 12 * w * w + (16 * w ** 3) / 3, 12);
  });

  it('all twelve edges with segments: a rounded cube', () => {
    const w = 0.5;
    const chamfered = signedVolume(bevelEdges(cube, cubeEdges, w, 1).mesh);
    let previous = chamfered;
    for (const segments of [2, 3, 4]) {
      const result = bevel(cube, cubeEdges, w, segments);
      // Per corner: 3 sector points, 3 arcs and the centre of the corner fan.
      expect(vertexCount(result.mesh)).toBe(8 * (3 + 3 * (segments - 1) + 1));
      expect(result.mesh.faces).toHaveLength(6 + 12 * segments + 8 * 3 * segments);
      // Every vertex is exactly w away from the cube shrunk by w.
      for (let v = 0; v < vertexCount(result.mesh); v++) {
        const p = position(result.mesh, v);
        expect(Math.hypot(...p.map((c) => Math.max(0, Math.abs(c) - (1 - w)))), `vertex ${v}`).toBeCloseTo(w, 12);
      }
      expect(signedVolume(result.mesh)).toBeGreaterThan(previous);
      previous = signedVolume(result.mesh);
    }
  });

  it('open chain, three edges at one corner, opposite edges', () => {
    for (const segments of [1, 2, 3]) {
      bevel(cube, [[2, 6], [6, 7]], 0.3, segments);
      bevel(cube, [[2, 6], [6, 7], [5, 6]], 0.3, segments);
      bevel(cube, [[2, 6], [3, 7]], 0.3, segments);
      bevel(cube, [[2, 6], [0, 4]], 0.3, segments);
      bevel(cube, [[2, 6], [6, 7], [3, 7], [4, 7], [4, 5]], 0.3, segments);
    }
    expect(vertexCount(bevel(cube, [[2, 6], [6, 7], [5, 6]], 0.3, 1).mesh)).toBe(8 + 2 + 3 * 1);
  });

  it('every subset of the twelve edges gives a valid solid', () => {
    for (const segments of [1, 2]) {
      for (let mask = 1; mask < 1 << 12; mask++) {
        const subset = cubeEdges.filter((_, i) => mask & (1 << i));
        const result = bevelEdges(cube, subset, 0.3, segments);
        const problem = solidProblem(result.mesh, 2) ?? outwardProblem(result.mesh);
        if (problem) throw new Error(`segments ${segments}, edges ${JSON.stringify(subset)}: ${problem}`);
        const volume = signedVolume(result.mesh);
        if (!(volume < 8 - 1e-9 && volume > 4)) throw new Error(`edges ${JSON.stringify(subset)}: volume ${volume}`);
        if (result.faces!.length !== result.mesh.faces.length - 6) throw new Error('selection');
      }
    }
  });

  it('rejects widths at which the offsets would cross', () => {
    expect(() => bevelEdges(cube, cubeEdges, 1, 1)).toThrow(/too large.*smaller than 1\b/);
    expect(() => bevelEdges(cube, cubeEdges, 1.5, 2)).toThrow(/too large/);
    bevel(cube, cubeEdges, 0.999, 1);
    // A single edge may use the whole neighbouring face, but not more.
    expect(() => bevelEdges(cube, [[2, 6]], 2, 1)).toThrow(/smaller than 2\b/);
    bevel(cube, [[2, 6]], 1.99, 2);
    // Two opposite edges of the top face share it.
    expect(() => bevelEdges(cube, [[2, 6], [3, 7]], 1, 1)).toThrow(/smaller than 1\b/);
  });

  it('rejects invalid input', () => {
    expect(() => bevelEdges(cube, [[0, 6]], 0.1, 1)).toThrow(/not an edge/);
    expect(() => bevelEdges(cube, [], 0.1, 1)).toThrow(/no edges/);
    expect(() => bevelEdges(cube, [[2, 6]], 0, 1)).toThrow(/width/);
    expect(() => bevelEdges(cube, [[2, 6]], -1, 1)).toThrow(/width/);
    expect(() => bevelEdges(cube, [[2, 6]], NaN, 1)).toThrow(/width/);
    expect(() => bevelEdges(cube, [[2, 6]], 0.1, 0)).toThrow(/segments/);
    expect(() => bevelEdges(cube, [[2, 6]], 0.1, 1.5)).toThrow(/segments/);
    expect(() => bevelEdges(createPrimitive('plane'), [[0, 1]], 0.1, 1)).toThrow(/exactly two faces/);
  });
});

describe('bevel: cylinder (n-gon caps)', () => {
  const N = 8;
  const cylinder = createPrimitive('cylinder', { segments: N });
  const rim: Edge[] = Array.from({ length: N }, (_, i) => (i === N - 1 ? [N, 2 * N - 1] : [N + i, N + i + 1]));

  it('the rim of the top cap', () => {
    const w = 0.2;
    const result = bevel(cylinder, rim, w, 1);
    expect(vertexCount(result.mesh)).toBe(3 * N);
    expect(sizes(result.mesh)).toEqual({ 4: 2 * N, [N]: 2 });
    const apothem = Math.cos(Math.PI / N);
    // The cap shrinks by w (measured perpendicular to its edges), the sides end w below it.
    for (const v of result.mesh.faces[N]) {
      const [x, y, z] = position(result.mesh, v);
      expect(y).toBe(1);
      expect(Math.hypot(x, z)).toBeCloseTo((apothem - w) / apothem, 12);
    }
    const below = result.faces!.flatMap((f) => result.mesh.faces[f]).map((v) => position(result.mesh, v)).filter((p) => p[1] !== 1);
    for (const [x, y, z] of below) {
      expect(y).toBeCloseTo(1 - w, 12);
      expect(Math.hypot(x, z)).toBeCloseTo(1, 12);
    }
  });

  it('rim with segments, both rims, single edges, everything', () => {
    const bottom: Edge[] = Array.from({ length: N }, (_, i) => (i === N - 1 ? [0, N - 1] : [i, i + 1]));
    const sides: Edge[] = Array.from({ length: N }, (_, i) => [i, N + i]);
    for (const segments of [1, 2, 3]) {
      bevel(cylinder, rim, 0.2, segments);
      bevel(cylinder, [...rim, ...bottom], 0.2, segments);
      bevel(cylinder, [[N, N + 1]], 0.2, segments); // one rim edge
      bevel(cylinder, [[0, N]], 0.2, segments); // one side edge
      bevel(cylinder, [[N, N + 1], [N + 1, N + 2], [1, N + 1]], 0.2, segments);
      bevel(cylinder, sides, 0.2, segments);
      const all = bevel(cylinder, [...rim, ...bottom, ...sides], 0.2, segments);
      if (segments === 1) {
        expect(vertexCount(all.mesh)).toBe(6 * N);
        expect(sizes(all.mesh)).toEqual({ 3: 2 * N, 4: 4 * N, [N]: 2 });
      }
    }
  });

  it('random edge sets', () => {
    const next = random(7);
    const candidates = allEdges(cylinder);
    for (let round = 0; round < 300; round++) {
      const subset = candidates.filter(() => next() < 0.3);
      if (subset.length === 0) continue;
      const result = bevelEdges(cylinder, subset, 0.15, 1 + (round % 3));
      const problem = solidProblem(result.mesh, 2) ?? outwardProblem(result.mesh);
      if (problem) throw new Error(`edges ${JSON.stringify(subset)}: ${problem}`);
      expect(signedVolume(result.mesh)).toBeLessThan(signedVolume(cylinder));
    }
  });

  it('rejects a width wider than the side faces', () => {
    const side = 2 * Math.sin(Math.PI / N);
    expect(() => bevelEdges(cylinder, [[0, N]], side * 1.001, 1)).toThrow(/too large/);
    bevel(cylinder, [[0, N]], side * 0.999, 1);
  });
});

describe('bevel: uv_sphere (four edges per vertex, poles)', () => {
  const SEG = 8;
  const RINGS = 6;
  const sphere = createPrimitive('uv_sphere', { segments: SEG, rings: RINGS });
  const at = (ring: number, i: number) => 1 + (ring - 1) * SEG + (i % SEG);
  const south = vertexCount(sphere) - 1;
  const latitude = (ring: number): Edge[] => Array.from({ length: SEG }, (_, i) => [at(ring, i), at(ring, i + 1)].sort((a, b) => a - b) as [number, number]);
  const meridian = (i: number): Edge[] => [
    [0, at(1, i)],
    ...Array.from({ length: RINGS - 2 }, (_, r): Edge => [at(r + 1, i), at(r + 2, i)]),
    [at(RINGS - 1, i), south],
  ];

  it('a latitude loop: the vertices slide along the meridians', () => {
    for (const segments of [1, 2, 3]) {
      const result = bevel(sphere, latitude(3), 0.1, segments);
      expect(vertexCount(result.mesh)).toBe(vertexCount(sphere) + SEG * segments);
      expect(result.mesh.faces).toHaveLength(sphere.faces.length + SEG * segments);
    }
    bevel(sphere, latitude(1), 0.1, 2); // next to the pole triangles
    bevel(sphere, [...latitude(2), ...latitude(4)], 0.1, 2);
  });

  it('a single edge keeps its end vertices for the edges straight ahead', () => {
    const edge: Edge = [at(2, 0), at(3, 0)];
    const result = bevel(sphere, [edge], 0.1, 1);
    // Per end: two new vertices beside the old one and a triangle between them.
    expect(vertexCount(result.mesh)).toBe(vertexCount(sphere) + 4);
    expect(result.faces).toHaveLength(3);
    expect(result.faces!.map((f) => result.mesh.faces[f].length)).toEqual([4, 3, 3]);
    expect(result.mesh.faces[result.faces![1]][0]).toBe(edge[0]);
    for (const v of edge) expect(position(result.mesh, v)).toEqual(position(sphere, v));
    for (const segments of [2, 3]) {
      const rounded = bevel(sphere, [edge], 0.1, segments);
      // The caps start at the kept vertex, so that a triangle fan from the first vertex is valid.
      const caps = rounded.faces!.slice(segments).map((f) => rounded.mesh.faces[f]);
      expect(caps.map((c) => c[0])).toEqual(edge);
      expect(caps.every((c) => c.length === segments + 2)).toBe(true);
    }
    bevel(sphere, [[at(2, 0), at(2, 1)]], 0.1, 2);
  });

  it('edges at a pole, a whole meridian circle, crossings', () => {
    for (const segments of [1, 2, 3]) {
      bevel(sphere, [[0, at(1, 0)]], 0.1, segments);
      bevel(sphere, meridian(0), 0.1, segments);
      // Through both poles: the pole stays, with one cap on each side.
      bevel(sphere, [...meridian(0), ...meridian(4)], 0.1, segments);
      bevel(sphere, [...meridian(0), ...meridian(2)], 0.1, segments);
      bevel(sphere, [...meridian(0), ...meridian(4), ...latitude(3)], 0.1, segments);
      bevel(sphere, [...meridian(0), ...meridian(1), ...meridian(2)], 0.05, segments);
    }
  });

  it('all edges', () => {
    for (const segments of [1, 2]) bevel(sphere, allEdges(sphere), 0.05, segments);
  });

  it('octahedron: every subset of its twelve edges gives a valid solid', () => {
    const octahedron = createPrimitive('uv_sphere', { segments: 4, rings: 2 });
    const candidates = allEdges(octahedron);
    expect(candidates).toHaveLength(12);
    const volume = signedVolume(octahedron);
    for (const segments of [1, 2]) {
      for (let mask = 1; mask < 1 << 12; mask++) {
        const subset = candidates.filter((_, i) => mask & (1 << i));
        const result = bevelEdges(octahedron, subset, 0.15, segments);
        const problem = solidProblem(result.mesh, 2) ?? outwardProblem(result.mesh, ledges(octahedron, subset, result));
        if (problem) throw new Error(`segments ${segments}, edges ${JSON.stringify(subset)}: ${problem}`);
        const after = signedVolume(result.mesh);
        if (!(after < volume - 1e-9 && after > volume / 2)) throw new Error(`edges ${JSON.stringify(subset)}: volume ${after}`);
      }
    }
  });

  it('icosahedron (five edges per vertex): random edge sets', () => {
    const ico = createPrimitive('ico_sphere', { subdivisions: 0 });
    const candidates = allEdges(ico);
    const next = random(3);
    for (let round = 0; round < 600; round++) {
      const subset = candidates.filter(() => next() < 0.1 + (round % 5) * 0.2);
      if (subset.length === 0) continue;
      const result = bevelEdges(ico, subset, 0.1, 1 + (round % 3));
      const problem = solidProblem(result.mesh, 2) ?? outwardProblem(result.mesh, ledges(ico, subset, result));
      if (problem) throw new Error(`edges ${JSON.stringify(subset)}: ${problem}`);
      expect(signedVolume(result.mesh)).toBeLessThan(signedVolume(ico));
    }
    bevel(ico, candidates, 0.1, 1);
    bevel(ico, candidates, 0.1, 3);
  });
});

describe('bevel: torus (genus 1)', () => {
  const SEG = 8;
  const MINOR = 6;
  const torus = createPrimitive('torus', { segments: SEG, minorSegments: MINOR });
  const at = (i: number, k: number) => (i % SEG) * MINOR + (k % MINOR);
  const edge = (a: number, b: number): Edge => (a < b ? [a, b] : [b, a]);
  const major = (k: number): Edge[] => Array.from({ length: SEG }, (_, i) => edge(at(i, k), at(i + 1, k)));
  const minor = (i: number): Edge[] => Array.from({ length: MINOR }, (_, k) => edge(at(i, k), at(i, k + 1)));
  const genus1: Expectation = { euler: 0, convex: false };

  it('closed loops in both directions', () => {
    for (const segments of [1, 2, 3]) {
      // The outer equator is convex: bevelling it removes volume.
      const outer = bevel(torus, major(0), 0.05, segments, genus1);
      expect(signedVolume(outer.mesh)).toBeLessThan(signedVolume(torus));
      expect(vertexCount(outer.mesh)).toBe(SEG * MINOR + SEG * segments);
      expect(outer.mesh.faces).toHaveLength(SEG * MINOR + SEG * segments);
      bevel(torus, major(3), 0.05, segments, genus1); // inner equator
      const around = bevel(torus, minor(2), 0.05, segments, genus1);
      expect(vertexCount(around.mesh)).toBe(SEG * MINOR + MINOR * segments);
      bevel(torus, [...major(0), ...major(2), ...minor(0), ...minor(4)], 0.05, segments, genus1);
    }
  });

  it('single edges, the four edges of one face, all edges', () => {
    for (const segments of [1, 2]) {
      const single = bevel(torus, [edge(at(0, 0), at(1, 0))], 0.05, segments, genus1);
      expect(signedVolume(single.mesh)).toBeLessThan(signedVolume(torus));
      bevel(torus, [edge(at(0, 0), at(0, 1))], 0.05, segments, genus1);
      const face = torus.faces[0];
      bevel(torus, face.map((v, i) => edge(v, face[(i + 1) % 4])), 0.05, segments, genus1);
      bevel(torus, allEdges(torus), 0.03, segments, genus1);
    }
  });

  it('random edge sets', () => {
    const next = random(11);
    const candidates = allEdges(torus);
    for (let round = 0; round < 300; round++) {
      const subset = candidates.filter(() => next() < 0.05 + (round % 4) * 0.2);
      if (subset.length === 0) continue;
      const result = bevelEdges(torus, subset, 0.03, 1 + (round % 3));
      const problem = solidProblem(result.mesh, 0);
      if (problem) throw new Error(`edges ${JSON.stringify(subset)}: ${problem}`);
      expect(signedVolume(result.mesh)).toBeGreaterThan(0);
    }
  });
});
