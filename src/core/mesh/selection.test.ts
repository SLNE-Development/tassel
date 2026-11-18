import { describe, expect, it } from 'vitest';
import type { Edge, PolyMesh } from '../types';
import { edges } from './polymesh';
import { createPrimitive } from './primitives';
import {
  checkElements,
  combineSelection,
  convertSelection,
  invertSelection,
  listElements,
  makeSelection,
  selectAll,
  selectBy,
  selectedEdges,
  selectedFaces,
  selectedVertices,
  selectionFromElements,
  selectLess,
  selectLinked,
  selectMore,
} from './selection';

// Faces: 0 +Z [4,5,6,7], 1 -Z [1,0,3,2], 2 +X [5,1,2,6], 3 -X [0,4,7,3], 4 +Y [7,6,2,3], 5 -Y [0,1,5,4].
const cube = createPrimitive('cube');
const sorted = (list: readonly number[]) => [...list].sort((a, b) => a - b);
const keys = (list: readonly Edge[]) => list.map(([a, b]) => `${a}:${b}`).sort();

/** 3 x 3 grid of quads in the XZ plane: vertex (i, j) = i + 4 * j, face (i, j) = i + 3 * j. */
const grid: PolyMesh = (() => {
  const positions: number[] = [];
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) positions.push(i, 0, -j);
  const faces: number[][] = [];
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) faces.push([i + 4 * j, i + 1 + 4 * j, i + 5 + 4 * j, i + 4 + 4 * j]);
  return { positions, faces };
})();

describe('conversion', () => {
  it('face -> vertices / edges', () => {
    const sel = makeSelection('face', [4]);
    expect(selectedVertices(cube, sel)).toEqual([7, 6, 2, 3]);
    expect(keys(selectedEdges(cube, sel))).toEqual(['2:3', '2:6', '3:7', '6:7']);
    expect(convertSelection(cube, sel, 'vertex')).toEqual({ elementMode: 'vertex', vertices: [7, 6, 2, 3], edges: [], faces: [] });
  });

  it('vertex -> edge / face needs all vertices of the element', () => {
    expect(selectedFaces(cube, makeSelection('vertex', [7, 6, 2]))).toEqual([]);
    expect(keys(selectedEdges(cube, makeSelection('vertex', [7, 6, 2])))).toEqual(['2:6', '6:7']);
    expect(selectedFaces(cube, makeSelection('vertex', [7, 6, 2, 3]))).toEqual([4]);
    expect(selectedFaces(cube, makeSelection('vertex', [7, 6, 2, 3, 4, 5]))).toEqual([0, 4]);
  });

  it('edge <-> face goes through the vertices', () => {
    // Two opposite edges of the top face cover its four vertices.
    const sel = makeSelection('edge', [[6, 7], [2, 3]] as Edge[]);
    expect(selectedVertices(cube, sel)).toEqual([6, 7, 2, 3]);
    expect(selectedFaces(cube, sel)).toEqual([4]);
    expect(selectedFaces(cube, makeSelection('edge', [[6, 7]] as Edge[]))).toEqual([]);
  });

  it('round trips: face -> vertex -> face and face -> edge -> face', () => {
    for (const faces of [[4], [0, 4], [0, 1, 2, 3, 4, 5], []]) {
      const sel = makeSelection('face', faces);
      expect(convertSelection(cube, convertSelection(cube, sel, 'vertex'), 'face').faces).toEqual(faces);
      expect(convertSelection(cube, convertSelection(cube, sel, 'edge'), 'face').faces).toEqual(faces);
    }
    const torus = createPrimitive('torus', { segments: 8, minorSegments: 5 });
    const some = makeSelection('face', [0, 1, 7, 20, 21]);
    expect(convertSelection(torus, convertSelection(torus, some, 'vertex'), 'face').faces).toEqual(some.faces);
  });

  it('round trips: edge -> vertex -> edge for a closed outline, and the identity conversion', () => {
    const outline = makeSelection('edge', [[6, 7], [2, 6], [2, 3], [3, 7]] as Edge[]);
    expect(keys(convertSelection(cube, convertSelection(cube, outline, 'vertex'), 'edge').edges)).toEqual(keys(outline.edges));
    expect(convertSelection(cube, outline, 'edge')).toBe(outline);
  });

  it('selectionFromElements prefers the element kind of the mode', () => {
    expect(selectionFromElements(cube, 'face', { faces: [4], vertices: [0] }).faces).toEqual([4]);
    expect(selectionFromElements(cube, 'vertex', { faces: [4] }).vertices).toEqual([7, 6, 2, 3]);
    expect(selectionFromElements(cube, 'face', { vertices: [7, 6, 2, 3] }).faces).toEqual([4]);
    expect(keys(selectionFromElements(cube, 'edge', { faces: [4] }).edges)).toEqual(['2:3', '2:6', '3:7', '6:7']);
    expect(selectionFromElements(cube, 'edge', {})).toEqual(makeSelection('edge', []));
  });
});

