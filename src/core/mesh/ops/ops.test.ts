import { Euler, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { Edge, PolyMesh, Vec3 } from '../../types';
import { edges, faceNormal, meshStats } from '../polymesh';
import { createPrimitive } from '../primitives';
import { selectBy } from '../selection';
import { edgeFaces, edgeKey } from '../topology';
import { meshProblems } from './checks';
import { deleteElements } from './delete';
import { extrudeFaces, insetFaces } from './extrude';
import { fillFace } from './fill';
import { flipFaces } from './flip';
import { mergeByDistance, mergeVertices } from './merge';
import { subdivideFaces } from './subdivide';
import { transformVertices } from './transform';
import type { MeshOpResult } from './types';
import { faceArea, position, vertexCount } from './util';

// Cube (size 2). Vertices: 0 (-,-,-) 1 (+,-,-) 2 (+,+,-) 3 (-,+,-) 4 (-,-,+) 5 (+,-,+) 6 (+,+,+) 7 (-,+,+).
// Faces: 0 +Z [4,5,6,7], 1 -Z [1,0,3,2], 2 +X [5,1,2,6], 3 -X [0,4,7,3], 4 +Y [7,6,2,3], 5 -Y [0,1,5,4].
const cube = createPrimitive('cube');
const TOP = 4;

const solids: Record<string, PolyMesh> = {
  cube,
  cylinder: createPrimitive('cylinder', { segments: 8 }),
  torus: createPrimitive('torus', { segments: 8, minorSegments: 5 }),
  uv_sphere: createPrimitive('uv_sphere', { segments: 8, rings: 4 }),
  ico_sphere: createPrimitive('ico_sphere', { subdivisions: 1 }),
};
const solidList = Object.entries(solids);

/** Face selections to try on every solid. */
function faceSets(mesh: PolyMesh): Record<string, number[]> {
  const all = mesh.faces.map((_, i) => i);
  const [a, b] = mesh.faces[0];
  const neighbour = edgeFaces(mesh).get(edgeKey(a, b))!.find((f) => f !== 0)!;
  // A face that shares exactly one vertex with face 0: the region is pinched there.
  const diagonal = all.find((f) => mesh.faces[f].filter((v) => mesh.faces[0].includes(v)).length === 1);
  return {
    'one face': [0],
    'the last face': [all.length - 1],
    'faces facing up': selectBy(mesh, 'face', { normal: [0, 1, 0], angle: 50 }).faces as number[],
    'every third face': all.filter((i) => i % 3 === 0),
    'two neighbours': [0, neighbour],
    ...(diagonal === undefined ? {} : { 'two faces touching in one vertex': [0, diagonal] }),
  };
}

const area = (mesh: PolyMesh) => mesh.faces.reduce((sum, face) => sum + faceArea(mesh, face), 0);
const sortedPositions = (mesh: PolyMesh, vertices: readonly number[]) =>
  vertices.map((v) => position(mesh, v).map((x) => Math.round(x * 1e9) / 1e9 + 0)).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);

/** The result is a sound mesh (closed manifold unless stated otherwise) and its selection refers to existing elements. */
function expectSound(result: MeshOpResult, closed = true): MeshOpResult {
  expect(meshProblems(result.mesh, closed)).toEqual([]);
  const count = vertexCount(result.mesh);
  for (const v of result.vertices ?? []) expect(Number.isInteger(v) && v >= 0 && v < count, `vertex ${v}`).toBe(true);
  for (const f of result.faces ?? []) expect(Number.isInteger(f) && f >= 0 && f < result.mesh.faces.length, `face ${f}`).toBe(true);
  const existing = edgeFaces(result.mesh);
  for (const [a, b] of result.edges ?? []) expect(existing.has(edgeKey(a, b)), `edge ${a}-${b}`).toBe(true);
  for (const list of [result.vertices, result.faces]) expect(new Set(list).size).toBe(list?.length ?? 0);
  return result;
}

describe('the test solids', () => {
  it.each(solidList)('%s is a closed manifold', (_, mesh) => expect(meshProblems(mesh)).toEqual([]));

  it('meshProblems notices defects', () => {
    expect(meshProblems(deleteElements(cube, { faces: [0] }).mesh)).not.toEqual([]);
    expect(meshProblems(flipFaces(cube, [0]).mesh)).not.toEqual([]);
    expect(meshProblems({ positions: cube.positions, faces: [...cube.faces, cube.faces[0]] })).not.toEqual([]);
    expect(meshProblems({ positions: [...cube.positions, 0, 0, 0], faces: cube.faces }, false)).toEqual(['1 unused vertices']);
    expect(meshProblems({ positions: [0, 0, 0, 1, 0, 0, 2, 0, 0], faces: [[0, 1, 2]] }, false)).toEqual(['face 0 has no area']);
    expect(meshProblems({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], faces: [[0, 1, 1, 2]] }, false)).toEqual(['face 0 repeats a vertex']);
  });
});

