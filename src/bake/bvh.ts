// A bounding volume hierarchy over a triangle soup, for the two ray queries baking needs. DOM-free.

const LEAF_SIZE = 4;
const BINS = 12;
/** Stands in for 1 / 0 in the box test: unlike Infinity it never produces NaN (0 * Infinity). */
const HUGE = 1e300;

const surface = (b: Float64Array, o: number) => {
  const x = b[o + 3] - b[o];
  const y = b[o + 4] - b[o + 1];
  const z = b[o + 5] - b[o + 2];
  return x * y + y * z + z * x;
};

function clearBox(b: Float64Array, o: number): void {
  b[o] = b[o + 1] = b[o + 2] = Infinity;
  b[o + 3] = b[o + 4] = b[o + 5] = -Infinity;
}

function growBox(b: Float64Array, o: number, from: Float64Array, f: number): void {
  for (let a = 0; a < 3; a++) {
    if (from[f + a] < b[o + a]) b[o + a] = from[f + a];
    if (from[f + 3 + a] > b[o + 3 + a]) b[o + 3 + a] = from[f + 3 + a];
  }
}

/**
 * Ray queries against triangles (9 position floats each). Hits are two-sided; a triangle's "front" is
 * the side it winds counter-clockwise from. Rays need not be normalised: distances are in units of the
 * direction's length.
 */
export class Bvh {
  readonly triangles: number;
  /** Per node: min x, y, z, max x, y, z. */
  private readonly bounds: Float64Array;
  /** Per node: the two children, or -1 for a leaf. */
  private readonly left: Int32Array;
  private readonly right: Int32Array;
  /** Per leaf: first triangle slot and number of triangles. */
  private readonly first: Int32Array;
  private readonly count: Int32Array;
  /** Per node: the axis its children are split along (left = lower). */
  private readonly axis: Uint8Array;
  /** Per triangle slot (leaf order): corner 0, edge 0→1, edge 0→2. */
  private readonly data: Float64Array;
  /** Per triangle slot: the triangle's index in the soup. */
  private readonly source: Uint32Array;
  private readonly stack: Int32Array;

  /** Distance along the ray of the last `closest` hit. */
  hitT = 0;
  /** Triangle index (into the soup) of the last `closest` hit. */
  hitTriangle = -1;
  /** Barycentric weights of corners 1 and 2 at the last `closest` hit. */
  hitU = 0;
  hitV = 0;

