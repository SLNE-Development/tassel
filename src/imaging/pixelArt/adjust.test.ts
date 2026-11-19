import { describe, expect, it } from 'vitest';
import type { Adjustment, TextureTransform } from '../../core/pixelOps';
import { adjustPixels, curveLut, transformPixels } from './index';

const sample = new Uint8ClampedArray([
  255, 0, 0, 255, //
  10, 200, 90, 128,
  77, 77, 77, 255,
  5, 6, 7, 0,
]);

describe('adjustPixels', () => {
  it('never mutates its input', () => {
    const before = sample.slice();
    adjustPixels(sample, 4, 1, { type: 'invert' });
    expect(sample).toEqual(before);
  });
  it('identity parameters leave pixels unchanged', () => {
    const ids: Adjustment[] = [
      { type: 'brightness_contrast', brightness: 0, contrast: 0 },
      { type: 'hue_saturation', hue: 0, saturation: 0, lightness: 0 },
      { type: 'opacity', factor: 1 },
      { type: 'curves' },
      { type: 'curves', rgb: [[0, 0], [1, 1]], a: [[0, 0], [0.5, 0.5], [1, 1]] },
    ];
    for (const a of ids) expect(adjustPixels(sample, 4, 1, a)).toEqual(sample);
  });
  it('invert flips rgb only and twice is the identity', () => {
    const once = adjustPixels(sample, 4, 1, { type: 'invert' });
    expect(Array.from(once.subarray(0, 8))).toEqual([0, 255, 255, 255, 245, 55, 165, 128]);
    expect(Array.from(once.subarray(12))).toEqual([5, 6, 7, 0]); // transparent pixels untouched
    expect(adjustPixels(once, 4, 1, { type: 'invert' })).toEqual(sample);
  });
  it('brightness shifts and contrast stretches around mid grey', () => {
    const grey = new Uint8ClampedArray([128, 128, 128, 255, 64, 64, 64, 200]);
    const bright = adjustPixels(grey, 2, 1, { type: 'brightness_contrast', brightness: 0.5, contrast: 0 });
    expect(Array.from(bright.subarray(0, 4))).toEqual([255, 255, 255, 255]);
    const darker = adjustPixels(grey, 2, 1, { type: 'brightness_contrast', brightness: -0.1, contrast: 0 });
    expect(darker[0]).toBeGreaterThanOrEqual(102);
    expect(darker[0]).toBeLessThanOrEqual(103);
    const more = adjustPixels(grey, 2, 1, { type: 'brightness_contrast', brightness: 0, contrast: 0.5 });
    expect(Math.abs(more[0] - 128)).toBeLessThanOrEqual(1); // mid grey is the fixed point
    expect(more[4]).toBe(0); // 64 -> (0.251-0.5)*2+0.5 < 0
    expect(more[7]).toBe(200); // alpha kept
    const flat = adjustPixels(grey, 2, 1, { type: 'brightness_contrast', brightness: 0, contrast: -1 });
    expect(flat[0]).toBe(128);
    expect(flat[4]).toBe(128);
  });
  it('hue rotates, saturation and lightness scale, greys stay grey', () => {
    const px = new Uint8ClampedArray([255, 0, 0, 255, 100, 100, 100, 255]);
    const hue = adjustPixels(px, 2, 1, { type: 'hue_saturation', hue: 120, saturation: 0, lightness: 0 });
    expect(Array.from(hue.subarray(0, 4))).toEqual([0, 255, 0, 255]);
    expect(Array.from(hue.subarray(4, 8))).toEqual([100, 100, 100, 255]);
    const desat = adjustPixels(px, 2, 1, { type: 'hue_saturation', hue: 0, saturation: -1, lightness: 0 });
    expect(Array.from(desat.subarray(0, 4))).toEqual([128, 128, 128, 255]);
    const white = adjustPixels(px, 2, 1, { type: 'hue_saturation', hue: 0, saturation: 0, lightness: 1 });
    expect(Array.from(white.subarray(0, 3))).toEqual([255, 255, 255]);
    const black = adjustPixels(px, 2, 1, { type: 'hue_saturation', hue: 0, saturation: 0, lightness: -1 });
    expect(Array.from(black.subarray(0, 3))).toEqual([0, 0, 0]);
    const sat = adjustPixels(new Uint8ClampedArray([150, 100, 100, 255]), 1, 1, { type: 'hue_saturation', hue: 0, saturation: 1, lightness: 0 });
    expect(sat[0]).toBeGreaterThan(150);
    expect(sat[1]).toBeLessThan(100);
  });
  it('opacity multiplies alpha, and zero clears the pixel', () => {
    const half = adjustPixels(sample, 4, 1, { type: 'opacity', factor: 0.5 });
    expect(half[3]).toBe(128);
    expect(half[7]).toBe(64);
    const more = adjustPixels(sample, 4, 1, { type: 'opacity', factor: 4 });
    expect(more[7]).toBe(255);
    expect(more[15]).toBe(0);
    const none = adjustPixels(sample, 4, 1, { type: 'opacity', factor: 0 });
    expect(Array.from(none.subarray(0, 4))).toEqual([0, 0, 0, 0]);
  });
  it('curves: rgb then channel, alpha, and inversion', () => {
    const invert = adjustPixels(sample, 4, 1, { type: 'curves', rgb: [[0, 1], [1, 0]] });
    expect(Array.from(invert.subarray(0, 4))).toEqual([0, 255, 255, 255]);
    const red = adjustPixels(sample, 4, 1, { type: 'curves', r: [[0, 0], [1, 0]] });
    expect(Array.from(red.subarray(0, 4))).toEqual([0, 0, 0, 255]);
    const alpha = adjustPixels(sample, 4, 1, { type: 'curves', a: [[0, 1], [1, 1]] });
    expect(alpha[3]).toBe(255);
    expect(alpha[15]).toBe(255);
  });
  it('limit_palette snaps to the nearest colour and keeps alpha', () => {
    const out = adjustPixels(sample, 4, 1, { type: 'limit_palette', colors: ['#000000', '#ff0000', '#ffffff'] });
    expect(Array.from(out.subarray(0, 4))).toEqual([255, 0, 0, 255]);
    expect(Array.from(out.subarray(4, 8))).toEqual([0, 0, 0, 128]);
    expect(Array.from(out.subarray(8, 12))).toEqual([0, 0, 0, 255]);
    expect(Array.from(out.subarray(12))).toEqual([5, 6, 7, 0]);
    expect(() => adjustPixels(sample, 4, 1, { type: 'limit_palette', colors: [] })).toThrow(/empty/);
    expect(() => adjustPixels(sample, 4, 1, { type: 'limit_palette', colors: ['nope'] })).toThrow(/Invalid colour/);
  });
  it('a mask limits every adjustment to the selected pixels', () => {
    const mask = Uint8Array.from([0, 1, 0, 0]);
    const out = adjustPixels(sample, 4, 1, { type: 'invert' }, mask);
    expect(Array.from(out.subarray(0, 4))).toEqual([255, 0, 0, 255]);
    expect(Array.from(out.subarray(4, 8))).toEqual([245, 55, 165, 128]);
    const tone = adjustPixels(sample, 4, 1, { type: 'brightness_contrast', brightness: 1, contrast: 0 }, mask);
    expect(Array.from(tone.subarray(8, 12))).toEqual([77, 77, 77, 255]);
    expect(Array.from(tone.subarray(4, 8))).toEqual([255, 255, 255, 128]);
  });
  it('checks the buffer size', () => {
    expect(() => adjustPixels(new Uint8ClampedArray(3), 1, 1, { type: 'invert' })).toThrow(/bytes/);
  });
});

