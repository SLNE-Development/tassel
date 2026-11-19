import { beforeEach, describe, expect, it } from 'vitest';
import { createImagingService, type TextureImaging } from '../../imaging';
import { compositeLayers, paintStroke, type Rgba } from '../../imaging/pixels';
import { decodePng, encodePng } from '../../imaging/png';
import { parseProject, serializeProject } from '../project';
import { activeDoc, createAppState } from '../state';
import type { AppState, DocState, ImagingService, PaintLayer, Texture } from '../types';
import { commands } from './index';
import { runCommand, type AnyCommand, type CommandContext } from './registry';

// The paint commands with the real imaging service: its PNG codec and pixel functions are pure and run in
// Node. Only decoding JPEG / WebP needs a browser; a stand-in decoder is passed where a test needs one.

const byId = new Map<string, AnyCommand>(commands.map((c) => [c.id, c]));

let app: AppState;
let imaging: TextureImaging;
/** Names of the imaging methods the commands called, in order. */
let calls: string[];
const ctx: CommandContext = {
  get: () => app,
  set: (update) => {
    app = update(app);
  },
  services: { viewport: null, exporter: null },
};

/** Lets every call through to the service and notes its name. */
function counted(service: TextureImaging): ImagingService {
  return new Proxy(service, {
    get(target, key: keyof TextureImaging) {
      const method = target[key] as (...args: unknown[]) => unknown;
      return (...args: unknown[]) => {
        calls.push(key);
        return method.apply(target, args);
      };
    },
  });
}