  constructor(positions: ArrayLike<number>) {
    const n = Math.floor(positions.length / 9);
    this.triangles = n;
    const order = new Uint32Array(n);
    const centroids = new Float64Array(n * 3);
    const boxes = new Float64Array(n * 6);
    for (let t = 0; t < n; t++) {
      order[t] = t;
      for (let a = 0; a < 3; a++) {
        const p0 = positions[t * 9 + a];
        const p1 = positions[t * 9 + 3 + a];
        const p2 = positions[t * 9 + 6 + a];
        boxes[t * 6 + a] = Math.min(p0, p1, p2);
        boxes[t * 6 + 3 + a] = Math.max(p0, p1, p2);
        centroids[t * 3 + a] = (boxes[t * 6 + a] + boxes[t * 6 + 3 + a]) / 2;
      }
    }

    const maxNodes = Math.max(1, 2 * n);
    const bounds = new Float64Array(maxNodes * 6);
    const left = new Int32Array(maxNodes).fill(-1);
    const right = new Int32Array(maxNodes).fill(-1);
    const first = new Int32Array(maxNodes);
    const count = new Int32Array(maxNodes);
    const axisOf = new Uint8Array(maxNodes);
    let nodes = 0;
    let maxDepth = 0;

    // Nodes still to be split, as [node, start, end, depth].
    const todo: number[] = [];
    const open = (start: number, end: number, depth: number): number => {
      const node = nodes++;
      clearBox(bounds, node * 6);
      for (let i = start; i < end; i++) growBox(bounds, node * 6, boxes, order[i] * 6);
      first[node] = start;
      count[node] = end - start;
      if (depth > maxDepth) maxDepth = depth;
      if (end - start > LEAF_SIZE) todo.push(node, start, end, depth);
      return node;
    };
    clearBox(bounds, 0);
    if (n > 0) open(0, n, 0);
    else nodes = 1; // an empty leaf

    const binCount = new Int32Array(BINS);
    const binBox = new Float64Array(BINS * 6);
    const rightCount = new Int32Array(BINS);
    const rightArea = new Float64Array(BINS);
    const sweep = new Float64Array(6);

    while (todo.length > 0) {
      const depth = todo.pop()!;
      const end = todo.pop()!;
      const start = todo.pop()!;
      const node = todo.pop()!;

      // Split along the axis on which the centroids spread most, at the cheapest of the bin borders
      // (surface area heuristic).
      let axis = 0;
      let lo = 0;
      let extent = -1;
      for (let a = 0; a < 3; a++) {
        let min = Infinity;
        let max = -Infinity;
        for (let i = start; i < end; i++) {
          const c = centroids[order[i] * 3 + a];
          if (c < min) min = c;
          if (c > max) max = c;
        }
        if (max - min > extent) {
          extent = max - min;
          axis = a;
          lo = min;
        }
      }
      let mid = -1;
      if (extent > 0) {
        const scale = BINS / extent;
        const binOf = (t: number) => Math.min(BINS - 1, Math.floor((centroids[t * 3 + axis] - lo) * scale));
        binCount.fill(0);
        for (let b = 0; b < BINS; b++) clearBox(binBox, b * 6);
        for (let i = start; i < end; i++) {
          const b = binOf(order[i]);
          binCount[b]++;
          growBox(binBox, b * 6, boxes, order[i] * 6);
        }
        clearBox(sweep, 0);
        let total = 0;
        for (let b = BINS - 1; b > 0; b--) {
          if (binCount[b] > 0) growBox(sweep, 0, binBox, b * 6);
          total += binCount[b];
          rightCount[b] = total;
          rightArea[b] = total > 0 ? surface(sweep, 0) : 0;
        }
        clearBox(sweep, 0);
        total = 0;
        let best = Infinity;
        let bestBin = -1;
        for (let b = 0; b < BINS - 1; b++) {
          if (binCount[b] > 0) growBox(sweep, 0, binBox, b * 6);
          total += binCount[b];
          if (total === 0 || rightCount[b + 1] === 0) continue;
          const cost = total * surface(sweep, 0) + rightCount[b + 1] * rightArea[b + 1];
          if (cost < best) {
            best = cost;
            bestBin = b;
          }
        }
        if (bestBin >= 0) {
          let i = start;
          let j = end - 1;
          while (i <= j) {
            if (binOf(order[i]) <= bestBin) i++;
            else {
              const swap = order[i];
              order[i] = order[j];
              order[j--] = swap;
            }
          }
          mid = i;
        }
      }
      // All centroids in one place: halve the list as it is.
      if (mid <= start || mid >= end) mid = (start + end) >> 1;

      count[node] = 0;
      axisOf[node] = axis;
      left[node] = open(start, mid, depth + 1);
      right[node] = open(mid, end, depth + 1);
    }

    this.bounds = bounds;
    this.left = left;
    this.right = right;
    this.first = first;
    this.count = count;
    this.axis = axisOf;
    this.source = order;
    this.stack = new Int32Array(maxDepth + 2);
    this.data = new Float64Array(n * 9);
    for (let slot = 0; slot < n; slot++) {
      const t = order[slot] * 9;
      for (let a = 0; a < 3; a++) {
        this.data[slot * 9 + a] = positions[t + a];
        this.data[slot * 9 + 3 + a] = positions[t + 3 + a] - positions[t + a];
        this.data[slot * 9 + 6 + a] = positions[t + 6 + a] - positions[t + a];
      }
    }
  }

  /**
   * The nearest hit of the ray origin + t * direction with tMin <= t <= tMax. With `facing`, only
   * triangles whose front looks along (fx, fy, fz) count (geometric normal · f > 0). Returns whether
   * there is one; the hit is in `hitT`, `hitTriangle`, `hitU`, `hitV`.
   */
  closest(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    tMin: number,
    tMax: number,
    facing = false,
    fx = 0,
    fy = 0,
    fz = 0,
  ): boolean {
    return this.cast(ox, oy, oz, dx, dy, dz, tMin, tMax, false, facing, fx, fy, fz);
  }

