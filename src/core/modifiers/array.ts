import type { PolyMesh, Vec3 } from '../types';

/** `count` copies in total, copy i moved by i * offset. Copies are not merged and share the UVs of the original. */
export function array(mesh: PolyMesh, count: number, offset: Vec3): PolyMesh {
  const vertexCount = mesh.positions.length / 3;
  const positions: number[] = [];
  const faces: number[][] = [];
  for (let i = 0; i < count; i++) {
    for (let p = 0; p < mesh.positions.length; p++) positions.push(mesh.positions[p] + i * offset[p % 3]);
    for (const face of mesh.faces) faces.push(face.map((v) => v + i * vertexCount));
  }
  if (!mesh.uvs) return { positions, faces };
  const uvs: (readonly number[])[] = [];
  for (let i = 0; i < count; i++) uvs.push(...mesh.uvs);
  return { positions, faces, uvs };
}
