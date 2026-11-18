import { describe, expect, it } from 'vitest';
import type { PolyMesh } from '../types';
import { boundingBox, edges, faceNormal, meshStats, polyMeshSchema, triangulate, wireframePositions } from './polymesh';
import { createPrimitive } from './primitives';

const cube = createPrimitive('cube', { size: 2 });

/** Regular pentagon in the XZ plane, CCW seen from +Y, plus a triangle hanging off one edge. */
const pentagon: PolyMesh = (() => {
  const positions: number[] = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    positions.push(Math.cos(a), 0, -Math.sin(a));
  }
  positions.push(2, 1, 0);
  return { positions, faces: [[0, 1, 2, 3, 4], [0, 5, 1]] };
})();

describe('faceNormal', () => {
  it('returns unit normals following the winding', () => {
    expect(faceNormal(cube, cube.faces[0])).toEqual([0, 0, 1]);
    expect(faceNormal(cube, [...cube.faces[0]].reverse())).toEqual([0, 0, -1]);
    const n = faceNormal(pentagon, pentagon.faces[0]);
    expect(n[0]).toBeCloseTo(0);
    expect(n[1]).toBeCloseTo(1);
    expect(n[2]).toBeCloseTo(0);
  });

  it('returns a zero vector for a degenerate face instead of NaN', () => {
    const line: PolyMesh = { positions: [0, 0, 0, 1, 0, 0, 2, 0, 0], faces: [[0, 1, 2]] };
    expect(faceNormal(line, line.faces[0])).toEqual([0, 0, 0]);
  });
});

describe('triangulate', () => {
  it('splits quads into two triangles each', () => {
    const soup = triangulate(cube);
    expect(soup.positions).toHaveLength(12 * 9);
    expect(soup.normals).toHaveLength(12 * 9);
    expect([...soup.triToFace]).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
  });

  it('fans from the first vertex and keeps the winding', () => {
    const soup = triangulate(cube);
    // Face 0 is [4, 5, 6, 7] => triangles (4, 5, 6) and (4, 6, 7).
    const corner = (i: number) => cube.positions.slice(i * 3, i * 3 + 3);
    expect([...soup.positions.slice(0, 18)]).toEqual([4, 5, 6, 4, 6, 7].flatMap(corner));
  });

  it('writes the flat face normal to every corner', () => {
    const soup = triangulate(cube);
    for (let t = 0; t < 12; t++) {
      const n = faceNormal(cube, cube.faces[soup.triToFace[t]]);
      for (let c = 0; c < 3; c++) expect([...soup.normals.slice(t * 9 + c * 3, t * 9 + c * 3 + 3)]).toEqual(n);
    }
  });

  it('produces triangles whose own normal matches the face normal', () => {
    const mesh = createPrimitive('cylinder', { segments: 7 });
    const soup = triangulate(mesh);
    for (let t = 0; t < soup.triToFace.length; t++) {
      const [ax, ay, az, bx, by, bz, cx, cy, cz] = soup.positions.slice(t * 9, t * 9 + 9);
      const u = [bx - ax, by - ay, bz - az];
      const v = [cx - ax, cy - ay, cz - az];
      const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const d = cross[0] * soup.normals[t * 9] + cross[1] * soup.normals[t * 9 + 1] + cross[2] * soup.normals[t * 9 + 2];
      expect(d).toBeGreaterThan(0);
    }
  });

  it('handles n-gons, mixed face sizes and empty meshes', () => {
    const soup = triangulate(pentagon);
    expect([...soup.triToFace]).toEqual([0, 0, 0, 1]);
    expect(soup.positions).toHaveLength(4 * 9);
    const empty = triangulate({ positions: [], faces: [] });
    expect(empty.positions).toHaveLength(0);
    expect(empty.triToFace).toHaveLength(0);
  });
});

