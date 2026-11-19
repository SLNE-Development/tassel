import { describe, expect, it } from 'vitest';
import { isClosedManifold, volume } from '../modifiers/testing';
import type { PolyMesh, Vec3 } from '../types';
import { boundingBox, edges, faceNormal, polyMeshSchema } from './polymesh';
import { createPrimitive } from './primitives';
import { createTube } from './tube';

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const vertex = (mesh: PolyMesh, i: number): Vec3 => [mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]];
const vertexCount = (mesh: PolyMesh) => mesh.positions.length / 3;

/** Distance of `p` from the infinite line through `a` and `b`, and its position along it (0 at a, 1 at b). */
function toLine(p: Vec3, a: Vec3, b: Vec3): { distance: number; t: number } {
  const d = sub(b, a);
  const t = dot(sub(p, a), d) / dot(d, d);
  return { distance: length(sub(p, [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t])), t };
}

/** Area of the regular polygon that is the tube's cross-section. */
const section = (radius: number, segments: number) => (segments / 2) * radius * radius * Math.sin((2 * Math.PI) / segments);

function expectSound(mesh: PolyMesh) {
  expect(polyMeshSchema.safeParse(mesh).success).toBe(true);
  expect(mesh.positions.every(Number.isFinite)).toBe(true);
  expect(mesh.positions.some((v) => Object.is(v, -0))).toBe(false);
  for (const face of mesh.faces) {
    expect(new Set(face).size).toBe(face.length);
    expect(Math.hypot(...faceNormal(mesh, face))).toBeCloseTo(1, 9);
  }
  expect(new Set(mesh.faces.flat()).size).toBe(vertexCount(mesh));
}

/** Every ring of the tube (ring i belongs to point i) lies on the cylinders around the pieces that meet in its point. */
function expectRadius(mesh: PolyMesh, points: Vec3[], radius: number, segments: number, closed = false) {
  const n = points.length;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < segments; k++) {
      const p = vertex(mesh, i * segments + k);
      if (closed || i > 0) expect(toLine(p, points[(i + n - 1) % n], points[i]).distance).toBeCloseTo(radius, 10);
      if (closed || i < n - 1) expect(toLine(p, points[i], points[(i + 1) % n]).distance).toBeCloseTo(radius, 10);
    }
  }
}

describe('tube between two points', () => {
  const cases: [Vec3, Vec3][] = [
    [
      [0, 0, 0],
      [0, 3, 0],
    ],
    [
      [0, 0, 0],
      [0, -3, 0],
    ],
    [
      [1, 2, 3],
      [4, -1, 5],
    ],
    [
      [-2, 0.5, 0],
      [5, 0.5, 0],
    ],
    [
      [0, 0, 1],
      [1e-3, 0, 1],
    ],
  ];

  it.each(cases)('%j -> %j is a cylinder of the given radius whose ends are exactly at the points', (a, b) => {
    const [radius, segments] = [0.25, 12];
    const mesh = createTube([a, b], { radius, segments });
    expectSound(mesh);
    expect(isClosedManifold(mesh)).toBe(true);
    const cylinder = createPrimitive('cylinder', { segments });
    expect(vertexCount(mesh)).toBe(vertexCount(cylinder));
    expect(mesh.faces.map((f) => f.length).sort()).toEqual(cylinder.faces.map((f) => f.length).sort());
    expect(vertexCount(mesh) - edges(mesh).length + mesh.faces.length).toBe(2);

    const scale = length(sub(b, a));
    for (let i = 0; i < vertexCount(mesh); i++) {
      const { distance, t } = toLine(vertex(mesh, i), a, b);
      expect(distance).toBeCloseTo(radius, 12);
      // The first ring is in the plane of the first point, the second in the plane of the second.
      expect(t * scale).toBeCloseTo(i < segments ? 0 : scale, 12);
    }
    // Outward and the size of a prism over the cross-section.
    expect(volume(mesh)).toBeCloseTo(section(radius, segments) * scale, 12);
    // The caps face away from the tube.
    const d = sub(b, a);
    expect(dot(faceNormal(mesh, mesh.faces.at(-2)!), d)).toBeCloseTo(-scale, 9);
    expect(dot(faceNormal(mesh, mesh.faces.at(-1)!), d)).toBeCloseTo(scale, 9);
  });

  it('along +Y it is the cylinder primitive moved up by half its height', () => {
    const mesh = createTube(
      [
        [0, 0, 0],
        [0, 2, 0],
      ],
      { radius: 1, segments: 32 },
    );
    const box = boundingBox(mesh)!;
    const expected = boundingBox(createPrimitive('cylinder'))!;
    for (let axis = 0; axis < 3; axis++) {
      expect(box.min[axis]).toBeCloseTo(expected.min[axis] + (axis === 1 ? 1 : 0), 12);
      expect(box.max[axis]).toBeCloseTo(expected.max[axis] + (axis === 1 ? 1 : 0), 12);
    }
    expect(volume(mesh)).toBeCloseTo(volume(createPrimitive('cylinder')), 12);
  });

  it('without caps it is an open shell with two boundary loops', () => {
    const mesh = createTube(
      [
        [0, 0, 0],
        [1, 0, 0],
      ],
      { radius: 0.1, segments: 8, caps: false },
    );
    expect(mesh.faces).toHaveLength(8);
    expect(isClosedManifold(mesh)).toBe(false);
    const uses = new Map<string, number>();
    for (const face of mesh.faces) {
      face.forEach((v, i) => {
        const w = face[(i + 1) % face.length];
        const key = v < w ? `${v}:${w}` : `${w}:${v}`;
        uses.set(key, (uses.get(key) ?? 0) + 1);
      });
    }
    expect([...uses.values()].filter((n) => n === 1)).toHaveLength(16);
  });
});

