import { compact } from '../mesh/topology';
import type { PolyMesh } from '../types';

/**
 * Mirrors across the plane `axis = 0` (0 = x, 1 = y, 2 = z). Vertices within `mergeDistance` of the
 * plane are snapped onto it and shared with the mirrored half; faces lying in the plane are dropped,
 * so an open half becomes a closed mesh. The mirrored half uses the same UVs as the original.
 */
function mirrorAxis(mesh: PolyMesh, axis: number, mergeDistance: number): PolyMesh {
  const positions = [...mesh.positions];
  const count = positions.length / 3;
  const mirrored = new Int32Array(count);
  for (let v = 0; v < count; v++) {
    if (Math.abs(positions[v * 3 + axis]) <= mergeDistance) {
      positions[v * 3 + axis] = 0;
      mirrored[v] = v;
    } else {
      mirrored[v] = positions.length / 3;
      const p = [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]];
      p[axis] = -p[axis];
      positions.push(p[0], p[1], p[2]);
    }
  }
  const keep = mesh.faces.map((face) => face.some((v) => mirrored[v] !== v));
  const kept = mesh.faces.filter((_, f) => keep[f]);
  const faces = [...kept, ...kept.map((face) => face.map((v) => mirrored[v]).reverse())];
  let result: PolyMesh = { positions, faces };
  if (mesh.uvs) {
    const uvs = mesh.uvs.filter((_, f) => keep[f]);
    // The mirrored faces run backwards, so their corner UVs do too.
    const reversed = uvs.map((uv) => {
      const out: number[] = [];
      for (let c = uv.length / 2 - 1; c >= 0; c--) out.push(uv[c * 2], uv[c * 2 + 1]);
      return out;
    });
    result = { positions, faces, uvs: [...uvs, ...reversed] };
  }
  return kept.length === mesh.faces.length ? result : compact(result).mesh;
}

export function mirror(
  mesh: PolyMesh,
  axes: { readonly x: boolean; readonly y: boolean; readonly z: boolean },
  mergeDistance: number,
): PolyMesh {
  let out = mesh;
  if (axes.x) out = mirrorAxis(out, 0, mergeDistance);
  if (axes.y) out = mirrorAxis(out, 1, mergeDistance);
  if (axes.z) out = mirrorAxis(out, 2, mergeDistance);
  return out;
}
