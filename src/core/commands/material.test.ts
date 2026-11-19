import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_TEXTURE_BASE64, textureBytes, textureDataProblem } from '../materials';
import { parseProject, serializeProject } from '../project';
import { activeDoc, createAppState } from '../state';
import { textureSlots } from '../types';
import type { AppState, DocState } from '../types';
import { commands } from './index';
import { runCommand, type AnyCommand, type CommandContext } from './registry';

const byId = new Map<string, AnyCommand>(commands.map((c) => [c.id, c]));

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
const materialOf = (id: string) => state().objects[id].materialId;
/** Materials and textures are records without a defined order (ids that look like numbers sort first). */
const byName = <T extends { name: string }>(list: readonly T[]): T[] => [...list].sort((a, b) => a.name.localeCompare(b.name));
const sorted = (list: readonly string[]) => [...list].sort();

// Tiny real image files.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='; // 1x1, 70 bytes
const PNG_2X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGM8ISfHwMAAAAXMAQZFiFnUAAAAAElFTkSuQmCC';
const JPEG =
  '/9j/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k='; // 1x1, 107 bytes
const WEBP = 'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA=='; // 1x1, 34 bytes

/** The start of a PNG file (signature and header) that says it has the given size. */
function pngHeader(width: number, height: number): string {
  const bytes = Buffer.from(PNG, 'base64').subarray(0, 33);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes.toString('base64');
}

const png = (overrides: Record<string, unknown> = {}) => ({ name: 'Holz', mimeType: 'image/png', data: PNG, width: 1, height: 1, ...overrides });

async function add(params: Record<string, unknown> = {}): Promise<string> {
  return (await run('scene.add_primitive', { type: 'plane', ...params })).id;
}

async function material(params: Record<string, unknown> = {}): Promise<string> {
  return (await run('material.create', params)).id;
}

async function texture(params: Record<string, unknown> = {}): Promise<string> {
  return (await run('texture.add', png(params))).id;
}

function invariantErrors(s: DocState): string[] {
  const errors: string[] = [];
  for (const [key, m] of Object.entries(s.materials)) {
    if (m.id !== key) errors.push(`material ${key} has id ${m.id}`);
    for (const [slot, textureId] of Object.entries(m.maps)) {
      if (!(textureSlots as readonly string[]).includes(slot)) errors.push(`material ${key}: unknown slot ${slot}`);
      if (typeof textureId !== 'string' || !s.textures[textureId]) errors.push(`material ${key}: dangling map ${slot}`);
    }
  }
  for (const [key, t] of Object.entries(s.textures)) if (t.id !== key) errors.push(`texture ${key} has id ${t.id}`);
  const materialNames = Object.values(s.materials).map((m) => m.name);
  if (new Set(materialNames).size !== materialNames.length) errors.push('material names are not unique');
  const textureNames = Object.values(s.textures).map((t) => t.name);
  if (new Set(textureNames).size !== textureNames.length) errors.push('texture names are not unique');
  for (const obj of Object.values(s.objects)) {
    if (obj.materialId !== null && !s.materials[obj.materialId]) errors.push(`object ${obj.id}: dangling materialId`);
  }
  return errors;
}

/** Runs a mutating command and checks that it is exactly one undo step that undo/redo restore by identity. */
async function expectUndoable(id: string, params: unknown): Promise<unknown> {
  const before = state();
  const past = doc().past.length;
  const result = await run(id, params);
  const after = state();
  expect(after).not.toBe(before);
  expect(doc().past).toHaveLength(past + 1);
  expect(invariantErrors(after)).toEqual([]);
  await run('history.undo');
  expect(state()).toBe(before);
  await run('history.redo');
  expect(state()).toBe(after);
  return result;
}

beforeEach(() => {
  app = createAppState();
});

describe('registration', () => {
  it('registers all material and texture commands', () => {
    const ids = commands.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id.startsWith('material.')).sort()).toEqual([
      'material.assign',
      'material.create',
      'material.delete',
      'material.duplicate',
      'material.import',
      'material.list',
      'material.replace',
      'material.update',
    ]);
    expect(ids.filter((id) => id.startsWith('texture.')).sort()).toEqual([
      'texture.add',
      'texture.add_from_library',
      'texture.export',
      'texture.get',
      'texture.link',
      'texture.list',
      'texture.normal_from_height',
      'texture.remove',
      'texture.rename',
      'texture.set_animation',
      'texture.unlink',
    ]);
  });

  it('new documents have no materials or textures', () => {
    expect(state().materials).toEqual({});
    expect(state().textures).toEqual({});
  });
});

