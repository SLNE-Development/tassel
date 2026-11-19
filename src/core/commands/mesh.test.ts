import { beforeEach, describe, expect, it, vi } from 'vitest';
import { meshProblems } from '../mesh/ops/checks';
import { faceNormal } from '../mesh/polymesh';
import { activeDoc, createAppState } from '../state';
import type { AppState, DocState, EditState, PolyMesh } from '../types';
import { documentCommands } from './document';
import { meshCommands } from './mesh';
import { runCommand, type AnyCommand, type CommandContext } from './registry';
import { sceneCommands } from './scene';

// Bevel and the loop tools are implemented elsewhere; here only the wiring is tested.
vi.mock('../mesh/ops/bevel', () => ({ bevelEdges: vi.fn() }));
vi.mock('../mesh/ops/loops', () => ({ edgeLoop: vi.fn(), edgeRing: vi.fn(), loopCut: vi.fn() }));
const { bevelEdges } = await import('../mesh/ops/bevel');
const { edgeLoop, edgeRing, loopCut } = await import('../mesh/ops/loops');

const byId = new Map<string, AnyCommand>([...documentCommands, ...sceneCommands, ...meshCommands].map((c) => [c.id, c]));

let app: AppState;
const ctx: CommandContext = {
  get: () => app,
  set: (update) => {
    app = update(app);
  },
  services: { viewport: null, exporter: null },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function run(id: string, params?: unknown): Promise<any> {
  const def = byId.get(id);
  if (!def) throw new Error(`Unknown command ${id}`);
  return runCommand(def, ctx, params);
}

const doc = () => activeDoc(app);
const state = (): DocState => doc().state;
const edit = (): EditState => state().edit!;
const mesh = (): PolyMesh => state().objects[edit().objectId].mesh;
const positionsOf = (vertices: readonly number[]) =>
  vertices.map((v) => mesh().positions.slice(v * 3, v * 3 + 3)).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);

// Cube faces: 0 +Z [4,5,6,7], 1 -Z [1,0,3,2], 2 +X [5,1,2,6], 3 -X [0,4,7,3], 4 +Y [7,6,2,3], 5 -Y [0,1,5,4].
let cube: string;

/** A cube in edit mode with the given element mode. */
async function editCube(mode: 'vertex' | 'edge' | 'face' = 'face') {
  cube = (await run('scene.add_primitive', { type: 'cube' })).id;
  await run('edit.enter');
  await run('edit.set_element_mode', { mode });
}

beforeEach(async () => {
  vi.resetAllMocks();
  app = createAppState();
});

