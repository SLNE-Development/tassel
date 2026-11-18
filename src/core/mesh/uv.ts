// UV unwrapping, packing and editing. Deterministic and DOM-free.
// UVs are stored per face corner (`PolyMesh.uvs`), v pointing up, rounded to 6 decimals.
import type { PolyMesh, Vec3 } from '../types';
import { newell } from './polymesh';
import { edgeKey } from './topology';

export const unwrapMethods = ['smart', 'box', 'planar', 'cylinder', 'sphere'] as const;
export type UnwrapMethod = (typeof unwrapMethods)[number];
export type UvAxis = 'x' | 'y' | 'z';

export interface UnwrapOptions {
  method: UnwrapMethod;
  /** smart: largest angle in degrees (below 90) between a face normal and the normal of the face its chart started from. */
  angle?: number;
  /** smart / box: gap between charts and to the border, as a fraction of the 0..1 square. */
  margin?: number;
  /** planar: projection direction; cylinder / sphere: the axis to wrap around. */
  axis?: UvAxis;
  /** Limit the unwrap to these faces; the others keep their UVs (or get 0,0 if the mesh had none). */
  faces?: readonly number[] | null;
}

export interface UvResult {
  mesh: PolyMesh;
  /** Number of charts (connected UV islands) among the affected faces. */
  charts: number;
  /** Share of the 0..1 square covered by the affected faces. */
  coverage: number;
}

export interface UvTransform {
  translate?: readonly [number, number];
  /** Degrees, counter-clockwise. */
  rotate?: number;
  scale?: readonly [number, number] | number;
  /** Centre of rotation and scaling. Defaults to the centre of the bounding box of the affected UVs. */
  pivot?: readonly [number, number];
}

/** UVs are stored with this precision; `+ 0` turns -0 into 0. */
const round = (x: number): number => Math.round(x * 1e6) / 1e6 + 0;
/** Two corner UVs closer than this (per coordinate) are the same point. */
const SAME_UV = 2e-6;

/** Signed area of a UV polygon given as flat [u0, v0, u1, v1, ...]; positive = counter-clockwise. */
export function uvArea(uv: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < uv.length; i += 2) {
    const j = (i + 2) % uv.length;
    sum += uv[i] * uv[j + 1] - uv[j] * uv[i + 1];
  }
  return sum / 2;
}

function checkedFaces(mesh: PolyMesh, faces: readonly number[] | null | undefined): number[] {
  if (!faces) return mesh.faces.map((_, i) => i);
  const list = [...new Set(faces)].sort((a, b) => a - b);
  for (const f of list) if (!mesh.faces[f]) throw new Error(`Face ${f} does not exist`);
  return list;
}

/** A copy of the UV list that may be modified per face; faces without UVs start at 0,0. */
function editableUvs(mesh: PolyMesh): (readonly number[])[] {
  return mesh.uvs ? [...mesh.uvs] : mesh.faces.map((face) => new Array<number>(face.length * 2).fill(0));
}

/**
 * Tangent basis (right, up) of the plane with unit normal `n`: right x up = n, and "up" is as close
 * to +Y as possible, so that projected side faces stand upright. Faces looking along Y get x as right.
 */
function basis(n: Vec3): [Vec3, Vec3] {
  if (Math.abs(n[1]) > 0.999) {
    // up = n x X, right = up x n
    const up: Vec3 = [0, n[2], -n[1]];
    const len = Math.hypot(up[1], up[2]);
    up[1] /= len;
    up[2] /= len;
    return [[up[1] * n[2] - up[2] * n[1], up[2] * n[0], -up[1] * n[0]], up];
  }
  // right = Y x n, up = n x right
  const len = Math.hypot(n[0], n[2]);
  const right: Vec3 = [n[2] / len, 0, -n[0] / len];
  return [right, [n[1] * right[2], n[2] * right[0] - n[0] * right[2], -n[1] * right[0]]];
}

/** Sets the UVs of `face` to its corners projected onto the plane with normal `n`. */
function projectFace(mesh: PolyMesh, uvs: (readonly number[])[], f: number, n: Vec3): void {
  const [right, up] = basis(n);
  const p = mesh.positions;
  const out: number[] = [];
  for (const v of mesh.faces[f]) {
    const [x, y, z] = [p[v * 3], p[v * 3 + 1], p[v * 3 + 2]];
    out.push(x * right[0] + y * right[1] + z * right[2], x * up[0] + y * up[1] + z * up[2]);
  }
  uvs[f] = out;
}

