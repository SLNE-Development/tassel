import { describe, expect, it } from 'vitest';
import { blendModes } from '../core/types';
import type { BlendMode, PaintBrush } from '../core/types';
import {
  MAX_STAMPS,
  StrokeMask,
  StrokePreview,
  applyStroke,
  blankPixels,
  compositeLayers,
  fillPixels,
  mergeDown,
  normalFromHeight,
  paintStroke,
  parseColor,
  type LayerPixels,
  type Rgba,
} from './pixels';

const brush = (overrides: Partial<PaintBrush> = {}): PaintBrush => ({
  color: '#000000',
  size: 10,
  opacity: 1,
  hardness: 1,
  spacing: 0.15,
  erase: false,
  ...overrides,
});

const pixel = (pixels: Uint8ClampedArray, width: number, x: number, y: number) => [...pixels.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
const layer = (pixels: Uint8ClampedArray, overrides: Partial<LayerPixels> = {}): LayerPixels => ({ pixels, visible: true, opacity: 1, blend: 'normal', ...overrides });
/** One RGBA value repeated. */
const solid = (width: number, height: number, rgba: readonly number[]): Rgba => {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < pixels.length; i++) pixels[i] = rgba[i % 4];
  return pixels;
};
/** Repeatable pseudo-random bytes. */
function noise(length: number, seed = 1): Rgba {
  const out = new Uint8ClampedArray(length);
  let s = seed;
  for (let i = 0; i < length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}
const area = (mask: StrokeMask) => mask.coverage.reduce((sum, v) => sum + v, 0) / 255;

describe('StrokeMask', () => {
  it('stamps a hard round dot of the brush diameter, anti-aliased', () => {
    const mask = new StrokeMask(32, 32, brush({ size: 10 }));
    expect(mask.add([[0.5, 0.5]])).toEqual({ x: 11, y: 11, width: 10, height: 10 });
    expect(area(mask)).toBeGreaterThan(Math.PI * 25 - 1.5);
    expect(area(mask)).toBeLessThan(Math.PI * 25 + 1.5);
    const at = (x: number, y: number) => mask.coverage[y * 32 + x];
    expect(at(16, 16)).toBe(255);
    expect(at(12, 16)).toBe(255); // 3.5 px from the centre
    expect(at(11, 16)).toBeGreaterThan(100); // 4.5 px: on the edge
    expect(at(11, 16)).toBeLessThan(255);
    expect(at(10, 16)).toBe(0); // 5.5 px: outside
    // Symmetric in every direction.
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        expect(at(x, y)).toBe(at(31 - x, y));
        expect(at(x, y)).toBe(at(y, x));
      }
    }
  });

  it('maps v up to the top of the image', () => {
    const mask = new StrokeMask(100, 50, brush({ size: 6 }));
    expect(mask.add([[0.25, 0.9]])).toEqual({ x: 22, y: 2, width: 6, height: 6 });
    expect(mask.coverage[5 * 100 + 25]).toBe(255); // u 0.25 → x 25, v 0.9 → 10 % from the top: y 5 of 50
    expect(mask.coverage[45 * 100 + 25]).toBe(0);
  });

  it('falls off monotonically from the centre for a soft brush', () => {
    const soft = new StrokeMask(64, 64, brush({ size: 40, hardness: 0 }));
    soft.add([[0.5, 0.5]]);
    const row = [...soft.coverage.subarray(32 * 64 + 32, 32 * 64 + 64)];
    expect(row[0]).toBeGreaterThan(250);
    for (let x = 1; x < row.length; x++) expect(row[x]).toBeLessThanOrEqual(row[x - 1]);
    expect(new Set(row.slice(0, 20)).size).toBeGreaterThan(15); // a gradient, not a step
    expect(row[10]).toBeGreaterThan(100);
    expect(row[10]).toBeLessThan(160); // half way out: about half
    expect(row[21]).toBe(0);

    const hard = new StrokeMask(64, 64, brush({ size: 40, hardness: 1 }));
    hard.add([[0.5, 0.5]]);
    const half = new StrokeMask(64, 64, brush({ size: 40, hardness: 0.5 }));
    half.add([[0.5, 0.5]]);
    expect(area(hard)).toBeGreaterThan(area(half));
    expect(area(half)).toBeGreaterThan(area(soft));
    expect(half.coverage[32 * 64 + 32 + 9]).toBe(255); // inside the hard core
  });

  it('scales the brush with the pressure', () => {
    const full = new StrokeMask(64, 64, brush({ size: 20 }));
    full.add([[0.5, 0.5]]);
    const light = new StrokeMask(64, 64, brush({ size: 20 }));
    light.add([[0.5, 0.5, 0.5]]);
    expect(area(full)).toBeCloseTo(Math.PI * 100, -1);
    expect(area(light)).toBeGreaterThan(Math.PI * 25 - 1.5);
    expect(area(light)).toBeLessThan(Math.PI * 25 + 1.5);

    // Pressure is interpolated along a segment: the stroke gets thinner.
    const taper = new StrokeMask(200, 40, brush({ size: 20 }));
    taper.add([
      [0.1, 0.5, 1],
      [0.9, 0.5, 0.2],
    ]);
    const thickness = (x: number) => {
      let count = 0;
      for (let y = 0; y < 40; y++) if (taper.coverage[y * 200 + x] > 127) count++;
      return count;
    };
    expect(thickness(20)).toBe(20);
    expect(thickness(100)).toBeGreaterThan(8);
    expect(thickness(100)).toBeLessThan(16);
    expect(thickness(175)).toBeLessThanOrEqual(6);
    expect(thickness(175)).toBeGreaterThanOrEqual(3);
  });

  it('sets stamps along the polyline every spacing x diameter', () => {
    // Spacing 2: dots of 10 px every 20 px, starting at the first point, across both segments.
    const mask = new StrokeMask(100, 100, brush({ size: 10, spacing: 2 }));
    mask.add([
      [0.1, 0.9],
      [0.6, 0.9],
      [0.6, 0.3],
    ]);
    const centres = [
      [10, 10],
      [30, 10],
      [50, 10],
      [60, 20], // 10 px along the first segment remain, so 10 px into the second
      [60, 40],
      [60, 60],
    ];
    for (const [x, y] of centres) expect(mask.coverage[y * 100 + x], `${x},${y}`).toBe(255);
    for (const [x, y] of [[20, 10], [40, 10], [60, 10], [60, 30], [60, 50], [60, 70]]) expect(mask.coverage[y * 100 + x], `${x},${y}`).toBe(0);
    expect(area(mask)).toBeCloseTo(6 * Math.PI * 25, -1);
    // The default spacing gives a closed line.
    const line = new StrokeMask(100, 100, brush({ size: 10 }));
    line.add([
      [0.1, 0.9],
      [0.6, 0.9],
    ]);
    for (let x = 10; x <= 60; x++) expect(line.coverage[10 * 100 + x]).toBe(255);
  });

  it('gives the same coverage whether points come at once or one by one', () => {
    const points = [
      [0.1, 0.2, 0.3],
      [0.5, 0.8, 1],
      [0.5, 0.8, 0.5],
      [0.9, 0.1, 0.7],
      [0.2, 0.4],
    ];
    const once = new StrokeMask(128, 128, brush({ size: 14, hardness: 0.4, spacing: 0.37 }));
    once.add(points);
    const stepwise = new StrokeMask(128, 128, brush({ size: 14, hardness: 0.4, spacing: 0.37 }));
    for (const point of points) stepwise.add([point]);
    expect(stepwise.coverage).toEqual(once.coverage);
  });

  it('reports exactly the rectangle it touched and clips at the image border', () => {
    const mask = new StrokeMask(64, 64, brush({ size: 8 }));
    const rect = mask.add([
      [0.25, 0.75],
      [0.5, 0.75],
    ])!;
    expect(rect).toEqual({ x: 12, y: 12, width: 24, height: 8 });
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const inside = x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
        if (!inside) expect(mask.coverage[y * 64 + x]).toBe(0);
      }
    }
    // Continuing reports only the new part.
    expect(mask.add([[0.5, 0.5]])).toEqual({ x: 28, y: 15, width: 8, height: 21 });
    // Outside the texture: nothing; across the border: clipped.
    expect(new StrokeMask(64, 64, brush()).add([[2, 2]])).toBeNull();
    expect(new StrokeMask(64, 64, brush({ size: 8 })).add([[0, 1]])).toEqual({ x: 0, y: 0, width: 4, height: 4 });
    expect(new StrokeMask(64, 64, brush()).add([])).toBeNull();
  });

  it('does not connect the points on either side of a break and restarts the spacing there', () => {
    // Two horizontal lines, far apart; unbroken, a diagonal would join them.
    const points = [
      [0.1, 0.8],
      [0.4, 0.8],
      [0.6, 0.2],
      [0.9, 0.2],
    ];
    const broken = new StrokeMask(100, 100, brush({ size: 6 }));
    expect(broken.add(points, [2])).toEqual({ x: 7, y: 17, width: 86, height: 66 });
    const joined = new StrokeMask(100, 100, brush({ size: 6 }));
    joined.add(points);
    expect(joined.coverage[50 * 100 + 50]).toBe(255); // the middle of the diagonal
    // Nothing between the two lines: rows 23..76 are empty.
    for (let y = 23; y < 77; y++) for (let x = 0; x < 100; x++) expect(broken.coverage[y * 100 + x], `${x},${y}`).toBe(0);
    for (let x = 10; x <= 40; x++) expect(broken.coverage[20 * 100 + x]).toBe(255);
    for (let x = 60; x <= 90; x++) expect(broken.coverage[80 * 100 + x]).toBe(255);
    // Exactly the two lines painted on their own, combined by maximum.
    const a = new StrokeMask(100, 100, brush({ size: 6 }));
    a.add(points.slice(0, 2));
    const b = new StrokeMask(100, 100, brush({ size: 6 }));
    b.add(points.slice(2));
    expect(broken.coverage).toEqual(a.coverage.map((v, i) => Math.max(v, b.coverage[i])));

    // Spacing 2 (dots every 20 px): the polyline after the break starts with a stamp at its first point,
    // whatever distance was left over before the break.
    const dots = new StrokeMask(100, 100, brush({ size: 10, spacing: 2 }));
    dots.add(
      [
        [0.1, 0.9],
        [0.4, 0.9], // stamps at x 10 and 30; 10 px left over
        [0.15, 0.5],
        [0.5, 0.5], // stamps at x 15 and 35
      ],
      [2],
    );
    for (const [x, y] of [[10, 10], [30, 10], [15, 50], [35, 50]]) expect(dots.coverage[y * 100 + x], `${x},${y}`).toBe(255);
    for (const [x, y] of [[20, 10], [40, 10], [25, 50], [45, 50], [20, 30]]) expect(dots.coverage[y * 100 + x], `${x},${y}`).toBe(0);
    expect(area(dots)).toBeCloseTo(4 * Math.PI * 25, -1);

    // breakStroke() between calls is the same as an index in one call; no breaks is the old behaviour.
    const stepwise = new StrokeMask(100, 100, brush({ size: 6 }));
    stepwise.add(points.slice(0, 2));
    stepwise.breakStroke();
    stepwise.add(points.slice(2));
    expect(stepwise.coverage).toEqual(broken.coverage);
    const none = new StrokeMask(100, 100, brush({ size: 6 }));
    none.add(points, []);
    expect(none.coverage).toEqual(joined.coverage);
  });

  it('refuses strokes with an absurd number of stamps', () => {
    const mask = new StrokeMask(16, 16, brush({ size: 1, spacing: 0.01 }));
    expect(() => mask.add([[0, 0], [MAX_STAMPS, 0]])).toThrow(/stroke is too long/);
  });
});

