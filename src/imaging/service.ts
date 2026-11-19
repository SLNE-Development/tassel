// The ImagingService: decodes and encodes PNGs, keeps decoded images in a cache and runs the pure pixel
// functions of ./pixels on them. Everything that decides a pixel value is in ./pixels.
import { imageSize } from '../core/imageInfo';
import type { ImagingService, PaintBrush, PaintLayer, Texture } from '../core/types';
import { fromBase64, toBase64 } from '../io/bytes';
import {
  StrokeMask,
  StrokePreview,
  applyStroke,
  blankPixels,
  compositeLayers,
  fillPixels,
  mergeDown,
  normalFromHeight,
  parseColor,
  type LayerPixels,
  type Rgba,
} from './pixels';
import { decodePng, encodePng } from './png';
import { applyPixelOp, transformPixels } from './pixelArt';

/** Largest image (in pixels) that is decoded: decoding allocates 4 bytes per pixel, whatever the file size. */
export const MAX_DECODE_PIXELS = 8192 * 8192;

/** Decoder for images the PNG codec does not read; returns pixels of exactly the given size. */
export type DecodeOther = (bytes: Uint8Array<ArrayBuffer>, mimeType: string, width: number, height: number) => Promise<Rgba>;

/**
 * An optional faster PNG encoder for images WITHOUT any transparency (the browser's canvas encoder: it works
 * off the main thread, but premultiplies, which is only exact for opaque pixels). Returns the PNG file.
 */
export type EncodeOpaque = (pixels: Rgba, width: number, height: number) => Promise<Uint8Array>;

/** The ImagingService plus what the paint UI uses directly (see index.ts). */
export interface TextureImaging extends ImagingService {
  /** Starts a live stroke preview on a layer of a layered texture. */
  beginStroke(texture: Texture, layerId: string, brush: PaintBrush): Promise<StrokePreview>;
  /** The texture's image as pixels (shared with the cache: read only). */
  pixels(texture: Texture): Promise<{ width: number; height: number; pixels: Rgba }>;
}

const NO_PIXELS = new Uint8ClampedArray(0);

/** The one layer that alone makes up the flattened image exactly, if there is such a layer. */
function soleLayer(layers: readonly PaintLayer[]): PaintLayer | null {
  const contributing = layers.filter((layer) => layer.visible && layer.opacity > 0);
  return contributing.length === 1 && contributing[0].opacity >= 1 ? contributing[0] : null;
}

function layerIndex(texture: Texture, layerId: string): number {
  const index = texture.layers?.findIndex((layer) => layer.id === layerId) ?? -1;
  if (index < 0) throw new Error(`Texture "${texture.name}" has no layer "${layerId}"`);
  return index;
}

function isOpaque(pixels: Rgba): boolean {
  // The alpha bytes of all pixels ANDed together, a word at a time.
  const alpha = new Uint32Array(new Uint8Array([0, 0, 0, 255]).buffer)[0];
  const words = new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.length >> 2);
  let all = alpha;
  for (let i = 0; i < words.length; i++) all &= words[i];
  return (all & alpha) >>> 0 === alpha;
}

/**
 * @param decodeOther decoder for non-PNG images and PNG variants the codec skips; without it they are refused
 * @param cacheBytes how many bytes of decoded pixels are kept (least recently used go first)
 * @param encodeOpaque see EncodeOpaque; without it every image goes through the codec in ./png
 */