describe('extrude', () => {
  it('cube top face by 1: four vertices at y = 2, 8 + 4 vertices, 6 + 4 faces', () => {
    const result = expectSound(extrudeFaces(cube, [TOP], 1));
    expect(meshStats(result.mesh)).toEqual({ vertices: 12, edges: 20, faces: 10, triangles: 20 });
    expect(result.faces).toEqual([TOP]);
    const top = result.mesh.faces[TOP];
    expect(sortedPositions(result.mesh, top)).toEqual([[-1, 2, -1], [-1, 2, 1], [1, 2, -1], [1, 2, 1]]);
    expect(faceNormal(result.mesh, top)).toEqual([0, 1, 0]);
    // Everything else is where it was: the eight original corners.
    const others = Array.from({ length: 12 }, (_, v) => v).filter((v) => !top.includes(v));
    expect(sortedPositions(result.mesh, others)).toEqual(sortedPositions(cube, [0, 1, 2, 3, 4, 5, 6, 7]));
    // The untouched faces keep their index and vertices.
    for (const f of [0, 1, 2, 3, 5]) expect(result.mesh.faces[f]).toEqual(cube.faces[f]);
    expect(area(result.mesh)).toBeCloseTo(24 + 4 * 2);
  });

  it('two adjacent faces: the edge between them is not duplicated', () => {
    // +Y and +Z: averaged normal (0, 1, 1) / sqrt 2.
    const result = expectSound(extrudeFaces(cube, [TOP, 0], Math.SQRT2));
    // 6 region vertices are duplicated, 6 outline edges get a side quad.
    expect(meshStats(result.mesh)).toMatchObject({ vertices: 14, faces: 12 });
    expect(result.faces).toEqual([TOP, 0]);
    const moved = [...new Set(result.faces!.flatMap((f) => result.mesh.faces[f]))];
    expect(moved).toHaveLength(6);
    expect(sortedPositions(result.mesh, moved)).toEqual(
      sortedPositions(cube, [2, 3, 4, 5, 6, 7]).map(([x, y, z]) => [x, y + 1, z + 1]),
    );
    // The two faces still share an edge.
    const shared = result.mesh.faces[TOP].filter((v) => result.mesh.faces[0].includes(v));
    expect(shared).toHaveLength(2);
  });

  it('negative distances extrude inwards', () => {
    const result = expectSound(extrudeFaces(cube, [TOP], -0.5));
    expect(sortedPositions(result.mesh, result.mesh.faces[TOP]).every((p) => p[1] === 0.5)).toBe(true);
  });

  it('a face of an open mesh gets side faces on its rim', () => {
    const plane = createPrimitive('plane');
    const result = expectSound(extrudeFaces(plane, [0], 1), false);
    expect(meshStats(result.mesh)).toMatchObject({ vertices: 8, faces: 5 });
    expect(sortedPositions(result.mesh, result.mesh.faces[0]).every((p) => p[1] === 1)).toBe(true);
    // Open at the bottom only: 4 rim edges, each with one face; and the box closes with one fill.
    const rim = [...edgeFaces(result.mesh).values()].filter((faces) => faces.length === 1);
    expect(rim).toHaveLength(4);
    expectSound(fillFace(result.mesh, [0, 1, 2, 3], null));
  });

  it('extruding all vertices of a face inside a larger open mesh keeps the neighbours attached', () => {
    const grid = subdivideFaces(createPrimitive('plane'), [0], 2).mesh; // 3 x 3 quads
    const result = expectSound(extrudeFaces(grid, [4], 0.5), false);
    expect(meshStats(result.mesh)).toMatchObject({ vertices: 16 + 4, faces: 9 + 4 });
    expect([...edgeFaces(result.mesh).values()].filter((faces) => faces.length === 1)).toHaveLength(12);
  });

  it('rejects unsuitable input', () => {
    expect(() => extrudeFaces(cube, [], 1)).toThrow('Select at least one face to extrude');
    expect(() => extrudeFaces(cube, [9], 1)).toThrow('Face 9 does not exist');
    expect(() => extrudeFaces(cube, [4, 5], 1)).toThrow(/opposite directions/);
    expect(() => extrudeFaces(cube, [0, 1, 2, 3, 4, 5], 1)).toThrow(/opposite directions/);
  });

  describe.each(solidList)('%s stays a closed manifold', (_, mesh) => {
    it.each(Object.entries(faceSets(mesh)))('%s', (__, faces) => {
      for (const distance of [0.3, -0.05]) {
        const result = expectSound(extrudeFaces(mesh, faces, distance));
        expect(result.faces).toEqual(faces);
        expect(result.mesh.faces.length).toBeGreaterThan(mesh.faces.length);
      }
    });
  });
});

