// Applying a PixelOp to one layer. Pure: the input is copied, never mutated.
//
// Conventions shared by all painting ops:
// - the coverage of an op is a SET of pixels: each is painted exactly once, at the paint opacity;
// - order: coverage -> mirror (adds mapped pixels) -> limited by the selection;
// - the selection mask is computed from the ORIGINAL layer pixels (it matters for wand / colour shapes);
// - an absent OR empty `selection` list means "everywhere" (except for 'move', which needs a real selection).
import type { PixelOp, PixelPaint, PixelRect } from '../../core/pixelOps';
import type { Rect, Rgba } from '../pixels';
import { fromBase64 } from '../../io/bytes';
import { paintPixel } from './blend';
import { hexToRgb } from './color';
import { adjustPixels } from './adjust';
import { applyMirror, clipRect, limitTo, strokeCoverage, strokeLinePixels } from './raster';
import { selectionMask, similarColorMask } from './selection';

type Selection = Extract<PixelOp, { op: 'stroke' }>['selection'];
type PaintMode = Pick<PixelPaint, 'blend' | 'lockAlpha' | 'erase'>;

function limitMask(layer: Uint8ClampedArray, width: number, height: number, selection: Selection): Uint8Array | null {
  return selection && selection.length > 0 ? selectionMask(layer, width, height, selection) : null;
}

function checkOpacity(opacity: number): number {
  if (!Number.isFinite(opacity)) throw new Error(`Invalid opacity ${opacity}`);
  return opacity < 0 ? 0 : opacity > 1 ? 1 : opacity;
}

/** Paints every covered pixel with one colour. */
function paintCoverage(out: Uint8ClampedArray, cov: Uint8Array, paint: PixelPaint): void {
  const [r, g, b] = paint.erase ? [0, 0, 0] : hexToRgb(paint.color);
  const alpha = checkOpacity(paint.opacity);
  for (let p = 0; p < cov.length; p++) if (cov[p]) paintPixel(out, p * 4, r, g, b, alpha, paint);
}

/** Bounding box of the pixels whose bytes differ, or null. */
function changedRect(a: Uint8ClampedArray, b: Uint8ClampedArray, width: number, height: number): Rect | null {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2] && a[i + 3] === b[i + 3]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** Pixels inside a rectangle / ellipse spanning from..to, as a local mask over the (unclipped) box. */
function shapeInside(shape: 'rectangle' | 'ellipse', bw: number, bh: number): Uint8Array {
  const inside = new Uint8Array(bw * bh);
  if (shape === 'rectangle') return inside.fill(1);
  const rx = bw / 2;
  const ry = bh / 2;
  for (let y = 0; y < bh; y++) {
    const dy = (y + 0.5 - ry) / ry;
    for (let x = 0; x < bw; x++) {
      const dx = (x + 0.5 - rx) / rx;
      if (dx * dx + dy * dy <= 1 + 1e-9) inside[y * bw + x] = 1;
    }
  }
  return inside;
}

/** One 4-neighbour erosion; everything outside the box counts as outside. */
function erode(src: Uint8Array, bw: number, bh: number): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let y = 1; y < bh - 1; y++) {
    for (let x = 1; x < bw - 1; x++) {
      const p = y * bw + x;
      if (src[p] && src[p - 1] && src[p + 1] && src[p - bw] && src[p + bw]) out[p] = 1;
    }
  }
  return out;
}

function intCoord(v: number, what: string): number {
  if (!Number.isFinite(v)) throw new Error(`${what} must be a finite number`);
  return Math.floor(v);
}

function applyStroke(out: Uint8ClampedArray, layer: Uint8ClampedArray, w: number, h: number, op: Extract<PixelOp, { op: 'stroke' }>): void {
  const cov = strokeCoverage(op.points, op.breaks ?? [], op.brush, op.pixelPerfect, w, h);
  const mirrored = applyMirror(cov, w, h, op.mirror);
  paintCoverage(out, limitTo(mirrored, limitMask(layer, w, h, op.selection)), op.paint);
}

