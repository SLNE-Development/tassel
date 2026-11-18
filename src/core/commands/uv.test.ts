import { beforeEach, describe, expect, it } from 'vitest';
import { commandTitles } from '../../i18n/en';
import { polyMeshSchema } from '../mesh/polymesh';
import { uvArea, uvCharts } from '../mesh/uv';
import { evaluateObject } from '../modifiers/evaluate';
import { parseProject, serializeProject } from '../project';
import { activeDoc, createAppState } from '../state';
import type { AppState, DocState, PolyMesh } from '../types';
import { commands, commandsById } from './index';
import { runCommand, type CommandContext } from './registry';
import { uvCommands } from './uv';

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
  const def = commandsById.get(id);
  if (!def) throw new Error(`Unknown command ${id}`);
  return runCommand(def, ctx, params);
}

const doc = () => activeDoc(app);
const state = (): DocState => doc().state;
const meshOf = (id: string): PolyMesh => state().objects[id].mesh;

// Cube faces: 0 +Z [4,5,6,7], 1 -Z [1,0,3,2], 2 +X [5,1,2,6], 3 -X [0,4,7,3], 4 +Y [7,6,2,3], 5 -Y [0,1,5,4].
let cube: string;

function box(uvs: readonly (readonly number[])[]) {
  const min = [Infinity, Infinity];
  const max = [-Infinity, -Infinity];
  for (const uv of uvs) {
    uv.forEach((x, i) => {
      min[i % 2] = Math.min(min[i % 2], x);
      max[i % 2] = Math.max(max[i % 2], x);
    });
  }
  return { min, max };
}

beforeEach(async () => {
  app = createAppState();
  cube = (await run('scene.add_primitive', { type: 'cube' })).id;
});

describe('registration', () => {
  it('the uv commands are registered, documented and have English titles', () => {
    expect(uvCommands.map((c) => c.id)).toEqual(['uv.unwrap', 'uv.clear', 'uv.transform', 'uv.pack', 'uv.get']);
    for (const command of uvCommands) {
      expect(commands).toContain(command);
      expect(command.description.length).toBeGreaterThan(60);
      expect(command.title).not.toBe('');
      expect(commandTitles[command.id]).toBeTruthy();
    }
  });
});

