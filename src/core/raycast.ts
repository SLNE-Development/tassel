// Ray casting against the evaluated meshes of objects in world space. DOM-free.
import { Bvh } from '../bake/bvh';
import { triangulateFaceCorners } from './mesh/polymesh';
import { transformMatrix } from './modifiers/boolean';
import { evaluateObject } from './modifiers/evaluate';
import { determinant } from './transformMath';
import type { DocState, PolyMesh, Transform, Vec3 } from './types';

interface Accel {
  transform: Transform;
  /** World-space triangles, 9 numbers each, counter-clockwise seen from the front (also under a mirroring transform). */
  positions: Float64Array;
  triToFace: Uint32Array;
  bvh: Bvh;
}

// Evaluated meshes keep their identity while nothing changes, so many rays against the same scene build each BVH once.
const cache = new WeakMap<PolyMesh, Accel>();

function accelOf(mesh: PolyMesh, transform: Transform): Accel {
  const hit = cache.get(mesh);
  if (hit && hit.transform === transform) return hit;
  let count = 0;
  for (const face of mesh.faces) count += face.length - 2;
  const positions = new Float64Array(count * 9);
  const triToFace = new Uint32Array(count);
  const m = transformMatrix(transform);
  const mirrored = determinant(m) < 0;
  const p = mesh.positions;
  const corners: number[] = [];
  let t = 0;
  mesh.faces.forEach((face, f) => {
    corners.length = 0;
    triangulateFaceCorners(mesh, face, corners);
    for (let c = 0; c < corners.length; c += 3) {
      for (let k = 0; k < 3; k++) {
        // A mirroring transform turns the winding around: swap corners 1 and 2.
        const v = face[corners[c + (mirrored && k > 0 ? 3 - k : k)]] * 3;
        for (let r = 0; r < 3; r++) {
          positions[t * 9 + k * 3 + r] = m[r * 4] * p[v] + m[r * 4 + 1] * p[v + 1] + m[r * 4 + 2] * p[v + 2] + m[r * 4 + 3];
        }
      }
      triToFace[t++] = f;
    }
  });
  const accel = { transform, positions, triToFace, bvh: new Bvh(positions) };
  cache.set(mesh, accel);
  return accel;
}

export interface RayHit {
  objectId: string;
  /** World-space hit point. */
  point: Vec3;
  /** Unit geometric normal of the hit face in world space, pointing to the face's front (outside). */
  normal: Vec3;
  /** Distance from the origin in meters. */
  distance: number;
  /** Index of the hit face in the object's evaluated mesh. */
  faceIndex: number;
  /** False if the ray hit the face from behind (from inside the object). */
  frontFacing: boolean;
}

/**
 * The nearest intersection of the ray with the evaluated meshes of the given objects. `direction`
 * must be a unit vector. Hits are two-sided.
 */
export function raycast(state: DocState, ids: readonly string[], origin: Vec3, direction: Vec3, maxDistance = Infinity): RayHit | null {
  let best: RayHit | null = null;
  let limit = Math.min(maxDistance, 1e300);
  const [ox, oy, oz] = origin;
  const [dx, dy, dz] = direction;
  for (const id of ids) {
    const { mesh } = evaluateObject(state, id);
    if (mesh.faces.length === 0) continue;
    const accel = accelOf(mesh, state.objects[id].transform);
    if (!accel.bvh.closest(ox, oy, oz, dx, dy, dz, 0, limit)) continue;
    const t = accel.bvh.hitT;
    // Of two hits at the same distance the first object wins.
    if (best && t >= limit) continue;
    limit = t;
    const o = accel.bvh.hitTriangle * 9;
    const q = accel.positions;
    const e1 = [q[o + 3] - q[o], q[o + 4] - q[o + 1], q[o + 5] - q[o + 2]];
    const e2 = [q[o + 6] - q[o], q[o + 7] - q[o + 1], q[o + 8] - q[o + 2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const length = Math.hypot(n[0], n[1], n[2]) || 1;
    const normal: Vec3 = [n[0] / length + 0, n[1] / length + 0, n[2] / length + 0];
    best = {
      objectId: id,
      point: [ox + dx * t, oy + dy * t, oz + dz * t],
      normal,
      distance: t,
      faceIndex: accel.triToFace[accel.bvh.hitTriangle],
      frontFacing: normal[0] * dx + normal[1] * dy + normal[2] * dz < 0,
    };
  }
  return best;
}
