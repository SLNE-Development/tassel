import { beforeEach, describe, expect, it } from 'vitest';
import { createImagingService, type TextureImaging } from '../../imaging';
import { decodePng, encodePng } from '../../imaging/png';
import { toBase64, fromBase64 } from '../../io/bytes';
import { faceRegions, mirrorMaps } from '../minecraft/paintRegions';
import { minecraftApp, testApp, type TestApp } from '../minecraft/testing';
import { parseProject, serializeProject } from '../project';
import { activeDoc } from '../state';

// The pixel-art paint commands with the real imaging service (pure code, runs in Node).

let imaging: TextureImaging;
beforeEach(() => {
  imaging = createImagingService();
});

/** A width x height PNG in one colour (RGBA bytes), base64. */
async function png(width: number, height: number, rgba: [number, number, number, number] = [0, 0, 0, 0]): Promise<string> {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels.set(rgba, i);
  return toBase64(await encodePng(pixels, width, height));
}

async function addPng(t: TestApp, name: string, width = 16, height = 16, rgba?: [number, number, number, number]): Promise<string> {
  return (await t.run('texture.add', { name, mimeType: 'image/png', data: await png(width, height, rgba), width, height })).id;
}

async function pixels(data: string) {
  const decoded = await decodePng(fromBase64(data));
  if (!decoded) throw new Error('not a PNG');
  return decoded;
}

async function pixelAt(t: TestApp, textureId: string, x: number, y: number): Promise<number[]> {
  const texture = t.state().textures[textureId];
  const { pixels: p, width } = await pixels(texture.data);
  const i = (y * width + x) * 4;
  return [p[i], p[i + 1], p[i + 2], p[i + 3]];
}

const RED = [255, 0, 0, 255];
const CLEAR = [0, 0, 0, 0];

