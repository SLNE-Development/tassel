// Pure pixel functions for texture painting. DOM-free and deterministic: the paint commands, the live
// preview and the tests all run exactly this code.
//
// Images are RGBA, 8 bits per channel, NOT premultiplied, row 0 = top of the image. UV coordinates have
// v pointing up, so v = 1 is row 0: pixel position = (u * width, (1 - v) * height), pixel centres at +0.5.
import type { BlendMode, PaintBrush, StrokePoints } from '../core/types';

export type Rgba = Uint8ClampedArray<ArrayBuffer>;

/** A pixel rectangle inside an image (row 0 = top). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A decoded paint layer. `pixels` is not read for layers that are hidden. */
export interface LayerPixels {
  readonly pixels: Uint8ClampedArray;
  readonly visible: boolean;
  readonly opacity: number;
  readonly blend: BlendMode;
}

/** Most stamps one stroke may have; a longer stroke is refused instead of freezing the app. */
export const MAX_STAMPS = 1_000_000;

/** '#rrggbb' → [r, g, b]. */
export function parseColor(color: string): [number, number, number] {
  const n = parseInt(color.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * The coverage of one brush stroke: 0..255 per pixel, the maximum over all stamps, so overlapping stamps
 * never add up. Points can be added in several calls; the result is the same as adding them all at once.
 *
 * Stamps: one at the first point, then along the polyline every `spacing * diameter` pixels (at least half
 * a pixel), where diameter = size * pressure of the last stamp; pressure is interpolated between points.
 * A stamp of radius r covers a pixel whose centre is d away by smoothstep((r + 0.5 - d) / w), with
 * w = max(1, (1 - hardness) * r): one anti-aliased pixel at hardness 1, a falloff from the centre at 0.
 *
 * A stroke may consist of several polylines (a drag that crosses a UV seam): at a break the next point is
 * not connected to the one before and starts with a stamp of its own, as a first point does. The coverage
 * is shared, so polylines of one stroke that overlap do not add up either.
 */
export class StrokeMask {
  readonly coverage: Uint8Array;
  private last: [x: number, y: number, pressure: number] | null = null;
  private untilNext = 0;
  private stamps = 0;
  private dirty = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };

  constructor(
    readonly width: number,
    readonly height: number,
    private readonly brush: Pick<PaintBrush, 'size' | 'hardness' | 'spacing'>,
  ) {
    this.coverage = new Uint8Array(width * height);
  }

  /** Ends the current polyline: the next point starts a new one. */
  breakStroke(): void {
    this.last = null;
  }

  /**
   * Stamps the next points [u, v, pressure?]. Returns the rectangle whose coverage changed, or null.
   * `breaks` are indices into `points` (increasing) at which a new polyline starts.
   */
  add(points: StrokePoints, breaks: readonly number[] = []): Rect | null {
    this.dirty = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    let nextBreak = 0;
    for (let index = 0; index < points.length; index++) {
      const point = points[index];
      if (breaks[nextBreak] === index) {
        nextBreak++;
        this.last = null;
      }
      const x = (point[0] ?? 0) * this.width;
      const y = (1 - (point[1] ?? 0)) * this.height;
      const pressure = Math.min(1, Math.max(0, point[2] ?? 1));
      const last = this.last;
      if (!last) {
        this.stamp(x, y, pressure);
      } else {
        const length = Math.hypot(x - last[0], y - last[1]);
        let position = 0;
        while (this.untilNext <= length - position) {
          position += this.untilNext;
          const t = position / length;
          this.stamp(last[0] + (x - last[0]) * t, last[1] + (y - last[1]) * t, last[2] + (pressure - last[2]) * t);
        }
        this.untilNext -= length - position;
      }
      this.last = [x, y, pressure];
    }
    const { x0, y0, x1, y1 } = this.dirty;
    return x1 < x0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
  }

  private stamp(cx: number, cy: number, pressure: number): void {
    if (++this.stamps > MAX_STAMPS) {
      throw new Error(`The stroke is too long: more than ${MAX_STAMPS} brush stamps. Use fewer or closer points, or a larger spacing.`);
    }
    const radius = (this.brush.size * pressure) / 2;
    this.untilNext = Math.max(0.5, this.brush.spacing * radius * 2);
    const falloff = Math.max(1, (1 - this.brush.hardness) * radius);
    const outer = radius + 0.5;
    const inner = outer - falloff;
    const innerSquared = inner > 0 ? inner * inner : -1;
    const y0 = Math.max(0, Math.floor(cy - outer));
    const y1 = Math.min(this.height - 1, Math.ceil(cy + outer) - 1);
    const { coverage, width, dirty } = this;
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - cy;
      const half = outer * outer - dy * dy;
      if (half <= 0) continue;
      const reach = Math.sqrt(half);
      const x0 = Math.max(0, Math.floor(cx - reach));
      const x1 = Math.min(width - 1, Math.ceil(cx + reach) - 1);
      if (x1 < x0) continue;
      let touched = false;
      for (let x = x0, i = y * width + x0; x <= x1; x++, i++) {
        const dx = x + 0.5 - cx;
        const squared = dx * dx + dy * dy;
        let value = 255;
        if (squared > innerSquared) {
          const t = (outer - Math.sqrt(squared)) / falloff;
          if (t <= 0) continue;
          value = t >= 1 ? 255 : Math.round(t * t * (3 - 2 * t) * 255);
        }
        if (value > coverage[i]) {
          coverage[i] = value;
          touched = true;
          if (x < dirty.x0) dirty.x0 = x;
          if (x > dirty.x1) dirty.x1 = x;
        }
      }
      if (touched) {
        if (y < dirty.y0) dirty.y0 = y;
        if (y > dirty.y1) dirty.y1 = y;
      }
    }
  }
}

