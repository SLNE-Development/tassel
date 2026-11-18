// Triangle data as loaders deliver it → PolyMesh.
import type { PolyMesh } from '../core/types';
import { tidyFloat } from './bytes';

export interface SoupInput {
  /** xyz per vertex. */
  positions: ArrayLike<number>;
  /** Vertex indices, three per triangle; null = the vertices are the triangle corners in order. */
  indices: ArrayLike<number> | null;
  /** uv per vertex, or null. */
  uvs?: ArrayLike<number> | null;
  /** Only these triangles: first index position and number of indices (like three's geometry groups). */
  start?: number;
  count?: number;
  /** Column-major 4x4 matrix applied to the positions. A mirroring matrix also reverses the winding. */
  matrix?: ArrayLike<number> | null;
  /** v → 1 - v, for sources whose v axis points down (glTF). */
  flipV?: boolean;
}

/**
 * Builds a PolyMesh of triangles: vertices at the same position (after rounding away float32 noise)
 * become one vertex, UVs stay per face corner, and triangles that are degenerate after welding or
 * have non-finite coordinates are dropped.
 */
export function soupToPolyMesh(input: SoupInput): { mesh: PolyMesh; dropped: number } {
  const { positions: p, indices, uvs: uvIn = null, matrix: m = null, flipV = false } = input;
  const total = indices ? indices.length : p.length / 3;
  const start = Math.max(0, input.start ?? 0);
  const end = Math.min(total, start + (input.count ?? Infinity));
  const mirrored =
    m !== null &&
    m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]) < 0;

  // Pass 1: every source vertex gets the id of its welded position (-1 = unusable).
  const welded = new Map<string, number>();
  const coords: number[] = [];
  const weldOf = new Int32Array(p.length / 3);
  for (let i = 0; i < weldOf.length; i++) {
    let x = p[i * 3];
    let y = p[i * 3 + 1];
    let z = p[i * 3 + 2];
    if (m) [x, y, z] = [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      weldOf[i] = -1;
      continue;
    }
    x = tidyFloat(x) || 0;
    y = tidyFloat(y) || 0;
    z = tidyFloat(z) || 0;
    const key = `${x},${y},${z}`;
    let id = welded.get(key);
    if (id === undefined) {
      id = coords.length / 3;
      coords.push(x, y, z);
      welded.set(key, id);
    }
    weldOf[i] = id;
  }

  // Pass 2: triangles; a welded position becomes a vertex when the first surviving triangle uses it.
  const positions: number[] = [];
  const faces: number[][] = [];
  const uvs: number[][] = [];
  const vertexOf = new Int32Array(coords.length / 3).fill(-1);
  const vertex = (id: number) => {
    if (vertexOf[id] === -1) {
      vertexOf[id] = positions.length / 3;
      positions.push(coords[id * 3], coords[id * 3 + 1], coords[id * 3 + 2]);
    }
    return vertexOf[id];
  };
  const weld = (i: number) => (i >= 0 && i < weldOf.length ? weldOf[i] : -1);
  let dropped = 0;
  for (let t = start; t + 2 < end; t += 3) {
    const src = [indices ? indices[t] : t, indices ? indices[t + 1] : t + 1, indices ? indices[t + 2] : t + 2];
    if (mirrored) [src[1], src[2]] = [src[2], src[1]];
    const a = weld(src[0]);
    const b = weld(src[1]);
    const c = weld(src[2]);
    if (a === -1 || b === -1 || c === -1 || a === b || b === c || a === c) {
      dropped++;
      continue;
    }
    faces.push([vertex(a), vertex(b), vertex(c)]);
    if (uvIn) {
      const uv: number[] = [];
      for (const s of src) {
        const u = Number(uvIn[s * 2]);
        const v = Number(uvIn[s * 2 + 1]);
        uv.push(Number.isFinite(u) ? tidyFloat(u) || 0 : 0, Number.isFinite(v) ? tidyFloat(flipV ? Math.fround(1 - v) : v) || 0 : 0);
      }
      uvs.push(uv);
    }
  }
  return { mesh: uvIn ? { positions, faces, uvs } : { positions, faces }, dropped };
}

/**
 * Whether the normals of the triangle data describe a smooth surface: true if a good part of the
 * triangles has corner normals that differ from each other (flat shading gives every corner the face normal).
 */
export function looksSmooth(normals: ArrayLike<number> | null | undefined, indices: ArrayLike<number> | null, vertexCount: number): boolean {
  if (!normals) return false;
  const total = indices ? indices.length : vertexCount;
  let smooth = 0;
  let triangles = 0;
  for (let t = 0; t + 2 < total; t += 3) {
    const a = (indices ? indices[t] : t) * 3;
    const b = (indices ? indices[t + 1] : t + 1) * 3;
    const c = (indices ? indices[t + 2] : t + 2) * 3;
    const dot = (i: number, j: number) => normals[i] * normals[j] + normals[i + 1] * normals[j + 1] + normals[i + 2] * normals[j + 2];
    triangles++;
    if (dot(a, b) < 0.9999 || dot(a, c) < 0.9999) smooth++;
  }
  return triangles > 0 && smooth / triangles > 0.25;
}
