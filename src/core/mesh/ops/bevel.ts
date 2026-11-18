import type { Edge, PolyMesh, Vec3 } from '../../types';
import { faceNormal } from '../polymesh';
import { edgeFaces, edgeKey, makeEdge } from '../topology';
import type { MeshOpResult } from './types';

// Edge bevel.
//
// Every vertex touched by a bevelled edge is resolved on its own. Its faces are ordered into a fan
// (clockwise seen from outside): fan edge i runs to corner i's previous vertex, fan face i lies
// between the fan edges i and i + 1. The bevelled edges cut the fan into sectors, and every sector
// gets its "boundary points", depending on the number r of unbevelled edges inside it:
//   r = 0   one point inside the face, `width` away from both bevelled edges
//   r = 1   one point on the unbevelled edge (the vertex slides along it)
//   r = 2   one point on each unbevelled edge; the face between them gains a vertex
//   r >= 3  one point on the first and one on the last unbevelled edge; the vertex itself stays
//           for the edges in between
// A bevelled edge's strip ends in the profile between the last point of the sector before it and
// the first point of the sector after it. All points and profiles of a vertex, in fan order, form
// its perimeter; whatever the strips and the rewritten faces leave open there is closed by cap faces.

type Corner = { face: number; at: number; prev: number; next: number };

interface VertexPlan {
  vertex: number;
  fan: Corner[];
  /** Fan indices of the bevelled edges, ascending. Sector j starts at bevelled[j]. */
  bevelled: number[];
  /** Boundary point vertex indices per sector, in fan order. */
  sectors: number[][];
  /** The vertex itself is one of the boundary points. */
  kept: boolean;
  /** Per bevelled edge: angle between the two in-face perpendiculars of the edge. */
  angles: number[];
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: Vec3): Vec3 => scale(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));
const ZERO: Vec3 = [0, 0, 0];

/**
 * Point t of the circular arc that touches both legs of an isosceles corner with apex angle `phi`
 * at their ends, as weights [a, b] of the legs: point = apex + a * leg1 + b * leg2.
 */
function arcWeights(phi: number, t: number): [number, number] {
  const sweep = Math.PI - Math.max(phi, 1e-3);
  if (sweep < 1e-6) return [1 - t, t]; // flat: the arc is a straight line
  const a = Math.sin((1 - t) * sweep) / Math.sin(sweep);
  const b = Math.sin(t * sweep) / Math.sin(sweep);
  const centre = (1 - a - b) / (1 - Math.cos(sweep));
  return [a + centre, b + centre];
}

