// World-space bounding boxes of objects (evaluated meshes, i.e. after modifiers). DOM-free.
import { evaluateObject } from './modifiers/evaluate';
import { transformMatrix } from './modifiers/boolean';
import { roundVec3 } from './transformMath';
import type { DocState, PolyMesh, Transform, Vec3 } from './types';

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

/** Axis-aligned world-space box of a mesh under a transform (values rounded to 1e-6), or null for a mesh without vertices. */
export function meshWorldBounds(mesh: PolyMesh, transform: Transform): Bounds | null {
  const p = mesh.positions;
  if (p.length === 0) return null;
  const m = transformMatrix(transform);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let r = 0; r < 3; r++) {
      const v = m[r * 4] * p[i] + m[r * 4 + 1] * p[i + 1] + m[r * 4 + 2] * p[i + 2] + m[r * 4 + 3];
      if (v < min[r]) min[r] = v;
      if (v > max[r]) max[r] = v;
    }
  }
  return { min: roundVec3(min), max: roundVec3(max) };
}

const cache = new WeakMap<PolyMesh, { transform: Transform; bounds: Bounds | null }>();

/**
 * World-space bounding box of an object's evaluated mesh, or null if it has no vertices. Boolean
 * modifiers only count once `initModifiers()` has resolved (as everywhere else).
 */
export function objectWorldBounds(state: DocState, id: string): Bounds | null {
  const { transform } = state.objects[id];
  const { mesh } = evaluateObject(state, id);
  const hit = cache.get(mesh);
  if (hit && hit.transform === transform) return hit.bounds;
  const bounds = meshWorldBounds(mesh, transform);
  cache.set(mesh, { transform, bounds });
  return bounds;
}

export function unionBounds(list: readonly (Bounds | null)[]): Bounds | null {
  let out: Bounds | null = null;
  for (const b of list) {
    if (!b) continue;
    out = out
      ? { min: out.min.map((v, i) => Math.min(v, b.min[i])) as Vec3, max: out.max.map((v, i) => Math.max(v, b.max[i])) as Vec3 }
      : b;
  }
  return out;
}

/** The union of the world bounds of the given objects, or null if none of them has vertices. */
export function worldBounds(state: DocState, ids: readonly string[]): Bounds | null {
  return unionBounds(ids.map((id) => objectWorldBounds(state, id)));
}

/** `{ min, max, center, size }` as query results report a box. */
export function describeBounds(b: Bounds) {
  return {
    min: b.min,
    max: b.max,
    center: roundVec3(b.min.map((v, i) => (v + b.max[i]) / 2)),
    size: roundVec3(b.max.map((v, i) => v - b.min[i])),
  };
}