/** For each of `faces`: the faces of the same set it shares an edge with. */
function neighbours(mesh: PolyMesh, faces: readonly number[]): Map<number, number[]> {
  const byEdge = new Map<string, number[]>();
  for (const f of faces) {
    const face = mesh.faces[f];
    for (let i = 0; i < face.length; i++) {
      const key = edgeKey(face[i], face[(i + 1) % face.length]);
      const list = byEdge.get(key);
      if (list) list.push(f);
      else byEdge.set(key, [f]);
    }
  }
  const out = new Map<number, number[]>(faces.map((f) => [f, []]));
  for (const list of byEdge.values()) {
    for (const a of list) for (const b of list) if (a !== b) out.get(a)!.push(b);
  }
  return out;
}

// ---- Charts ------------------------------------------------------------------------------------

/**
 * Smart charts: starting from the largest face not yet in a chart, a chart grows over edge-adjacent
 * faces whose normal is within `angle` degrees of that first face's normal. Each chart is projected
 * onto the plane of its area-weighted average normal.
 */
function smartCharts(mesh: PolyMesh, uvs: (readonly number[])[], faces: readonly number[], angle: number): number[][] {
  const p = mesh.positions;
  const vectors = new Map<number, Vec3>(faces.map((f) => [f, newell(p, mesh.faces[f])]));
  const length = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);
  let largest = 0;
  for (const v of vectors.values()) largest = Math.max(largest, length(v));
  // Areas are compared in coarse steps so that rounding noise between equal faces does not decide the order.
  const rank = new Map<number, number>(faces.map((f) => [f, largest > 0 ? Math.round((length(vectors.get(f)!) / largest) * 1e6) : 0]));
  const seeds = [...faces].sort((a, b) => rank.get(b)! - rank.get(a)! || a - b);
  const adjacent = neighbours(mesh, faces);
  const limit = Math.cos((Math.min(Math.max(angle, 0), 89) * Math.PI) / 180) - 1e-9;

  const charts: number[][] = [];
  const done = new Set<number>();
  for (const seed of seeds) {
    if (done.has(seed)) continue;
    const s = vectors.get(seed)!;
    const sl = length(s);
    const chart = [seed];
    done.add(seed);
    for (let i = 0; i < chart.length; i++) {
      for (const other of adjacent.get(chart[i])!) {
        if (done.has(other)) continue;
        const o = vectors.get(other)!;
        const ol = length(o);
        // Faces without area have no direction and go along with any chart.
        if (ol > 0 && sl > 0 && (o[0] * s[0] + o[1] * s[1] + o[2] * s[2]) / (ol * sl) < limit) continue;
        done.add(other);
        chart.push(other);
      }
    }

    // Project onto the average plane; if a face would be seen edge-on or from behind there, onto the seed's plane.
    let sum: Vec3 = [0, 0, 0];
    for (const f of chart) {
      const v = vectors.get(f)!;
      sum = [sum[0] + v[0], sum[1] + v[1], sum[2] + v[2]];
    }
    const sumLength = length(sum);
    const facesIt = chart.every((f) => {
      const v = vectors.get(f)!;
      return v[0] * sum[0] + v[1] * sum[1] + v[2] * sum[2] >= 0.05 * length(v) * sumLength;
    });
    let n: Vec3 = [0, 1, 0];
    if (sumLength > 0 && facesIt) n = [sum[0] / sumLength, sum[1] / sumLength, sum[2] / sumLength];
    else if (sl > 0) n = [s[0] / sl, s[1] / sl, s[2] / sl];
    for (const f of chart) projectFace(mesh, uvs, f, n);
    charts.push(chart.sort((a, b) => a - b));
  }
  return charts;
}