describe('pixel painting in Minecraft documents', () => {
  it('paints pixel-exact into a texture without layers, as one undo step', async () => {
    const t = await minecraftApp({}, { imaging });
    const id = await addPng(t, 'stone');
    const before = t.state().textures[id];
    const result = await t.run('paint.pixel_stroke', { textureId: id, points: [[0, 0], [3, 0]], color: '#ff0000' });
    expect(result).toEqual({ textureId: id, layerId: null, changed: true });
    for (let x = 0; x <= 3; x++) expect(await pixelAt(t, id, x, 0)).toEqual(RED);
    expect(await pixelAt(t, id, 4, 0)).toEqual(CLEAR);
    expect(await pixelAt(t, id, 0, 1)).toEqual(CLEAR);
    expect(t.state().textures[id].layers).toBeUndefined();
    await t.run('history.undo');
    expect(t.state().textures[id]).toBe(before);
  });

  it('reports no change (and adds no undo step) when nothing changes', async () => {
    const t = await minecraftApp({}, { imaging });
    const id = await addPng(t, 'stone');
    const history = activeDoc(t.app()).past.length;
    const result = await t.run('paint.pixel_stroke', { textureId: id, points: [[0, 0]], erase: true });
    expect(result.changed).toBe(false);
    expect(activeDoc(t.app()).past.length).toBe(history);
  });

  it('fills the face under a pixel, an element, and the connected colour', async () => {
    const t = await minecraftApp({}, { imaging });
    const id = await addPng(t, 'block');
    await t.run('cuboid.add', { from: [0, 0, 0], to: [4, 4, 4], texture: id });
    const regions = faceRegions(t.state(), id);
    expect(regions).toHaveLength(6);
    const north = regions.find((r) => r.face === 'north')!;
    await t.run('paint.pixel_fill', { textureId: id, mode: 'face', x: north.rect.x, y: north.rect.y, color: '#ff0000' });
    expect(await pixelAt(t, id, north.rect.x, north.rect.y)).toEqual(RED);
    expect(await pixelAt(t, id, north.rect.x + north.rect.width - 1, north.rect.y + north.rect.height - 1)).toEqual(RED);
    // Element mode covers every face.
    await t.run('paint.pixel_fill', { textureId: id, mode: 'element', elementId: t.state().order[0], color: '#00ff00' });
    for (const region of regions) expect(await pixelAt(t, id, region.rect.x, region.rect.y)).toEqual([0, 255, 0, 255]);
    // Connected: the transparent area outside the faces.
    await t.run('paint.pixel_fill', { textureId: id, mode: 'connected', x: 15, y: 15, color: '#0000ff' });
    expect(await pixelAt(t, id, 15, 15)).toEqual([0, 0, 255, 255]);
    expect(await pixelAt(t, id, north.rect.x, north.rect.y)).toEqual([0, 255, 0, 255]);
  });

  it('clears unused texture space', async () => {
    const t = await minecraftApp({}, { imaging });
    const id = await addPng(t, 'block', 16, 16, [9, 9, 9, 255]);
    await t.run('cuboid.add', { from: [0, 0, 0], to: [2, 2, 2], texture: id });
    const keep = faceRegions(t.state(), id)[0].rect;
    await t.run('paint.clear_unused', { textureId: id });
    expect(await pixelAt(t, id, keep.x, keep.y)).toEqual([9, 9, 9, 255]);
    expect(await pixelAt(t, id, 15, 15)).toEqual(CLEAR);
  });

  it('mirrors a stroke onto the mirror-image element (global X)', async () => {
    const t = await minecraftApp({}, { imaging });
    const id = await addPng(t, 'block', 32, 32);
    await t.run('minecraft.set_settings', { textureSize: [32, 32] });
    await t.run('cuboid.add', { from: [0, 0, 0], to: [4, 4, 4], texture: id });
    await t.run('cuboid.add', { from: [12, 0, 0], to: [16, 4, 4], texture: id });
    const [left, right] = t.state().order;
    // Give the right element its own UV area so the two do not overlap.
    await t.run('cuboid.set_face', { ids: [right], faces: ['north'], uv: [16, 16, 20, 20] });
    await t.run('cuboid.set_face', { ids: [left], faces: ['north'], uv: [0, 16, 4, 20] });
    const maps = mirrorMaps(t.state(), id, ['x'], 'global');
    const fromLeft = maps.find((m) => m.from.x === 0 && m.from.y === 16)!;
    expect(fromLeft.to).toEqual({ x: 16, y: 16, width: 4, height: 4 });
    expect(fromLeft).toMatchObject({ flipX: true, flipY: false, swap: false });
    await t.run('paint.pixel_stroke', { textureId: id, points: [[0, 16]], color: '#ff0000', mirror: { axes: ['x'] } });
    expect(await pixelAt(t, id, 0, 16)).toEqual(RED);
    expect(await pixelAt(t, id, 19, 16)).toEqual(RED);
    // Local symmetry: within the same face.
    const local = mirrorMaps(t.state(), id, ['x'], 'local').find((m) => m.from.x === 0 && m.from.y === 16)!;
    expect(local.to).toEqual(local.from);
  });

  it('accounts for rotated and flipped face UVs in mirror maps', async () => {
    const t = await minecraftApp({}, { imaging });
    const id = await addPng(t, 'block');
    await t.run('cuboid.add', { from: [0, 0, 0], to: [4, 4, 4], texture: id });
    const [el] = t.state().order;
    await t.run('cuboid.set_face', { ids: [el], faces: ['north'], uv: [4, 0, 0, 4] });
    const map = mirrorMaps(t.state(), id, ['x'], 'local').find((m) => m.from.x === 0 && m.from.y === 0 && m.to.x === 0)!;
    // The UV is flipped horizontally, which the mirror's own flip cancels... within the same face both flips meet.
    expect(map).toMatchObject({ flipX: true, swap: false });
    await t.run('cuboid.set_face', { ids: [el], faces: ['north'], uv: [0, 0, 4, 4], rotation: 90 });
    const rotated = mirrorMaps(t.state(), id, ['x'], 'local').find((m) => m.from.x === 0 && m.from.y === 0 && m.to.x === 0)!;
    // Rotated by 90 degrees, the face's horizontal is the texture's vertical.
    expect(rotated).toMatchObject({ flipX: false, flipY: true, swap: false });
  });

  it('refuses element fill modes and model mirroring in free documents', async () => {
    const t = testApp({ imaging });
    const id = await addPng(t, 'paint');
    await expect(t.run('paint.pixel_fill', { textureId: id, mode: 'face', x: 0, y: 0 })).rejects.toThrow(/Minecraft Java document/);
    await expect(t.run('paint.pixel_stroke', { textureId: id, points: [[0, 0]], mirror: { axes: ['x'] } })).rejects.toThrow(/Minecraft Java document/);
    // Image symmetry works anywhere.
    await t.run('paint.pixel_stroke', { textureId: id, points: [[0, 0]], color: '#ff0000', mirror: { image: true } });
    expect(await pixelAt(t, id, 15, 0)).toEqual(RED);
  });
});

