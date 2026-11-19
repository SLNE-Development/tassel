import { DataTexture, NearestFilter, RepeatWrapping, SRGBColorSpace } from 'three/webgpu';
import type { DecodedImage, McTexture } from '../../mcassets/loader';

// Pixel work on vanilla textures before they become three.js textures: the first frame of an
// animation strip, tinting greyscale textures (grass, leaves, water) and laying a tinted overlay
// over a base (grass block sides). Pure functions on RGBA arrays, so they are easy to test.

const hexToRgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

/** The top frame of an animation strip (the whole image if it is not animated). */
export function firstFrame(texture: McTexture): DecodedImage {
  if (texture.frameHeight >= texture.height) return { width: texture.width, height: texture.height, pixels: texture.pixels };
  const size = texture.width * texture.frameHeight * 4;
  return { width: texture.width, height: texture.frameHeight, pixels: texture.pixels.slice(0, size) };
}

/** Multiplies every pixel's colour by `tint` (#rrggbb). */
export function tinted(image: DecodedImage, tint: string): DecodedImage {
  const [r, g, b] = hexToRgb(tint);
  const pixels = new Uint8ClampedArray(image.pixels);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = (pixels[i] * r) / 255;
    pixels[i + 1] = (pixels[i + 1] * g) / 255;
    pixels[i + 2] = (pixels[i + 2] * b) / 255;
  }
  return { ...image, pixels };
}

/** `overlay` drawn over `base` with its alpha (both the same size, else `base` is returned unchanged). */
export function composite(base: DecodedImage, overlay: DecodedImage): DecodedImage {
  if (base.width !== overlay.width || base.height !== overlay.height) return base;
  const pixels = new Uint8ClampedArray(base.pixels);
  const top = overlay.pixels;
  for (let i = 0; i < pixels.length; i += 4) {
    const a = top[i + 3] / 255;
    if (a === 0) continue;
    for (let c = 0; c < 3; c++) pixels[i + c] = pixels[i + c] * (1 - a) + top[i + c] * a;
    pixels[i + 3] = Math.max(pixels[i + 3], top[i + 3]);
  }
  return { ...base, pixels };
}

/** A crisp (nearest-filtered) sRGB texture with the image's top row at the top (v = 1). */
export function pixelTexture(image: DecodedImage, repeat = false): DataTexture {
  const { width, height } = image;
  const rows = new Uint8Array(width * height * 4);
  const stride = width * 4;
  // DataTexture rows run bottom-up.
  for (let y = 0; y < height; y++) rows.set(image.pixels.subarray((height - 1 - y) * stride, (height - y) * stride), y * stride);
  const texture = new DataTexture(rows, width, height);
  texture.colorSpace = SRGBColorSpace;
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;
  if (repeat) texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}