describe('material.create', () => {
  it('creates a material with the defaults', async () => {
    const result = await run('material.create');
    expect(result).toEqual({ id: expect.any(String), name: 'Material' });
    expect(state().materials).toStrictEqual({
      [result.id]: {
        id: result.id,
        name: 'Material',
        baseColor: '#b9b5ae',
        metallic: 0,
        roughness: 0.6,
        emissive: '#000000',
        emissiveStrength: 1,
        normalScale: 1,
        maps: {},
      },
    });
  });

  it('takes all fields and normalises colours to lower case', async () => {
    const id = await material({
      name: 'Gold',
      baseColor: '#FFD700',
      metallic: 1,
      roughness: 0,
      emissive: '#0a0B0c',
      emissiveStrength: 100,
      normalScale: 10,
    });
    expect(state().materials[id]).toStrictEqual({
      id,
      name: 'Gold',
      baseColor: '#ffd700',
      metallic: 1,
      roughness: 0,
      emissive: '#0a0b0c',
      emissiveStrength: 100,
      normalScale: 10,
      maps: {},
    });
  });

  it('makes names unique among materials only', async () => {
    await add({ name: 'Material' });
    await texture({ name: 'Material' });
    const names = [await run('material.create'), await run('material.create'), await run('material.create', { name: 'Material.001' })];
    expect(names.map((r) => r.name)).toEqual(['Material', 'Material.001', 'Material.002']);
  });

  it('assignTo assigns it in the same undo step', async () => {
    const a = await add();
    const b = await add();
    const c = await add();
    const objC = state().objects[c];
    const result = (await expectUndoable('material.create', { assignTo: [a, b] })) as { id: string };
    expect([materialOf(a), materialOf(b), materialOf(c)]).toEqual([result.id, result.id, null]);
    expect(state().objects[c]).toBe(objC);
    await run('history.undo');
    expect(state().materials).toEqual({});
    expect([materialOf(a), materialOf(b)]).toEqual([null, null]);
  });

  it('rejects invalid values without changing anything', async () => {
    const a = await add();
    const before = app;
    for (const params of [
      { name: '' },
      { baseColor: 'red' },
      { baseColor: '#fff' },
      { baseColor: '#12345g' },
      { baseColor: '#1234567' },
      { emissive: 'ff0000' },
      { metallic: -0.1 },
      { metallic: 1.1 },
      { roughness: 2 },
      { roughness: -1 },
      { emissiveStrength: -1 },
      { emissiveStrength: 100.5 },
      { normalScale: -1 },
      { normalScale: 11 },
      { metallic: Number.NaN },
      { roughness: '0.5' },
    ]) {
      await expect(run('material.create', params), JSON.stringify(params)).rejects.toThrow();
    }
    await expect(run('material.create', { assignTo: [a, 'nope'] })).rejects.toThrow(/Object "nope" does not exist/);
    expect(app).toBe(before);
  });
});

describe('material.update', () => {
  it('updates only the given fields and returns the material', async () => {
    const id = await material({ name: 'Lack', roughness: 0.2 });
    const other = await material();
    const otherMaterial = state().materials[other];
    const result = await expectUndoable('material.update', { id, baseColor: '#FF0000', metallic: 0.5 });
    expect(result).toStrictEqual({
      id,
      name: 'Lack',
      baseColor: '#ff0000',
      metallic: 0.5,
      roughness: 0.2,
      emissive: '#000000',
      emissiveStrength: 1,
      normalScale: 1,
      maps: {},
    });
    expect(state().materials[id]).toBe(result);
    expect(state().materials[other]).toBe(otherMaterial);
    await run('material.update', { id, emissive: '#112233', emissiveStrength: 0, normalScale: 0, roughness: 1, metallic: 0 });
    expect(state().materials[id]).toMatchObject({ emissive: '#112233', emissiveStrength: 0, normalScale: 0, roughness: 1, metallic: 0, baseColor: '#ff0000' });
  });

  it('renames with unique names and may keep its own name', async () => {
    const a = await material({ name: 'A' });
    const b = await material({ name: 'B' });
    expect((await run('material.update', { id: b, name: 'A' })).name).toBe('A.001');
    expect((await run('material.update', { id: a, name: 'A' })).name).toBe('A');
    expect((await run('material.update', { id: a, roughness: 0.1 })).name).toBe('A');
  });

  it('sets and clears map slots', async () => {
    const id = await material();
    const t1 = await texture();
    const t2 = await texture();
    await expectUndoable('material.update', { id, maps: { baseColor: t1, normal: t2 } });
    expect(state().materials[id].maps).toStrictEqual({ baseColor: t1, normal: t2 });
    // Omitted slots stay, null clears, clearing an empty slot is fine.
    await run('material.update', { id, maps: { normal: null, roughness: t1, occlusion: null } });
    expect(state().materials[id].maps).toStrictEqual({ baseColor: t1, roughness: t1 });
    await run('material.update', { id, maps: { metallic: t2, emissive: t2, occlusion: t2 } });
    expect(state().materials[id].maps).toStrictEqual({ baseColor: t1, roughness: t1, metallic: t2, emissive: t2, occlusion: t2 });
    // Without maps the maps object keeps its identity.
    const maps = state().materials[id].maps;
    await run('material.update', { id, metallic: 1 });
    expect(state().materials[id].maps).toBe(maps);
    await run('material.update', { id, maps: {} });
    expect(state().materials[id].maps).toStrictEqual(maps);
  });

  it('rejects unknown ids, textures, slots and invalid values without changing anything', async () => {
    const id = await material();
    const t = await texture();
    const before = app;
    await expect(run('material.update', { id: 'nope', metallic: 1 })).rejects.toThrow(/Material "nope" does not exist/);
    await expect(run('material.update', { id, maps: { baseColor: 'nope' } })).rejects.toThrow(/Texture "nope" does not exist/);
    // All or nothing: the valid slot is not applied either.
    await expect(run('material.update', { id, maps: { baseColor: t, normal: 'nope' } })).rejects.toThrow(/Texture "nope"/);
    await expect(run('material.update', { id, maps: { diffuse: t } })).rejects.toThrow();
    await expect(run('material.update', { id, maps: { baseColor: 5 } })).rejects.toThrow();
    await expect(run('material.update', { id, name: '' })).rejects.toThrow();
    await expect(run('material.update', { id, baseColor: 'blue' })).rejects.toThrow();
    await expect(run('material.update', { id, roughness: 1.5 })).rejects.toThrow();
    await expect(run('material.update', { id, normalScale: 10.1 })).rejects.toThrow();
    await expect(run('material.update', { metallic: 1 })).rejects.toThrow();
    expect(app).toBe(before);
  });
});

