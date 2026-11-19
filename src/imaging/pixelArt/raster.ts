// Rasterising: brush footprints, Bresenham strokes, pixel-perfect cleanup, mirror maps, mask bit encoding.
import type { MirrorMap, PixelBrush, PixelRect, Px } from '../../core/pixelOps';
import type { Rect } from '../pixels';
import { fromBase64, toBase64 } from '../../io/bytes';

/** Most line pixels one stroke may have; a longer one is refused instead of freezing the app. */
export const MAX_LINE_PIXELS = 4_000_000;

function checkBrush(brush: PixelBrush): void {
  if (!Number.isInteger(brush.size) || brush.size < 1 || brush.size > 256) {
    throw new Error(`Invalid brush size ${brush.size}: expected an integer from 1 to 256`);
  }
  if (brush.shape !== 'square' && brush.shape !== 'round') throw new Error(`Invalid brush shape "${String(brush.shape)}"`);
}

/**
 * Row spans of a footprint: for row j (0..size-1, offset dy = j - floor((size-1)/2)) the inclusive range of
 * column offsets [start, end]. Both shapes are contiguous in every row.
 *
 * square: size x size with its top-left at -floor((size-1)/2) (so odd sizes are centred on the stamp pixel,
 * even sizes extend one more pixel to the bottom/right).
 * round: inside that square, the pixels whose centre lies within (<=) the disc of diameter `size` centred on
 * the square's centre. Sizes 1..3 are therefore full squares; from 4 on the corners are cut.
 */
function footprintSpans(brush: PixelBrush): { origin: number; start: Int32Array; end: Int32Array } {
  checkBrush(brush);
  const size = brush.size;
  const origin = -Math.floor((size - 1) / 2);
  const start = new Int32Array(size);
  const end = new Int32Array(size);
  const half = size / 2;
  for (let j = 0; j < size; j++) {
    if (brush.shape === 'square') {
      start[j] = origin;
      end[j] = origin + size - 1;
      continue;
    }
    const dy = j + 0.5 - half;
    const rest = half * half - dy * dy; // squared half-width available on this row
    // smallest/largest i with (i + 0.5 - half)^2 <= rest; computed exactly by scanning from the centre outwards
    let lo = size;
    let hi = -1;
    for (let i = 0; i < size; i++) {
      const dx = i + 0.5 - half;
      if (dx * dx <= rest + 1e-9) {
        if (i < lo) lo = i;
        hi = i;
      }
    }
    start[j] = origin + lo;
    end[j] = origin + hi;
  }
  return { origin, start, end };
}

/** Pixel offsets [dx, dy] of the brush footprint relative to the stamp pixel, row by row. */
export function brushFootprint(brush: PixelBrush): readonly Px[] {
  const { origin, start, end } = footprintSpans(brush);
  const out: Px[] = [];
  for (let j = 0; j < start.length; j++) {
    for (let x = start[j]; x <= end[j]; x++) out.push([x, origin + j]);
  }
  return out;
}