/**
 * Writes `source` with the stroke applied into `target`, inside `rect` only: where the mask covers a pixel,
 * the colour is laid over it with alpha = coverage * opacity (normal blending), or — erasing — the pixel's
 * alpha is reduced by that share. Without a mask the whole rectangle counts as fully covered.
 * `source` and `target` may be the same buffer.
 */
export function applyStroke(
  source: Uint8ClampedArray,
  target: Uint8ClampedArray,
  width: number,
  rect: Rect,
  mask: Uint8Array | null,
  color: readonly [number, number, number],
  opacity: number,
  erase: boolean,
): void {
  const [r, g, b] = color;
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    let m = y * width + rect.x;
    let i = m * 4;
    for (let x = 0; x < rect.width; x++, m++, i += 4) {
      const coverage = mask ? mask[m] : 255;
      const alpha = source[i + 3];
      if (coverage === 0) {
        if (target !== source) {
          target[i] = source[i];
          target[i + 1] = source[i + 1];
          target[i + 2] = source[i + 2];
          target[i + 3] = alpha;
        }
        continue;
      }
      const a = (coverage * opacity) / 255;
      if (erase) {
        target[i] = source[i];
        target[i + 1] = source[i + 1];
        target[i + 2] = source[i + 2];
        target[i + 3] = (alpha * (1 - a) + 0.5) | 0;
        continue;
      }
      const below = alpha / 255;
      const out = a + below * (1 - a);
      // Share of the brush colour in the result; 1 on a transparent pixel.
      const k = out > 0 ? a / out : 0;
      target[i] = (source[i] + (r - source[i]) * k + 0.5) | 0;
      target[i + 1] = (source[i + 1] + (g - source[i + 1]) * k + 0.5) | 0;
      target[i + 2] = (source[i + 2] + (b - source[i + 2]) * k + 0.5) | 0;
      target[i + 3] = (out * 255 + 0.5) | 0;
    }
  }
}

