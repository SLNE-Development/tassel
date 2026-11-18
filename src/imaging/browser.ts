// The browser's image decoder, for everything the PNG codec in ./png does not read (JPEG, WebP, unusual PNGs),
// and its PNG encoder for opaque images.
import type { Rgba } from './pixels';

/**
 * Decodes an image file to RGBA pixels of the given size (scaled if the file's size differs). Goes through a
 * 2D canvas, which premultiplies: exact for opaque images, translucent pixels may be off by a rounding step.
 */
export async function decodeWithCanvas(bytes: Uint8Array<ArrayBuffer>, mimeType: string, width: number, height: number): Promise<Rgba> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes], { type: mimeType }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  } catch {
    throw new Error('The image cannot be decoded (damaged file?)');
  }
  const context = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true })!;
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return context.getImageData(0, 0, width, height).data;
}

/**
 * Encodes pixels that are ALL opaque as a PNG with the canvas encoder, which runs beside the main thread.
 * (With alpha 255 everywhere the canvas's premultiplication changes nothing, so this is as exact as ./png.)
 */
export async function encodeOpaqueWithCanvas(pixels: Rgba, width: number, height: number): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d')!.putImageData(new ImageData(pixels, width, height), 0, 0);
  return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
}