/** Bevels the given edges. `width` is the offset along the adjacent faces, `segments` >= 1. Selects the new faces. */
export function bevelEdges(mesh: PolyMesh, edges: readonly Edge[], width: number, segments: number): MeshOpResult {
  if (!Number.isFinite(width) || width <= 0) throw new Error('Bevel width must be greater than 0.');
  if (!Number.isInteger(segments) || segments < 1) throw new Error('Bevel segments must be a whole number of at least 1.');
  const faceMap = edgeFaces(mesh);
  const given = new Map<string, Edge>();
  for (const [a, b] of edges) {
    const pair = faceMap.get(edgeKey(a, b));
    if (!pair) throw new Error(`Cannot bevel: ${a}-${b} is not an edge of the mesh.`);
    if (pair.length !== 2 || pair[0] === pair[1]) {
      throw new Error(`Cannot bevel edge ${a}-${b}: it must lie between exactly two faces.`);
    }
    given.set(edgeKey(a, b), makeEdge(a, b));
  }
  if (given.size === 0) throw new Error('Cannot bevel: no edges given.');
  // Sorted, so that the result does not depend on the order in which the edges are given.
  const selected = new Map([...given].sort(([, a], [, b]) => a[0] - b[0] || a[1] - b[1]));

  const original = mesh.positions;
  const point = (v: number): Vec3 => [original[v * 3], original[v * 3 + 1], original[v * 3 + 2]];
  const normals = new Map<number, Vec3>();
  const normalOf = (f: number): Vec3 => {
    let n = normals.get(f);
    if (!n) normals.set(f, (n = faceNormal(mesh, mesh.faces[f])));
    return n;
  };

  // Corners of the touched vertices.
  const corners = new Map<number, Corner[]>();
  for (const [a, b] of selected.values()) {
    corners.set(a, []);
    corners.set(b, []);
  }
  mesh.faces.forEach((face, fi) => {
    face.forEach((v, at) => {
      const n = face.length;
      corners.get(v)?.push({ face: fi, at, prev: face[(at + n - 1) % n], next: face[(at + 1) % n] });
    });
  });

  // Every vertex of the result is `original position of base + width * offset`. That makes the largest
  // valid width computable before any geometry is built.
  const vertexCount = original.length / 3;
  const base: number[] = Array.from({ length: vertexCount }, (_, i) => i);
  const offset: Vec3[] = new Array<Vec3>(vertexCount).fill(ZERO);
  /** Per face: the replacement for each corner (sparse, by position in the face loop). */
  const replacements = new Map<number, number[][]>();

  const plans: VertexPlan[] = [];
  for (const [v, list] of [...corners].sort(([a], [b]) => a - b)) {
    const fan = orderFan(v, list);
    const k = fan.length;
    const bevelled = fan.flatMap((c, i) => (selected.has(edgeKey(v, c.prev)) ? [i] : []));
    const m = bevelled.length;
    if (k < 3 && m < 2) throw new Error(`Cannot bevel: vertex ${v} has only two edges and one of them is not bevelled.`);

    const p = point(v);
    const toPrev = fan.map((c) => normalize(sub(point(c.prev), p))); // direction of fan edge i
    // In-face perpendiculars (pointing into fan face i) of the fan edges i and i + 1.
    const perpIn = fan.map((c, i) => normalize(cross(normalOf(c.face), scale(toPrev[i], -1))));
    const perpOut = fan.map((c, i) => normalize(cross(normalOf(c.face), toPrev[(i + 1) % k])));
    /** How far a point has to slide along a neighbouring edge to be 1 away from the bevelled edge. */
    const slide = (sine: number): number => {
      if (sine < 1e-6) throw new Error(`Cannot bevel at vertex ${v}: a neighbouring edge is parallel to a bevelled edge or folds back over it.`);
      return 1 / sine;
    };

    const spans = bevelled.map((s, j) => ({ s, r: (m === 1 ? k : (bevelled[(j + 1) % m] - s + k) % k) - 1 }));
    const kept = spans.some((span) => span.r >= 3);
    let reused = kept;
    const allocate = (o: Vec3): number => {
      if (!reused) {
        reused = true;
        offset[v] = o;
        return v;
      }
      base.push(v);
      offset.push(o);
      return base.length - 1;
    };
    const replace = (i: number, by: number[]) => {
      const c = fan[i % k];
      let perFace = replacements.get(c.face);
      if (!perFace) replacements.set(c.face, (perFace = []));
      perFace[c.at] = by;
    };

    const sectors = spans.map(({ s, r }) => {
      const last = s + r; // fan face before the next bevelled edge
      if (r === 0) {
        const d1 = perpIn[s];
        const d2 = perpOut[s];
        const denominator = 1 + dot(d1, d2);
        if (denominator < 1e-6) throw new Error(`Cannot bevel at vertex ${v}: two bevelled edges fold back onto each other.`);
        const q = allocate(scale(add(d1, d2), 1 / denominator));
        replace(s, [q]);
        return [q];
      }
      // Sliding distances on the first / last unbevelled edge of the sector.
      const first = slide(dot(toPrev[(s + 1) % k], perpIn[s]));
      const final = slide(dot(toPrev[last % k], perpOut[last % k]));
      if (r === 1) {
        // One edge has to serve both sides; exact when it meets both bevelled edges at the same angle.
        const q = allocate(scale(toPrev[(s + 1) % k], (first + final) / 2));
        replace(s, [q]);
        replace(s + 1, [q]);
        return [q];
      }
      const a = allocate(scale(toPrev[(s + 1) % k], first));
      const b = allocate(scale(toPrev[last % k], final));
      replace(s, [a]);
      replace(last, [b]);
      if (r === 2) {
        replace(s + 1, [a, b]);
        return [a, b];
      }
      replace(s + 1, [a, v]);
      replace(last - 1, [v, b]);
      return [a, v, b];
    });
    const angles = bevelled.map((i) => Math.acos(Math.max(-1, Math.min(1, dot(perpOut[(i + k - 1) % k], perpIn[i])))));
    plans.push({ vertex: v, fan, bevelled, sectors, kept, angles });
  }

  // Rewrite the faces and find the width at which the first edge of a face would collapse or flip.
  const faces: number[][] = mesh.faces.map((f) => [...f]);
  let limit = Infinity;
  for (const [fi, perFace] of replacements) {
    const face = mesh.faces[fi];
    faces[fi] = face.flatMap((v, i) => perFace[i] ?? [v]);
    face.forEach((v, i) => {
      const j = (i + 1) % face.length;
      const from = perFace[i]?.at(-1) ?? v;
      const to = perFace[j]?.[0] ?? face[j];
      const edge = sub(point(face[j]), point(v));
      const change = dot(sub(offset[to], offset[from]), edge);
      if (change < 0) limit = Math.min(limit, dot(edge, edge) / -change);
    });
  }
  if (width > limit * (1 - 1e-9)) {
    throw new Error(
      `Bevel width ${width} is too large for these edges: the offsets would cross. It must be smaller than ${Number(limit.toPrecision(6))}.`,
    );
  }

  const positions: number[] = [];
  base.forEach((b, i) => {
    for (let c = 0; c < 3; c++) positions.push(original[b * 3 + c] + width * offset[i][c]);
  });
  const moved = (i: number): Vec3 => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
  const push = (q: Vec3): number => positions.push(q[0], q[1], q[2]) / 3 - 1;

  // Profiles: `segments + 1` vertices per end of a bevelled edge, keyed `${vertex}>${other end}`.
  const profiles = new Map<string, number[]>();
  const caps: number[][] = [];
  for (const { vertex: v, fan, bevelled, sectors, kept, angles } of plans) {
    const m = bevelled.length;
    const p = point(v);
    // Two strips that meet in a single edge share one profile (mitre).
    const shared = m === 2 && sectors[0].length + sectors[1].length === 2;
    const arcs = bevelled.map((i, j) => {
      const other = fan[i].prev;
      const from = sectors[(j + m - 1) % m].at(-1)!;
      const to = sectors[j][0];
      if (shared && j === 1) {
        const arc = [...profiles.get(`${v}>${fan[bevelled[0]].prev}`)!].reverse();
        profiles.set(`${v}>${other}`, arc);
        return arc;
      }
      // The arc's corner is a point on the old edge: the vertex itself where the profile has to lie in
      // the plane of a neighbouring face or mitre, else (three or more bevelled edges) the point that
      // makes the profile perpendicular to the edge.
      let apex = p;
      if (m >= 3) {
        const along = normalize(sub(point(other), p));
        apex = add(p, scale(along, (dot(sub(moved(from), p), along) + dot(sub(moved(to), p), along)) / 2));
      }
      const phi = shared ? (angles[0] + angles[1]) / 2 : angles[j];
      const leg1 = sub(moved(from), apex);
      const leg2 = sub(moved(to), apex);
      const arc = [from];
      for (let s = 1; s < segments; s++) {
        const [a, b] = arcWeights(phi, s / segments);
        arc.push(push(add(apex, add(scale(leg1, a), scale(leg2, b)))));
      }
      arc.push(to);
      profiles.set(`${v}>${other}`, arc);
      return arc;
    });
    if (shared) continue;

    // Perimeter in fan order; reversed it is counter-clockwise seen from outside.
    const perimeter = sectors.flatMap((points, j) => [...points, ...arcs[(j + 1) % m].slice(1, -1)]).reverse();
    if (perimeter.length < 3) continue;
    if (kept) {
      // One cap per stretch between two occurrences of the vertex, each starting at the vertex so that
      // a triangle fan from the first vertex is valid even though the arcs make the cap concave.
      const start = perimeter.indexOf(v);
      const turned = [...perimeter.slice(start), ...perimeter.slice(0, start)];
      for (const q of turned) {
        if (q === v) caps.push([v]);
        else caps.at(-1)!.push(q);
      }
    } else if (segments > 1 && m >= 2) {
      // Rounded corner: a triangle fan around a centre vertex. The factor puts the centre exactly on
      // the sphere for a cube corner; elsewhere it is a reasonable bulge towards the old vertex.
      const mean = scale(sectors.flat().reduce<Vec3>((sum, q) => add(sum, moved(q)), [0, 0, 0]), 1 / sectors.flat().length);
      const centre = push(add(p, scale(sub(mean, p), (3 - Math.sqrt(3)) / 2)));
      perimeter.forEach((q, i) => caps.push([centre, q, perimeter[(i + 1) % perimeter.length]]));
    } else {
      caps.push(perimeter);
    }
  }

  const firstNew = faces.length;
  for (const [a, b] of selected.values()) {
    const pa = profiles.get(`${a}>${b}`)!;
    const pb = profiles.get(`${b}>${a}`)!;
    for (let s = 0; s < segments; s++) faces.push([pa[s], pa[s + 1], pb[segments - s - 1], pb[segments - s]]);
  }
  faces.push(...caps);
  return { mesh: { positions, faces }, faces: Array.from({ length: faces.length - firstNew }, (_, i) => firstNew + i) };
}

/** Orders the corners of a vertex so that each one's next edge is the following one's previous edge. */
function orderFan(v: number, list: Corner[]): Corner[] {
  const error = () => new Error(`Cannot bevel at vertex ${v}: the faces around it do not form a single closed fan.`);
  const byPrev = new Map<number, Corner>();
  for (const c of list) {
    if (byPrev.has(c.prev)) throw error();
    byPrev.set(c.prev, c);
  }
  const fan = [list[0]];
  for (let c = byPrev.get(list[0].next); c !== list[0]; c = byPrev.get(c.next)) {
    if (!c || fan.length >= list.length) throw error();
    fan.push(c);
  }
  if (fan.length !== list.length) throw error();
  return fan;
}
