import type { PolyMesh } from '../../types';
import type { MeshOpResult } from './types';

/** Reverses the winding (and with it the normal) of the given faces. Keeps them selected. */
export function flipFaces(mesh: PolyMesh, faces: readonly number[]): MeshOpResult {
  const set = new Set(faces);
  for (const f of set) if (!mesh.faces[f]) throw new Error(`Face ${f} does not exist`);
  return {
    mesh: {
      positions: mesh.positions,
      // The first vertex stays first.
      faces: mesh.faces.map((face, i) => (set.has(i) ? [face[0], ...face.slice(1).reverse()] : face)),
    },
    faces: [...set],
  };
}
