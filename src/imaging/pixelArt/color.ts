// Colour helpers for the pixel-art tools: hex parsing, HSV, nearest palette colour.
// All pure and deterministic.

/** '#rrggbb' (also '#rgb', and either without the '#') → [r, g, b] 0..255. Throws on anything else. */
export function hexToRgb(hex: string): [number, number, number] {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) throw new Error(`Invalid colour "${hex}": expected #rrggbb`);
  let digits = match[1];
  if (digits.length === 3) digits = digits[0] + digits[0] + digits[1] + digits[1] + digits[2] + digits[2];
  const n = parseInt(digits, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/** Lower-case '#rrggbb'; channels are rounded and clamped to 0..255. */
export function rgbToHex(r: number, g: number, b: number): string {
  return '#' + ((1 << 24) | (clampByte(r) << 16) | (clampByte(g) << 8) | clampByte(b)).toString(16).slice(1);
}

/** RGB 0..255 → [hue 0..360, saturation 0..1, value 0..1]. Grey has hue 0. */
export function rgbToHsv(r: number, g: number, b: number): [h: number, s: number, v: number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max, max];
}

/** [hue (any degrees, wrapped), saturation 0..1, value 0..1] → RGB as 0..255 integers. */
export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const hh = (((h % 360) + 360) % 360) / 60;
  const sat = Math.min(1, Math.max(0, s));
  const val = Math.min(1, Math.max(0, v));
  const c = val * sat;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = val - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hh < 1) [r, g, b] = [c, x, 0];
  else if (hh < 2) [r, g, b] = [x, c, 0];
  else if (hh < 3) [r, g, b] = [0, c, x];
  else if (hh < 4) [r, g, b] = [0, x, c];
  else if (hh < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [clampByte((r + m) * 255), clampByte((g + m) * 255), clampByte((b + m) * 255)];
}

/** Index of the palette colour closest in RGB (squared distance); the first wins ties. Throws on an empty palette. */
export function nearestColor(r: number, g: number, b: number, palette: readonly (readonly [number, number, number])[]): number {
  if (palette.length === 0) throw new Error('The palette is empty');
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i];
    const dr = p[0] - r;
    const dg = p[1] - g;
    const db = p[2] - b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}
