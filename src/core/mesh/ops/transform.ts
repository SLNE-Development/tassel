import type { PolyMesh, Vec3 } from '../../types';
import type { MeshOpResult } from './types';
import { boundsCentre, vertexCount } from './util';

export interface VertexTransform {
  translate?: Vec3;
  /** Euler XYZ in degrees (same convention as object rotations). */
  rotate?: Vec3;
  scale?: Vec3;
  /** Centre of rotation and scaling. Defaults to the bounding-box centre of the vertices. */
  pivot?: Vec3;
}

/** Row-major 3x3 rotation matrix Rx * Ry * Rz (three.js Euler order 'XYZ'). */
function rotationMatrix([rx, ry, rz]: Vec3): number[] {
  const rad = Math.PI / 180;
  const a = Math.cos(rx * rad);
  const b = Math.sin(rx * rad);
  const c = Math.cos(ry * rad);
  const d = Math.sin(ry * rad);
  const e = Math.cos(rz * rad);
  const f = Math.sin(rz * rad);
  // prettier-ignore
  return [
    c * e,              -c * f,             d,
    a * f + b * e * d,  a * e - b * f * d,  -b * c,
    b * f - a * e * d,  b * e + a * f * d,  a * c,
  ];
}

/** Moves the given vertices: scaled, then rotated (both about the pivot), then translated. Keeps the selection and the UVs. */
export function transformVertices(mesh: PolyMesh, vertices: readonly number[], t: VertexTransform): MeshOpResult {
  const list = [...new Set(vertices)];
  if (list.length === 0) throw new Error('Select at least one vertex to transform');
  const count = vertexCount(mesh);
  for (const v of list) if (v >= count) throw new Error(`Vertex ${v} does not exist`);

  const pivot = t.pivot ?? boundsCentre(mesh, list);
  const s = t.scale ?? [1, 1, 1];
  const m = rotationMatrix(t.rotate ?? [0, 0, 0]);
  const move = t.translate ?? [0, 0, 0];
  const positions = [...mesh.positions];
  for (const v of list) {
    const x = (positions[v * 3] - pivot[0]) * s[0];
    const y = (positions[v * 3 + 1] - pivot[1]) * s[1];
    const z = (positions[v * 3 + 2] - pivot[2]) * s[2];
    // `+ 0` turns -0 into 0.
    positions[v * 3] = m[0] * x + m[1] * y + m[2] * z + pivot[0] + move[0] + 0;
    positions[v * 3 + 1] = m[3] * x + m[4] * y + m[5] * z + pivot[1] + move[1] + 0;
    positions[v * 3 + 2] = m[6] * x + m[7] * y + m[8] * z + pivot[2] + move[2] + 0;
  }
  return { mesh: mesh.uvs ? { positions, faces: mesh.faces, uvs: mesh.uvs } : { positions, faces: mesh.faces }, vertices: list };
}
