import type { Edge, PolyMesh } from '../types';

export function makeEdge(a: number, b: number): Edge {
  return a < b ? [a, b] : [b, a];
}

/** Map key for an undirected edge. */
export function edgeKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/** For every undirected edge (by `edgeKey`): the indices of the faces that use it. */
export function edgeFaces(mesh: PolyMesh): Map<string, number[]> {
  const map = new Map<string, number[]>();
  mesh.faces.forEach((face, fi) => {
    for (let i = 0; i < face.length; i++) {
      const key = edgeKey(face[i], face[(i + 1) % face.length]);
      const list = map.get(key);
      if (list) list.push(fi);
      else map.set(key, [fi]);
    }
  });
  return map;
}

/** Drops vertices no face uses. `remap[old]` is the new index, or -1 for removed vertices. */
export function compact(mesh: PolyMesh): { mesh: PolyMesh; remap: Int32Array } {
  const count = mesh.positions.length / 3;
  const remap = new Int32Array(count).fill(-1);
  const positions: number[] = [];
  for (const face of mesh.faces) {
    for (const v of face) {
      if (remap[v] === -1) {
        remap[v] = positions.length / 3;
        positions.push(mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]);
      }
    }
  }
  return { mesh: { positions, faces: mesh.faces.map((f) => f.map((v) => remap[v])) }, remap };
}
