import { describe, expect, it } from 'vitest';
import type { MirrorMap, SelectionShape } from '../../core/pixelOps';
import { brushFootprint, decodeMaskBits, encodeMaskBits, maskToShape, selectionMask, strokeCoverage } from './index';
import { applyMirror, strokeLinePixels } from './raster';

function show(mask: Uint8Array, w: number): string {
  const rows: string[] = [];
  for (let y = 0; y < mask.length / w; y++) rows.push(Array.from(mask.subarray(y * w, (y + 1) * w), (v) => (v ? '#' : '.')).join(''));
  return rows.join('\n');
}

describe('brushFootprint', () => {
  const grid = (size: number, shape: 'square' | 'round'): string => {
    const fp = brushFootprint({ size, shape });
    const cells = new Set(fp.map(([x, y]) => `${x},${y}`));
    const lo = -Math.floor((size - 1) / 2);
    const rows: string[] = [];
    for (let y = lo; y < lo + size; y++) {
      let row = '';
      for (let x = lo; x < lo + size; x++) row += cells.has(`${x},${y}`) ? '#' : '.';
      rows.push(row);
    }
    return rows.join('\n');
  };

  it('square sizes are centred for odd sizes and extend right/down for even', () => {
    expect(brushFootprint({ size: 1, shape: 'square' })).toEqual([[0, 0]]);
    const three = brushFootprint({ size: 3, shape: 'square' });
    expect(three).toHaveLength(9);
    expect(three[0]).toEqual([-1, -1]);
    const two = brushFootprint({ size: 2, shape: 'square' });
    expect(two.map(([x, y]) => `${x},${y}`).sort()).toEqual(['0,0', '0,1', '1,0', '1,1']);
  });
  it('round sizes 1 and 2 are full squares, bigger ones are symmetric discs', () => {
    expect(brushFootprint({ size: 2, shape: 'round' })).toHaveLength(4);
    expect(grid(4, 'round')).toBe('.##.\n####\n####\n.##.');
    expect(grid(5, 'round')).toBe('.###.\n#####\n#####\n#####\n.###.');
    expect(grid(7, 'round').split('\n')[0]).toBe('..###..');
    expect(grid(4, 'round')).not.toBe(grid(4, 'square'));
  });
  it('rejects bad sizes', () => {
    expect(() => brushFootprint({ size: 0, shape: 'square' })).toThrow(/brush size/);
    expect(() => brushFootprint({ size: 1.5, shape: 'square' })).toThrow();
    expect(() => brushFootprint({ size: 257, shape: 'round' })).toThrow();
  });
});

describe('strokeCoverage', () => {
  it('a single point is a dot, clipped to the image', () => {
    expect(show(strokeCoverage([[1, 1]], [], { size: 1, shape: 'square' }, false, 3, 3), 3)).toBe('...\n.#.\n...');
    expect(show(strokeCoverage([[0, 0]], [], { size: 3, shape: 'square' }, false, 3, 3), 3)).toBe('##.\n##.\n...');
  });
  it('draws Bresenham lines', () => {
    expect(show(strokeCoverage([[0, 0], [4, 2]], [], { size: 1, shape: 'square' }, false, 5, 3), 5)).toBe('#....\n.##..\n...##');
  });
  it('line pixels of a diagonal and a shallow slope', () => {
    expect(strokeLinePixels([[0, 0], [3, 3]], [], false)).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
    expect(strokeLinePixels([[0, 0], [4, 1]], [], false)).toEqual([0, 0, 1, 0, 2, 1, 3, 1, 4, 1]);
    expect(strokeLinePixels([[3, 3], [0, 0]], [], false)).toEqual([3, 3, 2, 2, 1, 1, 0, 0]);
  });
  it('splits polylines at breaks', () => {
    const cov = strokeCoverage([[0, 0], [0, 0], [4, 0]], [1], { size: 1, shape: 'square' }, false, 5, 1);
    expect(show(cov, 5)).toBe('#####');
    const split = strokeCoverage([[0, 0], [1, 0], [3, 0], [4, 0]], [2], { size: 1, shape: 'square' }, false, 5, 1);
    expect(show(split, 5)).toBe('##.##');
  });
  it('covers each pixel once (a set) for larger brushes', () => {
    const cov = strokeCoverage([[2, 2], [3, 2]], [], { size: 3, shape: 'square' }, false, 6, 5);
    expect(show(cov, 6)).toBe('......\n.####.\n.####.\n.####.\n......');
  });
  it('pixel perfect removes L corners', () => {
    // a staircase drawn as 'L' steps: (0,0)(1,0)(1,1)(2,1)
    const pts: [number, number][] = [[0, 0], [1, 0], [1, 1], [2, 1]];
    expect(strokeLinePixels(pts, [], true)).toEqual([0, 0, 1, 1, 2, 1]);
    expect(strokeLinePixels(pts, [], false)).toEqual([0, 0, 1, 0, 1, 1, 2, 1]);
    // a straight line is untouched
    expect(strokeLinePixels([[0, 0], [3, 0]], [], true)).toEqual([0, 0, 1, 0, 2, 0, 3, 0]);
    // consecutive repeats are dropped
    expect(strokeLinePixels([[0, 0], [0, 0], [1, 0]], [], false)).toEqual([0, 0, 1, 0]);
  });
  it('pixel perfect is only applied at size 1', () => {
    const pts: [number, number][] = [[1, 1], [2, 1], [2, 2]];
    const one = strokeCoverage(pts, [], { size: 1, shape: 'square' }, true, 4, 4);
    expect(show(one, 4)).toBe('....\n.#..\n..#.\n....');
    const two = strokeCoverage(pts, [], { size: 2, shape: 'square' }, true, 4, 4);
    expect(two[1 * 4 + 2]).toBe(1);
  });
  it('refuses absurdly long strokes', () => {
    expect(() => strokeLinePixels([[0, 0], [100_000_000, 0]], [], false)).toThrow(/too long/);
  });
});