describe('tube along a path', () => {
  it('keeps its radius through the mitre of an L-shaped path', () => {
    const points: Vec3[] = [
      [0, 0, 0],
      [2, 0, 0],
      [2, 3, 0],
    ];
    const [radius, segments] = [0.25, 12];
    const mesh = createTube(points, { radius, segments });
    expectSound(mesh);
    expect(isClosedManifold(mesh)).toBe(true);
    expect(vertexCount(mesh)).toBe(3 * segments);
    expect(mesh.faces).toHaveLength(2 * segments + 2);
    expectRadius(mesh, points, radius, segments);
    // The corner ring lies in the plane bisecting the corner: x + y = 2.
    for (let k = 0; k < segments; k++) {
      const p = vertex(mesh, segments + k);
      expect(p[0] + p[1]).toBeCloseTo(2, 12);
    }
    // Two prisms cut at the mitre: together as long as the centre line.
    expect(volume(mesh)).toBeCloseTo(section(radius, segments) * 5, 12);
    // The ends stay perpendicular to the path, exactly at the first and last point.
    for (let k = 0; k < segments; k++) {
      expect(vertex(mesh, k)[0]).toBeCloseTo(0, 12);
      expect(vertex(mesh, 2 * segments + k)[1]).toBeCloseTo(3, 12);
    }
    const box = boundingBox(mesh)!;
    expect(box.min[0]).toBeCloseTo(0, 12);
    expect(box.max[0]).toBeCloseTo(2.25, 12);
    expect(box.min[1]).toBeCloseTo(-0.25, 12);
    expect(box.max[1]).toBeCloseTo(3, 12);
  });

  it('does not twist: on a straight path every ring is the first one moved along', () => {
    const points: Vec3[] = [
      [1, 1, 1],
      [2, 3, 1.5],
      [4, 7, 2.5],
      [4.5, 8, 2.75],
    ];
    const segments = 7;
    const mesh = createTube(points, { radius: 0.3, segments });
    for (let i = 1; i < points.length; i++) {
      const move = sub(points[i], points[0]);
      for (let k = 0; k < segments; k++) {
        const [p, q] = [vertex(mesh, i * segments + k), vertex(mesh, k)];
        for (let axis = 0; axis < 3; axis++) expect(p[axis]).toBeCloseTo(q[axis] + move[axis], 12);
      }
    }
  });

  it('keeps the radius and stays untwisted along a path that turns in space', () => {
    const points: Vec3[] = [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [1, 1, 1],
      [3, 2, 2],
      [3, -1, 2.5],
    ];
    const [radius, segments] = [0.05, 8];
    const mesh = createTube(points, { radius, segments });
    expectSound(mesh);
    expect(isClosedManifold(mesh)).toBe(true);
    expectRadius(mesh, points, radius, segments);
    let centreLine = 0;
    for (let i = 1; i < points.length; i++) centreLine += length(sub(points[i], points[i - 1]));
    expect(volume(mesh)).toBeCloseTo(section(radius, segments) * centreLine, 12);
    // Untwisted: the side faces stay planar, because each one is a strip of a prism.
    for (const face of mesh.faces.filter((f) => f.length === 4)) {
      const n = faceNormal(mesh, face);
      const origin = vertex(mesh, face[0]);
      for (const v of face) expect(dot(n, sub(vertex(mesh, v), origin))).toBeCloseTo(0, 12);
    }
  });

  it('a closed loop joins the last point to the first and has no caps', () => {
    const points: Vec3[] = [
      [0, 0, 0],
      [4, 0, 0],
      [4, 0, 3],
      [0, 0, 3],
    ];
    const [radius, segments] = [0.2, 10];
    const mesh = createTube(points, { radius, segments, closed: true });
    expectSound(mesh);
    expect(isClosedManifold(mesh)).toBe(true);
    expect(vertexCount(mesh)).toBe(4 * segments);
    expect(mesh.faces).toHaveLength(4 * segments);
    expect(mesh.faces.every((f) => f.length === 4)).toBe(true);
    expect(vertexCount(mesh) - edges(mesh).length + mesh.faces.length).toBe(0);
    expectRadius(mesh, points, radius, segments, true);
    expect(volume(mesh)).toBeCloseTo(section(radius, segments) * 14, 12);
    const box = boundingBox(mesh)!;
    expect(box.min[0]).toBeCloseTo(-0.2, 12);
    expect(box.max[0]).toBeCloseTo(4.2, 12);
    expect(box.min[2]).toBeCloseTo(-0.2, 12);
    expect(box.max[2]).toBeCloseTo(3.2, 12);
    // The same loop given with its first point repeated at the end.
    expect(createTube([...points, points[0]], { radius, segments, closed: true })).toEqual(mesh);
  });

  it('a closed loop that is not planar still closes, with the radius kept in every corner', () => {
    const points: Vec3[] = [
      [0, 0, 0],
      [2, 0, 0],
      [2, 1, 1],
      [1, 2, 2],
      [0, 1, 0.5],
    ];
    const [radius, segments] = [0.1, 12];
    const mesh = createTube(points, { radius, segments, closed: true });
    expectSound(mesh);
    expect(isClosedManifold(mesh)).toBe(true);
    expect(vertexCount(mesh) - edges(mesh).length + mesh.faces.length).toBe(0);
    expectRadius(mesh, points, radius, segments, true);
    expect(volume(mesh)).toBeGreaterThan(0);
  });

  it('tapers with one radius per point', () => {
    const mesh = createTube(
      [
        [0, 0, 0],
        [0, 0, 2],
      ],
      { radii: [0.5, 0.1], segments: 16 },
    );
    expectSound(mesh);
    expect(isClosedManifold(mesh)).toBe(true);
    for (let k = 0; k < 16; k++) {
      expect(Math.hypot(vertex(mesh, k)[0], vertex(mesh, k)[1])).toBeCloseTo(0.5, 12);
      expect(vertex(mesh, k)[2]).toBeCloseTo(0, 12);
      expect(Math.hypot(vertex(mesh, 16 + k)[0], vertex(mesh, 16 + k)[1])).toBeCloseTo(0.1, 12);
      expect(vertex(mesh, 16 + k)[2]).toBeCloseTo(2, 12);
    }
    const [a, b] = [section(0.5, 16), section(0.1, 16)];
    expect(volume(mesh)).toBeCloseTo((2 / 3) * (a + b + Math.sqrt(a * b)), 12);

    const bent = createTube(
      [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [2, 1, 1],
      ],
      { radius: 9, radii: [0.3, 0.2, 0.1, 0.05], segments: 6 },
    );
    expectSound(bent);
    expect(isClosedManifold(bent)).toBe(true);
    expect(volume(bent)).toBeGreaterThan(0);
  });

  it('drops repeated points', () => {
    const plain = createTube(
      [
        [0, 0, 0],
        [1, 0, 0],
        [1, 2, 0],
      ],
      { radius: 0.1 },
    );
    const repeated = createTube(
      [
        [0, 0, 0],
        [0, 0, 0],
        [1, 0, 0],
        [1, 0, 0],
        [1, 2, 0],
        [1, 2, 0],
      ],
      { radius: 0.1 },
    );
    expect(repeated).toEqual(plain);
  });

  it('rejects paths it cannot follow', () => {
    const p: Vec3 = [1, 2, 3];
    expect(() => createTube([p], { radius: 1 })).toThrow(/at least 2 different points/);
    expect(() => createTube([p, p, p], { radius: 1 })).toThrow(/at least 2 different points/);
    expect(() => createTube([p, [2, 2, 3]], {})).toThrow(/radius/);
    expect(() => createTube([p, [2, 2, 3]], { radius: 0 })).toThrow(/positive/);
    expect(() => createTube([p, [2, 2, 3]], { radius: NaN })).toThrow(/positive/);
    expect(() => createTube([p, [2, 2, 3]], { radii: [1] })).toThrow(/one entry per point/);
    expect(() => createTube([p, [2, 2, 3]], { radius: 1, closed: true })).toThrow(/at least 3/);
    expect(() =>
      createTube(
        [
          [0, 0, 0],
          [1, 0, 0],
          [0.5, 0, 0],
        ],
        { radius: 0.1 },
      ),
    ).toThrow(/folds back.*point 1/);
  });
});
