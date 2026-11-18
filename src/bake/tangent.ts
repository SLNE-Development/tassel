// The tangent frame of a normal map, exactly as the viewport builds it. DOM-free.
//
// The viewport renders with three.js node materials and geometries WITHOUT a tangent attribute, so
// three derives the frame per fragment from screen-space derivatives (nodes/accessors/TangentUtils.js,
// "Normal Mapping Without Precomputed Tangents"):
//
//   q0 = dFdx(P), q1 = dFdy(P), st0 = dFdx(uv), st1 = dFdy(uv), N = interpolated unit normal
//   T' = (q1 x N) * st0.x + (N x q0) * st1.x
//   B' = (q1 x N) * st0.y + (N x q0) * st1.y
//   s  = 1 / sqrt(max(T'.T', B'.B'))          (one common scale: T and B are NOT normalised separately)
//   n  = normalize(T' s * m.x + B' s * m.y + N * m.z),   m = texel * 2 - 1   (green is used as it is)
//
// On a triangle P is an affine function of uv with the gradients Pu = dP/du and Pv = dP/dv, so
// q0 = Pu st0.x + Pv st0.y and q1 = Pu st1.x + Pv st1.y. Substituting gives, for any view,
//
//   T' = D (Pv x N),   B' = D (N x Pu),   D = st0.x st1.y - st0.y st1.x
//
// D only matters by its sign (the scale s removes its size): for a front face it is positive when the
// UVs run counter-clockwise where the triangle does, negative for mirrored UVs. So with
// sigma = sign of the UV triangle's area (given triangles that wind counter-clockwise seen from the front):
//
//   T = s sigma (Pv x N),   B = s sigma (N x Pu)
//
// T points along +u, B along +v (v up: OpenGL / glTF convention, green = +v), both perpendicular to N.

export interface Frame {
  /** Tangent (along +u), bitangent (along +v) and normal as x, y, z triples. */
  t: [number, number, number];
  b: [number, number, number];
  n: [number, number, number];
}

/**
 * Position gradients of a triangle over its UVs: [Pu.x, Pu.y, Pu.z, Pv.x, Pv.y, Pv.z, sigma] written
 * to `out`, where sigma is +1 or -1 (mirrored UVs). Returns false if the UV triangle has no area.
 * `p` holds 9 position floats from `po`, `uv` 6 floats from `uo`.
 */
export function uvGradients(p: ArrayLike<number>, po: number, uv: ArrayLike<number>, uo: number, out: Float64Array): boolean {
  const du1 = uv[uo + 2] - uv[uo];
  const dv1 = uv[uo + 3] - uv[uo + 1];
  const du2 = uv[uo + 4] - uv[uo];
  const dv2 = uv[uo + 5] - uv[uo + 1];
  const det = du1 * dv2 - du2 * dv1;
  if (!(Math.abs(det) > 1e-20)) return false;
  const inv = 1 / det;
  for (let a = 0; a < 3; a++) {
    const e1 = p[po + 3 + a] - p[po + a];
    const e2 = p[po + 6 + a] - p[po + a];
    out[a] = (e1 * dv2 - e2 * dv1) * inv;
    out[3 + a] = (e2 * du1 - e1 * du2) * inv;
  }
  out[6] = det > 0 ? 1 : -1;
  return true;
}

/**
 * The frame three.js uses at a point of a triangle with the gradients `g` (from `uvGradients`) and the
 * unit shading normal (nx, ny, nz). Writes T (0..2) and B (3..5) to `out`; false if there is no frame.
 */
export function tangentFrame(g: Float64Array, nx: number, ny: number, nz: number, out: Float64Array): boolean {
  const sigma = g[6];
  // T' = sigma (Pv x N)
  const tx = sigma * (g[4] * nz - g[5] * ny);
  const ty = sigma * (g[5] * nx - g[3] * nz);
  const tz = sigma * (g[3] * ny - g[4] * nx);
  // B' = sigma (N x Pu)
  const bx = sigma * (ny * g[2] - nz * g[1]);
  const by = sigma * (nz * g[0] - nx * g[2]);
  const bz = sigma * (nx * g[1] - ny * g[0]);
  const m = Math.max(tx * tx + ty * ty + tz * tz, bx * bx + by * by + bz * bz);
  if (!(m > 1e-30)) return false;
  const s = 1 / Math.sqrt(m);
  out[0] = tx * s;
  out[1] = ty * s;
  out[2] = tz * s;
  out[3] = bx * s;
  out[4] = by * s;
  out[5] = bz * s;
  return true;
}

/**
 * The tangent-space vector m (unit length, written to `out`) that three.js turns back into the world
 * normal (wx, wy, wz): T m.x + B m.y + N m.z is parallel to it. `frame` is from `tangentFrame`, N the
 * same unit normal. T and B need not be orthogonal or of equal length, so this solves in the plane
 * instead of taking dot products. False if T and B do not span the plane.
 */
export function toTangentSpace(
  frame: Float64Array,
  nx: number,
  ny: number,
  nz: number,
  wx: number,
  wy: number,
  wz: number,
  out: Float64Array,
): boolean {
  const g11 = frame[0] * frame[0] + frame[1] * frame[1] + frame[2] * frame[2];
  const g12 = frame[0] * frame[3] + frame[1] * frame[4] + frame[2] * frame[5];
  const g22 = frame[3] * frame[3] + frame[4] * frame[4] + frame[5] * frame[5];
  const det = g11 * g22 - g12 * g12;
  if (!(det > 1e-12 * g11 * g22)) return false;
  const r1 = frame[0] * wx + frame[1] * wy + frame[2] * wz;
  const r2 = frame[3] * wx + frame[4] * wy + frame[5] * wz;
  const a = (g22 * r1 - g12 * r2) / det;
  const b = (g11 * r2 - g12 * r1) / det;
  const c = nx * wx + ny * wy + nz * wz;
  const len = Math.hypot(a, b, c);
  if (!(len > 0)) return false;
  out[0] = a / len;
  out[1] = b / len;
  out[2] = c / len;
  return true;
}

/** A unit-vector component as a normal map channel: -1..1 → 0..255. */
export function toByte(component: number): number {
  return Math.min(255, Math.max(0, Math.round((component * 0.5 + 0.5) * 255)));
}

/** The flat normal (0, 0, 1) as a texel. */
export const FLAT_NORMAL = [128, 128, 255] as const;