describe('paintStroke', () => {
  it('does not build up opacity where the stamps of one stroke overlap', () => {
    const white = solid(64, 16, [255, 255, 255, 255]);
    const stroke = brush({ size: 8, opacity: 0.5 });
    const points = [
      [0.1, 0.5],
      [0.9, 0.5],
    ];
    const once = paintStroke(white, 64, 16, stroke, points);
    for (let x = 8; x <= 56; x++) expect(pixel(once, 64, x, 8)).toEqual([128, 128, 128, 255]);
    let darkest = 255;
    for (let i = 0; i < once.length; i += 4) darkest = Math.min(darkest, once[i]);
    expect(darkest).toBe(128);
    // A second stroke is a new stroke and does add up.
    const twice = paintStroke(once, 64, 16, stroke, points);
    expect(pixel(twice, 64, 30, 8)).toEqual([64, 64, 64, 255]);
    // Going back over itself within one stroke does not.
    const zigzag = paintStroke(white, 64, 16, stroke, [...points, [0.1, 0.5], [0.9, 0.5]]);
    for (let i = 0; i < zigzag.length; i += 4) expect(zigzag[i]).toBeGreaterThanOrEqual(128);
    expect(pixel(zigzag, 64, 30, 8)).toEqual([128, 128, 128, 255]);
  });

  it('does not build up opacity where the polylines of one broken stroke overlap', () => {
    const white = solid(64, 64, [255, 255, 255, 255]);
    const stroke = brush({ size: 8, opacity: 0.5 });
    // A cross: a horizontal and a vertical line, not connected.
    const cross = [
      [0.1, 0.5],
      [0.9, 0.5],
      [0.5, 0.9],
      [0.5, 0.1],
    ];
    const once = paintStroke(white, 64, 64, stroke, cross, [2]);
    expect(pixel(once, 64, 32, 32)).toEqual([128, 128, 128, 255]); // the crossing
    expect(pixel(once, 64, 12, 32)).toEqual([128, 128, 128, 255]);
    expect(pixel(once, 64, 32, 12)).toEqual([128, 128, 128, 255]);
    expect(pixel(once, 64, 16, 16)).toEqual([255, 255, 255, 255]); // no diagonal from (0.9, 0.5) to (0.5, 0.9) ... nor elsewhere
    expect(pixel(once, 64, 46, 20)).toEqual([255, 255, 255, 255]);
    for (let i = 0; i < once.length; i += 4) expect(once[i]).toBeGreaterThanOrEqual(128);
    // As two strokes the crossing gets darker.
    const two = paintStroke(paintStroke(white, 64, 64, stroke, cross.slice(0, 2)), 64, 64, stroke, cross.slice(2));
    expect(pixel(two, 64, 32, 32)).toEqual([64, 64, 64, 255]);
    // Without breaks nothing changed: undefined and [] are the plain stroke.
    expect(paintStroke(white, 64, 64, stroke, cross, [])).toEqual(paintStroke(white, 64, 64, stroke, cross));
    expect(paintStroke(white, 64, 64, stroke, cross, undefined)).toEqual(paintStroke(white, 64, 64, stroke, cross));
  });

  it('paints colour onto transparency and over other colours', () => {
    const empty = new Uint8ClampedArray(32 * 32 * 4);
    const red = paintStroke(empty, 32, 32, brush({ color: '#ff0000', size: 12 }), [[0.5, 0.5]]);
    expect(pixel(red, 32, 16, 16)).toEqual([255, 0, 0, 255]);
    expect(pixel(red, 32, 2, 2)).toEqual([0, 0, 0, 0]);
    // The anti-aliased edge has the full colour at partial alpha (not premultiplied).
    const edge = pixel(red, 32, 12, 11);
    expect(edge.slice(0, 3)).toEqual([255, 0, 0]);
    expect(edge[3]).toBeGreaterThan(0);
    expect(edge[3]).toBeLessThan(255);
    // Half-opaque blue over opaque red; over half-transparent red.
    const blue = brush({ color: '#0000ff', size: 12, opacity: 0.5 });
    expect(pixel(paintStroke(red, 32, 32, blue, [[0.5, 0.5]]), 32, 16, 16)).toEqual([128, 0, 128, 255]);
    const faint = solid(32, 32, [255, 0, 0, 128]);
    // a = 0.5, below = 128/255: alpha = 0.5 + 0.502 * 0.5 = 0.751 → 192; blue share = 0.5 / 0.751 = 0.666
    expect(pixel(paintStroke(faint, 32, 32, blue, [[0.5, 0.5]]), 32, 16, 16)).toEqual([85, 0, 170, 192]);
  });

  it('erases alpha and keeps the colour', () => {
    const red = solid(32, 32, [200, 30, 40, 255]);
    const erased = paintStroke(red, 32, 32, brush({ size: 12, erase: true, color: '#00ff00' }), [[0.5, 0.5]]);
    expect(pixel(erased, 32, 16, 16)).toEqual([200, 30, 40, 0]);
    expect(pixel(erased, 32, 2, 2)).toEqual([200, 30, 40, 255]);
    const half = paintStroke(red, 32, 32, brush({ size: 12, erase: true, opacity: 0.5 }), [[0.5, 0.5]]);
    expect(pixel(half, 32, 16, 16)).toEqual([200, 30, 40, 128]);
    const again = paintStroke(half, 32, 32, brush({ size: 12, erase: true, opacity: 0.5 }), [[0.5, 0.5]]);
    expect(pixel(again, 32, 16, 16)).toEqual([200, 30, 40, 64]);
  });

  it('is deterministic and leaves the source and everything outside the stroke alone', () => {
    const source = noise(64 * 64 * 4);
    const copy = new Uint8ClampedArray(source);
    const stroke = brush({ color: '#3366cc', size: 9, hardness: 0.3, opacity: 0.7 });
    const points = [
      [0.2, 0.2, 0.4],
      [0.7, 0.6, 1],
    ];
    const a = paintStroke(source, 64, 64, stroke, points);
    const b = paintStroke(source, 64, 64, stroke, points);
    expect(a).toEqual(b);
    expect(source).toEqual(copy);
    const mask = new StrokeMask(64, 64, stroke);
    mask.add(points);
    let changed = 0;
    for (let p = 0; p < 64 * 64; p++) {
      const same = [0, 1, 2, 3].every((c) => a[p * 4 + c] === source[p * 4 + c]);
      if (mask.coverage[p] === 0) expect(same).toBe(true);
      else if (!same) changed++;
    }
    expect(changed).toBeGreaterThan(100);
  });

  it('touches only the bounding rectangle of the stroke (fast on a large layer)', () => {
    const size = 2048;
    const source = new Uint8ClampedArray(size * size * 4);
    const target = new Uint8ClampedArray(source);
    const mask = new StrokeMask(size, size, brush({ size: 32, hardness: 0.8 }));
    const rect = mask.add([
      [0.4, 0.5],
      [0.45, 0.52],
      [0.5, 0.5],
    ])!;
    const start = performance.now();
    applyStroke(source, target, size, rect, mask.coverage, parseColor('#ff0000'), 1, false);
    const elapsed = performance.now() - start;
    expect(rect.width).toBeLessThan(240);
    expect(rect.height).toBeLessThan(80);
    expect(elapsed).toBeLessThan(200); // well under a millisecond on its own: 14 000 of 4 million pixels
    expect(pixel(target, size, 820, 1024)).toEqual([255, 0, 0, 255]);
  });
});

