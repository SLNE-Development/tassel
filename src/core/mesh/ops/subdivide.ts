import type { PolyMesh } from '../../types';
import { edgeKey } from '../topology';
import type { MeshOpResult } from './types';
import { faceCentroid } from './util';

/**
 * Subdivides faces with `cuts` cuts per edge: quads become a grid of (cuts + 1)^2 quads, triangles
 * (cuts + 1)^2 triangles, n-gons a fan of triangles around their centroid. Unselected faces next to
 * a subdivided edge get the new edge vertices inserted, so the mesh stays watertight.
 * Selects the new faces.
 */
export function subdivideFaces(mesh: PolyMesh, faces: readonly number[], cuts: number): MeshOpResult {
  const selected = new Set(faces);
  if (selected.size === 0) throw new Error('Select at least one face to subdivide');
  for (const f of selected) if (!mesh.faces[f]) throw new Error(`Face ${f} does not exist`);
  const n = cuts + 1; // segments per edge
  const positions = [...mesh.positions];

  const addPoint = (x: number, y: number, z: number): number => {
    positions.push(x, y, z);
    return positions.length / 3 - 1;
  };
  /** a + (b - a) * s + (c - a) * t for vertex indices a, b, c. */
  const affine = (a: number, b: number, s: number, c: number, t: number): number =>
    addPoint(
      positions[a * 3] + (positions[b * 3] - positions[a * 3]) * s + (positions[c * 3] - positions[a * 3]) * t,
      positions[a * 3 + 1] + (positions[b * 3 + 1] - positions[a * 3 + 1]) * s + (positions[c * 3 + 1] - positions[a * 3 + 1]) * t,
      positions[a * 3 + 2] + (positions[b * 3 + 2] - positions[a * 3 + 2]) * s + (positions[c * 3 + 2] - positions[a * 3 + 2]) * t,
    );

  // New vertices per subdivided edge, ordered from the lower to the higher vertex index.
  const split = new Map<string, number[]>();
  for (const f of selected) {
    const face = mesh.faces[f];
    face.forEach((a, i) => {
      const b = face[(i + 1) % face.length];
      const key = edgeKey(a, b);
      if (split.has(key)) return;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      split.set(key, Array.from({ length: cuts }, (_, k) => affine(lo, hi, (k + 1) / n, lo, 0)));
    });
  }
  /** Point k of n on the edge from a to b (0 is a, n is b). */
  const onEdge = (a: number, b: number, k: number): number => {
    if (k === 0) return a;
    if (k === n) return b;
    const points = split.get(edgeKey(a, b))!;
    return a < b ? points[k - 1] : points[n - 1 - k];
  };

  const out: number[][] = [];
  const created: number[] = [];
  const emit = (face: number[]) => {
    created.push(out.length);
    out.push(face);
  };

  mesh.faces.forEach((face, f) => {
    if (!selected.has(f)) {
      // Take over the new vertices of edges shared with subdivided faces.
      const loop: number[] = [];
      face.forEach((a, i) => {
        const b = face[(i + 1) % face.length];
        loop.push(a);
        if (split.has(edgeKey(a, b))) for (let k = 1; k < n; k++) loop.push(onEdge(a, b, k));
      });
      out.push(loop);
      return;
    }

    if (face.length === 4) {
      const [a, b, c, d] = face;
      // grid[i][j]: i along a -> b, j along a -> d.
      const grid: number[][] = [];
      for (let i = 0; i <= n; i++) {
        grid.push([]);
        for (let j = 0; j <= n; j++) {
          if (j === 0) grid[i].push(onEdge(a, b, i));
          else if (j === n) grid[i].push(onEdge(d, c, i));
          else if (i === 0) grid[i].push(onEdge(a, d, j));
          else if (i === n) grid[i].push(onEdge(b, c, j));
          else {
            // Bilinear: a point on the line between the matching points of the edges a-d and b-c.
            grid[i].push(affine(onEdge(a, d, j), onEdge(b, c, j), i / n, a, 0));
          }
        }
      }
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) emit([grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]]);
      }
    } else if (face.length === 3) {
      const [a, b, c] = face;
      // grid[i][j] = a + (b - a) * i / n + (c - a) * j / n for i + j <= n.
      const grid: number[][] = [];
      for (let i = 0; i <= n; i++) {
        grid.push([]);
        for (let j = 0; i + j <= n; j++) {
          if (j === 0) grid[i].push(onEdge(a, b, i));
          else if (i === 0) grid[i].push(onEdge(a, c, j));
          else if (i + j === n) grid[i].push(onEdge(b, c, j));
          else grid[i].push(affine(a, b, i / n, c, j / n));
        }
      }
      for (let i = 0; i < n; i++) {
        for (let j = 0; i + j < n; j++) {
          emit([grid[i][j], grid[i + 1][j], grid[i][j + 1]]);
          if (i + j < n - 1) emit([grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]]);
        }
      }
    } else {
      const centre = addPoint(...faceCentroid(mesh, face));
      face.forEach((a, i) => {
        const b = face[(i + 1) % face.length];
        for (let k = 0; k < n; k++) emit([centre, onEdge(a, b, k), onEdge(a, b, k + 1)]);
      });
    }
  });

  return { mesh: { positions, faces: out }, faces: created };
}