describe('material.delete', () => {
  it('removes the material and unassigns it from its objects', async () => {
    const a = await add();
    const b = await add();
    const c = await add();
    const t = await texture();
    const m = await material({ assignTo: [a, c] });
    const keep = await material({ assignTo: [b] });
    await run('material.update', { id: m, maps: { baseColor: t } });
    const objB = state().objects[b];

    expect(await expectUndoable('material.delete', { id: m })).toEqual({ deleted: m, unassigned: [a, c] });
    expect(Object.keys(state().materials)).toEqual([keep]);
    expect([materialOf(a), materialOf(b), materialOf(c)]).toEqual([null, keep, null]);
    expect(state().objects[b]).toBe(objB);
    // The texture stays.
    expect(state().textures[t]).toBeDefined();

    await run('history.undo');
    expect([materialOf(a), materialOf(b), materialOf(c)]).toEqual([m, keep, m]);
    expect(state().materials[m].maps).toEqual({ baseColor: t });
  });

  it('rejects unknown ids', async () => {
    const before = app;
    await expect(run('material.delete', { id: 'nope' })).rejects.toThrow(/Material "nope" does not exist/);
    expect(app).toBe(before);
  });
});

describe('material.duplicate', () => {
  it('copies values and maps under a unique name without assigning it', async () => {
    const a = await add();
    const t = await texture();
    const m = await material({ name: 'Lack', baseColor: '#102030', metallic: 0.3, assignTo: [a] });
    await run('material.update', { id: m, maps: { normal: t } });
    const result = (await expectUndoable('material.duplicate', { id: m })) as { id: string; name: string };
    expect(result).toEqual({ id: expect.any(String), name: 'Lack.001' });
    expect(result.id).not.toBe(m);
    expect(state().materials[result.id]).toStrictEqual({ ...state().materials[m], id: result.id, name: 'Lack.001' });
    expect((await run('material.duplicate', { id: result.id })).name).toBe('Lack.002');
    expect(materialOf(a)).toBe(m);
    expect(Object.keys(state().textures)).toEqual([t]);
  });

  it('rejects unknown ids', async () => {
    const before = app;
    await expect(run('material.duplicate', { id: 'nope' })).rejects.toThrow(/Material "nope" does not exist/);
    expect(app).toBe(before);
  });
});

describe('material.assign', () => {
  it('assigns to the given objects or the selection, and null removes it', async () => {
    const a = await add();
    const b = await add();
    const c = await add();
    const m = await material();
    const n = await material();
    expect(await expectUndoable('material.assign', { materialId: m, ids: [a, b] })).toEqual({ materialId: m, ids: [a, b] });
    expect([materialOf(a), materialOf(b), materialOf(c)]).toEqual([m, m, null]);

    await run('scene.select', { ids: [b, c] });
    await run('material.assign', { materialId: n });
    expect([materialOf(a), materialOf(b), materialOf(c)]).toEqual([m, n, n]);
    // Selection and edit state are untouched.
    expect(state().selection).toEqual([b, c]);

    await expectUndoable('material.assign', { materialId: null, ids: [b] });
    expect([materialOf(a), materialOf(b), materialOf(c)]).toEqual([m, null, n]);
  });

  it('objects that already have the material keep their identity', async () => {
    const a = await add();
    const b = await add();
    const m = await material({ assignTo: [a] });
    const objA = state().objects[a];
    await run('material.assign', { materialId: m, ids: [a, b, b] });
    expect(state().objects[a]).toBe(objA);
    expect(materialOf(b)).toBe(m);
  });

  it('does not disturb edit mode', async () => {
    const a = await add();
    const m = await material();
    await run('edit.enter', { id: a });
    const edit = state().edit;
    const mesh = state().objects[a].mesh;
    await run('material.assign', { materialId: m });
    expect(materialOf(a)).toBe(m);
    expect(state().edit).toBe(edit);
    expect(state().objects[a].mesh).toBe(mesh);
  });

  it('rejects unknown materials, unknown objects and an empty target', async () => {
    const a = await add();
    const m = await material();
    await run('scene.select', { ids: [] });
    const before = app;
    await expect(run('material.assign', { materialId: 'nope', ids: [a] })).rejects.toThrow(/Material "nope" does not exist/);
    await expect(run('material.assign', { materialId: m, ids: [a, 'nope'] })).rejects.toThrow(/Object "nope" does not exist/);
    await expect(run('material.assign', { materialId: m })).rejects.toThrow(/nothing is selected/);
    await expect(run('material.assign', { materialId: m, ids: [] })).rejects.toThrow(/nothing is selected/);
    await expect(run('material.assign', { ids: [a] })).rejects.toThrow();
    expect(app).toBe(before);
  });
});

