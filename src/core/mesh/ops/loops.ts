// STUB — replaced by the real implementation.
import type { Edge, PolyMesh } from '../../types';
import type { MeshOpResult } from './types';

/** The edge loop through `edge`: continues straight across vertices with four edges. Includes `edge`. */
export function edgeLoop(_mesh: PolyMesh, _edge: Edge): Edge[] {
  throw new Error('not implemented');
}

/** The edge ring through `edge`: the opposite edges across consecutive quads. Includes `edge`. */
export function edgeRing(_mesh: PolyMesh, _edge: Edge): Edge[] {
  throw new Error('not implemented');
}

/** Cuts the ring of quads through `edge` with `cuts` evenly spaced new edge loops. Selects the new edges. */
export function loopCut(_mesh: PolyMesh, _edge: Edge, _cuts: number): MeshOpResult {
  throw new Error('not implemented');
}