describe('inset', () => {
  it('cube top face: an inner face and a ring of four quads', () => {
    const result = expectSound(insetFaces(cube, [TOP], 0.5, 0, false));
    expect(meshStats(result.mesh)).toMatchObject({ vertices: 12, faces: 10 });
    expect(result.faces).toEqual([TOP]);
    expect(sortedPositions(result.mesh, result.mesh.faces[TOP])).toEqual([[-0.5, 1, -0.5], [-0.5, 1, 0.5], [0.5, 1, -0.5], [0.5, 1, 0.5]]);
    expect(area(result.mesh)).toBeCloseTo(24);
    for (const face of result.mesh.faces.slice(6)) expect(faceNormal(result.mesh, face)).toEqual([0, 1, 0]);
  });

  it('depth moves the inner face along its normal', () => {
    const result = expectSound(insetFaces(cube, [TOP], 0.25, -0.5, false));
    expect(sortedPositions(result.mesh, result.mesh.faces[TOP])).toEqual([
      [-0.75, 0.5, -0.75], [-0.75, 0.5, 0.75], [0.75, 0.5, -0.75], [0.75, 0.5, 0.75],
    ]);
  });

  it('inset then extrude', () => {
    const inset = insetFaces(cube, [TOP], 0.5, 0, false);
    const result = expectSound(extrudeFaces(inset.mesh, inset.faces!, 0.5));
    expect(meshStats(result.mesh)).toMatchObject({ vertices: 16, faces: 14 });
    expect(sortedPositions(result.mesh, result.mesh.faces[TOP])).toEqual([[-0.5, 1.5, -0.5], [-0.5, 1.5, 0.5], [0.5, 1.5, -0.5], [0.5, 1.5, 0.5]]);
    // The four side faces of the new block are 1 x 0.5.
    expect(area(result.mesh)).toBeCloseTo(24 + 4 * 0.5);
  });

  it('region: the outline of two adjacent faces is inset as one, sliding along their common edge', () => {
    const result = expectSound(insetFaces(cube, [TOP, 0], 0.5, 0, false));
    expect(meshStats(result.mesh)).toMatchObject({ vertices: 14, faces: 12 });
    expect(sortedPositions(result.mesh, result.mesh.faces[TOP])).toEqual([[-0.5, 1, -0.5], [-0.5, 1, 1], [0.5, 1, -0.5], [0.5, 1, 1]]);
    expect(sortedPositions(result.mesh, result.mesh.faces[0])).toEqual([[-0.5, -0.5, 1], [-0.5, 1, 1], [0.5, -0.5, 1], [0.5, 1, 1]]);
    expect(area(result.mesh)).toBeCloseTo(24);
  });

  it('individual: every face gets its own ring', () => {
    const result = expectSound(insetFaces(cube, [TOP, 0], 0.5, 0, true));
    expect(meshStats(result.mesh)).toMatchObject({ vertices: 16, faces: 14 });
    expect(sortedPositions(result.mesh, result.mesh.faces[TOP])).toEqual([[-0.5, 1, -0.5], [-0.5, 1, 0.5], [0.5, 1, -0.5], [0.5, 1, 0.5]]);
    expect(sortedPositions(result.mesh, result.mesh.faces[0])).toEqual([[-0.5, -0.5, 1], [-0.5, 0.5, 1], [0.5, -0.5, 1], [0.5, 0.5, 1]]);
  });

  it('keeps the thickness at corners that are not right angles', () => {
    const prism = createPrimitive('cylinder', { segments: 3, radius: 1, height: 1 });
    const cap = 3; // top cap: an equilateral triangle with inradius 0.5
    const result = expectSound(insetFaces(prism, [cap], 0.25, 0, false));
    const [a, b, c] = result.mesh.faces[cap].map((v) => position(result.mesh, v));
    // Half the inradius is left, so the inner triangle is half as large.
    expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeCloseTo(Math.sqrt(3) / 2);
    expect(Math.hypot(c[0], c[2])).toBeCloseTo(0.5);
  });

  it('a region without outline (the whole solid) only moves by depth', () => {
    const result = expectSound(insetFaces(cube, [0, 1, 2, 3, 4, 5], 0.3, Math.sqrt(3), false));
    expect(meshStats(result.mesh)).toEqual(meshStats(cube));
    expect(sortedPositions(result.mesh, [0, 1, 2, 3, 4, 5, 6, 7])).toEqual(
      sortedPositions(cube, [0, 1, 2, 3, 4, 5, 6, 7]).map((p) => p.map((x) => x * 2)),
    );
  });

  it('rejects unsuitable input', () => {
    expect(() => insetFaces(cube, [], 0.1, 0, false)).toThrow('Select at least one face to inset');
    expect(() => insetFaces(cube, [6], 0.1, 0, true)).toThrow('Face 6 does not exist');
  });

  describe.each(solidList)('%s stays a closed manifold', (_, mesh) => {
    it.each(Object.entries(faceSets(mesh)))('%s', (__, faces) => {
      for (const individual of [false, true]) {
        for (const depth of [0, 0.05]) {
          const result = expectSound(insetFaces(mesh, faces, 0.02, depth, individual));
          expect(result.faces).toEqual(faces);
        }
      }
    });

    it('all faces individually', () => {
      const all = mesh.faces.map((_, i) => i);
      const result = expectSound(insetFaces(mesh, all, 0.01, 0.02, true));
      const corners = mesh.faces.reduce((sum, face) => sum + face.length, 0);
      expect(meshStats(result.mesh)).toMatchObject({ vertices: vertexCount(mesh) + corners, faces: mesh.faces.length + corners });
    });
  });
});

