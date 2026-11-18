import { beforeEach, describe, expect, it } from 'vitest';
import { activeDoc, createAppState } from '../state';
import type { AppState, BakeRequest, DocState } from '../types';
import { commands } from './index';
import { runCommand, type AnyCommand, type CommandContext } from './registry';

const byId = new Map<string, AnyCommand>(commands.map((c) => [c.id, c]));

// A 1 x 1 PNG stands in for the baked image; the real baker is tested in src/bake.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let app: AppState;
let requests: BakeRequest[];
/** Runs while the fake bake is "computing". */
let during: (() => Promise<unknown>) | null;
const ctx: CommandContext = {
  get: () => app,
  set: (update) => {
    app = update(app);
  },
  services: {
    viewport: null,
    exporter: null,
    baker: {
      async bake(_state, request) {
        requests.push(request);
        await during?.();
        return { data: PNG, coverage: 0.75, distance: request.type === 'normal' ? (request.maxDistance ?? 0.123) : (request.distance ?? 0.456) };
      },
    },
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function run(id: string, params?: unknown): Promise<any> {
  const def = byId.get(id);
  if (!def) throw new Error(`Unknown command ${id}`);
  return runCommand(def, ctx, params);
}

const doc = () => activeDoc(app);
const state = (): DocState => doc().state;

let low: string;
let high: string;

beforeEach(async () => {
  app = createAppState();
  requests = [];
  during = null;
  low = (await run('scene.add_primitive', { type: 'plane', name: 'Low' })).id;
  await run('uv.unwrap', { objectId: low, method: 'planar' });
  high = (await run('scene.add_primitive', { type: 'uv_sphere', name: 'High' })).id;
});

describe('bake.normal', () => {
  it('creates the texture and puts it into a new material of the target as one undo step', async () => {
    const steps = doc().past.length;
    const result = await run('bake.normal', { targetId: low, sourceIds: [high, high], size: 256 });
    expect(requests).toEqual([{ type: 'normal', targetId: low, sourceIds: [high], size: 256, maxDistance: undefined }]);
    expect(result).toEqual({ textureId: expect.any(String), name: 'Low Normal', materialId: expect.any(String), coverage: 0.75, maxDistance: 0.123 });
    expect(state().textures[result.textureId]).toEqual({ id: result.textureId, name: 'Low Normal', mimeType: 'image/png', data: PNG, width: 256, height: 256 });
    const material = state().materials[result.materialId];
    expect(material).toMatchObject({ name: 'Low', baseColor: '#b9b5ae', roughness: 0.6, maps: { normal: result.textureId } });
    expect(state().objects[low].materialId).toBe(result.materialId);
    expect(state().objects[high].materialId).toBeNull();
    expect(doc().past.length).toBe(steps + 1);

    await run('history.undo');
    expect(state().textures).toEqual({});
    expect(state().materials).toEqual({});
    expect(state().objects[low].materialId).toBeNull();
    await run('history.redo');
    expect(state().objects[low].materialId).toBe(result.materialId);
    expect(Object.keys(state().textures)).toEqual([result.textureId]);
  });

  it('keeps the target material and its other maps, and names textures uniquely', async () => {
    const { id: materialId } = await run('material.create', { name: 'Stone', roughness: 0.9, assignTo: [low] });
    const first = await run('bake.normal', { targetId: low, sourceIds: [high], maxDistance: 0.5 });
    expect(first).toMatchObject({ materialId, maxDistance: 0.5, name: 'Low Normal' });
    expect(requests[0]).toMatchObject({ size: 1024, maxDistance: 0.5 });
    const ao = await run('bake.ao', { targetId: low });
    const second = await run('bake.normal', { targetId: low, sourceIds: [high], name: 'Low Normal' });
    expect(second.name).toBe('Low Normal.001');
    expect(state().materials[materialId]).toMatchObject({ name: 'Stone', roughness: 0.9, maps: { normal: second.textureId, occlusion: ao.textureId } });
    expect(Object.keys(state().materials)).toEqual([materialId]);
    expect(Object.keys(state().textures)).toHaveLength(3);
  });

  it('only adds the texture with assign false', async () => {
    const result = await run('bake.normal', { targetId: low, sourceIds: [high], assign: false, name: 'Detail' });
    expect(result).toMatchObject({ name: 'Detail', materialId: null });
    expect(state().materials).toEqual({});
    expect(state().objects[low].materialId).toBeNull();
    expect(state().textures[result.textureId].name).toBe('Detail');
  });

  it('applies the result to the document as it is when the bake ends', async () => {
    // While baking, another material is assigned (e.g. by an AI client).
    during = async () => {
      await run('material.create', { name: 'Later', assignTo: [low] });
    };
    const result = await run('bake.normal', { targetId: low, sourceIds: [high] });
    expect(state().materials[result.materialId]).toMatchObject({ name: 'Later', maps: { normal: result.textureId } });
    // The target is deleted while baking: the texture is still added.
    during = () => run('scene.delete_objects', { ids: [low] });
    const orphan = await run('bake.normal', { targetId: low, sourceIds: [high] });
    expect(orphan.materialId).toBeNull();
    expect(state().textures[orphan.textureId]).toBeDefined();
  });

  it('explains what is wrong with the request before baking', async () => {
    const steps = doc().past.length;
    await expect(run('bake.normal', { targetId: high, sourceIds: [low] })).rejects.toThrow('The target object "High" has no UVs. Unwrap it first (uv.unwrap), then bake.');
    await expect(run('bake.normal', { targetId: 'nope', sourceIds: [high] })).rejects.toThrow('Target object "nope" does not exist');
    await expect(run('bake.normal', { targetId: low, sourceIds: ['nope'] })).rejects.toThrow('Source object "nope" does not exist');
    await expect(run('bake.normal', { targetId: low, sourceIds: [low] })).rejects.toThrow('The target cannot be its own source');
    await expect(run('bake.normal', { targetId: low, sourceIds: [] })).rejects.toThrow();
    await expect(run('bake.normal', { targetId: low, sourceIds: [high], size: 8 })).rejects.toThrow();
    await expect(run('bake.normal', { targetId: low, sourceIds: [high], maxDistance: 0 })).rejects.toThrow();
    expect(requests).toEqual([]);
    expect(doc().past.length).toBe(steps);
  });

  it('fails without a baker and passes on the errors of the baker, changing nothing', async () => {
    const before = state();
    during = () => Promise.reject(new Error('Baking was cancelled'));
    await expect(run('bake.normal', { targetId: low, sourceIds: [high] })).rejects.toThrow('Baking was cancelled');
    expect(state()).toBe(before);
    const def = byId.get('bake.ao')!;
    await expect(runCommand(def, { ...ctx, services: { viewport: null, exporter: null } }, { targetId: low })).rejects.toThrow('The baker is not ready yet');
  });
});

describe('bake.ao', () => {
  it('bakes into the occlusion slot with its defaults', async () => {
    const result = await run('bake.ao', { targetId: low, includeIds: [high, low, high] });
    // The target always occludes itself; listing it again changes nothing.
    expect(requests).toEqual([{ type: 'ao', targetId: low, includeIds: [high], size: 1024, samples: 64, distance: undefined }]);
    expect(result).toEqual({ textureId: expect.any(String), name: 'Low AO', materialId: expect.any(String), distance: 0.456 });
    expect(state().materials[result.materialId].maps).toEqual({ occlusion: result.textureId });
    expect(state().textures[result.textureId]).toMatchObject({ width: 1024, height: 1024, mimeType: 'image/png' });
  });

  it('checks its request', async () => {
    await expect(run('bake.ao', { targetId: high })).rejects.toThrow('has no UVs');
    await expect(run('bake.ao', { targetId: low, includeIds: ['nope'] })).rejects.toThrow('Included object "nope" does not exist');
    await expect(run('bake.ao', { targetId: low, samples: 0 })).rejects.toThrow();
  });

  it('bakes the mesh after modifiers that keep the UVs', async () => {
    await run('modifier.add', { objectId: low, type: 'subdivision', levels: 1 });
    await expect(run('bake.ao', { targetId: low })).resolves.toMatchObject({ name: 'Low AO' });
  });
});
