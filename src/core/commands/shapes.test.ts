import { beforeEach, describe, expect, it } from 'vitest';
import { boundingBox } from '../mesh/polymesh';
import { createPrimitive } from '../mesh/primitives';
import { isClosedManifold, volume } from '../modifiers/testing';
import { activeDoc, createAppState } from '../state';
import type { AppState, DocState } from '../types';
import { commandsById } from './index';
import { runCommand, type CommandContext } from './registry';

let app: AppState;
const ctx = {
  get: () => app,
  set: (update: (app: AppState) => AppState) => {
    app = update(app);
  },
  services: {},
} as unknown as CommandContext;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function run(id: string, params?: unknown): Promise<any> {
  const def = commandsById.get(id);
  if (!def) throw new Error(`Unknown command ${id}`);
  return runCommand(def, ctx, params);
}

const state = (): DocState => activeDoc(app).state;

beforeEach(() => {
  app = createAppState();
});

describe('scene.add_primitive: cube dimensions and arc', () => {
  it('makes a box from dimensions', async () => {
    const { id } = await run('scene.add_primitive', { type: 'cube', dimensions: [4, 0.2, 1], position: [0, 1, 0] });
    expect(boundingBox(state().objects[id].mesh)).toEqual({ min: [-2, -0.1, -0.5], max: [2, 0.1, 0.5] });
    await expect(run('scene.add_primitive', { type: 'cube', dimensions: [4, -0.2, 1] })).rejects.toThrow();
    await expect(run('scene.add_primitive', { type: 'cube', dimensions: [4, 1] })).rejects.toThrow();
  });

  it('makes a conveyor curve from an arc', async () => {
    const result = await run('scene.add_primitive', { type: 'arc', innerRadius: 2, outerRadius: 3, height: 0.1, angle: 90, segments: 12, position: [5, 0.8, 0] });
    expect(result.name).toBe('Bogen');
    const obj = state().objects[result.id];
    expect(isClosedManifold(obj.mesh)).toBe(true);
    expect(obj.mesh.faces).toHaveLength(12 * 4 + 2);
    const box = boundingBox(obj.mesh)!;
    expect(box.min.map((v) => +v.toFixed(9) + 0)).toEqual([0, -0.05, -3]);
    expect(box.max.map((v) => +v.toFixed(9) + 0)).toEqual([3, 0.05, 0]);
    await expect(run('scene.add_primitive', { type: 'arc', innerRadius: 3, outerRadius: 2 })).rejects.toThrow(/smaller than outerRadius/);
    // A failed command leaves nothing behind.
    expect(state().order).toEqual([result.id]);
  });
});