describe('edit mode', () => {
  it('enter edits the active object, starting in vertex mode with nothing selected', async () => {
    const a = (await run('scene.add_primitive', { type: 'cube' })).id;
    const b = (await run('scene.add_primitive', { type: 'cone' })).id;
    await run('scene.select', { ids: [a, b] });
    expect(state().edit).toBeNull();
    const result = await run('edit.enter');
    expect(result).toMatchObject({ objectId: b, elementMode: 'vertex', vertices: 33 });
    expect(state().edit).toEqual({ objectId: b, elementMode: 'vertex', vertices: [], edges: [], faces: [] });
    // The edited object becomes the only selected one.
    expect(state().selection).toEqual([b]);
    expect(state().activeId).toBe(b);
  });

  it('enter takes an object id and switches between objects', async () => {
    const a = (await run('scene.add_primitive', { type: 'cube' })).id;
    const b = (await run('scene.add_primitive', { type: 'cone' })).id;
    await run('edit.enter', { id: a });
    expect(edit().objectId).toBe(a);
    expect(state().selection).toEqual([a]);
    await run('mesh.select', { indices: [1, 2] });
    // Entering again for the same object keeps the selection.
    await run('edit.enter', { id: a });
    expect(edit().vertices).toEqual([1, 2]);
    await run('edit.enter', { id: b });
    expect(edit()).toMatchObject({ objectId: b, vertices: [] });
    expect(state().activeId).toBe(b);
  });

  it('enter fails without an object', async () => {
    await expect(run('edit.enter')).rejects.toThrow('there is no active object');
    await expect(run('edit.enter', { id: 'nope' })).rejects.toThrow('Object "nope" does not exist');
    expect(state().edit).toBeNull();
  });

  it('exit and toggle', async () => {
    const a = (await run('scene.add_primitive', { type: 'cube' })).id;
    expect(await run('edit.toggle')).toMatchObject({ mode: 'edit', objectId: a });
    expect(edit().objectId).toBe(a);
    expect(await run('edit.toggle')).toEqual({ mode: 'object' });
    expect(state().edit).toBeNull();
    expect(state().selection).toEqual([a]);
    await run('edit.enter');
    await run('edit.exit');
    expect(state().edit).toBeNull();
    await run('edit.exit'); // harmless in object mode
    await run('scene.select', { ids: [] });
    await expect(run('edit.toggle')).rejects.toThrow('there is no active object');
  });

  it('remembers the element mode per document', async () => {
    await editCube('edge');
    await run('edit.exit');
    await run('edit.enter');
    expect(edit().elementMode).toBe('edge');
    // A new document starts in vertex mode again.
    await run('document.new');
    await run('scene.add_primitive', { type: 'cube' });
    await run('edit.enter');
    expect(edit().elementMode).toBe('vertex');
  });

  it('mode switches are not undo steps and do not mark the document dirty', async () => {
    cube = (await run('scene.add_primitive', { type: 'cube' })).id;
    await run('document.mark_saved');
    const { past } = doc();
    await run('edit.enter');
    await run('edit.set_element_mode', { mode: 'face' });
    await run('edit.exit');
    await run('edit.toggle');
    expect(doc().past).toBe(past);
    expect(doc().dirty).toBe(false);
  });

  it('deleting the edited object or selecting another one leaves edit mode', async () => {
    await editCube();
    await run('scene.delete_objects', { ids: [cube] });
    expect(state().edit).toBeNull();
    await editCube();
    const other = (await run('scene.add_primitive', { type: 'cone' })).id;
    expect(state().edit).toBeNull();
    await run('edit.enter', { id: cube });
    await run('scene.select', { ids: [other] });
    expect(state().edit).toBeNull();
  });

  it('set_element_mode converts the selection', async () => {
    await editCube('face');
    await run('mesh.select', { indices: [4] });
    expect(await run('edit.set_element_mode', { mode: 'vertex' })).toEqual({ elementMode: 'vertex', selected: 4 });
    expect(edit()).toEqual({ objectId: cube, elementMode: 'vertex', vertices: [7, 6, 2, 3], edges: [], faces: [] });
    expect(await run('edit.set_element_mode', { mode: 'edge' })).toEqual({ elementMode: 'edge', selected: 4 });
    expect(edit().vertices).toEqual([]);
    expect(edit().edges.map(([a, b]) => `${a}:${b}`).sort()).toEqual(['2:3', '2:6', '3:7', '6:7']);
    expect(await run('edit.set_element_mode', { mode: 'face' })).toEqual({ elementMode: 'face', selected: 1 });
    expect(edit()).toEqual({ objectId: cube, elementMode: 'face', vertices: [], edges: [], faces: [4] });
    // Three vertices of a quad do not select it.
    await run('edit.set_element_mode', { mode: 'vertex' });
    await run('mesh.select', { indices: [7], action: 'remove' });
    expect(await run('edit.set_element_mode', { mode: 'face' })).toEqual({ elementMode: 'face', selected: 0 });
    await expect(run('edit.set_element_mode', { mode: 'polygon' })).rejects.toThrow();
  });
});

describe('everything else requires edit mode', () => {
  const needEdit = meshCommands.map((c) => c.id).filter((id) => !['edit.enter', 'edit.exit', 'edit.toggle'].includes(id));

  it('covers every command of the contract', () => {
    expect(meshCommands.map((c) => c.id).sort()).toEqual(
      [
        'edit.enter', 'edit.exit', 'edit.toggle', 'edit.set_element_mode',
        'mesh.select', 'mesh.select_all', 'mesh.select_none', 'mesh.select_invert', 'mesh.select_linked', 'mesh.select_more',
        'mesh.select_less', 'mesh.select_loop', 'mesh.select_ring', 'mesh.select_by', 'mesh.get_elements',
        'mesh.extrude', 'mesh.inset', 'mesh.bevel', 'mesh.loop_cut', 'mesh.subdivide', 'mesh.merge', 'mesh.merge_by_distance',
        'mesh.delete', 'mesh.transform', 'mesh.flip_normals', 'mesh.fill',
      ].sort(),
    );
    for (const c of meshCommands) {
      expect(c.title.length, c.id).toBeGreaterThan(0);
      expect(c.description.length, c.id).toBeGreaterThan(40);
    }
  });

  it('selection, query and mode commands are not undoable, operations are', () => {
    const operations = ['extrude', 'inset', 'bevel', 'loop_cut', 'subdivide', 'merge', 'merge_by_distance', 'delete', 'transform', 'flip_normals', 'fill'];
    for (const c of meshCommands) {
      expect(c.history !== false, c.id).toBe(operations.includes(c.id.replace('mesh.', '')) && c.id.startsWith('mesh.'));
    }
  });

  it.each(needEdit)('%s refuses to run in object mode', async (id) => {
    await run('scene.add_primitive', { type: 'cube' });
    const before = app;
    const params: Record<string, unknown> = {
      'edit.set_element_mode': { mode: 'face' },
      'mesh.select': { indices: [0] },
      'mesh.select_loop': { edge: [0, 1] },
      'mesh.select_ring': { edge: [0, 1] },
      'mesh.select_by': { normal: [0, 1, 0] },
      'mesh.transform': { translate: [1, 0, 0] },
    };
    await expect(run(id, params[id] ?? {})).rejects.toThrow('Not in edit mode. Call edit.enter first');
    expect(app).toBe(before);
  });
});