/** A new image: `source` with the whole stroke painted in. For one-off use; the commands go through StrokePreview's steps. */
export function paintStroke(
  source: Uint8ClampedArray,
  width: number,
  height: number,
  brush: PaintBrush,
  points: StrokePoints,
  breaks?: readonly number[],
): Rgba {
  const target = new Uint8ClampedArray(source);
  const mask = new StrokeMask(width, height, brush);
  const rect = mask.add(points, breaks);
  if (rect) applyStroke(source, target, width, rect, mask.coverage, parseColor(brush.color), brush.opacity, brush.erase);
  return target;
}

/** A new image of the given size in one colour: opaque for '#rrggbb', fully transparent for null. */
export function blankPixels(width: number, height: number, color: string | null): Rgba {
  const pixels = new Uint8ClampedArray(width * height * 4);
  if (color !== null) {
    const [r, g, b] = parseColor(color);
    // One 32-bit write per pixel; the byte order of the view follows the platform.
    const word = new Uint32Array(new Uint8Array([r, g, b, 255]).buffer)[0];
    new Uint32Array(pixels.buffer).fill(word);
  }
  return pixels;
}

/** A new image: the colour laid over every pixel of `source` at `opacity` (1 replaces the image, alpha included). */
export function fillPixels(source: Uint8ClampedArray, width: number, height: number, color: string, opacity: number): Rgba {
  if (opacity >= 1) return blankPixels(width, height, color);
  const target = new Uint8ClampedArray(source.length);
  applyStroke(source, target, width, { x: 0, y: 0, width, height }, null, parseColor(color), opacity, false);
  return target;
}

/**
 * Composites the visible layers (bottom first) onto transparency, into `out` (a new buffer if omitted),
 * inside `rect` only (the whole image if omitted). Standard alpha compositing on non-premultiplied values
 * (W3C "Compositing and Blending"): with source alpha As = layer alpha * layer opacity and backdrop alpha Ab,
 *   Ao = As + Ab - As*Ab,   Co = (As*(1-Ab)*Cs + As*Ab*Blend(Cb, Cs) + (1-As)*Ab*Cb) / Ao.
 * Where the backdrop is fully transparent the source colour is taken over unchanged (even at alpha 0), so a
 * single layer at opacity 1 composites to an exact copy of itself. Each layer's result is rounded to 8 bits.
 * Blend(b, s) on 0..1: normal s; multiply b*s; screen b + s - b*s; add min(1, b + s);
 * overlay 2*b*s where the backdrop is darker than mid grey, else 1 - 2*(1-b)*(1-s).
 */
