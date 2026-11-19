// Selections: shapes → a 0/1 mask, and back.
import type { SelectMode, SelectionShape } from '../../core/pixelOps';
import type { Rect } from '../pixels';
import { decodeMaskBits, encodeMaskBits } from './raster';

/**
 * Do two pixels (byte offsets a, b into `px`) have a similar colour? max channel difference / 255 <= tolerance
 * over RGBA; two fully transparent pixels are always equal (whatever their rgb).
 */
function similar(px: Uint8ClampedArray, ref: readonly number[], i: number, tolerance: number): boolean {
  const a = px[i + 3];
  if (a === 0 && ref[3] === 0) return true;
  const limit = tolerance * 255;
  return (
    Math.abs(px[i] - ref[0]) <= limit &&
    Math.abs(px[i + 1] - ref[1]) <= limit &&
    Math.abs(px[i + 2] - ref[2]) <= limit &&
    Math.abs(a - ref[3]) <= limit
  );
}

/** Pixels (x, y) connected (4-neighbourhood, or everywhere when !connected) with a colour like the seed's. */
export function similarColorMask(
  layer: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  tolerance: number,
  connected: boolean,
): Uint8Array {
  const out = new Uint8Array(width * height);
  x = Math.floor(x);
  y = Math.floor(y);
  if (x < 0 || y < 0 || x >= width || y >= height) return out;
  const s = (y * width + x) * 4;
  const ref = [layer[s], layer[s + 1], layer[s + 2], layer[s + 3]];
  if (!connected) {
    for (let p = 0; p < width * height; p++) if (similar(layer, ref, p * 4, tolerance)) out[p] = 1;
    return out;
  }
  const stack = new Int32Array(width * height);
  let top = 0;
  out[y * width + x] = 1;
  stack[top++] = y * width + x;
  while (top > 0) {
    const p = stack[--top];
    const px = p % width;
    const py = (p - px) / width;
    if (px > 0 && !out[p - 1] && similar(layer, ref, (p - 1) * 4, tolerance)) {
      out[p - 1] = 1;
      stack[top++] = p - 1;
    }
    if (px < width - 1 && !out[p + 1] && similar(layer, ref, (p + 1) * 4, tolerance)) {
      out[p + 1] = 1;
      stack[top++] = p + 1;
    }
    if (py > 0 && !out[p - width] && similar(layer, ref, (p - width) * 4, tolerance)) {
      out[p - width] = 1;
      stack[top++] = p - width;
    }
    if (py < height - 1 && !out[p + width] && similar(layer, ref, (p + width) * 4, tolerance)) {
      out[p + width] = 1;
      stack[top++] = p + width;
    }
  }
  return out;
}

/** Even-odd polygon fill on pixel centres; polygon vertices are positions (not pixel centres). */
function lassoMask(points: readonly (readonly [number, number])[], width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  const n = points.length;
  if (n < 3) return out;
  for (let y = 0; y < height; y++) {
    const cy = y + 0.5;
    const xs: number[] = [];
    for (let i = 0; i < n; i++) {
      const [ax, ay] = points[i];
      const [bx, by] = points[(i + 1) % n];
      if (ay === by) continue;
      if ((ay <= cy && by > cy) || (by <= cy && ay > cy)) xs.push(ax + ((cy - ay) / (by - ay)) * (bx - ax));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      // pixel centres x + 0.5 in [xs[k], xs[k+1])
      const x0 = Math.max(0, Math.ceil(xs[k] - 0.5));
      const x1 = Math.min(width - 1, Math.ceil(xs[k + 1] - 0.5) - 1);
      for (let x = x0; x <= x1; x++) out[y * width + x] = 1;
    }
  }
  return out;
}

function shapeMask(layer: Uint8ClampedArray, width: number, height: number, s: SelectionShape): Uint8Array {
  switch (s.shape) {
    case 'rect': {
      const out = new Uint8Array(width * height);
      const x0 = Math.max(0, Math.floor(s.x));
      const y0 = Math.max(0, Math.floor(s.y));
      const x1 = Math.min(width, Math.ceil(s.x + s.width));
      const y1 = Math.min(height, Math.ceil(s.y + s.height));
      for (let y = y0; y < y1; y++) if (x1 > x0) out.fill(1, y * width + x0, y * width + x1);
      return out;
    }
    case 'ellipse': {
      const out = new Uint8Array(width * height);
      if (!(s.width > 0 && s.height > 0)) return out;
      const rx = s.width / 2;
      const ry = s.height / 2;
      const cx = s.x + rx;
      const cy = s.y + ry;
      for (let y = Math.max(0, Math.floor(s.y)); y < Math.min(height, Math.ceil(s.y + s.height)); y++) {
        const dy = (y + 0.5 - cy) / ry;
        for (let x = Math.max(0, Math.floor(s.x)); x < Math.min(width, Math.ceil(s.x + s.width)); x++) {
          const dx = (x + 0.5 - cx) / rx;
          if (dx * dx + dy * dy <= 1 + 1e-9) out[y * width + x] = 1;
        }
      }
      return out;
    }
    case 'lasso':
      return lassoMask(s.points, width, height);
    case 'wand':
      return similarColorMask(layer, width, height, s.x, s.y, s.tolerance, true);
    case 'color':
      return similarColorMask(layer, width, height, s.x, s.y, s.tolerance, false);
    case 'mask': {
      const out = new Uint8Array(width * height);
      const bits = decodeMaskBits(s.bits, s.width, s.height);
      for (let y = 0; y < s.height; y++) {
        const ty = s.y + y;
        if (ty < 0 || ty >= height) continue;
        for (let x = 0; x < s.width; x++) {
          const tx = s.x + x;
          if (tx >= 0 && tx < width && bits[y * s.width + x]) out[ty * width + tx] = 1;
        }
      }
      return out;
    }
  }
}

function combine(mask: Uint8Array, shape: Uint8Array, mode: SelectMode): void {
  switch (mode) {
    case 'replace':
      mask.set(shape);
      return;
    case 'add':
      for (let i = 0; i < mask.length; i++) mask[i] |= shape[i];
      return;
    case 'subtract':
      for (let i = 0; i < mask.length; i++) mask[i] &= shape[i] ^ 1;
      return;
    case 'intersect':
      for (let i = 0; i < mask.length; i++) mask[i] &= shape[i];
      return;
  }
}

/** 1 = selected, 0 = not, one byte per pixel. Shapes are applied in order to an empty mask; 'replace' (default) clears first. wand/color read `layer`. */
export function selectionMask(layer: Uint8ClampedArray, width: number, height: number, shapes: readonly SelectionShape[]): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (const s of shapes) combine(mask, shapeMask(layer, width, height, s), s.mode ?? 'replace');
  return mask;
}

/** The mask as one 'mask' SelectionShape over its bounding box (mode 'replace'), or null if nothing is selected. */
export function maskToShape(mask: Uint8Array, width: number, height: number): SelectionShape | null {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  const rect: Rect = { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
  return { shape: 'mask', ...rect, bits: encodeMaskBits(mask, width, rect), mode: 'replace' };
}
