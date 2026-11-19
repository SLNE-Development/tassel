import type { PolyMesh, Vec3 } from '../types';

export interface TubeOptions {
  /** Radius at every point. Ignored where `radii` is given. */
  radius?: number;
  /** Radius per point (same length as `points`) for tapered tubes. */
  radii?: readonly number[];
  /** Sides of the cross-section. */
  segments?: number;
  /** Join the last point back to the first. A closed tube has no caps. */
  closed?: boolean;
  /** Close the two ends of an open tube with an n-gon each. */
  caps?: boolean;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a: Vec3, f: number): Vec3 => [a[0] * f, a[1] * f, a[2] * f];
const normalize = (a: Vec3): Vec3 => scale(a, 1 / Math.hypot(a[0], a[1], a[2]));

/** Rotates `v` about the unit `axis` by the angle given as cosine and sine (Rodrigues). */
function rotate(v: Vec3, axis: Vec3, cos: number, sin: number): Vec3 {
  const c = cross(axis, v);
  const d = dot(axis, v) * (1 - cos);
  return [v[0] * cos + c[0] * sin + axis[0] * d, v[1] * cos + c[1] * sin + axis[1] * d, v[2] * cos + c[2] * sin + axis[2] * d];
}

/**
 * A round tube along the polyline `points`, in the same space as the points. Faces are CCW seen from outside.
 *
 * The cross-section is carried along without twisting (parallel transport: at every corner it is
 * turned by the smallest rotation that takes one segment direction into the next). The ring of a
 * corner lies in the plane bisecting the two segments and is stretched within it (a mitre), so that
 * each straight piece is an exact prism of the given radius. A closed tube that does not come back
 * to its starting orientation (a non-planar loop) spreads the leftover twist evenly over its rings.
 *
 * Repeated points are dropped. Throws if fewer than two distinct points remain or the path folds
 * back onto itself.
 */
export function createTube(points: readonly Vec3[], options: TubeOptions = {}): PolyMesh {
  const { segments = 12, closed = false, caps = true } = options;
  if (options.radii && options.radii.length !== points.length) {
    throw new Error(`radii must have one entry per point (${points.length}), got ${options.radii.length}`);
  }
  const radiusAt = (i: number) => options.radii?.[i] ?? options.radius;

  // Drop points that repeat their predecessor (and a last point repeating the first of a closed path).
  const path: Vec3[] = [];
  const radii: number[] = [];
  let scaleOfPath = 0;
  for (const p of points) for (const v of p) scaleOfPath = Math.max(scaleOfPath, Math.abs(v));
  const same = (a: Vec3, b: Vec3) => Math.hypot(...sub(a, b)) <= 1e-9 * Math.max(1, scaleOfPath);
  points.forEach((p, i) => {
    const r = radiusAt(i);
    if (r === undefined) throw new Error('Give a radius (or radii with one entry per point)');
    if (!(r > 0) || !Number.isFinite(r)) throw new Error(`The radius at point ${i} must be a positive number, got ${r}`);
    if (path.length && same(path[path.length - 1], p)) return;
    path.push(p);
    radii.push(r);
  });
  if (closed && path.length > 1 && same(path[0], path[path.length - 1])) {
    path.pop();
    radii.pop();
  }
  const count = path.length;
  if (count < 2) throw new Error('A tube needs at least 2 different points');
  if (closed && count < 3) throw new Error('A closed tube needs at least 3 different points');

  // Direction of the piece that starts at point i (the last one of a closed path leads back to point 0).
  const pieces = closed ? count : count - 1;
  const dirs: Vec3[] = [];
  for (let i = 0; i < pieces; i++) dirs.push(normalize(sub(path[(i + 1) % count], path[i])));

  // The pieces that meet in point i: `before` arrives, `after` leaves. The ends of an open path have only one.
  const before = (i: number) => (i > 0 ? dirs[i - 1] : closed ? dirs[pieces - 1] : dirs[0]);
  const after = (i: number) => (i < pieces ? dirs[i] : closed ? dirs[0] : dirs[pieces - 1]);

  // Reference direction of the cross-section, perpendicular to the piece arriving in point 0.
  const first = before(0);
  const helper: Vec3 = Math.abs(first[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const start = normalize(cross(helper, first));

  /** Carries a reference direction from the piece arriving in point i over to the piece leaving it. */
  const transport = (u: Vec3, i: number): Vec3 => {
    const [a, b] = [before(i), after(i)];
    const axis = cross(a, b);
    const sin = Math.hypot(...axis);
    if (sin < 1e-12) return u;
    return rotate(u, scale(axis, 1 / sin), dot(a, b), sin);
  };

  // For a closed path: by how much the reference has turned (about the last piece) after one round.
  let twist = 0;
  if (closed) {
    let u = start;
    for (let i = 0; i < count; i++) u = transport(u, i);
    twist = Math.atan2(dot(cross(start, u), first), dot(start, u));
  }

  const positions: number[] = [];
  let u = start;
  for (let i = 0; i < count; i++) {
    const [a, b] = [before(i), after(i)];
    // The bisecting plane of the corner; at the ends of an open path the plane perpendicular to the path.
    const m: Vec3 = [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
    const along = dot(a, m);
    if (along < 1e-4) throw new Error(`The path folds back onto itself at point ${i}; a tube cannot make a 180 degree turn in one point`);
    const turned = twist === 0 ? u : rotate(u, a, Math.cos((-twist * i) / count), Math.sin((-twist * i) / count));
    const v = cross(a, turned);
    for (let k = 0; k < segments; k++) {
      const angle = (k / segments) * Math.PI * 2;
      const [c, s] = [Math.cos(angle), Math.sin(angle)];
      // A point of the circle around the arriving piece, slid along that piece into the bisecting plane.
      const w: Vec3 = [turned[0] * c + v[0] * s, turned[1] * c + v[1] * s, turned[2] * c + v[2] * s];
      const slide = -dot(w, m) / along;
      for (let axis = 0; axis < 3; axis++) positions.push(path[i][axis] + radii[i] * (w[axis] + slide * a[axis]) + 0);
    }
    u = transport(u, i);
  }

  const faces: number[][] = [];
  const at = (ring: number, k: number) => (ring % count) * segments + (k % segments);
  for (let i = 0; i < pieces; i++) {
    for (let k = 0; k < segments; k++) faces.push([at(i, k), at(i, k + 1), at(i + 1, k + 1), at(i + 1, k)]);
  }
  if (!closed && caps) {
    faces.push(Array.from({ length: segments }, (_, k) => at(0, segments - 1 - k)));
    faces.push(Array.from({ length: segments }, (_, k) => at(count - 1, k)));
  }
  return { positions, faces };
}
