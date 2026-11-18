import { z } from 'zod';
import type { PolyMesh, Vec3 } from '../types';

/** Validates untrusted mesh data (project files, MCP input). */
export const polyMeshSchema = z
  .object({
    positions: z.array(z.number().finite()),
    faces: z.array(z.array(z.number().int().nonnegative()).min(3)),
  })
  .superRefine((m, ctx) => {
    if (m.positions.length % 3 !== 0) {
      ctx.addIssue({ code: 'custom', message: 'positions length must be a multiple of 3' });
      return;
    }
    const count = m.positions.length / 3;
    for (const face of m.faces) {
      if (face.some((i) => i >= count)) {
        ctx.addIssue({ code: 'custom', message: 'face references a vertex that does not exist' });
        return;
      }
    }
  });

/** Unit face normal via Newell's method (robust for n-gons). */
export function faceNormal(mesh: PolyMesh, face: readonly number[]): Vec3 {
  const p = mesh.positions;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < face.length; i++) {
    const a = face[i] * 3;
    const b = face[(i + 1) % face.length] * 3;
    nx += (p[a + 1] - p[b + 1]) * (p[a + 2] + p[b + 2]);
    ny += (p[a + 2] - p[b + 2]) * (p[a] + p[b]);
    nz += (p[a] - p[b]) * (p[a + 1] + p[b + 1]);
  }
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

export interface TriangleSoup {
  /** Non-indexed triangle positions, 9 floats per triangle. */
  positions: Float32Array;
  /** Flat per-face normals, same layout as positions. */
  normals: Float32Array;
  /** Maps each triangle to the index of the face it came from. */
  triToFace: Uint32Array;
}

/**
 * Fan triangulation. Correct for convex faces.
 * `smooth` = averaged vertex normals instead of flat per-face normals (not implemented yet).
 */
export function triangulate(mesh: PolyMesh, _smooth = false): TriangleSoup {
  let triCount = 0;
  for (const f of mesh.faces) triCount += f.length - 2;
  const positions = new Float32Array(triCount * 9);
  const normals = new Float32Array(triCount * 9);
  const triToFace = new Uint32Array(triCount);
  const p = mesh.positions;
  let t = 0;
  mesh.faces.forEach((face, fi) => {
    const n = faceNormal(mesh, face);
    for (let i = 1; i < face.length - 1; i++) {
      const corners = [face[0], face[i], face[i + 1]];
      for (let c = 0; c < 3; c++) {
        const src = corners[c] * 3;
        const dst = t * 9 + c * 3;
        positions[dst] = p[src];
        positions[dst + 1] = p[src + 1];
        positions[dst + 2] = p[src + 2];
        normals[dst] = n[0];
        normals[dst + 1] = n[1];
        normals[dst + 2] = n[2];
      }
      triToFace[t++] = fi;
    }
  });
  return { positions, normals, triToFace };
}

/** Unique edges as vertex index pairs [a, b] with a < b. */
export function edges(mesh: PolyMesh): [number, number][] {
  const seen = new Set<string>();
  const out: [number, number][] = [];
  for (const face of mesh.faces) {
    for (let i = 0; i < face.length; i++) {
      const a = face[i];
      const b = face[(i + 1) % face.length];
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const key = `${lo}:${hi}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push([lo, hi]);
      }
    }
  }
  return out;
}

/** Edge line segments for wireframe rendering, 6 floats per edge. */
export function wireframePositions(mesh: PolyMesh): Float32Array {
  const list = edges(mesh);
  const out = new Float32Array(list.length * 6);
  list.forEach(([a, b], i) => {
    out.set(mesh.positions.slice(a * 3, a * 3 + 3), i * 6);
    out.set(mesh.positions.slice(b * 3, b * 3 + 3), i * 6 + 3);
  });
  return out;
}

/** Local-space bounding box, or null for an empty mesh. */
export function boundingBox(mesh: PolyMesh): { min: Vec3; max: Vec3 } | null {
  const p = mesh.positions;
  if (p.length === 0) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      if (p[i + a] < min[a]) min[a] = p[i + a];
      if (p[i + a] > max[a]) max[a] = p[i + a];
    }
  }
  return { min, max };
}

export function meshStats(mesh: PolyMesh) {
  let triangles = 0;
  for (const f of mesh.faces) triangles += f.length - 2;
  return {
    vertices: mesh.positions.length / 3,
    edges: edges(mesh).length,
    faces: mesh.faces.length,
    triangles,
  };
}