describe('material.list', () => {
  it('lists materials with the objects using them', async () => {
    const a = await add();
    const b = await add();
    const t = await texture();
    const m = await material({ name: 'Eins', assignTo: [b, a] });
    const unused = await material({ name: 'Zwei' });
    await run('material.update', { id: m, maps: { emissive: t } });
    const before = app;
    const { materials, ...rest } = await run('material.list');
    expect(rest).toEqual({});
    expect(byName(materials)).toEqual([
      { ...state().materials[m], objectIds: [a, b] },
      { ...state().materials[unused], objectIds: [] },
    ]);
    expect(byName<{ name: string; maps: unknown }>(materials)[0].maps).toEqual({ emissive: t });
    expect(app).toBe(before);
  });

  it('is empty for a new document', async () => {
    expect(await run('material.list')).toEqual({ materials: [] });
  });
});

describe('texture data validation', () => {
  it('accepts real PNG, JPEG and WebP files', () => {
    expect(textureDataProblem('image/png', PNG)).toBeNull();
    expect(textureDataProblem('image/png', PNG_2X1)).toBeNull();
    expect(textureDataProblem('image/jpeg', JPEG)).toBeNull();
    expect(textureDataProblem('image/webp', WEBP)).toBeNull();
  });

  it('reports what is wrong', () => {
    expect(textureDataProblem('image/png', '')).toBe('empty');
    expect(textureDataProblem('image/png', JPEG)).toBe('signature');
    expect(textureDataProblem('image/jpeg', PNG)).toBe('signature');
    expect(textureDataProblem('image/webp', PNG)).toBe('signature');
    expect(textureDataProblem('image/png', WEBP)).toBe('signature');
    // RIFF container that is not WebP (a WAV header).
    expect(textureDataProblem('image/webp', Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'latin1').toString('base64'))).toBe('signature');
    // Too short to hold the signature.
    expect(textureDataProblem('image/png', 'iVBORw==')).toBe('signature');
    expect(textureDataProblem('image/webp', 'UklGRg==')).toBe('signature');
    expect(textureDataProblem('image/png', `data:image/png;base64,${PNG}`)).toBe('notBase64');
    expect(textureDataProblem('image/png', PNG.slice(0, -1))).toBe('notBase64');
    expect(textureDataProblem('image/png', `${PNG.slice(0, 20)}=${PNG.slice(21)}`)).toBe('notBase64');
    expect(textureDataProblem('image/png', `${PNG.slice(0, 20)}\n${PNG.slice(20)}`)).toBe('notBase64');
    expect(textureDataProblem('image/png', PNG.replace('B', '-'))).toBe('notBase64');
    expect(textureDataProblem('image/png', 'A'.repeat(MAX_TEXTURE_BASE64 + 4))).toBe('tooLarge');
  });

  it('textureBytes is the size of the decoded file', () => {
    for (const data of [PNG, PNG_2X1, JPEG, WEBP, 'iVBORw==', 'AAAA', 'AAA=']) {
      expect(textureBytes(data), data).toBe(Buffer.from(data, 'base64').length);
    }
    expect(textureBytes(PNG)).toBe(70);
  });
});

