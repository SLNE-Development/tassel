import { describe, expect, it } from 'vitest';
import { createPrimitive } from '../core/mesh/primitives';
import { emptyDocState } from '../core/state';
import type { DocState, PolyMesh, SceneObject, Transform } from '../core/types';
import { assemble, bakeBand, runBake, type BakeResult } from './bake';
import { Bvh } from './bvh';
import { dilate } from './dilate';
import { buildJob, defaultDistance, worldSoup } from './geometry';
import { coverageMap, rasterizeTriangle } from './raster';
import { cosineDirection, hammersley, hash32, radicalInverse2 } from './sampling';
import { tangentFrame, toByte, toTangentSpace, uvGradients } from './tangent';

type V3 = [number, number, number];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const normalize = (a: V3): V3 => scale(a, 1 / Math.hypot(...a));

/** A deterministic random number generator (mulberry32). */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const identity: Transform = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };

function docWith(objects: Record<string, Partial<SceneObject> & { mesh: PolyMesh }>): DocState {
  const full: Record<string, SceneObject> = {};
  for (const [id, o] of Object.entries(objects)) {
    full[id] = { id, name: id, visible: true, transform: identity, modifiers: [], smooth: false, groupId: null, materialId: null, ...o };
  }
  return { ...emptyDocState, objects: full, order: Object.keys(full) };
}

/** The plane primitive (facing +y) with u along +x and v along -z. */
const plane = (size = 2): PolyMesh => ({ ...createPrimitive('plane', { size }), uvs: [[0, 0, 1, 0, 1, 1, 0, 1]] });

/** The texel at (x, y) with y counted from the top, as [r, g, b]. */
const texel = (result: BakeResult, size: number, x: number, y: number) => [...result.pixels.subarray((y * size + x) * 4, (y * size + x) * 4 + 3)];

describe('rasterizeTriangle', () => {
  const collect = (uv: number[], size: number) => {
    const out: string[] = [];
    rasterizeTriangle(uv[0], uv[1], uv[2], uv[3], uv[4], uv[5], size, (x, y) => out.push(`${x},${y}`));
    return out.sort();
  };

  it('covers exactly the texels whose centre is inside, edges included', () => {
    // Lower left half of a 4 x 4 texture: centres (x + 0.5, y + 0.5) with x + y <= 3.
    const expected = ['0,0', '0,1', '0,2', '0,3', '1,0', '1,1', '1,2', '2,0', '2,1', '3,0'];
    expect(collect([0, 0, 1, 0, 0, 1], 4)).toEqual(expected);
    // The winding does not matter.
    expect(collect([0, 0, 0, 1, 1, 0], 4)).toEqual(expected);
    // The other half gets the diagonal as well: no texel on a shared edge is left out.
    expect(collect([1, 0, 1, 1, 0, 1], 4)).toEqual(['0,3', '1,2', '1,3', '2,1', '2,2', '2,3', '3,0', '3,1', '3,2', '3,3']);
  });

  it('reports the barycentric weights of the texel centre', () => {
    const seen: number[][] = [];
    rasterizeTriangle(0, 0, 1, 0, 0, 1, 4, (x, y, b0, b1, b2) => seen.push([x, y, b0, b1, b2]));
    expect(seen).toHaveLength(10);
    for (const [x, y, b0, b1, b2] of seen) {
      expect(b0 + b1 + b2).toBeCloseTo(1, 12);
      // Corner 1 is at u = 1, corner 2 at v = 1.
      expect(b1).toBeCloseTo((x + 0.5) / 4, 12);
      expect(b2).toBeCloseTo((y + 0.5) / 4, 12);
    }
  });

  it('ignores a triangle too small to contain a texel centre and degenerate ones', () => {
    expect(collect([0.3, 0.3, 0.32, 0.3, 0.3, 0.32], 4)).toEqual([]);
    expect(collect([0, 0, 0.5, 0.5, 1, 1], 4)).toEqual([]);
    expect(collect([0, 0, NaN, 0.5, 1, 1], 4)).toEqual([]);
  });

  it('wraps UVs outside 0..1 around', () => {
    const inside = collect([0, 0, 1, 0, 0, 1], 4);
    expect(collect([1, 0, 2, 0, 1, 1], 4)).toEqual(inside);
    expect(collect([-3, -2, -2, -2, -3, -1], 4)).toEqual(inside);
    // A seam triangle from u = 0.75 to 1.25 covers the last and the first column
    // (centres with x + y / 2 <= 5 in texels, x from 3).
    expect(collect([0.75, 0, 1.25, 0, 0.75, 1], 4)).toEqual(['0,0', '3,0', '3,1', '3,2']);
    // A triangle larger than the texture reaches every texel (some more than once), however large it is.
    expect(new Set(collect([-2, -2, 3, -2, 0, 4], 8)).size).toBe(64);
    expect(new Set(collect([-5000, -5000, 5000, -5000, 0, 8000], 8)).size).toBe(64);
  });

  it('coverageMap gives every texel of a quad to one of its two triangles', () => {
    const map = coverageMap([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], 8);
    expect([...map].filter((t) => t === 0)).toHaveLength(36); // the diagonal goes to the first triangle
    expect([...map].filter((t) => t === 1)).toHaveLength(28);
    expect(coverageMap([0, 0, 0.5, 0, 0, 0.5], 8).filter((t) => t === -1)).toHaveLength(64 - 10);
  });
});