  /** Whether anything is hit with tMin <= t <= tMax. Faster than `closest`: stops at the first hit. */
  occluded(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tMin: number, tMax: number): boolean {
    return this.cast(ox, oy, oz, dx, dy, dz, tMin, tMax, true, false, 0, 0, 0);
  }

  private cast(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    tMin: number,
    tMax: number,
    any: boolean,
    facing: boolean,
    fx: number,
    fy: number,
    fz: number,
  ): boolean {
    const { bounds, left, right, first, count, axis, data, stack } = this;
    const ix = dx !== 0 ? 1 / dx : HUGE;
    const iy = dy !== 0 ? 1 / dy : HUGE;
    const iz = dz !== 0 ? 1 / dz : HUGE;
    // Per axis: whether the ray runs towards lower coordinates.
    const negative = (dx < 0 ? 1 : 0) | (dy < 0 ? 2 : 0) | (dz < 0 ? 4 : 0);
    let best = tMax;
    let found = false;
    let sp = 0;
    stack[sp++] = 0;
    while (sp > 0) {
      const node = stack[--sp];
      const o = node * 6;
      // Slab test against the current range tMin..best.
      let t0 = (bounds[o] - ox) * ix;
      let t1 = (bounds[o + 3] - ox) * ix;
      let near = t0 < t1 ? t0 : t1;
      let far = t0 < t1 ? t1 : t0;
      t0 = (bounds[o + 1] - oy) * iy;
      t1 = (bounds[o + 4] - oy) * iy;
      if (t0 < t1) {
        if (t0 > near) near = t0;
        if (t1 < far) far = t1;
      } else {
        if (t1 > near) near = t1;
        if (t0 < far) far = t0;
      }
      t0 = (bounds[o + 2] - oz) * iz;
      t1 = (bounds[o + 5] - oz) * iz;
      if (t0 < t1) {
        if (t0 > near) near = t0;
        if (t1 < far) far = t1;
      } else {
        if (t1 > near) near = t1;
        if (t0 < far) far = t0;
      }
      // `!(…)` also rejects the NaNs of an empty box.
      if (!(near <= far && far >= tMin && near <= best)) continue;

      const n = count[node];
      if (n === 0) {
        // The child the ray enters first is looked at first, so `best` shrinks early.
        if (negative & (1 << axis[node])) {
          stack[sp++] = left[node];
          stack[sp++] = right[node];
        } else {
          stack[sp++] = right[node];
          stack[sp++] = left[node];
        }
        continue;
      }
      for (let slot = first[node], end = slot + n; slot < end; slot++) {
        // Möller–Trumbore.
        const d = slot * 9;
        const e1x = data[d + 3];
        const e1y = data[d + 4];
        const e1z = data[d + 5];
        const e2x = data[d + 6];
        const e2y = data[d + 7];
        const e2z = data[d + 8];
        const px = dy * e2z - dz * e2y;
        const py = dz * e2x - dx * e2z;
        const pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (det === 0) continue;
        const inv = 1 / det;
        const sx = ox - data[d];
        const sy = oy - data[d + 1];
        const sz = oz - data[d + 2];
        const u = (sx * px + sy * py + sz * pz) * inv;
        if (!(u >= 0 && u <= 1)) continue;
        const qx = sy * e1z - sz * e1y;
        const qy = sz * e1x - sx * e1z;
        const qz = sx * e1y - sy * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv;
        if (!(v >= 0 && u + v <= 1)) continue;
        const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (!(t >= tMin && t <= best)) continue;
        if (any) return true;
        if (facing) {
          const gx = e1y * e2z - e1z * e2y;
          const gy = e1z * e2x - e1x * e2z;
          const gz = e1x * e2y - e1y * e2x;
          if (!(gx * fx + gy * fy + gz * fz > 0)) continue;
        }
        best = t;
        found = true;
        this.hitT = t;
        this.hitTriangle = this.source[slot];
        this.hitU = u;
        this.hitV = v;
      }
    }
    return found;
  }
}