describe('subdivide', () => {
  it('cube top face, one cut: 4 quads, and the side faces take over the new edge vertices', () => {
    const result = expectSound(subdivideFaces(cube, [TOP], 1));
    expect(meshStats(result.mesh)).toMatchObject({ vertices: 8 + 4 + 1, faces: 5 + 4 });
    expect(result.faces).toHaveLength(4);
    for (const f of result.faces!) {
      expect(result.mesh.faces[f]).toHaveLength(4);
      expect(faceNormal(result.mesh, result.mesh.faces[f])).toEqual([0, 1, 0]);
      expect(faceArea(result.mesh, result.mesh.faces[f])).toBeCloseTo(1);
    }
    expect(result.mesh.faces.filter((face) => face.length === 5)).toHaveLength(4);
    expect(sortedPositions(result.mesh, [8, 9, 10, 11, 12])).toEqual([[-1, 1, 0], [0, 1, -1], [0, 1, 0], [0, 1, 1], [1, 1, 0]]);
    expect(area(result.mesh)).toBeCloseTo(24);
  });

  it('all cube faces, two cuts: a 3 x 3 grid per face', () => {
    const result = expectSound(subdivideFaces(cube, [0, 1, 2, 3, 4, 5], 2));
    expect(meshStats(result.mesh)).toMatchObject({ vertices: 8 + 12 * 2 + 6 * 4, faces: 54 });
    expect(result.faces).toHaveLength(54);
    for (const face of result.mesh.faces) expect(faceArea(result.mesh, face)).toBeCloseTo(4 / 9);
  });

  it('triangles become (cuts + 1)^2 triangles', () => {
    const ico = createPrimitive('ico_sphere', { subdivisions: 0 });
    const result = expectSound(subdivideFaces(ico, [0], 2));
    expect(meshStats(result.mesh)).toMatchObject({ vertices: 12 + 3 * 2 + 1, faces: 19 + 9 });
    expect(result.faces).toHaveLength(9);
    const n = faceNormal(ico, ico.faces[0]);
    for (const f of result.faces!) {
      expect(result.mesh.faces[f]).toHaveLength(3);
      expect(faceArea(result.mesh, result.mesh.faces[f])).toBeCloseTo(faceArea(ico, ico.faces[0]) / 9);
      faceNormal(result.mesh, result.mesh.faces[f]).forEach((x, a) => expect(x).toBeCloseTo(n[a]));
    }
  });

  it('n-gons become a fan around their centre', () => {
    const cylinder = solids.cylinder;
    const cap = 8;
    const result = expectSound(subdivideFaces(cylinder, [cap], 1));
    expect(meshStats(result.mesh)).toMatchObject({ vertices: 16 + 8 + 1, faces: 9 + 16 });
    expect(result.faces).toHaveLength(16);
    expect(area(result.mesh)).toBeCloseTo(area(cylinder));
  });

  it('rejects unsuitable input', () => {
    expect(() => subdivideFaces(cube, [], 1)).toThrow('Select at least one face to subdivide');
    expect(() => subdivideFaces(cube, [7], 1)).toThrow('Face 7 does not exist');
  });

  describe.each(solidList)('%s stays a closed manifold', (_, mesh) => {
    const sets = { ...faceSets(mesh), 'all faces': mesh.faces.map((__, i) => i) };
    it.each(Object.entries(sets))('%s', (__, faces) => {
      for (const cuts of [1, 2, 3]) {
        const result = expectSound(subdivideFaces(mesh, faces, cuts));
        expect(result.mesh.faces.length - result.faces!.length).toBe(mesh.faces.length - faces.length);
        // The new faces are flat pieces of the old ones, so nothing changes shape when the faces were planar.
        if (mesh === cube || mesh === solids.ico_sphere) expect(area(result.mesh)).toBeCloseTo(area(mesh));
      }
    });
  });
});

