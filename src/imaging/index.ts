// Texture painting: pixel work. Public API of src/imaging.
//
// ── For the paint UI: live preview without commands ─────────────────────────────────────────────
//
//   import { beginStrokePreview, compositeTexture, type StrokePreview } from '../imaging';
//
//   // pointer down (async: decodes the layers once; they stay in the service's cache afterwards)
//   const preview = await beginStrokePreview(texture, layerId, { color, size, opacity, hardness, spacing, erase });
//   // every pointer move: append the new points [u, v, pressure?] (UV, v up) — cheap, touches only the new stamps
//   const dirty = preview.extend([[u, v, pressure]]);          // Rect in pixels (row 0 = top of the image) or null
//   if (dirty) context.putImageData(new ImageData(preview.pixels, preview.width, preview.height), 0, 0,
//                                   dirty.x, dirty.y, dirty.width, dirty.height);
//   // where the drag must not be connected (it crossed a UV seam): the next extend starts a new polyline
//   preview.breakStroke();
//   // pointer up: commit exactly what was previewed — ONE command, one undo step, however many breaks
//   await execute('paint.stroke', { textureId, layerId, points: preview.points, breaks: preview.breaks, ...brush });
//
// `preview.pixels` is the whole texture (all visible layers composited, the stroke so far included) as
// RGBA 8-bit, NOT premultiplied, row 0 = top of the image (v = 1), length width * height * 4. It is one
// buffer that `extend` updates in place, so keep the reference and upload / draw only the dirty rect.
// `preview.layer` is the painted layer alone, in the same format. The preview runs the same pure code
// as `paint.stroke`, so it equals the committed texture pixel for pixel.
//
// `compositeTexture(texture)` gives the pixels of a texture as it is now (no stroke) in the same format —
// use it to show a texture on a 2D canvas, or to pick a colour. For a texture without layers it decodes `data`.
//
// Rules:
// - Never write to buffers you get from here except through `extend` (decoded layers are shared with a cache).
// - A preview belongs to the texture object it was started with. Await the `paint.stroke` command (the
//   store then holds the new texture) before starting the next preview; commands are not queued.
// - Sizes above 8192 x 8192 are refused with an Error.
// - Cost (measured in Chrome): `extend` well under 1 ms per point; `beginStrokePreview` 3 / 9 / 28 ms at
//   1024 / 2048 / 4096 px once the layers are cached (one PNG decode per layer otherwise); the committing
//   `paint.stroke` 35 / 100 / 310 ms on a single layer and 100 / 350 / 1000 ms with four layers — nearly all
//   of it PNG encoding, so keep showing the preview until the command has resolved.
//
// ── For everything else ─────────────────────────────────────────────────────────────────────────
// `imaging` is the app's ImagingService (registered as `services.imaging` in main.tsx; the paint commands
// and texture.normal_from_height await it). The pure pixel functions are in ./pixels (DOM-free), the PNG
// codec in ./png; `createImagingService` builds a service for tests.
import type { PaintBrush, Texture } from '../core/types';
import { decodeWithCanvas, encodeOpaqueWithCanvas } from './browser';
import { StrokePreview } from './pixels';
import { createImagingService } from './service';

export { StrokePreview, type LayerPixels, type Rect } from './pixels';
export { createImagingService, type TextureImaging } from './service';
export type { PaintBrush, StrokePoint, StrokePoints } from '../core/types';

/**
 * The app's imaging service: PNGs through the codec in ./png, other image types through the browser's decoder,
 * and opaque images encoded by the browser (faster, and equally exact for them).
 */
export const imaging = createImagingService(decodeWithCanvas, undefined, encodeOpaqueWithCanvas);

/**
 * Starts the live preview of one brush stroke on `layerId` of a layered texture. See the top of this file.
 * Rejects if the texture has no such layer or an image cannot be decoded.
 */
export function beginStrokePreview(texture: Texture, layerId: string, brush: PaintBrush): Promise<StrokePreview> {
  return imaging.beginStroke(texture, layerId, brush);
}

/**
 * The texture as RGBA pixels (not premultiplied, row 0 = top): its visible layers composited, or the decoded
 * image if it has no layers. The buffer is shared with the cache — do not write to it.
 */
export function compositeTexture(texture: Texture): Promise<{ width: number; height: number; pixels: Uint8ClampedArray<ArrayBuffer> }> {
  return imaging.pixels(texture);
}
