import { describe, expect, it } from 'vitest';
import type { PixelOp, PixelPaint } from '../../core/pixelOps';
import { toBase64 } from '../../io/bytes';
import { applyPixelOp } from './index';

const paint = (over: Partial<PixelPaint> = {}): PixelPaint => ({ color: '#ff0000', opacity: 1, blend: 'default', lockAlpha: false, erase: false, ...over });
const blank = (w: number, h: number): Uint8ClampedArray => new Uint8ClampedArray(w * h * 4);

function image(rows: string[], colors: Record<string, [number, number, number, number]>): Uint8ClampedArray {
  const h = rows.length;
  const w = rows[0].length;
  const px = new Uint8ClampedArray(w * h * 4);
  rows.forEach((row, y) => [...row].forEach((ch, x) => px.set(colors[ch] ?? [0, 0, 0, 0], (y * w + x) * 4)));
  return px;
}

/** One character per pixel: '.' transparent, R/G/B/W by exact colour, '?' otherwise. */
function draw(px: Uint8ClampedArray, w: number): string {
  const names: Record<string, string> = { '255,0,0,255': 'R', '0,255,0,255': 'G', '0,0,255,255': 'B', '255,255,255,255': 'W', '0,0,0,0': '.' };
  const rows: string[] = [];
  for (let y = 0; y < px.length / 4 / w; y++) {
    let row = '';
    for (let x = 0; x < w; x++) row += names[Array.from(px.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)).join(',')] ?? '?';
    rows.push(row);
  }
  return rows.join('\n');
}

const RGBW = { R: [255, 0, 0, 255], G: [0, 255, 0, 255], B: [0, 0, 255, 255], W: [255, 255, 255, 255] } as Record<string, [number, number, number, number]>;

describe('applyPixelOp: general contract', () => {
  it('never mutates the input and reports the changed rectangle', () => {
    const layer = blank(6, 6);
    const before = layer.slice();
    const op: PixelOp = { op: 'stroke', points: [[1, 2], [3, 2]], brush: { size: 1, shape: 'square' }, pixelPerfect: false, paint: paint() };
    const { pixels, changed } = applyPixelOp(layer, 6, 6, op);
    expect(layer).toEqual(before);
    expect(pixels).not.toBe(layer);
    expect(changed).toEqual({ x: 1, y: 2, width: 3, height: 1 });
  });
  it('changed is null when nothing differs', () => {
    const layer = image(['RR'], RGBW);
    const op: PixelOp = { op: 'fill', mode: 'all', paint: paint() };
    const { pixels, changed } = applyPixelOp(layer, 2, 1, op);
    expect(changed).toBeNull();
    expect(pixels).toEqual(layer);
  });
  it('only counts pixels whose bytes differ', () => {
    const layer = image(['R.R'], RGBW);
    const { changed } = applyPixelOp(layer, 3, 1, { op: 'fill', mode: 'all', paint: paint() });
    expect(changed).toEqual({ x: 1, y: 0, width: 1, height: 1 });
  });
  it('rejects a layer of the wrong size', () => {
    expect(() => applyPixelOp(new Uint8ClampedArray(7), 2, 2, { op: 'clear' })).toThrow(/bytes/);
  });
});

