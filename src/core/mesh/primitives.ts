import { z } from 'zod';
import type { PolyMesh } from '../types';

export const primitiveTypes = ['cube', 'plane', 'uv_sphere', 'ico_sphere', 'cylinder', 'cone', 'torus'] as const;
export type PrimitiveType = (typeof primitiveTypes)[number];

/** Shape parameters. Each primitive reads only the ones that apply to it. */
export const primitiveShape = {
  size: z.number().positive().default(2).describe('Edge length of cube / plane'),
  radius: z.number().positive().default(1).describe('Radius of sphere / cylinder / cone / torus (major radius)'),
  height: z.number().positive().default(2).describe('Height of cylinder / cone'),
  segments: z.number().int().min(3).max(256).default(32).describe('Segments around the axis'),
  rings: z.number().int().min(2).max(128).default(16).describe('Rings of a uv_sphere'),
  subdivisions: z.number().int().min(0).max(5).default(2).describe('Subdivision level of an ico_sphere'),
  minorRadius: z.number().positive().default(0.25).describe('Tube radius of a torus'),
  minorSegments: z.number().int().min(3).max(128).default(12).describe('Segments around the torus tube'),
};
const shapeSchema = z.object(primitiveShape);
export type PrimitiveShape = z.infer<typeof shapeSchema>;

/** Creates a primitive centered on the origin, Y up, faces CCW seen from outside. */
export function createPrimitive(type: PrimitiveType, shape: Partial<PrimitiveShape> = {}): PolyMesh {
  const s = shapeSchema.parse(shape);
  switch (type) {
    case 'cube':
      return cube(s.size);
    case 'plane':
      return plane(s.size);
    case 'uv_sphere':
      return uvSphere(s.radius, s.segments, s.rings);
    case 'ico_sphere':
      return icoSphere(s.radius, s.subdivisions);
    case 'cylinder':
      return cylinder(s.radius, s.height, s.segments);
    case 'cone':
      return cone(s.radius, s.height, s.segments);
    case 'torus':
      return torus(s.radius, s.minorRadius, s.segments, s.minorSegments);
  }
}

// Angle convention for everything round: angle a around the Y axis maps to (cos a, -sin a) in XZ,
// so increasing angles run counter-clockwise seen from above (+Y).

/** Appends a ring of `segments` vertices around the Y axis. `+ 0` turns -0 into 0. */
function pushRing(positions: number[], radius: number, y: number, segments: number): void {
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    positions.push(radius * Math.cos(a) + 0, y, -radius * Math.sin(a) + 0);
  }
}

function uvSphere(radius: number, segments: number, rings: number): PolyMesh {
  // Vertex 0 is the north pole, then rings - 1 rings from top to bottom, then the south pole.
  const positions: number[] = [0, radius, 0];
  for (let r = 1; r < rings; r++) {
    const phi = (r / rings) * Math.PI;
    pushRing(positions, radius * Math.sin(phi), radius * Math.cos(phi) + 0, segments);
  }
  positions.push(0, -radius, 0);
  const south = positions.length / 3 - 1;
  const at = (ring: number, i: number) => 1 + (ring - 1) * segments + (i % segments);

  const faces: number[][] = [];
  for (let i = 0; i < segments; i++) faces.push([0, at(1, i), at(1, i + 1)]);
  for (let r = 1; r < rings - 1; r++) {
    for (let i = 0; i < segments; i++) faces.push([at(r + 1, i), at(r + 1, i + 1), at(r, i + 1), at(r, i)]);
  }
  for (let i = 0; i < segments; i++) faces.push([south, at(rings - 1, i + 1), at(rings - 1, i)]);
  return { positions, faces };
}