describe('texture.add', () => {
  it('stores the texture', async () => {
    const result = await run('texture.add', png());
    expect(result).toEqual({ id: expect.any(String), name: 'Holz' });
    expect(state().textures).toStrictEqual({
      [result.id]: { id: result.id, name: 'Holz', mimeType: 'image/png', data: PNG, width: 1, height: 1 },
    });
  });

  it('accepts JPEG and WebP and sizes up to the limit', async () => {
    const j = (await run('texture.add', { name: 'J', mimeType: 'image/jpeg', data: JPEG, width: 1, height: 1 })).id;
    const w = (await run('texture.add', { name: 'W', mimeType: 'image/webp', data: WEBP, width: 1, height: 1 })).id;
    const b = (await run('texture.add', png({ data: pngHeader(16384, 16384), width: 16384, height: 16384 }))).id;
    expect(state().textures[j]).toMatchObject({ mimeType: 'image/jpeg', width: 1, height: 1 });
    expect(state().textures[w]).toMatchObject({ mimeType: 'image/webp', width: 1, height: 1 });
    expect(state().textures[b]).toMatchObject({ mimeType: 'image/png', width: 16384, height: 16384 });
  });

  it('rejects a declared size that the image file header does not confirm', async () => {
    const before = app;
    // A file that claims to be small but would decode huge, and the other way round.
    await expect(run('texture.add', png({ data: pngHeader(16384, 16384) }))).rejects.toThrow(
      'Texture size does not match the image: the file header says 16384 x 16384 pixels, not 1 x 1',
    );
    await expect(run('texture.add', png({ width: 2 }))).rejects.toThrow(/file header says 1 x 1 pixels, not 2 x 1/);
    await expect(run('texture.add', { name: 'J', mimeType: 'image/jpeg', data: JPEG, width: 16, height: 16 })).rejects.toThrow(/1 x 1 pixels, not 16 x 16/);
    await expect(run('texture.add', { name: 'W', mimeType: 'image/webp', data: WEBP, width: 1, height: 2 })).rejects.toThrow(/1 x 1 pixels, not 1 x 2/);
    // Only the signature, no header to read the size from.
    await expect(run('texture.add', png({ data: PNG.slice(0, 12) + 'AAAA' }))).rejects.toThrow(/no readable image size/);
    expect(app).toBe(before);
    // Photos are stored sideways and rotated by their EXIF orientation when decoded: swapped sides are accepted.
    await run('texture.add', png({ data: PNG_2X1, width: 1, height: 2 }));
    await run('texture.add', png({ data: PNG_2X1, width: 2, height: 1 }));
  });

  it('makes names unique among textures only', async () => {
    await add({ name: 'Holz' });
    await material({ name: 'Holz' });
    const results = [await run('texture.add', png()), await run('texture.add', png()), await run('texture.add', png({ name: 'Holz.001' }))];
    expect(results.map((r) => r.name)).toEqual(['Holz', 'Holz.001', 'Holz.002']);
  });

  it('is one undo step', async () => {
    const result = (await expectUndoable('texture.add', png())) as { id: string };
    await run('history.undo');
    expect(state().textures).toEqual({});
    await run('history.redo');
    expect(state().textures[result.id].data).toBe(PNG);
  });

  it('shares the texture by reference between history states', async () => {
    const id = await texture({ data: PNG_2X1, width: 2, height: 1 });
    const stored = state().textures[id];
    const a = await add();
    const m = await material({ assignTo: [a] });
    await run('material.update', { id: m, maps: { baseColor: id } });
    const other = await texture({ name: 'Andere' });
    await run('texture.rename', { id: other, name: 'Neu' });
    await run('scene.set_transform', { items: [{ id: a, position: [1, 2, 3] }] });
    await run('material.delete', { id: m });

    // Every state that has the texture holds the very same object, and with it the same data string.
    const states = [...doc().past, state()].filter((s) => s.textures[id]);
    expect(states.length).toBeGreaterThanOrEqual(7);
    for (const s of states) expect(s.textures[id]).toBe(stored);
    await run('history.undo');
    await run('history.undo');
    expect(state().textures[id]).toBe(stored);
    for (const s of doc().future) expect(s.textures[id]).toBe(stored);
  });

  it('rejects wrong data, types and sizes without changing anything', async () => {
    const before = app;
    await expect(run('texture.add', png({ data: JPEG }))).rejects.toThrow(/not a image\/png file/);
    await expect(run('texture.add', png({ mimeType: 'image/jpeg' }))).rejects.toThrow(/not a image\/jpeg file/);
    await expect(run('texture.add', png({ mimeType: 'image/webp' }))).rejects.toThrow(/not a image\/webp file/);
    await expect(run('texture.add', png({ data: '' }))).rejects.toThrow(/empty/);
    await expect(run('texture.add', png({ data: `data:image/png;base64,${PNG}` }))).rejects.toThrow(/not valid base64/);
    await expect(run('texture.add', png({ data: 'not base64!' }))).rejects.toThrow(/not valid base64/);
    await expect(run('texture.add', png({ data: PNG.slice(0, -2) }))).rejects.toThrow(/not valid base64/);
    await expect(run('texture.add', png({ mimeType: 'image/gif' }))).rejects.toThrow();
    await expect(run('texture.add', png({ mimeType: undefined }))).rejects.toThrow();
    await expect(run('texture.add', png({ name: '' }))).rejects.toThrow();
    await expect(run('texture.add', png({ data: undefined }))).rejects.toThrow();
    for (const size of [0, -1, 1.5, 16385, Number.NaN, '1']) {
      await expect(run('texture.add', png({ width: size })), String(size)).rejects.toThrow();
      await expect(run('texture.add', png({ height: size })), String(size)).rejects.toThrow();
    }
    expect(app).toBe(before);
  });

  it('rejects data above 64 MB of base64 with a clear error', async () => {
    const before = app;
    const head = PNG.slice(0, 32); // signature and the header with the size
    const tooLarge = head + 'A'.repeat(MAX_TEXTURE_BASE64 - head.length + 4);
    await expect(run('texture.add', png({ data: tooLarge }))).rejects.toThrow(/too large: 64\.0 MB of base64, the limit is 64\.0 MB/);
    expect(app).toBe(before);
    // Exactly at the limit is accepted.
    const atLimit = head + 'A'.repeat(MAX_TEXTURE_BASE64 - head.length);
    const { id } = await run('texture.add', png({ data: atLimit }));
    expect(state().textures[id].data.length).toBe(MAX_TEXTURE_BASE64);
    expect((await run('texture.list')).textures[0].bytes).toBe((MAX_TEXTURE_BASE64 / 4) * 3);
  });
});