describe('merge', () => {
  it('cube top face at its centre: a pyramid', () => {
    const result = expectSound(mergeVertices(cube, cube.faces[TOP], 'center'));
    expect(meshStats(result.mesh)).toEqual({ vertices: 5, edges: 8, faces: 5, triangles: 6 });
    expect(result.vertices).toHaveLength(1);
    expect(position(result.mesh, result.vertices![0])).toEqual([0, 1, 0]);
    expect(result.mesh.faces.map((f) => f.length).sort()).toEqual([3, 3, 3, 3, 4]);
    expect(sortedPositions(result.mesh, [0, 1, 2, 3, 4])).toEqual([[-1, -1, -1], [-1, -1, 1], [0, 1, 0], [1, -1, -1], [1, -1, 1]]);
  });

  it('first / last use the position of the first / last vertex given', () => {
    const first = expectSound(mergeVertices(cube, [6, 7, 2, 3], 'first'));
    expect(position(first.mesh, first.vertices![0])).toEqual([1, 1, 1]);
    const last = expectSound(mergeVertices(cube, [6, 7, 2, 3], 'last'));
    expect(position(last.mesh, last.vertices![0])).toEqual([-1, 1, -1]);
    expect(meshStats(last.mesh)).toMatchObject({ vertices: 5, faces: 5 });
  });

  it('two vertices of an edge: the edge collapses, its faces lose a corner', () => {
    const result = expectSound(mergeVertices(cube, [6, 7], 'center'));
    expect(meshStats(result.mesh)).toMatchObject({ vertices: 7, faces: 6 });
    expect(result.mesh.faces.map((f) => f.length).sort()).toEqual([3, 3, 4, 4, 4, 4]);
    expect(position(result.mesh, result.vertices![0])).toEqual([0, 1, 1]);
  });

  it('two opposite corners of a face: the face disappears', () => {
    const result = expectSound(mergeVertices(cube, [7, 2], 'center'));
    expect(meshStats(result.mesh)).toMatchObject({ vertices: 7, faces: 5 });
  });

  it('rejects unsuitable input', () => {
    expect(() => mergeVertices(cube, [3], 'center')).toThrow('Select at least two vertices to merge');
    expect(() => mergeVertices(cube, [3, 3], 'center')).toThrow('Select at least two vertices to merge');
    expect(() => mergeVertices(cube, [3, 8], 'center')).toThrow('Vertex 8 does not exist');
  });

  describe.each(solidList)('%s stays a closed manifold', (_, mesh) => {
    it('merging one face', () => {
      for (const f of [0, mesh.faces.length - 1]) {
        const result = expectSound(mergeVertices(mesh, mesh.faces[f], 'center'));
        expect(vertexCount(result.mesh)).toBe(vertexCount(mesh) - mesh.faces[f].length + 1);
      }
    });

    it('collapsing one edge', () => {
      for (const [a, b] of [edges(mesh)[0], edges(mesh).at(-1)!]) {
        const result = expectSound(mergeVertices(mesh, [a, b], 'last'));
        expect(vertexCount(result.mesh)).toBe(vertexCount(mesh) - 1);
        expect(position(result.mesh, result.vertices![0])).toEqual(position(mesh, b));
      }
    });
  });
});

