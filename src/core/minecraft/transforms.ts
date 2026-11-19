// Flipping and quarter-turning cuboid elements: geometry, element rotation, and which face (with which UV
// orientation) ends up where. Works for any axis-aligned orthogonal map (mirrors, 90 degree turns).
import { cuboidFaces } from '../types';
import type { Cuboid, CuboidFace, CuboidFaceName, Vec3 } from '../types';
import { faceUvCorners } from './cuboid';
import { tidy } from './space';

/** 3x3 matrix, row-major. */
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

export function apply(m: Mat3, v: Readonly<Vec3>): Vec3 {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}

export function multiply(a: Mat3, b: Mat3): Mat3 {
  const out: number[] = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out.push(a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]);
  return out as unknown as Mat3;
}

export function transpose(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

/** Rotation matrix of Euler XYZ angles in degrees (Rx * Ry * Rz, as Tessel's transforms and Minecraft). */
export function eulerMatrix(deg: Readonly<Vec3>): Mat3 {
  const [x, y, z] = deg.map((d) => (d * Math.PI) / 180);
  const [a, b, c, d, e, f] = [Math.cos(x), Math.sin(x), Math.cos(y), Math.sin(y), Math.cos(z), Math.sin(z)];
  return [c * e, -c * f, d, a * f + b * e * d, a * e - b * f * d, -b * c, b * f - a * e * d, b * e + a * f * d, a * c];
}

/** Euler XYZ angles in degrees of a rotation matrix (tidied). */
export function matrixEuler(m: Mat3): Vec3 {
  const deg = (r: number) => tidy((r * 180) / Math.PI);
  const y = Math.asin(Math.max(-1, Math.min(1, m[2])));
  if (Math.abs(m[2]) < 0.9999999) return [deg(Math.atan2(-m[5], m[8])), deg(y), deg(Math.atan2(-m[1], m[0]))];
  return [deg(Math.atan2(m[7], m[4])), deg(y), 0];
}

const AXIS: Record<'x' | 'y' | 'z', number> = { x: 0, y: 1, z: 2 };

export function mirrorMatrix(axis: 'x' | 'y' | 'z'): Mat3 {
  const m = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  m[AXIS[axis] * 4] = -1;
  return m as unknown as Mat3;
}

/** A quarter turn about an axis; +1 = counter-clockwise looking down the positive axis. */
export function quarterTurn(axis: 'x' | 'y' | 'z', direction: 1 | -1): Mat3 {
  const s = direction;
  switch (axis) {
    case 'x':
      return [1, 0, 0, 0, 0, -s, 0, s, 0];
    case 'y':
      return [0, 0, s, 0, 1, 0, -s, 0, 0];
    case 'z':
      return [0, -s, 0, s, 0, 0, 0, 0, 1];
  }
}

const NORMALS: Record<CuboidFaceName, Vec3> = {
  north: [0, 0, -1],
  south: [0, 0, 1],
  east: [1, 0, 0],
  west: [-1, 0, 0],
  up: [0, 1, 0],
  down: [0, -1, 0],
};

/** Face corners [TL, TR, BR, BL] on the cube [-1, 1]^3 (see CORNERS in cuboid.ts). */
const UNIT_CORNERS: Record<CuboidFaceName, readonly Vec3[]> = {
  north: [[1, 1, -1], [-1, 1, -1], [-1, -1, -1], [1, -1, -1]],
  south: [[-1, 1, 1], [1, 1, 1], [1, -1, 1], [-1, -1, 1]],
  east: [[1, 1, 1], [1, 1, -1], [1, -1, -1], [1, -1, 1]],
  west: [[-1, 1, -1], [-1, 1, 1], [-1, -1, 1], [-1, -1, -1]],
  up: [[-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]],
  down: [[-1, -1, 1], [1, -1, 1], [1, -1, -1], [-1, -1, -1]],
};

const same = (a: Readonly<Vec3>, b: Readonly<Vec3>) => Math.round(a[0]) === Math.round(b[0]) && Math.round(a[1]) === Math.round(b[1]) && Math.round(a[2]) === Math.round(b[2]);

/** The face whose outward normal is `normal`. */
export function faceOf(normal: Readonly<Vec3>): CuboidFaceName {
  return cuboidFaces.find((f) => same(NORMALS[f], normal))!;
}

export function mapDirection(m: Mat3, dir: CuboidFaceName | null): CuboidFaceName | null {
  return dir === null ? null : faceOf(apply(m, NORMALS[dir]));
}

/**
 * The face (uv rectangle and rotation) that shows the given UV corners on its [TL, TR, BR, BL] corners.
 * Rect + mirroring + rotation can express all eight arrangements, so this always finds one.
 */
export function faceFromCorners(face: CuboidFace, corners: readonly (readonly [number, number])[]): CuboidFace {
  for (const rotation of [0, 90, 180, 270] as const) {
    const shift = rotation / 90;
    // Undo the rotation: unrotated corner j is shown on face corner j + shift.
    const c = [0, 1, 2, 3].map((j) => corners[(j + shift) % 4]);
    if (c[0][1] === c[1][1] && c[1][0] === c[2][0] && c[2][1] === c[3][1] && c[3][0] === c[0][0]) {
      return { ...face, uv: [c[0][0], c[0][1], c[2][0], c[2][1]], rotation };
    }
  }
  return face;
}

/** The cuboid's faces after the orthogonal map `m`: which face goes where and how its texture turns. */
export function mapFaces(cuboid: Cuboid, m: Mat3): Cuboid['faces'] {
  const faces = {} as Record<CuboidFaceName, CuboidFace>;
  for (const name of cuboidFaces) {
    const face = cuboid.faces[name];
    const target = faceOf(apply(m, NORMALS[name]));
    const moved = UNIT_CORNERS[name].map((p) => apply(m, p));
    const uv = faceUvCorners(face);
    // For each corner of the target face, the uv of the old corner that landed on it.
    const corners = UNIT_CORNERS[target].map((p) => uv[moved.findIndex((q) => same(p, q))]);
    faces[target] = { ...faceFromCorners(face, corners), cullface: mapDirection(m, face.cullface) };
  }
  return faces;
}
