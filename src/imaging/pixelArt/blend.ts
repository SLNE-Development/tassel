// Painting one pixel, following the W3C Compositing & Blending Level 1 model on straight (non-premultiplied)
// colour. With source colour Cs and alpha as over a backdrop Cb with alpha ab, for blend mode B:
//   Cs2 = (1 - ab)*Cs + ab*B(Cb, Cs)          (the blended source; B = Cs for 'default')
//   ar  = as + ab*(1 - as)
//   Cr  = ((1 - as)*ab*Cb + as*Cs2) / ar
// Everything is computed in floats 0..1 and rounded to the nearest 0..255 once at the end.
import type { PixelPaint } from '../../core/pixelOps';

type PaintMode = Pick<PixelPaint, 'blend' | 'lockAlpha' | 'erase'>;

function lum(r: number, g: number, b: number): number {
  return 0.3 * r + 0.59 * g + 0.11 * b;
}

const scratch = [0, 0, 0];

/** W3C SetLum(C, l) with ClipColor, into `scratch`. */
function setLum(r: number, g: number, b: number, l: number): void {
  const d = l - lum(r, g, b);
  r += d;
  g += d;
  b += d;
  const ll = lum(r, g, b);
  const n = Math.min(r, g, b);
  const x = Math.max(r, g, b);
  if (n < 0) {
    const k = ll - n;
    r = ll + ((r - ll) * ll) / k;
    g = ll + ((g - ll) * ll) / k;
    b = ll + ((b - ll) * ll) / k;
  }
  if (x > 1) {
    const k = x - ll;
    r = ll + ((r - ll) * (1 - ll)) / k;
    g = ll + ((g - ll) * (1 - ll)) / k;
    b = ll + ((b - ll) * (1 - ll)) / k;
  }
  scratch[0] = r;
  scratch[1] = g;
  scratch[2] = b;
}

/** Separable blend function B(Cb, Cs) for one channel, 0..1. */
function channelBlend(mode: PaintMode['blend'], cb: number, cs: number): number {
  switch (mode) {
    case 'multiply':
      return cb * cs;
    case 'screen':
      return cb + cs - cb * cs;
    case 'overlay': // HardLight with the roles swapped
      return cb <= 0.5 ? 2 * cb * cs : cs + (2 * cb - 1) - cs * (2 * cb - 1);
    case 'darken':
      return Math.min(cb, cs);
    case 'lighten':
      return Math.max(cb, cs);
    case 'difference':
      return Math.abs(cb - cs);
    case 'add':
      return Math.min(1, cb + cs);
    default:
      return cs;
  }
}

function byte(v: number): number {
  const n = Math.round(v * 255);
  return n < 0 ? 0 : n > 255 ? 255 : n;
}

/**
 * Paints one pixel: writes the result into `out` at byte offset `i`. The source colour is r, g, b 0..255 with
 * alpha 0..1 (paint opacity times any source alpha).
 *
 * - default: source-over. behind: destination-over. set_opacity: the pixel becomes exactly (Cs, as).
 * - erase: ab' = ab*(1 - as), colour untouched (even when the alpha reaches 0).
 * - lockAlpha: the final alpha is forced back to ab, so fully transparent pixels are left unchanged.
 * - Otherwise a result of alpha 0 is written as 0,0,0,0 (one canonical transparent pixel).
 */
export function paintPixel(out: Uint8ClampedArray, i: number, r: number, g: number, b: number, alpha: number, paint: PaintMode): void {
  const as = alpha <= 0 ? 0 : alpha >= 1 ? 1 : alpha;
  const aByte = out[i + 3];
  const ab = aByte / 255;
  if (paint.lockAlpha && aByte === 0) return;
  if (paint.erase) {
    if (paint.lockAlpha) return;
    out[i + 3] = byte(ab * (1 - as));
    return;
  }
  const mode = paint.blend;
  if (as === 0 && mode !== 'set_opacity') return;
  const csr = r / 255;
  const csg = g / 255;
  const csb = b / 255;
  const cbr = out[i] / 255;
  const cbg = out[i + 1] / 255;
  const cbb = out[i + 2] / 255;

  let ar: number;
  let cr: number;
  let cg: number;
  let cb: number;
  if (mode === 'set_opacity') {
    ar = as;
    cr = csr;
    cg = csg;
    cb = csb;
  } else if (mode === 'behind') {
    ar = ab + as * (1 - ab);
    if (ar > 0) {
      const wb = ab / ar;
      const ws = ((1 - ab) * as) / ar;
      cr = wb * cbr + ws * csr;
      cg = wb * cbg + ws * csg;
      cb = wb * cbb + ws * csb;
    } else {
      cr = cg = cb = 0;
    }
  } else {
    let sr = csr;
    let sg = csg;
    let sb = csb;
    if (ab > 0 && mode !== 'default') {
      let br: number;
      let bg: number;
      let bb: number;
      if (mode === 'color') {
        setLum(csr, csg, csb, lum(cbr, cbg, cbb));
        br = scratch[0];
        bg = scratch[1];
        bb = scratch[2];
      } else {
        br = channelBlend(mode, cbr, csr);
        bg = channelBlend(mode, cbg, csg);
        bb = channelBlend(mode, cbb, csb);
      }
      sr = (1 - ab) * csr + ab * br;
      sg = (1 - ab) * csg + ab * bg;
      sb = (1 - ab) * csb + ab * bb;
    }
    ar = as + ab * (1 - as);
    if (ar > 0) {
      const wb = ((1 - as) * ab) / ar;
      const ws = as / ar;
      cr = wb * cbr + ws * sr;
      cg = wb * cbg + ws * sg;
      cb = wb * cbb + ws * sb;
    } else {
      cr = cg = cb = 0;
    }
  }

  const finalAlpha = paint.lockAlpha ? aByte : byte(ar);
  if (finalAlpha === 0) {
    out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0;
    return;
  }
  out[i] = byte(cr);
  out[i + 1] = byte(cg);
  out[i + 2] = byte(cb);
  out[i + 3] = finalAlpha;
}