function applyFill(out: Uint8ClampedArray, layer: Uint8ClampedArray, w: number, h: number, op: Extract<PixelOp, { op: 'fill' }>): void {
  let cov: Uint8Array;
  const tolerance = op.tolerance ?? 0;
  switch (op.mode) {
    case 'regions': {
      cov = new Uint8Array(w * h);
      for (const region of op.regions ?? []) {
        const r = clipRect(region, w, h);
        if (r) for (let y = r.y; y < r.y + r.height; y++) cov.fill(1, y * w + r.x, y * w + r.x + r.width);
      }
      break;
    }
    case 'connected':
    case 'same_color': {
      if (op.x === undefined || op.y === undefined) throw new Error(`Fill mode "${op.mode}" needs x and y`);
      cov = similarColorMask(layer, w, h, op.x, op.y, tolerance, op.mode === 'connected');
      break;
    }
    case 'all':
      cov = new Uint8Array(w * h).fill(1);
      break;
  }
  paintCoverage(out, limitTo(applyMirror(cov, w, h, op.mirror), limitMask(layer, w, h, op.selection)), op.paint);
}

function applyShape(out: Uint8ClampedArray, layer: Uint8ClampedArray, w: number, h: number, op: Extract<PixelOp, { op: 'shape' }>): void {
  const x0 = Math.min(intCoord(op.from[0], 'Shape x'), intCoord(op.to[0], 'Shape x'));
  const x1 = Math.max(intCoord(op.from[0], 'Shape x'), intCoord(op.to[0], 'Shape x'));
  const y0 = Math.min(intCoord(op.from[1], 'Shape y'), intCoord(op.to[1], 'Shape y'));
  const y1 = Math.max(intCoord(op.from[1], 'Shape y'), intCoord(op.to[1], 'Shape y'));
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  if (bw * bh > 64_000_000) throw new Error('The shape is too large');
  let local = shapeInside(op.shape, bw, bh);
  if (!op.filled) {
    if (!Number.isInteger(op.lineWidth) || op.lineWidth < 1) throw new Error(`Invalid line width ${op.lineWidth}: expected an integer >= 1`);
    let core: Uint8Array = local;
    for (let k = 0; k < op.lineWidth; k++) core = erode(core, bw, bh);
    const ring = new Uint8Array(local.length);
    for (let p = 0; p < ring.length; p++) ring[p] = local[p] & (core[p] ^ 1);
    local = ring;
  }
  const cov = new Uint8Array(w * h);
  for (let y = Math.max(0, y0); y <= Math.min(h - 1, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(w - 1, x1); x++) cov[y * w + x] = local[(y - y0) * bw + (x - x0)];
  }
  paintCoverage(out, limitTo(applyMirror(cov, w, h, op.mirror), limitMask(layer, w, h, op.selection)), op.paint);
}

function applyGradient(out: Uint8ClampedArray, layer: Uint8ClampedArray, w: number, h: number, op: Extract<PixelOp, { op: 'gradient' }>): void {
  const [r0, g0, b0] = hexToRgb(op.colors[0]);
  const [r1, g1, b1] = hexToRgb(op.colors[1]);
  const alpha = checkOpacity(op.paint.opacity);
  const mode: PaintMode = { blend: op.paint.blend, lockAlpha: op.paint.lockAlpha, erase: false };
  const dx = op.to[0] - op.from[0];
  const dy = op.to[1] - op.from[1];
  const len2 = dx * dx + dy * dy;
  const limit = limitMask(layer, w, h, op.selection);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (limit && !limit[p]) continue;
      let t = len2 === 0 ? 0 : ((x - op.from[0]) * dx + (y - op.from[1]) * dy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      paintPixel(
        out,
        p * 4,
        Math.round(r0 + (r1 - r0) * t),
        Math.round(g0 + (g1 - g0) * t),
        Math.round(b0 + (b1 - b0) * t),
        alpha,
        mode,
      );
    }
  }
}