describe('scene.add_tube', () => {
  it('adds a strut between two world points with its origin at the first one, and selects it', async () => {
    const result = await run('scene.add_tube', { points: [[1, 2, 3], [1, 5, 7]], radius: 0.05 });
    expect(result).toEqual({
      id: expect.any(String),
      name: 'Rohr',
      transform: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
      bounds: expect.any(Object),
      length: 5,
      vertices: 24,
      faces: 14,
    });
    // World-space bounds: the strut runs from y 2 to 5 and z 3 to 7, 0.05 thick.
    expect(result.bounds.min[0]).toBeCloseTo(0.95, 9);
    expect(result.bounds.max[0]).toBeCloseTo(1.05, 9);
    expect(result.bounds.min[1]).toBeLessThan(2);
    expect(result.bounds.max[2]).toBeGreaterThan(7);
    expect(result.bounds.center[0]).toBeCloseTo(1, 9);
    const obj = state().objects[result.id];
    expect(obj.transform).toEqual({ position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] });
    expect(obj.smooth).toBe(true);
    expect(obj.groupId).toBeNull();
    expect(obj.materialId).toBeNull();
    expect(obj.modifiers).toEqual([]);
    expect(state().selection).toEqual([result.id]);
    expect(state().activeId).toBe(result.id);
    expect(isClosedManifold(obj.mesh)).toBe(true);
    // In world space every vertex is 0.05 from the line between the points, at one of its ends.
    for (let i = 0; i < obj.mesh.positions.length; i += 3) {
      const p = [0, 1, 2].map((a) => obj.mesh.positions[i + a] + obj.transform.position[a] - [1, 2, 3][a]);
      const t = (p[1] * 3 + p[2] * 4) / 25;
      expect(Math.hypot(p[0], p[1] - 3 * t, p[2] - 4 * t)).toBeCloseTo(0.05, 12);
      expect(Math.min(Math.abs(t), Math.abs(t - 1))).toBeLessThan(1e-12);
    }
    expect(volume(obj.mesh)).toBeCloseTo(6 * 0.05 * 0.05 * Math.sin(Math.PI / 6) * 5, 12);
  });

  it('is one undo step', async () => {
    const { id } = await run('scene.add_tube', { points: [[0, 0, 0], [1, 0, 0]], radius: 0.1 });
    expect(activeDoc(app).past).toHaveLength(1);
    await run('history.undo');
    expect(state().objects[id]).toBeUndefined();
    await run('history.redo');
    expect(state().objects[id]).toBeDefined();
  });

  it('takes a path, a name, a group and a material by name, and the shape options', async () => {
    const group = await run('group.create', { name: 'Frame', ids: [] });
    const material = await run('material.create', { name: 'Steel' });
    const points = [[0, 0, 0], [2, 0, 0], [2, 0, 2], [0, 0, 2]];
    const ring = await run('scene.add_tube', { points, radius: 0.1, segments: 6, closed: true, smooth: false, name: 'Handrail', groupId: 'Frame', materialId: 'Steel' });
    expect(ring).toMatchObject({ name: 'Handrail', length: 8, vertices: 24, faces: 24 });
    const obj = state().objects[ring.id];
    expect(obj).toMatchObject({ groupId: group.id, materialId: material.id, smooth: false });
    expect(isClosedManifold(obj.mesh)).toBe(true);

    const again = await run('scene.add_tube', { points, radius: 0.1, name: 'Handrail' });
    expect(again.name).toBe('Handrail.001');
    expect(again.length).toBe(6);

    const open = await run('scene.add_tube', { points: points.slice(0, 2), radius: 0.1, segments: 8, caps: false });
    expect(open.faces).toBe(8);
    expect(isClosedManifold(state().objects[open.id].mesh)).toBe(false);

    const cone = await run('scene.add_tube', { points: [[0, 0, 0], [0, 1, 0]], radii: [0.5, 0.01], segments: 16 });
    expect(boundingBox(state().objects[cone.id].mesh)!.max[0]).toBeCloseTo(0.5, 12);
    expect(isClosedManifold(state().objects[cone.id].mesh)).toBe(true);
  });

  it('rejects bad input with a clear message and changes nothing', async () => {
    const points = [[0, 0, 0], [1, 0, 0]];
    await expect(run('scene.add_tube', { points })).rejects.toThrow(/Give radius/);
    await expect(run('scene.add_tube', { points: [[0, 0, 0]], radius: 1 })).rejects.toThrow();
    await expect(run('scene.add_tube', { points: [[0, 0, 0], [0, 0, 0]], radius: 1 })).rejects.toThrow(/at least 2 different points/);
    await expect(run('scene.add_tube', { points: [[0, 0, 0], [1, NaN, 0]], radius: 1 })).rejects.toThrow();
    await expect(run('scene.add_tube', { points: [[0, 0, 0], [1, Infinity, 0]], radius: 1 })).rejects.toThrow();
    await expect(run('scene.add_tube', { points, radius: -1 })).rejects.toThrow();
    await expect(run('scene.add_tube', { points, radius: 1, segments: 2 })).rejects.toThrow();
    await expect(run('scene.add_tube', { points, radius: 1, segments: 1000 })).rejects.toThrow();
    await expect(run('scene.add_tube', { points, radii: [1, 2, 3] })).rejects.toThrow(/one entry per point/);
    await expect(run('scene.add_tube', { points, radius: 1, closed: true })).rejects.toThrow(/at least 3/);
    await expect(run('scene.add_tube', { points: [[0, 0, 0], [1, 0, 0], [0, 0, 0]], radius: 1 })).rejects.toThrow(/folds back/);
    await expect(run('scene.add_tube', { points, radius: 1, groupId: 'nope' })).rejects.toThrow(/does not exist/);
    await expect(run('scene.add_tube', { points, radius: 1, materialId: 'toString' })).rejects.toThrow(/does not exist/);
    await expect(run('scene.add_tube', { points: Array.from({ length: 2001 }, (_, i) => [i, 0, 0]), radius: 1 })).rejects.toThrow();
    expect(state().order).toEqual([]);
    expect(activeDoc(app).past).toHaveLength(0);
  });

  it('a long path stays a closed solid', async () => {
    const points = Array.from({ length: 2000 }, (_, i) => [Math.cos(i / 20) * 3, i * 0.01, Math.sin(i / 20) * 3]);
    const { id, vertices } = await run('scene.add_tube', { points, radius: 0.05, segments: 8 });
    expect(vertices).toBe(16000);
    expect(isClosedManifold(state().objects[id].mesh)).toBe(true);
  });
});