describe('tangent frame', () => {
  // A unit quad in the XY plane facing +z; `uv` gives the UVs of its corners (0,0) (1,0) (1,1).
  const frameOf = (uv: number[], normal: V3 = [0, 0, 1], positions = [0, 0, 0, 1, 0, 0, 1, 1, 0]) => {
    const g = new Float64Array(7);
    const f = new Float64Array(6);
    expect(uvGradients(positions, 0, uv, 0, g)).toBe(true);
    expect(tangentFrame(g, normal[0], normal[1], normal[2], f)).toBe(true);
    return { g: [...g], t: [...f.subarray(0, 3)].map((v) => v + 0), b: [...f.subarray(3, 6)].map((v) => v + 0) };
  };

  it('is T = +u, B = +v on a unit quad', () => {
    const { g, t, b } = frameOf([0, 0, 1, 0, 1, 1]);
    expect(g).toEqual([1, 0, 0, 0, 1, 0, 1]);
    expect(t).toEqual([1, 0, 0]);
    expect(b).toEqual([0, 1, 0]);
  });

  it('follows mirrored and rotated UVs', () => {
    // u runs against x: T points along -x, B still along +y.
    const mirrored = frameOf([1, 0, 0, 0, 0, 1]);
    expect(mirrored.g[6]).toBe(-1);
    expect(mirrored.t).toEqual([-1, 0, 0]);
    expect(mirrored.b).toEqual([0, 1, 0]);
    // UVs turned by 90 degrees: u runs along +y, v along -x.
    const turned = frameOf([0, 0, 0, -1, 1, -1]);
    expect(turned.t).toEqual([0, 1, 0]);
    expect(turned.b).toEqual([-1, 0, 0]);
  });

  it('scales T and B by one common factor, like three.js', () => {
    // u covers the quad in 0..0.5: dP/du is twice as long as dP/dv.
    const { g, t, b } = frameOf([0, 0, 0.5, 0, 0.5, 1]);
    expect(g.slice(0, 6)).toEqual([2, 0, 0, 0, 1, 0]);
    // T' = Pv x N = (1, 0, 0), B' = N x Pu = (0, 2, 0), both divided by the longer one.
    expect(t).toEqual([0.5, 0, 0]);
    expect(b).toEqual([0, 1, 0]);
  });

  it('has no gradients for UVs without area', () => {
    expect(uvGradients([0, 0, 0, 1, 0, 0, 1, 1, 0], 0, [0, 0, 0.5, 0.5, 1, 1], 0, new Float64Array(7))).toBe(false);
  });

  /**
   * three.js' frame, literally as in nodes/accessors/TangentUtils.js, from screen-space derivatives:
   * q0/q1 = dFdx/dFdy of the position, st0/st1 = dFdx/dFdy of the UV.
   */
  const threeFrame = (q0: V3, q1: V3, st0: [number, number], st1: [number, number], n: V3) => {
    const q1perp = cross(q1, n);
    const q0perp = cross(n, q0);
    const t = add(scale(q1perp, st0[0]), scale(q0perp, st1[0]));
    const b = add(scale(q1perp, st0[1]), scale(q0perp, st1[1]));
    const det = Math.max(dot(t, t), dot(b, b));
    const s = det === 0 ? 0 : 1 / Math.sqrt(det);
    return { t: scale(t, s), b: scale(b, s) };
  };

  it('equals the frame three.js derives per fragment, for any triangle, UV layout and view', () => {
    const next = random(7);
    const signed = () => next() * 2 - 1;
    for (let round = 0; round < 200; round++) {
      const positions = Array.from({ length: 9 }, signed);
      const uv = Array.from({ length: 6 }, signed);
      const p0 = positions.slice(0, 3) as V3;
      const e1 = add(positions.slice(3, 6) as V3, scale(p0, -1));
      const e2 = add(positions.slice(6, 9) as V3, scale(p0, -1));
      const front = normalize(cross(e1, e2));
      // A shading normal up to ~50 degrees off the face normal.
      const n = normalize(add(front, scale([signed(), signed(), signed()], 0.6)));
      const g = new Float64Array(7);
      const f = new Float64Array(6);
      if (!uvGradients(positions, 0, uv, 0, g) || Math.abs((uv[2] - uv[0]) * (uv[5] - uv[1]) - (uv[4] - uv[0]) * (uv[3] - uv[1])) < 0.05) continue;
      expect(tangentFrame(g, n[0], n[1], n[2], f)).toBe(true);

      // A view: one screen pixel to the right / up moves the surface point by q0 / q1 (in the triangle's
      // plane), any two directions that show the triangle from its front (q0 x q1 along the face normal).
      let a = [signed(), signed()];
      let b = [signed(), signed()];
      if (Math.abs(a[0] * b[1] - a[1] * b[0]) < 0.05) continue;
      if (a[0] * b[1] - a[1] * b[0] < 0) [a, b] = [b, a];
      const q0 = add(scale(e1, a[0]), scale(e2, a[1]));
      const q1 = add(scale(e1, b[0]), scale(e2, b[1]));
      expect(dot(cross(q0, q1), front)).toBeGreaterThan(0);
      // The UV moves along with the surface point.
      const du1 = [uv[2] - uv[0], uv[3] - uv[1]];
      const du2 = [uv[4] - uv[0], uv[5] - uv[1]];
      const st0: [number, number] = [du1[0] * a[0] + du2[0] * a[1], du1[1] * a[0] + du2[1] * a[1]];
      const st1: [number, number] = [du1[0] * b[0] + du2[0] * b[1], du1[1] * b[0] + du2[1] * b[1]];

      const expected = threeFrame(q0, q1, st0, st1, n);
      for (let i = 0; i < 3; i++) {
        expect(f[i]).toBeCloseTo(expected.t[i], 9);
        expect(f[3 + i]).toBeCloseTo(expected.b[i], 9);
      }

      // And encoding a world normal gives the vector three.js decodes back to it.
      const world = normalize(add(n, scale([signed(), signed(), signed()], 0.5)));
      const m = new Float64Array(3);
      expect(toTangentSpace(f, n[0], n[1], n[2], world[0], world[1], world[2], m)).toBe(true);
      expect(Math.hypot(m[0], m[1], m[2])).toBeCloseTo(1, 12);
      const decoded = normalize(add(add(scale(expected.t, m[0]), scale(expected.b, m[1])), scale(n, m[2])));
      for (let i = 0; i < 3; i++) expect(decoded[i]).toBeCloseTo(world[i], 9);
    }
  });

  it('maps components to bytes', () => {
    expect([toByte(-1), toByte(0), toByte(1), toByte(2)]).toEqual([0, 128, 255, 255]);
  });
});

