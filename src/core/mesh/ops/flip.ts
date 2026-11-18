import type { PolyMesh } from '../../types';
import type { MeshOpResult } from './types';

/** Reverses the winding (and with it the normal) of the given faces; their UVs follow the corners. Keeps them selected. */
export function flipFaces(mesh: PolyMesh, faces: readonly number[]): MeshOpResult {
  const set = new Set(faces);
  for (const f of set) if (!mesh.faces[f]) throw new Error(`Face ${f} does not exist`);
  // The first vertex stays first.
  const flipped = mesh.faces.map((face, i) => (set.has(i) ? [face[0], ...face.slice(1).reverse()] : face));
  const uvs = mesh.uvs?.map((uv, i) => {
    if (!set.has(i)) return uv;
    const out = [uv[0], uv[1]];
    for (let c = uv.length / 2 - 1; c >= 1; c--) out.push(uv[c * 2], uv[c * 2 + 1]);
    return out;
  });
  return { mesh: uvs ? { positions: mesh.positions, faces: flipped, uvs } : { positions: mesh.positions, faces: flipped }, faces: [...set] };
}
