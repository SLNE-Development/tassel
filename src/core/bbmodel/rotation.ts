// Small 3x3 rotation helpers for the .bbmodel importer. Matrices are row-major arrays of 9 numbers.
import type { Vec3 } from '../types';

export type Mat3 = readonly number[];

const rad = (deg: number) => (deg * Math.PI) / 180;

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function rotX(deg: number): Mat3 {
  const c = Math.cos(rad(deg));
  const s = Math.sin(rad(deg));
  return [1, 0, 0, 0, c, -s, 0, s, c];
}

export function rotY(deg: number): Mat3 {
  const c = Math.cos(rad(deg));
  const s = Math.sin(rad(deg));
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}

export function rotZ(deg: number): Mat3 {
  const c = Math.cos(rad(deg));
  const s = Math.sin(rad(deg));
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

export function mul(a: Mat3, b: Mat3): Mat3 {
  const out: number[] = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out.push(a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]);
  return out;
}

export function apply(m: Mat3, p: Readonly<Vec3>): Vec3 {
  return [m[0] * p[0] + m[1] * p[1] + m[2] * p[2], m[3] * p[0] + m[4] * p[1] + m[5] * p[2], m[6] * p[0] + m[7] * p[1] + m[8] * p[2]];
}

/** Blockbench's rotation order: matrix = Rz * Ry * Rx. */
export function matrixFromBlockbench(rot: Readonly<Vec3>): Mat3 {
  return mul(rotZ(rot[2]), mul(rotY(rot[1]), rotX(rot[0])));
}

/** Tessel's Euler XYZ in degrees (matrix = Rx * Ry * Rz) of a rotation matrix. */
export function eulerXyz(m: Mat3): Vec3 {
  const y = Math.asin(Math.max(-1, Math.min(1, m[2])));
  let x: number;
  let z: number;
  if (Math.abs(m[2]) < 0.9999999) {
    x = Math.atan2(-m[5], m[8]);
    z = Math.atan2(-m[1], m[0]);
  } else {
    x = Math.atan2(m[7], m[4]);
    z = 0;
  }
  return [round((x * 180) / Math.PI), round((y * 180) / Math.PI), round((z * 180) / Math.PI)];
}

/** Rounds to 1/10000 and avoids -0. */
export function round(n: number, digits = 4): number {
  const k = 10 ** digits;
  const r = Math.round(n * k) / k;
  return Object.is(r, -0) ? 0 : r;
}

/** Blockbench Euler (ZYX order) -> Tessel Euler XYZ with the same orientation. */
export function blockbenchToTesselEuler(rot: Readonly<Vec3>): Vec3 {
  return eulerXyz(matrixFromBlockbench(rot));
}