describe('fillPixels and blankPixels', () => {
  it('fills with an opaque colour, or lays the colour over the image', () => {
    expect(blankPixels(3, 2, null)).toEqual(new Uint8ClampedArray(24));
    expect(blankPixels(3, 2, '#102030')).toEqual(solid(3, 2, [16, 32, 48, 255]));
    const source = solid(4, 4, [255, 255, 255, 255]);
    source.set([9, 9, 9, 0], 0);
    expect(fillPixels(source, 4, 4, '#ff8000', 1)).toEqual(solid(4, 4, [255, 128, 0, 255]));
    const half = fillPixels(source, 4, 4, '#000000', 0.5);
    expect(pixel(half, 4, 0, 0)).toEqual([0, 0, 0, 128]); // onto transparency
    expect(pixel(half, 4, 1, 0)).toEqual([128, 128, 128, 255]); // onto white
  });
});

describe('compositeLayers', () => {
  const backdrop = [200, 100, 50, 255];
  const source = [100, 200, 50, 255];
  const blend = (mode: BlendMode, s = source, b = backdrop, opacity = 1) =>
    pixel(compositeLayers(1, 1, [layer(solid(1, 1, b)), layer(solid(1, 1, s), { blend: mode, opacity })]), 1, 0, 0);

  it('blends opaque colours in every mode', () => {
    expect(blend('normal')).toEqual([100, 200, 50, 255]);
    expect(blend('multiply')).toEqual([78, 78, 10, 255]); // b * s / 255
    expect(blend('screen')).toEqual([222, 222, 90, 255]); // b + s - b * s / 255
    expect(blend('overlay')).toEqual([188, 157, 20, 255]); // multiply below mid grey, screen above
    expect(blend('add')).toEqual([255, 255, 100, 255]);
    // The identities of the modes.
    for (const mode of blendModes) {
      const neutral = mode === 'multiply' ? [255, 255, 255, 255] : mode === 'overlay' ? null : mode === 'normal' ? null : [0, 0, 0, 255];
      if (neutral) expect(blend(mode, neutral), mode).toEqual(backdrop);
    }
    expect(blend('multiply', [0, 0, 0, 255])).toEqual([0, 0, 0, 255]);
    expect(blend('screen', [255, 255, 255, 255])).toEqual([255, 255, 255, 255]);
    expect(blend('overlay', source, [0, 255, 0, 255])).toEqual([0, 255, 0, 255]);
  });

  it('weights the blend by the source alpha and the layer opacity', () => {
    // Half of the way from the backdrop to the blended colour (alpha 128 → 0.502).
    expect(blend('normal', [100, 200, 50, 128])).toEqual([150, 150, 50, 255]);
    expect(blend('multiply', [100, 200, 50, 128])).toEqual([139, 89, 30, 255]);
    expect(blend('normal', source, backdrop, 0.5)).toEqual([150, 150, 50, 255]);
    expect(blend('add', source, backdrop, 0.25)).toEqual([214, 139, 63, 255]);
    expect(blend('normal', [0, 0, 0, 255], [255, 255, 255, 255], 0.5)).toEqual([128, 128, 128, 255]);
    // Opacity and alpha multiply.
    expect(blend('normal', [0, 0, 0, 128], [255, 255, 255, 255], 0.5)).toEqual([191, 191, 191, 255]);
  });

  it('composites translucent over translucent without premultiplication errors', () => {
    // Ao = 0.502 + 0.502 - 0.252 = 0.752 → 192; blue = 0.502 * 255 / 0.752, red = 0.498 * 0.502 * 255 / 0.752
    expect(blend('normal', [0, 0, 255, 128], [255, 0, 0, 128])).toEqual([85, 0, 170, 192]);
    // Where the backdrop is transparent the blend mode has nothing to blend with: the source shows as it is.
    for (const mode of blendModes) expect(blend(mode, [10, 20, 30, 77], [255, 255, 255, 0]), mode).toEqual([10, 20, 30, 77]);
    // Multiply on a half-transparent backdrop: half blended, half the plain source.
    expect(blend('multiply', [100, 200, 50, 255], [200, 100, 50, 128])).toEqual([89, 139, 30, 255]);
    expect(blend('normal', [1, 2, 3, 0])).toEqual(backdrop);
  });

  it('skips hidden and fully transparent layers and never reads hidden pixels', () => {
    const base = solid(2, 2, [10, 20, 30, 255]);
    const top = solid(2, 2, [255, 255, 255, 255]);
    const stack = [layer(base), layer(top, { visible: false }), layer(top, { opacity: 0 }), layer(new Uint8ClampedArray(0), { visible: false })];
    expect(compositeLayers(2, 2, stack)).toEqual(base);
    expect(compositeLayers(2, 2, [])).toEqual(new Uint8ClampedArray(16));
    expect(compositeLayers(2, 2, [layer(top, { visible: false })])).toEqual(new Uint8ClampedArray(16));
  });

  it('composites a single layer to an exact copy of itself', () => {
    const pixels = noise(16 * 16 * 4, 7); // any alpha, colour under alpha 0 included
    for (const mode of blendModes) expect(compositeLayers(16, 16, [layer(pixels, { blend: mode })]), mode).toEqual(pixels);
    const faded = compositeLayers(16, 16, [layer(pixels, { opacity: 0.5 })]);
    for (let i = 0; i < pixels.length; i += 4) {
      expect(faded[i]).toBe(pixels[i]);
      expect(faded[i + 3]).toBe(Math.floor(pixels[i + 3] * 0.5 + 0.5));
    }
  });

  it('recomposites just a rectangle into an existing buffer', () => {
    const stack = [layer(noise(32 * 32 * 4, 3)), layer(noise(32 * 32 * 4, 4), { blend: 'overlay', opacity: 0.8 }), layer(noise(32 * 32 * 4, 5), { blend: 'screen' })];
    const full = compositeLayers(32, 32, stack);
    const out = solid(32, 32, [1, 2, 3, 4]);
    const rect = { x: 5, y: 7, width: 11, height: 3 };
    expect(compositeLayers(32, 32, stack, out, rect)).toBe(out);
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        const inside = x >= 5 && x < 16 && y >= 7 && y < 10;
        expect(pixel(out, 32, x, y)).toEqual(inside ? pixel(full, 32, x, y) : [1, 2, 3, 4]);
      }
    }
  });

  it('composites a large texture with 4 layers quickly', () => {
    // 2048 x 2048 here, to go easy on the machine; 4096 x 4096 takes four times as long (measured: about 0.3 s).
    const size = 2048;
    // An opaque base, two mostly transparent paint layers with a translucent band, one opaque-banded overlay layer.
    const base = solid(size, size, [120, 130, 140, 255]);
    const band = (rgba: readonly number[], from: number, to: number) => {
      const pixels = new Uint8ClampedArray(size * size * 4);
      for (let i = from * size * 4; i < to * size * 4; i++) pixels[i] = rgba[i % 4];
      return pixels;
    };
    const stack = [
      layer(base),
      layer(band([255, 0, 0, 128], 250, 750)),
      layer(band([0, 255, 0, 200], 500, 1250), { blend: 'multiply', opacity: 0.7 }),
      layer(band([0, 0, 255, 255], 1000, 1500), { blend: 'overlay' }),
    ];
    compositeLayers(64, 64, stack); // warm up
    const start = performance.now();
    const out = compositeLayers(size, size, stack);
    const elapsed = performance.now() - start;
    // About 80 ms on its own; the bound is loose because the test files run in parallel.
    expect(elapsed).toBeLessThan(2000);
    expect(pixel(out, size, 0, 0)).toEqual([120, 130, 140, 255]);
    expect(pixel(out, size, 0, 350)).toEqual([188, 65, 70, 255]);
  });
});

