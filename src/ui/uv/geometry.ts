// What the UV editor derives from a mesh's UVs: charts, bounds for picking, coverage. DOM-free.
import { uvArea, uvCharts } from '../../core/mesh/uv';
import type { PolyMesh } from '../../core/types';

export interface UvGeometry {
  readonly uvs: readonly (readonly number[])[];
  /** Connected UV islands as sorted face lists. */
  readonly charts: readonly (readonly number[])[];
  /** Chart index per face. */
  readonly chartOf: Int32Array;
  /** Per face: min u, min v, max u, max v. */
  readonly bounds: Float64Array;
  /** Share of the 0..1 square the faces cover (overlaps count twice, capped at 1). */
  readonly coverage: number;
}

const cache = new WeakMap<object, UvGeometry>();

/** The geometry of a mesh's UVs, or null if it has none. Cached per UV set (meshes are immutable). */
export function uvGeometry(mesh: PolyMesh): UvGeometry | null {
  const uvs = mesh.uvs;
  if (!uvs) return null;
  let geometry = cache.get(uvs);
  if (!geometry) {
    const charts = uvCharts(mesh);
    const chartOf = new Int32Array(uvs.length);
    charts.forEach((chart, i) => {
      for (const f of chart) chartOf[f] = i;
    });
    const bounds = new Float64Array(uvs.length * 4);
    let area = 0;
    for (let f = 0; f < uvs.length; f++) {
      const uv = uvs[f];
      let [minU, minV, maxU, maxV] = [Infinity, Infinity, -Infinity, -Infinity];
      for (let i = 0; i < uv.length; i += 2) {
        if (uv[i] < minU) minU = uv[i];
        if (uv[i] > maxU) maxU = uv[i];
        if (uv[i + 1] < minV) minV = uv[i + 1];
        if (uv[i + 1] > maxV) maxV = uv[i + 1];
      }
      bounds.set([minU, minV, maxU, maxV], f * 4);
      area += Math.abs(uvArea(uv));
    }
    geometry = { uvs, charts, chartOf, bounds, coverage: Math.min(1, area) };
    cache.set(uvs, geometry);
  }
  return geometry;
}

function inPolygon(uv: readonly number[], u: number, v: number): boolean {
  let inside = false;
  for (let i = 0, j = uv.length - 2; i < uv.length; j = i, i += 2) {
    if (uv[i + 1] > v !== uv[j + 1] > v && u < ((uv[j] - uv[i]) * (v - uv[i + 1])) / (uv[j + 1] - uv[i + 1]) + uv[i]) inside = !inside;
  }
  return inside;
}

/** The face under a UV point, or -1. Where faces overlap, the smallest one wins: it is the hardest to hit otherwise. */
export function pickFace(geometry: UvGeometry, u: number, v: number): number {
  const { uvs, bounds } = geometry;
  let best = -1;
  let bestArea = Infinity;
  for (let f = 0; f < uvs.length; f++) {
    const b = f * 4;
    if (u < bounds[b] || v < bounds[b + 1] || u > bounds[b + 2] || v > bounds[b + 3] || !inPolygon(uvs[f], u, v)) continue;
    const area = Math.abs(uvArea(uvs[f]));
    if (area < bestArea) {
      best = f;
      bestArea = area;
    }
  }
  return best;
}

const side = (ax: number, ay: number, bx: number, by: number, px: number, py: number) => Math.sign((bx - ax) * (py - ay) - (by - ay) * (px - ax));

function segmentsCross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  return side(ax, ay, bx, by, cx, cy) !== side(ax, ay, bx, by, dx, dy) && side(cx, cy, dx, dy, ax, ay) !== side(cx, cy, dx, dy, bx, by);
}

/** The faces that touch the rectangle: a corner inside it, an edge through it, or the rectangle inside the face. */
export function facesInRect(geometry: UvGeometry, u0: number, v0: number, u1: number, v1: number): number[] {
  const { uvs, bounds } = geometry;
  const [minU, maxU, minV, maxV] = [Math.min(u0, u1), Math.max(u0, u1), Math.min(v0, v1), Math.max(v0, v1)];
  const hits: number[] = [];
  for (let f = 0; f < uvs.length; f++) {
    const b = f * 4;
    if (bounds[b] > maxU || bounds[b + 2] < minU || bounds[b + 1] > maxV || bounds[b + 3] < minV) continue;
    const uv = uvs[f];
    let hit = inPolygon(uv, minU, minV);
    for (let i = 0, j = uv.length - 2; !hit && i < uv.length; j = i, i += 2) {
      hit =
        (uv[i] >= minU && uv[i] <= maxU && uv[i + 1] >= minV && uv[i + 1] <= maxV) ||
        // An edge that passes through without a corner inside crosses a diagonal.
        segmentsCross(uv[j], uv[j + 1], uv[i], uv[i + 1], minU, minV, maxU, maxV) ||
        segmentsCross(uv[j], uv[j + 1], uv[i], uv[i + 1], minU, maxV, maxU, minV);
    }
    if (hit) hits.push(f);
  }
  return hits;
}