/** Box charts: every face is projected along the axis its normal points along most; connected faces of one direction form a chart. */
function boxCharts(mesh: PolyMesh, uvs: (readonly number[])[], faces: readonly number[]): number[][] {
  const p = mesh.positions;
  const direction = new Map<number, number>();
  for (const f of faces) {
    const n = newell(p, mesh.faces[f]);
    // On ties the earlier axis wins, with a little slack against rounding noise.
    let axis = 0;
    for (let a = 1; a < 3; a++) if (Math.abs(n[a]) > Math.abs(n[axis]) * (1 + 1e-9) + 1e-300) axis = a;
    const d = axis * 2 + (n[axis] < 0 ? 1 : 0);
    direction.set(f, d);
    const normal: Vec3 = [0, 0, 0];
    normal[axis] = n[axis] < 0 ? -1 : 1;
    projectFace(mesh, uvs, f, normal);
  }
  const adjacent = neighbours(mesh, faces);
  const charts: number[][] = [];
  const done = new Set<number>();
  for (const seed of faces) {
    if (done.has(seed)) continue;
    const chart = [seed];
    done.add(seed);
    for (let i = 0; i < chart.length; i++) {
      for (const other of adjacent.get(chart[i])!) {
        if (done.has(other) || direction.get(other) !== direction.get(seed)) continue;
        done.add(other);
        chart.push(other);
      }
    }
    charts.push(chart.sort((a, b) => a - b));
  }
  return charts;
}

/**
 * Connected UV islands: faces belong together when they share an edge and the UVs of both of its
 * corners coincide on the two faces. Each chart is sorted, charts are in order of their first face.
 */
export function uvCharts(mesh: PolyMesh, faces?: readonly number[] | null): number[][] {
  if (!mesh.uvs) return [];
  return islands(mesh, mesh.uvs, checkedFaces(mesh, faces));
}

function islands(mesh: PolyMesh, uvs: readonly (readonly number[])[], faces: readonly number[]): number[][] {
  const parent = new Map<number, number>(faces.map((f) => [f, f]));
  const find = (f: number): number => {
    let root = f;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (parent.get(f) !== root) {
      const next = parent.get(f)!;
      parent.set(f, root);
      f = next;
    }
    return root;
  };
  // Per edge: the faces using it with the UVs at its lower and higher vertex.
  const byEdge = new Map<string, { f: number; uv: [number, number, number, number] }[]>();
  for (const f of faces) {
    const face = mesh.faces[f];
    const uv = uvs[f];
    for (let i = 0; i < face.length; i++) {
      const j = (i + 1) % face.length;
      const [lo, hi] = face[i] < face[j] ? [i, j] : [j, i];
      const entry = { f, uv: [uv[lo * 2], uv[lo * 2 + 1], uv[hi * 2], uv[hi * 2 + 1]] as [number, number, number, number] };
      const key = edgeKey(face[i], face[j]);
      const list = byEdge.get(key);
      if (list) list.push(entry);
      else byEdge.set(key, [entry]);
    }
  }
  for (const list of byEdge.values()) {
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        if (list[a].uv.every((x, k) => Math.abs(x - list[b].uv[k]) <= SAME_UV)) {
          const [ra, rb] = [find(list[a].f), find(list[b].f)];
          if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb));
        }
      }
    }
  }
  const charts = new Map<number, number[]>();
  for (const f of faces) {
    const root = find(f);
    const chart = charts.get(root);
    if (chart) chart.push(f);
    else charts.set(root, [f]);
  }
  return [...charts.values()];
}

// ---- Packing -----------------------------------------------------------------------------------

/** Convex hull (counter-clockwise, no duplicates) of flat 2D points. */
function convexHull(points: readonly number[]): number[] {
  const order = Array.from({ length: points.length / 2 }, (_, i) => i).sort(
    (a, b) => points[a * 2] - points[b * 2] || points[a * 2 + 1] - points[b * 2 + 1],
  );
  const cross = (o: number, a: number, b: number) =>
    (points[a * 2] - points[o * 2]) * (points[b * 2 + 1] - points[o * 2 + 1]) -
    (points[a * 2 + 1] - points[o * 2 + 1]) * (points[b * 2] - points[o * 2]);
  const half = (list: number[]) => {
    const out: number[] = [];
    for (const i of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], i) <= 0) out.pop();
      out.push(i);
    }
    out.pop();
    return out;
  };
  const hull = [...half(order), ...half(order.reverse())];
  return hull.flatMap((i) => [points[i * 2], points[i * 2 + 1]]);
}

