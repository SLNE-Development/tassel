// How a factory machine turns when it is placed with another facing. The model (and every port) is authored
// facing north; a placed machine is rotated exactly like a blockstate variant rotates the model: about the
// centre of the model's own block, [8, 8, 8] px, first about X, then about Y (Minecraft's order).
import { cuboidFaces } from '../../types';
import type { CuboidFaceName, Vec3 } from '../../types';

export type Facing = CuboidFaceName;
export const facings = cuboidFaces;
export const horizontalFacings: readonly Facing[] = ['north', 'east', 'south', 'west'];

/** Rows of an integer rotation matrix; p' = M p. */
export type Mat3 = readonly [Vec3, Vec3, Vec3];

/** The blockstate rotation (degrees) that turns the north-facing model to face the given way. */
export const facingRotations: Readonly<Record<Facing, { readonly x: 0 | 90 | 180 | 270; readonly y: 0 | 90 | 180 | 270 }>> = {
  north: { x: 0, y: 0 },
  east: { x: 0, y: 90 },
  south: { x: 0, y: 180 },
  west: { x: 0, y: 270 },
  up: { x: 270, y: 0 },
  down: { x: 90, y: 0 },
};

/** Outward unit normal of each block face (+X east, +Y up, +Z south). */
export const faceNormals: Readonly<Record<Facing, Vec3>> = {
  north: [0, 0, -1],
  east: [1, 0, 0],
  south: [0, 0, 1],
  west: [-1, 0, 0],
  up: [0, 1, 0],
  down: [0, -1, 0],
};

/** The pivot every facing rotates about: the centre of the model's own block, in pixels. */
export const ROTATION_PIVOT: Vec3 = [8, 8, 8];

const IDENTITY: Mat3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
/** Y 90: north -> east -> south -> west (clockwise seen from above), as blockstate "y": 90. */
const Y90: Mat3 = [
  [0, 0, -1],
  [0, 1, 0],
  [1, 0, 0],
];
/** X 90: north -> down, up -> north, as blockstate "x": 90. */
const X90: Mat3 = [
  [1, 0, 0],
  [0, 0, 1],
  [0, -1, 0],
];

export function multiply(a: Mat3, b: Mat3): Mat3 {
  const row = (i: number): Vec3 => [0, 1, 2].map((j) => clean(a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j])) as Vec3;
  return [row(0), row(1), row(2)];
}

function power(m: Mat3, degrees: number): Mat3 {
  let result = IDENTITY;
  for (let i = 0; i < degrees / 90; i++) result = multiply(m, result);
  return result;
}

/** -0 written as 0, so the JSON never shows "-0". */
const clean = (n: number): number => (n === 0 ? 0 : n);

/** The matrix that maps north-facing model coordinates (relative to the pivot) to the given facing. */
export function facingMatrix(facing: Facing): Mat3 {
  const { x, y } = facingRotations[facing];
  // X is applied first, then Y.
  return multiply(power(Y90, y), power(X90, x));
}

export function apply(m: Mat3, v: Readonly<Vec3>): Vec3 {
  return [0, 1, 2].map((i) => clean(m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2])) as Vec3;
}

/** A point in model pixels, turned with the machine about the pivot. */
export function rotatePoint(m: Mat3, p: Readonly<Vec3>): Vec3 {
  const r = apply(m, [p[0] - ROTATION_PIVOT[0], p[1] - ROTATION_PIVOT[1], p[2] - ROTATION_PIVOT[2]]);
  return [clean(r[0] + ROTATION_PIVOT[0]), clean(r[1] + ROTATION_PIVOT[1]), clean(r[2] + ROTATION_PIVOT[2])];
}

/** The face a direction vector points to (the axis with the largest component). */
export function faceOf(v: Readonly<Vec3>): Facing {
  const axis = [0, 1, 2].reduce((best, i) => (Math.abs(v[i]) > Math.abs(v[best]) ? i : best), 0);
  if (axis === 0) return v[0] > 0 ? 'east' : 'west';
  if (axis === 1) return v[1] > 0 ? 'up' : 'down';
  return v[2] > 0 ? 'south' : 'north';
}

export function rotateFace(m: Mat3, face: Facing): Facing {
  return faceOf(apply(m, faceNormals[face]));
}

/**
 * The block (cell, relative to the model's own block = [0, 0, 0]) a port belongs to. A port on a block
 * boundary belongs to the block behind its face, i.e. the one it opens out of.
 */
export function portBlock(position: Readonly<Vec3>, face: Facing | null): Vec3 {
  const n = face ? faceNormals[face] : [0, 0, 0];
  return [0, 1, 2].map((i) => clean(Math.floor((position[i] - n[i] * 0.5) / 16))) as Vec3;
}

/** A block cell (relative to the model's own block) turned with the machine. */
export function rotateBlock(m: Mat3, cell: Readonly<Vec3>): Vec3 {
  const centre = rotatePoint(m, [cell[0] * 16 + 8, cell[1] * 16 + 8, cell[2] * 16 + 8]);
  return centre.map((c) => clean(Math.floor(c / 16))) as Vec3;
}

/** The cells a footprint covers, relative to the model's own block: inclusive min and max corners. */
export function footprintCells(footprint: Readonly<Vec3>, anchor: Readonly<Vec3>): { min: Vec3; max: Vec3 } {
  return {
    min: [clean(-anchor[0]), clean(-anchor[1]), clean(-anchor[2])],
    max: [footprint[0] - anchor[0] - 1, footprint[1] - anchor[1] - 1, footprint[2] - anchor[2] - 1],
  };
}

/** Inclusive cell bounds of a footprint after turning it to a facing. */
export function rotatedCells(m: Mat3, cells: { min: Vec3; max: Vec3 }): { min: Vec3; max: Vec3 } {
  const a = rotateBlock(m, cells.min);
  const b = rotateBlock(m, cells.max);
  return {
    min: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])],
    max: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])],
  };
}
