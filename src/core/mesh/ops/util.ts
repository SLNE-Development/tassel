import type { PolyMesh, Vec3 } from '../../types';
import { faceNormal } from '../polymesh';

export const vertexCount = (mesh: PolyMesh): number => mesh.positions.length / 3;

export function position(mesh: PolyMesh, v: number): Vec3 {
  return [mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]];
}

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

/** Unit vector, or the zero vector if `a` has no length. */
export function normalize(a: Vec3): Vec3 {
  const len = length(a);
  return len > 0 ? [a[0] / len, a[1] / len, a[2] / len] : [0, 0, 0];
}

/** Average of the face's vertex positions. */
export function faceCentroid(mesh: PolyMesh, face: readonly number[]): Vec3 {
  const c: Vec3 = [0, 0, 0];
  for (const v of face) {
    c[0] += mesh.positions[v * 3];
    c[1] += mesh.positions[v * 3 + 1];
    c[2] += mesh.positions[v * 3 + 2];
  }
  return scale(c, 1 / face.length);
}

/** Area of a (planar) face, via Newell's method. */
export function faceArea(mesh: PolyMesh, face: readonly number[]): number {
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
  return Math.hypot(nx, ny, nz) / 2;
}

/** Unit normals of all faces. */
export function faceNormals(mesh: PolyMesh): Vec3[] {
  return mesh.faces.map((face) => faceNormal(mesh, face));
}

/** Centre of the bounding box of the given vertices. */
export function boundsCentre(mesh: PolyMesh, vertices: readonly number[]): Vec3 {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const v of vertices) {
    for (let a = 0; a < 3; a++) {
      const value = mesh.positions[v * 3 + a];
      if (value < min[a]) min[a] = value;
      if (value > max[a]) max[a] = value;
    }
  }
  return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
}

/**
 * Drops vertices no face uses. Unlike `compact` in topology.ts the remaining vertices keep their
 * order, so indices only shift down. `remap[old]` is the new index, or -1 for removed vertices.
 * Faces are not touched, so UVs are carried over.
 */
export function dropUnused(mesh: PolyMesh): { mesh: PolyMesh; remap: Int32Array } {
  const count = vertexCount(mesh);
  const remap = new Int32Array(count).fill(-1);
  for (const face of mesh.faces) for (const v of face) remap[v] = 0;
  const positions: number[] = [];
  for (let v = 0; v < count; v++) {
    if (remap[v] === -1) continue;
    remap[v] = positions.length / 3;
    positions.push(mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]);
  }
  if (positions.length === mesh.positions.length) return { mesh, remap };
  const faces = mesh.faces.map((f) => f.map((v) => remap[v]));
  return { mesh: mesh.uvs ? { positions, faces, uvs: mesh.uvs } : { positions, faces }, remap };
}

/**
 * Splits a vertex loop that may visit vertices more than once into simple loops and drops the
 * ones with fewer than three vertices. [a, a, b, c] -> [[a, b, c]]; [x, a, b, x, c, d] -> two triangles.
 * The loops are returned as corner indices (positions within `loop`), so that per-corner data can follow.
 */
function simpleLoops(loop: readonly number[]): number[][] {
  const out: number[][] = [];
  const path: number[] = [];
  for (let corner = 0; corner < loop.length; corner++) {
    const at = path.findIndex((c) => loop[c] === loop[corner]);
    if (at === -1) {
      path.push(corner);
      continue;
    }
    // Returned to a vertex of the path: what lies in between is a loop of its own.
    if (path.length - at >= 3) out.push(path.slice(at));
    path.length = at + 1;
  }
  if (path.length >= 3) out.push(path);
  return out;
}

/** Key that is equal for faces with the same vertex cycle; `reversed` tells the two orientations apart. */
function cycleKey(face: readonly number[]): { key: string; reversed: boolean } {
  let start = 0;
  for (let i = 1; i < face.length; i++) if (face[i] < face[start]) start = i;
  const n = face.length;
  const reversed = face[(start + 1) % n] > face[(start + n - 1) % n];
  const cycle = face.map((_, i) => face[(start + (reversed ? n - i : i)) % n]);
  return { key: cycle.join(','), reversed };
}

/**
 * Welds vertices: `target[v]` is the vertex that replaces v (itself if it stays).
 * Faces that collapse below three distinct vertices are removed, pinched faces are split, of
 * identical faces one is kept, and two faces lying back to back on the same vertices (they enclose
 * nothing) are both removed. Unused vertices are dropped; `remap[old]` is the new index or -1.
 * UVs follow the surviving face corners (a welded corner keeps the UV of the first corner welded into it).
 */
export function weld(mesh: PolyMesh, target: ArrayLike<number>): { mesh: PolyMesh; remap: Int32Array } {
  const candidates: number[][] = [];
  const candidateUvs: number[][] = [];
  mesh.faces.forEach((face, f) => {
    const welded = face.map((v) => target[v]);
    for (const corners of simpleLoops(welded)) {
      candidates.push(corners.map((c) => welded[c]));
      if (mesh.uvs) candidateUvs.push(corners.flatMap((c) => [mesh.uvs![f][c * 2], mesh.uvs![f][c * 2 + 1]]));
    }
  });

  // Per vertex cycle: how many faces use it in each orientation.
  const groups = new Map<string, { forward: number; backward: number; kept: boolean }>();
  const keys = candidates.map((face) => {
    const { key, reversed } = cycleKey(face);
    const group = groups.get(key) ?? { forward: 0, backward: 0, kept: false };
    if (reversed) group.backward++;
    else group.forward++;
    groups.set(key, group);
    return { key, reversed };
  });
  const keep = candidates.map((_, i) => {
    const group = groups.get(keys[i].key)!;
    // Back-to-back pairs cancel out; of what remains keep the first face of the majority orientation.
    if (group.kept || group.forward === group.backward) return false;
    if (keys[i].reversed !== group.backward > group.forward) return false;
    group.kept = true;
    return true;
  });
  const faces = candidates.filter((_, i) => keep[i]);
  const uvs = mesh.uvs && candidateUvs.filter((_, i) => keep[i]);

  const compacted = dropUnused(uvs ? { positions: mesh.positions, faces, uvs } : { positions: mesh.positions, faces });
  const remap = new Int32Array(vertexCount(mesh));
  for (let v = 0; v < remap.length; v++) remap[v] = compacted.remap[target[v]];
  return { mesh: compacted.mesh, remap };
}
