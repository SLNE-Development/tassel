// The baking loop: plain typed arrays in, pixels out. DOM-free, so it runs in a worker and in tests.
import { Bvh } from './bvh';
import { dilate } from './dilate';
import { rasterizeTriangle } from './raster';
import { cosineDirection, hammersley, hash32 } from './sampling';
import { FLAT_NORMAL, tangentFrame, toByte, toTangentSpace, uvGradients } from './tangent';

/** Texels the charts are extended by into empty space. */
export const DILATION = 8;

/** World-space triangles: 9 position and 9 normal floats per triangle, winding counter-clockwise from the front. */
export interface Soup {
  positions: Float32Array;
  normals: Float32Array;
}

interface JobBase {
  /** Width and height of the texture in pixels. */
  size: number;
  /** The object that gets the texture, with 6 UV floats per triangle (v up). */
  target: Soup & { uvs: Float32Array };
  /** What the rays are cast against. */
  scene: Soup;
}

export interface NormalJob extends JobBase {
  type: 'normal';
  /** `target.normals` must be SMOOTH normals; `scene` holds the sources with their shading normals. */
  maxDistance: number;
}

export interface AoJob extends JobBase {
  type: 'ao';
  /** `target.normals` are the target's shading normals; `scene` is everything that occludes (target included). */
  samples: number;
  distance: number;
  /** How far ray origins are lifted off the surface. */
  bias: number;
}

export type BakeJob = NormalJob | AoJob;

export interface BakeResult {
  /** RGBA, row 0 at the TOP (v = 1), as image files have it. */
  pixels: Uint8ClampedArray<ArrayBuffer>;
  /** Texels inside the target's UV triangles. */
  covered: number;
  /** Normal: covered texels that found a source. AO: the same as `covered`. */
  hits: number;
}

/** Every `count`-th row of the image, starting with row `index`: the share of one worker. */
export interface Band {
  index: number;
  count: number;
}

/** The rows of one band, packed: row r of the band is image row `index + r * count`. */
export interface BandResult {
  /** RGBA per texel; texels outside the charts hold the background (flat normal or white). */
  pixels: Uint8ClampedArray<ArrayBuffer>;
  /** One byte per texel: 1 inside the target's UV triangles. */
  mask: Uint8Array<ArrayBuffer>;
  covered: number;
  hits: number;
}

/**
 * Computes the texels of one band of rows. Bands are independent of each other, so several workers
 * can share a bake; together they give exactly what one band of all rows gives. `onProgress` gets 0..1
 * a few times per second.
 */
export function bakeBand(job: BakeJob, band: Band, onProgress?: (fraction: number) => void): BandResult {
  const { size, target } = job;
  const triangles = Math.floor(target.positions.length / 9);
  const rows = Math.ceil((size - band.index) / band.count);
  const pixels = new Uint8ClampedArray(rows * size * 4);
  const background = job.type === 'normal' ? FLAT_NORMAL : ([255, 255, 255] as const);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = background[0];
    pixels[i + 1] = background[1];
    pixels[i + 2] = background[2];
    pixels[i + 3] = 255;
  }
  const mask = new Uint8Array(rows * size);
  const bvh = new Bvh(job.scene.positions);
  const shade = job.type === 'normal' ? normalShader(job, bvh) : aoShader(job, bvh);

  // Progress counts texels against the number the UV area promises (overlaps make that an estimate).
  const uv = target.uvs;
  let area = 0;
  for (let o = 0; o < triangles * 6; o += 6) {
    area += Math.abs((uv[o + 2] - uv[o]) * (uv[o + 5] - uv[o + 1]) - (uv[o + 4] - uv[o]) * (uv[o + 3] - uv[o + 1])) / 2;
  }
  const expected = Math.max(1, (area * size * size) / band.count);
  let lastReport = Date.now();

  let covered = 0;
  let hits = 0;
  const out = new Uint8Array(3);
  for (let t = 0; t < triangles; t++) {
    const o = t * 6;
    if (shade.begin(t)) {
      rasterizeTriangle(uv[o], uv[o + 1], uv[o + 2], uv[o + 3], uv[o + 4], uv[o + 5], size, (x, y, b0, b1, b2) => {
        // Image rows count from the top.
        const row = size - 1 - y;
        if (row % band.count !== band.index) return;
        const index = ((row - band.index) / band.count) * size + x;
        // Where UV triangles overlap, the first one keeps the texel.
        if (mask[index]) return;
        mask[index] = 1;
        covered++;
        if (onProgress && (covered & 255) === 0 && Date.now() - lastReport > 80) {
          lastReport = Date.now();
          onProgress(Math.min(1, covered / expected));
        }
        if (shade.texel(b0, b1, b2, row * size + x, out)) hits++;
        pixels[index * 4] = out[0];
        pixels[index * 4 + 1] = out[1];
        pixels[index * 4 + 2] = out[2];
      });
    }
  }
  onProgress?.(1);
  return { pixels, mask, covered, hits };
}