describe('sampling', () => {
  it('has the base 2 radical inverse', () => {
    expect([0, 1, 2, 3, 4].map(radicalInverse2)).toEqual([0, 0.5, 0.25, 0.75, 0.125]);
  });

  it('spreads Hammersley points evenly: every cell of a 4 x 4 grid gets one of 16 points', () => {
    const points = hammersley(16);
    const cells = new Set<number>();
    for (let i = 0; i < 16; i++) cells.add(Math.floor(points[i * 2] * 4) * 4 + Math.floor(points[i * 2 + 1] * 4));
    expect(cells.size).toBe(16);
  });

  it('gives cosine-weighted unit directions', () => {
    const points = hammersley(4096);
    const d = new Float64Array(3);
    let meanZ = 0;
    for (let i = 0; i < 4096; i++) {
      cosineDirection(points[i * 2], points[i * 2 + 1], d);
      expect(Math.hypot(d[0], d[1], d[2])).toBeCloseTo(1, 12);
      expect(d[2]).toBeGreaterThanOrEqual(0);
      meanZ += d[2] / 4096;
    }
    // E[cos] under a cosine-weighted density is 2/3.
    expect(meanZ).toBeCloseTo(2 / 3, 3);
  });

  it('hashes deterministically and differently for neighbours', () => {
    expect(hash32(1)).toBe(hash32(1));
    expect(new Set([0, 1, 2, 3, 4, 5, 6, 7].map(hash32)).size).toBe(8);
  });
});

