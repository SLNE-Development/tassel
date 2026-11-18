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

describe('triangulate: concave faces', () => {
  type P2 = [number, number];

  /** A face from 2D points (counter-clockwise), placed on a tilted plane to exercise the projection. */
  function tilted(points: P2[]): PolyMesh {
    const u = [0.6, 0.48, 0.64];
    const v = [-0.8, 0.36, 0.48]; // u, v orthonormal
    const positions = points.flatMap(([x, y]) => [1 + x * u[0] + y * v[0], 2 + x * u[1] + y * v[1], 3 + x * u[2] + y * v[2]]);
    return { positions, faces: [points.map((_, i) => i)] };
  }

  function polygonArea(points: P2[]): number {
    let sum = 0;
    points.forEach(([x, y], i) => {
      const [nx, ny] = points[(i + 1) % points.length];
      sum += x * ny - nx * y;
    });
    return sum / 2;
  }

  function inside(points: P2[], [x, y]: P2): boolean {
    let result = false;
    points.forEach(([ax, ay], i) => {
      const [bx, by] = points[(i + 1) % points.length];
      if (ay > y !== by > y && x < ax + ((y - ay) / (by - ay)) * (bx - ax)) result = !result;
    });
    return result;
  }

  /** Triangulates the polygon and checks: right count, same orientation, inside the polygon, areas add up. */
  function check(points: P2[]) {
    const mesh = tilted(points);
    const soup = triangulate(mesh);
    const n = faceNormal(mesh, mesh.faces[0]);
    expect(soup.triToFace).toHaveLength(points.length - 2);

    // Recover 2D coordinates by matching positions to vertices.
    const index = (t: number, c: number) => {
      const at = [...soup.positions.slice(t * 9 + c * 3, t * 9 + c * 3 + 3)];
      const found = points.findIndex((_, i) => at.every((value, a) => Math.abs(value - mesh.positions[i * 3 + a]) < 1e-5));
      expect(found).toBeGreaterThanOrEqual(0);
      return found;
    };
    let total = 0;
    for (let t = 0; t < soup.triToFace.length; t++) {
      const tri = [0, 1, 2].map((c) => points[index(t, c)]);
      const area = polygonArea(tri);
      expect(area).toBeGreaterThanOrEqual(-1e-9); // never flipped
      total += area;
      if (area > 1e-9) {
        const centre: P2 = [(tri[0][0] + tri[1][0] + tri[2][0]) / 3, (tri[0][1] + tri[1][1] + tri[2][1]) / 3];
        expect(inside(points, centre), `triangle ${t} of ${JSON.stringify(points)}`).toBe(true);
      }
      for (let c = 0; c < 3; c++) expect([...soup.normals.slice(t * 9 + c * 3, t * 9 + c * 3 + 3)]).toEqual(n.map(Math.fround));
    }
    expect(total).toBeCloseTo(polygonArea(points), 9);
  }

  const rotations = (points: P2[]) => points.map((_, i) => [...points.slice(i), ...points.slice(0, i)]);

  const shapes: Record<string, P2[]> = {
    'L-shaped hexagon': [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]],
    'arrow (concave quad)': [[0, 0], [2, 1], [0, 2], [0.5, 1]],
    'U shape': [[0, 0], [3, 0], [3, 3], [2, 3], [2, 1], [1, 1], [1, 3], [0, 3]],
    'star': Array.from({ length: 10 }, (_, i): P2 => {
      const r = i % 2 === 0 ? 2 : 0.7;
      return [r * Math.cos((i / 10) * Math.PI * 2), r * Math.sin((i / 10) * Math.PI * 2)];
    }),
    'comb': [[0, 0], [5, 0], [5, 2], [4, 2], [4, 1], [3, 1], [3, 2], [2, 2], [2, 1], [1, 1], [1, 2], [0, 2]],
    'square with edge midpoints': [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2], [1, 2], [0, 2], [0, 1]],
    'L with collinear vertices': [[0, 0], [1, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2], [0, 1]],
  };

  it.each(Object.entries(shapes))('%s, starting at every vertex', (_, points) => {
    for (const rotated of rotations(points)) check(rotated);
  });

  it('the L-shaped hexagon gives 4 triangles with a total area of 3', () => {
    const mesh = tilted(shapes['L-shaped hexagon']);
    const soup = triangulate(mesh);
    expect(soup.triToFace).toHaveLength(4);
    let area = 0;
    for (let t = 0; t < 4; t++) {
      const [ax, ay, az, bx, by, bz, cx, cy, cz] = soup.positions.slice(t * 9, t * 9 + 9);
      const u = [bx - ax, by - ay, bz - az];
      const v = [cx - ax, cy - ay, cz - az];
      area += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
    }
    expect(area).toBeCloseTo(3, 5);
  });
});

describe('triangulate: smooth normals', () => {
  it('keeps positions and face mapping, only the normals differ', () => {
    const mesh = createPrimitive('cylinder', { segments: 6 });
    const flat = triangulate(mesh);
    const smooth = triangulate(mesh, true);
    expect(smooth.positions).toEqual(flat.positions);
    expect(smooth.triToFace).toEqual(flat.triToFace);
    expect(smooth.normals).not.toEqual(flat.normals);
  });

  it('gives unit normals pointing radially on spheres', () => {
    for (const mesh of [createPrimitive('ico_sphere', { subdivisions: 3, radius: 2 }), createPrimitive('uv_sphere', { radius: 0.5 })]) {
      const soup = triangulate(mesh, true);
      for (let i = 0; i < soup.positions.length; i += 3) {
        const [x, y, z] = soup.positions.slice(i, i + 3);
        const [nx, ny, nz] = soup.normals.slice(i, i + 3);
        expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 5);
        expect((x * nx + y * ny + z * nz) / Math.hypot(x, y, z)).toBeGreaterThan(0.995); // within 6 degrees: area weighting is not exactly radial next to the poles
      }
    }
  });

  it('averages the face normals at a cube corner', () => {
    const soup = triangulate(cube, true);
    for (let i = 0; i < soup.positions.length; i += 3) {
      for (let a = 0; a < 3; a++) expect(soup.normals[i + a]).toBeCloseTo(soup.positions[i + a] / Math.sqrt(3), 6);
    }
  });

  it('weights by face area', () => {
    // A large and a small triangle sharing an edge, at a right angle: the shared vertices lean towards the large one.
    const mesh: PolyMesh = { positions: [0, 0, 0, 0, 0, 1, 10, 0, 0, 0, 1, 0], faces: [[0, 1, 2], [1, 0, 3]] };
    const soup = triangulate(mesh, true);
    const [nx, ny, nz] = soup.normals.slice(0, 3); // corner at vertex 0
    expect(nz).toBeCloseTo(0);
    expect(ny / nx).toBeCloseTo(10, 5); // areas 5 (normal +Y) and 0.5 (normal +X)
  });
});