describe('merge by distance', () => {
  it('does nothing when no vertices are close', () => {
    const result = expectSound(mergeByDistance(cube, null, 0.5));
    expect(result.mesh).toEqual(cube);
    expect(result.vertices).toEqual([]);
  });

  it('welds two cubes that touch and removes the two faces between them', () => {
    const two: PolyMesh = {
      positions: [...cube.positions, ...cube.positions.map((v, i) => (i % 3 === 0 ? v + 2 : v))],
      faces: [...cube.faces, ...cube.faces.map((f) => f.map((v) => v + 8))],
    };
    expect(meshProblems(two)).toEqual([]);
    const result = expectSound(mergeByDistance(two, null, 0.0001));
    expect(meshStats(result.mesh)).toMatchObject({ vertices: 12, faces: 10 });
    expect(area(result.mesh)).toBeCloseTo(40);
  });

  it('undoes a zero-distance extrude and a zero-thickness inset', () => {
    for (const [, mesh] of solidList) {
      for (const op of [extrudeFaces(mesh, faceSets(mesh)['two neighbours'], 0), insetFaces(mesh, [0, 1], 0, 0, true)]) {
        expect(op.mesh.faces.length).toBeGreaterThan(mesh.faces.length);
        const result = expectSound(mergeByDistance(op.mesh, null, 1e-6));
        expect(meshStats(result.mesh)).toEqual(meshStats(mesh));
      }
    }
  });

  it('is limited to the given vertices and selects the ones that are left', () => {
    // A cube with a slightly raised copy of its top face: two rings of four vertices 0.01 apart.
    const raised = extrudeFaces(cube, [TOP], 0.01).mesh;
    const top = raised.faces[TOP];
    const below = Array.from({ length: 12 }, (_, v) => v).filter((v) => !top.includes(v) && raised.positions[v * 3 + 1] === 1);
    const pair = [top.find((v) => raised.positions[v * 3] === 1 && raised.positions[v * 3 + 2] === 1)!, below.find((v) => raised.positions[v * 3] === 1 && raised.positions[v * 3 + 2] === 1)!];
    const one = expectSound(mergeByDistance(raised, pair, 0.02));
    expect(vertexCount(one.mesh)).toBe(11);
    expect(one.vertices).toHaveLength(1);
    // The lower index survives, and with it its position.
    expect(position(one.mesh, one.vertices![0])).toEqual(position(raised, Math.min(...pair)));
    const all = expectSound(mergeByDistance(raised, [...top, ...below], 0.02));
    expect(meshStats(all.mesh)).toEqual(meshStats(cube));
    expect(all.vertices).toHaveLength(4);
    // Too small a distance changes nothing.
    expect(mergeByDistance(raised, null, 0.005).mesh).toEqual(raised);
  });

  it('removes one of two identical faces', () => {
    const doubled: PolyMesh = { positions: [...cube.positions, ...cube.positions.slice(6 * 3, 8 * 3)], faces: [...cube.faces, [8, 9, 7, 6]] };
    const result = mergeByDistance(doubled, null, 0);
    // [8, 9, 7, 6] welds to [6, 7, 7, 6], which collapses.
    expect(result.mesh).toEqual(cube);
    const twice: PolyMesh = { positions: [...cube.positions, ...cube.positions], faces: [...cube.faces, ...cube.faces.map((f) => f.map((v) => v + 8))] };
    expect(expectSound(mergeByDistance(twice, null, 0)).mesh).toEqual(cube);
  });
});

describe('delete', () => {
  it('faces: only the faces go, their vertices stay while other faces use them', () => {
    const result = expectSound(deleteElements(cube, { faces: [TOP] }), false);
    expect(meshStats(result.mesh)).toMatchObject({ vertices: 8, faces: 5 });
    expect(result).toMatchObject({ vertices: [], edges: [], faces: [] });
  });

  it('vertices: every face using one of them goes', () => {
    const result = expectSound(deleteElements(cube, { vertices: [6] }), false);
    expect(meshStats(result.mesh)).toMatchObject({ vertices: 7, faces: 3 });
    expect(sortedPositions(result.mesh, [0, 1, 2, 3, 4, 5, 6])).not.toContainEqual([1, 1, 1]);
  });

  it('edges: both faces at the edge go', () => {
    const result = expectSound(deleteElements(cube, { edges: [[6, 7]] }), false);
    expect(meshStats(result.mesh)).toMatchObject({ vertices: 8, faces: 4 });
  });

  it('drops orphaned vertices, down to an empty mesh', () => {
    const half = expectSound(deleteElements(cube, { vertices: cube.faces[TOP] }), false);
    expect(meshStats(half.mesh)).toMatchObject({ vertices: 4, faces: 1 });
    expect(deleteElements(cube, { faces: [0, 1, 2, 3, 4, 5] }).mesh).toEqual({ positions: [], faces: [] });
  });

  it.each(solidList)('%s: deleting a face and filling the hole restores a closed manifold', (_, mesh) => {
    for (const f of [0, mesh.faces.length - 1]) {
      const normal = faceNormal(mesh, mesh.faces[f]);
      const open = expectSound(deleteElements(mesh, { faces: [f] }), false);
      expect(open.mesh.faces).toHaveLength(mesh.faces.length - 1);
      expect(vertexCount(open.mesh)).toBe(vertexCount(mesh));
      // No vertex was dropped, so the indices of the hole are those of the deleted face.
      const filled = expectSound(fillFace(open.mesh, mesh.faces[f], null));
      expect(meshStats(filled.mesh)).toEqual(meshStats(mesh));
      expect(filled.faces).toEqual([mesh.faces.length - 1]);
      faceNormal(filled.mesh, filled.mesh.faces.at(-1)!).forEach((x, a) => expect(x).toBeCloseTo(normal[a]));
    }
  });
});