describe('texture.remove', () => {
  it('removes the texture and clears it from every material slot', async () => {
    const t = await texture();
    const keep = await texture({ name: 'Bleibt' });
    const m1 = await material({ name: 'A' });
    const m2 = await material({ name: 'B' });
    const m3 = await material({ name: 'C' });
    await run('material.update', { id: m1, maps: { baseColor: t, normal: keep, roughness: t } });
    await run('material.update', { id: m2, maps: { occlusion: t } });
    await run('material.update', { id: m3, maps: { baseColor: keep } });
    const untouched = state().materials[m3];

    const result = (await expectUndoable('texture.remove', { id: t })) as { removed: string; clearedFrom: unknown[] };
    expect(result.removed).toBe(t);
    expect(result.clearedFrom).toHaveLength(3);
    expect(result.clearedFrom).toEqual(
      expect.arrayContaining([
        { materialId: m1, slot: 'baseColor' },
        { materialId: m1, slot: 'roughness' },
        { materialId: m2, slot: 'occlusion' },
      ]),
    );
    expect(Object.keys(state().textures)).toEqual([keep]);
    expect(state().materials[m1].maps).toStrictEqual({ normal: keep });
    expect(state().materials[m2].maps).toStrictEqual({});
    expect(state().materials[m3]).toBe(untouched);

    await run('history.undo');
    expect(state().materials[m1].maps).toEqual({ baseColor: t, normal: keep, roughness: t });
    expect(state().materials[m2].maps).toEqual({ occlusion: t });
    expect(state().textures[t].data).toBe(PNG);
  });

  it('rejects unknown ids', async () => {
    const before = app;
    await expect(run('texture.remove', { id: 'nope' })).rejects.toThrow(/Texture "nope" does not exist/);
    expect(app).toBe(before);
  });
});

describe('texture.rename', () => {
  it('renames, keeps names unique and may keep its own name', async () => {
    const a = await texture({ name: 'A' });
    const b = await texture({ name: 'B' });
    expect(await run('texture.rename', { id: b, name: 'A' })).toEqual({ id: b, name: 'A.001' });
    expect(await run('texture.rename', { id: a, name: 'A' })).toEqual({ id: a, name: 'A' });
    expect(await expectUndoable('texture.rename', { id: b, name: 'Stein' })).toEqual({ id: b, name: 'Stein' });
    expect(state().textures[b]).toStrictEqual({ id: b, name: 'Stein', mimeType: 'image/png', data: PNG, width: 1, height: 1 });
  });

  it('rejects unknown ids and empty names', async () => {
    const t = await texture();
    const before = app;
    await expect(run('texture.rename', { id: 'nope', name: 'X' })).rejects.toThrow(/Texture "nope" does not exist/);
    await expect(run('texture.rename', { id: t, name: '' })).rejects.toThrow();
    expect(app).toBe(before);
  });
});

describe('texture.list and texture.get', () => {
  it('list returns everything but the data, get includes it', async () => {
    const t = await texture();
    const j = (await run('texture.add', { name: 'Foto', mimeType: 'image/jpeg', data: JPEG, width: 1, height: 1 })).id;
    const m = await material();
    const n = await material();
    await run('material.update', { id: m, maps: { baseColor: t, emissive: t } });
    await run('material.update', { id: n, maps: { normal: t } });
    const before = app;

    const list = await run('texture.list');
    expect(Object.keys(list)).toEqual(['textures']);
    const [foto, holz] = byName(list.textures as { name: string; usedBy: { materialId: string; slot: string }[] }[]);
    expect(foto).toStrictEqual({ id: j, name: 'Foto', mimeType: 'image/jpeg', width: 1, height: 1, bytes: 107, usedBy: [] });
    expect({ ...holz, usedBy: [] }).toStrictEqual({ id: t, name: 'Holz', mimeType: 'image/png', width: 1, height: 1, bytes: 70, usedBy: [] });
    expect(holz.usedBy).toHaveLength(3);
    expect(holz.usedBy).toEqual(
      expect.arrayContaining([
        { materialId: m, slot: 'baseColor' },
        { materialId: m, slot: 'emissive' },
        { materialId: n, slot: 'normal' },
      ]),
    );
    expect(JSON.stringify(list)).not.toContain(PNG.slice(0, 12));
    expect(JSON.stringify(list)).not.toContain(JPEG.slice(0, 12));

    expect(await run('texture.get', { id: t })).toStrictEqual({ ...holz, data: PNG });
    expect((await run('texture.get', { id: j })).data).toBe(JPEG);
    expect(app).toBe(before);
  });

  it('get rejects unknown ids; list is empty for a new document', async () => {
    await expect(run('texture.get', { id: 'nope' })).rejects.toThrow(/Texture "nope" does not exist/);
    expect(await run('texture.list')).toEqual({ textures: [] });
  });

  it('the description of texture.get warns about its size', () => {
    expect(byId.get('texture.get')!.description).toMatch(/WARNING/);
  });
});