describe('combineSelection', () => {
  it('replace, add, remove, toggle keep the selection order and avoid duplicates', () => {
    const sel = makeSelection('vertex', [5, 1]);
    expect(combineSelection(sel, [3, 3, 2], 'replace').vertices).toEqual([3, 2]);
    expect(combineSelection(sel, [1, 7], 'add').vertices).toEqual([5, 1, 7]);
    expect(combineSelection(sel, [5, 6], 'remove').vertices).toEqual([1]);
    expect(combineSelection(sel, [1, 2], 'toggle').vertices).toEqual([5, 2]);
  });

  it('treats [a, b] and [b, a] as the same edge', () => {
    const sel = makeSelection('edge', [[0, 1]] as Edge[]);
    expect(combineSelection(sel, [[1, 0], [2, 3]] as Edge[], 'toggle').edges).toEqual([[2, 3]]);
    expect(combineSelection(sel, [[1, 0]] as Edge[], 'add').edges).toHaveLength(1);
  });
});

describe('all / invert / linked / more / less', () => {
  it('selectAll per mode', () => {
    expect(selectAll(cube, 'vertex').vertices).toHaveLength(8);
    expect(selectAll(cube, 'edge').edges).toHaveLength(12);
    expect(selectAll(cube, 'face').faces).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('invert', () => {
    expect(invertSelection(cube, makeSelection('face', [4, 0])).faces).toEqual([1, 2, 3, 5]);
    expect(invertSelection(cube, makeSelection('vertex', [])).vertices).toHaveLength(8);
    const inverted = invertSelection(cube, makeSelection('edge', [[6, 7], [2, 3]] as Edge[]));
    expect(inverted.edges).toHaveLength(10);
    expect(keys(inverted.edges)).not.toContain('6:7');
    expect(invertSelection(cube, invertSelection(cube, makeSelection('face', [2]))).faces).toEqual([2]);
  });

  it('linked selects whole islands', () => {
    // Two cubes in one mesh.
    const two: PolyMesh = {
      positions: [...cube.positions, ...cube.positions.map((v, i) => (i % 3 === 0 ? v + 5 : v))],
      faces: [...cube.faces, ...cube.faces.map((f) => f.map((v) => v + 8))],
    };
    expect(selectLinked(two, makeSelection('vertex', [9])).vertices).toEqual([8, 9, 10, 11, 12, 13, 14, 15]);
    expect(selectLinked(two, makeSelection('face', [0])).faces).toEqual([0, 1, 2, 3, 4, 5]);
    expect(selectLinked(two, makeSelection('edge', [[0, 1], [8, 9]] as Edge[])).edges).toHaveLength(24);
    expect(selectLinked(two, makeSelection('face', [])).faces).toEqual([]);
  });

  it('more grows by one ring of faces', () => {
    expect(selectMore(grid, makeSelection('face', [4])).faces).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(selectMore(grid, makeSelection('face', [0])).faces).toEqual([0, 1, 3, 4]);
    expect(selectMore(grid, makeSelection('vertex', [0])).vertices).toEqual([0, 1, 4, 5]);
    expect(selectMore(grid, makeSelection('vertex', [5])).vertices).toEqual([0, 1, 2, 4, 5, 6, 8, 9, 10]);
    expect(selectMore(grid, makeSelection('face', [])).faces).toEqual([]);
  });

  it('less drops what touches a face that is not fully selected', () => {
    expect(selectLess(grid, makeSelection('face', [4])).faces).toEqual([]);
    expect(selectLess(grid, makeSelection('face', [0, 1, 3, 4])).faces).toEqual([0]);
    expect(selectLess(grid, makeSelection('vertex', [0, 1, 4, 5])).vertices).toEqual([0]);
    expect(selectLess(grid, makeSelection('vertex', [0, 1, 2, 4, 5, 6, 8, 9, 10])).vertices).toEqual([0, 1, 4, 5]);
    // The rim of an open mesh is not a border of the selection.
    expect(selectLess(grid, selectAll(grid, 'face')).faces).toHaveLength(9);
  });

  it('less undoes more on a closed mesh, in every mode', () => {
    const torus = createPrimitive('torus', { segments: 12, minorSegments: 10 });
    const face = makeSelection('face', [13]);
    expect(selectMore(torus, face).faces).toHaveLength(9);
    expect(selectLess(torus, selectMore(torus, face)).faces).toEqual([13]);
    expect(selectLess(torus, selectLess(torus, selectMore(torus, selectMore(torus, face)))).faces).toEqual([13]);

    const vertex = makeSelection('vertex', [20]);
    expect(selectMore(torus, vertex).vertices).toHaveLength(9);
    expect(selectLess(torus, selectMore(torus, vertex)).vertices).toEqual([20]);

    const edge = makeSelection('edge', [edges(torus)[5]]);
    const more = selectMore(torus, edge);
    expect(more.edges).toHaveLength(17); // 6 faces in a 2 x 3 block: 12 vertices, 17 edges
    expect(selectLess(torus, more).edges).toEqual(edge.edges);
  });
});

describe('selectBy', () => {
  it('normal: faces pointing a certain way', () => {
    expect(selectBy(cube, 'face', { normal: [0, 1, 0] }).faces).toEqual([4]);
    expect(selectBy(cube, 'face', { normal: [0, -5, 0] }).faces).toEqual([5]);
    expect(selectBy(cube, 'face', { normal: [0, 1, 0], angle: 90 }).faces).toEqual([0, 1, 2, 3, 4]);
    expect(selectBy(cube, 'face', { normal: [1, 1, 0], angle: 46 }).faces).toEqual([2, 4]);
    expect(selectBy(cube, 'face', { normal: [1, 1, 0], angle: 44 }).faces).toEqual([]);
    expect(() => selectBy(cube, 'face', { normal: [0, 0, 0] })).toThrow(/zero vector/);
  });

  it('normal in vertex / edge mode gives the elements of the matching faces', () => {
    expect(sorted(selectBy(cube, 'vertex', { normal: [0, 1, 0] }).vertices)).toEqual([2, 3, 6, 7]);
    expect(keys(selectBy(cube, 'edge', { normal: [0, 1, 0] }).edges)).toEqual(['2:3', '2:6', '3:7', '6:7']);
    const sphere = createPrimitive('uv_sphere', { segments: 8, rings: 4 });
    // The top cap: 8 triangles around the north pole.
    expect(selectBy(sphere, 'face', { normal: [0, 1, 0], angle: 45 }).faces).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(selectBy(sphere, 'vertex', { normal: [0, 1, 0], angle: 45 }).vertices).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('box: element centres inside, borders included, half-open boxes allowed', () => {
    expect(sorted(selectBy(cube, 'vertex', { boxMin: [-9, 1, -9], boxMax: [9, 1, 9] }).vertices)).toEqual([2, 3, 6, 7]);
    expect(sorted(selectBy(cube, 'vertex', { boxMin: [0, 0, 0] }).vertices)).toEqual([6]);
    expect(selectBy(cube, 'vertex', { boxMax: [0, 0, 0] }).vertices).toEqual([0]);
    // Face centroids: the top face is at y = 1, the side faces at y = 0.
    expect(selectBy(cube, 'face', { boxMin: [-9, 0.5, -9] }).faces).toEqual([4]);
    expect(selectBy(cube, 'face', { boxMin: [-9, 0, -9] }).faces).toEqual([0, 1, 2, 3, 4]);
    // Edge midpoints with y = 1: the four top edges.
    expect(keys(selectBy(cube, 'edge', { boxMin: [-9, 1, -9] }).edges)).toEqual(['2:3', '2:6', '3:7', '6:7']);
  });

  it('combines normal and box with AND', () => {
    expect(selectBy(cube, 'face', { normal: [0, 1, 0], angle: 90, boxMin: [0.5, -9, -9] }).faces).toEqual([2]);
    expect(selectBy(cube, 'vertex', { normal: [0, 1, 0], boxMin: [0, -9, -9] }).vertices).toEqual([2, 6]);
    expect(selectBy(cube, 'face', { normal: [0, 1, 0], boxMax: [9, 0, 9] }).faces).toEqual([]);
  });
});

describe('listElements', () => {
  const all = { selectedOnly: false, offset: 0, limit: 200 };

  it('describes vertices, edges and faces', () => {
    const sel = makeSelection('face', [4]);
    const vertices = listElements(cube, 'vertex', sel, all);
    expect(vertices.total).toBe(8);
    expect(vertices.elements[6]).toEqual({ index: 6, position: [1, 1, 1], selected: true });
    expect(vertices.elements[0]).toEqual({ index: 0, position: [-1, -1, -1], selected: false });

    const edgeList = listElements(cube, 'edge', sel, all);
    expect(edgeList.total).toBe(12);
    expect(edgeList.elements).toContainEqual({ vertices: [6, 7], midpoint: [0, 1, 1], length: 2, selected: true });
    expect(edgeList.elements).toContainEqual({ vertices: [4, 5], midpoint: [0, -1, 1], length: 2, selected: false });

    const faces = listElements(cube, 'face', sel, all);
    expect(faces.total).toBe(6);
    expect(faces.elements[4]).toEqual({ index: 4, vertices: [7, 6, 2, 3], centroid: [0, 1, 0], normal: [0, 1, 0], area: 4, selected: true });
    expect(faces.elements[5].selected).toBe(false);
  });

  it('selectedOnly, offset and limit', () => {
    const sel = makeSelection('vertex', [7, 6, 2, 3]);
    const selected = listElements(cube, 'vertex', sel, { selectedOnly: true, offset: 0, limit: 200 });
    expect(selected.total).toBe(4);
    expect(selected.elements.map((e) => 'index' in e && e.index)).toEqual([2, 3, 6, 7]);
    const page = listElements(cube, 'vertex', sel, { selectedOnly: false, offset: 6, limit: 5 });
    expect(page.total).toBe(8);
    expect(page.elements).toHaveLength(2);
    expect(listElements(cube, 'face', sel, { selectedOnly: true, offset: 0, limit: 200 }).elements).toHaveLength(1);
    expect(listElements(cube, 'edge', sel, { selectedOnly: true, offset: 1, limit: 2 })).toMatchObject({ total: 4, elements: { length: 2 } });
  });
});

describe('checkElements', () => {
  it('accepts existing elements and normalizes edges', () => {
    expect(checkElements(cube, 'vertex', [0, 7])).toEqual([0, 7]);
    expect(checkElements(cube, 'face', [5])).toEqual([5]);
    expect(checkElements(cube, 'edge', [[7, 6]] as Edge[])).toEqual([[6, 7]]);
    expect(edges(cube)).toContainEqual([6, 7]);
  });

  it('rejects elements that do not exist', () => {
    expect(() => checkElements(cube, 'vertex', [8])).toThrow('Vertex 8 does not exist (the mesh has 8)');
    expect(() => checkElements(cube, 'face', [6])).toThrow('Face 6 does not exist');
    expect(() => checkElements(cube, 'edge', [[0, 6]] as Edge[])).toThrow('no edge between vertices 0 and 6');
  });
});
