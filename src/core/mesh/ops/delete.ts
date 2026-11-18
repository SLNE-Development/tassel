import type { Edge, PolyMesh } from '../../types';
import { edgeKey } from '../topology';
import type { MeshOpResult } from './types';
import { dropUnused } from './util';

/**
 * Deletes elements: faces are removed as given; deleting vertices or edges removes every face that
 * uses one of them. Vertices that no face uses afterwards are dropped. Nothing is selected afterwards.
 */
export function deleteElements(
  mesh: PolyMesh,
  elements: { vertices: readonly number[] } | { edges: readonly Edge[] } | { faces: readonly number[] },
): MeshOpResult {
  let doomed: (face: readonly number[], index: number) => boolean;
  if ('faces' in elements) {
    const set = new Set(elements.faces);
    doomed = (_, index) => set.has(index);
  } else if ('vertices' in elements) {
    const set = new Set(elements.vertices);
    doomed = (face) => face.some((v) => set.has(v));
  } else {
    const set = new Set(elements.edges.map(([a, b]) => edgeKey(a, b)));
    doomed = (face) => face.some((a, i) => set.has(edgeKey(a, face[(i + 1) % face.length])));
  }
  const faces = mesh.faces.filter((face, index) => !doomed(face, index));
  return { mesh: dropUnused({ positions: mesh.positions, faces }).mesh, vertices: [], edges: [], faces: [] };
}
