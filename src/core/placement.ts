// Placing a set of objects as one unit: the unit's own origin is moved, rotated and scaled, and every
// object's transform is composed with that exactly. Plain maths, no three.js (core is DOM-free).
// Rotating / scaling single transforms about a pivot is in transformMath.ts; this composes whole matrices,
// which is exact also where the result is no longer a position / rotation / scale (then it is baked).
import { transformMatrix, type Mat } from './modifiers/boolean';
import { determinant, matrixEuler } from './transformMath';
import type { PolyMesh, Transform, Vec3 } from './types';

export type { Mat };

export const IDENTITY_TRANSFORM: Transform = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };

export interface Placement {
  /** Where the unit's own origin goes (world space, meters). */
  position?: Vec3;
  /** Euler XYZ in degrees, about the unit's origin. */
  rotation?: Vec3;
  /** Uniform factor or one per axis of the unit, about the unit's origin. */
  scale?: number | Vec3;
}

/** The matrix T * R * S of a placement, or null if it changes nothing. */
export function placementMatrix(placement: Placement): Mat | null {
  const position = placement.position ?? [0, 0, 0];
  const rotation = placement.rotation ?? [0, 0, 0];
  const scale: Vec3 = typeof placement.scale === 'number' ? [placement.scale, placement.scale, placement.scale] : (placement.scale ?? [1, 1, 1]);
  if (position.every((v) => v === 0) && rotation.every((v) => v === 0) && scale.every((v) => v === 1)) return null;
  return transformMatrix({ position, rotation, scale });
}

/** a * b for affine 3x4 matrices (apply b first). */
export function multiply(a: Mat, b: Mat): Mat {
  const out: number[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      out.push(a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + (c === 3 ? a[r * 4 + 3] : 0));
    }
  }
  return out;
}

// `|| 0` turns -0 into 0.
const round = (x: number, digits: number) => Number(x.toFixed(digits)) || 0;

/**
 * The matrix as position / rotation / scale, or null if it has no such form with a positive scale
 * (shear from a non-uniform scale applied to a rotated object, mirroring, zero scale).
 */
export function decompose(m: Mat): Transform | null {
  if (!m.every(Number.isFinite) || !(determinant(m) > 0)) return null;
  const sx = Math.hypot(m[0], m[4], m[8]);
  const sy = Math.hypot(m[1], m[5], m[9]);
  const sz = Math.hypot(m[2], m[6], m[10]);
  // The rotation, if the columns are orthogonal (checked below by composing the matrix again).
  const transform: Transform = {
    position: [round(m[3], 9), round(m[7], 9), round(m[11], 9)],
    rotation: matrixEuler([m[0] / sx, m[1] / sy, m[2] / sz, m[4] / sx, m[5] / sy, m[6] / sz, m[8] / sx, m[9] / sy, m[10] / sz]),
    scale: [round(sx, 9), round(sy, 9), round(sz, 9)],
  };
  const back = transformMatrix(transform);
  // Column by column, relative to that axis' own length, so that a small axis cannot hide a shear.
  const lengths = [sx, sy, sz];
  for (const i of [0, 1, 2, 4, 5, 6, 8, 9, 10]) if (Math.abs(back[i] - m[i]) > 1e-6 * lengths[i % 4]) return null;
  return transform;
}

/**
 * The mesh with the matrix applied to its vertices. A mirroring matrix turns faces inside out, so their
 * winding is reversed (first corner kept) to keep them facing outwards.
 */
export function bakeMatrix(mesh: PolyMesh, m: Mat): PolyMesh {
  const p = mesh.positions;
  const positions = new Array<number>(p.length);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i];
    const y = p[i + 1];
    const z = p[i + 2];
    positions[i] = round(m[0] * x + m[1] * y + m[2] * z + m[3], 9);
    positions[i + 1] = round(m[4] * x + m[5] * y + m[6] * z + m[7], 9);
    positions[i + 2] = round(m[8] * x + m[9] * y + m[10] * z + m[11], 9);
  }
  if (determinant(m) >= 0) return mesh.uvs ? { positions, faces: mesh.faces, uvs: mesh.uvs } : { positions, faces: mesh.faces };
  const faces = mesh.faces.map((face) => [face[0], ...face.slice(1).reverse()]);
  const uvs = mesh.uvs?.map((uv) => {
    const out = [uv[0], uv[1]];
    for (let c = uv.length / 2 - 1; c >= 1; c--) out.push(uv[c * 2], uv[c * 2 + 1]);
    return out;
  });
  return uvs ? { positions, faces, uvs } : { positions, faces };
}

/**
 * An object after its world matrix was multiplied from the left by `placement`: the new transform where
 * the result still is position / rotation / scale (always for a placement with a uniform positive scale),
 * otherwise the whole matrix is baked into the vertices and the transform becomes the identity.
 */
export function placeObject(transform: Transform, mesh: PolyMesh, placement: Mat): { transform: Transform; mesh: PolyMesh; baked: boolean } {
  const world = multiply(placement, transformMatrix(transform));
  const placed = decompose(world);
  if (placed) return { transform: placed, mesh, baked: false };
  return { transform: IDENTITY_TRANSFORM, mesh: bakeMatrix(mesh, world), baked: true };
}
