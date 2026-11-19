// Image adjustments (Image menu). Colour adjustments leave alpha alone and skip fully transparent pixels.
import type { Adjustment } from '../../core/pixelOps';
import type { Rgba } from '../pixels';
import { hexToRgb, nearestColor } from './color';

type Points = readonly (readonly [number, number])[];

/**
 * Per-channel tone curve lookup table (256 entries) through control points [in, out] in 0..1: a monotone
 * cubic (Fritsch-Carlson) Hermite spline, flat before the first and after the last point. No points = identity;
 * a single point = a constant. Points are sorted by `in`; for equal `in` the last one wins.
 */
export function curveLut(points: readonly (readonly [number, number])[]): Uint8Array {
  const lut = new Uint8Array(256);
  if (points.length === 0) {
    for (let i = 0; i < 256; i++) lut[i] = i;
    return lut;
  }
  const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
  const sorted: [number, number][] = [];
  for (const [px, py] of [...points].map((p, k) => [p[0], p[1], k] as const).sort((a, b) => a[0] - b[0] || a[2] - b[2])) {
    if (!Number.isFinite(px) || !Number.isFinite(py)) throw new Error('Curve points must be finite numbers');
    const p: [number, number] = [clamp01(px), clamp01(py)];
    if (sorted.length > 0 && sorted[sorted.length - 1][0] === p[0]) sorted[sorted.length - 1] = p;
    else sorted.push(p);
  }
  const n = sorted.length;
  const xs = sorted.map((p) => p[0]);
  const ys = sorted.map((p) => p[1]);
  // secant slopes and monotone tangents
  const d = new Array<number>(Math.max(0, n - 1));
  for (let k = 0; k < n - 1; k++) d[k] = (ys[k + 1] - ys[k]) / (xs[k + 1] - xs[k]);
  const m = new Array<number>(n).fill(0);
  if (n > 1) {
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for (let k = 1; k < n - 1; k++) m[k] = d[k - 1] * d[k] <= 0 ? 0 : (d[k - 1] + d[k]) / 2;
    for (let k = 0; k < n - 1; k++) {
      if (d[k] === 0) {
        m[k] = 0;
        m[k + 1] = 0;
        continue;
      }
      const a = m[k] / d[k];
      const b = m[k + 1] / d[k];
      const s = a * a + b * b;
      if (s > 9) {
        const t = 3 / Math.sqrt(s);
        m[k] = t * a * d[k];
        m[k + 1] = t * b * d[k];
      }
    }
  }
  let seg = 0;
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    let y: number;
    if (x <= xs[0]) y = ys[0];
    else if (x >= xs[n - 1]) y = ys[n - 1];
    else {
      while (seg < n - 2 && x > xs[seg + 1]) seg++;
      const h = xs[seg + 1] - xs[seg];
      const t = (x - xs[seg]) / h;
      const t2 = t * t;
      const t3 = t2 * t;
      y = (2 * t3 - 3 * t2 + 1) * ys[seg] + (t3 - 2 * t2 + t) * h * m[seg] + (-2 * t3 + 3 * t2) * ys[seg + 1] + (t3 - t2) * h * m[seg + 1];
    }
    lut[i] = Math.round(clamp01(y) * 255);
  }
  return lut;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Lookup for brightness/contrast; see adjustPixels. */
function brightnessContrastLut(brightness: number, contrast: number): Uint8Array {
  const b = clamp(brightness, -1, 1);
  const c = clamp(contrast, -1, 1);
  const k = c < 0 ? 1 + c : 1 / (1 - Math.min(c, 0.99));
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.round(clamp(((i / 255 - 0.5) * k + 0.5 + b) * 255, 0, 255));
  return lut;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d + 6) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hh = (((h % 360) + 360) % 360) / 60;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hh < 1) [r, g, b] = [c, x, 0];
  else if (hh < 2) [r, g, b] = [x, c, 0];
  else if (hh < 3) [r, g, b] = [0, c, x];
  else if (hh < 4) [r, g, b] = [0, x, c];
  else if (hh < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round(clamp((r + m) * 255, 0, 255)), Math.round(clamp((g + m) * 255, 0, 255)), Math.round(clamp((b + m) * 255, 0, 255))];
}

/**
 * Applies an adjustment to a copy of `pixels`; with `mask` (1 byte per pixel) only selected pixels change.
 *
 * - brightness_contrast: v' = (v - 0.5) * k + 0.5 + brightness on each colour channel (v = 0..1), with
 *   k = 1 + contrast for contrast < 0 and k = 1 / (1 - min(contrast, 0.99)) for contrast >= 0 (contrast 0 and
 *   brightness 0 are exactly the identity). Result clamped, rounded.
 * - hue_saturation: in HSL; hue is rotated by `hue` degrees; saturation s' = s * (1 + sat) for sat < 0 and
 *   s + (1 - s) * sat for sat >= 0 (greys stay grey); lightness l' = l * (1 + light) for light < 0 and
 *   l + (1 - l) * light for light >= 0. All zero = exact identity (no HSL round trip).
 * - opacity: alpha * factor rounded and clamped; a result of alpha 0 is written as 0,0,0,0.
 * - invert: rgb -> 255 - rgb (alpha 0 pixels untouched, so inverting twice is the identity).
 * - curves: `rgb` curve first, then the r/g/b channel's own curve; `a` on alpha.
 * - limit_palette: nearest RGB palette colour (first wins ties), alpha kept, alpha 0 pixels untouched.
 */
