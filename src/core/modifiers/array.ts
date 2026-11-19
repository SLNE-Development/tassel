import type { PolyMesh, Transform, Vec3 } from '../types';
import { transformMatrix } from './boolean';

export interface ArrayOptions {
  /** Euler XYZ in degrees by which each copy is turned further than the one before it. Default: none. */
  rotation?: Vec3;
  /** Local point the rotation turns about. Default: the object's origin. */
  pivot?: Vec3;
  /** 'world': `offset` is in world meters along the world axes, which needs `transform`. Default: 'local'. */
  offsetSpace?: 'local' | 'world';
  /** The object's transform (only its rotation and scale matter). */
  transform?: Transform;
}

/** `offset` given along the world axes, expressed in the local space of an object with that transform. */
function worldToLocalOffset(offset: Vec3, transform: Transform): Vec3 {
  // World = R * S * local for directions, so local = S^-1 * R^T * world.
  const m = transformMatrix({ ...transform, scale: [1, 1, 1] });
  if (transform.scale.some((s) => Math.abs(s) < 1e-12)) throw new Error('The object has a scale of zero');
  return [0, 1, 2].map((c) => (m[c] * offset[0] + m[4 + c] * offset[1] + m[8 + c] * offset[2]) / transform.scale[c]) as Vec3;
}

/**
 * `count` copies in total. Copy i is the mesh transformed i times by the per-copy step "turn by
 * `rotation` about `pivot`, then move by `offset`" (so copy 0 is the mesh itself, and without a
 * rotation copy i is simply moved by i * offset). Copies are not merged and share the UVs of the original.
 */
export function array(mesh: PolyMesh, count: number, offset: Vec3, options: ArrayOptions = {}): PolyMesh {
  const { rotation = [0, 0, 0], pivot = [0, 0, 0], offsetSpace = 'local', transform } = options;
  let step = offset;
  if (offsetSpace === 'world') {
    if (!transform) throw new Error('A world-space offset needs the transform of the object');
    step = worldToLocalOffset(offset, transform);
  }
  const vertexCount = mesh.positions.length / 3;
  const positions: number[] = [];
  const faces: number[][] = [];
  const rotates = rotation.some((r) => r !== 0);
  // Row-major 3x4 matrix of copy i; starts as the identity and is multiplied by the step for each further copy.
  const r = transformMatrix({ position: [0, 0, 0], rotation, scale: [1, 1, 1] });
  const stepMatrix = [0, 1, 2].flatMap((row) => [
    r[row * 4],
    r[row * 4 + 1],
    r[row * 4 + 2],
    // p -> R * (p - pivot) + pivot + step
    pivot[row] + step[row] - (r[row * 4] * pivot[0] + r[row * 4 + 1] * pivot[1] + r[row * 4 + 2] * pivot[2]),
  ]);
  let m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
  for (let i = 0; i < count; i++) {
    if (!rotates) {
      for (let p = 0; p < mesh.positions.length; p++) positions.push(mesh.positions[p] + i * step[p % 3]);
    } else {
      for (let p = 0; p < mesh.positions.length; p += 3) {
        const [x, y, z] = [mesh.positions[p], mesh.positions[p + 1], mesh.positions[p + 2]];
        for (let row = 0; row < 3; row++) positions.push(m[row * 4] * x + m[row * 4 + 1] * y + m[row * 4 + 2] * z + m[row * 4 + 3] + 0);
      }
      // next = step * m
      const next: number[] = [];
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 4; col++) {
          next.push(
            stepMatrix[row * 4] * m[col] + stepMatrix[row * 4 + 1] * m[4 + col] + stepMatrix[row * 4 + 2] * m[8 + col] + (col === 3 ? stepMatrix[row * 4 + 3] : 0),
          );
        }
      }
      m = next;
    }
    for (const face of mesh.faces) faces.push(face.map((v) => v + i * vertexCount));
  }
  if (!mesh.uvs) return { positions, faces };
  const uvs: (readonly number[])[] = [];
  for (let i = 0; i < count; i++) uvs.push(...mesh.uvs);
  return { positions, faces, uvs };
}