describe('applyMirror', () => {
  const one = (w: number, h: number, x: number, y: number): Uint8Array => {
    const m = new Uint8Array(w * h);
    m[y * w + x] = 1;
    return m;
  };
  const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

  it('returns the input when there are no maps', () => {
    const m = one(4, 4, 1, 1);
    expect(applyMirror(m, 4, 4, undefined)).toBe(m);
  });
  it('flipX mirrors inside the same rect', () => {
    const map: MirrorMap = { from: rect(0, 0, 4, 4), to: rect(0, 0, 4, 4), flipX: true, flipY: false, swap: false };
    expect(show(applyMirror(one(4, 4, 0, 1), 4, 4, [map]), 4)).toBe('....\n#..#\n....\n....');
  });
  it('flipY and both flips', () => {
    const fy: MirrorMap = { from: rect(0, 0, 4, 4), to: rect(0, 0, 4, 4), flipX: false, flipY: true, swap: false };
    expect(show(applyMirror(one(4, 4, 2, 0), 4, 4, [fy]), 4)).toBe('..#.\n....\n....\n..#.');
    const both: MirrorMap = { ...fy, flipX: true };
    expect(show(applyMirror(one(4, 4, 0, 0), 4, 4, [both]), 4)).toBe('#...\n....\n....\n...#');
  });
  it('maps between different rects, scaling positions', () => {
    const map: MirrorMap = { from: rect(0, 0, 2, 2), to: rect(2, 0, 4, 4), flipX: false, flipY: false, swap: false };
    // (1, 0) is at relative (0.75, 0.25) -> (2 + 3, 1)
    expect(show(applyMirror(one(6, 4, 1, 0), 6, 4, [map]), 6)).toBe('.#....\n.....#\n......\n......');
  });
  it('swap exchanges the relative coordinates after the flips', () => {
    const map: MirrorMap = { from: rect(0, 0, 4, 4), to: rect(4, 0, 4, 4), flipX: false, flipY: false, swap: true };
    // (1, 0) -> rx .375 ry .125 -> swap -> rx .125, ry .375 -> (4 + 0, 1)
    const out = applyMirror(one(8, 4, 1, 0), 8, 4, [map]);
    expect(out[1 * 8 + 4]).toBe(1);
    const flipped: MirrorMap = { ...map, flipX: true };
    // flipX first: rx = .625, ry = .125 -> swap -> rx .125, ry .625 -> (4, 2)
    expect(applyMirror(one(8, 4, 1, 0), 8, 4, [flipped])[2 * 8 + 4]).toBe(1);
  });
  it('only mirrors pixels whose centre is inside from, and does not chain maps', () => {
    const a: MirrorMap = { from: rect(0, 0, 2, 4), to: rect(2, 0, 2, 4), flipX: false, flipY: false, swap: false };
    const b: MirrorMap = { from: rect(2, 0, 2, 4), to: rect(4, 0, 2, 4), flipX: false, flipY: false, swap: false };
    const out = applyMirror(one(6, 4, 0, 0), 6, 4, [a, b]);
    expect(show(out, 6).split('\n')[0]).toBe('#.#...');
    expect(applyMirror(one(6, 4, 5, 3), 6, 4, [a])[3 * 6 + 5]).toBe(1);
  });
});