export function adjustPixels(pixels: Uint8ClampedArray, width: number, height: number, adjust: Adjustment, mask?: Uint8Array): Rgba {
  if (pixels.length !== width * height * 4) throw new Error(`Pixel data has ${pixels.length} bytes, expected ${width * height * 4}`);
  const out = new Uint8ClampedArray(pixels) as Rgba;
  const count = width * height;
  const selected = (p: number): boolean => mask === undefined || mask[p] !== 0;

  switch (adjust.type) {
    case 'brightness_contrast': {
      if (adjust.brightness === 0 && adjust.contrast === 0) return out;
      const lut = brightnessContrastLut(adjust.brightness, adjust.contrast);
      for (let p = 0; p < count; p++) {
        const i = p * 4;
        if (out[i + 3] === 0 || !selected(p)) continue;
        out[i] = lut[out[i]];
        out[i + 1] = lut[out[i + 1]];
        out[i + 2] = lut[out[i + 2]];
      }
      return out;
    }
    case 'hue_saturation': {
      const { hue, saturation, lightness } = adjust;
      if (hue === 0 && saturation === 0 && lightness === 0) return out;
      const sat = clamp(saturation, -1, 1);
      const light = clamp(lightness, -1, 1);
      for (let p = 0; p < count; p++) {
        const i = p * 4;
        if (out[i + 3] === 0 || !selected(p)) continue;
        let [h, s, l] = rgbToHsl(out[i], out[i + 1], out[i + 2]);
        h += hue;
        if (s > 0) s = sat < 0 ? s * (1 + sat) : s + (1 - s) * sat;
        l = light < 0 ? l * (1 + light) : l + (1 - l) * light;
        const [r, g, b] = hslToRgb(h, s, l);
        out[i] = r;
        out[i + 1] = g;
        out[i + 2] = b;
      }
      return out;
    }
    case 'opacity': {
      const f = adjust.factor;
      if (!(f >= 0)) throw new Error(`Invalid opacity factor ${f}`);
      for (let p = 0; p < count; p++) {
        const i = p * 4;
        if (out[i + 3] === 0 || !selected(p)) continue;
        const a = Math.round(clamp(out[i + 3] * f, 0, 255));
        out[i + 3] = a;
        if (a === 0) out[i] = out[i + 1] = out[i + 2] = 0;
      }
      return out;
    }
    case 'invert': {
      for (let p = 0; p < count; p++) {
        const i = p * 4;
        if (out[i + 3] === 0 || !selected(p)) continue;
        out[i] = 255 - out[i];
        out[i + 1] = 255 - out[i + 1];
        out[i + 2] = 255 - out[i + 2];
      }
      return out;
    }
    case 'curves': {
      const lut = (own: Points | undefined, common?: Points): Uint8Array | null => {
        const a = common && common.length > 0 ? curveLut(common) : null;
        const b = own && own.length > 0 ? curveLut(own) : null;
        if (!a && !b) return null;
        if (!a) return b;
        if (!b) return a;
        const both = new Uint8Array(256);
        for (let v = 0; v < 256; v++) both[v] = b[a[v]];
        return both;
      };
      const lr = lut(adjust.r, adjust.rgb);
      const lg = lut(adjust.g, adjust.rgb);
      const lb = lut(adjust.b, adjust.rgb);
      const la = lut(adjust.a);
      for (let p = 0; p < count; p++) {
        const i = p * 4;
        if (!selected(p)) continue;
        if (out[i + 3] !== 0) {
          if (lr) out[i] = lr[out[i]];
          if (lg) out[i + 1] = lg[out[i + 1]];
          if (lb) out[i + 2] = lb[out[i + 2]];
        }
        if (la) {
          const before = out[i + 3];
          const a = la[before];
          out[i + 3] = a;
          if (a === 0 && before !== 0) out[i] = out[i + 1] = out[i + 2] = 0;
        }
      }
      return out;
    }
    case 'limit_palette': {
      const palette = adjust.colors.map((c) => hexToRgb(c));
      if (palette.length === 0) throw new Error('The palette is empty');
      let lastKey = -1;
      let lastIndex = 0;
      for (let p = 0; p < count; p++) {
        const i = p * 4;
        if (out[i + 3] === 0 || !selected(p)) continue;
        const key = (out[i] << 16) | (out[i + 1] << 8) | out[i + 2];
        if (key !== lastKey) {
          lastKey = key;
          lastIndex = nearestColor(out[i], out[i + 1], out[i + 2], palette);
        }
        const c = palette[lastIndex];
        out[i] = c[0];
        out[i + 1] = c[1];
        out[i + 2] = c[2];
      }
      return out;
    }
  }
}