export function compositeLayers(width: number, height: number, layers: readonly LayerPixels[], out?: Rgba, rect?: Rect): Rgba {
  const target = out ?? new Uint8ClampedArray(width * height * 4);
  const area = rect ?? { x: 0, y: 0, width, height };
  const rowStart = (y: number) => (y * width + area.x) * 4;
  const rowBytes = area.width * 4;
  // `empty` = the target is still transparent everywhere in the area: the first layer is simply copied.
  let empty = true;
  if (out) for (let y = area.y; y < area.y + area.height; y++) out.fill(0, rowStart(y), rowStart(y) + rowBytes);
  for (const layer of layers) {
    if (!layer.visible || layer.opacity <= 0) continue;
    const source = layer.pixels;
    const opacity = Math.min(1, layer.opacity);
    const mode = layer.blend;
    const first = empty;
    empty = false;
    for (let y = area.y; y < area.y + area.height; y++) {
      let i = rowStart(y);
      if (first) {
        target.set(source.subarray(i, i + rowBytes), i);
        if (opacity < 1) for (let a = i + 3; a < i + rowBytes; a += 4) target[a] = (target[a] * opacity + 0.5) | 0;
        continue;
      }
      for (const end = i + rowBytes; i < end; i += 4) {
        const sourceAlpha = source[i + 3];
        const backdropAlpha = target[i + 3];
        if (backdropAlpha === 0) {
          target[i] = source[i];
          target[i + 1] = source[i + 1];
          target[i + 2] = source[i + 2];
          target[i + 3] = opacity === 1 ? sourceAlpha : (sourceAlpha * opacity + 0.5) | 0;
          continue;
        }
        if (sourceAlpha === 0) continue;
        const s0 = source[i];
        const s1 = source[i + 1];
        const s2 = source[i + 2];
        if (sourceAlpha === 255 && opacity === 1 && mode === 'normal') {
          target[i] = s0;
          target[i + 1] = s1;
          target[i + 2] = s2;
          target[i + 3] = 255;
          continue;
        }
        const b0 = target[i];
        const b1 = target[i + 1];
        const b2 = target[i + 2];
        const as = (sourceAlpha * opacity) / 255;
        // Weights of the plain source colour, the blended colour and the backdrop colour.
        let ws = 0;
        let wm = as;
        let wb = 1 - as;
        if (backdropAlpha !== 255) {
          const ab = backdropAlpha / 255;
          const ao = as + ab - as * ab;
          ws = (as * (1 - ab)) / ao;
          wm = (as * ab) / ao;
          wb = ((1 - as) * ab) / ao;
          target[i + 3] = (ao * 255 + 0.5) | 0;
        }
        // The blended colour per channel (see blendChannel), written out per mode: this is the hot loop.
        let m0 = s0;
        let m1 = s1;
        let m2 = s2;
        if (mode === 'multiply') {
          m0 = (b0 * s0) / 255;
          m1 = (b1 * s1) / 255;
          m2 = (b2 * s2) / 255;
        } else if (mode === 'screen') {
          m0 = b0 + s0 - (b0 * s0) / 255;
          m1 = b1 + s1 - (b1 * s1) / 255;
          m2 = b2 + s2 - (b2 * s2) / 255;
        } else if (mode === 'add') {
          m0 = b0 + s0 > 255 ? 255 : b0 + s0;
          m1 = b1 + s1 > 255 ? 255 : b1 + s1;
          m2 = b2 + s2 > 255 ? 255 : b2 + s2;
        } else if (mode === 'overlay') {
          m0 = b0 < 128 ? (2 * b0 * s0) / 255 : 255 - (2 * (255 - b0) * (255 - s0)) / 255;
          m1 = b1 < 128 ? (2 * b1 * s1) / 255 : 255 - (2 * (255 - b1) * (255 - s1)) / 255;
          m2 = b2 < 128 ? (2 * b2 * s2) / 255 : 255 - (2 * (255 - b2) * (255 - s2)) / 255;
        }
        target[i] = (ws * s0 + wm * m0 + wb * b0 + 0.5) | 0;
        target[i + 1] = (ws * s1 + wm * m1 + wb * b1 + 0.5) | 0;
        target[i + 2] = (ws * s2 + wm * m2 + wb * b2 + 0.5) | 0;
      }
    }
  }
  return target;
}

/** The pixels of the layer that replaces `lower` and `upper`: `upper` (with its opacity and blend mode) composited onto `lower`. */
export function mergeDown(width: number, height: number, lower: Uint8ClampedArray, upper: Omit<LayerPixels, 'visible'>): Rgba {
  return compositeLayers(width, height, [
    { pixels: lower, visible: true, opacity: 1, blend: 'normal' },
    { ...upper, visible: true },
  ]);
}

/**
 * Tangent-space normal map from a height image (its luminance, white = high; `invert` makes black high).
 * Sobel filter that wraps around at the borders, so tiling heights give tiling normals. OpenGL convention:
 * red = +u, green = +v (up in the image), blue = out of the surface; a flat area is exactly (128, 128, 255).
 * The normal is normalize(-strength * dh/du, -strength * dh/dv, 1) with the height in 0..1 and the gradient
 * taken as the plain Sobel sum (8 x the slope per pixel).
 */