describe('curveLut', () => {
  it('is the identity without points or with [0,0],[1,1]', () => {
    const id = Array.from({ length: 256 }, (_, i) => i);
    expect(Array.from(curveLut([]))).toEqual(id);
    expect(Array.from(curveLut([[0, 0], [1, 1]]))).toEqual(id);
    expect(Array.from(curveLut([[0, 0], [0.5, 0.5], [1, 1]]))).toEqual(id);
  });
  it('passes through its control points and is monotone', () => {
    const lut = curveLut([[0, 0], [0.25, 0.5], [0.75, 0.6], [1, 1]]);
    expect(lut[0]).toBe(0);
    expect(lut[255]).toBe(255);
    expect(lut[64]).toBe(128); // 0.25 * 255 = 63.75 ~ 64
    for (let i = 1; i < 256; i++) expect(lut[i]).toBeGreaterThanOrEqual(lut[i - 1]);
  });
  it('is flat outside the points, constant for one point, and sorts its input', () => {
    const lut = curveLut([[0.5, 0.2], [0.25, 0.8]]);
    expect(lut[0]).toBe(Math.round(0.8 * 255));
    expect(lut[255]).toBe(Math.round(0.2 * 255));
    expect(Array.from(new Set(curveLut([[0.3, 0.4]])))).toEqual([102]);
    expect(Array.from(curveLut([[1, 0], [0, 1]]))).toEqual(Array.from({ length: 256 }, (_, i) => 255 - i));
  });
});

