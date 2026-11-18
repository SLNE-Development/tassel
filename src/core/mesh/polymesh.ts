import { z } from 'zod';
import type { PolyMesh, Vec3 } from '../types';

/** Validates untrusted mesh data (project files, MCP input). */
export const polyMeshSchema = z
  .object({
    positions: z.array(z.number().finite()),
    faces: z.array(z.array(z.number().int().nonnegative()).min(3)),
    uvs: z.array(z.array(z.number().finite())).optional(),
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
    if (m.uvs) {
      if (m.uvs.length !== m.faces.length) {
        ctx.addIssue({ code: 'custom', message: 'uvs must have one entry per face' });
        return;
      }
      if (m.uvs.some((uv, f) => uv.length !== m.faces[f].length * 2)) {
        ctx.addIssue({ code: 'custom', message: 'uvs must hold two numbers per face corner' });
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
  /** Texture coordinates, 6 floats per triangle (u, v per corner, same corner order as positions). Only if the mesh has UVs. */
  uvs?: Float32Array;
}

/** Newell vector of a face: its direction is the face normal, its length twice the face area. */
export function newell(p: readonly number[], face: readonly number[]): Vec3 {
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
  return [nx, ny, nz];
}

/** Twice the signed area of triangle (a, b, c) seen against the direction n. */
function signedArea(p: readonly number[], a: number, b: number, c: number, n: Vec3): number {
  const ux = p[b * 3] - p[a * 3];
  const uy = p[b * 3 + 1] - p[a * 3 + 1];
  const uz = p[b * 3 + 2] - p[a * 3 + 2];
  const vx = p[c * 3] - p[a * 3];
  const vy = p[c * 3 + 1] - p[a * 3 + 1];
  const vz = p[c * 3 + 2] - p[a * 3 + 2];
  return (uy * vz - uz * vy) * n[0] + (uz * vx - ux * vz) * n[1] + (ux * vy - uy * vx) * n[2];
}

/** Ear clipping of a face projected onto its plane (normal `n`, not necessarily unit). Appends corner index triples. */
function earClip(p: readonly number[], face: readonly number[], n: Vec3, out: number[]): void {
  // 2D coordinates in a basis (u, v) with u x v = n, so the polygon is counter-clockwise.
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  const nx = n[0] / len;
  const ny = n[1] / len;
  const nz = n[2] / len;
  const ax = Math.abs(nx);
  const ay = Math.abs(ny);
  const az = Math.abs(nz);
  // Helper axis: the one the normal is least aligned with.
  const h: Vec3 = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
  let ux = h[1] * nz - h[2] * ny;
  let uy = h[2] * nx - h[0] * nz;
  let uz = h[0] * ny - h[1] * nx;
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul;
  uy /= ul;
  uz /= ul;
  const vx = ny * uz - nz * uy;
  const vy = nz * ux - nx * uz;
  const vz = nx * uy - ny * ux;
  const xs = face.map((i) => p[i * 3] * ux + p[i * 3 + 1] * uy + p[i * 3 + 2] * uz);
  const ys = face.map((i) => p[i * 3] * vx + p[i * 3 + 1] * vy + p[i * 3 + 2] * vz);
  const cross = (a: number, b: number, c: number) => (xs[b] - xs[a]) * (ys[c] - ys[a]) - (ys[b] - ys[a]) * (xs[c] - xs[a]);
  const eps = len * 1e-12;

  const rest = face.map((_, i) => i); // positions within `face` still to be clipped
  while (rest.length > 3) {
    let ear = -1;
    for (let i = 0; i < rest.length && ear === -1; i++) {
      const a = rest[(i + rest.length - 1) % rest.length];
      const b = rest[i];
      const c = rest[(i + 1) % rest.length];
      if (cross(a, b, c) <= eps) continue; // reflex or straight corner
      // An ear must not contain (or touch) any other remaining vertex.
      let empty = true;
      for (const q of rest) {
        if (q === a || q === b || q === c) continue;
        if (cross(a, b, q) >= -eps && cross(b, c, q) >= -eps && cross(c, a, q) >= -eps) {
          empty = false;
          break;
        }
      }
      if (empty) ear = i;
    }
    // Self-intersecting or degenerate polygons may have no ear; clip anything so that we terminate.
    if (ear === -1) ear = 0;
    const a = rest[(ear + rest.length - 1) % rest.length];
    const c = rest[(ear + 1) % rest.length];
    out.push(a, rest[ear], c);
    rest.splice(ear, 1);
  }
  out.push(rest[0], rest[1], rest[2]);
}

/**
 * Splits one face into triangles, appended to `out` as triples of corner indices (positions within
 * `face`), keeping the winding. Convex faces are fanned from their first vertex; concave ones are
 * ear clipped in the face plane.
 */
export function triangulateFaceCorners(mesh: PolyMesh, face: readonly number[], out: number[]): void {
  const count = face.length;
  if (count === 3) {
    out.push(0, 1, 2);
    return;
  }
  const p = mesh.positions;
  const n = newell(p, face);
  // If every fan triangle has the face's orientation, the face is star-shaped seen from its first
  // vertex and the fan is a valid triangulation. That covers all convex faces.
  const tolerance = -1e-9 * (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
  let fan = true;
  for (let i = 1; i < count - 1 && fan; i++) fan = signedArea(p, face[0], face[i], face[i + 1], n) >= tolerance;
  if (fan) {
    for (let i = 1; i < count - 1; i++) out.push(0, i, i + 1);
  } else if (count === 4) {
    // Concave quad with the reflex corner at vertex 1 or 3: use the other diagonal.
    out.push(1, 2, 3, 1, 3, 0);
  } else {
    earClip(p, face, n, out);
  }
}

/** Like `triangulateFaceCorners`, but appends vertex index triples. */
export function triangulateFace(mesh: PolyMesh, face: readonly number[], out: number[]): void {
  const start = out.length;
  triangulateFaceCorners(mesh, face, out);
  for (let i = start; i < out.length; i++) out[i] = face[out[i]];
}

/**
 * Triangulates all faces (also concave ones). Triangles keep the winding of their face.
 * `smooth` = area-weighted averaged vertex normals instead of flat per-face normals.
 */
export function triangulate(mesh: PolyMesh, smooth = false): TriangleSoup {
  let triCount = 0;
  for (const f of mesh.faces) triCount += f.length - 2;
  const positions = new Float32Array(triCount * 9);
  const normals = new Float32Array(triCount * 9);
  const triToFace = new Uint32Array(triCount);
  const uvs = mesh.uvs ? new Float32Array(triCount * 6) : undefined;
  const p = mesh.positions;

  let vertexNormals: Float64Array | null = null;
  if (smooth) {
    // The Newell vector's length is twice the face area, so summing it weights by area.
    vertexNormals = new Float64Array(p.length);
    for (const face of mesh.faces) {
      const n = newell(p, face);
      for (const v of face) {
        vertexNormals[v * 3] += n[0];
        vertexNormals[v * 3 + 1] += n[1];
        vertexNormals[v * 3 + 2] += n[2];
      }
    }
    for (let i = 0; i < vertexNormals.length; i += 3) {
      const len = Math.hypot(vertexNormals[i], vertexNormals[i + 1], vertexNormals[i + 2]) || 1;
      vertexNormals[i] /= len;
      vertexNormals[i + 1] /= len;
      vertexNormals[i + 2] /= len;
    }
  }

  let t = 0;
  const corners: number[] = [];
  mesh.faces.forEach((face, fi) => {
    corners.length = 0;
    triangulateFaceCorners(mesh, face, corners);
    const n = vertexNormals ? null : faceNormal(mesh, face);
    const uv = uvs && mesh.uvs![fi];
    for (let c = 0; c < corners.length; c++) {
      const src = face[corners[c]] * 3;
      const dst = t * 9 + (c % 3) * 3;
      if (uv) {
        uvs[t * 6 + (c % 3) * 2] = uv[corners[c] * 2];
        uvs[t * 6 + (c % 3) * 2 + 1] = uv[corners[c] * 2 + 1];
      }
      positions[dst] = p[src];
      positions[dst + 1] = p[src + 1];
      positions[dst + 2] = p[src + 2];
      normals[dst] = n ? n[0] : vertexNormals![src];
      normals[dst + 1] = n ? n[1] : vertexNormals![src + 1];
      normals[dst + 2] = n ? n[2] : vertexNormals![src + 2];
      if (c % 3 === 2) triToFace[t++] = fi;
    }
  });
  return uvs ? { positions, normals, triToFace, uvs } : { positions, normals, triToFace };
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