/** Puts the bands of a bake (in the order of their index) together to the whole image and its chart mask. */
export function assemble(size: number, bands: readonly BandResult[]): { pixels: Uint8ClampedArray<ArrayBuffer>; mask: Uint8Array<ArrayBuffer> } {
  const pixels = new Uint8ClampedArray(size * size * 4);
  const mask = new Uint8Array(size * size);
  bands.forEach((band, index) => {
    for (let r = 0, row = index; row < size; r++, row += bands.length) {
      pixels.set(band.pixels.subarray(r * size * 4, (r + 1) * size * 4), row * size * 4);
      mask.set(band.mask.subarray(r * size, (r + 1) * size), row * size);
    }
  });
  return { pixels, mask };
}

/**
 * Bakes a whole job in one go: all texels, then the dilation. Texels no chart reaches (after the
 * dilation) hold the flat normal (128, 128, 255) or white.
 */
export function runBake(job: BakeJob, onProgress?: (fraction: number) => void): BakeResult {
  const band = bakeBand(job, { index: 0, count: 1 }, onProgress);
  dilate(band.pixels, band.mask, job.size, DILATION);
  return { pixels: band.pixels, covered: band.covered, hits: band.hits };
}

interface Shader {
  /** Prepares a target triangle; false skips it. */
  begin(triangle: number): boolean;
  /** Computes the texel (`index` = its number in the image) at the barycentric point of the current triangle into `out` (r, g, b). Returns whether it counts as a hit. */
  texel(b0: number, b1: number, b2: number, index: number, out: Uint8Array): boolean;
}