describe('stroke', () => {
  const base = { op: 'stroke', brush: { size: 1, shape: 'square' }, pixelPerfect: false } as const;
  it('paints once per pixel: opacity does not build up along an overlapping stroke', () => {
    const { pixels } = applyPixelOp(blank(4, 1), 4, 1, { ...base, points: [[0, 0], [3, 0], [0, 0]], paint: paint({ opacity: 0.5 }) });
    expect(Array.from(pixels.subarray(0, 4))).toEqual([255, 0, 0, 128]);
  });
  it('honours mirror and the selection limits the mirrored coverage too', () => {
    const op: PixelOp = {
      ...base,
      points: [[0, 0]],
      paint: paint(),
      mirror: [{ from: { x: 0, y: 0, width: 4, height: 1 }, to: { x: 0, y: 0, width: 4, height: 1 }, flipX: true, flipY: false, swap: false }],
    };
    expect(draw(applyPixelOp(blank(4, 1), 4, 1, op).pixels, 4)).toBe('R..R');
    const limited = { ...op, selection: [{ shape: 'rect', x: 0, y: 0, width: 2, height: 1 }] } as PixelOp;
    expect(draw(applyPixelOp(blank(4, 1), 4, 1, limited).pixels, 4)).toBe('R...');
  });
  it('erase and lockAlpha', () => {
    const layer = image(['RR.'], RGBW);
    const erased = applyPixelOp(layer, 3, 1, { ...base, points: [[0, 0]], paint: paint({ erase: true }) });
    expect(Array.from(erased.pixels.subarray(0, 4))).toEqual([255, 0, 0, 0]);
    const locked = applyPixelOp(layer, 3, 1, { ...base, points: [[1, 0], [2, 0]], paint: paint({ color: '#0000ff', lockAlpha: true }) });
    expect(draw(locked.pixels, 3)).toBe('RB.');
  });
  it('the selection is computed from the original pixels (wand)', () => {
    const layer = image(['RRB'], RGBW);
    const op: PixelOp = {
      ...base,
      points: [[0, 0], [2, 0]],
      paint: paint({ color: '#00ff00' }),
      selection: [{ shape: 'wand', x: 0, y: 0, tolerance: 0 }],
    };
    expect(draw(applyPixelOp(layer, 3, 1, op).pixels, 3)).toBe('GGB');
  });
  it('rejects bad brushes', () => {
    expect(() => applyPixelOp(blank(2, 2), 2, 2, { ...base, points: [[0, 0]], brush: { size: 0, shape: 'square' }, paint: paint() })).toThrow(/brush size/);
  });
});

describe('fill', () => {
  const layer = image(['RRB', 'RBB', 'GGR'], RGBW);
  const fill = (extra: Partial<Extract<PixelOp, { op: 'fill' }>>): string =>
    draw(applyPixelOp(layer, 3, 3, { op: 'fill', mode: 'all', paint: paint({ color: '#ffffff' }), ...extra }).pixels, 3);
  it('connected', () => {
    expect(fill({ mode: 'connected', x: 0, y: 0 })).toBe('WWB\nWBB\nGGR');
    expect(fill({ mode: 'connected', x: 2, y: 2 })).toBe('RRB\nRBB\nGGW');
    expect(fill({ mode: 'connected', x: 9, y: 9 })).toBe('RRB\nRBB\nGGR');
  });
  it('same_color reaches disconnected pixels', () => {
    expect(fill({ mode: 'same_color', x: 0, y: 0 })).toBe('WWB\nWBB\nGGW');
  });
  it('tolerance', () => {
    const l = image(['RG'], RGBW);
    const run = (tolerance: number): string => draw(applyPixelOp(l, 2, 1, { op: 'fill', mode: 'same_color', x: 0, y: 0, tolerance, paint: paint({ color: '#ffffff' }) }).pixels, 2);
    expect(run(0.99)).toBe('WG');
    expect(run(1)).toBe('WW');
  });
  it('regions and all', () => {
    expect(fill({ mode: 'regions', regions: [{ x: 1, y: 1, width: 2, height: 1 }, { x: 0, y: 2, width: 1, height: 5 }] })).toBe('RRB\nRWW\nWGR');
    expect(fill({ mode: 'all' })).toBe('WWW\nWWW\nWWW');
  });
  it('connected needs a seed', () => {
    expect(() => fill({ mode: 'connected' })).toThrow(/needs x and y/);
  });
});