describe('selection', () => {
  it('mesh.select: replace, add, remove, toggle', async () => {
    await editCube('face');
    expect(await run('mesh.select', { indices: [4, 0] })).toEqual({ elementMode: 'face', selected: 2 });
    expect(edit().faces).toEqual([4, 0]);
    await run('mesh.select', { indices: [1, 4], action: 'add' });
    expect(edit().faces).toEqual([4, 0, 1]);
    await run('mesh.select', { indices: [0], action: 'remove' });
    expect(edit().faces).toEqual([4, 1]);
    await run('mesh.select', { indices: [1, 5], action: 'toggle' });
    expect(edit().faces).toEqual([4, 5]);
    await run('mesh.select', { indices: [] });
    expect(edit().faces).toEqual([]);
  });

  it('mesh.select in edge mode takes vertex pairs in any order', async () => {
    await editCube('edge');
    await run('mesh.select', { edges: [[7, 6], [2, 3]] });
    expect(edit().edges).toEqual([[6, 7], [2, 3]]);
    await run('mesh.select', { edges: [[6, 7]], action: 'toggle' });
    expect(edit().edges).toEqual([[2, 3]]);
  });

  it('mesh.select explains wrong parameters and unknown elements', async () => {
    await editCube('edge');
    const before = app;
    await expect(run('mesh.select', { indices: [0] })).rejects.toThrow('The element mode is edge: pass `edges`');
    await expect(run('mesh.select', {})).rejects.toThrow('The element mode is edge: pass `edges`');
    await expect(run('mesh.select', { edges: [[0, 6]] })).rejects.toThrow('The mesh has no edge between vertices 0 and 6');
    await run('edit.set_element_mode', { mode: 'vertex' });
    await expect(run('mesh.select', { edges: [[0, 1]] })).rejects.toThrow('The element mode is vertex: pass `indices`');
    await expect(run('mesh.select', { indices: [8] })).rejects.toThrow('Vertex 8 does not exist');
    await expect(run('mesh.select', { indices: [-1] })).rejects.toThrow();
    await run('edit.set_element_mode', { mode: 'face' });
    await expect(run('mesh.select', { indices: [6] })).rejects.toThrow('Face 6 does not exist');
    expect(state().edit).toEqual({ ...before.docs[before.activeDocId].state.edit, elementMode: 'face' });
  });

  it('all, none, invert', async () => {
    await editCube('vertex');
    expect(await run('mesh.select_all')).toEqual({ elementMode: 'vertex', selected: 8 });
    expect(await run('mesh.select_none')).toEqual({ elementMode: 'vertex', selected: 0 });
    await run('mesh.select', { indices: [0, 1] });
    expect(await run('mesh.select_invert')).toEqual({ elementMode: 'vertex', selected: 6 });
    expect(edit().vertices).toEqual([2, 3, 4, 5, 6, 7]);
    await run('edit.set_element_mode', { mode: 'edge' });
    expect(await run('mesh.select_all')).toEqual({ elementMode: 'edge', selected: 12 });
  });

  it('linked, more, less', async () => {
    await run('scene.add_primitive', { type: 'torus', segments: 12, minorSegments: 10 });
    await run('edit.enter');
    await run('edit.set_element_mode', { mode: 'face' });
    await run('mesh.select', { indices: [33] });
    expect(await run('mesh.select_more')).toEqual({ elementMode: 'face', selected: 9 });
    expect(await run('mesh.select_less')).toEqual({ elementMode: 'face', selected: 1 });
    expect(edit().faces).toEqual([33]);
    expect(await run('mesh.select_linked')).toEqual({ elementMode: 'face', selected: 120 });
    expect(await run('mesh.select_less')).toEqual({ elementMode: 'face', selected: 120 });
  });

  it('select_by normal and box', async () => {
    await editCube('face');
    expect(await run('mesh.select_by', { normal: [0, 1, 0] })).toEqual({ elementMode: 'face', selected: 1 });
    expect(edit().faces).toEqual([4]);
    await run('mesh.select_by', { normal: [0, 0, 1], action: 'add' });
    expect(edit().faces).toEqual([4, 0]);
    await run('mesh.select_by', { normal: [0, 1, 0], angle: 100, boxMax: [0, 9, 9], action: 'remove' });
    expect(edit().faces).toEqual([]);
    await run('edit.set_element_mode', { mode: 'vertex' });
    await run('mesh.select_by', { boxMin: [-9, 0.5, -9], boxMax: [9, 9, 9] });
    expect(edit().vertices).toEqual([2, 3, 6, 7]);
    await run('mesh.select_by', { normal: [1, 0, 0], boxMin: [-9, 0.5, -9] });
    expect(edit().vertices).toEqual([2, 6]);
    await expect(run('mesh.select_by', {})).rejects.toThrow('Give at least one criterion');
    await expect(run('mesh.select_by', { normal: [0, 0, 0] })).rejects.toThrow('zero vector');
  });

  it('select_by uses the local space of the object', async () => {
    cube = (await run('scene.add_primitive', { type: 'cube', position: [10, 10, 10], rotation: [90, 0, 0] })).id;
    await run('edit.enter');
    await run('edit.set_element_mode', { mode: 'face' });
    await run('mesh.select_by', { normal: [0, 1, 0], boxMin: [-1, -1, -1], boxMax: [1, 1, 1] });
    expect(edit().faces).toEqual([4]);
  });

  it('get_elements lists elements with their selection state', async () => {
    await editCube('face');
    await run('mesh.select', { indices: [4] });
    const before = app;
    const faces = await run('mesh.get_elements');
    expect(faces).toMatchObject({ kind: 'face', total: 6 });
    expect(faces.elements[4]).toEqual({ index: 4, vertices: [7, 6, 2, 3], centroid: [0, 1, 0], normal: [0, 1, 0], area: 4, selected: true });
    const vertices = await run('mesh.get_elements', { kind: 'vertex', selectedOnly: true });
    expect(vertices.total).toBe(4);
    expect(vertices.elements.map((e: { index: number }) => e.index)).toEqual([2, 3, 6, 7]);
    expect(vertices.elements[0]).toEqual({ index: 2, position: [1, 1, -1], selected: true });
    const edges = await run('mesh.get_elements', { kind: 'edge', offset: 10, limit: 5 });
    expect(edges.total).toBe(12);
    expect(edges.elements).toHaveLength(2);
    expect(edges.elements[0]).toMatchObject({ vertices: expect.any(Array), midpoint: expect.any(Array), length: 2 });
    expect(app).toBe(before);
  });

  it('never creates undo steps, marks the document dirty or clears the redo stack', async () => {
    await editCube('face');
    await run('mesh.select', { indices: [4] });
    await run('mesh.extrude');
    await run('history.undo');
    await run('document.mark_saved');
    const { past, future } = doc();
    expect(future).toHaveLength(1);
    await run('mesh.select', { indices: [0, 1] });
    await run('mesh.select_all');
    await run('mesh.select_invert');
    await run('mesh.select_by', { normal: [0, 1, 0] });
    await run('mesh.select_more');
    await run('mesh.select_less');
    await run('mesh.select_linked');
    await run('mesh.select_none');
    await run('mesh.get_elements');
    await run('edit.set_element_mode', { mode: 'vertex' });
    expect(doc().past).toBe(past);
    expect(doc().future).toBe(future);
    expect(doc().dirty).toBe(false);
  });
});