describe('existing scene commands', () => {
  it('list_objects and get_object include materialId', async () => {
    const a = await add();
    const b = await add();
    const m = await material({ assignTo: [a] });
    const list = await run('scene.list_objects');
    expect(list.objects.map((o: { materialId: string | null }) => o.materialId)).toEqual([m, null]);
    expect((await run('scene.get_object', { id: a })).materialId).toBe(m);
    expect((await run('scene.get_object', { id: b })).materialId).toBeNull();
  });

  it('add_primitive takes an existing material', async () => {
    const m = await material();
    expect(materialOf(await add({ materialId: m }))).toBe(m);
    expect(materialOf(await add())).toBeNull();
    expect(materialOf(await add({ materialId: null }))).toBeNull();
    const before = app;
    await expect(add({ materialId: 'nope' })).rejects.toThrow(/Material "nope" does not exist/);
    expect(app).toBe(before);
  });

  it('duplicate keeps the material', async () => {
    const a = await add();
    const b = await add();
    const m = await material({ assignTo: [a] });
    const result = await run('scene.duplicate_objects', { ids: [a, b] });
    const [ca, cb] = result.objects.map((o: { id: string }) => o.id);
    expect([materialOf(ca), materialOf(cb)]).toEqual([m, null]);
    expect(Object.keys(state().materials)).toEqual([m]);
    expect((await run('material.list')).materials[0].objectIds).toEqual([a, ca]);
  });

  it('deleting objects (or their group) keeps their material', async () => {
    const a = await add();
    const b = await add();
    const m = await material({ assignTo: [a, b] });
    await run('scene.delete_objects', { ids: [a] });
    const g = (await run('group.create', { ids: [b] })).id;
    await run('group.delete', { id: g });
    expect(state().order).toEqual([]);
    expect(Object.keys(state().materials)).toEqual([m]);
    expect((await run('material.list')).materials[0].objectIds).toEqual([]);
    expect(invariantErrors(state())).toEqual([]);
  });

  it('undoing the creation of a material that was assigned later restores a consistent state', async () => {
    const a = await add();
    const m = await material();
    await run('material.assign', { materialId: m, ids: [a] });
    await run('history.undo');
    await run('history.undo');
    expect(state().materials).toEqual({});
    expect(materialOf(a)).toBeNull();
    expect(invariantErrors(state())).toEqual([]);
  });
});