describe('dilate', () => {
  it('fills the neighbours ring by ring and leaves the rest alone', () => {
    const size = 9;
    const pixels = new Uint8ClampedArray(size * size * 4).fill(7);
    const covered = new Uint8Array(size * size);
    const centre = 4 * size + 4;
    covered[centre] = 1;
    pixels.set([200, 100, 50, 255], centre * 4);
    expect(dilate(pixels, covered, size, 2)).toBe(24);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const reach = Math.max(Math.abs(x - 4), Math.abs(y - 4));
        const colour = [...pixels.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];
        expect(colour, `${x},${y}`).toEqual(reach <= 2 ? [200, 100, 50, 255] : [7, 7, 7, 7]);
      }
    }
    expect([...covered].filter(Boolean)).toHaveLength(1);
  });

  it('averages where two charts meet, direct neighbours counting double', () => {
    const size = 8;
    const pixels = new Uint8ClampedArray(size * size * 4);
    const covered = new Uint8Array(size * size);
    const set = (x: number, y: number, value: number) => {
      covered[y * size + x] = 1;
      pixels.set([value, value, value, 255], (y * size + x) * 4);
    };
    set(1, 1, 100);
    set(3, 1, 200);
    set(3, 2, 40);
    dilate(pixels, covered, size, 1);
    // (2, 1) touches 100 and 200 directly and 40 diagonally: (2 * 100 + 2 * 200 + 40) / 5.
    expect(pixels[(1 * size + 2) * 4]).toBe(128);
    // (0, 0) only touches 100.
    expect(pixels[0]).toBe(100);
  });

  it('wraps around the image edges', () => {
    const size = 6;
    const pixels = new Uint8ClampedArray(size * size * 4);
    const covered = new Uint8Array(size * size);
    covered[0] = 1;
    pixels.set([9, 9, 9, 255], 0);
    dilate(pixels, covered, size, 1);
    expect(pixels[(size * size - 1) * 4]).toBe(9); // the opposite corner
    expect(pixels[(size - 1) * 4]).toBe(9); // the end of the first row
    expect(pixels[(2 * size + 2) * 4]).toBe(0);
  });
});

describe('Bvh', () => {
  it('finds the same hits as testing every triangle', () => {
    const next = random(3);
    const sphere = worldSoup(docWith({ s: { mesh: createPrimitive('uv_sphere', { segments: 24, rings: 12 }) } }), 's', false);
    const bvh = new Bvh(sphere.positions);
    expect(bvh.triangles).toBe(24 * 2 * 11);
    const single = (t: number) => new Bvh(sphere.positions.subarray(t * 9, t * 9 + 9));
    const singles = Array.from({ length: bvh.triangles }, (_, t) => single(t));
    let hits = 0;
    for (let round = 0; round < 300; round++) {
      const o: V3 = [next() * 3 - 1.5, next() * 3 - 1.5, next() * 3 - 1.5];
      const d = normalize([next() - 0.5, next() - 0.5, next() - 0.5]);
      let best = Infinity;
      let triangle = -1;
      singles.forEach((one, t) => {
        if (one.closest(o[0], o[1], o[2], d[0], d[1], d[2], 0, 10) && one.hitT < best) {
          best = one.hitT;
          triangle = t;
        }
      });
      const found = bvh.closest(o[0], o[1], o[2], d[0], d[1], d[2], 0, 10);
      expect(found).toBe(triangle !== -1);
      expect(bvh.occluded(o[0], o[1], o[2], d[0], d[1], d[2], 0, 10)).toBe(found);
      if (!found) continue;
      hits++;
      expect(bvh.hitT).toBeCloseTo(best, 12);
      // The hit point lies on the unit sphere's facets, so just inside radius 1.
      const point = add(o, scale(d, bvh.hitT));
      expect(Math.hypot(...point)).toBeLessThanOrEqual(1 + 1e-9);
      expect(Math.hypot(...point)).toBeGreaterThan(0.96);
      // Limits are respected.
      expect(bvh.closest(o[0], o[1], o[2], d[0], d[1], d[2], 0, best * 0.99)).toBe(false);
    }
    expect(hits).toBeGreaterThan(100);
  });

  it('reports the triangle, its barycentric weights and honours the facing filter', () => {
    // Two triangles above each other, both winding counter-clockwise seen from +y... the lower one from -y.
    const positions = new Float32Array([0, 1, 0, 0, 1, 2, 2, 1, 0, /* lower, facing down */ 0, 0, 0, 2, 0, 0, 0, 0, 2]);
    const bvh = new Bvh(positions);
    expect(bvh.closest(0.5, 5, 1, 0, -1, 0, 0, 10)).toBe(true);
    expect([bvh.hitTriangle, bvh.hitT, bvh.hitU, bvh.hitV]).toEqual([0, 4, 0.5, 0.25]);
    // From below the lower one comes first...
    expect(bvh.closest(0.5, -5, 1, 0, 1, 0, 0, 10)).toBe(true);
    expect([bvh.hitTriangle, bvh.hitT]).toEqual([1, 5]);
    // ...unless only triangles facing up count.
    expect(bvh.closest(0.5, -5, 1, 0, 1, 0, 0, 10, true, 0, 1, 0)).toBe(true);
    expect([bvh.hitTriangle, bvh.hitT]).toEqual([0, 6]);
    expect(bvh.closest(0.5, -5, 1, 0, 1, 0, 0, 5.5, true, 0, 1, 0)).toBe(false);
    // Rays along an axis through a box face, misses, and an empty scene.
    expect(bvh.closest(5, 5, 5, 0, -1, 0, 0, 10)).toBe(false);
    expect(new Bvh(new Float32Array(0)).closest(0, 0, 0, 0, 1, 0, 0, 10)).toBe(false);
  });
});