describe('shape', () => {
  const run = (shape: 'rectangle' | 'ellipse', filled: boolean, lineWidth: number, from: [number, number], to: [number, number], w = 7, h = 7): string =>
    draw(applyPixelOp(blank(w, h), w, h, { op: 'shape', shape, from, to, filled, lineWidth, paint: paint() }).pixels, w);
  it('filled and hollow rectangles, from..to in any order', () => {
    expect(run('rectangle', true, 1, [3, 2], [1, 1], 5, 4)).toBe('.....\n.RRR.\n.RRR.\n.....');
    expect(run('rectangle', false, 1, [0, 0], [4, 4], 5, 5)).toBe('RRRRR\nR...R\nR...R\nR...R\nRRRRR');
    expect(run('rectangle', false, 2, [0, 0], [5, 5], 6, 6)).toBe('RRRRRR\nRRRRRR\nRR..RR\nRR..RR\nRRRRRR\nRRRRRR');
    expect(run('rectangle', false, 5, [0, 0], [3, 3], 4, 4)).toBe('RRRR\nRRRR\nRRRR\nRRRR');
  });
  it('filled ellipse on pixel centres and a hollow one', () => {
    expect(run('ellipse', true, 1, [0, 0], [4, 4], 5, 5)).toBe('.RRR.\nRRRRR\nRRRRR\nRRRRR\n.RRR.');
    expect(run('ellipse', false, 1, [0, 0], [4, 4], 5, 5)).toBe('.RRR.\nR...R\nR...R\nR...R\n.RRR.');
  });
  it('a single pixel and clipping at the image edge', () => {
    expect(run('rectangle', true, 1, [1, 1], [1, 1], 3, 3)).toBe('...\n.R.\n...');
    expect(run('rectangle', false, 1, [-2, -2], [1, 1], 3, 3)).toBe('.R.\nRR.\n...');
  });
  it('refuses a bad line width', () => {
    expect(() => run('rectangle', false, 0, [0, 0], [2, 2])).toThrow(/line width/);
  });
});

describe('gradient', () => {
  const grad = (from: [number, number], to: [number, number], w = 5, h = 1, extra: Partial<Extract<PixelOp, { op: 'gradient' }>> = {}) =>
    applyPixelOp(blank(w, h), w, h, { op: 'gradient', from, to, colors: ['#000000', '#ff8000'], paint: { opacity: 1, blend: 'default', lockAlpha: false }, ...extra }).pixels;
  it('hits the end colours at from and to and is clamped beyond', () => {
    const px = grad([1, 0], [3, 0]);
    expect(Array.from(px.subarray(0, 4))).toEqual([0, 0, 0, 255]); // before from: clamped to the start
    expect(Array.from(px.subarray(4, 8))).toEqual([0, 0, 0, 255]);
    expect(Array.from(px.subarray(8, 12))).toEqual([128, 64, 0, 255]); // t = 0.5
    expect(Array.from(px.subarray(12, 16))).toEqual([255, 128, 0, 255]);
    expect(Array.from(px.subarray(16, 20))).toEqual([255, 128, 0, 255]);
  });
  it('from == to gives the first colour; the projection works in 2D', () => {
    expect(Array.from(grad([2, 0], [2, 0]).subarray(0, 4))).toEqual([0, 0, 0, 255]);
    const px = grad([0, 0], [0, 2], 2, 3);
    expect(Array.from(px.subarray(0, 4))).toEqual([0, 0, 0, 255]);
    expect(Array.from(px.subarray(4 * 2, 4 * 2 + 4))).toEqual([128, 64, 0, 255]); // (0, 1)
    expect(Array.from(px.subarray(4 * 5, 4 * 5 + 4))).toEqual([255, 128, 0, 255]); // (1, 2)
    expect(Array.from(px.subarray(4 * 1, 4 * 1 + 4))).toEqual([0, 0, 0, 255]); // (1, 0) same t as (0, 0)
  });
  it('respects opacity and the selection', () => {
    const half = applyPixelOp(blank(2, 1), 2, 1, { op: 'gradient', from: [0, 0], to: [1, 0], colors: ['#ffffff', '#ffffff'], paint: { opacity: 0.5, blend: 'default', lockAlpha: false }, selection: [{ shape: 'rect', x: 1, y: 0, width: 1, height: 1 }] }).pixels;
    expect(Array.from(half)).toEqual([0, 0, 0, 0, 255, 255, 255, 128]);
  });
});