describe('operations', () => {
  it('extrude: the top face of a cube by 1', async () => {
    await editCube('face');
    await run('mesh.select_by', { normal: [0, 1, 0] });
    const result = await run('mesh.extrude', { distance: 1 });
    expect(result).toEqual({
      vertices: 12, edges: 20, faces: 10, triangles: 20, elementMode: 'face', selected: 1,
      selectionBounds: { min: [-1, 2, -1], max: [1, 2, 1] },
    });
    expect(edit().faces).toEqual([4]);
    expect(positionsOf(mesh().faces[4])).toEqual([[-1, 2, -1], [-1, 2, 1], [1, 2, -1], [1, 2, 1]]);
    expect(meshProblems(mesh())).toEqual([]);
    expect(doc().dirty).toBe(true);
  });

  it('extrude defaults to 0.5 and converts the selection from and to the current mode', async () => {
    await editCube('vertex');
    await run('mesh.select', { indices: [7, 6, 2, 3] });
    expect(await run('mesh.extrude')).toMatchObject({ vertices: 12, faces: 10, elementMode: 'vertex', selected: 4 });
    expect(positionsOf(edit().vertices)).toEqual([[-1, 1.5, -1], [-1, 1.5, 1], [1, 1.5, -1], [1, 1.5, 1]]);
    await run('edit.set_element_mode', { mode: 'edge' });
    expect(await run('mesh.extrude')).toMatchObject({ vertices: 16, faces: 14, elementMode: 'edge', selected: 4 });
    expect(positionsOf(edit().edges.flat()).every((p) => p[1] === 2)).toBe(true);
  });

  it('inset then extrude', async () => {
    await editCube('face');
    await run('mesh.select', { indices: [4] });
    expect(await run('mesh.inset', { thickness: 0.5 })).toMatchObject({ vertices: 12, faces: 10, selected: 1 });
    expect(positionsOf(mesh().faces[4])).toEqual([[-0.5, 1, -0.5], [-0.5, 1, 0.5], [0.5, 1, -0.5], [0.5, 1, 0.5]]);
    expect(await run('mesh.extrude', { distance: -0.5 })).toMatchObject({ vertices: 16, faces: 14, selected: 1 });
    expect(positionsOf(mesh().faces[edit().faces[0]])).toEqual([[-0.5, 0.5, -0.5], [-0.5, 0.5, 0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5]]);
    expect(meshProblems(mesh())).toEqual([]);
  });

  it('inset: depth and individual', async () => {
    await editCube('face');
    await run('mesh.select', { indices: [4, 0] });
    expect(await run('mesh.inset', { thickness: 0.25, depth: 0.1, individual: true })).toMatchObject({ vertices: 16, faces: 14, selected: 2 });
    expect(positionsOf(mesh().faces[4]).every((p) => Math.abs(p[1] - 1.1) < 1e-12 && Math.abs(p[0]) === 0.75)).toBe(true);
    await expect(run('mesh.inset', { thickness: -1 })).rejects.toThrow();
  });

  it('subdivide', async () => {
    await editCube('face');
    await run('mesh.select', { indices: [4] });
    expect(await run('mesh.subdivide')).toMatchObject({ vertices: 13, faces: 9, selected: 4 });
    expect(edit().faces.every((f) => faceNormal(mesh(), mesh().faces[f])[1] === 1)).toBe(true);
    await run('mesh.select_all');
    // 4 + 1 quads become 9 quads each, the four side faces (now pentagons) 15 triangles each.
    expect(await run('mesh.subdivide', { cuts: 2 })).toMatchObject({ faces: 45 + 60, selected: 105 });
    expect(meshProblems(mesh())).toEqual([]);
    await expect(run('mesh.subdivide', { cuts: 0 })).rejects.toThrow();
  });

  it("merge: a cube's top face at its centre gives a pyramid", async () => {
    await editCube('face');
    await run('mesh.select', { indices: [4] });
    expect(await run('mesh.merge')).toEqual({
      vertices: 5, edges: 8, faces: 5, triangles: 6, elementMode: 'face', selected: 0, selectionBounds: null,
    });
    expect(meshProblems(mesh())).toEqual([]);
    expect(positionsOf([0, 1, 2, 3, 4])).toContainEqual([0, 1, 0]);
  });

  it('merge at the first / last selected vertex, selecting the merged vertex', async () => {
    await editCube('vertex');
    await run('mesh.select', { indices: [6, 7] });
    expect(await run('mesh.merge', { at: 'last' })).toMatchObject({ vertices: 7, selected: 1 });
    expect(positionsOf(edit().vertices)).toEqual([[-1, 1, 1]]);
    await run('history.undo');
    await run('mesh.merge', { at: 'first' });
    expect(positionsOf(edit().vertices)).toEqual([[1, 1, 1]]);
    await run('mesh.select_none');
    await expect(run('mesh.merge')).rejects.toThrow('mesh.merge needs at least two selected vertices (0 selected)');
  });

  it('merge_by_distance: selection or whole mesh, no undo step when nothing changes', async () => {
    await editCube('face');
    await run('mesh.select', { indices: [4] });
    await run('mesh.extrude', { distance: 0.001 });
    const past = doc().past.length;
    expect(await run('mesh.merge_by_distance')).toMatchObject({ removedVertices: 0, vertices: 12 });
    expect(doc().past).toHaveLength(past);
    // Limited to the selection (the moved face): its vertices are 2 apart, nothing to weld.
    expect(await run('mesh.merge_by_distance', { distance: 0.01 })).toMatchObject({ removedVertices: 0 });
    await run('mesh.select_none');
    expect(await run('mesh.merge_by_distance', { distance: 0.01 })).toEqual({
      removedVertices: 4, vertices: 8, edges: 12, faces: 6, triangles: 12, elementMode: 'face', selected: 0, selectionBounds: null,
    });
    expect(doc().past).toHaveLength(past + 1);
    expect(meshProblems(mesh())).toEqual([]);
  });

  it('delete: kind defaults to the element mode', async () => {
    await editCube('face');
    await run('mesh.select', { indices: [4] });
    expect(await run('mesh.delete')).toMatchObject({ vertices: 8, faces: 5, selected: 0 });
    expect(edit().faces).toEqual([]);
    await expect(run('mesh.delete')).rejects.toThrow('mesh.delete: no faces are selected');

    await run('edit.set_element_mode', { mode: 'vertex' });
    await run('mesh.select', { indices: [0] });
    expect(await run('mesh.delete')).toMatchObject({ vertices: 6, faces: 2 });
    await run('history.undo');
    // The same vertex, but only faces that it fully selects: none.
    await expect(run('mesh.delete', { kind: 'faces' })).rejects.toThrow('no faces are selected');
    await run('edit.set_element_mode', { mode: 'edge' });
    await run('mesh.select', { edges: [[0, 1]] });
    expect(await run('mesh.delete')).toMatchObject({ vertices: 8, faces: 3 });
    await run('history.undo');
    expect(await run('mesh.delete', { kind: 'vertices' })).toMatchObject({ vertices: 4, faces: 1 });
  });

  it('delete then fill closes the hole again', async () => {
    await editCube('face');
    await run('mesh.select', { indices: [4] });
    await run('mesh.delete');
    await run('edit.set_element_mode', { mode: 'vertex' });
    await run('mesh.select_by', { boxMin: [-9, 1, -9] });
    expect(await run('mesh.fill')).toMatchObject({ vertices: 8, faces: 6, elementMode: 'vertex', selected: 4 });
    expect(meshProblems(mesh())).toEqual([]);
    expect(faceNormal(mesh(), mesh().faces[5])).toEqual([0, 1, 0]);

    await run('history.undo');
    await run('edit.set_element_mode', { mode: 'edge' });
    expect(edit().edges).toHaveLength(4);
    expect(await run('mesh.fill')).toMatchObject({ faces: 6, elementMode: 'edge', selected: 4 });
    await run('edit.set_element_mode', { mode: 'face' });
    expect(edit().faces).toEqual([5]);
    await expect(run('mesh.fill')).rejects.toThrow(/Cannot fill: the selection must be the open edges around one hole/);
    await run('mesh.select_none');
    await expect(run('mesh.fill')).rejects.toThrow('Cannot fill: a face needs at least three vertices');
  });

  it('transform moves the selected vertices and keeps the selection', async () => {
    await editCube('face');
    await run('mesh.select', { indices: [4] });
    const selection = edit().faces;
    expect(await run('mesh.transform', { translate: [0, 1, 0], scale: [0.5, 1, 0.5] })).toMatchObject({ vertices: 8, selected: 1 });
    expect(edit().faces).toBe(selection);
    expect(positionsOf(mesh().faces[4])).toEqual([[-0.5, 2, -0.5], [-0.5, 2, 0.5], [0.5, 2, -0.5], [0.5, 2, 0.5]]);
    await run('mesh.transform', { rotate: [0, 0, 90], pivot: [0, 0, 0] });
    expect(positionsOf(mesh().faces[4]).every((p) => Math.abs(p[0] + 2) < 1e-12)).toBe(true);
    await expect(run('mesh.transform', {})).rejects.toThrow('Give at least one of translate, rotate or scale');
    await run('mesh.select_none');
    await expect(run('mesh.transform', { translate: [1, 0, 0] })).rejects.toThrow('mesh.transform: nothing is selected');
  });

  it('flip_normals: the selected faces, or all without a selection', async () => {
    await editCube('face');
    await run('mesh.select', { indices: [4] });
    await run('mesh.flip_normals');
    expect(faceNormal(mesh(), mesh().faces[4])).toEqual([0, -1, 0]);
    expect(faceNormal(mesh(), mesh().faces[5])).toEqual([0, -1, 0]);
    expect(edit().faces).toEqual([4]);
    await run('mesh.select_none');
    await run('mesh.flip_normals');
    expect(faceNormal(mesh(), mesh().faces[4])).toEqual([0, 1, 0]);
    expect(faceNormal(mesh(), mesh().faces[5])).toEqual([0, 1, 0]);
    await run('edit.set_element_mode', { mode: 'vertex' });
    await run('mesh.select', { indices: [0] });
    await expect(run('mesh.flip_normals')).rejects.toThrow('mesh.flip_normals needs at least one selected face');
  });

  it('operations explain an unsuitable selection and leave state and history alone', async () => {
    await editCube('face');
    const before = app;
    await expect(run('mesh.extrude')).rejects.toThrow('mesh.extrude needs at least one selected face, but nothing is selected');
    await expect(run('mesh.inset')).rejects.toThrow('mesh.inset needs at least one selected face');
    await expect(run('mesh.subdivide')).rejects.toThrow('mesh.subdivide needs at least one selected face');
    await expect(run('mesh.bevel')).rejects.toThrow('mesh.bevel needs at least one selected edge');
    await expect(run('mesh.loop_cut')).rejects.toThrow('pass `edge` or select exactly one edge (0 are selected)');
    await expect(run('mesh.delete')).rejects.toThrow('no faces are selected');
    expect(app).toBe(before);
    await run('mesh.select', { indices: [4, 5] });
    await expect(run('mesh.extrude')).rejects.toThrow(/opposite directions/);
    await run('edit.set_element_mode', { mode: 'vertex' });
    await run('mesh.select', { indices: [0, 1, 2] });
    await expect(run('mesh.extrude')).rejects.toThrow('in vertex mode a face counts as selected when all its vertices are selected');
    expect(doc().past).toHaveLength(1);
  });

  it('only the edited object changes; other objects keep their identity', async () => {
    const other = (await run('scene.add_primitive', { type: 'cone' })).id;
    await editCube('face');
    const otherBefore = state().objects[other];
    await run('mesh.select', { indices: [4] });
    await run('mesh.extrude');
    expect(state().objects[other]).toBe(otherBefore);
    expect(state().objects[cube].mesh.faces).toHaveLength(10);
  });
});

