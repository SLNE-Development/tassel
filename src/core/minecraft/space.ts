// Minecraft model space <-> Tessel world space.
//
// Minecraft models are measured in pixels: one block is 16 px and spans 0..16 on every axis. Tessel works in
// meters with Y up, so 1 px = 1/16 m and one block is 1 m. The block sits on the ground grid, centred on the
// world origin in X and Z: model point (8, 0, 8) is world (0, 0, 0). Axes are the same (Minecraft: +X east,
// +Y up, +Z south; Euler XYZ rotations in degrees, the same convention as Tessel's transforms).
import type { Vec3 } from '../types';

/** Pixels per meter. */
export const PX = 16;

/** The model-space point (in px) that lies at the world origin. */
export const MODEL_ORIGIN_PX: Vec3 = [8, 0, 8];

/** Model-space px -> world meters. */
export function modelToWorld(p: Readonly<Vec3>): Vec3 {
  return [(p[0] - MODEL_ORIGIN_PX[0]) / PX, (p[1] - MODEL_ORIGIN_PX[1]) / PX, (p[2] - MODEL_ORIGIN_PX[2]) / PX];
}

/** World meters -> model-space px, rounded to 1/1000 px against float noise. */
export function worldToModel(w: Readonly<Vec3>): Vec3 {
  return [tidy(w[0] * PX + MODEL_ORIGIN_PX[0]), tidy(w[1] * PX + MODEL_ORIGIN_PX[1]), tidy(w[2] * PX + MODEL_ORIGIN_PX[2])];
}

/** Rounds to 1/10000 so that values like 7.999999999 read as 8 in files and panels. */
export function tidy(n: number): number {
  const r = Math.round(n * 10000) / 10000;
  return Object.is(r, -0) ? 0 : r;
}

export const addVec = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const subVec = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