/** Bresenham line from (x0, y0) to (x1, y1), both ends included; calls `visit` for every pixel. */
function bresenham(x0: number, y0: number, x1: number, y1: number, visit: (x: number, y: number) => void): void {
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    visit(x, y);
    if (x === x1 && y === y1) return;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

/**
 * The pixels along a stroke, in order, as a flat list [x0, y0, x1, y1, ...]. Polylines start at the indices in
 * `breaks`; consecutive repeats are dropped. With `pixelPerfect`, every pixel that forms an L-corner (its
 * neighbours in the sequence are diagonal to each other and both orthogonally adjacent to it) is removed;
 * this is done per polyline.
 */
export function strokeLinePixels(points: readonly Px[], breaks: readonly number[], pixelPerfect: boolean): number[] {
  const out: number[] = [];
  const isBreak = new Set(breaks);
  let line: number[] = [];
  let total = 0;
  const flush = (): void => {
    if (line.length === 0) return;
    if (pixelPerfect) line = removeCorners(line);
    for (let k = 0; k < line.length; k++) out.push(line[k]);
    line = [];
  };
  let px = 0;
  let py = 0;
  let have = false;
  const add = (x: number, y: number): void => {
    if (line.length >= 2 && line[line.length - 2] === x && line[line.length - 1] === y) return;
    if (++total > MAX_LINE_PIXELS) throw new Error('The stroke is too long');
    line.push(x, y);
  };
  for (let k = 0; k < points.length; k++) {
    const x = Math.floor(points[k][0]);
    const y = Math.floor(points[k][1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Stroke points must be finite numbers');
    if (isBreak.has(k)) {
      flush();
      have = false;
    }
    if (!have) add(x, y);
    else bresenham(px, py, x, y, add);
    px = x;
    py = y;
    have = true;
  }
  flush();
  return out;
}

function removeCorners(line: number[]): number[] {
  const n = line.length / 2;
  if (n < 3) return line;
  const out: number[] = [line[0], line[1]];
  for (let i = 1; i < n - 1; i++) {
    const ax = out[out.length - 2]; // the previous pixel that was kept
    const ay = out[out.length - 1];
    const x = line[2 * i];
    const y = line[2 * i + 1];
    const bx = line[2 * i + 2];
    const by = line[2 * i + 3];
    const orthoA = Math.abs(ax - x) + Math.abs(ay - y) === 1;
    const orthoB = Math.abs(bx - x) + Math.abs(by - y) === 1;
    const diagonal = Math.abs(ax - bx) === 1 && Math.abs(ay - by) === 1;
    if (orthoA && orthoB && diagonal) continue;
    out.push(x, y);
  }
  out.push(line[2 * n - 2], line[2 * n - 1]);
  return out;
}

/**
 * The pixels a pixel-brush stroke covers (before mirror and selection), 1 byte per pixel, clipped to the image.
 * Each pixel is covered at most once (a set). pixelPerfect only applies at brush size 1.
 */
export function strokeCoverage(
  points: readonly Px[],
  breaks: readonly number[],
  brush: PixelBrush,
  pixelPerfect: boolean,
  width: number,
  height: number,
): Uint8Array {
  const { origin, start, end } = footprintSpans(brush);
  const cov = new Uint8Array(width * height);
  const line = strokeLinePixels(points, breaks, pixelPerfect && brush.size === 1);
  const rows = start.length;
  for (let k = 0; k < line.length; k += 2) {
    const cx = line[k];
    const cy = line[k + 1];
    for (let j = 0; j < rows; j++) {
      const y = cy + origin + j;
      if (y < 0 || y >= height) continue;
      const x0 = Math.max(0, cx + start[j]);
      const x1 = Math.min(width - 1, cx + end[j]);
      if (x0 > x1) continue;
      cov.fill(1, y * width + x0, y * width + x1 + 1);
    }
  }
  return cov;
}

/**
 * Adds the mirrored pixels. Every pixel of the ORIGINAL coverage whose centre lies inside a map's `from` also
 * covers its target in `to` (maps are not chained). Relative position rx = (x + 0.5 - from.x) / from.width;
 * flipX: rx = 1 - rx; flipY likewise; swap exchanges rx and ry; target = floor(to.x + rx * to.width) (resp. y),
 * clamped into `to`. Returns a new mask (the input when there are no maps).
 */
export function applyMirror(cov: Uint8Array, width: number, height: number, maps: readonly MirrorMap[] | undefined): Uint8Array {
  if (!maps || maps.length === 0) return cov;
  const out = cov.slice();
  for (const m of maps) {
    const { from, to } = m;
    if (!(from.width > 0 && from.height > 0 && to.width > 0 && to.height > 0)) continue;
    const y0 = Math.max(0, Math.floor(from.y));
    const y1 = Math.min(height - 1, Math.ceil(from.y + from.height));
    const x0 = Math.max(0, Math.floor(from.x));
    const x1 = Math.min(width - 1, Math.ceil(from.x + from.width));
    for (let y = y0; y <= y1; y++) {
      const cy = y + 0.5;
      if (cy < from.y || cy >= from.y + from.height) continue;
      for (let x = x0; x <= x1; x++) {
        if (cov[y * width + x] === 0) continue;
        const cx = x + 0.5;
        if (cx < from.x || cx >= from.x + from.width) continue;
        let rx = (cx - from.x) / from.width;
        let ry = (cy - from.y) / from.height;
        if (m.flipX) rx = 1 - rx;
        if (m.flipY) ry = 1 - ry;
        if (m.swap) [rx, ry] = [ry, rx];
        let tx = Math.floor(to.x + rx * to.width);
        let ty = Math.floor(to.y + ry * to.height);
        tx = Math.min(Math.max(tx, Math.floor(to.x)), Math.ceil(to.x + to.width) - 1);
        ty = Math.min(Math.max(ty, Math.floor(to.y)), Math.ceil(to.y + to.height) - 1);
        if (tx < 0 || ty < 0 || tx >= width || ty >= height) continue;
        out[ty * width + tx] = 1;
      }
    }
  }
  return out;
}

/** Intersects `cov` with `limit` in place (when there is a limit). */
export function limitTo(cov: Uint8Array, limit: Uint8Array | null): Uint8Array {
  if (limit) for (let i = 0; i < cov.length; i++) cov[i] &= limit[i];
  return cov;
}

/** Clips a pixel rectangle to an image; null when nothing is left. */
export function clipRect(r: PixelRect | Rect, width: number, height: number): Rect | null {
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(width, Math.ceil(r.x + r.width));
  const y1 = Math.min(height, Math.ceil(r.y + r.height));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * The bits of `mask` (row stride maskWidth) over `rect` as base64: one bit per pixel, rows top to bottom,
 * each row starting on a new byte, most significant bit first. `rect` must lie inside the mask.
 */
export function encodeMaskBits(mask: Uint8Array, maskWidth: number, rect: Rect): string {
  const rowBytes = Math.ceil(rect.width / 8);
  const bytes = new Uint8Array(rowBytes * rect.height);
  for (let y = 0; y < rect.height; y++) {
    const row = (rect.y + y) * maskWidth + rect.x;
    for (let x = 0; x < rect.width; x++) {
      if (mask[row + x]) bytes[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return toBase64(bytes);
}

/** The inverse of encodeMaskBits: width * height bytes, 0 or 1. Throws when `bits` is too short. */
export function decodeMaskBits(bits: string, width: number, height: number): Uint8Array {
  const rowBytes = Math.ceil(width / 8);
  const bytes = fromBase64(bits);
  if (bytes.length < rowBytes * height) {
    throw new Error(`Mask data too short: ${bytes.length} bytes for a ${width}x${height} mask (needs ${rowBytes * height})`);
  }
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (bytes[y * rowBytes + (x >> 3)] & (0x80 >> (x & 7))) out[y * width + x] = 1;
    }
  }
  return out;
}
