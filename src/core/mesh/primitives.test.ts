import { describe, expect, it } from 'vitest';
import type { PolyMesh, Vec3 } from '../types';
import { boundingBox, edges, faceNormal, polyMeshSchema } from './polymesh';
import { createPrimitive, primitiveTypes, type PrimitiveShape, type PrimitiveType } from './primitives';

const vertexCount = (mesh: PolyMesh) => mesh.positions.length / 3;

function centroid(mesh: PolyMesh, face: readonly number[]): Vec3 {
  const c: Vec3 = [0, 0, 0];
  for (const i of face) for (let a = 0; a < 3; a++) c[a] += mesh.positions[i * 3 + a] / face.length;
  return c;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Counts how often each directed edge a->b is used. */
function directedEdges(mesh: PolyMesh): Map<string, number> {
  const map = new Map<string, number>();
  for (const face of mesh.faces) {
    face.forEach((a, i) => {
      const key = `${a}>${face[(i + 1) % face.length]}`;
      map.set(key, (map.get(key) ?? 0) + 1);
    });
  }
  return map;
}

function expectValidFaces(mesh: PolyMesh) {
  expect(polyMeshSchema.safeParse(mesh).success).toBe(true);
  expect(mesh.positions.every(Number.isFinite)).toBe(true);
  const count = vertexCount(mesh);
  expect(Number.isInteger(count)).toBe(true);
  for (const face of mesh.faces) {
    expect(face.length).toBeGreaterThanOrEqual(3);
    for (const i of face) {
      expect(Number.isInteger(i)).toBe(true);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(count);
    }
    // Not degenerate: no repeated vertex and a non-zero area (faceNormal returns a zero vector for zero area).
    expect(new Set(face).size).toBe(face.length);
    expect(Math.hypot(...faceNormal(mesh, face))).toBeCloseTo(1, 9);
  }
}

function expectNoDuplicateVertices(mesh: PolyMesh) {
  const seen = new Set<string>();
  for (let i = 0; i < mesh.positions.length; i += 3) {
    seen.add(
      mesh.positions
        .slice(i, i + 3)
        .map((v) => Math.round(v * 1e7))
        .join(','),
    );
  }
  expect(seen.size).toBe(vertexCount(mesh));
  // Every vertex is used by a face.
  expect(new Set(mesh.faces.flat()).size).toBe(vertexCount(mesh));
}

function expectClosedManifold(mesh: PolyMesh) {
  const directed = directedEdges(mesh);
  for (const [key, uses] of directed) {
    const [a, b] = key.split('>');
    // Used once in this direction and once in the opposite one => exactly two faces, consistently oriented.
    expect(uses, `edge ${key}`).toBe(1);
    expect(directed.get(`${b}>${a}`), `opposite of edge ${key}`).toBe(1);
  }
  expect(directed.size).toBe(edges(mesh).length * 2);
}

const eulerCharacteristic = (mesh: PolyMesh) => vertexCount(mesh) - edges(mesh).length + mesh.faces.length;

/** Signed distance-like value: > 0 if the face normal points away from the solid. */
function outwardness(type: PrimitiveType, mesh: PolyMesh, face: readonly number[], shape: Partial<PrimitiveShape>): number {
  const n = faceNormal(mesh, face);
  const c = centroid(mesh, face);
  if (type !== 'torus') return dot(n, c);
  // Torus: compare against the direction from the tube's center line. Each vertex belongs to the tube
  // cross-section at its own angle; averaging those centers gives the center line point below the face
  // (which is a chord of the major circle, relevant for low segment counts).
  const radius = shape.radius ?? 1;
  const center: Vec3 = [0, 0, 0];
  for (const i of face) {
    const [x, , z] = mesh.positions.slice(i * 3, i * 3 + 3);
    const len = Math.hypot(x, z);
    center[0] += ((x / len) * radius) / face.length;
    center[2] += ((z / len) * radius) / face.length;
  }
  return dot(n, [c[0] - center[0], c[1] - center[1], c[2] - center[2]]);
}

const closedTypes = primitiveTypes.filter((t) => t !== 'plane');

const variants: [PrimitiveType, Partial<PrimitiveShape>][] = [
  ...closedTypes.map((t): [PrimitiveType, Partial<PrimitiveShape>] => [t, {}]),
  ['cube', { size: 0.5 }],
  ['uv_sphere', { radius: 2.5, segments: 3, rings: 2 }],
  ['uv_sphere', { radius: 0.3, segments: 7, rings: 5 }],
  ['uv_sphere', { segments: 64, rings: 32 }],
  ['ico_sphere', { subdivisions: 0 }],
  ['ico_sphere', { radius: 3, subdivisions: 1 }],
  ['ico_sphere', { subdivisions: 4 }],
  ['cylinder', { radius: 0.5, height: 5, segments: 3 }],
  ['cylinder', { segments: 5 }],
  ['cone', { radius: 3, height: 0.5, segments: 3 }],
  ['cone', { segments: 9 }],
  ['torus', { radius: 2, minorRadius: 0.5, segments: 3, minorSegments: 3 }],
  ['torus', { radius: 4, minorRadius: 1.5, segments: 9, minorSegments: 5 }],
];

describe('closed primitives', () => {
  describe.each(variants)('%s %j', (type, shape) => {
    const mesh = createPrimitive(type, shape);

    it('has valid indices and no degenerate faces', () => expectValidFaces(mesh));
    it('has no duplicate or unused vertices', () => expectNoDuplicateVertices(mesh));
    it('is a closed, consistently oriented manifold', () => expectClosedManifold(mesh));

    it('has the right Euler characteristic', () => {
      expect(eulerCharacteristic(mesh)).toBe(type === 'torus' ? 0 : 2);
    });

    it('has outward facing normals', () => {
      for (const face of mesh.faces) expect(outwardness(type, mesh, face, shape)).toBeGreaterThan(1e-9);
    });
  });
});

describe('default parameters', () => {
  it.each<[PrimitiveType, number, number]>([
    ['cube', 8, 6],
    ['plane', 4, 1],
    ['uv_sphere', 32 * 15 + 2, 32 * 16],
    ['ico_sphere', 162, 320],
    ['cylinder', 64, 34],
    ['cone', 33, 33],
    ['torus', 32 * 12, 32 * 12],
  ])('%s has %i vertices and %i faces', (type, vertices, faces) => {
    const mesh = createPrimitive(type);
    expect(vertexCount(mesh)).toBe(vertices);
    expect(mesh.faces.length).toBe(faces);
  });

  it('does not produce negative zeros (they would not survive a JSON round trip)', () => {
    for (const type of primitiveTypes) {
      expect(createPrimitive(type).positions.some((v) => Object.is(v, -0)), type).toBe(false);
    }
  });
});

describe('face types', () => {
  const sizes = (mesh: PolyMesh) => {
    const out: Record<number, number> = {};
    for (const f of mesh.faces) out[f.length] = (out[f.length] ?? 0) + 1;
    return out;
  };

  it('uv_sphere: triangles at the poles, quads in between', () => {
    expect(sizes(createPrimitive('uv_sphere', { segments: 8, rings: 4 }))).toEqual({ 3: 16, 4: 16 });
    expect(sizes(createPrimitive('uv_sphere', { segments: 8, rings: 2 }))).toEqual({ 3: 16 });
  });

  it('ico_sphere: only triangles, 20 * 4^n faces and 10 * 4^n + 2 vertices', () => {
    for (let n = 0; n <= 5; n++) {
      const mesh = createPrimitive('ico_sphere', { subdivisions: n });
      expect(sizes(mesh)).toEqual({ 3: 20 * 4 ** n });
      expect(vertexCount(mesh)).toBe(10 * 4 ** n + 2);
    }
  });

  it('cylinder: quad sides and one n-gon per cap', () => {
    expect(sizes(createPrimitive('cylinder', { segments: 8 }))).toEqual({ 4: 8, 8: 2 });
  });

  it('cone: triangle sides and one n-gon as base', () => {
    expect(sizes(createPrimitive('cone', { segments: 8 }))).toEqual({ 3: 8, 8: 1 });
  });

  it('torus: only quads', () => {
    expect(sizes(createPrimitive('torus', { segments: 8, minorSegments: 5 }))).toEqual({ 4: 40 });
  });
});

describe('extent', () => {
  function expectBox(mesh: PolyMesh, half: Vec3) {
    const box = boundingBox(mesh)!;
    for (let a = 0; a < 3; a++) {
      expect(box.max[a]).toBeCloseTo(half[a], 9);
      expect(box.min[a]).toBeCloseTo(-half[a], 9);
    }
  }

  it('cube spans size', () => expectBox(createPrimitive('cube', { size: 3 }), [1.5, 1.5, 1.5]));

  it('uv_sphere: all vertices on the sphere, box spans the diameter', () => {
    const mesh = createPrimitive('uv_sphere', { radius: 1.5 });
    for (let i = 0; i < mesh.positions.length; i += 3) {
      expect(Math.hypot(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2])).toBeCloseTo(1.5, 9);
    }
    expectBox(mesh, [1.5, 1.5, 1.5]);
    // Poles are on the Y axis.
    expect(mesh.positions.slice(0, 3)).toEqual([0, 1.5, 0]);
    expect(mesh.positions.slice(-3)).toEqual([0, -1.5, 0]);
  });

  it('ico_sphere: all vertices on the sphere, box spans the diameter', () => {
    for (const subdivisions of [0, 1, 2, 3]) {
      const mesh = createPrimitive('ico_sphere', { radius: 2.5, subdivisions });
      for (let i = 0; i < mesh.positions.length; i += 3) {
        expect(Math.hypot(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2])).toBeCloseTo(2.5, 9);
      }
      // The bare icosahedron has no vertices on the axes; from level 1 on it has.
      if (subdivisions > 0) expectBox(mesh, [2.5, 2.5, 2.5]);
    }
  });

  it('cylinder spans radius and height, axis along Y', () => {
    const mesh = createPrimitive('cylinder', { radius: 0.5, height: 3 });
    expectBox(mesh, [0.5, 1.5, 0.5]);
    for (let i = 0; i < mesh.positions.length; i += 3) {
      expect(Math.hypot(mesh.positions[i], mesh.positions[i + 2])).toBeCloseTo(0.5, 9);
      expect(Math.abs(mesh.positions[i + 1])).toBe(1.5);
    }
  });

  it('cone spans radius and height, apex on +Y', () => {
    const mesh = createPrimitive('cone', { radius: 0.5, height: 3 });
    expectBox(mesh, [0.5, 1.5, 0.5]);
    const top: number[] = [];
    for (let i = 0; i < mesh.positions.length; i += 3) {
      if (mesh.positions[i + 1] > 0) top.push(...mesh.positions.slice(i, i + 3));
    }
    expect(top).toEqual([0, 1.5, 0]);
  });

  it('torus spans major + minor radius around Y and the minor radius along Y', () => {
    const mesh = createPrimitive('torus', { radius: 2, minorRadius: 0.5 });
    expectBox(mesh, [2.5, 0.5, 2.5]);
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const tube = Math.hypot(Math.hypot(mesh.positions[i], mesh.positions[i + 2]) - 2, mesh.positions[i + 1]);
      expect(tube).toBeCloseTo(0.5, 9);
    }
  });
});