function normalShader(job: NormalJob, bvh: Bvh): Shader {
  const { positions: p, normals: n, uvs } = job.target;
  const sourceNormals = job.scene.normals;
  const sourcePositions = job.scene.positions;
  const maxDistance = job.maxDistance;
  // A source lying exactly on the target must be found by one of the two rays.
  const tMin = -1e-7 * maxDistance;
  // Far enough to leave the surface a ray starts on.
  const skip = 1e-5 * maxDistance;
  const gradients = new Float64Array(7);
  const frame = new Float64Array(6);
  const m = new Float64Array(3);
  let o = 0;
  let hasFrame = false;
  return {
    begin(triangle) {
      o = triangle * 9;
      hasFrame = uvGradients(p, o, uvs, triangle * 6, gradients);
      return true;
    },
    texel(b0, b1, b2, _index, out) {
      out[0] = FLAT_NORMAL[0];
      out[1] = FLAT_NORMAL[1];
      out[2] = FLAT_NORMAL[2];
      let nx = n[o] * b0 + n[o + 3] * b1 + n[o + 6] * b2;
      let ny = n[o + 1] * b0 + n[o + 4] * b1 + n[o + 7] * b2;
      let nz = n[o + 2] * b0 + n[o + 5] * b1 + n[o + 8] * b2;
      const length = Math.hypot(nx, ny, nz);
      if (!(length > 1e-12)) return false;
      nx /= length;
      ny /= length;
      nz /= length;
      const px = p[o] * b0 + p[o + 3] * b1 + p[o + 6] * b2;
      const py = p[o + 1] * b0 + p[o + 4] * b1 + p[o + 7] * b2;
      const pz = p[o + 2] * b0 + p[o + 5] * b1 + p[o + 8] * b2;

      // Outwards and inwards; of the two nearest surfaces that face the way the target does, the closer one.
      let triangle = -1;
      /** Where the hit is along the normal: positive outside the target, negative inside. */
      let signed = Infinity;
      let u = 0;
      let v = 0;
      if (bvh.closest(px, py, pz, nx, ny, nz, tMin, maxDistance, true, nx, ny, nz)) {
        triangle = bvh.hitTriangle;
        signed = bvh.hitT;
        u = bvh.hitU;
        v = bvh.hitV;
      }
      if (bvh.closest(px, py, pz, -nx, -ny, -nz, tMin, maxDistance, true, nx, ny, nz) && Math.abs(bvh.hitT) < Math.abs(signed)) {
        triangle = bvh.hitTriangle;
        signed = -bvh.hitT;
        u = bvh.hitU;
        v = bvh.hitV;
      }
      if (triangle === -1) return false;

      // Sources may run through each other (a bump pushed into a body): a surface inside another
      // source is not what one sees. Going outwards from the hit, leaving a solid first (through a
      // surface facing outwards) means the hit was buried, and that outer surface takes its place.
      // Meeting a surface from behind, or nothing, means the hit is the visible one.
      let along = signed;
      for (let step = 0; step < 16; step++) {
        if (!bvh.closest(px + nx * along, py + ny * along, pz + nz * along, nx, ny, nz, skip, maxDistance - along)) break;
        const g = bvh.hitTriangle * 9;
        const e1x = sourcePositions[g + 3] - sourcePositions[g];
        const e1y = sourcePositions[g + 4] - sourcePositions[g + 1];
        const e1z = sourcePositions[g + 5] - sourcePositions[g + 2];
        const e2x = sourcePositions[g + 6] - sourcePositions[g];
        const e2y = sourcePositions[g + 7] - sourcePositions[g + 1];
        const e2z = sourcePositions[g + 8] - sourcePositions[g + 2];
        if (!((e1y * e2z - e1z * e2y) * nx + (e1z * e2x - e1x * e2z) * ny + (e1x * e2y - e1y * e2x) * nz > 0)) break;
        along += bvh.hitT;
        triangle = bvh.hitTriangle;
        u = bvh.hitU;
        v = bvh.hitV;
      }

      // The source's shading normal at the hit.
      const s = triangle * 9;
      const w = 1 - u - v;
      const sx = sourceNormals[s] * w + sourceNormals[s + 3] * u + sourceNormals[s + 6] * v;
      const sy = sourceNormals[s + 1] * w + sourceNormals[s + 4] * u + sourceNormals[s + 7] * v;
      const sz = sourceNormals[s + 2] * w + sourceNormals[s + 5] * u + sourceNormals[s + 8] * v;
      // A hit without a usable frame still counts as covered by the source; it just stays flat.
      if (hasFrame && tangentFrame(gradients, nx, ny, nz, frame) && toTangentSpace(frame, nx, ny, nz, sx, sy, sz, m)) {
        out[0] = toByte(m[0]);
        out[1] = toByte(m[1]);
        out[2] = toByte(m[2]);
      }
      return true;
    },
  };
}

