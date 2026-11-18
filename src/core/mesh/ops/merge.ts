import type { PolyMesh, Vec3 } from '../../types';
import type { MeshOpResult } from './types';
import { add, position, scale, vertexCount, weld } from './util';

/**
 * Merges the given vertices into one. `at`: 'center' = the average of their positions, 'first' /
 * 'last' = the position of the first / last vertex of the list. Faces that collapse are removed.
 * Selects the merged vertex.
 */
export function mergeVertices(mesh: PolyMesh, vertices: readonly number[], at: 'center' | 'first' | 'last'): MeshOpResult {
  const list = [...new Set(vertices)];
  if (list.length < 2) throw new Error('Select at least two vertices to merge');
  const count = vertexCount(mesh);
  for (const v of list) if (v >= count) throw new Error(`Vertex ${v} does not exist`);

  let where: Vec3;
  if (at === 'first') where = position(mesh, list[0]);
  else if (at === 'last') where = position(mesh, list[list.length - 1]);
  else where = scale(list.map((v) => position(mesh, v)).reduce(add), 1 / list.length);

  const keep = list[0];
  const positions = [...mesh.positions];
  positions.splice(keep * 3, 3, ...where);
  const target = Int32Array.from({ length: count }, (_, i) => i);
  for (const v of list) target[v] = keep;
  const result = weld({ positions, faces: mesh.faces }, target);
  return { mesh: result.mesh, vertices: result.remap[keep] === -1 ? [] : [result.remap[keep]] };
}

/**
 * Welds vertices that are closer than `distance` to each other (chains of close vertices end up in
 * one vertex) at the position of the lowest-index vertex of each cluster. `vertices` limits the
 * operation to these vertices; null = the whole mesh. Collapsed and duplicate faces are removed.
 * Selects the given vertices that are left.
 */
export function mergeByDistance(mesh: PolyMesh, vertices: readonly number[] | null, distance: number): MeshOpResult {
  const count = vertexCount(mesh);
  const candidates = vertices ? [...new Set(vertices)].sort((a, b) => a - b) : Array.from({ length: count }, (_, i) => i);
  for (const v of candidates) if (v >= count) throw new Error(`Vertex ${v} does not exist`);

  const target = Int32Array.from({ length: count }, (_, i) => i);
  const find = (v: number): number => {
    while (target[v] !== v) {
      target[v] = target[target[v]];
      v = target[v];
    }
    return v;
  };

  // Spatial hash with cells of the merge distance: partners are in the same or a neighbouring cell.
  const p = mesh.positions;
  const cell = Math.max(distance, 1e-12);
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const grid = new Map<string, number[]>();
  for (const v of candidates) {
    const cx = Math.floor(p[v * 3] / cell);
    const cy = Math.floor(p[v * 3 + 1] / cell);
    const cz = Math.floor(p[v * 3 + 2] / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (const other of grid.get(key(cx + dx, cy + dy, cz + dz)) ?? []) {
            const d = Math.hypot(p[v * 3] - p[other * 3], p[v * 3 + 1] - p[other * 3 + 1], p[v * 3 + 2] - p[other * 3 + 2]);
            if (d <= distance) {
              // Union with the lower index as root, so every cluster keeps its lowest vertex.
              const a = find(v);
              const b = find(other);
              if (a !== b) target[Math.max(a, b)] = Math.min(a, b);
            }
          }
        }
      }
    }
    const own = key(cx, cy, cz);
    const bucket = grid.get(own);
    if (bucket) bucket.push(v);
    else grid.set(own, [v]);
  }
  for (let v = 0; v < count; v++) target[v] = find(v);

  const result = weld(mesh, target);
  const left = vertices ? [...new Set(candidates.map((v) => result.remap[v]).filter((v) => v !== -1))] : [];
  return { mesh: result.mesh, vertices: left };
}