describe('undo', () => {
  it('restores mesh and selection together, redo brings both back', async () => {
    await editCube('face');
    await run('mesh.select', { indices: [4] });
    const before = state();
    await run('mesh.subdivide');
    const after = state();
    expect(after.edit!.faces).toHaveLength(4);
    expect(doc().past.at(-1)).toBe(before);

    await run('history.undo');
    expect(state()).toBe(before);
    expect(edit().faces).toEqual([4]);
    expect(mesh().faces).toHaveLength(6);

    await run('history.redo');
    expect(state()).toBe(after);
    expect(edit().faces).toHaveLength(4);
    expect(mesh().faces).toHaveLength(9);
  });

  it('every operation is exactly one undo step', async () => {
    await editCube('face');
    await run('mesh.select', { indices: [4] });
    const start = doc().past.length;
    await run('mesh.inset', { thickness: 0.2 });
    await run('mesh.extrude');
    await run('mesh.transform', { translate: [0, 1, 0] });
    await run('mesh.flip_normals');
    await run('mesh.subdivide');
    await run('mesh.merge');
    await run('mesh.select_all');
    await run('mesh.delete');
    expect(doc().past).toHaveLength(start + 7);
    expect(mesh().faces).toHaveLength(0);
    for (let i = 0; i < 7; i++) await run('history.undo');
    expect(mesh().faces).toHaveLength(6);
    expect(edit().faces).toEqual([4]);
    expect(mesh().positions).toEqual(state().objects[cube].mesh.positions);
  });

  it('a selection change between operations is restored with the operation before it', async () => {
    await editCube('face');
    await run('mesh.select', { indices: [4] });
    await run('mesh.extrude');
    await run('mesh.select', { indices: [0] });
    await run('mesh.extrude');
    await run('history.undo');
    // Back before the second extrude, with the selection it was run on.
    expect(mesh().faces).toHaveLength(10);
    expect(edit().faces).toEqual([0]);
    await run('history.undo');
    expect(mesh().faces).toHaveLength(6);
    expect(edit().faces).toEqual([4]);
    // Undoing past the point where the object was created leaves edit mode.
    await run('history.undo');
    expect(state().edit).toBeNull();
    expect(state().order).toEqual([]);
  });
});