export function normalFromHeight(source: Uint8ClampedArray, width: number, height: number, strength: number, invert: boolean): Rgba {
  const heights = new Float32Array(width * height);
  for (let p = 0, i = 0; p < heights.length; p++, i += 4) {
    const luminance = (0.2126 * source[i] + 0.7152 * source[i + 1] + 0.0722 * source[i + 2]) / 255;
    heights[p] = invert ? 1 - luminance : luminance;
  }
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const up = ((y + height - 1) % height) * width;
    const row = y * width;
    const down = ((y + 1) % height) * width;
    for (let x = 0; x < width; x++) {
      const l = (x + width - 1) % width;
      const r = (x + 1) % width;
      // Image x runs along +u; image y runs DOWN, against +v.
      const du = heights[up + r] + 2 * heights[row + r] + heights[down + r] - heights[up + l] - 2 * heights[row + l] - heights[down + l];
      const dv = heights[up + l] + 2 * heights[up + x] + heights[up + r] - heights[down + l] - 2 * heights[down + x] - heights[down + r];
      const nx = -strength * du;
      const ny = -strength * dv;
      const scale = 0.5 / Math.sqrt(nx * nx + ny * ny + 1);
      const i = (row + x) * 4;
      out[i] = Math.round((nx * scale + 0.5) * 255);
      out[i + 1] = Math.round((ny * scale + 0.5) * 255);
      out[i + 2] = Math.round((scale + 0.5) * 255);
      out[i + 3] = 255;
    }
  }
  return out;
}

/**
 * One brush stroke in progress on one layer of a texture, with the composited texture kept up to date.
 * This is the live preview of the paint UI, and `paint.stroke` produces its result with the very same steps
 * (StrokeMask → applyStroke → compositeLayers on the changed rectangle), so both give identical pixels.
 */
export class StrokePreview {
  /** The whole texture with the stroke so far: all visible layers composited. Updated in place by `extend`. */
  readonly pixels: Rgba;
  /** The painted layer with the stroke so far. Updated in place by `extend`. */
  readonly layer: Rgba;
  /** Every point added so far — the `points` to pass to `paint.stroke`. */
  readonly points: (readonly (number | undefined)[])[] = [];
  /** Indices into `points` at which a new polyline starts (see `breakStroke`) — the `breaks` to pass to `paint.stroke`. */
  readonly breaks: number[] = [];
  private breakPending = false;
  private readonly mask: StrokeMask;
  private readonly stack: LayerPixels[];
  private readonly original: Uint8ClampedArray;
  private readonly color: [number, number, number];

  /**
   * @param layers the texture's layers, bottom first (their pixels are only read)
   * @param layerIndex the layer that is painted
   * @param composite the texture as it is now (the composite of `layers`), if known — saves compositing it once
   */
  constructor(
    readonly width: number,
    readonly height: number,
    layers: readonly LayerPixels[],
    layerIndex: number,
    readonly brush: PaintBrush,
    composite?: Uint8ClampedArray,
  ) {
    this.original = layers[layerIndex].pixels;
    this.layer = new Uint8ClampedArray(this.original);
    this.stack = layers.map((layer, index) => (index === layerIndex ? { ...layer, pixels: this.layer } : layer));
    this.pixels = composite ? new Uint8ClampedArray(composite) : compositeLayers(width, height, this.stack);
    this.mask = new StrokeMask(width, height, brush);
    this.color = parseColor(brush.color);
  }

  /** Continues the stroke with more points [u, v, pressure?]. Returns the rectangle of `pixels` and `layer` that changed, or null. */
  extend(points: StrokePoints): Rect | null {
    if (points.length === 0) return null;
    if (this.breakPending) {
      this.breakPending = false;
      this.breaks.push(this.points.length);
      this.mask.breakStroke();
    }
    for (const point of points) this.points.push(point);
    const rect = this.mask.add(points);
    if (!rect) return null;
    applyStroke(this.original, this.layer, this.width, rect, this.mask.coverage, this.color, this.brush.opacity, this.brush.erase);
    compositeLayers(this.width, this.height, this.stack, this.pixels, rect);
    return rect;
  }

  /**
   * Breaks the stroke (at a UV seam, say): the points of the next `extend` start a new polyline that is not
   * connected to what was painted so far. It is still the same stroke — one coverage, one `paint.stroke`.
   * Does nothing before the first point, and nothing more when called twice in a row.
   */
  breakStroke(): void {
    this.breakPending = this.points.length > 0;
  }
}