describe('worldSoup', () => {
  it('applies the transform to positions and normals', () => {
    const state = docWith({ p: { mesh: plane(), transform: { position: [1, 2, 3], rotation: [0, 0, 90], scale: [2, 1, 1] } } });
    const soup = worldSoup(state, 'p', true);
    // The plane faces +y; turned by 90 degrees around z it faces -x.
    for (let i = 0; i < soup.normals.length; i += 3) {
      expect(soup.normals[i]).toBeCloseTo(-1, 6);
      expect(soup.normals[i + 1]).toBeCloseTo(0, 6);
    }
    // Corner (-1, 0, 1) → scaled (-2, 0, 1) → rotated (0, -2, 1) → moved.
    expect([...soup.positions.subarray(0, 3)].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([1, 0, 4]);
    expect(soup.uvs).toBeDefined();
  });

  it('keeps triangles counter-clockwise from the front under a mirroring transform', () => {
    const state = docWith({ p: { mesh: plane(), transform: { ...identity, scale: [-1, 1, 1] } } });
    const soup = worldSoup(state, 'p', false);
    for (let t = 0; t < 2; t++) {
      const p = [...soup.positions.subarray(t * 9, t * 9 + 9)];
      const winding = cross([p[3] - p[0], p[4] - p[1], p[5] - p[2]], [p[6] - p[0], p[7] - p[1], p[8] - p[2]]);
      // Still facing +y, like its normals.
      expect(winding[1]).toBeGreaterThan(0);
      expect(soup.normals[t * 9 + 1]).toBeCloseTo(1, 6);
      // The UVs moved with their corners: u now runs along -x.
      for (let c = 0; c < 3; c++) expect(soup.uvs![t * 6 + c * 2]).toBeCloseTo((1 - p[c * 3]) / 2, 6);
    }
  });

  it('derives the default distances from the bounding diagonals', () => {
    const state = docWith({ a: { mesh: plane(2) }, b: { mesh: plane(2), transform: { ...identity, position: [0, 4, 0] } } });
    expect(defaultDistance(state, 'normal', 'a')).toBeCloseTo(Math.hypot(2, 2) * 0.05, 6);
    expect(defaultDistance(state, 'ao', 'a')).toBeCloseTo(Math.hypot(2, 2) * 0.25, 6);
    expect(defaultDistance(state, 'ao', 'a', ['b'])).toBeCloseTo(Math.hypot(2, 4, 2) * 0.25, 6);
  });
});

describe('bake.normal', () => {
  const size = 32;
  const bakeNormal = (state: DocState, maxDistance?: number) =>
    runBake(buildJob(state, { type: 'normal', targetId: 'low', sourceIds: ['high'], size, maxDistance }));

  it('gives the flat normal everywhere for a parallel offset plane', () => {
    const state = docWith({ low: { mesh: plane() }, high: { mesh: createPrimitive('plane', { size: 3 }), transform: { ...identity, position: [0, 0.05, 0] } } });
    const result = bakeNormal(state);
    expect(result.covered).toBe(size * size);
    expect(result.hits).toBe(size * size);
    for (let i = 0; i < result.pixels.length; i += 4) expect([...result.pixels.subarray(i, i + 4)]).toEqual([128, 128, 255, 255]);
    // The same from below the target.
    const below = docWith({ low: { mesh: plane() }, high: { mesh: createPrimitive('plane', { size: 3 }), transform: { ...identity, position: [0, -0.05, 0] } } });
    expect(bakeNormal(below).hits).toBe(size * size);
  });

  it('finds nothing beyond the maximum distance or behind a surface facing away', () => {
    const far = docWith({ low: { mesh: plane() }, high: { mesh: createPrimitive('plane', { size: 3 }), transform: { ...identity, position: [0, 0.5, 0] } } });
    // The default is 5 % of the target diagonal: 0.141.
    const result = bakeNormal(far);
    expect([result.covered, result.hits]).toEqual([size * size, 0]);
    expect(texel(result, size, 5, 5)).toEqual([128, 128, 255]);
    expect(bakeNormal(far, 0.6).hits).toBe(size * size);
    // Upside down: it faces away from the target's normal.
    const flipped = docWith({ low: { mesh: plane() }, high: { mesh: createPrimitive('plane', { size: 3 }), transform: { position: [0, 0.05, 0], rotation: [180, 0, 0], scale: [1, 1, 1] } } });
    expect(bakeNormal(flipped).hits).toBe(0);
  });

  it('gives the analytically expected constant normal for a tilted plane', () => {
    // Tilted by 20 degrees around z: its normal is (-sin 20°, cos 20°, 0). The target's u runs along +x,
    // its v along -z, so in tangent space that is (-sin 20°, 0, cos 20°).
    const angle = (20 * Math.PI) / 180;
    const state = docWith({ low: { mesh: plane() }, high: { mesh: createPrimitive('plane', { size: 4 }), transform: { ...identity, rotation: [0, 0, 20] } } });
    const result = bakeNormal(state, 1);
    expect(result.hits).toBe(size * size);
    const expected = [Math.round((-Math.sin(angle) * 0.5 + 0.5) * 255), 128, Math.round((Math.cos(angle) * 0.5 + 0.5) * 255)];
    expect(expected).toEqual([84, 128, 247]);
    for (let i = 0; i < result.pixels.length; i += 4) expect([...result.pixels.subarray(i, i + 3)]).toEqual(expected);

    // Tilted around x by 20 degrees the normal leans towards +z... which is -v: green goes down.
    const aroundX = docWith({ low: { mesh: plane() }, high: { mesh: createPrimitive('plane', { size: 4 }), transform: { ...identity, rotation: [20, 0, 0] } } });
    expect(texel(bakeNormal(aroundX, 1), size, 7, 20)).toEqual([128, Math.round((-Math.sin(angle) * 0.5 + 0.5) * 255), 247]);
  });

  it('is independent of how the target is turned, moved and scaled', () => {
    // Source and target share the transform, so the relative tilt and therefore the map stay the same.
    const transform: Transform = { position: [3, -1, 2], rotation: [30, 70, -45], scale: [2, 2, 2] };
    const tilted: PolyMesh = { positions: [-2, 0.4, 2, 2, -0.4, 2, 2, -0.4, -2, -2, 0.4, -2], faces: [[0, 1, 2, 3]] };
    const reference = bakeNormal(docWith({ low: { mesh: plane() }, high: { mesh: tilted } }), 1);
    const moved = bakeNormal(docWith({ low: { mesh: plane(), transform }, high: { mesh: tilted, transform } }), 2);
    expect(moved.hits).toBe(size * size);
    expect(texel(moved, size, 3, 9)).toEqual(texel(reference, size, 3, 9));
    // Slope -0.2 along x: the normal (0.2, 1, 0) normalised leans towards +u.
    expect(texel(reference, size, 3, 9)).toEqual([Math.round((0.2 / Math.hypot(0.2, 1)) * 127.5 + 127.5), 128, Math.round((1 / Math.hypot(0.2, 1)) * 127.5 + 127.5)]);
  });

  it('uses the smooth or flat shading normal of the source, and the smooth normal of the target', () => {
    // A coarse sphere as its own high-poly: with the same smooth normals on both sides the map is flat.
    const sphere: PolyMesh = createPrimitive('uv_sphere', { segments: 16, rings: 8 });
    const unwrapped: PolyMesh = { ...sphere, uvs: sphere.faces.map((face) => face.flatMap((v) => sphericalUv(sphere, v))) };
    const smooth = bakeNormal(docWith({ low: { mesh: unwrapped }, high: { mesh: sphere, smooth: true } }), 0.1);
    expect(smooth.hits).toBe(smooth.covered);
    let off = 0;
    for (let i = 0; i < smooth.pixels.length; i += 4) {
      if (Math.abs(smooth.pixels[i] - 128) > 1 || Math.abs(smooth.pixels[i + 1] - 128) > 1 || smooth.pixels[i + 2] < 254) off++;
    }
    expect(off).toBe(0);
    // A flat-shaded source bakes its facets: clearly not flat.
    const flat = bakeNormal(docWith({ low: { mesh: unwrapped }, high: { mesh: sphere, smooth: false } }), 0.1);
    let facets = 0;
    for (let i = 0; i < flat.pixels.length; i += 4) if (Math.abs(flat.pixels[i] - 128) > 8 || Math.abs(flat.pixels[i + 1] - 128) > 8) facets++;
    expect(facets).toBeGreaterThan(flat.covered * 0.5);
  });

  it('takes the visible surface where sources run through each other, but not a separate object above', () => {
    // A closed slab just above the target with a steep roof-shaped ridge pushed through it: under the
    // ridge the slab's top is the nearest surface, but it is buried in the ridge.
    const box = (x0: number, x1: number, y0: number, y1: number): PolyMesh => ({
      positions: [x0, y0, 2, x1, y0, 2, x1, y1, 2, x0, y1, 2, x0, y0, -2, x1, y0, -2, x1, y1, -2, x0, y1, -2],
      faces: [[0, 1, 2, 3], [5, 4, 7, 6], [1, 5, 6, 2], [4, 0, 3, 7], [3, 2, 6, 7], [4, 5, 1, 0]],
    });
    const ridge: PolyMesh = {
      positions: [-0.5, -0.2, 2, 0.5, -0.2, 2, 0, 0.3, 2, -0.5, -0.2, -2, 0.5, -0.2, -2, 0, 0.3, -2],
      faces: [[0, 1, 2], [4, 3, 5], [1, 4, 5, 2], [3, 0, 2, 5], [3, 4, 1, 0]],
    };
    const state = docWith({ low: { mesh: plane() }, slab: { mesh: box(-2, 2, -0.3, 0.05) }, ridge: { mesh: ridge }, lid: { mesh: box(-2, 2, 0.4, 0.45) } });
    const result = runBake(buildJob(state, { type: 'normal', targetId: 'low', sourceIds: ['slab', 'ridge', 'lid'], size, maxDistance: 1 }));
    expect(result.hits).toBe(size * size);
    // Outside the ridge (|x| > 0.4 where it leaves the slab): the slab's top, flat.
    expect(texel(result, size, 2, 10)).toEqual([128, 128, 255]);
    expect(texel(result, size, 29, 10)).toEqual([128, 128, 255]);
    // On the ridge's flanks: slope 1, normals (-1, 1, 0) and (1, 1, 0) normalised. Never the lid above.
    const lean = Math.round((Math.SQRT1_2 * 0.5 + 0.5) * 255);
    expect(texel(result, size, 12, 10)).toEqual([255 - lean, 128, lean]);
    expect(texel(result, size, 19, 10)).toEqual([lean, 128, lean]);
  });

  it('dilates beyond the chart and leaves the rest flat', () => {
    // The target only uses the lower left quarter of its texture.
    const quarter: PolyMesh = { ...createPrimitive('plane'), uvs: [[0, 0, 0.5, 0, 0.5, 0.5, 0, 0.5]] };
    const state = docWith({ low: { mesh: quarter }, high: { mesh: createPrimitive('plane', { size: 4 }), transform: { ...identity, rotation: [0, 0, 20] } } });
    const wide = 64;
    const result = runBake(buildJob(state, { type: 'normal', targetId: 'low', sourceIds: ['high'], size: wide, maxDistance: 1 }));
    expect(result.covered).toBe(32 * 32);
    const baked = [84, 128, 247];
    const flat = [128, 128, 255];
    // Rows count from the top: the chart is columns 0..31 of rows 32..63.
    expect(texel(result, wide, 4, 40)).toEqual(baked);
    // Eight texels beyond the chart border are filled, the ninth is not...
    expect(texel(result, wide, 39, 40)).toEqual(baked);
    expect(texel(result, wide, 40, 40)).toEqual(flat);
    expect(texel(result, wide, 4, 24)).toEqual(baked);
    expect(texel(result, wide, 4, 23)).toEqual(flat);
    expect(texel(result, wide, 39, 24)).toEqual(baked); // diagonally
    // ...and the same across the image edges, where a repeating texture continues.
    expect(texel(result, wide, 56, 40)).toEqual(baked);
    expect(texel(result, wide, 55, 40)).toEqual(flat);
    expect(texel(result, wide, 4, 7)).toEqual(baked);
    expect(texel(result, wide, 4, 8)).toEqual(flat);
  });

  it('gives the same image when the rows are shared out in bands', () => {
    const quarter: PolyMesh = { ...createPrimitive('plane'), uvs: [[0.1, 0, 0.7, 0.1, 0.6, 0.9, 0, 0.5]] };
    const state = docWith({ low: { mesh: quarter }, high: { mesh: createPrimitive('uv_sphere', { radius: 3 }), transform: { ...identity, position: [0, -2.9, 0] } } });
    const job = buildJob(state, { type: 'normal', targetId: 'low', sourceIds: ['high'], size: 50, maxDistance: 1 });
    const whole = bakeBand(job, { index: 0, count: 1 });
    expect(whole.covered).toBeGreaterThan(900);
    expect(new Set(whole.pixels).size).toBeGreaterThan(20);
    const bands = [0, 1, 2].map((index) => bakeBand(job, { index, count: 3 }));
    expect(bands.map((b) => b.mask.length)).toEqual([17 * 50, 17 * 50, 16 * 50]);
    expect(bands.reduce((n, b) => n + b.covered, 0)).toBe(whole.covered);
    expect(bands.reduce((n, b) => n + b.hits, 0)).toBe(whole.hits);
    const joined = assemble(50, bands);
    expect([...joined.pixels]).toEqual([...whole.pixels]);
    expect([...joined.mask]).toEqual([...whole.mask]);
  });

  it('reports progress up to 1', () => {
    const state = docWith({ low: { mesh: plane() }, high: { mesh: createPrimitive('plane', { size: 3 }), transform: { ...identity, position: [0, 0.05, 0] } } });
    const seen: number[] = [];
    runBake(buildJob(state, { type: 'normal', targetId: 'low', sourceIds: ['high'], size: 16 }), (f) => seen.push(f));
    expect(seen.at(-1)).toBe(1);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });
});

/** Longitude / latitude UVs of a vertex of a sphere around the origin (may wrap at the seam; that is fine). */
function sphericalUv(mesh: PolyMesh, vertex: number): [number, number] {
  const [x, y, z] = mesh.positions.slice(vertex * 3, vertex * 3 + 3);
  return [Math.atan2(-z, x) / (2 * Math.PI) + 0.5, Math.acos(Math.max(-1, Math.min(1, y / Math.hypot(x, y, z)))) / Math.PI];
}

describe('bake.ao', () => {
  const size = 16;

  it('is white for an open plane', () => {
    const state = docWith({ low: { mesh: plane() } });
    const job = buildJob(state, { type: 'ao', targetId: 'low', includeIds: [], size, samples: 32 });
    expect(job.type === 'ao' && job.distance).toBeCloseTo(Math.hypot(2, 2) * 0.25, 6);
    const result = runBake(job);
    expect(result.covered).toBe(size * size);
    for (let i = 0; i < result.pixels.length; i += 4) expect([...result.pixels.subarray(i, i + 4)]).toEqual([255, 255, 255, 255]);
  });

  it('matches the analytic occlusion next to a perpendicular wall', () => {
    // A floor strip next to a very long, very high wall at x = 0. A point at distance d sees the wall
    // (height h, taken as endless in length) under the form factor F = (1 - d / sqrt(d² + h²)) / 2,
    // which is exactly its cosine-weighted share of the hemisphere; ambient occlusion is 1 - F.
    const h = 400;
    const floor: PolyMesh = { positions: [0, 0, 1, 2, 0, 1, 2, 0, -1, 0, 0, -1], faces: [[0, 1, 2, 3]], uvs: [[0, 0, 1, 0, 1, 1, 0, 1]] };
    const wall: PolyMesh = { positions: [0, 0, 4000, 0, 0, -4000, 0, h, -4000, 0, h, 4000], faces: [[0, 1, 2, 3]] };
    const state = docWith({ low: { mesh: floor }, wall: { mesh: wall } });
    const result = runBake(buildJob(state, { type: 'ao', targetId: 'low', includeIds: ['wall'], size, samples: 1024, distance: 1e6 }));
    for (const column of [0, 3, 8, 15]) {
      const d = ((column + 0.5) / size) * 2;
      const expected = 1 - (1 - d / Math.hypot(d, h)) / 2;
      // In the very corner half of the hemisphere is wall: 0.5.
      if (column === 0) expect(expected).toBeCloseTo(0.5, 2);
      for (const row of [2, 9]) expect(texel(result, size, column, row)[0] / 255, `column ${column}`).toBeCloseTo(expected, 2);
    }
    // With a short ray length only the wall's foot counts: far from it nothing is hit.
    const short = runBake(buildJob(state, { type: 'ao', targetId: 'low', includeIds: ['wall'], size, samples: 64, distance: 0.5 }));
    expect(texel(short, size, 15, 5)).toEqual([255, 255, 255]);
    expect(texel(short, size, 0, 5)[0]).toBeLessThan(200);
  });

  it('is deterministic, and a flat-shaded cube does not shade itself', () => {
    const cube = createPrimitive('cube');
    // Every face gets the whole texture; they overlap, which is fine for this check.
    const unwrapped: PolyMesh = { ...cube, uvs: cube.faces.map(() => [0, 0, 1, 0, 1, 1, 0, 1]) };
    const state = docWith({ low: { mesh: unwrapped } });
    const request = { type: 'ao', targetId: 'low', includeIds: [], size, samples: 16 } as const;
    const first = runBake(buildJob(state, request));
    expect([...first.pixels]).toEqual([...runBake(buildJob(state, request)).pixels]);
    expect(first.pixels.every((v) => v === 255)).toBe(true);
    // Smooth shading tilts the hemisphere at the corners, but rays below the face are left out, not counted as hits.
    const smooth = runBake(buildJob(docWith({ low: { mesh: unwrapped, smooth: true } }), request));
    expect(smooth.pixels.every((v) => v === 255)).toBe(true);
  });

  it('darkens the floor around a cube standing on it', () => {
    const floor: PolyMesh = { ...createPrimitive('plane', { size: 8 }), uvs: [[0, 0, 1, 0, 1, 1, 0, 1]] };
    const state = docWith({ low: { mesh: floor }, cube: { mesh: createPrimitive('cube'), transform: { ...identity, position: [0, 1, 0] } } });
    const result = runBake(buildJob(state, { type: 'ao', targetId: 'low', includeIds: ['cube'], size: 32, samples: 64 }));
    const grey = (x: number, y: number) => texel(result, 32, x, y)[0];
    expect(grey(16, 16)).toBe(0); // under the cube
    expect(grey(10, 16)).toBeLessThan(190); // 0.4 beside it (the cube ends at texel 12)
    expect(grey(10, 16)).toBeGreaterThan(100);
    expect(grey(6, 16)).toBeGreaterThan(grey(10, 16)); // fading with distance
    expect(grey(0, 0)).toBeGreaterThan(245);
  });
});
