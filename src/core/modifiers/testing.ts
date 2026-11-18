// Mesh checks shared by the modifier tests.
import { createPrimitive } from '../mesh/primitives';
import type { PolyMesh } from '../types';

/** Every edge is used by exactly two faces, in opposite directions. */
export function isClosedManifold(mesh: PolyMesh): boolean {
  const directed = new Map<string, number>();
  for (const face of mesh.faces) {
    for (let i = 0; i < face.length; i++) {
      const key = `${face[i]}:${face[(i + 1) % face.length]}`;
      directed.set(key, (directed.get(key) ?? 0) + 1);
    }
  }
  if (directed.size === 0) return false;
  for (const [key, count] of directed) {
    const [a, b] = key.split(':');
    if (count !== 1 || directed.get(`${b}:${a}`) !== 1) return false;
  }
  return true;
}

/** Signed volume from the fan triangles of every face (positive for outward-facing closed meshes). */
export function volume(mesh: PolyMesh): number {
  const p = mesh.positions;
  let sum = 0;
  for (const face of mesh.faces) {
    for (let i = 1; i < face.length - 1; i++) {
      const [a, b, c] = [face[0] * 3, face[i] * 3, face[i + 1] * 3];
      sum +=
        p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
        p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
        p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
    }
  }
  return sum / 6;
}

/**
 * A size-2 cube cut down to its positive side along the given axes (0 = x, 1 = y, 2 = z) and left
 * open in the cut planes: the input a mirror modifier turns back into the cube.
 */
export function cutCube(axes: number[]): PolyMesh {
  const cube = createPrimitive('cube');
  const positions = [...cube.positions];
  for (let i = 0; i < positions.length; i++) if (axes.includes(i % 3) && positions[i] < 0) positions[i] = 0;
  const faces = cube.faces.filter((face) => !axes.some((axis) => face.every((v) => positions[v * 3 + axis] === 0)));
  return { positions, faces };
}