describe('pixel painting on layered textures (free documents keep working)', () => {
  it('paints the top layer by default and keeps the smooth brush working', async () => {
    const t = testApp({ imaging });
    const { id, layerId } = await t.run('paint.create_texture', { width: 16, height: 16, color: '#ffffff' });
    const top = (await t.run('paint.add_layer', { textureId: id })).layerId;
    await t.run('paint.pixel_stroke', { textureId: id, points: [[1, 1]], color: '#ff0000' });
    const texture = t.state().textures[id];
    const layer = texture.layers!.find((l) => l.id === top)!;
    const base = texture.layers!.find((l) => l.id === layerId)!;
    const top1 = (await pixels(layer.data)).pixels;
    expect([...top1.slice((16 + 1) * 4, (16 + 1) * 4 + 4)]).toEqual(RED);
    expect([...(await pixels(base.data)).pixels.slice((16 + 1) * 4, (16 + 1) * 4 + 4)]).toEqual([255, 255, 255, 255]);
    expect(await pixelAt(t, id, 1, 1)).toEqual(RED);
    // The smooth brush still paints the same layer.
    const stroke = await t.run('paint.stroke', { textureId: id, layerId: top, points: [[0.5, 0.5]], size: 4, color: '#0000ff' });
    expect(stroke.changed).toBe(true);
  });

  it('adjusts, moves and transforms pixels', async () => {
    const t = testApp({ imaging });
    const id = await addPng(t, 'img', 4, 2);
    await t.run('paint.pixel_stroke', { textureId: id, points: [[0, 0]], color: '#ff0000' });
    await t.run('paint.adjust', { textureId: id, adjust: { type: 'invert' } });
    expect(await pixelAt(t, id, 0, 0)).toEqual([0, 255, 255, 255]);
    await t.run('paint.move_pixels', { textureId: id, selection: [{ shape: 'rect', x: 0, y: 0, width: 1, height: 1 }], dx: 1, dy: 1 });
    expect(await pixelAt(t, id, 1, 1)).toEqual([0, 255, 255, 255]);
    expect(await pixelAt(t, id, 0, 0)).toEqual(CLEAR);
    await t.run('paint.transform', { textureId: id, transform: { op: 'rotate', direction: 'cw' } });
    const rotated = t.state().textures[id];
    expect([rotated.width, rotated.height]).toEqual([2, 4]);
  });
});

describe('animated textures', () => {
  it('adds frames, sets the animation and exports the .mcmeta', async () => {
    const t = await minecraftApp({}, { imaging });
    const id = await addPng(t, 'fire', 16, 16, [200, 100, 0, 255]);
    expect((await t.run('texture.export', { id })).mcmeta).toBeUndefined();
    await t.run('paint.frames', { textureId: id, action: 'duplicate', index: 0 });
    await t.run('paint.frames', { textureId: id, action: 'add' });
    let texture = t.state().textures[id];
    expect([texture.width, texture.height]).toEqual([16, 48]);
    expect(texture.animation).toEqual({ frametime: 1, interpolate: false });
    expect(await pixelAt(t, id, 0, 16)).toEqual([200, 100, 0, 255]);
    expect(await pixelAt(t, id, 0, 32)).toEqual(CLEAR);
    await t.run('texture.set_animation', { id, animation: { frametime: 4, interpolate: true } });
    const exported = await t.run('texture.export', { id });
    expect(exported.fileName).toBe('fire.png');
    expect(exported.mcmeta.fileName).toBe('fire.png.mcmeta');
    expect(JSON.parse(exported.mcmeta.text)).toEqual({ animation: { frametime: 4, interpolate: true } });
    // Frames survive saving.
    const reopened = parseProject(serializeProject(activeDoc(t.app())));
    expect(reopened.state.textures[id].animation).toEqual({ frametime: 4, interpolate: true });
    // Removing frames down to one keeps the animation settings; a still texture can drop them.
    await t.run('paint.frames', { textureId: id, action: 'remove', index: 2 });
    await t.run('paint.frames', { textureId: id, action: 'move', index: 1, to: 0 });
    texture = t.state().textures[id];
    expect(texture.height).toBe(32);
    await t.run('texture.set_animation', { id, animation: null });
    expect(t.state().textures[id].animation).toBeUndefined();
    await expect(t.run('texture.set_animation', { id: await addPng(t, 'wide', 16, 8), animation: { frametime: 1 } })).rejects.toThrow(/multiple of its width/);
  });

  it('fills face areas in the chosen frame', async () => {
    const t = await minecraftApp({}, { imaging });
    const id = await addPng(t, 'water', 16, 32);
    await t.run('texture.set_animation', { id, animation: { frametime: 2 } });
    await t.run('cuboid.add', { from: [0, 0, 0], to: [16, 16, 16], texture: id });
    await t.run('paint.pixel_fill', { textureId: id, mode: 'face', x: 0, y: 16, frame: 1, color: '#ff0000' });
    expect(await pixelAt(t, id, 0, 16)).toEqual(RED);
    expect(await pixelAt(t, id, 0, 0)).toEqual(CLEAR);
  });
});