describe('uv.unwrap', () => {
  it('smart is the default: six charts on a cube, as one undo step', async () => {
    expect(meshOf(cube).uvs).toBeUndefined();
    const before = meshOf(cube);
    const result = await run('uv.unwrap');
    expect(result).toEqual({ charts: 6, coverage: expect.closeTo(0.5643, 3) });
    const mesh = meshOf(cube);
    expect(mesh.positions).toBe(before.positions);
    expect(mesh.faces).toBe(before.faces);
    expect(polyMeshSchema.safeParse(mesh).success).toBe(true);
    expect(uvCharts(mesh).length).toBe(6);
    expect(doc().dirty).toBe(true);
    // The selection is untouched.
    expect(state().selection).toEqual([cube]);
    expect(state().edit).toBeNull();

    await run('history.undo');
    expect(meshOf(cube)).toBe(before);
    await run('history.redo');
    expect(meshOf(cube)).toBe(mesh);
  });

  it('takes an object id, a method, an axis, an angle and a margin', async () => {
    const sphere = (await run('scene.add_primitive', { type: 'uv_sphere' })).id;
    expect(state().activeId).toBe(sphere);
    expect((await run('uv.unwrap', { objectId: cube, method: 'box' })).charts).toBe(6);
    expect(meshOf(sphere).uvs).toBeUndefined();
    expect(meshOf(cube).uvs).toBeDefined();

    const wide = await run('uv.unwrap', { angle: 80 });
    const narrow = await run('uv.unwrap', { angle: 20, margin: 0.01 });
    expect(narrow.charts).toBeGreaterThan(wide.charts);
    expect(box(meshOf(sphere).uvs!).min[0]).toBeCloseTo(0.01, 4);

    expect(await run('uv.unwrap', { method: 'sphere' })).toEqual({ charts: 1, coverage: expect.any(Number) });
    expect((await run('uv.unwrap', { method: 'cylinder', axis: 'x' })).charts).toBeGreaterThanOrEqual(1);
    await run('uv.unwrap', { objectId: cube, method: 'planar', axis: 'z' });
    expect(meshOf(cube).uvs![0]).toEqual([0, 0, 1, 0, 1, 1, 0, 1]);
  });

  it('explains what is wrong', async () => {
    await expect(run('uv.unwrap', { objectId: 'nope' })).rejects.toThrow('Object "nope" does not exist');
    await expect(run('uv.unwrap', { method: 'lscm' })).rejects.toThrow();
    await expect(run('uv.unwrap', { angle: 120 })).rejects.toThrow();
    await expect(run('uv.unwrap', { margin: 0.6 })).rejects.toThrow();
    await run('scene.select', { ids: [] });
    await expect(run('uv.unwrap')).rejects.toThrow('no active object');
    await expect(run('uv.get')).rejects.toThrow('no active object');
    expect(doc().past.length).toBe(1);
  });

  it('edit mode: only the selected faces are unwrapped', async () => {
    await run('edit.enter');
    await run('edit.set_element_mode', { mode: 'face' });
    await run('mesh.select', { indices: [4] });
    expect(await run('uv.unwrap')).toEqual({ charts: 1, coverage: expect.closeTo(0.9216, 4) });
    let uvs = meshOf(cube).uvs!;
    expect(box([uvs[4]])).toEqual({ min: [0.02, 0.02], max: [0.98, 0.98] });
    for (const f of [0, 1, 2, 3, 5]) expect(uvs[f]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    // The element selection survives.
    expect(state().edit).toMatchObject({ elementMode: 'face', faces: [4] });

    // Nothing selected: all faces.
    await run('mesh.select_none');
    expect((await run('uv.unwrap')).charts).toBe(6);
    const all = meshOf(cube).uvs!;

    // Two faces again; the other four keep what they have.
    await run('mesh.select', { indices: [0, 2] });
    expect((await run('uv.unwrap', { method: 'box', margin: 0.1 })).charts).toBe(2);
    uvs = meshOf(cube).uvs!;
    for (const f of [1, 3, 4, 5]) expect(uvs[f]).toBe(all[f]);
    expect(box([uvs[0], uvs[2]]).min).toEqual([0.1, expect.any(Number)]);
    expect(box([uvs[0], uvs[2]]).max[0]).toBeCloseTo(0.9, 5);
  });

  it('edit mode: vertex and edge selections count as the faces they fill', async () => {
    await run('uv.unwrap');
    const all = meshOf(cube).uvs!;
    await run('edit.enter');
    await run('edit.set_element_mode', { mode: 'vertex' });
    // The four vertices of the top face.
    await run('mesh.select', { indices: [7, 6, 2, 3] });
    await run('uv.unwrap', { method: 'planar' });
    let uvs = meshOf(cube).uvs!;
    expect(uvs[4]).toEqual([0, 0, 1, 0, 1, 1, 0, 1]);
    for (const f of [0, 1, 2, 3, 5]) expect(uvs[f]).toBe(all[f]);

    // Two vertices fill no face: everything is unwrapped.
    await run('mesh.select', { indices: [0, 1] });
    await run('uv.unwrap', { method: 'planar' });
    uvs = meshOf(cube).uvs!;
    expect(uvs[5]).toEqual([0, 1, 1, 1, 1, 0, 0, 0]);

    await run('edit.set_element_mode', { mode: 'edge' });
    await run('mesh.select', { edges: [[4, 5], [5, 6], [6, 7], [4, 7]] });
    expect((await run('uv.unwrap', { method: 'smart' })).charts).toBe(1);
    expect(box([meshOf(cube).uvs![0]])).toEqual({ min: [0.02, 0.02], max: [0.98, 0.98] });
  });

  it('edit mode of another object does not limit the faces', async () => {
    const other = (await run('scene.add_primitive', { type: 'cube' })).id;
    await run('edit.enter', { id: other });
    await run('edit.set_element_mode', { mode: 'face' });
    await run('mesh.select', { indices: [0] });
    expect((await run('uv.unwrap', { objectId: cube })).charts).toBe(6);
    expect((await run('uv.unwrap')).charts).toBe(1);
  });
});

describe('uv.clear', () => {
  it('removes the UVs, undoably', async () => {
    expect(await run('uv.clear')).toEqual({ hadUvs: false });
    expect(doc().past.length).toBe(1);
    await run('uv.unwrap');
    const mesh = meshOf(cube);
    expect(await run('uv.clear')).toEqual({ hadUvs: true });
    expect('uvs' in meshOf(cube)).toBe(false);
    expect(meshOf(cube).faces).toBe(mesh.faces);
    await run('history.undo');
    expect(meshOf(cube)).toBe(mesh);
  });

  it('clears the whole mesh also in edit mode', async () => {
    await run('uv.unwrap');
    await run('edit.enter');
    await run('edit.set_element_mode', { mode: 'face' });
    await run('mesh.select', { indices: [1] });
    await run('uv.clear');
    expect(meshOf(cube).uvs).toBeUndefined();
  });
});

describe('uv.transform', () => {
  beforeEach(async () => {
    await run('uv.unwrap', { method: 'planar' });
  });

  it('scales, rotates and moves about a pivot', async () => {
    // The top face is the unit square [0,0, 1,0, 1,1, 0,1].
    expect(await run('uv.transform', { scale: 0.5 })).toEqual({ faces: 6 });
    expect(meshOf(cube).uvs![4]).toEqual([0.25, 0.25, 0.75, 0.25, 0.75, 0.75, 0.25, 0.75]);
    await run('uv.transform', { scale: [2, 4], pivot: [0.25, 0.25] });
    expect(meshOf(cube).uvs![4]).toEqual([0.25, 0.25, 1.25, 0.25, 1.25, 2.25, 0.25, 2.25]);
    await run('uv.transform', { rotate: 90, pivot: [0.25, 0.25] });
    expect(meshOf(cube).uvs![4]).toEqual([0.25, 0.25, 0.25, 1.25, -1.75, 1.25, -1.75, 0.25]);
    await run('uv.transform', { translate: [1.75, -0.25] });
    expect(meshOf(cube).uvs![4]).toEqual([2, 0, 2, 1, 0, 1, 0, 0]);
    expect(uvArea(meshOf(cube).uvs![4])).toBe(2);
    await run('history.undo');
    expect(meshOf(cube).uvs![4]).toEqual([0.25, 0.25, 0.25, 1.25, -1.75, 1.25, -1.75, 0.25]);
  });

  it('edit mode: only the selected faces move', async () => {
    const before = meshOf(cube).uvs!;
    await run('edit.enter');
    await run('edit.set_element_mode', { mode: 'face' });
    await run('mesh.select', { indices: [4] });
    expect(await run('uv.transform', { translate: [0.5, 0] })).toEqual({ faces: 1 });
    const uvs = meshOf(cube).uvs!;
    expect(uvs[4]).toEqual([0.5, 0, 1.5, 0, 1.5, 1, 0.5, 1]);
    for (const f of [0, 1, 2, 3, 5]) expect(uvs[f]).toBe(before[f]);
    // The pivot defaults to the centre of the selected faces' UVs.
    await run('uv.transform', { scale: 0.5 });
    expect(meshOf(cube).uvs![4]).toEqual([0.75, 0.25, 1.25, 0.25, 1.25, 0.75, 0.75, 0.75]);
  });

  it('needs UVs and something to do', async () => {
    await expect(run('uv.transform', {})).rejects.toThrow('at least one of translate, rotate or scale');
    await run('uv.clear');
    await expect(run('uv.transform', { rotate: 10 })).rejects.toThrow('has no UVs yet. Create them with uv.unwrap first');
    await expect(run('uv.pack')).rejects.toThrow('has no UVs yet');
  });
});

describe('uv.pack', () => {
  it('packs the charts again after they were scaled', async () => {
    const fresh = await run('uv.unwrap');
    await run('edit.enter');
    await run('edit.set_element_mode', { mode: 'face' });
    await run('mesh.select', { indices: [0] });
    await run('uv.transform', { scale: 3 });
    await run('mesh.select', { indices: [5] });
    await run('uv.transform', { scale: 0.2, translate: [3, 3] });
    await run('edit.exit');
    expect(box(meshOf(cube).uvs!).max[0]).toBeGreaterThan(1);

    const result = await run('uv.pack');
    expect(result).toEqual({ charts: 6, coverage: expect.closeTo(fresh.coverage, 3) });
    const uvs = meshOf(cube).uvs!;
    const areas = uvs.map(uvArea);
    for (const area of areas) expect(area).toBeCloseTo(areas[0], 4);
    expect(box(uvs).min[0]).toBeCloseTo(0.02, 4);
    expect(box(uvs).max[0]).toBeCloseTo(0.98, 4);

    const wide = await run('uv.pack', { margin: 0.1 });
    expect(wide.coverage).toBeLessThan(result.coverage);
    expect(box(meshOf(cube).uvs!).min[0]).toBeCloseTo(0.1, 4);
    await run('history.undo');
    expect(meshOf(cube).uvs).toBe(uvs);
  });

  it('edit mode: only the charts of the selected faces', async () => {
    await run('uv.unwrap');
    const before = meshOf(cube).uvs!;
    await run('edit.enter');
    await run('edit.set_element_mode', { mode: 'face' });
    await run('mesh.select', { indices: [0, 1] });
    expect((await run('uv.pack', { margin: 0.05 })).charts).toBe(2);
    const uvs = meshOf(cube).uvs!;
    for (const f of [2, 3, 4, 5]) expect(uvs[f]).toBe(before[f]);
    expect(box([uvs[0], uvs[1]]).min[0]).toBeCloseTo(0.05, 4);
    expect(box([uvs[0], uvs[1]]).max[0]).toBeCloseTo(0.95, 4);
  });
});

describe('uv.get', () => {
  it('lists the UVs per face with their chart and pages', async () => {
    expect(await run('uv.get')).toEqual({ hasUvs: false, charts: 0, total: 0, faces: [] });
    await run('uv.unwrap');
    const all = await run('uv.get');
    expect(all).toMatchObject({ hasUvs: true, charts: 6, total: 6 });
    expect(all.faces.map((f: { index: number }) => f.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(all.faces.map((f: { chart: number }) => f.chart)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(all.faces[2].uvs).toBe(meshOf(cube).uvs![2]);
    const page = await run('uv.get', { offset: 4, limit: 1 });
    expect(page.total).toBe(6);
    expect(page.faces).toEqual([{ index: 4, chart: 4, uvs: meshOf(cube).uvs![4] }]);
    // A query: no undo step, nothing changes.
    expect(doc().past.length).toBe(2);
  });

  it('edit mode: the selected faces', async () => {
    await run('uv.unwrap', { method: 'cylinder' });
    await run('edit.enter');
    await run('edit.set_element_mode', { mode: 'face' });
    expect((await run('uv.get')).total).toBe(6);
    await run('mesh.select', { indices: [5, 2] });
    const result = await run('uv.get');
    expect(result.total).toBe(2);
    expect(result.charts).toBe(uvCharts(meshOf(cube)).length);
    expect(result.faces.map((f: { index: number }) => f.index).sort()).toEqual([2, 5]);
  });
});

describe('mesh commands and UVs', () => {
  beforeEach(async () => {
    await run('uv.unwrap');
    await run('edit.enter');
    await run('edit.set_element_mode', { mode: 'face' });
    await run('mesh.select', { indices: [4] });
  });

  const aligned = () => {
    const mesh = meshOf(cube);
    expect(polyMeshSchema.safeParse(mesh).success).toBe(true);
    return mesh;
  };

  it.each([
    ['mesh.extrude', {}],
    ['mesh.inset', {}],
    ['mesh.subdivide', {}],
    ['mesh.bevel', {}],
    ['mesh.loop_cut', { edge: [0, 1] }],
  ])('%s drops the UVs and says so', async (id, params) => {
    const before = meshOf(cube);
    const result = await run(id, params);
    expect(result.uvsDropped).toBe(true);
    expect(aligned().uvs).toBeUndefined();
    expect(commandsById.get(id)!.description).toContain('uvsDropped');
    await run('history.undo');
    expect(meshOf(cube)).toBe(before);
    expect(meshOf(cube).uvs).toBeDefined();
    // Without UVs there is nothing to report.
    await run('uv.clear');
    expect('uvsDropped' in (await run(id, params))).toBe(false);
  });

  it('mesh.fill drops the UVs', async () => {
    await run('mesh.delete');
    expect(aligned().uvs!.length).toBe(5);
    await run('edit.set_element_mode', { mode: 'vertex' });
    await run('mesh.select', { indices: [7, 6, 2, 3] });
    const result = await run('mesh.fill');
    expect(result).toMatchObject({ faces: 6, uvsDropped: true });
    expect(aligned().uvs).toBeUndefined();
    expect(commandsById.get('mesh.fill')!.description).toContain('uvsDropped');
  });

  it('mesh.transform, mesh.flip_normals, mesh.delete and the merges keep them', async () => {
    const uvs = meshOf(cube).uvs!;
    let result = await run('mesh.transform', { translate: [0, 1, 0] });
    expect(result.uvsDropped).toBeUndefined();
    expect(aligned().uvs).toBe(uvs);

    result = await run('mesh.flip_normals');
    expect(result.uvsDropped).toBeUndefined();
    expect(aligned().uvs![4]).toEqual([uvs[4][0], uvs[4][1], uvs[4][6], uvs[4][7], uvs[4][4], uvs[4][5], uvs[4][2], uvs[4][3]]);
    expect(meshOf(cube).faces[4]).toEqual([7, 3, 2, 6]);

    result = await run('mesh.merge_by_distance', { distance: 0.001 });
    expect(result).toMatchObject({ removedVertices: 0 });
    expect(result.uvsDropped).toBeUndefined();

    result = await run('mesh.merge');
    expect(result).toMatchObject({ faces: 5 });
    expect(result.uvsDropped).toBeUndefined();
    expect(aligned().uvs!.map((uv) => uv.length).sort()).toEqual([6, 6, 6, 6, 8]);

    await run('mesh.select', { indices: [0] });
    result = await run('mesh.delete');
    expect(result.uvsDropped).toBeUndefined();
    expect(aligned().uvs!.length).toBe(4);

    await run('mesh.select_all');
    result = await run('mesh.merge_by_distance', { distance: 10 });
    expect(result.uvsDropped).toBeUndefined();
    aligned();
  });
});

describe('UVs elsewhere', () => {
  it('modifiers carry them into the evaluated mesh', async () => {
    await run('uv.unwrap');
    await run('modifier.add', { type: 'array', count: 3 });
    await run('modifier.add', { type: 'subdivision', levels: 1 });
    const { mesh } = evaluateObject(state(), cube);
    expect(mesh.faces.length).toBe(72);
    expect(mesh.uvs!.length).toBe(72);
    expect(polyMeshSchema.safeParse(mesh).success).toBe(true);
  });

  it('project files keep UVs', async () => {
    await run('scene.add_primitive', { type: 'torus' });
    await run('uv.unwrap', { method: 'smart' });
    await run('uv.unwrap', { objectId: cube, method: 'cylinder' });
    await run('scene.add_primitive', { type: 'cone' });
    const parsed = parseProject(serializeProject(doc()));
    expect(parsed.state.objects).toEqual(state().objects);
    const ids = state().order;
    expect(parsed.state.objects[ids[0]].mesh.uvs).toEqual(meshOf(cube).uvs);
    expect(parsed.state.objects[ids[1]].mesh.uvs!.length).toBe(meshOf(ids[1]).faces.length);
    expect('uvs' in parsed.state.objects[ids[2]].mesh).toBe(false);

    // Through the commands as well.
    const { json } = await run('document.serialize');
    await run('document.load', { json });
    expect(state().objects[ids[0]].mesh.uvs).toEqual(parsed.state.objects[ids[0]].mesh.uvs);
  });

  it('project files with misaligned UVs are rejected', async () => {
    await run('uv.unwrap');
    const project = JSON.parse(serializeProject(doc()));
    project.objects[0].mesh.uvs.pop();
    expect(() => parseProject(JSON.stringify(project))).toThrow('uvs must have one entry per face');
    project.objects[0].mesh.uvs.push([0, 0, 1]);
    expect(() => parseProject(JSON.stringify(project))).toThrow('uvs must hold two numbers per face corner');
  });
});
