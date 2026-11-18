import type { Edge, PolyMesh } from '../../types';

/**
 * Result of a mesh operation: the new mesh plus the elements that should be selected afterwards,
 * given in whichever element kind is natural for the operation (indices refer to the new mesh).
 */
export interface MeshOpResult {
  mesh: PolyMesh;
  vertices?: number[];
  edges?: Edge[];
  faces?: number[];
}