function applyMove(out: Uint8ClampedArray, layer: Uint8ClampedArray, w: number, h: number, op: Extract<PixelOp, { op: 'move' }>): void {
  const sel = selectionMask(layer, w, h, op.selection);
  const dx = intCoord(op.dx, 'dx');
  const dy = intCoord(op.dy, 'dy');
  if (!op.copy) {
    for (let p = 0; p < sel.length; p++) if (sel[p]) out[p * 4] = out[p * 4 + 1] = out[p * 4 + 2] = out[p * 4 + 3] = 0;
  }
  const mode: PaintMode = { blend: 'default', lockAlpha: false, erase: false };
  for (let y = 0; y < h; y++) {
    const ty = y + dy;
    if (ty < 0 || ty >= h) continue;
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const tx = x + dx;
      if (!sel[p] || tx < 0 || tx >= w) continue;
      const i = p * 4;
      if (layer[i + 3] === 0) continue;
      paintPixel(out, (ty * w + tx) * 4, layer[i], layer[i + 1], layer[i + 2], layer[i + 3] / 255, mode);
    }
  }
}

/**
 * copy_brush. 'copy': a pixel at p takes the colour at p + offset; 'pattern': the `source` rectangle tiled over
 * the image, aligned at source.x/y; 'sample': the source rectangle stamped centred on every line pixel of the
 * stroke (q = c + (i - floor(w/2), j - floor(h/2)), later stamps win; the brush size is not used for it).
 * Colours come from the original layer, alpha = source alpha * paint.opacity. Sources outside the image are skipped.
 */
function applyCopyBrush(out: Uint8ClampedArray, layer: Uint8ClampedArray, w: number, h: number, op: Extract<PixelOp, { op: 'copy_brush' }>): void {
  const limit = limitMask(layer, w, h, op.selection);
  const opacity = checkOpacity(op.paint.opacity);
  const mode: PaintMode = { blend: op.paint.blend, lockAlpha: op.paint.lockAlpha, erase: false };
  // srcIndex[p] = pixel index to read, or -1
  const srcIndex = new Int32Array(w * h).fill(-1);
  const source: PixelRect | undefined = op.source;
  const needSource = (): PixelRect => {
    if (!source || !(source.width >= 1 && source.height >= 1)) throw new Error(`Copy brush mode "${op.mode}" needs a source rectangle`);
    return source;
  };
  if (op.mode === 'sample') {
    const s = needSource();
    const line = strokeLinePixels(op.points, op.breaks ?? [], false);
    const sx = intCoord(s.x, 'source.x');
    const sy = intCoord(s.y, 'source.y');
    const ox = Math.floor(s.width / 2);
    const oy = Math.floor(s.height / 2);
    for (let k = 0; k < line.length; k += 2) {
      for (let j = 0; j < s.height; j++) {
        const qy = line[k + 1] + j - oy;
        const py = sy + j;
        if (qy < 0 || qy >= h || py < 0 || py >= h) continue;
        for (let i = 0; i < s.width; i++) {
          const qx = line[k] + i - ox;
          const px = sx + i;
          if (qx < 0 || qx >= w || px < 0 || px >= w) continue;
          srcIndex[qy * w + qx] = py * w + px;
        }
      }
    }
  } else {
    const cov = strokeCoverage(op.points, op.breaks ?? [], op.brush, false, w, h);
    if (op.mode === 'copy') {
      if (!op.offset) throw new Error('Copy brush mode "copy" needs an offset');
      const ox = intCoord(op.offset[0], 'offset');
      const oy = intCoord(op.offset[1], 'offset');
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!cov[y * w + x]) continue;
          const px = x + ox;
          const py = y + oy;
          if (px >= 0 && px < w && py >= 0 && py < h) srcIndex[y * w + x] = py * w + px;
        }
      }
    } else {
      const s = needSource();
      const sw = Math.floor(s.width);
      const sh = Math.floor(s.height);
      const sx = intCoord(s.x, 'source.x');
      const sy = intCoord(s.y, 'source.y');
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!cov[y * w + x]) continue;
          const px = sx + ((((x - sx) % sw) + sw) % sw);
          const py = sy + ((((y - sy) % sh) + sh) % sh);
          if (px >= 0 && px < w && py >= 0 && py < h) srcIndex[y * w + x] = py * w + px;
        }
      }
    }
  }
  for (let p = 0; p < srcIndex.length; p++) {
    const s = srcIndex[p];
    if (s < 0 || (limit && !limit[p])) continue;
    const i = s * 4;
    paintPixel(out, p * 4, layer[i], layer[i + 1], layer[i + 2], (layer[i + 3] / 255) * opacity, mode);
  }
}

