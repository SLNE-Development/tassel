import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaintBrush, PaintLayer, Texture } from '../core/types';
import { blankPixels, compositeLayers, paintStroke } from './pixels';
import * as png from './png';
import { createImagingService } from './service';

// Count how often the service really decodes and encodes PNGs.
vi.mock('./png', async (original) => {
  const real = await original<typeof import('./png')>();
  return { decodePng: vi.fn(real.decodePng), encodePng: vi.fn(real.encodePng) };
});
const decodes = vi.mocked(png.decodePng);
const encodes = vi.mocked(png.encodePng);

beforeEach(() => {
  decodes.mockClear();
  encodes.mockClear();
});

const brush: PaintBrush = { color: '#ff0000', size: 6, opacity: 1, hardness: 1, spacing: 0.15, erase: false };
const SIZE = 32;

const pixelsOf = async (data: string) => (await vi.importActual<typeof import('./png')>('./png')).decodePng(new Uint8Array(Buffer.from(data, 'base64'))).then((image) => image!.pixels);

function layerOf(id: string, data: string, overrides: Partial<PaintLayer> = {}): PaintLayer {
  return { id, name: id, visible: true, opacity: 1, blend: 'normal', data, ...overrides };
}

function textureOf(data: string, layers?: PaintLayer[], overrides: Partial<Texture> = {}): Texture {
  return { id: 't', name: 'T', mimeType: 'image/png', data, width: SIZE, height: SIZE, layers, ...overrides };
}

/** A two-layer texture (white base, transparent top) made by `service`. */
async function twoLayers(service: ReturnType<typeof createImagingService>): Promise<Texture> {
  const base = layerOf('base', await service.blank(SIZE, SIZE, '#ffffff'));
  const top = layerOf('top', await service.blank(SIZE, SIZE, null));
  return textureOf(base.data, [base, top]);
}

/** The texture after a stroke on a layer, as the paint command would store it. */
function withEdit(texture: Texture, layerId: string, edit: { layer: string; flattened: string }): Texture {
  return { ...texture, data: edit.flattened, layers: texture.layers!.map((l) => (l.id === layerId ? { ...l, data: edit.layer } : l)) };
}