describe('move', () => {
  const layer = image(['RR..', 'GG..', '....'], RGBW);
  const sel = [{ shape: 'rect', x: 0, y: 0, width: 2, height: 2 }] as const;
  it('moves, leaving transparency behind', () => {
    const { pixels } = applyPixelOp(layer, 4, 3, { op: 'move', selection: sel, dx: 1, dy: 1, copy: false });
    expect(draw(pixels, 4)).toBe('....\n.RR.\n.GG.');
  });
  it('copy keeps the source and replaces the destination', () => {
    const { pixels } = applyPixelOp(layer, 4, 3, { op: 'move', selection: sel, dx: 1, dy: 0, copy: true });
    expect(draw(pixels, 4)).toBe('RRR.\nGGG.\n....');
  });
  it('is clipped at the image edge and uses the original pixels for overlap', () => {
    const { pixels } = applyPixelOp(layer, 4, 3, { op: 'move', selection: sel, dx: 3, dy: 0, copy: false });
    expect(draw(pixels, 4)).toBe('...R\n...G\n....');
    expect(applyPixelOp(layer, 4, 3, { op: 'move', selection: sel, dx: 0, dy: 0, copy: false }).changed).toBeNull();
  });
  it('blends semi-transparent pixels source-over', () => {
    const l = new Uint8ClampedArray([255, 0, 0, 128, 0, 0, 255, 255]);
    const { pixels } = applyPixelOp(l, 2, 1, { op: 'move', selection: [{ shape: 'rect', x: 0, y: 0, width: 1, height: 1 }], dx: 1, dy: 0, copy: true });
    expect(Array.from(pixels.subarray(4))).toEqual([128, 0, 127, 255]);
  });
});

describe('copy_brush', () => {
  const layer = image(['RGB.', '....', '....', '....'], RGBW);
  const brush = { size: 1, shape: 'square' } as const;
  const op = (extra: Partial<Extract<PixelOp, { op: 'copy_brush' }>>): PixelOp => ({
    op: 'copy_brush', mode: 'copy', points: [[0, 2], [2, 2]], brush, paint: { opacity: 1, blend: 'default', lockAlpha: false }, ...extra,
  });
  it('copy reads from the original at +offset; outside sources are skipped', () => {
    expect(draw(applyPixelOp(layer, 4, 4, op({ offset: [0, -2] })).pixels, 4)).toBe('RGB.\n....\nRGB.\n....');
    expect(draw(applyPixelOp(layer, 4, 4, op({ offset: [1, -2] })).pixels, 4)).toBe('RGB.\n....\nGB..\n....');
  });
  it('copy sees the layer as it was before the stroke', () => {
    const l = image(['RG..'], RGBW);
    expect(draw(applyPixelOp(l, 4, 1, op({ points: [[1, 0], [3, 0]], offset: [-1, 0] })).pixels, 4)).toBe('RRG.');
  });
  it('pattern tiles the source rectangle aligned to its corner', () => {
    const l = image(['RG..', '....', '....'], RGBW);
    const { pixels } = applyPixelOp(l, 4, 3, { ...op({ mode: 'pattern', source: { x: 0, y: 0, width: 2, height: 1 }, points: [[0, 2], [3, 2]] }) } as PixelOp);
    expect(draw(pixels, 4)).toBe('RG..\n....\nRGRG');
  });
  it('sample stamps the source centred on every stroke pixel, later stamps win', () => {
    const l = image(['RGB.', '....', '....', '....'], RGBW);
    const { pixels } = applyPixelOp(l, 4, 4, op({ mode: 'sample', source: { x: 0, y: 0, width: 3, height: 1 }, points: [[1, 2], [2, 2]] }));
    // stamp at (1,2): R at x0, G at x1, B at x2; stamp at (2,2): R at x1, G at x2, B at x3
    expect(draw(pixels, 4)).toBe('RGB.\n....\nRRGB\n....');
  });
  it('applies paint opacity to the source alpha and needs its parameters', () => {
    const { pixels } = applyPixelOp(layer, 4, 4, op({ offset: [0, -2], points: [[0, 2]], paint: { opacity: 0.5, blend: 'default', lockAlpha: false } }));
    expect(Array.from(pixels.subarray(4 * 8, 4 * 8 + 4))).toEqual([255, 0, 0, 128]);
    expect(() => applyPixelOp(layer, 4, 4, op({}))).toThrow(/offset/);
    expect(() => applyPixelOp(layer, 4, 4, op({ mode: 'pattern' }))).toThrow(/source/);
  });
});