/**
 * The rotation (radians, between -45 and 45 degrees) that makes the bounding rectangle of the points
 * smallest, or 0 if the upright rectangle is already as good as the best one.
 */
function bestRotation(points: readonly number[]): number {
  const hull = convexHull(points);
  const extent = (angle: number): number => {
    const [c, s] = [Math.cos(angle), Math.sin(angle)];
    let [minX, maxX, minY, maxY] = [Infinity, -Infinity, Infinity, -Infinity];
    for (let i = 0; i < hull.length; i += 2) {
      const x = hull[i] * c - hull[i + 1] * s;
      const y = hull[i] * s + hull[i + 1] * c;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    return (maxX - minX) * (maxY - minY);
  };
  const upright = extent(0);
  let best = 0;
  let bestArea = upright;
  // The smallest rectangle has a side along an edge of the convex hull.
  for (let i = 0; i < hull.length; i += 2) {
    const j = (i + 2) % hull.length;
    let angle = -Math.atan2(hull[j + 1] - hull[i + 1], hull[j] - hull[i]);
    angle -= Math.round(angle / (Math.PI / 2)) * (Math.PI / 2);
    const area = extent(angle);
    if (area < bestArea - 1e-12 * upright) {
      bestArea = area;
      best = angle;
    }
  }
  return bestArea < upright * 0.99 ? best : 0;
}

/**
 * Skyline bottom-left packing of rectangles (in the given order) into a strip of width `size`.
 * Returns the positions, or null if a rectangle does not fit into the square `size` x `size`.
 */
function skyline(widths: readonly number[], heights: readonly number[], order: readonly number[], size: number): { x: number[]; y: number[] } | null {
  const eps = size * 1e-9;
  // Segments of the skyline from left to right: [x, y, width].
  let line: [number, number, number][] = [[0, 0, size]];
  const xs = new Array<number>(widths.length).fill(0);
  const ys = new Array<number>(widths.length).fill(0);
  for (const r of order) {
    const [w, h] = [widths[r], heights[r]];
    let bestY = Infinity;
    let bestX = 0;
    for (let i = 0; i < line.length; i++) {
      const x = line[i][0];
      if (x + w > size + eps) break;
      let y = line[i][1];
      for (let k = i + 1; k < line.length && line[k][0] < x + w - eps; k++) y = Math.max(y, line[k][1]);
      if (y < bestY - eps) {
        bestY = y;
        bestX = x;
      }
    }
    if (bestY + h > size + eps) return null;
    xs[r] = bestX;
    ys[r] = bestY;
    const end = bestX + w;
    const next: [number, number, number][] = [];
    for (const segment of line) {
      const segmentEnd = segment[0] + segment[2];
      if (segmentEnd <= bestX + eps || segment[0] >= end - eps) next.push(segment);
      else {
        if (segment[0] < bestX - eps) next.push([segment[0], segment[1], bestX - segment[0]]);
        if (segmentEnd > end + eps) next.push([end, segment[1], segmentEnd - end]);
      }
    }
    if (w > eps) next.push([bestX, bestY + h, w]);
    line = next.sort((a, b) => a[0] - b[0]);
  }
  return { x: xs, y: ys };
}

/**
 * Packs the charts into the 0..1 square: every chart is scaled to the same texel density (UV area
 * per surface area), turned to its smallest bounding rectangle where that saves space, and the
 * rectangles are packed without overlap with `margin` between them and to the border, as large as
 * they fit. If there are too many charts for the margin, the margin shrinks. Writes `uvs`.
 */
function packCharts(mesh: PolyMesh, uvs: (readonly number[])[], charts: readonly (readonly number[])[], margin: number): void {
  if (charts.length === 0) return;
  const p = mesh.positions;
  const count = charts.length;
  const local: number[][][] = []; // per chart, per face: UVs relative to the chart's rectangle
  const widths: number[] = [];
  const heights: number[] = [];
  for (const chart of charts) {
    // Density: surface area against UV area; for charts without UV area lengths are compared instead.
    let area3 = 0;
    let area2 = 0;
    let length3 = 0;
    let length2 = 0;
    const points: number[] = [];
    for (const f of chart) {
      const face = mesh.faces[f];
      const uv = uvs[f];
      const n = newell(p, face);
      area3 += Math.hypot(n[0], n[1], n[2]) / 2;
      area2 += Math.abs(uvArea(uv));
      for (let i = 0; i < face.length; i++) {
        const j = (i + 1) % face.length;
        const [a, b] = [face[i] * 3, face[j] * 3];
        length3 += Math.hypot(p[a] - p[b], p[a + 1] - p[b + 1], p[a + 2] - p[b + 2]);
        length2 += Math.hypot(uv[i * 2] - uv[j * 2], uv[i * 2 + 1] - uv[j * 2 + 1]);
        points.push(uv[i * 2], uv[i * 2 + 1]);
      }
    }
    let scale = 1;
    if (area2 > 1e-9 * length2 * length2 && area3 > 0) scale = Math.sqrt(area3 / area2);
    else if (length2 > 0 && length3 > 0) scale = length3 / length2;

    const angle = bestRotation(points);
    const [c, s] = [Math.cos(angle) * scale, Math.sin(angle) * scale];
    let [minX, maxX, minY, maxY] = [Infinity, -Infinity, Infinity, -Infinity];
    const turned = chart.map((f) => {
      const uv = uvs[f];
      const out: number[] = [];
      for (let i = 0; i < uv.length; i += 2) {
        const x = uv[i] * c - uv[i + 1] * s;
        const y = uv[i] * s + uv[i + 1] * c;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        out.push(x, y);
      }
      return out;
    });
    for (const uv of turned) {
      for (let i = 0; i < uv.length; i += 2) {
        uv[i] -= minX;
        uv[i + 1] -= minY;
      }
    }
    local.push(turned);
    widths.push(maxX - minX);
    heights.push(maxY - minY);
  }

  // Tall rectangles first: that is what skyline packing likes.
  const order = Array.from({ length: count }, (_, i) => i).sort((a, b) => heights[b] - heights[a] || widths[b] - widths[a] || a - b);
  const largest = Math.max(...widths, ...heights);
  let gap = Math.min(Math.max(margin, 0), 0.25);
  let scale = 0;
  let layout: { x: number[]; y: number[] } | null = null;
  // Every rectangle is grown by the gap (half on each side) and packed into the square shrunk by the gap.
  const attempt = (s: number) => {
    const w = widths.map((x) => x * s + gap);
    const h = heights.map((x) => x * s + gap);
    const size = 1 - gap;
    let area = 0;
    for (let i = 0; i < count; i++) area += w[i] * h[i];
    return area > size * size * (1 + 1e-9) ? null : skyline(w, h, order, size);
  };
  for (;;) {
    layout = attempt(0);
    if (layout) break;
    gap /= 2; // too many charts for this margin
  }
  if (largest > 0) {
    let high = (1 - 2 * gap) / largest;
    const atHigh = attempt(high);
    if (atHigh) {
      layout = atHigh;
      scale = high;
    } else {
      let low = 0;
      for (let i = 0; i < 40; i++) {
        const mid = (low + high) / 2;
        const fit = attempt(mid);
        if (fit) {
          layout = fit;
          scale = low = mid;
        } else high = mid;
      }
    }
  }

  // Centre what was packed in the square.
  let usedX = 0;
  let usedY = 0;
  for (let i = 0; i < count; i++) {
    usedX = Math.max(usedX, layout.x[i] + widths[i] * scale + gap);
    usedY = Math.max(usedY, layout.y[i] + heights[i] * scale + gap);
  }
  const offsetX = gap + (1 - gap - usedX) / 2;
  const offsetY = gap + (1 - gap - usedY) / 2;
  charts.forEach((chart, i) => {
    chart.forEach((f, k) => {
      uvs[f] = local[i][k].map((x, j) => round(x * scale + (j % 2 === 0 ? layout!.x[i] + offsetX : layout!.y[i] + offsetY)));
    });
  });
}

// ---- Projections -------------------------------------------------------------------------------

const axisVector: Record<UvAxis, Vec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/** Angle difference wrapped to -PI..PI. */
const wrap = (a: number): number => a - Math.round(a / (2 * Math.PI)) * 2 * Math.PI;

/**
 * Planar, cylindrical or spherical projection of the faces about the centre of their bounding box.
 * - planar: seen along `axis` (from its positive side), scaled uniformly so that the longer side fills 0..1, centred.
 * - cylinder: u runs once around the axis (the seam is at the back, u = 0.5 at the front), v along the axis from 0 to 1.
 *   Caps (faces across the axis) are projected flat into the full square instead.
 * - sphere: u as for the cylinder, v is the latitude (0 = bottom pole, 1 = top pole).
 * Faces across the seam are kept in one piece: their u continues past 0 or 1 instead of jumping back.
 * A corner on the axis (a pole) gets the average u of the other corners of its face.
 */
function project(mesh: PolyMesh, uvs: (readonly number[])[], faces: readonly number[], method: 'planar' | 'cylinder' | 'sphere', axis: UvAxis): void {
  const p = mesh.positions;
  const n = axisVector[axis];
  const [right, up] = basis(n);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const f of faces) {
    for (const v of mesh.faces[f]) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], p[v * 3 + k]);
        max[k] = Math.max(max[k], p[v * 3 + k]);
      }
    }
  }
  const centre: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  /** Coordinates of a vertex relative to the centre: along right, along up (both across the axis), along the axis. */
  const coordinates = (v: number): Vec3 => {
    const [x, y, z] = [p[v * 3] - centre[0], p[v * 3 + 1] - centre[1], p[v * 3 + 2] - centre[2]];
    return [x * right[0] + y * right[1] + z * right[2], x * up[0] + y * up[1] + z * up[2], x * n[0] + y * n[1] + z * n[2]];
  };
  const extent: Vec3 = [0, 0, 0]; // half sizes along right / up / axis
  let radius = 0;
  for (const f of faces) {
    for (const v of mesh.faces[f]) {
      const c = coordinates(v);
      for (let k = 0; k < 3; k++) extent[k] = Math.max(extent[k], Math.abs(c[k]));
      radius = Math.max(radius, Math.hypot(c[0], c[1]));
    }
  }

  if (method === 'planar') {
    const size = 2 * Math.max(extent[0], extent[1]);
    for (const f of faces) {
      uvs[f] = mesh.faces[f].flatMap((v) => {
        const c = coordinates(v);
        return size > 0 ? [round(0.5 + c[0] / size), round(0.5 + c[1] / size)] : [0.5, 0.5];
      });
    }
    return;
  }

  const onAxis = 1e-9 * Math.max(radius, extent[2]);
  for (const f of faces) {
    const face = mesh.faces[f];
    const corners = face.map(coordinates);
    const off = corners.filter((c) => Math.hypot(c[0], c[1]) > onAxis);
    // The angle is 0 at the front (for the y axis: +Z) and grows to the right seen from outside.
    const angles = off.map((c) => Math.atan2(c[0], -c[1]));
    let turn = 0;
    for (let i = 0; i < angles.length; i++) turn += wrap(angles[(i + 1) % angles.length] - angles[i]);
    const encircles = off.length === corners.length && Math.abs(turn) > Math.PI;
    let cap = encircles;
    if (!cap && method === 'cylinder') {
      const normal = newell(p, face);
      const length = Math.hypot(normal[0], normal[1], normal[2]);
      cap = length > 0 && Math.abs(normal[0] * n[0] + normal[1] * n[1] + normal[2] * n[2]) > 0.999 * length;
    }
    if (cap) {
      uvs[f] = corners.flatMap((c) => (radius > 0 ? [round(0.5 + (0.5 * c[0]) / radius), round(0.5 + (0.5 * c[1]) / radius)] : [0.5, 0.5]));
      continue;
    }

    // Angles relative to the direction of the face's centre keep a face on the seam in one piece.
    let [sumX, sumY] = [0, 0];
    for (const c of off) {
      sumX += c[0];
      sumY += c[1];
    }
    const reference = Math.hypot(sumX, sumY) > onAxis ? Math.atan2(sumX, -sumY) : (angles[0] ?? 0);
    const us = off.map((_, i) => 0.5 + (reference + wrap(angles[i] - reference)) / (2 * Math.PI));
    const pole = us.length > 0 ? us.reduce((a, b) => a + b) / us.length : 0.5;
    let next = 0;
    uvs[f] = corners.flatMap((c) => {
      const u = Math.hypot(c[0], c[1]) > onAxis ? us[next++] : pole;
      let v = 0.5;
      if (method === 'cylinder') {
        if (extent[2] > 0) v = 0.5 + c[2] / (2 * extent[2]);
      } else {
        const distance = Math.hypot(c[0], c[1], c[2]);
        if (distance > 0) v = 0.5 + Math.asin(Math.min(1, Math.max(-1, c[2] / distance))) / Math.PI;
      }
      return [round(u), round(v)];
    });
  }
}