describe('selectionMask', () => {
  const layer = new Uint8ClampedArray(5 * 5 * 4);
  const mask = (shapes: SelectionShape[]): string => show(selectionMask(layer, 5, 5, shapes), 5);

  it('rect, clipped', () => {
    expect(mask([{ shape: 'rect', x: 1, y: 1, width: 2, height: 2 }])).toBe('.....\n.##..\n.##..\n.....\n.....');
    expect(mask([{ shape: 'rect', x: 3, y: 3, width: 9, height: 9 }])).toBe('.....\n.....\n.....\n...##\n...##');
    expect(mask([])).toBe('.....\n.....\n.....\n.....\n.....');
  });
  it('ellipse tests pixel centres', () => {
    expect(mask([{ shape: 'ellipse', x: 0, y: 0, width: 5, height: 5 }])).toBe('.###.\n#####\n#####\n#####\n.###.');
    expect(mask([{ shape: 'ellipse', x: 0, y: 0, width: 4, height: 4 }])).toBe('.##..\n####.\n####.\n.##..\n.....');
  });
  it('lasso fills the polygon on pixel centres', () => {
    expect(mask([{ shape: 'lasso', points: [[0, 0], [4, 0], [4, 4]] }])).toBe('####.\n.###.\n..##.\n...#.\n.....');
    expect(mask([{ shape: 'lasso', points: [[0, 0], [1, 1]] }])).toBe('.....\n.....\n.....\n.....\n.....');
  });
  it('modes add / subtract / intersect / replace', () => {
    const a: SelectionShape = { shape: 'rect', x: 0, y: 0, width: 3, height: 1 };
    const b: SelectionShape = { shape: 'rect', x: 2, y: 0, width: 3, height: 1 };
    expect(mask([a, { ...b, mode: 'add' }]).split('\n')[0]).toBe('#####');
    expect(mask([a, { ...b, mode: 'subtract' }]).split('\n')[0]).toBe('##...');
    expect(mask([a, { ...b, mode: 'intersect' }]).split('\n')[0]).toBe('..#..');
    expect(mask([a, { ...b, mode: 'replace' }]).split('\n')[0]).toBe('..###');
    expect(mask([a, b]).split('\n')[0]).toBe('..###');
  });
  it('wand is connected, color is global, tolerance and transparency', () => {
    const px = new Uint8ClampedArray(4 * 1 * 4);
    // red, red, blue, red
    px.set([255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 250, 0, 0, 255]);
    expect(show(selectionMask(px, 4, 1, [{ shape: 'wand', x: 0, y: 0, tolerance: 0 }]), 4)).toBe('##..');
    expect(show(selectionMask(px, 4, 1, [{ shape: 'color', x: 0, y: 0, tolerance: 0 }]), 4)).toBe('##..');
    expect(show(selectionMask(px, 4, 1, [{ shape: 'color', x: 0, y: 0, tolerance: 5 / 255 }]), 4)).toBe('##.#');
    expect(show(selectionMask(px, 4, 1, [{ shape: 'color', x: 0, y: 0, tolerance: 4 / 255 }]), 4)).toBe('##..');
    expect(show(selectionMask(px, 4, 1, [{ shape: 'wand', x: 9, y: 0, tolerance: 0 }]), 4)).toBe('....');
    // transparent pixels with different rgb are equal
    const t = new Uint8ClampedArray([1, 2, 3, 0, 9, 9, 9, 0, 0, 0, 0, 255]);
    expect(show(selectionMask(t, 3, 1, [{ shape: 'wand', x: 0, y: 0, tolerance: 0 }]), 3)).toBe('##.');
  });
  it('mask shape places explicit bits', () => {
    const bits = encodeMaskBits(Uint8Array.from([1, 0, 1, 1, 1, 0]), 3, { x: 0, y: 0, width: 3, height: 2 });
    expect(mask([{ shape: 'mask', x: 1, y: 2, width: 3, height: 2, bits }])).toBe('.....\n.....\n.#.#.\n.##..\n.....');
  });
});

describe('mask bits', () => {
  it('round-trips arbitrary masks over a rect', () => {
    const w = 11;
    const h = 5;
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) mask[i] = (i * 7) % 3 === 0 ? 1 : 0;
    const rect = { x: 2, y: 1, width: 9, height: 3 };
    const decoded = decodeMaskBits(encodeMaskBits(mask, w, rect), rect.width, rect.height);
    for (let y = 0; y < rect.height; y++) for (let x = 0; x < rect.width; x++) expect(decoded[y * rect.width + x]).toBe(mask[(y + rect.y) * w + x + rect.x]);
  });
  it('uses row-aligned MSB-first bytes', () => {
    // 3 wide, 2 high: row0 = 1,0,1 -> 0b10100000 ; row1 = 0,1,1 -> 0b01100000
    const b64 = encodeMaskBits(Uint8Array.from([1, 0, 1, 0, 1, 1]), 3, { x: 0, y: 0, width: 3, height: 2 });
    expect(Array.from(Buffer.from(b64, 'base64'))).toEqual([0xa0, 0x60]);
  });
  it('rejects short data', () => {
    expect(() => decodeMaskBits('AA==', 8, 4)).toThrow(/too short/);
  });
  it('maskToShape wraps the bounding box and round-trips through selectionMask', () => {
    const w = 6;
    const mask = new Uint8Array(w * 4);
    mask[1 * w + 2] = 1;
    mask[2 * w + 4] = 1;
    mask[2 * w + 3] = 1;
    const shape = maskToShape(mask, w, 4);
    expect(shape).toMatchObject({ shape: 'mask', x: 2, y: 1, width: 3, height: 2, mode: 'replace' });
    expect(selectionMask(new Uint8ClampedArray(w * 4 * 4), w, 4, [shape!])).toEqual(mask);
    expect(maskToShape(new Uint8Array(w * 4), w, 4)).toBeNull();
  });
});