function applySet(out: Uint8ClampedArray, w: number, h: number, op: Extract<PixelOp, { op: 'set' }>): void {
  const { rect } = op;
  if (!Number.isInteger(rect.width) || !Number.isInteger(rect.height) || rect.width < 0 || rect.height < 0 || !Number.isInteger(rect.x) || !Number.isInteger(rect.y)) {
    throw new Error('Invalid rectangle for set');
  }
  const data = fromBase64(op.rgba);
  const expected = rect.width * rect.height * 4;
  if (data.length !== expected) throw new Error(`Set data has ${data.length} bytes, expected ${expected} for a ${rect.width}x${rect.height} rectangle`);
  const clipped = clipRect(rect, w, h);
  if (!clipped) return;
  for (let y = clipped.y; y < clipped.y + clipped.height; y++) {
    const from = ((y - rect.y) * rect.width + (clipped.x - rect.x)) * 4;
    out.set(data.subarray(from, from + clipped.width * 4), (y * w + clipped.x) * 4);
  }
}

/** Applies the op to a COPY of `layer` (never mutates the input). changed = bounding box of pixels whose bytes differ, or null. */
export function applyPixelOp(layer: Uint8ClampedArray, width: number, height: number, op: PixelOp): { pixels: Rgba; changed: Rect | null } {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error(`Invalid image size ${width}x${height}`);
  if (layer.length !== width * height * 4) throw new Error(`Layer has ${layer.length} bytes, expected ${width * height * 4}`);
  let out = new Uint8ClampedArray(layer) as Rgba;
  switch (op.op) {
    case 'stroke':
      applyStroke(out, layer, width, height, op);
      break;
    case 'fill':
      applyFill(out, layer, width, height, op);
      break;
    case 'shape':
      applyShape(out, layer, width, height, op);
      break;
    case 'gradient':
      applyGradient(out, layer, width, height, op);
      break;
    case 'move':
      applyMove(out, layer, width, height, op);
      break;
    case 'copy_brush':
      applyCopyBrush(out, layer, width, height, op);
      break;
    case 'adjust':
      out = adjustPixels(layer, width, height, op.adjust, limitMask(layer, width, height, op.selection) ?? undefined);
      break;
    case 'clear': {
      const limit = limitMask(layer, width, height, op.selection);
      const keep = new Uint8Array(width * height);
      for (const r of op.keep ?? []) {
        const c = clipRect(r, width, height);
        if (c) for (let y = c.y; y < c.y + c.height; y++) keep.fill(1, y * width + c.x, y * width + c.x + c.width);
      }
      for (let p = 0; p < keep.length; p++) {
        if (keep[p] || (limit && !limit[p])) continue;
        out[p * 4] = out[p * 4 + 1] = out[p * 4 + 2] = out[p * 4 + 3] = 0;
      }
      break;
    }
    case 'set':
      applySet(out, width, height, op);
      break;
  }
  return { pixels: out, changed: changedRect(layer, out, width, height) };
}