beforeEach(() => {
  app = createAppState();
  imaging = createImagingService();
  calls = [];
  ctx.services.imaging = counted(imaging);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function run(id: string, params?: unknown): Promise<any> {
  const def = byId.get(id);
  if (!def) throw new Error(`Unknown command ${id}`);
  return runCommand(def, ctx, params);
}

const doc = () => activeDoc(app);
const state = (): DocState => doc().state;
const tex = (id: string): Texture => state().textures[id];
const layersOf = (id: string): readonly PaintLayer[] => tex(id).layers!;

async function pixelsOf(data: string): Promise<Rgba> {
  return (await decodePng(new Uint8Array(Buffer.from(data, 'base64'))))!.pixels;
}
/** The RGBA value at a pixel (row 0 = top) of a PNG. */
async function at(data: string, width: number, x: number, y: number): Promise<number[]> {
  return [...(await pixelsOf(data)).subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
}
const solid = (pixels: number, rgba: readonly number[]) => Uint8ClampedArray.from({ length: pixels * 4 }, (_, i) => rgba[i % 4]);

/** Runs a command that must be exactly one undo step, and checks undo and redo. */
async function expectUndoable(id: string, params: unknown): Promise<unknown> {
  const before = state();
  const past = doc().past.length;
  const result = await run(id, params);
  const after = state();
  expect(after).not.toBe(before);
  expect(doc().past).toHaveLength(past + 1);
  await run('history.undo');
  expect(state()).toBe(before);
  await run('history.redo');
  expect(state()).toBe(after);
  return result;
}

/** Runs a command that must fail and leave everything as it is. */
async function expectError(id: string, params: unknown, message: string | RegExp): Promise<void> {
  const before = app;
  await expect(run(id, params)).rejects.toThrow(message);
  expect(app).toBe(before);
}

/** A 32 x 32 paint texture; returns its id and base layer id. */
async function paintTexture(params: Record<string, unknown> = {}): Promise<{ id: string; layerId: string }> {
  return run('paint.create_texture', { width: 32, height: 32, color: '#ffffff', ...params });
}

/** An image file as a (not layered) texture, like an imported one. */
async function imported(pixels: Uint8ClampedArray, width: number, height: number): Promise<string> {
  const data = Buffer.from(await encodePng(pixels, width, height)).toString('base64');
  return (await run('texture.add', { name: 'Imported', mimeType: 'image/png', data, width, height })).id;
}

const JPEG =
  '/9j/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k='; // 1x1

describe('registration', () => {
  it('registers the paint commands', () => {
    expect(
      commands
        .map((c) => c.id)
        .filter((id) => id.startsWith('paint.'))
        .sort(),
    ).toEqual([
      'paint.add_layer',
      'paint.adjust',
      'paint.clear',
      'paint.clear_unused',
      'paint.copy_brush',
      'paint.create_texture',
      'paint.fill',
      'paint.flatten',
      'paint.frames',
      'paint.gradient',
      'paint.list_layers',
      'paint.merge_down',
      'paint.move_layer',
      'paint.move_pixels',
      'paint.pixel_fill',
      'paint.pixel_stroke',
      'paint.remove_layer',
      'paint.set_pixels',
      'paint.shape',
      'paint.stroke',
      'paint.transform',
      'paint.update_layer',
    ]);
  });

  it('fails clearly while there is no imaging service', async () => {
    ctx.services.imaging = null;
    await expectError('paint.create_texture', {}, 'The imaging service is not ready yet');
    await expectError('texture.normal_from_height', { sourceId: 'x' }, 'The imaging service is not ready yet');
  });
});

describe('paint.create_texture', () => {
  it('creates a layered PNG texture with one filled base layer', async () => {
    const result = (await expectUndoable('paint.create_texture', { name: 'Skin', width: 64, height: 16, color: '#3366CC' })) as {
      id: string;
      name: string;
      layerId: string;
    };
    expect(result.name).toBe('Skin');
    const texture = tex(result.id);
    expect(texture).toMatchObject({ id: result.id, name: 'Skin', mimeType: 'image/png', width: 64, height: 16 });
    expect(texture.layers).toEqual([{ id: result.layerId, name: 'Base', visible: true, opacity: 1, blend: 'normal', data: texture.data }]);
    // One image, one string: the base layer is the flattened image.
    expect(texture.layers![0].data).toBe(texture.data);
    expect(await pixelsOf(texture.data)).toEqual(solid(64 * 16, [0x33, 0x66, 0xcc, 255]));
  });

  it('uses the defaults of the contract and unique names', async () => {
    const a = await run('paint.create_texture');
    const b = await run('paint.create_texture');
    expect([a.name, b.name]).toEqual(['Paint', 'Paint.001']);
    expect(tex(a.id)).toMatchObject({ width: 1024, height: 1024 });
    expect(await at(tex(a.id).data, 1024, 500, 500)).toEqual([128, 128, 128, 255]);
  });

  it('puts the texture into a material slot in the same undo step', async () => {
    const m = (await run('material.create', {})).id;
    const result = (await expectUndoable('paint.create_texture', { width: 16, height: 16, materialId: m, slot: 'roughness' })) as { id: string };
    expect(state().materials[m].maps).toEqual({ roughness: result.id });
    await run('history.undo');
    expect(state().textures).toEqual({});
    expect(state().materials[m].maps).toEqual({});
  });

  it('rejects invalid sizes, colours and material references', async () => {
    const m = (await run('material.create', {})).id;
    for (const params of [{ width: 15 }, { height: 8193 }, { width: 100.5 }, { color: 'red' }, { color: '#fff' }, { name: '' }, { slot: 'height', materialId: m }]) {
      await expectError('paint.create_texture', params, /./);
    }
    await expectError('paint.create_texture', { materialId: m }, 'Pass materialId and slot together, or neither');
    await expectError('paint.create_texture', { slot: 'normal' }, 'Pass materialId and slot together, or neither');
    await expectError('paint.create_texture', { materialId: 'nope', slot: 'normal' }, 'Material "nope" does not exist');
    expect(calls).toEqual([]);
  });
});

describe('paint.stroke', () => {
  it('paints into the layer and updates the flattened image in one undo step', async () => {
    const { id, layerId } = await paintTexture();
    const before = tex(id);
    const result = await expectUndoable('paint.stroke', { textureId: id, layerId, points: [[0.25, 0.75]], color: '#ff0000', size: 8, hardness: 1 });
    expect(result).toEqual({ textureId: id, layerId, changed: true });
    const after = tex(id);
    expect(after.data).not.toBe(before.data);
    expect(after.layers![0].data).toBe(after.data); // still one image
    expect(after.layers![0]).toMatchObject({ id: layerId, name: 'Base', visible: true, opacity: 1, blend: 'normal' });
    // u 0.25 → x 8; v 0.75 is a quarter down from the TOP → y 8.
    expect(await at(after.data, 32, 8, 8)).toEqual([255, 0, 0, 255]);
    expect(await at(after.data, 32, 8, 24)).toEqual([255, 255, 255, 255]);
    expect(await at(after.data, 32, 24, 8)).toEqual([255, 255, 255, 255]);
    // Exactly the pure function's pixels.
    const expected = paintStroke(solid(32 * 32, [255, 255, 255, 255]), 32, 32, { color: '#ff0000', size: 8, opacity: 1, hardness: 1, spacing: 0.15, erase: false }, [[0.25, 0.75]]);
    expect(await pixelsOf(after.data)).toEqual(expected);
    // Undo brings back the very same strings.
    await run('history.undo');
    expect(tex(id)).toBe(before);
  });

  it('uses the contract defaults: black, 32 px, opacity 1, hardness 0.8, spacing 0.15', async () => {
    const { id, layerId } = await paintTexture({ width: 128, height: 128 });
    await run('paint.stroke', { textureId: id, layerId, points: [[0.5, 0.5]] });
    const expected = paintStroke(solid(128 * 128, [255, 255, 255, 255]), 128, 128, { color: '#000000', size: 32, opacity: 1, hardness: 0.8, spacing: 0.15, erase: false }, [[0.5, 0.5]]);
    expect(await pixelsOf(tex(id).data)).toEqual(expected);
    expect(await at(tex(id).data, 128, 64, 64)).toEqual([0, 0, 0, 255]);
    expect(await at(tex(id).data, 128, 64, 84)).toEqual([255, 255, 255, 255]);
  });

  it('does not build up opacity within a stroke, but does across strokes', async () => {
    const { id, layerId } = await paintTexture({ width: 64, height: 16 });
    const stroke = { textureId: id, layerId, points: [[0.1, 0.5], [0.9, 0.5, 1], [0.1, 0.5]], size: 6, opacity: 0.5, hardness: 1 };
    await run('paint.stroke', stroke);
    for (const x of [10, 20, 32, 50]) expect(await at(tex(id).data, 64, x, 8)).toEqual([128, 128, 128, 255]);
    await run('paint.stroke', stroke);
    expect(await at(tex(id).data, 64, 32, 8)).toEqual([64, 64, 64, 255]);
    expect(doc().past).toHaveLength(3);
  });

  it('is deterministic: the same call gives the same image file', async () => {
    const a = await paintTexture();
    const b = await paintTexture();
    const stroke = { points: [[0.1, 0.2, 0.4], [0.8, 0.9], [0.6, 0.1, 0.7]], color: '#12ab34', size: 5.5, opacity: 0.6, hardness: 0.3, spacing: 0.4 };
    await run('paint.stroke', { textureId: a.id, layerId: a.layerId, ...stroke });
    await run('paint.stroke', { textureId: b.id, layerId: b.layerId, ...stroke });
    expect(tex(a.id).data).toBe(tex(b.id).data);
    expect(tex(a.id).data).not.toBe(tex((await paintTexture()).id).data);
  });

  it('erases alpha instead of painting', async () => {
    const { id, layerId } = await paintTexture({ color: '#204060' });
    await run('paint.stroke', { textureId: id, layerId, points: [[0.5, 0.5]], size: 10, hardness: 1, erase: true, color: '#ff0000' });
    expect(await at(tex(id).data, 32, 16, 16)).toEqual([0x20, 0x40, 0x60, 0]);
    expect(await at(tex(id).data, 32, 2, 2)).toEqual([0x20, 0x40, 0x60, 255]);
    await run('paint.stroke', { textureId: id, layerId, points: [[0.1, 0.1]], size: 4, hardness: 1, erase: true, opacity: 0.5 });
    expect(await at(tex(id).data, 32, 3, 28)).toEqual([0x20, 0x40, 0x60, 128]);
  });

  it('keeps the other layers identical and composites the stack', async () => {
    const { id, layerId: base } = await paintTexture();
    const { layerId: middle } = await run('paint.add_layer', { textureId: id });
    const { layerId: top } = await run('paint.add_layer', { textureId: id });
    await run('paint.fill', { textureId: id, layerId: top, color: '#0000ff', opacity: 0.5 });
    const before = layersOf(id);
    calls = [];
    await expectUndoable('paint.stroke', { textureId: id, layerId: middle, points: [[0.5, 0.5]], color: '#ff0000', size: 10, hardness: 1 });
    expect(calls).toEqual(['stroke']);
    const after = layersOf(id);
    expect(after.map((l) => l.id)).toEqual([base, middle, top]);
    expect(after[0]).toBe(before[0]);
    expect(after[2]).toBe(before[2]);
    expect(after[1]).not.toBe(before[1]);
    expect({ ...after[1], data: '' }).toEqual({ ...before[1], data: '' });
    // The layer holds only the stroke; the texture shows it under the half-blue top layer.
    expect(await at(after[1].data, 32, 16, 16)).toEqual([255, 0, 0, 255]);
    expect(await at(after[1].data, 32, 2, 2)).toEqual([0, 0, 0, 0]);
    expect(await at(tex(id).data, 32, 16, 16)).toEqual([127, 0, 128, 255]);
    expect(await at(tex(id).data, 32, 2, 2)).toEqual([127, 127, 255, 255]);
    const stack = await Promise.all(after.map(async (l) => ({ pixels: await pixelsOf(l.data), visible: l.visible, opacity: l.opacity, blend: l.blend })));
    expect(await pixelsOf(tex(id).data)).toEqual(compositeLayers(32, 32, stack));
  });

  it('paints a hidden layer without touching the flattened image', async () => {
    const { id } = await paintTexture();
    const { layerId } = await run('paint.add_layer', { textureId: id });
    await run('paint.update_layer', { textureId: id, layerId, visible: false });
    const data = tex(id).data;
    await expectUndoable('paint.stroke', { textureId: id, layerId, points: [[0.5, 0.5]] });
    expect(tex(id).data).toBe(data);
    expect(await at(layersOf(id)[1].data, 32, 16, 16)).toEqual([0, 0, 0, 255]);
  });

  it('changes nothing for a stroke that misses the texture', async () => {
    const { id, layerId } = await paintTexture();
    const before = app;
    expect(await run('paint.stroke', { textureId: id, layerId, points: [[3, 3], [4, 3]], size: 4 })).toEqual({ textureId: id, layerId, changed: false });
    expect(app).toBe(before);
  });

  it('gives the same pixels as the live preview', async () => {
    const { id, layerId: base } = await paintTexture({ color: '#405060' });
    const { layerId } = await run('paint.add_layer', { textureId: id });
    await run('paint.update_layer', { textureId: id, layerId, blend: 'multiply', opacity: 0.8 });
    await run('paint.stroke', { textureId: id, layerId: base, points: [[0.2, 0.2], [0.8, 0.3]], color: '#ffcc00', size: 9, hardness: 0.2 });
    const brush = { color: '#22aa66', size: 7, opacity: 0.7, hardness: 0.5, spacing: 0.2, erase: false };
    const points = [[0.1, 0.8, 0.5], [0.5, 0.5, 1], [0.9, 0.7, 0.2], [0.4, 0.1]];
    const preview = await imaging.beginStroke(tex(id), layerId, brush);
    expect(preview.pixels).toEqual(await pixelsOf(tex(id).data));
    for (const point of points) preview.extend([point]);
    await run('paint.stroke', { textureId: id, layerId, points: preview.points, ...brush });
    expect(await pixelsOf(tex(id).data)).toEqual(preview.pixels);
    expect(await pixelsOf(layersOf(id)[1].data)).toEqual(preview.layer);
    // And the same again with a service that has nothing cached (as after loading a project).
    await run('history.undo');
    const fresh = createImagingService();
    const again = await fresh.beginStroke(tex(id), layerId, brush);
    again.extend(points);
    expect(again.pixels).toEqual(preview.pixels);
    ctx.services.imaging = fresh;
    await run('paint.stroke', { textureId: id, layerId, points, ...brush });
    expect(await pixelsOf(tex(id).data)).toEqual(preview.pixels);
  });

  it('paints several unconnected polylines as one stroke and one undo step with breaks', async () => {
    const { id, layerId } = await paintTexture({ width: 64, height: 64 });
    // A cross of two lines at 50 %: not connected, and no darker where they cross.
    const points = [[0.1, 0.5], [0.9, 0.5], [0.5, 0.9], [0.5, 0.1]];
    const brush = { color: '#000000', size: 8, opacity: 0.5, hardness: 1, spacing: 0.15, erase: false };
    const result = await expectUndoable('paint.stroke', { textureId: id, layerId, points, breaks: [2], ...brush });
    expect(result).toEqual({ textureId: id, layerId, changed: true });
    expect(doc().past).toHaveLength(2); // create_texture + ONE stroke
    for (const [x, y] of [[32, 32], [12, 32], [32, 12]]) expect(await at(tex(id).data, 64, x, y)).toEqual([128, 128, 128, 255]);
    expect(await at(tex(id).data, 64, 46, 20)).toEqual([255, 255, 255, 255]); // where the joining diagonal would be
    const white = solid(64 * 64, [255, 255, 255, 255]);
    expect(await pixelsOf(tex(id).data)).toEqual(paintStroke(white, 64, 64, brush, points, [2]));
    expect(await pixelsOf(tex(id).data)).not.toEqual(paintStroke(white, 64, 64, brush, points));
    // Undo removes all of it.
    await run('history.undo');
    expect(await pixelsOf(tex(id).data)).toEqual(white);
    // An empty breaks list is the plain stroke, byte for byte.
    const other = await paintTexture({ width: 64, height: 64 });
    await run('paint.stroke', { textureId: id, layerId, points, ...brush });
    await run('paint.stroke', { textureId: other.id, layerId: other.layerId, points, breaks: [], ...brush });
    expect(tex(other.id).data).toBe(tex(id).data);
  });

  it('gives the same pixels as a live preview with breaks', async () => {
    const { id } = await paintTexture({ color: '#405060' });
    const { layerId } = await run('paint.add_layer', { textureId: id });
    await run('paint.update_layer', { textureId: id, layerId, blend: 'multiply', opacity: 0.8 });
    const brush = { color: '#22aa66', size: 7, opacity: 0.6, hardness: 0.4, spacing: 0.2, erase: false };
    const preview = await imaging.beginStroke(tex(id), layerId, brush);
    preview.extend([[0.1, 0.8, 0.5], [0.5, 0.5, 1]]);
    preview.breakStroke();
    preview.extend([[0.9, 0.7, 0.2]]);
    preview.extend([[0.4, 0.1]]);
    preview.breakStroke();
    preview.extend([[0.3, 0.6]]); // a dot on top of the first polyline
    expect(preview.breaks).toEqual([2, 4]);
    await expectUndoable('paint.stroke', { textureId: id, layerId, points: preview.points, breaks: preview.breaks, ...brush });
    expect(await pixelsOf(tex(id).data)).toEqual(preview.pixels);
    expect(await pixelsOf(layersOf(id)[1].data)).toEqual(preview.layer);
  });

  it('rejects invalid breaks', async () => {
    const { id, layerId } = await paintTexture();
    const ok = { textureId: id, layerId, points: [[0.2, 0.5], [0.4, 0.5], [0.6, 0.5], [0.8, 0.5]] };
    calls = [];
    for (const breaks of [[0], [4], [5], [-1], [2, 2], [3, 1], [1, 2, 2]]) {
      await expectError('paint.stroke', { ...ok, breaks }, /breaks must be strictly increasing indices into points, each > 0 and < 4/);
    }
    for (const breaks of [[1.5], ['1'], 1, [NaN], [[1]]]) await expectError('paint.stroke', { ...ok, breaks }, /./);
    await expectError('paint.stroke', { ...ok, points: [[0.5, 0.5]], breaks: [1] }, /got 1 at breaks\[0\]/);
    expect(calls).toEqual([]);
    await run('paint.stroke', { ...ok, breaks: [1, 2, 3] });
  });

  it('rejects unknown textures and layers, textures without layers and invalid strokes', async () => {
    const { id, layerId } = await paintTexture();
    const plain = await imported(solid(4, [1, 2, 3, 255]), 2, 2);
    const ok = { textureId: id, layerId, points: [[0.5, 0.5]] };
    await expectError('paint.stroke', { ...ok, textureId: 'nope' }, 'Texture "nope" does not exist');
    await expectError('paint.stroke', { ...ok, layerId: 'nope' }, 'Texture "Paint" has no layer "nope"');
    await expectError('paint.stroke', { ...ok, textureId: plain }, /Texture "Imported" has no paint layers yet\. Call paint\.add_layer first/);
    await expectError('paint.stroke', { ...ok, points: [] }, /points is empty/);
    await expectError('paint.stroke', { ...ok, points: Array.from({ length: 100_001 }, () => [0.5, 0.5]) }, /at most 100000 points/);
    for (const points of [[[0.5]], [[0.5, 0.5, 1, 1]], [[0.5, NaN]], [[0.5, Infinity]], [['a', 0.5]], [0.5, 0.5], undefined]) {
      await expectError('paint.stroke', { ...ok, points }, /./);
    }
    for (const bad of [{ color: 'blue' }, { size: 0 }, { size: 5000 }, { opacity: 1.5 }, { opacity: -0.1 }, { hardness: 2 }, { spacing: 0 }, { erase: 'yes' }]) {
      await expectError('paint.stroke', { ...ok, ...bad }, /./);
    }
    expect(calls).toEqual(['blank']);
    // 100 000 points are fine.
    await run('paint.stroke', { ...ok, points: Array.from({ length: 100_000 }, (_, i) => [i / 100_000, 0.5]), size: 2 });
    expect(await at(tex(id).data, 32, 20, 16)).toEqual([0, 0, 0, 255]);
  });

  it('drops an edit whose texture changed while the pixels were computed', async () => {
    const { id, layerId } = await paintTexture();
    const first = run('paint.stroke', { textureId: id, layerId, points: [[0.2, 0.5]], color: '#ff0000', size: 6, hardness: 1 });
    const second = run('paint.stroke', { textureId: id, layerId, points: [[0.8, 0.5]], color: '#00ff00', size: 6, hardness: 1 });
    const results = await Promise.allSettled([first, second]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(String(rejected.reason)).toMatch(/Texture "Paint" was changed or removed while this command was working/);
    // Exactly one of the two strokes is there, whole.
    const red = (await at(tex(id).data, 32, 6, 16)).join() === '255,0,0,255';
    const green = (await at(tex(id).data, 32, 25, 16)).join() === '0,255,0,255';
    expect(red !== green).toBe(true);
  });
});

describe('paint.fill', () => {
  it('fills a layer, replacing or laying over', async () => {
    const { id, layerId: base } = await paintTexture();
    const { layerId } = await run('paint.add_layer', { textureId: id });
    const baseLayer = layersOf(id)[0];
    await expectUndoable('paint.fill', { textureId: id, layerId, color: '#FF0000', opacity: 0.5 });
    expect(await pixelsOf(layersOf(id)[1].data)).toEqual(solid(32 * 32, [255, 0, 0, 128]));
    expect(await pixelsOf(tex(id).data)).toEqual(solid(32 * 32, [255, 127, 127, 255]));
    expect(layersOf(id)[0]).toBe(baseLayer);
    await expectUndoable('paint.fill', { textureId: id, layerId: base, color: '#000000' });
    expect(await pixelsOf(layersOf(id)[0].data)).toEqual(solid(32 * 32, [0, 0, 0, 255]));
    expect(await pixelsOf(tex(id).data)).toEqual(solid(32 * 32, [128, 0, 0, 255]));
    // Opacity 0 is nothing at all.
    const before = app;
    expect((await run('paint.fill', { textureId: id, layerId, color: '#00ff00', opacity: 0 })).changed).toBe(false);
    expect(app).toBe(before);
  });

  it('rejects invalid input', async () => {
    const { id, layerId } = await paintTexture();
    await expectError('paint.fill', { textureId: id, layerId }, /./);
    await expectError('paint.fill', { textureId: id, layerId, color: 'red' }, /./);
    await expectError('paint.fill', { textureId: id, layerId, color: '#000000', opacity: 2 }, /./);
    await expectError('paint.fill', { textureId: 'nope', layerId, color: '#000000' }, 'Texture "nope" does not exist');
    await expectError('paint.fill', { textureId: id, layerId: 'nope', color: '#000000' }, /has no layer "nope"/);
  });
});

describe('paint.add_layer', () => {
  it('adds a transparent layer on top without re-encoding the image', async () => {
    const { id, layerId: base } = await paintTexture();
    const before = tex(id);
    calls = [];
    const result = (await expectUndoable('paint.add_layer', { textureId: id })) as { layerId: string };
    expect(calls).toEqual(['blank']);
    const after = tex(id);
    expect(after.data).toBe(before.data);
    expect(after.layers![0]).toBe(before.layers![0]);
    expect(after.layers!.map((l) => l.id)).toEqual([base, result.layerId]);
    expect(after.layers![1]).toMatchObject({ name: 'Layer 2', visible: true, opacity: 1, blend: 'normal' });
    expect(await pixelsOf(after.layers![1].data)).toEqual(new Uint8ClampedArray(32 * 32 * 4));
  });

  it('inserts at an index and makes names unique within the texture', async () => {
    const { id, layerId: base } = await paintTexture();
    const a = (await run('paint.add_layer', { textureId: id, name: 'Dirt' })).layerId;
    const b = (await run('paint.add_layer', { textureId: id, name: 'Dirt', index: 0 })).layerId;
    const c = (await run('paint.add_layer', { textureId: id, index: 1 })).layerId;
    expect(layersOf(id).map((l) => [l.id, l.name])).toEqual([
      [b, 'Dirt.001'],
      [c, 'Layer 4'],
      [base, 'Base'],
      [a, 'Dirt'],
    ]);
    await expectError('paint.add_layer', { textureId: id, index: 5 }, 'index must be 0..4');
    await expectError('paint.add_layer', { textureId: id, index: -1 }, /./);
    await expectError('paint.add_layer', { textureId: 'nope' }, 'Texture "nope" does not exist');
  });

  it('turns an imported PNG into the base layer as it is', async () => {
    const pixels = Uint8ClampedArray.from({ length: 8 * 4 * 4 }, (_, i) => (i * 37) % 256);
    const id = await imported(pixels, 8, 4);
    const before = tex(id);
    const m = (await run('material.create', {})).id;
    await run('material.update', { id: m, maps: { baseColor: id } });
    calls = [];
    const result = (await expectUndoable('paint.add_layer', { textureId: id })) as { layerId: string; baseLayerId: string };
    expect(calls).toEqual(['baseLayer', 'blank']);
    const after = tex(id);
    expect(after).toMatchObject({ id, name: 'Imported', mimeType: 'image/png', width: 8, height: 4 });
    expect(after.data).toBe(before.data);
    expect(after.layers!.map((l) => [l.id, l.name])).toEqual([
      [result.baseLayerId, 'Base'],
      [result.layerId, 'Layer 2'],
    ]);
    expect(after.layers![0].data).toBe(before.data);
    expect(state().materials[m].maps).toEqual({ baseColor: id });
    await run('paint.stroke', { textureId: id, layerId: result.layerId, points: [[0.5, 0.5]], size: 4, hardness: 1 });
    expect(await at(tex(id).data, 8, 4, 2)).toEqual([0, 0, 0, 255]);
    expect(await at(tex(id).data, 8, 0, 0)).toEqual([...pixels.subarray(0, 4)]);
  });

  it('converts a JPEG to a PNG base layer of the texture size', async () => {
    const decoded: unknown[][] = [];
    ctx.services.imaging = counted(
      createImagingService(async (bytes, mimeType, width, height) => {
        decoded.push([bytes.length, mimeType, width, height]);
        return solid(width * height, [10, 20, 30, 255]);
      }),
    );
    const id = (await run('texture.add', { name: 'Foto', mimeType: 'image/jpeg', data: JPEG, width: 1, height: 1 })).id;
    const { layerId, baseLayerId } = (await expectUndoable('paint.add_layer', { textureId: id })) as { layerId: string; baseLayerId: string };
    expect(decoded).toEqual([[107, 'image/jpeg', 1, 1]]);
    const texture = tex(id);
    expect(texture.mimeType).toBe('image/png');
    expect(texture.data).toBe(texture.layers![0].data);
    expect(texture.layers!.map((l) => l.id)).toEqual([baseLayerId, layerId]);
    expect(await at(texture.data, 1, 0, 0)).toEqual([10, 20, 30, 255]);
    await run('history.undo');
    expect(tex(id)).toMatchObject({ mimeType: 'image/jpeg', data: JPEG });
    expect(tex(id).layers).toBeUndefined();
  });

  it('reports images it cannot decode and textures that are too large', async () => {
    const jpeg = (await run('texture.add', { name: 'Foto', mimeType: 'image/jpeg', data: JPEG, width: 1, height: 1 })).id;
    await expectError('paint.add_layer', { textureId: jpeg }, 'This kind of image cannot be decoded here');
    const header = Buffer.from(await encodePng(new Uint8ClampedArray(4), 1, 1)).subarray(0, 33);
    header.writeUInt32BE(16384, 16);
    header.writeUInt32BE(16, 20);
    const huge = (await run('texture.add', { name: 'Huge', mimeType: 'image/png', data: header.toString('base64'), width: 16384, height: 16 })).id;
    for (const command of ['paint.add_layer', 'paint.flatten']) {
      await expectError(command, { textureId: huge }, 'Texture "Huge" is too large to paint or process: 16384 x 16 pixels, the limit is 8192 x 8192');
    }
    await expectError('texture.normal_from_height', { sourceId: huge }, /too large to paint or process/);
  });
});

describe('layer stack commands', () => {
  /** White base, red layer, half-transparent blue layer on top. */
  async function stack() {
    const { id, layerId: base } = await paintTexture();
    const red = (await run('paint.add_layer', { textureId: id, name: 'Red' })).layerId;
    const blue = (await run('paint.add_layer', { textureId: id, name: 'Blue' })).layerId;
    await run('paint.fill', { textureId: id, layerId: red, color: '#ff0000' });
    await run('paint.fill', { textureId: id, layerId: blue, color: '#0000ff', opacity: 0.5 });
    calls = [];
    return { id, base, red, blue };
  }
  const colour = async (id: string) => at(tex(id).data, 32, 5, 5);

  it('paint.list_layers lists the layers without their data', async () => {
    const { id, base, red, blue } = await stack();
    const before = app;
    const result = await run('paint.list_layers', { textureId: id });
    expect(app).toBe(before);
    expect(result).toMatchObject({ textureId: id, width: 32, height: 32 });
    expect(result.layers.map((l: PaintLayer) => [l.id, l.name, l.visible, l.opacity, l.blend])).toEqual([
      [base, 'Base', true, 1, 'normal'],
      [red, 'Red', true, 1, 'normal'],
      [blue, 'Blue', true, 1, 'normal'],
    ]);
    for (const l of result.layers) {
      expect(l.data).toBeUndefined();
      expect(l.bytes).toBeGreaterThan(60);
    }
    expect(JSON.stringify(result).length).toBeLessThan(600);
    const plain = await imported(solid(4, [1, 2, 3, 255]), 2, 2);
    expect((await run('paint.list_layers', { textureId: plain })).layers).toEqual([]);
    await expectError('paint.list_layers', { textureId: 'nope' }, 'Texture "nope" does not exist');
  });

  it('paint.update_layer renames without any pixel work', async () => {
    const { id, red } = await stack();
    const before = tex(id);
    const result = await expectUndoable('paint.update_layer', { textureId: id, layerId: red, name: 'Blue' });
    expect(calls).toEqual([]);
    expect(result).toEqual({ id: red, name: 'Blue.001', visible: true, opacity: 1, blend: 'normal' });
    const after = tex(id);
    expect(after.data).toBe(before.data);
    expect(after.layers![1].data).toBe(before.layers![1].data);
    expect(after.layers![0]).toBe(before.layers![0]);
    expect(after.layers![2]).toBe(before.layers![2]);
    // Nothing to change: no undo step, and its own name is not "taken".
    const unchanged = app;
    await run('paint.update_layer', { textureId: id, layerId: red, name: 'Blue.001', visible: true, opacity: 1 });
    await run('paint.update_layer', { textureId: id, layerId: red });
    expect(app).toBe(unchanged);
    expect(calls).toEqual([]);
  });

  it('paint.update_layer re-flattens when visibility, opacity or blend mode change', async () => {
    const { id, red, blue } = await stack();
    expect(await colour(id)).toEqual([127, 0, 128, 255]);
    await expectUndoable('paint.update_layer', { textureId: id, layerId: blue, visible: false });
    expect(await colour(id)).toEqual([255, 0, 0, 255]);
    await expectUndoable('paint.update_layer', { textureId: id, layerId: red, opacity: 0.5 });
    expect(await colour(id)).toEqual([255, 128, 128, 255]);
    await expectUndoable('paint.update_layer', { textureId: id, layerId: red, opacity: 1, blend: 'multiply' });
    expect(await colour(id)).toEqual([255, 0, 0, 255]);
    await run('paint.fill', { textureId: id, layerId: red, color: '#808080' });
    expect(await colour(id)).toEqual([128, 128, 128, 255]);
    await run('paint.update_layer', { textureId: id, layerId: red, blend: 'screen' });
    expect(await colour(id)).toEqual([255, 255, 255, 255]);
    // Changing a hidden layer that stays hidden needs no pixels either.
    calls = [];
    const data = tex(id).data;
    await expectUndoable('paint.update_layer', { textureId: id, layerId: blue, opacity: 0.3, blend: 'add' });
    expect(calls).toEqual([]);
    expect(tex(id).data).toBe(data);
    expect(layersOf(id)[2]).toMatchObject({ visible: false, opacity: 0.3, blend: 'add' });
    for (const bad of [{ opacity: 2 }, { blend: 'darken' }, { name: '' }, { visible: 1 }, { layerId: 'nope' }]) {
      await expectError('paint.update_layer', { textureId: id, layerId: red, ...bad }, /./);
    }
  });

  it('shares one string between the layer and the image while a single layer is all there is to see', async () => {
    const { id, base, red, blue } = await stack();
    await run('paint.update_layer', { textureId: id, layerId: blue, visible: false });
    await run('paint.update_layer', { textureId: id, layerId: base, visible: false });
    expect(tex(id).data).toBe(layersOf(id)[1].data);
    await run('paint.stroke', { textureId: id, layerId: red, points: [[0.5, 0.5]], size: 4 });
    expect(tex(id).data).toBe(layersOf(id)[1].data);
    await run('paint.update_layer', { textureId: id, layerId: red, visible: false });
    expect(await pixelsOf(tex(id).data)).toEqual(new Uint8ClampedArray(32 * 32 * 4));
  });

  it('paint.move_layer reorders the stack', async () => {
    const { id, base, red, blue } = await stack();
    await expectUndoable('paint.move_layer', { textureId: id, layerId: red, index: 2 });
    expect(layersOf(id).map((l) => l.id)).toEqual([base, blue, red]);
    expect(await colour(id)).toEqual([255, 0, 0, 255]);
    await run('paint.move_layer', { textureId: id, layerId: red, index: 0 });
    expect(layersOf(id).map((l) => l.id)).toEqual([red, base, blue]);
    expect(await colour(id)).toEqual([127, 127, 255, 255]);
    const before = app;
    expect(await run('paint.move_layer', { textureId: id, layerId: red, index: 0 })).toEqual({ layerId: red, index: 0 });
    expect(app).toBe(before);
    await expectError('paint.move_layer', { textureId: id, layerId: red, index: 3 }, 'index must be 0..2');
    await expectError('paint.move_layer', { textureId: id, layerId: 'nope', index: 0 }, /has no layer "nope"/);
  });

  it('paint.remove_layer removes a layer but never the last one', async () => {
    const { id, base, red, blue } = await stack();
    const layers = layersOf(id);
    await expectUndoable('paint.remove_layer', { textureId: id, layerId: red });
    expect(layersOf(id)).toEqual([layers[0], layers[2]]);
    expect(layersOf(id)[0]).toBe(layers[0]);
    expect(await colour(id)).toEqual([127, 127, 255, 255]);
    await run('paint.remove_layer', { textureId: id, layerId: base });
    expect(layersOf(id).map((l) => l.id)).toEqual([blue]);
    expect(await colour(id)).toEqual([0, 0, 255, 128]);
    await expectError('paint.remove_layer', { textureId: id, layerId: blue }, 'The last layer of a texture cannot be removed');
    await expectError('paint.remove_layer', { textureId: id, layerId: red }, /has no layer/);
  });

  it('paint.merge_down merges a layer into the one below, keeping the look', async () => {
    const { id, base, red, blue } = await stack();
    await run('paint.update_layer', { textureId: id, layerId: blue, blend: 'screen', opacity: 0.9 });
    const look = await pixelsOf(tex(id).data);
    const layers = layersOf(id);
    const result = await expectUndoable('paint.merge_down', { textureId: id, layerId: blue });
    expect(result).toEqual({ layerId: red });
    expect(layersOf(id).map((l) => [l.id, l.name])).toEqual([
      [base, 'Base'],
      [red, 'Red'],
    ]);
    expect(layersOf(id)[0]).toBe(layers[0]);
    expect(await pixelsOf(tex(id).data)).toEqual(look);
    await run('paint.merge_down', { textureId: id, layerId: red });
    expect(layersOf(id).map((l) => l.id)).toEqual([base]);
    expect(await pixelsOf(tex(id).data)).toEqual(look);
    expect(tex(id).data).toBe(layersOf(id)[0].data);
    await expectError('paint.merge_down', { textureId: id, layerId: base }, 'The bottom layer has no layer below it to merge into');
    const top = (await run('paint.add_layer', { textureId: id })).layerId;
    await run('paint.update_layer', { textureId: id, layerId: top, visible: false });
    await expectError('paint.merge_down', { textureId: id, layerId: top }, 'Both layers must be visible to merge them');
  });

  it('paint.flatten leaves one layer that is the image, without pixel work', async () => {
    const { id, base, red } = await stack();
    await run('paint.update_layer', { textureId: id, layerId: red, visible: false });
    calls = [];
    const before = tex(id);
    expect(await expectUndoable('paint.flatten', { textureId: id })).toEqual({ layerId: base });
    expect(calls).toEqual([]);
    const after = tex(id);
    expect(after.data).toBe(before.data);
    expect(after.layers).toEqual([{ id: base, name: 'Base', visible: true, opacity: 1, blend: 'normal', data: before.data }]);
    expect(await colour(id)).toEqual([127, 127, 255, 255]);
    // Already flat: nothing happens.
    const unchanged = app;
    await run('paint.flatten', { textureId: id });
    expect(app).toBe(unchanged);
    // An image without layers gets its one layer.
    const plain = await imported(solid(4, [1, 2, 3, 255]), 2, 2);
    const result = (await expectUndoable('paint.flatten', { textureId: plain })) as { layerId: string };
    expect(tex(plain).layers).toEqual([{ id: result.layerId, name: 'Base', visible: true, opacity: 1, blend: 'normal', data: tex(plain).data }]);
    await expectError('paint.flatten', { textureId: 'nope' }, 'Texture "nope" does not exist');
  });
});

describe('texture.normal_from_height', () => {
  it('creates a normal map texture from the luminance of the source', async () => {
    // Height rising by 4 per pixel to the right; see the pixel test for the numbers.
    const pixels = Uint8ClampedArray.from({ length: 64 * 16 * 4 }, (_, i) => (i % 4 === 3 ? 255 : ((i >> 2) % 64) * 4));
    const source = await imported(pixels, 64, 16);
    const before = tex(source);
    const result = (await expectUndoable('texture.normal_from_height', { sourceId: source })) as { id: string; name: string };
    expect(calls).toEqual(['normalFromHeight']);
    expect(result.name).toBe('Imported normal');
    const normal = tex(result.id);
    expect(normal).toMatchObject({ id: result.id, mimeType: 'image/png', width: 64, height: 16 });
    expect(normal.layers).toBeUndefined();
    expect(tex(source)).toBe(before);
    expect(await at(normal.data, 64, 30, 8)).toEqual([96, 128, 251, 255]);
    const inverted = await run('texture.normal_from_height', { sourceId: source, invert: true, strength: 8, name: 'Bumps' });
    expect(inverted.name).toBe('Bumps');
    expect((await at(tex(inverted.id).data, 64, 30, 8))[0]).toBeGreaterThan(200);
  });

  it('gives exactly (128, 128, 255) for a flat source, also a layered one', async () => {
    const { id } = await paintTexture({ color: '#5a5a5a' });
    const result = await run('texture.normal_from_height', { sourceId: id });
    expect(await pixelsOf(tex(result.id).data)).toEqual(solid(32 * 32, [128, 128, 255, 255]));
  });

  it('puts the result into the normal slot of a material in the same undo step', async () => {
    const { id } = await paintTexture();
    const m = (await run('material.create', {})).id;
    const result = (await expectUndoable('texture.normal_from_height', { sourceId: id, materialId: m })) as { id: string };
    expect(state().materials[m].maps).toEqual({ normal: result.id });
    await run('history.undo');
    expect(state().materials[m].maps).toEqual({});
    expect(Object.keys(state().textures)).toEqual([id]);
  });

  it('rejects unknown sources and materials and invalid values', async () => {
    const { id } = await paintTexture();
    await expectError('texture.normal_from_height', { sourceId: 'nope' }, 'Texture "nope" does not exist');
    await expectError('texture.normal_from_height', { sourceId: id, materialId: 'nope' }, 'Material "nope" does not exist');
    await expectError('texture.normal_from_height', { sourceId: id, strength: -1 }, /./);
    await expectError('texture.normal_from_height', { sourceId: id, name: '' }, /./);
    await expectError('texture.normal_from_height', {}, /./);
  });
});

describe('project files with paint layers', () => {
  const parse = (edit: (texture: Record<string, unknown> & { layers: Record<string, unknown>[] }) => void) => {
    const file = JSON.parse(serializeProject(doc()));
    edit(file.textures[0]);
    return () => parseProject(JSON.stringify(file));
  };

  async function painted(): Promise<string> {
    const { id, layerId } = await paintTexture({ name: 'Skin' });
    const top = (await run('paint.add_layer', { textureId: id, name: 'Details' })).layerId;
    await run('paint.stroke', { textureId: id, layerId: top, points: [[0.2, 0.2], [0.8, 0.8]], color: '#aa0000', size: 5 });
    await run('paint.update_layer', { textureId: id, layerId: top, blend: 'multiply', opacity: 0.75 });
    await run('paint.stroke', { textureId: id, layerId, points: [[0.5, 0.5]], erase: true, size: 6 });
    return id;
  }

  it('round trips layered textures', async () => {
    const id = await painted();
    const plain = await imported(solid(4, [1, 2, 3, 255]), 2, 2);
    const m = (await run('material.create', {})).id;
    await run('material.update', { id: m, maps: { baseColor: id } });
    const loaded = parseProject(serializeProject(doc())).state;
    expect(loaded.textures).toEqual(state().textures);
    expect(loaded.textures[id].layers).toHaveLength(2);
    expect(loaded.textures[id].layers![1]).toMatchObject({ name: 'Details', blend: 'multiply', opacity: 0.75, visible: true });
    expect(loaded.textures[plain].layers).toBeUndefined();
    expect(Object.hasOwn(loaded.textures[plain], 'layers')).toBe(false);
    expect(loaded.materials[m].maps).toEqual({ baseColor: id });
    // The loaded document can be painted on right away.
    app = { ...app, docs: { ...app.docs, [doc().id]: { ...doc(), state: loaded } } };
    ctx.services.imaging = createImagingService();
    const look = await pixelsOf(tex(id).data);
    await run('paint.stroke', { textureId: id, layerId: tex(id).layers![1].id, points: [[3, 3]] });
    await run('paint.update_layer', { textureId: id, layerId: tex(id).layers![1].id, opacity: 0.5 });
    await run('paint.update_layer', { textureId: id, layerId: tex(id).layers![1].id, opacity: 0.75 });
    expect(await pixelsOf(tex(id).data)).toEqual(look);
  });

  it('loads files written before layers existed', async () => {
    await imported(solid(4, [1, 2, 3, 255]), 2, 2);
    const file = JSON.parse(serializeProject(doc()));
    expect(file.textures[0].layers).toBeUndefined();
    const loaded = parseProject(JSON.stringify(file)).state;
    expect(Object.values(loaded.textures)).toEqual(Object.values(state().textures));
  });

  it('rejects layered textures whose layers are invalid', async () => {
    await painted();
    const other = Buffer.from(await encodePng(new Uint8ClampedArray(16 * 32 * 4), 16, 32)).toString('base64');
    const invalid = 'Not a valid Tessel file: ';
    expect(parse(() => {})).not.toThrow();
    expect(parse((t) => (t.layers[1].data = other))).toThrow(`${invalid}texture "Skin": paint layer "Details" is 16 x 32 pixels, but the texture is 32 x 32`);
    expect(parse((t) => (t.layers[1].data = JPEG))).toThrow(`${invalid}texture "Skin": paint layer "Details" is not a valid PNG image`);
    expect(parse((t) => (t.layers[0].data = ''))).toThrow(`${invalid}texture "Skin": paint layer "Base" is not a valid PNG image`);
    expect(parse((t) => (t.layers[0].data = 'iVBORw0KGgo='))).toThrow(`${invalid}texture "Skin": paint layer "Base" is not a valid PNG image`);
    expect(parse((t) => (t.layers[0].data = '!!!!'))).toThrow('paint layer "Base" is not a valid PNG image');
    expect(parse((t) => (t.layers = []))).toThrow(`${invalid}texture "Skin": has an empty list of paint layers`);
    expect(parse((t) => (t.layers[1].id = t.layers[0].id))).toThrow(`${invalid}texture "Skin": has two paint layers with the same id`);
    expect(parse((t) => (t.mimeType = 'image/jpeg'))).toThrow(/texture "Skin"/);
    for (const edit of [
      (l: Record<string, unknown>) => (l.blend = 'darken'),
      (l: Record<string, unknown>) => (l.opacity = 1.5),
      (l: Record<string, unknown>) => (l.opacity = '1'),
      (l: Record<string, unknown>) => (l.visible = 'yes'),
      (l: Record<string, unknown>) => (l.id = ''),
      (l: Record<string, unknown>) => delete l.data,
      (l: Record<string, unknown>) => delete l.name,
    ]) {
      expect(parse((t) => edit(t.layers[1]))).toThrow(invalid);
    }
    expect(parse((t) => (t.layers = 'none' as never))).toThrow(invalid);
  });

  it('rejects a texture whose declared size is not the size of its image', async () => {
    await imported(solid(4, [1, 2, 3, 255]), 2, 2);
    expect(parse((t) => (t.width = 1))).toThrow('Not a valid Tessel file: texture "Imported": is 2 x 2 pixels according to its image data, not 1 x 2');
    expect(parse((t) => (t.height = 4096))).toThrow(/is 2 x 2 pixels according to its image data, not 2 x 4096/);
  });
});