// ---- Operations --------------------------------------------------------------------------------

function coverage(uvs: readonly (readonly number[])[], faces: readonly number[]): number {
  let sum = 0;
  for (const f of faces) sum += Math.abs(uvArea(uvs[f]));
  return round(Math.min(1, sum));
}

/** Creates UVs for the mesh (or for some of its faces) with the given method. */
export function unwrap(mesh: PolyMesh, options: UnwrapOptions): UvResult {
  const faces = checkedFaces(mesh, options.faces);
  const uvs = editableUvs(mesh);
  let charts: number;
  if (options.method === 'smart' || options.method === 'box') {
    const list = options.method === 'smart' ? smartCharts(mesh, uvs, faces, options.angle ?? 66) : boxCharts(mesh, uvs, faces);
    packCharts(mesh, uvs, list, options.margin ?? 0.02);
    charts = list.length;
  } else {
    project(mesh, uvs, faces, options.method, options.axis ?? 'y');
    charts = islands(mesh, uvs, faces).length;
  }
  return { mesh: { positions: mesh.positions, faces: mesh.faces, uvs }, charts, coverage: coverage(uvs, faces) };
}

/** Re-packs the existing charts (connected UV islands) of the mesh, or of some of its faces, into 0..1. */
export function packUvs(mesh: PolyMesh, margin: number, faces?: readonly number[] | null): UvResult {
  if (!mesh.uvs) throw new Error('The mesh has no UVs');
  const list = checkedFaces(mesh, faces);
  const uvs = [...mesh.uvs];
  const charts = islands(mesh, uvs, list);
  packCharts(mesh, uvs, charts, margin);
  return { mesh: { positions: mesh.positions, faces: mesh.faces, uvs }, charts: charts.length, coverage: coverage(uvs, list) };
}