describe('fill', () => {
  const open = deleteElements(cube, { faces: [TOP] }).mesh; // vertex indices unchanged
  const hole: Edge[] = [[6, 7], [2, 6], [2, 3], [3, 7]];

  it('fills a hole from its vertices in any order, wound like the neighbours', () => {
    for (const vertices of [[7, 6, 2, 3], [2, 7, 3, 6], [3, 2, 6, 7]]) {
      const result = expectSound(fillFace(open, vertices, null));
      expect(result.faces).toEqual([5]);
      expect(faceNormal(result.mesh, result.mesh.faces[5])).toEqual([0, 1, 0]);
    }
  });

  it('fills a hole from its edges', () => {
    const result = expectSound(fillFace(open, [], hole));
    expect(faceNormal(result.mesh, result.mesh.faces[5])).toEqual([0, 1, 0]);
  });

  it('closes an open chain of edges with a new edge', () => {
    const result = expectSound(fillFace(open, [], hole.slice(0, 3)));
    expect(result.mesh.faces[5]).toHaveLength(4);
    // Two edges at a corner of a larger hole: a triangle remains open next to it.
    const triangle = expectSound(fillFace(open, [], hole.slice(0, 2)), false);
    expect(triangle.mesh.faces[5]).toHaveLength(3);
    expect(faceNormal(triangle.mesh, triangle.mesh.faces[5])).toEqual([0, 1, 0]);
    expectSound(fillFace(triangle.mesh, [], [[2, 3], [3, 7], [2, 7]]));
  });

  it('fills an n-gon hole along the loop, not in index order', () => {
    const cylinder = solids.cylinder;
    const opened = deleteElements(cylinder, { faces: [8] }).mesh;
    const result = expectSound(fillFace(opened, [15, 9, 12, 8, 14, 10, 13, 11], null));
    expect(result.mesh.faces.at(-1)).toHaveLength(8);
    expect(faceNormal(result.mesh, result.mesh.faces.at(-1)!)[1]).toBeCloseTo(1);
  });

  it('explains unsuitable selections', () => {
    // The top face exists: its edges all have two faces.
    expect(() => fillFace(cube, [7, 6, 2, 3], null)).toThrow(/Cannot fill: the selection must be the open edges around one hole/);
    expect(() => fillFace(cube, [], hole)).toThrow('Cannot fill: edge 6-7 already has two faces');
    expect(() => fillFace(open, [], [[0, 6]])).toThrow('no edge between vertices 0 and 6');
    expect(() => fillFace(open, [6, 7], null)).toThrow('at least three vertices');
    expect(() => fillFace(open, [], [])).toThrow('at least three vertices');
    // A vertex that is not on the hole.
    expect(() => fillFace(open, [7, 6, 2, 3, 0], null)).toThrow(/Cannot fill/);
    // Two holes at once.
    const twoHoles = deleteElements(cube, { faces: [TOP, 5] }).mesh;
    expect(() => fillFace(twoHoles, [0, 1, 2, 3, 4, 5, 6, 7], null)).toThrow(/Cannot fill/);
    expectSound(fillFace(fillFace(twoHoles, [7, 6, 2, 3], null).mesh, [0, 1, 5, 4], null));
  });
});