describe('bevel and loop tools (mocked kernel functions)', () => {
  /** What the mocked kernel returns: the cube with one more vertex, so that a change is visible. */
  const changed = (): PolyMesh => ({ positions: [...mesh().positions, 0, 5, 0], faces: [...mesh().faces, [7, 6, 8]] });

  it('bevel passes the selected edges, width and segments and applies the result', async () => {
    await editCube('edge');
    await run('mesh.select', { edges: [[6, 7], [3, 2]] });
    const before = mesh();
    const result = changed();
    vi.mocked(bevelEdges).mockReturnValue({ mesh: result, faces: [6] });
    expect(await run('mesh.bevel', { width: 0.25, segments: 3 })).toMatchObject({
      vertices: 9, edges: 14, faces: 7, triangles: 13, elementMode: 'edge', selected: 3,
    });
    expect(bevelEdges).toHaveBeenCalledExactlyOnceWith(before, [[6, 7], [2, 3]], 0.25, 3);
    expect(mesh()).toBe(result);
    // The returned faces, converted to the current mode: the three edges of face 6.
    expect(edit().edges.map(([a, b]) => `${a}:${b}`).sort()).toEqual(['6:7', '6:8', '7:8']);
    await run('history.undo');
    expect(mesh()).toBe(before);
    expect(edit().edges).toEqual([[6, 7], [2, 3]]);
  });

  it('bevel uses the defaults and converts a face selection to its edges', async () => {
    await editCube('face');
    await run('mesh.select', { indices: [4] });
    vi.mocked(bevelEdges).mockReturnValue({ mesh: changed(), faces: [6] });
    expect(await run('mesh.bevel')).toMatchObject({ elementMode: 'face', selected: 1 });
    const [, edges, width, segments] = vi.mocked(bevelEdges).mock.calls[0];
    expect(edges.map(([a, b]) => `${a}:${b}`).sort()).toEqual(['2:3', '2:6', '3:7', '6:7']);
    expect([width, segments]).toEqual([0.1, 1]);
    expect(edit().faces).toEqual([6]);
    await expect(run('mesh.bevel', { width: 0 })).rejects.toThrow();
    await expect(run('mesh.bevel', { segments: 0 })).rejects.toThrow();
  });

  it('errors of the kernel reach the caller and change nothing', async () => {
    await editCube('edge');
    await run('mesh.select', { edges: [[6, 7]] });
    const before = app;
    vi.mocked(bevelEdges).mockImplementation(() => {
      throw new Error('width is too large');
    });
    await expect(run('mesh.bevel')).rejects.toThrow('width is too large');
    expect(app).toBe(before);
  });

  it('loop_cut takes an explicit edge (normalized) or the single selected edge', async () => {
    await editCube('edge');
    const before = mesh();
    vi.mocked(loopCut).mockImplementation(() => ({ mesh: changed(), edges: [[6, 8], [7, 8]] }));
    expect(await run('mesh.loop_cut', { edge: [7, 6], cuts: 3 })).toMatchObject({ vertices: 9, elementMode: 'edge', selected: 2 });
    expect(loopCut).toHaveBeenLastCalledWith(before, [6, 7], 3);
    expect(edit().edges).toEqual([[6, 8], [7, 8]]);

    await run('history.undo');
    await run('mesh.select', { edges: [[2, 3]] });
    await run('mesh.loop_cut');
    expect(loopCut).toHaveBeenLastCalledWith(before, [2, 3], 1);

    await run('history.undo');
    await run('mesh.select', { edges: [[2, 3], [6, 7]] });
    await expect(run('mesh.loop_cut')).rejects.toThrow('pass `edge` or select exactly one edge (2 are selected)');
    await expect(run('mesh.loop_cut', { edge: [0, 6] })).rejects.toThrow('The mesh has no edge between vertices 0 and 6');
    await expect(run('mesh.loop_cut', { edge: [6, 7], cuts: 0 })).rejects.toThrow();
    expect(loopCut).toHaveBeenCalledTimes(2);
  });

  it('loop_cut in vertex mode: two selected vertices of an edge name that edge; the result is converted', async () => {
    await editCube('vertex');
    await run('mesh.select', { indices: [6, 7] });
    vi.mocked(loopCut).mockImplementation(() => ({ mesh: changed(), edges: [[6, 8], [7, 8]] }));
    expect(await run('mesh.loop_cut')).toMatchObject({ elementMode: 'vertex', selected: 3 });
    expect(vi.mocked(loopCut).mock.calls[0].slice(1)).toEqual([[6, 7], 1]);
    expect(edit().vertices).toEqual([6, 8, 7]);
  });

  it('select_loop / select_ring select what the kernel returns, combined by action', async () => {
    await editCube('edge');
    vi.mocked(edgeLoop).mockReturnValue([[6, 7], [2, 6], [2, 3], [3, 7]]);
    vi.mocked(edgeRing).mockReturnValue([[6, 7], [4, 5], [0, 1], [2, 3]]);
    const past = doc().past;

    expect(await run('mesh.select_loop', { edge: [7, 6] })).toEqual({ elementMode: 'edge', selected: 4 });
    expect(edgeLoop).toHaveBeenCalledExactlyOnceWith(mesh(), [6, 7]);
    expect(edit().edges).toEqual([[6, 7], [2, 6], [2, 3], [3, 7]]);

    expect(await run('mesh.select_ring', { edge: [6, 7], action: 'add' })).toEqual({ elementMode: 'edge', selected: 6 });
    expect(edgeRing).toHaveBeenCalledExactlyOnceWith(mesh(), [6, 7]);
    expect(await run('mesh.select_loop', { edge: [6, 7], action: 'remove' })).toEqual({ elementMode: 'edge', selected: 2 });
    expect(edit().edges).toEqual([[4, 5], [0, 1]]);
    expect(await run('mesh.select_ring', { edge: [6, 7], action: 'toggle' })).toEqual({ elementMode: 'edge', selected: 2 });
    expect(edit().edges).toEqual([[6, 7], [2, 3]]);

    await expect(run('mesh.select_loop', { edge: [0, 6] })).rejects.toThrow('The mesh has no edge between vertices 0 and 6');
    await expect(run('mesh.select_ring', {})).rejects.toThrow();
    expect(doc().past).toBe(past);
  });

  it('select_loop / select_ring convert to vertex and face mode', async () => {
    await editCube('vertex');
    vi.mocked(edgeLoop).mockReturnValue([[6, 7], [2, 6], [2, 3], [3, 7]]);
    vi.mocked(edgeRing).mockReturnValue([[6, 7], [4, 5], [0, 1], [2, 3]]);
    await run('mesh.select_loop', { edge: [6, 7] });
    expect(edit().vertices).toEqual([6, 7, 2, 3]);
    await run('edit.set_element_mode', { mode: 'face' });
    await run('mesh.select_none');
    // The ring around the cube: all eight vertices, so in face mode every face.
    await run('mesh.select_ring', { edge: [6, 7] });
    expect(edit().faces).toEqual([0, 1, 2, 3, 4, 5]);
    await run('mesh.select_loop', { edge: [6, 7] });
    expect(edit().faces).toEqual([4]);
  });
});