describe('project files', () => {
  const triangle = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], faces: [[0, 1, 2]] };
  const object = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    name: id,
    visible: true,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    mesh: triangle,
    ...overrides,
  });
  const fileMaterial = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    name: id,
    baseColor: '#808080',
    metallic: 0,
    roughness: 0.5,
    emissive: '#000000',
    emissiveStrength: 1,
    normalScale: 1,
    maps: {},
    ...overrides,
  });
  const fileTexture = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    name: id,
    mimeType: 'image/png',
    data: PNG,
    width: 1,
    height: 1,
    ...overrides,
  });
  const project = (parts: { objects?: unknown[]; materials?: unknown; textures?: unknown }) =>
    JSON.stringify({ format: 'tessel', version: 1, name: 'Test', objects: [], ...parts });

  it('round trips materials, textures and assignments', async () => {
    const a = await add();
    const b = await add();
    const t1 = await texture();
    const t2 = (await run('texture.add', { name: 'Foto', mimeType: 'image/jpeg', data: JPEG, width: 1, height: 1 })).id;
    const t3 = (await run('texture.add', { name: 'Web', mimeType: 'image/webp', data: WEBP, width: 1, height: 1 })).id;
    const m1 = await material({ name: 'Gold', baseColor: '#ffd700', metallic: 1, roughness: 0.25, assignTo: [a] });
    const m2 = await material({ name: 'Glut', emissive: '#ff4400', emissiveStrength: 12.5, normalScale: 2 });
    await run('material.update', { id: m1, maps: { baseColor: t1, normal: t2, occlusion: t3 } });
    const source = state();

    const { json } = await run('document.serialize');
    const file = JSON.parse(json);
    expect(file.version).toBe(1);
    expect(byName(file.materials)).toEqual(byName([source.materials[m1], source.materials[m2]]));
    expect(byName(file.textures)).toEqual(byName([source.textures[t1], source.textures[t2], source.textures[t3]]));
    expect(file.objects.map((o: { materialId: string | null }) => o.materialId)).toEqual([m1, null]);

    await run('document.load', { json });
    expect(state()).not.toBe(source);
    expect(state().materials).toStrictEqual(source.materials);
    expect(sorted(Object.keys(state().materials))).toEqual(sorted([m1, m2]));
    expect(state().textures).toStrictEqual(source.textures);
    expect(sorted(Object.keys(state().textures))).toEqual(sorted([t1, t2, t3]));
    expect(state().objects).toEqual(source.objects);
    expect([materialOf(a), materialOf(b)]).toEqual([m1, null]);
    expect(invariantErrors(state())).toEqual([]);
    expect((await run('document.serialize')).json).toBe(json);
    // The loaded document is editable.
    await run('texture.remove', { id: t1 });
    expect(state().materials[m1].maps).toStrictEqual({ normal: t2, occlusion: t3 });
    await run('history.undo');
    expect(state().materials[m1].maps).toStrictEqual(source.materials[m1].maps);
  });

  it('writes empty lists for a document without materials', () => {
    const file = JSON.parse(serializeProject(doc()));
    expect(file.materials).toEqual([]);
    expect(file.textures).toEqual([]);
  });

  it('loads files written before materials existed', () => {
    const { state: loaded } = parseProject(project({ objects: [object('a'), object('b')] }));
    expect(loaded.materials).toEqual({});
    expect(loaded.textures).toEqual({});
    expect(loaded.order.map((id) => loaded.objects[id].materialId)).toEqual([null, null]);
  });

  it('missing maps mean no maps', () => {
    const { state: loaded } = parseProject(project({ materials: [fileMaterial('m', { maps: undefined })] }));
    expect(loaded.materials.m.maps).toStrictEqual({});
  });

  it('repairs dangling references instead of rejecting the file', () => {
    const { state: loaded } = parseProject(
      project({
        objects: [object('a', { materialId: 'gone' }), object('b', { materialId: 'm' }), object('c', { materialId: null })],
        materials: [fileMaterial('m', { maps: { baseColor: 't', normal: 'gone', occlusion: 'gone' } }), fileMaterial('n', { maps: { emissive: 't' } })],
        textures: [fileTexture('t')],
      }),
    );
    expect(loaded.order.map((id) => loaded.objects[id].materialId)).toEqual([null, 'm', null]);
    expect(loaded.materials.m.maps).toStrictEqual({ baseColor: 't' });
    expect(loaded.materials.n.maps).toStrictEqual({ emissive: 't' });
    expect(invariantErrors(loaded)).toEqual([]);
  });

  it('repairs a file that has references but no materials or textures at all', () => {
    const { state: loaded } = parseProject(project({ objects: [object('a', { materialId: 'm' })] }));
    expect(loaded.objects.a.materialId).toBeNull();
    const withMaterial = parseProject(project({ materials: [fileMaterial('m', { maps: { baseColor: 't' } })] })).state;
    expect(withMaterial.materials.m.maps).toStrictEqual({});
  });

  it('gives duplicate ids a new id instead of dropping entries', () => {
    const { state: loaded } = parseProject(
      project({
        objects: [object('a', { materialId: 'm' })],
        materials: [fileMaterial('m', { name: 'Erstes', maps: { baseColor: 't' } }), fileMaterial('m', { name: 'Zweites' })],
        textures: [fileTexture('t', { name: 'Erste' }), fileTexture('t', { name: 'Zweite' })],
      }),
    );
    expect(byName(Object.values(loaded.materials)).map((m) => m.name)).toEqual(['Erstes', 'Zweites']);
    expect(byName(Object.values(loaded.textures)).map((t) => t.name)).toEqual(['Erste', 'Zweite']);
    expect(loaded.objects.a.materialId).toBe('m');
    expect(loaded.materials.m.maps).toStrictEqual({ baseColor: 't' });
    expect(invariantErrors(loaded)).toEqual([]);
  });

  it('rejects invalid textures with a readable message', () => {
    const load = (overrides: Record<string, unknown>) => () => parseProject(project({ textures: [fileTexture('t', { name: 'Holz', ...overrides })] }));
    expect(load({ data: JPEG })).toThrow('Not a valid Tessel file: texture "Holz": image data is not an image of type image/png');
    expect(load({ mimeType: 'image/webp' })).toThrow('texture "Holz": image data is not an image of type image/webp');
    expect(load({ data: 'kein base64!' })).toThrow('Not a valid Tessel file: texture "Holz": image data is not valid base64');
    expect(load({ data: '' })).toThrow('Not a valid Tessel file: texture "Holz": has no image data');
    for (const size of [0, -4, 1.5, 16385]) {
      const message = 'Not a valid Tessel file: texture "Holz": width and height must be integers from 1 to 16384';
      expect(load({ width: size }), String(size)).toThrow(message);
      expect(load({ height: size }), String(size)).toThrow(message);
    }
    const invalid = /^Not a valid Tessel file: /;
    expect(load({ mimeType: 'image/gif' })).toThrow(invalid);
    expect(load({ data: undefined })).toThrow(invalid);
    expect(load({ width: '1' })).toThrow(invalid);
    expect(load({ id: '' })).toThrow(invalid);
    expect(() => parseProject(project({ textures: {} }))).toThrow(invalid);
  });

  it('rejects textures above the size limit', () => {
    const data = PNG.slice(0, 16) + 'A'.repeat(MAX_TEXTURE_BASE64);
    expect(() => parseProject(project({ textures: [fileTexture('t', { data })] }))).toThrow(
      'Not a valid Tessel file: texture "t": image data is larger than 64 MB',
    );
  });

  it('rejects malformed material data', () => {
    const invalid = /^Not a valid Tessel file: /;
    const load = (overrides: Record<string, unknown>) => () => parseProject(project({ materials: [fileMaterial('m', overrides)] }));
    expect(load({ baseColor: 'red' })).toThrow(invalid);
    expect(load({ emissive: undefined })).toThrow(invalid);
    expect(load({ metallic: 2 })).toThrow(invalid);
    expect(load({ roughness: -1 })).toThrow(invalid);
    expect(load({ emissiveStrength: 101 })).toThrow(invalid);
    expect(load({ normalScale: 11 })).toThrow(invalid);
    expect(load({ maps: { baseColor: 5 } })).toThrow(invalid);
    expect(load({ id: '' })).toThrow(invalid);
    expect(() => parseProject(project({ materials: {} }))).toThrow(invalid);
    expect(() => parseProject(project({ objects: [object('a', { materialId: 5 })] }))).toThrow(invalid);
  });
});
