// Box UV layout of a cube: the six face rectangles derived from a texture offset and the cube size.
import type { CuboidFaceName } from '../types';

export type UvRect = [number, number, number, number];

/** Face UV rectangles (in UV pixels, y down) of a box-UV cube of size [dx, dy, dz] at offset [u, v]. */
export function boxUvFaces(offset: readonly [number, number], size: readonly [number, number, number], mirror: boolean): Record<CuboidFaceName, UvRect> {
  const [u, v] = offset;
  const [dx, dy, dz] = size;
  const east: UvRect = [u, v + dz, u + dz, v + dz + dy];
  const north: UvRect = [u + dz, v + dz, u + dz + dx, v + dz + dy];
  const west: UvRect = [u + dz + dx, v + dz, u + 2 * dz + dx, v + dz + dy];
  const south: UvRect = [u + 2 * dz + dx, v + dz, u + 2 * dz + 2 * dx, v + dz + dy];
  const up: UvRect = [u + dz, v, u + dz + dx, v + dz];
  const down: UvRect = [u + dz + dx, v + dz, u + dz + 2 * dx, v];
  const faces: Record<CuboidFaceName, UvRect> = mirror ? { east: west, west: east, north, south, up, down } : { east, west, north, south, up, down };
  if (mirror) for (const name of Object.keys(faces) as CuboidFaceName[]) faces[name] = [faces[name][2], faces[name][1], faces[name][0], faces[name][3]];
  return faces;
}
