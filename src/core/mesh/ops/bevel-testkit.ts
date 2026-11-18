// Shared checks for the bevel and loop tests (test-only helper).
import { expect } from 'vitest';
import type { PolyMesh, Vec3 } from '../../types';
import { edges, polyMeshSchema } from '../polymesh';

export const vertexCount = (mesh: PolyMesh) => mesh.positions.length / 3;
export const position = (mesh: PolyMesh, i: number): Vec3 => [mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]];
export const eulerCharacteristic = (mesh: PolyMesh) => vertexCount(mesh) - edges(mesh).length + mesh.faces.length;

/** Area-weighted (unnormalized) face normal via Newell's method; its length is twice the area. */
export function areaNormal(mesh: PolyMesh, face: readonly number[]): Vec3 {
  const n: Vec3 = [0, 0, 0];
  face.forEach((v, i) => {
    const a = position(mesh, v);
    const b = position(mesh, face[(i + 1) % face.length]);
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  });
  return n;
}

/** Signed volume of the fan-triangulated mesh (positive for outward winding). */
export function signedVolume(mesh: PolyMesh): number {
  let six = 0;
  for (const face of mesh.faces) {
    const a = position(mesh, face[0]);
    for (let i = 1; i < face.length - 1; i++) {
      const b = position(mesh, face[i]);
      const c = position(mesh, face[i + 1]);
      six += a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
    }
  }
  return six / 6;
}

/**
 * Null if the mesh is a closed, consistently oriented manifold (every undirected edge used by exactly
 * two faces, in opposite directions) with valid indices, without degenerate or duplicate faces, unused
 * or coincident vertices, and with the given Euler characteristic. Otherwise the first problem found.
 */
export function solidProblem(mesh: PolyMesh, euler: number): string | null {
  if (!polyMeshSchema.safeParse(mesh).success) return 'schema';
  const count = vertexCount(mesh);
  const faceKeys = new Set<string>();
  const directed = new Map<string, number>();
  for (const face of mesh.faces) {
    if (face.length < 3) return `face ${face} has fewer than 3 vertices`;
    if (new Set(face).size !== face.length) return `face ${face} repeats a vertex`;
    if (face.some((v) => !Number.isInteger(v) || v < 0 || v >= count)) return `face ${face} has an invalid index`;
    if (!(Math.hypot(...areaNormal(mesh, face)) > 1e-9)) return `face ${face} has no area`;
    faceKeys.add([...face].sort((a, b) => a - b).join(','));
    face.forEach((a, i) => {
      const key = `${a}>${face[(i + 1) % face.length]}`;
      directed.set(key, (directed.get(key) ?? 0) + 1);
    });
  }
  if (faceKeys.size !== mesh.faces.length) return 'duplicate faces';
  for (const [key, uses] of directed) {
    const [a, b] = key.split('>');
    if (uses !== 1) return `directed edge ${key} is used ${uses} times`;
    if (directed.get(`${b}>${a}`) !== 1) return `edge ${key} has no opposite`;
  }
  if (new Set(mesh.faces.flat()).size !== count) return 'unused vertices';
  const places = new Set<string>();
  for (let i = 0; i < count; i++) places.add(position(mesh, i).map((c) => Math.round(c * 1e7)).join(','));
  if (places.size !== count) return 'coincident vertices';
  if (eulerCharacteristic(mesh) !== euler) return `Euler characteristic ${eulerCharacteristic(mesh)}`;
  return null;
}

/** For convex shapes around the origin: null if every face normal (except `skip`) points away from the origin. */
export function outwardProblem(mesh: PolyMesh, skip?: (face: readonly number[]) => boolean): string | null {
  for (const face of mesh.faces) {
    if (skip?.(face)) continue;
    const n = areaNormal(mesh, face);
    const c: Vec3 = [0, 0, 0];
    for (const v of face) position(mesh, v).forEach((x, a) => (c[a] += x / face.length));
    if (!(n[0] * c[0] + n[1] * c[1] + n[2] * c[2] > 0)) return `face ${face} points inward`;
  }
  return null;
}

export const expectSolid = (mesh: PolyMesh, euler: number) => expect(solidProblem(mesh, euler)).toBeNull();
export const expectOutward = (mesh: PolyMesh, skip?: (face: readonly number[]) => boolean) => expect(outwardProblem(mesh, skip)).toBeNull();