describe('edges', () => {
  it('returns each undirected edge once as [lo, hi]', () => {
    const list = edges(cube);
    expect(list).toHaveLength(12);
    for (const [a, b] of list) expect(a).toBeLessThan(b);
    expect(new Set(list.map(([a, b]) => `${a}:${b}`)).size).toBe(12);
  });

  it('includes the closing edge of every face and shares edges between faces', () => {
    const key = (list: [number, number][]) => list.map(([a, b]) => `${a}:${b}`).sort();
    expect(key(edges(pentagon))).toEqual(['0:1', '0:4', '0:5', '1:2', '1:5', '2:3', '3:4']);
    expect(edges({ positions: [], faces: [] })).toEqual([]);
  });

  it('wireframePositions has two points per edge', () => {
    const lines = wireframePositions(pentagon);
    expect(lines).toHaveLength(7 * 6);
    const [a, b] = edges(pentagon)[0];
    expect([...lines.slice(0, 6)]).toEqual(
      [...pentagon.positions.slice(a * 3, a * 3 + 3), ...pentagon.positions.slice(b * 3, b * 3 + 3)].map(Math.fround),
    );
  });
});

describe('boundingBox', () => {
  it('returns min and max per axis', () => {
    expect(boundingBox(cube)).toEqual({ min: [-1, -1, -1], max: [1, 1, 1] });
    expect(boundingBox({ positions: [1, -2, 3, -4, 5, -6, 0, 0, 0], faces: [] })).toEqual({
      min: [-4, -2, -6],
      max: [1, 5, 3],
    });
  });

  it('handles a single vertex and an empty mesh', () => {
    expect(boundingBox({ positions: [1, 2, 3], faces: [] })).toEqual({ min: [1, 2, 3], max: [1, 2, 3] });
    expect(boundingBox({ positions: [], faces: [] })).toBeNull();
  });
});

describe('meshStats', () => {
  it('counts vertices, edges, faces and triangles', () => {
    expect(meshStats(cube)).toEqual({ vertices: 8, edges: 12, faces: 6, triangles: 12 });
    expect(meshStats(pentagon)).toEqual({ vertices: 6, edges: 7, faces: 2, triangles: 4 });
    expect(meshStats({ positions: [], faces: [] })).toEqual({ vertices: 0, edges: 0, faces: 0, triangles: 0 });
  });
});

describe('polyMeshSchema', () => {
  const triangle = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], faces: [[0, 1, 2]] };
  const ok = (value: unknown) => polyMeshSchema.safeParse(value).success;

  it('accepts valid meshes', () => {
    expect(ok(triangle)).toBe(true);
    expect(ok(cube)).toBe(true);
    expect(ok({ positions: [], faces: [] })).toBe(true);
    expect(polyMeshSchema.parse(triangle)).toEqual(triangle);
  });

  it('rejects positions that are not xyz triples', () => {
    expect(ok({ ...triangle, positions: [0, 0, 0, 1, 0, 0, 0, 1] })).toBe(false);
  });

  it('rejects non-finite or non-numeric coordinates', () => {
    expect(ok({ ...triangle, positions: [0, 0, 0, 1, 0, 0, 0, 1, NaN] })).toBe(false);
    expect(ok({ ...triangle, positions: [0, 0, 0, 1, 0, 0, 0, 1, Infinity] })).toBe(false);
    expect(ok({ ...triangle, positions: [0, 0, 0, 1, 0, 0, 0, 1, '0'] })).toBe(false);
    expect(ok({ ...triangle, positions: [0, 0, 0, 1, 0, 0, 0, 1, null] })).toBe(false);
  });

  it('rejects faces referencing vertices that do not exist', () => {
    expect(ok({ ...triangle, faces: [[0, 1, 3]] })).toBe(false);
    expect(ok({ positions: [], faces: [[0, 1, 2]] })).toBe(false);
    const result = polyMeshSchema.safeParse({ ...triangle, faces: [[0, 1, 3]] });
    expect(result.error?.issues[0].message).toMatch(/does not exist/);
  });

  it('rejects faces with fewer than three corners', () => {
    expect(ok({ ...triangle, faces: [[0, 1]] })).toBe(false);
    expect(ok({ ...triangle, faces: [[]] })).toBe(false);
  });

  it('rejects negative and fractional indices', () => {
    expect(ok({ ...triangle, faces: [[0, 1, -1]] })).toBe(false);
    expect(ok({ ...triangle, faces: [[0, 1, 1.5]] })).toBe(false);
  });

  it('rejects wrong shapes', () => {
    expect(ok(null)).toBe(false);
    expect(ok({ positions: triangle.positions })).toBe(false);
    expect(ok({ faces: triangle.faces })).toBe(false);
    expect(ok({ positions: 'abc', faces: [] })).toBe(false);
    expect(ok({ ...triangle, faces: [0, 1, 2] })).toBe(false);
  });
});