describe('adjust, clear, set', () => {
  it('adjust honours the selection', () => {
    const layer = image(['RR'], RGBW);
    const { pixels } = applyPixelOp(layer, 2, 1, { op: 'adjust', adjust: { type: 'invert' }, selection: [{ shape: 'rect', x: 1, y: 0, width: 1, height: 1 }] });
    expect(Array.from(pixels)).toEqual([255, 0, 0, 255, 0, 255, 255, 255]);
  });
  it('clear: everything, selection, keep', () => {
    const layer = image(['RRR', 'RRR'], RGBW);
    expect(draw(applyPixelOp(layer, 3, 2, { op: 'clear' }).pixels, 3)).toBe('...\n...');
    expect(draw(applyPixelOp(layer, 3, 2, { op: 'clear', selection: [{ shape: 'rect', x: 0, y: 0, width: 1, height: 2 }] }).pixels, 3)).toBe('.RR\n.RR');
    expect(draw(applyPixelOp(layer, 3, 2, { op: 'clear', keep: [{ x: 1, y: 0, width: 1, height: 1 }, { x: 2, y: 1, width: 5, height: 5 }] }).pixels, 3)).toBe('.R.\n..R');
  });
  it('set replaces a rectangle, clipped, and validates the data length', () => {
    const rgba = (n: number, c: number[]): string => toBase64(Uint8Array.from({ length: n * 4 }, (_, i) => c[i % 4]));
    const { pixels, changed } = applyPixelOp(blank(3, 2), 3, 2, { op: 'set', rect: { x: 2, y: 1, width: 2, height: 2 }, rgba: rgba(4, [0, 255, 0, 255]) });
    expect(draw(pixels, 3)).toBe('...\n..G');
    expect(changed).toEqual({ x: 2, y: 1, width: 1, height: 1 });
    expect(() => applyPixelOp(blank(3, 2), 3, 2, { op: 'set', rect: { x: 0, y: 0, width: 2, height: 2 }, rgba: rgba(3, [0, 0, 0, 0]) })).toThrow(/expected 16/);
    const off = applyPixelOp(blank(3, 2), 3, 2, { op: 'set', rect: { x: -1, y: 0, width: 2, height: 1 }, rgba: toBase64(Uint8Array.from([255, 0, 0, 255, 0, 0, 255, 255])) });
    expect(draw(off.pixels, 3)).toBe('B..\n...');
  });
});

describe('performance', () => {
  it('handles a large stroke and fill on 512x512 quickly', () => {
    const layer = blank(512, 512);
    const t0 = Date.now();
    const { pixels } = applyPixelOp(layer, 512, 512, { op: 'stroke', points: [[0, 0], [511, 511], [0, 511]], brush: { size: 32, shape: 'round' }, pixelPerfect: false, paint: paint() });
    applyPixelOp(pixels, 512, 512, { op: 'fill', mode: 'connected', x: 5, y: 500, paint: paint({ color: '#00ff00' }) });
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
