// Sample sequences for ambient occlusion. DOM-free and deterministic.

/** Van der Corput radical inverse in base 2 of a 32-bit integer: 0..1 (exclusive). */
export function radicalInverse2(i: number): number {
  let bits = i >>> 0;
  bits = ((bits << 16) | (bits >>> 16)) >>> 0;
  bits = (((bits & 0x55555555) << 1) | ((bits & 0xaaaaaaaa) >>> 1)) >>> 0;
  bits = (((bits & 0x33333333) << 2) | ((bits & 0xcccccccc) >>> 2)) >>> 0;
  bits = (((bits & 0x0f0f0f0f) << 4) | ((bits & 0xf0f0f0f0) >>> 4)) >>> 0;
  bits = (((bits & 0x00ff00ff) << 8) | ((bits & 0xff00ff00) >>> 8)) >>> 0;
  return bits / 4294967296;
}

/** The Hammersley point set: `count` well-spread points in the unit square as [x0, y0, x1, y1, …]. */
export function hammersley(count: number): Float64Array {
  const points = new Float64Array(count * 2);
  for (let i = 0; i < count; i++) {
    points[i * 2] = (i + 0.5) / count;
    points[i * 2 + 1] = radicalInverse2(i);
  }
  return points;
}

/** Integer hash (lowbias32): a well-mixed 32-bit value for every input. */
export function hash32(value: number): number {
  let x = value >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/**
 * Cosine-weighted direction on the hemisphere around +z for a point (u1, u2) of the unit square:
 * directions near the pole are as much more likely as they count for diffuse light. Writes x, y, z.
 */
export function cosineDirection(u1: number, u2: number, out: Float64Array): void {
  const r = Math.sqrt(u1);
  const phi = 2 * Math.PI * u2;
  out[0] = r * Math.cos(phi);
  out[1] = r * Math.sin(phi);
  out[2] = Math.sqrt(Math.max(0, 1 - u1));
}