describe('plane', () => {
  const mesh = createPrimitive('plane', { size: 4 });

  it('is a single quad in the XZ plane facing +Y', () => {
    expectValidFaces(mesh);
    expectNoDuplicateVertices(mesh);
    expect(mesh.faces).toHaveLength(1);
    expect(mesh.faces[0]).toHaveLength(4);
    const n = faceNormal(mesh, mesh.faces[0]);
    expect(n[0]).toBeCloseTo(0);
    expect(n[1]).toBeCloseTo(1);
    expect(n[2]).toBeCloseTo(0);
    expect(boundingBox(mesh)).toEqual({ min: [-2, 0, -2], max: [2, 0, 2] });
  });

  it('is open: every edge is a boundary edge', () => {
    const directed = directedEdges(mesh);
    expect(directed.size).toBe(4);
    for (const [key, uses] of directed) {
      const [a, b] = key.split('>');
      expect(uses).toBe(1);
      expect(directed.has(`${b}>${a}`)).toBe(false);
    }
    expect(eulerCharacteristic(mesh)).toBe(1);
  });
});

describe('parameters', () => {
  it('rejects invalid shape parameters', () => {
    expect(() => createPrimitive('cube', { size: 0 })).toThrow();
    expect(() => createPrimitive('uv_sphere', { radius: -1 })).toThrow();
    expect(() => createPrimitive('cylinder', { segments: 2 })).toThrow();
    expect(() => createPrimitive('uv_sphere', { rings: 1 })).toThrow();
    expect(() => createPrimitive('ico_sphere', { subdivisions: 6 })).toThrow();
    expect(() => createPrimitive('torus', { minorSegments: 2.5 })).toThrow();
  });

  it('implements every declared primitive type', () => {
    for (const type of primitiveTypes) expect(createPrimitive(type).faces.length).toBeGreaterThan(0);
  });
});