describe('mergeDown', () => {
  it('equals the composite of the two layers', () => {
    const lower = noise(24 * 24 * 4, 11);
    const upper = noise(24 * 24 * 4, 12);
    for (const mode of blendModes) {
      const top = { pixels: upper, opacity: 0.7, blend: mode };
      const merged = mergeDown(24, 24, lower, top);
      expect(merged, mode).toEqual(compositeLayers(24, 24, [layer(lower), layer(upper, top)]));
      // In a stack the merged layer stands in for the two.
      expect(compositeLayers(24, 24, [layer(merged)]), mode).toEqual(compositeLayers(24, 24, [layer(lower), layer(upper, top)]));
    }
  });
});

describe('normalFromHeight', () => {
  /** A grey height image from a function of pixel position. */
  const heightImage = (width: number, height: number, value: (x: number, y: number) => number): Rgba => {
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) pixels.set([value(x, y), value(x, y), value(x, y), 255], (y * width + x) * 4);
    }
    return pixels;
  };

  it('turns a flat image into exactly (128, 128, 255)', () => {
    for (const grey of [0, 77, 255]) {
      const normals = normalFromHeight(solid(8, 8, [grey, grey, grey, 255]), 8, 8, 5, false);
      expect(normals).toEqual(solid(8, 8, [128, 128, 255, 255]));
    }
    expect(normalFromHeight(solid(4, 4, [10, 200, 30, 0]), 4, 4, 2, true)).toEqual(solid(4, 4, [128, 128, 255, 255]));
  });

  it('tilts the normal against the slope of a ramp', () => {
    // Height rises by 4/255 per pixel to the right: Sobel sum 8 * 4/255, times strength 2 → slope 0.251.
    // normalize(-0.251, 0, 1) = (-0.2434, 0, 0.9699) → (96, 128, 251)
    const right = normalFromHeight(
      heightImage(64, 16, (x) => x * 4),
      64,
      16,
      2,
      false,
    );
    for (let x = 1; x < 63; x++) expect(pixel(right, 64, x, 8)).toEqual([96, 128, 251, 255]);
    // Rising towards the TOP of the image (+v): green goes down, red stays.
    const up = normalFromHeight(
      heightImage(16, 64, (_, y) => (63 - y) * 4),
      16,
      64,
      2,
      false,
    );
    for (let y = 1; y < 63; y++) expect(pixel(up, 16, 8, y)).toEqual([128, 96, 251, 255]);
    // Rising towards the bottom (-v): green goes up.
    const down = normalFromHeight(
      heightImage(16, 64, (_, y) => y * 4),
      16,
      64,
      2,
      false,
    );
    expect(pixel(down, 16, 8, 30)).toEqual([128, 159, 251, 255]);
    // Inverting the height or the direction flips the tilt; more strength tilts further; none gives flat.
    const args = [heightImage(64, 16, (x) => x * 4), 64, 16] as const;
    expect(pixel(normalFromHeight(...args, 2, true), 64, 30, 8)).toEqual([159, 128, 251, 255]);
    expect(pixel(normalFromHeight(...args, 8, false), 64, 30, 8)[0]).toBeLessThan(60);
    expect(pixel(normalFromHeight(...args, 0, false), 64, 30, 8)).toEqual([128, 128, 255, 255]);
  });

  it('makes the normals of a cone point away from its tip', () => {
    const cone = heightImage(65, 65, (x, y) => Math.max(0, 255 - Math.hypot(x - 32, y - 32) * 8));
    const normals = normalFromHeight(cone, 65, 65, 2, false);
    const at = (x: number, y: number) => pixel(normals, 65, x, y);
    expect(at(32, 32)).toEqual([128, 128, 255, 255]); // the tip itself is symmetric
    expect(at(48, 32)[0]).toBeGreaterThan(150); // right of the tip: +u
    expect(at(48, 32)[1]).toBe(128);
    expect(at(16, 32)[0]).toBeLessThan(106); // left: -u
    expect(at(32, 16)[1]).toBeGreaterThan(150); // above the tip in the image: +v
    expect(at(32, 16)[0]).toBe(128);
    expect(at(32, 48)[1]).toBeLessThan(106); // below: -v
    expect(at(48, 32)[0] + at(16, 32)[0]).toBe(255); // mirror images around 127.5
    expect(at(2, 2)).toEqual([128, 128, 255, 255]); // the flat ground
    // Every normal has unit length within rounding and points out of the surface.
    for (let i = 0; i < normals.length; i += 4) {
      const n = [0, 1, 2].map((c) => (normals[i + c] / 255) * 2 - 1);
      expect(Math.hypot(...n)).toBeCloseTo(1, 1);
      expect(normals[i + 2]).toBeGreaterThan(128);
      expect(normals[i + 3]).toBe(255);
    }
  });

  it('wraps around at the borders', () => {
    // A bright first column: the last column sees it as its right neighbour, the second as its left.
    const image = heightImage(8, 8, (x) => (x === 0 ? 255 : 0));
    const normals = normalFromHeight(image, 8, 8, 2, false);
    expect(pixel(normals, 8, 7, 4)[0]).toBeLessThan(40);
    expect(pixel(normals, 8, 1, 4)[0]).toBeGreaterThan(215);
    expect(pixel(normals, 8, 4, 4)).toEqual([128, 128, 255, 255]);
    // Same for rows: a bright top row tilts the bottom row towards -v ... which is "up the slope" across the border.
    const rows = normalFromHeight(
      heightImage(8, 8, (_, y) => (y === 0 ? 255 : 0)),
      8,
      8,
      2,
      false,
    );
    expect(pixel(rows, 8, 4, 7)[1]).toBeGreaterThan(215); // the height rises downwards (-v) across the border
    expect(pixel(rows, 8, 4, 1)[1]).toBeLessThan(40);
  });
});