describe('transformPixels', () => {
  // 3 wide, 2 high: A B C / D E F, each pixel (n, 0, 0, 255)
  const px = (ids: number[]): Uint8ClampedArray => new Uint8ClampedArray(ids.flatMap((n) => [n, 0, 0, 255]));
  const ids = (a: Uint8ClampedArray): number[] => Array.from({ length: a.length / 4 }, (_, i) => (a[i * 4 + 3] === 0 ? 0 : a[i * 4]));
  const img = px([1, 2, 3, 4, 5, 6]);
  const run = (t: TextureTransform, src = img, w = 3, h = 2) => transformPixels(src, w, h, t);

  it('flips', () => {
    expect(ids(run({ op: 'flip', axis: 'x' }).pixels)).toEqual([3, 2, 1, 6, 5, 4]);
    expect(ids(run({ op: 'flip', axis: 'y' }).pixels)).toEqual([4, 5, 6, 1, 2, 3]);
  });
  it('rotates and swaps the dimensions; cw then ccw is the identity', () => {
    const cw = run({ op: 'rotate', direction: 'cw' });
    expect([cw.width, cw.height]).toEqual([2, 3]);
    expect(ids(cw.pixels)).toEqual([4, 1, 5, 2, 6, 3]);
    const ccw = run({ op: 'rotate', direction: 'ccw' });
    expect(ids(ccw.pixels)).toEqual([3, 6, 2, 5, 1, 4]);
    const back = transformPixels(cw.pixels, cw.width, cw.height, { op: 'rotate', direction: 'ccw' });
    expect(back.pixels).toEqual(img);
    expect([back.width, back.height]).toEqual([3, 2]);
    let turned = { pixels: img as Uint8ClampedArray, width: 3, height: 2 };
    for (let k = 0; k < 4; k++) turned = transformPixels(turned.pixels, turned.width, turned.height, { op: 'rotate', direction: 'cw' });
    expect(turned.pixels).toEqual(img);
  });
  it('resizes the canvas (top-left anchored) and scales with nearest neighbour', () => {
    const big = run({ op: 'resize', width: 4, height: 3, mode: 'canvas' });
    expect(ids(big.pixels)).toEqual([1, 2, 3, 0, 4, 5, 6, 0, 0, 0, 0, 0]);
    expect(big.pixels[3 * 4 + 3]).toBe(0);
    const small = run({ op: 'resize', width: 2, height: 1, mode: 'canvas' });
    expect(ids(small.pixels)).toEqual([1, 2]);
    const up = run({ op: 'resize', width: 6, height: 4, mode: 'scale' });
    expect(ids(up.pixels).slice(0, 6)).toEqual([1, 1, 2, 2, 3, 3]);
    expect(ids(up.pixels).slice(12, 18)).toEqual([4, 4, 5, 5, 6, 6]);
    const down = run({ op: 'resize', width: 2, height: 1, mode: 'scale' });
    expect(ids(down.pixels)).toEqual([1, 2]); // floor(1 * 3 / 2) = 1
    expect(() => run({ op: 'resize', width: 0, height: 1, mode: 'scale' })).toThrow(/Invalid image size/);
  });
  it('crops, including outside the image', () => {
    expect(ids(run({ op: 'crop', rect: { x: 1, y: 0, width: 2, height: 2 } }).pixels)).toEqual([2, 3, 5, 6]);
    const wide = run({ op: 'crop', rect: { x: -1, y: -1, width: 3, height: 2 } });
    expect(ids(wide.pixels)).toEqual([0, 0, 0, 0, 1, 2]);
    expect(wide.pixels[3]).toBe(0);
    expect(ids(run({ op: 'crop', rect: { x: 2, y: 1, width: 3, height: 1 } }).pixels)).toEqual([6, 0, 0]);
    expect(ids(run({ op: 'crop', rect: { x: 9, y: 9, width: 1, height: 1 } }).pixels)).toEqual([0]);
  });
  it('rebuilds frames from an order', () => {
    // 2 wide, 6 high = 3 frames of 2x2 with ids 1..3 as the first pixel of each frame
    const frames = new Uint8ClampedArray(2 * 6 * 4);
    for (let f = 0; f < 3; f++) for (let p = 0; p < 4; p++) frames.set([f + 1, 0, 0, 255], (f * 4 + p) * 4);
    const out = transformPixels(frames, 2, 6, { op: 'frames', order: [2, 0, null, 7, 0] });
    expect([out.width, out.height]).toEqual([2, 10]);
    const frameIds = [0, 1, 2, 3, 4].map((f) => (out.pixels[f * 16 + 3] === 0 ? 0 : out.pixels[f * 16]));
    expect(frameIds).toEqual([3, 1, 0, 0, 1]);
    const same = transformPixels(frames, 2, 6, { op: 'frames', order: [0, 1, 2] });
    expect(same.pixels).toEqual(frames);
    expect(() => transformPixels(frames, 2, 6, { op: 'frames', order: [] })).toThrow();
  });
  it('never mutates the input', () => {
    const copy = img.slice();
    run({ op: 'flip', axis: 'x' });
    run({ op: 'rotate', direction: 'cw' });
    expect(img).toEqual(copy);
  });
});