describe('transform', () => {
  const top = cube.faces[TOP];

  it('translates only the given vertices and leaves the input alone', () => {
    const before = [...cube.positions];
    const result = expectSound(transformVertices(cube, top, { translate: [0.5, 1, -2] }));
    expect(cube.positions).toEqual(before);
    expect(result.vertices).toEqual(top);
    expect(result.mesh.faces).toBe(cube.faces);
    expect(sortedPositions(result.mesh, top)).toEqual([[-0.5, 2, -3], [-0.5, 2, -1], [1.5, 2, -3], [1.5, 2, -1]]);
    for (const v of [0, 1, 4, 5]) expect(position(result.mesh, v)).toEqual(position(cube, v));
  });

  it('scales about the bounding-box centre of the vertices by default', () => {
    const result = expectSound(transformVertices(cube, top, { scale: [0.5, 3, 0.5] }));
    expect(sortedPositions(result.mesh, top)).toEqual([[-0.5, 1, -0.5], [-0.5, 1, 0.5], [0.5, 1, -0.5], [0.5, 1, 0.5]]);
    const pivoted = transformVertices(cube, top, { scale: [1, 2, 1], pivot: [0, -1, 0] });
    expect(sortedPositions(pivoted.mesh, top).every((p) => p[1] === 3)).toBe(true);
  });

  it('rotates in degrees about the pivot', () => {
    const y90 = expectSound(transformVertices(cube, [6], { rotate: [0, 90, 0], pivot: [0, 1, 0] }));
    position(y90.mesh, 6).forEach((x, a) => expect(x).toBeCloseTo([1, 1, -1][a]));
    const x90 = transformVertices(cube, [6], { rotate: [90, 0, 0], pivot: [0, 0, 0] });
    position(x90.mesh, 6).forEach((x, a) => expect(x).toBeCloseTo([1, -1, 1][a]));
    // A quarter turn of the top face about its own centre maps it onto itself.
    const turned = expectSound(transformVertices(cube, top, { rotate: [0, 90, 0] }));
    expect(sortedPositions(turned.mesh, top)).toEqual(sortedPositions(cube, top));
  });

  it('uses the same Euler XYZ convention as object rotations (three.js), after scaling and before translating', () => {
    const rotate: Vec3 = [25, -70, 130];
    const scale: Vec3 = [2, 0.5, -1.5];
    const translate: Vec3 = [3, -2, 1];
    const pivot: Vec3 = [0.25, 0.5, -1];
    const result = transformVertices(cube, [0, 1, 2, 3, 4, 5, 6, 7], { rotate, scale, translate, pivot });
    const rad = (d: number) => (d * Math.PI) / 180;
    const euler = new Euler(rad(rotate[0]), rad(rotate[1]), rad(rotate[2]), 'XYZ');
    for (let v = 0; v < 8; v++) {
      const expected = new Vector3(...position(cube, v))
        .sub(new Vector3(...pivot))
        .multiply(new Vector3(...scale))
        .applyEuler(euler)
        .add(new Vector3(...pivot))
        .add(new Vector3(...translate));
      position(result.mesh, v).forEach((x, a) => expect(x).toBeCloseTo(expected.getComponent(a), 9));
    }
  });

  it('rejects unsuitable input', () => {
    expect(() => transformVertices(cube, [], { translate: [1, 0, 0] })).toThrow('Select at least one vertex to transform');
    expect(() => transformVertices(cube, [8], { translate: [1, 0, 0] })).toThrow('Vertex 8 does not exist');
  });

  it.each(solidList)('%s stays a closed manifold', (_, mesh) => {
    const some = Array.from({ length: vertexCount(mesh) }, (__, v) => v).filter((v) => mesh.positions[v * 3 + 1] > 0);
    const result = expectSound(transformVertices(mesh, some, { translate: [0, 1, 0], rotate: [0, 20, 0], scale: [1.2, 1, 1.2] }));
    expect(meshStats(result.mesh)).toEqual(meshStats(mesh));
  });
});

describe('flip', () => {
  it('reverses the winding of the given faces and keeps their first vertex', () => {
    const result = flipFaces(cube, [TOP]);
    expect(result.mesh.faces[TOP]).toEqual([7, 3, 2, 6]);
    expect(faceNormal(result.mesh, result.mesh.faces[TOP])).toEqual([0, -1, 0]);
    expect(result.faces).toEqual([TOP]);
    expect(result.mesh.faces[0]).toBe(cube.faces[0]);
    expect(flipFaces(result.mesh, [TOP]).mesh.faces).toEqual(cube.faces);
    expect(() => flipFaces(cube, [6])).toThrow('Face 6 does not exist');
  });

  it.each(solidList)('%s: flipping every face keeps a closed manifold, inside out', (_, mesh) => {
    const all = mesh.faces.map((__, i) => i);
    const result = expectSound(flipFaces(mesh, all));
    mesh.faces.forEach((face, f) => {
      const n = faceNormal(mesh, face);
      faceNormal(result.mesh, result.mesh.faces[f]).forEach((x, a) => expect(x).toBeCloseTo(-n[a]));
    });
  });
});

describe('chains of operations', () => {
  it.each(solidList)('%s: inset, extrude, subdivide, merge, delete, fill', (_, mesh) => {
    const up = selectBy(mesh, 'face', { normal: [0, 1, 0], angle: 50 }).faces as number[];
    const inset = expectSound(insetFaces(mesh, up, 0.02, 0, false));
    const extruded = expectSound(extrudeFaces(inset.mesh, inset.faces!, 0.4));
    const again = expectSound(extrudeFaces(extruded.mesh, extruded.faces!, 0.2));
    const subdivided = expectSound(subdivideFaces(again.mesh, again.faces!, 2));
    const one = subdivided.faces![0];
    const merged = expectSound(mergeVertices(subdivided.mesh, subdivided.mesh.faces[one], 'center'));
    const welded = expectSound(mergeByDistance(merged.mesh, null, 1e-6));
    expect(meshStats(welded.mesh)).toEqual(meshStats(merged.mesh));
    const opened = expectSound(deleteElements(welded.mesh, { faces: [0] }), false);
    const rim = [...edgeFaces(opened.mesh)].filter(([, faces]) => faces.length === 1).map(([key]) => key.split(':').map(Number) as unknown as Edge);
    expectSound(fillFace(opened.mesh, [], rim));
  });
});