describe('StrokePreview', () => {
  const size = 48;
  const stack = () => [
    layer(noise(size * size * 4, 21)),
    layer(noise(size * size * 4, 22), { blend: 'multiply', opacity: 0.9 }),
    layer(noise(size * size * 4, 23), { blend: 'screen', opacity: 0.6 }),
  ];
  const stroke = brush({ color: '#e0a020', size: 7, hardness: 0.5, opacity: 0.8 });
  const points = [
    [0.1, 0.1, 0.5],
    [0.4, 0.7, 1],
    [0.8, 0.6, 0.8],
    [0.9, 0.2, 0.3],
  ];

  it('equals the committed stroke pixel for pixel, however the points arrive', () => {
    const layers = stack();
    const painted = paintStroke(layers[1].pixels, size, size, stroke, points);
    const expected = compositeLayers(size, size, [layers[0], { ...layers[1], pixels: painted }, layers[2]]);

    const preview = new StrokePreview(size, size, layers, 1, stroke);
    expect(preview.pixels).toEqual(compositeLayers(size, size, layers));
    for (const point of points) preview.extend([point]);
    expect(preview.layer).toEqual(painted);
    expect(preview.pixels).toEqual(expected);
    expect(preview.points).toEqual(points);
    // The decoded layers it was given are untouched.
    expect(layers[1].pixels).toEqual(noise(size * size * 4, 22));

    const withComposite = new StrokePreview(size, size, layers, 1, stroke, compositeLayers(size, size, layers));
    withComposite.extend(points.slice(0, 2));
    withComposite.extend(points.slice(2));
    expect(withComposite.pixels).toEqual(expected);
  });

  it('reports the changed rectangle and changes nothing outside it', () => {
    const layers = stack();
    const preview = new StrokePreview(size, size, layers, 2, brush({ size: 6, erase: true }));
    const before = new Uint8ClampedArray(preview.pixels);
    const rect = preview.extend([[0.5, 0.5]])!;
    expect(rect).toEqual({ x: 21, y: 21, width: 6, height: 6 });
    let changed = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const same = pixel(preview.pixels, size, x, y).join() === pixel(before, size, x, y).join();
        const inside = x >= 21 && x < 27 && y >= 21 && y < 27;
        if (!inside) expect(same).toBe(true);
        else if (!same) changed++;
      }
    }
    expect(changed).toBeGreaterThan(20);
    expect(preview.layer[(24 * size + 24) * 4 + 3]).toBe(0);
  });

  it('breaks a stroke into polylines and still equals the committed stroke', () => {
    const layers = stack();
    const breaks = [2, 3];
    const painted = paintStroke(layers[1].pixels, size, size, stroke, points, breaks);
    const expected = compositeLayers(size, size, [layers[0], { ...layers[1], pixels: painted }, layers[2]]);
    expect(painted).not.toEqual(paintStroke(layers[1].pixels, size, size, stroke, points));

    const preview = new StrokePreview(size, size, layers, 1, stroke);
    preview.breakStroke(); // before the first point: nothing to break
    preview.extend(points.slice(0, 1));
    preview.extend(points.slice(1, 2));
    preview.breakStroke();
    preview.breakStroke(); // twice in a row is one break
    expect(preview.extend([])).toBeNull();
    expect(preview.breaks).toEqual([]); // a break counts once a point follows it
    preview.extend(points.slice(2, 3));
    preview.breakStroke();
    preview.extend(points.slice(3));
    preview.breakStroke(); // at the end: never becomes a break
    expect(preview.points).toEqual(points);
    expect(preview.breaks).toEqual(breaks);
    expect(preview.layer).toEqual(painted);
    expect(preview.pixels).toEqual(expected);
  });

  it('paints a hidden layer without changing the look', () => {
    const layers = [stack()[0], { ...stack()[1], visible: false }];
    const preview = new StrokePreview(size, size, layers, 1, stroke);
    expect(preview.extend(points)).not.toBeNull();
    expect(preview.pixels).toEqual(layers[0].pixels);
    expect(preview.layer).toEqual(paintStroke(layers[1].pixels, size, size, stroke, points));
  });
});
