// From the document to bake jobs: evaluated meshes in world space. DOM-free.
import { Matrix3 } from 'three';
import { triangulate } from '../core/mesh/polymesh';
import { evaluateObject } from '../core/modifiers/evaluate';
import type { BakeRequest, DocState } from '../core/types';
import { transformMatrix } from '../io/scene';
import type { BakeJob, Soup } from './bake';

type WorldSoup = Soup & { uvs?: Float32Array };

/**
 * An object's evaluated mesh (after modifiers) as world-space triangles with smooth or flat normals,
 * transformed the way the viewport does it (normals by the normal matrix). A mirroring transform turns
 * the winding around, so that triangles always wind counter-clockwise seen from their front.
 */
export function worldSoup(state: DocState, id: string, smooth: boolean): WorldSoup {
  const object = state.objects[id];
  const soup = triangulate(evaluateObject(state, id).mesh, smooth);
  const matrix = transformMatrix(object.transform);
  const e = matrix.elements;
  const k = new Matrix3().getNormalMatrix(matrix).elements;
  const { positions, normals, uvs } = soup;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    positions[i] = e[0] * x + e[4] * y + e[8] * z + e[12];
    positions[i + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    positions[i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    const nx = normals[i];
    const ny = normals[i + 1];
    const nz = normals[i + 2];
    const wx = k[0] * nx + k[3] * ny + k[6] * nz;
    const wy = k[1] * nx + k[4] * ny + k[7] * nz;
    const wz = k[2] * nx + k[5] * ny + k[8] * nz;
    const length = Math.hypot(wx, wy, wz) || 1;
    normals[i] = wx / length;
    normals[i + 1] = wy / length;
    normals[i + 2] = wz / length;
  }
  if (matrix.determinant() < 0) {
    // Swap corners 1 and 2 of every triangle.
    const swap = (data: Float32Array, a: number, b: number, width: number) => {
      for (let c = 0; c < width; c++) {
        const keep = data[a + c];
        data[a + c] = data[b + c];
        data[b + c] = keep;
      }
    };
    for (let t = 0; t * 9 < positions.length; t++) {
      swap(positions, t * 9 + 3, t * 9 + 6, 3);
      swap(normals, t * 9 + 3, t * 9 + 6, 3);
      if (uvs) swap(uvs, t * 6 + 2, t * 6 + 4, 2);
    }
  }
  return uvs ? { positions, normals, uvs } : { positions, normals };
}

function merge(soups: readonly Soup[]): Soup {
  if (soups.length === 1) return soups[0];
  const length = soups.reduce((n, s) => n + s.positions.length, 0);
  const positions = new Float32Array(length);
  const normals = new Float32Array(length);
  let offset = 0;
  for (const soup of soups) {
    positions.set(soup.positions, offset);
    normals.set(soup.normals, offset);
    offset += soup.positions.length;
  }
  return { positions, normals };
}

/** Length of the diagonal of the bounding box of all the positions; 0 without any. */
function diagonal(...sets: Float32Array[]): number {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const positions of sets) {
    for (let i = 0; i < positions.length; i++) {
      const a = i % 3;
      if (positions[i] < min[a]) min[a] = positions[i];
      if (positions[i] > max[a]) max[a] = positions[i];
    }
  }
  return min[0] <= max[0] ? Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) : 0;
}

/** Share of the bounding diagonal that the distances default to. */
export const NORMAL_DISTANCE = 0.05;
export const AO_DISTANCE = 0.25;

/**
 * The distance a request is baked with when it names none: 5 % of the target's bounding diagonal for
 * normals, 25 % of the diagonal of everything involved for ambient occlusion.
 */
export function defaultDistance(state: DocState, type: BakeRequest['type'], targetId: string, includeIds: readonly string[] = []): number {
  const positions = (id: string) => worldSoup(state, id, false).positions;
  if (type === 'normal') return diagonal(positions(targetId)) * NORMAL_DISTANCE;
  return diagonal(positions(targetId), ...includeIds.map(positions)) * AO_DISTANCE;
}

/**
 * Collects the geometry of a request. The command has checked the request (objects exist, the target
 * has UVs); this throws only for geometry that cannot be baked at all.
 */
export function buildJob(state: DocState, request: BakeRequest): BakeJob & { distanceUsed: number } {
  const size = request.size;
  if (request.type === 'normal') {
    // Always smooth: the ray directions and the tangent frame must vary continuously over the surface.
    const target = worldSoup(state, request.targetId, true);
    if (!target.uvs) throw new Error('The target object has no UVs');
    const scene = merge(request.sourceIds.map((id) => worldSoup(state, id, state.objects[id].smooth)));
    if (scene.positions.length === 0) throw new Error('The source objects have no faces');
    const maxDistance = request.maxDistance ?? diagonal(target.positions) * NORMAL_DISTANCE;
    if (!(maxDistance > 0)) throw new Error('The target object has no size, so there is nothing to bake onto');
    return { type: 'normal', size, target: { ...target, uvs: target.uvs }, scene, maxDistance, distanceUsed: maxDistance };
  }
  const target = worldSoup(state, request.targetId, state.objects[request.targetId].smooth);
  if (!target.uvs) throw new Error('The target object has no UVs');
  const scene = merge([target, ...request.includeIds.map((id) => worldSoup(state, id, false))]);
  const extent = diagonal(scene.positions);
  const distance = request.distance ?? extent * AO_DISTANCE;
  if (!(distance > 0)) throw new Error('The target object has no size, so there is nothing to bake onto');
  return {
    type: 'ao',
    size,
    target: { ...target, uvs: target.uvs },
    scene,
    samples: request.samples,
    distance,
    bias: extent * 1e-5,
    distanceUsed: distance,
  };
}