describe('imaging service', () => {
  it('keeps decoded layers in its cache: consecutive strokes decode nothing', async () => {
    const service = createImagingService();
    let texture = await twoLayers(service);
    for (const u of [0.2, 0.4, 0.6, 0.8]) texture = withEdit(texture, 'top', await service.stroke(texture, 'top', brush, [[u, 0.5]]));
    expect(decodes).not.toHaveBeenCalled();
    expect(encodes).toHaveBeenCalledTimes(2 + 4 * 2); // per stroke: the layer and the flattened image

    // A service that has seen none of these images (after loading a project) decodes each layer once.
    const fresh = createImagingService();
    for (const u of [0.2, 0.4]) texture = withEdit(texture, 'top', await fresh.stroke(texture, 'top', brush, [[u, 0.2]]));
    expect(decodes).toHaveBeenCalledTimes(2);
    await fresh.beginStroke(texture, 'top', brush);
    await fresh.pixels(texture);
    expect(decodes).toHaveBeenCalledTimes(2);
    // Six dots on white.
    const expected = [0.2, 0.4, 0.6, 0.8].reduce((pixels, u) => paintStroke(pixels, SIZE, SIZE, brush, [[u, 0.5]]), blankPixels(SIZE, SIZE, '#ffffff'));
    const all = [0.2, 0.4].reduce((pixels, u) => paintStroke(pixels, SIZE, SIZE, brush, [[u, 0.2]]), expected);
    expect(await pixelsOf(texture.data)).toEqual(all);
  });

  it('decodes an image only once when it is asked for several times at once', async () => {
    const maker = createImagingService();
    const texture = await twoLayers(maker);
    const service = createImagingService();
    const [a, b] = await Promise.all([service.pixels(texture), service.pixels(texture)]);
    expect(a.pixels).toBe(b.pixels);
    expect(decodes).toHaveBeenCalledTimes(1);
  });

  it('gives correct results when the cache is too small to hold anything', async () => {
    const small = createImagingService(undefined, 1);
    const roomy = createImagingService();
    let a = await twoLayers(small);
    let b = await twoLayers(roomy);
    for (const u of [0.3, 0.7]) {
      a = withEdit(a, 'top', await small.stroke(a, 'top', { ...brush, opacity: 0.5 }, [[u, 0.5], [0.5, 0.5]]));
      b = withEdit(b, 'top', await roomy.stroke(b, 'top', { ...brush, opacity: 0.5 }, [[u, 0.5], [0.5, 0.5]]));
    }
    expect(a).toEqual(b);
    // The roomy service decodes nothing; the small one decodes the base layer on every stroke. Whether the new top
    // layer survives in the one-entry cache depends on which of the two parallel encodes finishes last.
    expect(decodes.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('uses one string for the layer and the image when the layer is all there is to see', async () => {
    const service = createImagingService();
    const base = layerOf('base', await service.blank(SIZE, SIZE, '#ffffff'));
    const hidden = layerOf('hidden', await service.blank(SIZE, SIZE, null), { visible: false });
    const texture = textureOf(base.data, [base, hidden]);
    encodes.mockClear();
    const edit = await service.stroke(texture, 'base', brush, [[0.5, 0.5]]);
    expect(edit.flattened).toBe(edit.layer);
    expect(encodes).toHaveBeenCalledTimes(1);
    // Painting the hidden layer leaves the image alone.
    const onHidden = await service.stroke(texture, 'hidden', brush, [[0.5, 0.5]]);
    expect(onHidden.flattened).toBe(texture.data);
    expect(onHidden.layer).not.toBe(hidden.data);
    expect(encodes).toHaveBeenCalledTimes(2);
    expect(await service.flatten(SIZE, SIZE, [base, hidden])).toBe(base.data);
    expect(encodes).toHaveBeenCalledTimes(2);
    // A stroke that misses changes nothing and encodes nothing.
    expect(await service.stroke(texture, 'base', brush, [[5, 5]])).toEqual({ layer: base.data, flattened: texture.data });
    expect(encodes).toHaveBeenCalledTimes(2);
  });

  it('flattens, merges and fills with the pure pixel functions', async () => {
    const service = createImagingService();
    const base = layerOf('base', await service.blank(SIZE, SIZE, '#c86432'));
    const top = layerOf('top', await service.blank(SIZE, SIZE, '#64c832'), { blend: 'multiply', opacity: 0.5 });
    const stack = [
      { pixels: blankPixels(SIZE, SIZE, '#c86432'), visible: true, opacity: 1, blend: 'normal' as const },
      { pixels: blankPixels(SIZE, SIZE, '#64c832'), visible: true, opacity: 0.5, blend: 'multiply' as const },
    ];
    const expected = compositeLayers(SIZE, SIZE, stack);
    expect(await pixelsOf(await service.flatten(SIZE, SIZE, [base, top]))).toEqual(expected);
    expect(await pixelsOf(await service.mergeDown(SIZE, SIZE, base, top))).toEqual(expected);
    expect([...expected.subarray(0, 4)]).toEqual([139, 89, 30, 255]);
    expect(await pixelsOf(await service.flatten(SIZE, SIZE, [{ ...base, visible: false }, { ...top, opacity: 0 }]))).toEqual(blankPixels(SIZE, SIZE, null));
    const filled = await service.fill(textureOf(await service.flatten(SIZE, SIZE, [base, top]), [base, top]), 'top', '#000000', 1);
    expect(await pixelsOf(filled.layer)).toEqual(blankPixels(SIZE, SIZE, '#000000'));
    expect([...(await pixelsOf(filled.flattened)).subarray(0, 4)]).toEqual([100, 50, 25, 255]);
    await expect(service.stroke(textureOf(base.data, [base]), 'nope', brush, [[0.5, 0.5]])).rejects.toThrow('Texture "T" has no layer "nope"');
    await expect(service.beginStroke(textureOf(base.data), 'base', brush)).rejects.toThrow('Texture "T" has no layer "base"');
  });

  it('gives only fully opaque images to the opaque encoder', async () => {
    const real = await vi.importActual<typeof import('./png')>('./png');
    const opaque: number[] = [];
    const service = createImagingService(undefined, undefined, async (pixels, width, height) => {
      opaque.push(pixels.length);
      return real.encodePng(pixels, width, height);
    });
    let texture = await twoLayers(service); // a white layer and a transparent one
    expect(opaque).toHaveLength(1);
    expect(encodes).toHaveBeenCalledTimes(1);
    // The painted layer is mostly transparent, the flattened image opaque.
    texture = withEdit(texture, 'top', await service.stroke(texture, 'top', brush, [[0.5, 0.5]]));
    expect(opaque).toHaveLength(2);
    expect(encodes).toHaveBeenCalledTimes(2);
    // One erased pixel is enough to make an image not opaque.
    texture = withEdit(texture, 'base', await service.stroke(texture, 'base', { ...brush, size: 1, erase: true }, [[0.02, 0.02]]));
    expect(opaque).toHaveLength(2);
    expect(encodes).toHaveBeenCalledTimes(4);
    const flat = await pixelsOf(texture.data);
    expect(flat[31 * SIZE * 4 + 3]).toBeLessThan(255);
    expect([...flat.subarray((16 * SIZE + 16) * 4, (16 * SIZE + 16) * 4 + 4)]).toEqual([255, 0, 0, 255]);
  });

  it('refuses images whose header claims more than 8192 x 8192 pixels, before decoding', async () => {
    const service = createImagingService(async () => {
      throw new Error('must not be asked to decode');
    });
    const header = Buffer.from(await (await vi.importActual<typeof import('./png')>('./png')).encodePng(new Uint8ClampedArray(4), 1, 1));
    header.writeUInt32BE(8192, 16);
    header.writeUInt32BE(8193, 20);
    const bomb = header.toString('base64');
    // Whatever size the texture declares.
    for (const [width, height] of [
      [1, 1],
      [8192, 8193],
    ]) {
      const texture = textureOf(bomb, undefined, { width, height });
      await expect(service.pixels(texture)).rejects.toThrow('The image is too large to paint or process (8192 x 8193 pixels; the limit is 8192 x 8192)');
      await expect(service.normalFromHeight(texture, 2, false)).rejects.toThrow(/too large/);
      await expect(service.beginStroke(textureOf(bomb, [layerOf('l', bomb)], { width, height }), 'l', brush)).rejects.toThrow(/too large/);
    }
    expect(decodes).not.toHaveBeenCalled();
    await expect(service.pixels(textureOf('AAAA'))).rejects.toThrow('The image has no readable size');
    await expect(service.pixels(textureOf('????'))).rejects.toThrow('not valid base64');
  });

  it('hands other image types to the given decoder, at the declared size', async () => {
    const seen: unknown[][] = [];
    const service = createImagingService(async (bytes, mimeType, width, height) => {
      seen.push([bytes.length, mimeType, width, height]);
      return blankPixels(width, height, '#112233');
    });
    const webp = 'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA=='; // 1 x 1
    const texture = textureOf(webp, undefined, { mimeType: 'image/webp', width: 1, height: 1 });
    const base = await service.baseLayer(texture);
    expect(seen).toEqual([[34, 'image/webp', 1, 1]]);
    expect([...(await pixelsOf(base))]).toEqual([0x11, 0x22, 0x33, 255]);
    // A PNG whose size is not the declared one is scaled by that decoder too; one that fits is taken as it is.
    const small = await service.blank(2, 2, '#ffffff');
    expect(await service.baseLayer(textureOf(small, undefined, { width: 2, height: 2 }))).toBe(small);
    const scaled = await service.baseLayer(textureOf(small, undefined, { width: 4, height: 4 }));
    expect(seen[1].slice(1)).toEqual(['image/png', 4, 4]);
    expect(await pixelsOf(scaled)).toEqual(blankPixels(4, 4, '#112233'));
    await expect(createImagingService().baseLayer(texture)).rejects.toThrow('This kind of image cannot be decoded here');
  });
});