export function createImagingService(decodeOther?: DecodeOther, cacheBytes = 384 * 1024 * 1024, encodeOpaque?: EncodeOpaque): TextureImaging {
  // Decoded images by their base64 text, least recently used first. The pixels are never modified.
  const cache = new Map<string, Rgba>();
  const decoding = new Map<string, Promise<Rgba>>();
  let cached = 0;

  function lookup(data: string): Rgba | undefined {
    const pixels = cache.get(data);
    if (pixels) {
      cache.delete(data);
      cache.set(data, pixels);
    }
    return pixels;
  }

  function remember(data: string, pixels: Rgba): void {
    if (cache.has(data)) return;
    cache.set(data, pixels);
    cached += pixels.length;
    for (const [key, old] of cache) {
      if (cached <= cacheBytes || key === data) break;
      cache.delete(key);
      cached -= old.length;
    }
  }

  /** Marks images that were just replaced as the first to go: only undo would ask for them again. */
  function retire(...keys: string[]): void {
    const entries = [...cache];
    cache.clear();
    for (const entry of entries) if (keys.includes(entry[0])) cache.set(...entry);
    for (const entry of entries) if (!keys.includes(entry[0])) cache.set(...entry);
  }

  async function decodeFile(data: string, mimeType: string, width: number, height: number): Promise<Rgba> {
    const bytes = fromBase64(data);
    // The size in the file header is checked before decoding, so a small file that claims huge dimensions is refused.
    const header = imageSize(bytes);
    if (!header) throw new Error('The image has no readable size (damaged file?)');
    if (header.width * header.height > MAX_DECODE_PIXELS || width * height > MAX_DECODE_PIXELS) {
      throw new Error(`The image is too large to paint or process (${header.width} x ${header.height} pixels; the limit is 8192 x 8192)`);
    }
    if (mimeType === 'image/png' && header.width === width && header.height === height) {
      const decoded = await decodePng(bytes);
      if (decoded) return decoded.pixels;
    }
    if (!decodeOther) throw new Error('This kind of image cannot be decoded here');
    return decodeOther(bytes, mimeType, width, height);
  }

  function decode(data: string, mimeType: string, width: number, height: number): Promise<Rgba> {
    const known = lookup(data);
    // (An image that is used at another size than its own is decoded, and scaled, again.)
    if (known?.length === width * height * 4) return Promise.resolve(known);
    let pending = decoding.get(data);
    if (!pending) {
      pending = decodeFile(data, mimeType, width, height)
        .then((pixels) => {
          remember(data, pixels);
          return pixels;
        })
        .finally(() => decoding.delete(data));
      decoding.set(data, pending);
    }
    return pending;
  }

  async function encode(pixels: Rgba, width: number, height: number): Promise<string> {
    const file = encodeOpaque && isOpaque(pixels) ? await encodeOpaque(pixels, width, height) : await encodePng(pixels, width, height);
    const data = toBase64(file);
    remember(data, pixels);
    return data;
  }

  /** The layers decoded, except hidden ones other than `needed` (their pixels are never read). */
  function decodeLayers(width: number, height: number, layers: readonly PaintLayer[], needed = -1): Promise<LayerPixels[]> {
    return Promise.all(
      layers.map(async (layer, index) => ({
        pixels: layer.visible || index === needed ? await decode(layer.data, 'image/png', width, height) : NO_PIXELS,
        visible: layer.visible,
        opacity: layer.opacity,
        blend: layer.blend,
      })),
    );
  }

  /** The texture's current composite: from the cache if it is there, else composited from the layers. */
  function compositeOf(texture: Texture, stack: readonly LayerPixels[]): Rgba {
    const known = lookup(texture.data);
    if (known?.length === texture.width * texture.height * 4) return known;
    const composite = compositeLayers(texture.width, texture.height, stack);
    remember(texture.data, composite);
    return composite;
  }

  /**
   * Encodes a changed layer and the texture's new flattened image. Nothing is encoded twice: the flattened
   * image is the layer's own string when the layer alone is the image, and stays as it is when the layer is hidden.
   */
  async function encodeEdit(texture: Texture, index: number, layer: Rgba, composite: () => Rgba) {
    const { width, height } = texture;
    const layers = texture.layers!;
    const old = layers[index];
    // What is being replaced goes first when the cache needs room for the new images (only undo asks for it again).
    if (!old.visible || old.opacity <= 0) {
      retire(old.data);
      return { layer: await encode(layer, width, height), flattened: texture.data };
    }
    const alone = soleLayer(layers) === old;
    const flat = alone ? null : composite();
    retire(old.data, texture.data);
    const [data, flattened] = await Promise.all([encode(layer, width, height), flat && encode(flat, width, height)]);
    return { layer: data, flattened: flattened ?? data };
  }

  const service: TextureImaging = {
    blank(width, height, color) {
      return encode(blankPixels(width, height, color), width, height);
    },

    async baseLayer(texture) {
      const { width, height } = texture;
      if (texture.mimeType === 'image/png') {
        const header = imageSize(fromBase64(texture.data.slice(0, 64)));
        if (header?.width === width && header.height === height) return texture.data;
      }
      return encode(await decode(texture.data, texture.mimeType, width, height), width, height);
    },

    async stroke(texture, layerId, brush, points, breaks) {
      const { width, height } = texture;
      const index = layerIndex(texture, layerId);
      const stack = await decodeLayers(width, height, texture.layers!, index);
      // The same steps as StrokePreview.extend with all points at once.
      const mask = new StrokeMask(width, height, brush);
      const rect = mask.add(points, breaks);
      if (!rect) return { layer: texture.layers![index].data, flattened: texture.data };
      const layer = new Uint8ClampedArray(stack[index].pixels);
      applyStroke(stack[index].pixels, layer, width, rect, mask.coverage, parseColor(brush.color), brush.opacity, brush.erase);
      return encodeEdit(texture, index, layer, () => {
        const composite = new Uint8ClampedArray(compositeOf(texture, stack));
        const painted = stack.map((entry, i) => (i === index ? { ...entry, pixels: layer } : entry));
        return compositeLayers(width, height, painted, composite, rect);
      });
    },

    async fill(texture, layerId, color, opacity) {
      const { width, height } = texture;
      const index = layerIndex(texture, layerId);
      const stack = await decodeLayers(width, height, texture.layers!, opacity >= 1 ? -1 : index);
      const layer = fillPixels(stack[index].pixels, width, height, color, opacity);
      return encodeEdit(texture, index, layer, () =>
        compositeLayers(
          width,
          height,
          stack.map((entry, i) => (i === index ? { ...entry, pixels: layer } : entry)),
        ),
      );
    },

    async flatten(width, height, layers) {
      const sole = soleLayer(layers);
      if (sole) return sole.data;
      return encode(compositeLayers(width, height, await decodeLayers(width, height, layers)), width, height);
    },

    async mergeDown(width, height, lower, upper) {
      const [below, above] = await Promise.all([decode(lower.data, 'image/png', width, height), decode(upper.data, 'image/png', width, height)]);
      return encode(mergeDown(width, height, below, { pixels: above, opacity: upper.opacity, blend: upper.blend }), width, height);
    },

    async normalFromHeight(texture, strength, invert) {
      const { width, height, pixels } = await service.pixels(texture);
      return encode(normalFromHeight(pixels, width, height, strength, invert), width, height);
    },

    async beginStroke(texture, layerId, brush) {
      const { width, height } = texture;
      const index = layerIndex(texture, layerId);
      const stack = await decodeLayers(width, height, texture.layers!, index);
      return new StrokePreview(width, height, stack, index, brush, compositeOf(texture, stack));
    },

    async pixelEdit(texture, layerId, op) {
      const { width, height } = texture;
      if (layerId === null) {
        if (texture.layers?.length) throw new Error(`Texture "${texture.name}" has paint layers: name the layer to edit`);
        const source = await decode(texture.data, texture.mimeType, width, height);
        const { pixels, changed } = applyPixelOp(source, width, height, op);
        if (!changed) return { layer: texture.data, flattened: texture.data, changed: false };
        retire(texture.data);
        const data = await encode(pixels, width, height);
        return { layer: data, flattened: data, changed: true };
      }
      const index = layerIndex(texture, layerId);
      const stack = await decodeLayers(width, height, texture.layers!, index);
      const { pixels: layer, changed } = applyPixelOp(stack[index].pixels, width, height, op);
      if (!changed) return { layer: texture.layers![index].data, flattened: texture.data, changed: false };
      const edit = await encodeEdit(texture, index, layer, () =>
        compositeLayers(
          width,
          height,
          stack.map((entry, i) => (i === index ? { ...entry, pixels: layer } : entry)),
        ),
      );
      return { ...edit, changed: true };
    },

    async transformTexture(texture, transform) {
      const { width, height } = texture;
      const apply = (pixels: Uint8ClampedArray) => transformPixels(pixels, width, height, transform);
      if (!texture.layers?.length) {
        const out = apply(await decode(texture.data, texture.mimeType, width, height));
        return { data: await encode(out.pixels, out.width, out.height), width: out.width, height: out.height };
      }
      const layers = await Promise.all(
        texture.layers.map(async (layer) => {
          const out = apply(await decode(layer.data, 'image/png', width, height));
          return { ...layer, data: await encode(out.pixels, out.width, out.height), size: out };
        }),
      );
      const size = layers[0].size;
      const data = await service.flatten(size.width, size.height, layers);
      return { data, width: size.width, height: size.height, layers: layers.map((layer) => layer.data) };
    },

    async pixels(texture) {
      const { width, height } = texture;
      return { width, height, pixels: await decode(texture.data, texture.mimeType, width, height) };
    },

    async regionTransparent(texture, rect) {
      const { width, height, pixels } = await service.pixels(texture);
      // Every pixel the rectangle touches, clipped to the image.
      const x0 = Math.max(0, Math.floor(rect.x));
      const y0 = Math.max(0, Math.floor(rect.y));
      const x1 = Math.min(width, Math.ceil(rect.x + rect.width));
      const y1 = Math.min(height, Math.ceil(rect.y + rect.height));
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (pixels[(y * width + x) * 4 + 3] !== 0) return false;
      return true;
    },
  };
  return service;
}