function icoSphere(radius: number, subdivisions: number): PolyMesh {
  const t = (1 + Math.sqrt(5)) / 2;
  // prettier-ignore
  const positions: number[] = [
    -1, t, 0,  1, t, 0,  -1, -t, 0,  1, -t, 0,
    0, -1, t,  0, 1, t,  0, -1, -t,  0, 1, -t,
    t, 0, -1,  t, 0, 1,  -t, 0, -1,  -t, 0, 1,
  ];
  // prettier-ignore
  let faces: number[][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];

  // Work on the unit sphere: every new midpoint is normalized right away, the radius is applied at the end.
  const normalize = (x: number, y: number, z: number): [number, number, number] => {
    const len = Math.hypot(x, y, z);
    return [x / len, y / len, z / len];
  };
  for (let i = 0; i < positions.length; i += 3) {
    const n = normalize(positions[i], positions[i + 1], positions[i + 2]);
    for (let c = 0; c < 3; c++) positions[i + c] = n[c];
  }

  // Midpoints are cached per edge so neighbouring triangles share them.
  const cache = new Map<string, number>();
  const midpoint = (a: number, b: number): number => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    let index = cache.get(key);
    if (index === undefined) {
      index = positions.length / 3;
      positions.push(
        ...normalize(
          positions[a * 3] + positions[b * 3],
          positions[a * 3 + 1] + positions[b * 3 + 1],
          positions[a * 3 + 2] + positions[b * 3 + 2],
        ),
      );
      cache.set(key, index);
    }
    return index;
  };
  for (let level = 0; level < subdivisions; level++) {
    const next: number[][] = [];
    for (const [a, b, c] of faces) {
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }

  // `+ 0` turns -0 into 0.
  return { positions: positions.map((v) => v * radius + 0), faces };
}

function cylinder(radius: number, height: number, segments: number): PolyMesh {
  const h = height / 2;
  const positions: number[] = [];
  pushRing(positions, radius, -h, segments); // bottom ring: 0 .. segments - 1
  pushRing(positions, radius, h, segments); // top ring: segments .. 2 * segments - 1
  const faces: number[][] = [];
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    faces.push([i, j, segments + j, segments + i]);
  }
  const ring = Array.from({ length: segments }, (_, i) => i);
  faces.push(ring.map((i) => segments + i)); // top cap
  faces.push(ring.map((i) => segments - 1 - i)); // bottom cap
  return { positions, faces };
}

function cone(radius: number, height: number, segments: number): PolyMesh {
  const h = height / 2;
  const positions: number[] = [];
  pushRing(positions, radius, -h, segments); // base ring: 0 .. segments - 1
  positions.push(0, h, 0); // apex
  const apex = segments;
  const faces: number[][] = [];
  for (let i = 0; i < segments; i++) faces.push([i, (i + 1) % segments, apex]);
  faces.push(Array.from({ length: segments }, (_, i) => segments - 1 - i)); // base cap
  return { positions, faces };
}

function torus(radius: number, minorRadius: number, segments: number, minorSegments: number): PolyMesh {
  // Vertex (i, k): i around the Y axis, k around the tube starting at the outer equator going up.
  const positions: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    for (let k = 0; k < minorSegments; k++) {
      const b = (k / minorSegments) * Math.PI * 2;
      const r = radius + minorRadius * Math.cos(b);
      positions.push(r * Math.cos(a) + 0, minorRadius * Math.sin(b) + 0, -r * Math.sin(a) + 0);
    }
  }
  const at = (i: number, k: number) => (i % segments) * minorSegments + (k % minorSegments);
  const faces: number[][] = [];
  for (let i = 0; i < segments; i++) {
    for (let k = 0; k < minorSegments; k++) faces.push([at(i, k), at(i + 1, k), at(i + 1, k + 1), at(i, k + 1)]);
  }
  return { positions, faces };
}

function cube(size: number): PolyMesh {
  const h = size / 2;
  return {
    // prettier-ignore
    positions: [
      -h, -h, -h,  h, -h, -h,  h, h, -h,  -h, h, -h,
      -h, -h,  h,  h, -h,  h,  h, h,  h,  -h, h,  h,
    ],
    faces: [
      [4, 5, 6, 7], // +Z
      [1, 0, 3, 2], // -Z
      [5, 1, 2, 6], // +X
      [0, 4, 7, 3], // -X
      [7, 6, 2, 3], // +Y
      [0, 1, 5, 4], // -Y
    ],
  };
}

function plane(size: number): PolyMesh {
  const h = size / 2;
  return {
    positions: [-h, 0, h, h, 0, h, h, 0, -h, -h, 0, -h],
    faces: [[0, 1, 2, 3]],
  };
}
