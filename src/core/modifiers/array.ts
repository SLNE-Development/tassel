import type { PolyMesh, Vec3 } from '../types';

/** `count` copies in total, copy i moved by i * offset. Copies are not merged. */
export function array(mesh: PolyMesh, count: number, offset: Vec3): PolyMesh {
  const vertexCount = mesh.positions.length / 3;
  const positions: number[] = [];
  const faces: number[][] = [];
  for (let i = 0; i < count; i++) {
    for (let p = 0; p < mesh.positions.length; p++) positions.push(mesh.positions[p] + i * offset[p % 3]);
    for (const face of mesh.faces) faces.push(face.map((v) => v + i * vertexCount));
  }
  return { positions, faces };
}
