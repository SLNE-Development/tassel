// Channel packing for glTF: the document keeps roughness, metallic and occlusion as separate greyscale
// images, glTF wants roughness in G and metallic in B of one image. The pixel work is pure; decoding and
// encoding images needs the browser.
import type { Texture } from '../core/types';
import { toBase64 } from './bytes';
import { imageSize } from './imageInfo';

export interface PackedImage {
  mimeType: 'image/png';
  /** The PNG file as base64. */
  data: string;
  width: number;
  height: number;
}

export type Channel = 'r' | 'g' | 'b';

export interface ImageOps {
  /** One image with G = roughness and B = metallic (each the luminance of its map; white where there is no map). */
  packMetallicRoughness(roughness: Texture | null, metallic: Texture | null): Promise<PackedImage>;
  /** One greyscale image per requested channel, or null for a channel that is white everywhere (= no map). */
  splitChannels(image: { mimeType: string; bytes: Uint8Array<ArrayBuffer> }, channels: readonly Channel[]): Promise<(PackedImage | null)[]>;
}

const luminance = (p: Uint8ClampedArray, i: number) => Math.round(0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2]);

/** RGBA pixels with G = luminance of `roughness`, B = luminance of `metallic`, 255 where a map is missing. */
export function packPixels(roughness: Uint8ClampedArray | null, metallic: Uint8ClampedArray | null, pixels: number): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(pixels * 4).fill(255);
  for (let i = 0; i < pixels * 4; i += 4) {
    if (roughness) out[i + 1] = luminance(roughness, i);
    if (metallic) out[i + 2] = luminance(metallic, i);
  }
  return out;
}

/** Opaque grey RGBA pixels from one channel, or null if that channel is 255 everywhere. */
export function channelPixels(rgba: Uint8ClampedArray, channel: Channel): Uint8ClampedArray<ArrayBuffer> | null {
  const offset = channel === 'r' ? 0 : channel === 'g' ? 1 : 2;
  const out = new Uint8ClampedArray(rgba.length);
  let white = true;
  for (let i = 0; i < rgba.length; i += 4) {
    const value = rgba[i + offset];
    if (value !== 255) white = false;
    out[i] = out[i + 1] = out[i + 2] = value;
    out[i + 3] = 255;
  }
  return white ? null : out;
}

/** Largest image (in pixels) we are willing to decode: decoding allocates 4 bytes per pixel, whatever the file size. */
const MAX_DECODE_PIXELS = 8192 * 8192;

async function decode(bytes: Uint8Array<ArrayBuffer>, mimeType: string, size?: { width: number; height: number }): Promise<ImageData> {
  // Check the size in the file header before decoding, so a tiny file that claims huge dimensions
  // (a decompression bomb in an imported model) is refused instead of exhausting memory.
  const header = imageSize(bytes);
  if (!header) throw new Error('The image has no readable size');
  if (header.width * header.height > MAX_DECODE_PIXELS || (size && size.width * size.height > MAX_DECODE_PIXELS)) {
    throw new Error(`The image is too large to process (${header.width} x ${header.height})`);
  }
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mimeType }), {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
  const width = size?.width ?? bitmap.width;
  const height = size?.height ?? bitmap.height;
  const context = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true })!;
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return context.getImageData(0, 0, width, height);
}

async function encode(pixels: Uint8ClampedArray<ArrayBuffer>, width: number, height: number): Promise<PackedImage> {
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d')!.putImageData(new ImageData(pixels, width, height), 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return { mimeType: 'image/png', data: toBase64(new Uint8Array(await blob.arrayBuffer())), width, height };
}

function textureBytes(texture: Texture): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(texture.data), (c) => c.charCodeAt(0));
}

/** The implementation for the app (needs createImageBitmap and OffscreenCanvas). */
export const browserImageOps: ImageOps = {
  async packMetallicRoughness(roughness, metallic) {
    // Maps of different sizes are scaled to the larger one.
    const width = Math.max(roughness?.width ?? 1, metallic?.width ?? 1);
    const height = Math.max(roughness?.height ?? 1, metallic?.height ?? 1);
    const load = async (t: Texture | null) => (t ? (await decode(textureBytes(t), t.mimeType, { width, height })).data : null);
    return encode(packPixels(await load(roughness), await load(metallic), width * height), width, height);
  },
  async splitChannels(image, channels) {
    const decoded = await decode(image.bytes, image.mimeType);
    return Promise.all(
      channels.map((channel) => {
        const pixels = channelPixels(decoded.data, channel);
        return pixels && encode(pixels, decoded.width, decoded.height);
      }),
    );
  },
};