function aoShader(job: AoJob, bvh: Bvh): Shader {
  const { positions: p, normals: n } = job.target;
  const { samples, distance, bias } = job;
  const points = hammersley(samples);
  const local = new Float64Array(3);
  let o = 0;
  // Geometric normal of the current triangle.
  let gx = 0;
  let gy = 0;
  let gz = 0;
  return {
    begin(triangle) {
      o = triangle * 9;
      const e1x = p[o + 3] - p[o];
      const e1y = p[o + 4] - p[o + 1];
      const e1z = p[o + 5] - p[o + 2];
      const e2x = p[o + 6] - p[o];
      const e2y = p[o + 7] - p[o + 1];
      const e2z = p[o + 8] - p[o + 2];
      gx = e1y * e2z - e1z * e2y;
      gy = e1z * e2x - e1x * e2z;
      gz = e1x * e2y - e1y * e2x;
      const length = Math.hypot(gx, gy, gz);
      if (!(length > 0)) return false;
      gx /= length;
      gy /= length;
      gz /= length;
      return true;
    },
    texel(b0, b1, b2, index, out) {
      // The hemisphere stands on the shading normal, so smooth objects get smooth occlusion.
      let nx = n[o] * b0 + n[o + 3] * b1 + n[o + 6] * b2;
      let ny = n[o + 1] * b0 + n[o + 4] * b1 + n[o + 7] * b2;
      let nz = n[o + 2] * b0 + n[o + 5] * b1 + n[o + 8] * b2;
      const length = Math.hypot(nx, ny, nz);
      if (length > 1e-12 && nx * gx + ny * gy + nz * gz > 0) {
        nx /= length;
        ny /= length;
        nz /= length;
      } else {
        nx = gx;
        ny = gy;
        nz = gz;
      }
      // Any two unit vectors perpendicular to the normal.
      let tx: number;
      let ty: number;
      let tz: number;
      if (Math.abs(nx) > 0.9) {
        // normal x (0, 1, 0)
        tx = -nz;
        ty = 0;
        tz = nx;
      } else {
        // normal x (1, 0, 0)
        tx = 0;
        ty = nz;
        tz = -ny;
      }
      const tl = Math.hypot(tx, ty, tz);
      tx /= tl;
      ty /= tl;
      tz /= tl;
      const bx = ny * tz - nz * ty;
      const by = nz * tx - nx * tz;
      const bz = nx * ty - ny * tx;

      const px = p[o] * b0 + p[o + 3] * b1 + p[o + 6] * b2 + gx * bias;
      const py = p[o + 1] * b0 + p[o + 4] * b1 + p[o + 7] * b2 + gy * bias;
      const pz = p[o + 2] * b0 + p[o + 5] * b1 + p[o + 8] * b2 + gz * bias;

      // The same well-spread sample set for every texel, shifted by a per-texel offset (Cranley–Patterson).
      const h = hash32(index);
      const shift1 = h / 4294967296;
      const shift2 = hash32(h) / 4294967296;
      let counted = 0;
      let occluded = 0;
      for (let i = 0; i < samples; i++) {
        let u1 = points[i * 2] + shift1;
        let u2 = points[i * 2 + 1] + shift2;
        if (u1 >= 1) u1 -= 1;
        if (u2 >= 1) u2 -= 1;
        cosineDirection(u1, u2, local);
        const dx = tx * local[0] + bx * local[1] + nx * local[2];
        const dy = ty * local[0] + by * local[1] + ny * local[2];
        const dz = tz * local[0] + bz * local[1] + nz * local[2];
        // Directions below the actual triangle would only hit the triangle's own neighbourhood
        // (the facets of a smooth low-poly object); they are left out instead of counted as dark.
        if (!(dx * gx + dy * gy + dz * gz > 1e-4)) continue;
        counted++;
        if (bvh.occluded(px, py, pz, dx, dy, dz, 0, distance)) occluded++;
      }
      const open = counted > 0 ? 1 - occluded / counted : 1;
      out[0] = out[1] = out[2] = Math.round(open * 255);
      return true;
    },
  };
}