/** Scales, then rotates (both about the pivot), then moves the UVs of the given faces (null = all). */
export function transformUvs(mesh: PolyMesh, faces: readonly number[] | null, t: UvTransform): PolyMesh {
  if (!mesh.uvs) throw new Error('The mesh has no UVs');
  const list = checkedFaces(mesh, faces);
  let pivot = t.pivot;
  if (!pivot) {
    let [minU, maxU, minV, maxV] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const f of list) {
      const uv = mesh.uvs[f];
      for (let i = 0; i < uv.length; i += 2) {
        minU = Math.min(minU, uv[i]);
        maxU = Math.max(maxU, uv[i]);
        minV = Math.min(minV, uv[i + 1]);
        maxV = Math.max(maxV, uv[i + 1]);
      }
    }
    pivot = list.length > 0 ? [(minU + maxU) / 2, (minV + maxV) / 2] : [0.5, 0.5];
  }
  const [su, sv] = typeof t.scale === 'number' ? [t.scale, t.scale] : (t.scale ?? [1, 1]);
  const angle = ((t.rotate ?? 0) * Math.PI) / 180;
  const [c, s] = [Math.cos(angle), Math.sin(angle)];
  const [du, dv] = t.translate ?? [0, 0];
  const uvs = [...mesh.uvs];
  for (const f of list) {
    const uv = mesh.uvs[f];
    const out: number[] = [];
    for (let i = 0; i < uv.length; i += 2) {
      const u = (uv[i] - pivot[0]) * su;
      const v = (uv[i + 1] - pivot[1]) * sv;
      out.push(round(u * c - v * s + pivot[0] + du), round(u * s + v * c + pivot[1] + dv));
    }
    uvs[f] = out;
  }
  return { positions: mesh.positions, faces: mesh.faces, uvs };
}

/** The mesh without UVs (the mesh itself if it has none). */
export function clearUvs(mesh: PolyMesh): PolyMesh {
  return mesh.uvs ? { positions: mesh.positions, faces: mesh.faces } : mesh;
}