describe('scene.add_text', () => {
  it('adds upright text as one object and reports its bounds', async () => {
    const result = await run('scene.add_text', { text: 'Exit', size: 0.5, depth: 0.04, position: [0, 2, -3], rotation: [0, 90, 0] });
    expect(result).toMatchObject({ id: expect.any(String), name: 'Exit', skipped: [] });
    const obj = state().objects[result.id];
    expect(obj.transform).toEqual({ position: [0, 2, -3], rotation: [0, 90, 0], scale: [1, 1, 1] });
    expect(obj.smooth).toBe(false);
    expect(state().selection).toEqual([result.id]);
    expect(isClosedManifold(obj.mesh)).toBe(true);
    expect(result.localBounds).toEqual(boundingBox(obj.mesh));
    // In the world the text is turned by 90 degrees about Y (it now reads along -Z and faces +X) and lifted.
    expect(result.transform).toEqual(obj.transform);
    expect(result.bounds.min[1]).toBeCloseTo(2, 6);
    expect(result.bounds.max[1]).toBeCloseTo(2.5, 6);
    expect(result.bounds.min[0]).toBeCloseTo(0, 6);
    expect(result.bounds.max[0]).toBeCloseTo(0.04, 6);
    expect(result.bounds.center[2]).toBeCloseTo(-3, 6);
    expect(result.localBounds.min[1]).toBeCloseTo(0, 6);
    expect(result.localBounds.max[1]).toBeCloseTo(0.5, 6);
    expect(result.localBounds.min[2]).toBe(0);
    expect(result.localBounds.max[2]).toBe(0.04);
    expect(result.localBounds.min[0]).toBeCloseTo(-result.localBounds.max[0], 6);
    expect(result.vertices).toBe(obj.mesh.positions.length / 3);
    expect(result.faces).toBe(obj.mesh.faces.length);
    expect(activeDoc(app).past).toHaveLength(1);
    await run('history.undo');
    expect(state().order).toEqual([]);
  });

  it('works without the engine having been loaded by anything else, with defaults', async () => {
    const result = await run('scene.add_text', { text: 'A' });
    expect(result.localBounds.max[1]).toBeCloseTo(1, 6);
    expect(result.localBounds.max[2]).toBe(0.1);
  });

  it('reports skipped characters, names the object after the text, aligns and groups', async () => {
    await run('group.create', { name: 'Signs', ids: [] });
    const material = await run('material.create', { name: 'Paint' });
    const result = await run('scene.add_text', { text: 'Gate ☃ 7\nNorth', align: 'left', groupId: 'Signs', materialId: 'Paint' });
    expect(result.skipped).toEqual(['☃']);
    expect(result.name).toBe('Gate ☃ 7 North');
    expect(result.localBounds.min[0]).toBeCloseTo(0, 6);
    expect(result.localBounds.min[1]).toBeLessThan(-1);
    expect(state().objects[result.id].materialId).toBe(material.id);
    expect((await run('scene.add_text', { text: 'North', name: 'Label' })).name).toBe('Label');
    expect((await run('scene.add_text', { text: 'x'.repeat(100) })).name).toHaveLength(40);
  });

  it('rejects text it cannot set', async () => {
    await expect(run('scene.add_text', { text: '' })).rejects.toThrow();
    await expect(run('scene.add_text', { text: 'x'.repeat(501) })).rejects.toThrow();
    await expect(run('scene.add_text', { text: '☃☃' })).rejects.toThrow(/None of the characters has a glyph/);
    await expect(run('scene.add_text', { text: '  \n ' })).rejects.toThrow(/only spaces/);
    await expect(run('scene.add_text', { text: 'A', size: 0 })).rejects.toThrow();
    await expect(run('scene.add_text', { text: 'A', depth: -1 })).rejects.toThrow();
    await expect(run('scene.add_text', { text: 'A', align: 'middle' })).rejects.toThrow();
    await expect(run('scene.add_text', { text: 'A', font: 'arial' })).rejects.toThrow();
    await expect(run('scene.add_text', { text: 'A', groupId: 'nope' })).rejects.toThrow(/does not exist/);
    expect(state().order).toEqual([]);
  });
});

describe('shapes are plain meshes afterwards', () => {
  it('a radial array of struts: one tube, one modifier', async () => {
    const { id } = await run('scene.add_tube', { points: [[1, 0, 0], [1, 2, 0]], radius: 0.05, segments: 8 });
    // The tube's origin is its first point, so the centre of the circle is at local [-1, 0, 0].
    await run('modifier.add', { objectId: id, type: 'array', count: 12, offset: [0, 0, 0], rotation: [0, 30, 0], pivot: [-1, 0, 0] });
    const { evaluateObject } = await import('../modifiers/evaluate');
    const mesh = evaluateObject(state(), id).mesh;
    expect(mesh.faces).toHaveLength(12 * 10);
    expect(isClosedManifold(mesh)).toBe(true);
    const cylinder = createPrimitive('cylinder', { radius: 0.05, height: 2, segments: 8 });
    expect(volume(mesh)).toBeCloseTo(12 * volume(cylinder), 12);
    // Every strut stands on the circle of radius 1 around the world Y axis.
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const r = Math.hypot(mesh.positions[i] + 1, mesh.positions[i + 2]);
      expect(r).toBeGreaterThan(0.95 - 1e-9);
      expect(r).toBeLessThan(1.05 + 1e-9);
    }
  });
});
