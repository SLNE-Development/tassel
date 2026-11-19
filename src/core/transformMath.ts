// Pure transform maths shared by the commands and the viewport: Euler XYZ rotations (degrees, R = Rx * Ry * Rz,
// the three.js 'XYZ' order), and rotating / scaling an object's transform about a pivot in world space.
import { transformMatrix, type Mat } from './modifiers/boolean';
import type { Transform, Vec3 } from './types';

/** A 3x3 matrix, row-major. */
export type Mat3 = readonly number[];

// `+ 0` turns -0 into 0.
const round = (n: number) => Math.round(n * 1e6) / 1e6 + 0;
export const roundVec3 = (v: readonly number[]): Vec3 => [round(v[0]), round(v[1]), round(v[2])];

/** Rotation matrix of Euler XYZ angles in degrees. */
export function eulerMatrix(rotation: Vec3): Mat3 {
  const m = transformMatrix({ position: [0, 0, 0], rotation, scale: [1, 1, 1] });
  return [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
}

/** Rotation matrix of a unit quaternion. */
export function quaternionMatrix(x: number, y: number, z: number, w: number): Mat3 {
  // prettier-ignore
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w),     2 * (x * z + y * w),
    2 * (x * y + z * w),     1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w),     2 * (y * z + x * w),     1 - 2 * (x * x + y * y),
  ];
}

export function multiply3(a: Mat3, b: Mat3): number[] {
  const out: number[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) out.push(a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]);
  }
  return out;
}

export function apply3(m: Mat3, v: readonly number[]): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** Euler XYZ angles in degrees of a rotation matrix, rounded to 1e-6. */
export function matrixEuler(m: Mat3): Vec3 {
  const deg = 180 / Math.PI;
  const m13 = Math.max(-1, Math.min(1, m[2]));
  const y = Math.asin(m13);
  let x: number;
  let z: number;
  if (Math.abs(m13) < 0.9999999) {
    x = Math.atan2(-m[5], m[8]);
    z = Math.atan2(-m[1], m[0]);
  } else {
    x = Math.atan2(m[7], m[4]);
    z = 0;
  }
  // Whole degrees must not come out as 89.999999 (asin is ill-conditioned near ±90°).
  return roundVec3([x * deg, y * deg, z * deg]).map((a) => (Math.abs(a - Math.round(a)) < 2e-6 ? Math.round(a) + 0 : a)) as Vec3;
}

/** The transform after rotating the object by `rotation` (world space) about `pivot`. */
export function rotateAbout(t: Transform, pivot: Vec3, rotation: Mat3): Transform {
  const p = apply3(rotation, [t.position[0] - pivot[0], t.position[1] - pivot[1], t.position[2] - pivot[2]]);
  return {
    position: roundVec3([p[0] + pivot[0], p[1] + pivot[1], p[2] + pivot[2]]),
    rotation: matrixEuler(multiply3(rotation, eulerMatrix(t.rotation))),
    scale: t.scale,
  };
}

/**
 * The transform after scaling the object by `scale` along the world axes about `pivot`.
 *
 * The position is exact. The object's own scale is exact for a uniform `scale` and for objects whose
 * axes line up with the world axes; otherwise the true result would be sheared, which position /
 * rotation / scale cannot express, so each local axis is scaled by how much `scale` stretches a
 * unit vector along it (the closest per-axis scale) and the rotation stays as it is.
 */
export function scaleAbout(t: Transform, pivot: Vec3, scale: Vec3): Transform {
  const position = t.position.map((v, i) => (v - pivot[i]) * scale[i] + pivot[i]);
  const basis = eulerMatrix(t.rotation);
  const own = t.scale.map((s, i) => {
    // Column i of the rotation: where the local axis points in the world.
    const axis = [basis[i], basis[3 + i], basis[6 + i]];
    const stretched = [axis[0] * scale[0], axis[1] * scale[1], axis[2] * scale[2]];
    const dot = stretched[0] * axis[0] + stretched[1] * axis[1] + stretched[2] * axis[2];
    // Mirrored if the stretched axis points away from where it pointed.
    return s * Math.hypot(stretched[0], stretched[1], stretched[2]) * (dot < 0 ? -1 : 1);
  });
  return { position: roundVec3(position), rotation: t.rotation, scale: roundVec3(own) };
}

/** Determinant of the linear part of an affine matrix: negative if it mirrors. */
export function determinant(m: Mat): number {
  return m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);
}

/** The point (x, y, z) transformed by an affine matrix. */
export function applyMat(m: Mat, x: number, y: number, z: number): Vec3 {
  return [m[0] * x + m[1] * y + m[2] * z + m[3], m[4] * x + m[5] * y + m[6] * z + m[7], m[8] * x + m[9] * y + m[10] * z + m[11]];
}
