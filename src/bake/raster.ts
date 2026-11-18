// Rasterising UV triangles into texels. DOM-free.

/** A texel centre counts as inside when its barycentric weights are above this (so shared edges leave no gaps). */
const EDGE_TOLERANCE = -1e-7;

/**
 * Calls `visit` for every texel of a `size` x `size` texture whose centre lies inside the UV triangle
 * (edges included). `x`, `y` are texel coordinates with y pointing UP like v (row 0 is v = 0); UVs
 * outside 0..1 wrap around, as a repeating texture does. `b0`..`b2` are the barycentric weights of the
 * texel centre. A centre exactly on an edge shared by two triangles is reported for both, and a
 * triangle larger than the texture reports the texels it wraps onto more than once.
 */
export function rasterizeTriangle(
  u0: number,
  v0: number,
  u1: number,
  v1: number,
  u2: number,
  v2: number,
  size: number,
  visit: (x: number, y: number, b0: number, b1: number, b2: number) => void,
): void {
  const x0 = u0 * size;
  const y0 = v0 * size;
  const x1 = u1 * size;
  const y1 = v1 * size;
  const x2 = u2 * size;
  const y2 = v2 * size;
  const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  if (!(Math.abs(area) > 1e-12)) return; // degenerate (or NaN)
  const inv = 1 / area;

  // Texel i covers i..i+1 and has its centre at i + 0.5.
  let firstX = Math.ceil(Math.min(x0, x1, x2) - 0.5);
  let firstY = Math.ceil(Math.min(y0, y1, y2) - 0.5);
  let lastX = Math.floor(Math.max(x0, x1, x2) - 0.5);
  let lastY = Math.floor(Math.max(y0, y1, y2) - 0.5);
  // A triangle spanning the texture many times over only wraps onto itself: look at its middle part.
  const limit = size * 8;
  if (lastX - firstX >= limit) {
    firstX = Math.round((x0 + x1 + x2) / 3 - limit / 2);
    lastX = firstX + limit - 1;
  }
  if (lastY - firstY >= limit) {
    firstY = Math.round((y0 + y1 + y2) / 3 - limit / 2);
    lastY = firstY + limit - 1;
  }

  for (let iy = firstY; iy <= lastY; iy++) {
    const cy = iy + 0.5;
    const ty = ((iy % size) + size) % size;
    for (let ix = firstX; ix <= lastX; ix++) {
      const cx = ix + 0.5;
      const b0 = ((x1 - cx) * (y2 - cy) - (x2 - cx) * (y1 - cy)) * inv;
      if (b0 < EDGE_TOLERANCE) continue;
      const b1 = ((x2 - cx) * (y0 - cy) - (x0 - cx) * (y2 - cy)) * inv;
      if (b1 < EDGE_TOLERANCE) continue;
      const b2 = 1 - b0 - b1;
      if (b2 < EDGE_TOLERANCE) continue;
      visit(((ix % size) + size) % size, ty, b0, b1, b2);
    }
  }
}

/**
 * Which triangle covers each texel: the index of the first triangle (6 UV floats each) whose area
 * contains the texel centre, or -1. Index = y * size + x with y up.
 */
export function coverageMap(uvs: ArrayLike<number>, size: number): Int32Array {
  const map = new Int32Array(size * size).fill(-1);
  for (let t = 0; t * 6 < uvs.length; t++) {
    const o = t * 6;
    rasterizeTriangle(uvs[o], uvs[o + 1], uvs[o + 2], uvs[o + 3], uvs[o + 4], uvs[o + 5], size, (x, y) => {
      if (map[y * size + x] === -1) map[y * size + x] = t;
    });
  }
  return map;
}
