import { describe, expect, it } from 'vitest';
import type { PixelBlendMode } from '../../core/pixelOps';
import { hexToRgb, hsvToRgb, nearestColor, rgbToHex, rgbToHsv } from './index';
import { paintPixel } from './index';

const normal = { lockAlpha: false, erase: false };

function paint(dst: number[], src: [number, number, number], alpha: number, blend: PixelBlendMode, extra: Partial<typeof normal> = {}): number[] {
  const px = new Uint8ClampedArray(dst);
  paintPixel(px, 0, src[0], src[1], src[2], alpha, { blend, ...normal, ...extra });
  return Array.from(px);
}

describe('paintPixel blend modes on an opaque pixel', () => {
  const dst = [200, 100, 50, 255];
  const src: [number, number, number] = [100, 200, 150];
  it.each([
    ['default', [100, 200, 150, 255]],
    ['multiply', [78, 78, 29, 255]],
    ['screen', [222, 222, 171, 255]],
    ['overlay', [188, 157, 59, 255]],
    ['darken', [100, 100, 50, 255]],
    ['lighten', [200, 200, 150, 255]],
    ['difference', [100, 100, 100, 255]],
    ['add', [255, 255, 200, 255]],
    ['set_opacity', [100, 200, 150, 255]],
    ['behind', [200, 100, 50, 255]],
  ] as [PixelBlendMode, number[]][])('%s at full opacity', (mode, expected) => {
    expect(paint(dst, src, 1, mode)).toEqual(expected);
  });

  it('colour mode keeps the luminosity of the backdrop', () => {
    const [r, g, b] = paint([128, 128, 128, 255], [255, 0, 0], 1, 'color');
    const lum = (0.3 * r + 0.59 * g + 0.11 * b) / 255;
    expect(lum).toBeCloseTo(128 / 255, 1);
    expect(r).toBeGreaterThan(g);
    expect(g).toBe(b);
  });

  it('mixes a blended colour in by the source alpha', () => {
    // multiply at 50%: halfway between dst and multiply result
    expect(paint(dst, src, 0.5, 'multiply')).toEqual([139, 89, 40, 255]);
    expect(paint(dst, src, 0.5, 'default')).toEqual([150, 150, 100, 255]);
  });

  it('set_opacity sets the alpha exactly', () => {
    expect(paint(dst, src, 0.5, 'set_opacity')).toEqual([100, 200, 150, 128]);
  });

  it('behind only shows where the backdrop is transparent', () => {
    expect(paint([0, 0, 0, 0], src, 1, 'behind')).toEqual([100, 200, 150, 255]);
    expect(paint([200, 100, 50, 128], [0, 0, 0], 1, 'behind')[3]).toBe(255);
  });

  it('paints over a transparent pixel with the plain colour in every blend mode', () => {
    for (const mode of ['default', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'difference', 'add', 'color'] as const) {
      expect(paint([0, 0, 0, 0], src, 0.5, mode)).toEqual([100, 200, 150, 128]);
    }
  });

  it('source alpha 0 changes nothing, except set_opacity', () => {
    expect(paint(dst, src, 0, 'default')).toEqual(dst);
    expect(paint(dst, src, 0, 'set_opacity')).toEqual([0, 0, 0, 0]);
  });
});

describe('paintPixel erase and lockAlpha', () => {
  it('erase reduces alpha by the opacity and keeps the colour', () => {
    expect(paint([10, 20, 30, 200], [0, 0, 0], 0.5, 'default', { erase: true })).toEqual([10, 20, 30, 100]);
    expect(paint([10, 20, 30, 200], [0, 0, 0], 1, 'default', { erase: true })).toEqual([10, 20, 30, 0]);
  });
  it('lockAlpha keeps alpha and leaves transparent pixels alone', () => {
    expect(paint([10, 20, 30, 128], [200, 200, 200], 1, 'default', { lockAlpha: true })).toEqual([200, 200, 200, 128]);
    expect(paint([0, 0, 0, 0], [200, 200, 200], 1, 'default', { lockAlpha: true })).toEqual([0, 0, 0, 0]);
    expect(paint([10, 20, 30, 128], [0, 0, 0], 1, 'default', { lockAlpha: true, erase: true })).toEqual([10, 20, 30, 128]);
  });
  it('a result of alpha 0 is written as 0,0,0,0', () => {
    expect(paint([9, 9, 9, 1], [1, 2, 3], 0.001, 'set_opacity')).toEqual([0, 0, 0, 0]);
  });
});

describe('colour helpers', () => {
  it('parses and formats hex', () => {
    expect(hexToRgb('#ff8000')).toEqual([255, 128, 0]);
    expect(hexToRgb('f80')).toEqual([255, 136, 0]);
    expect(rgbToHex(255, 128, 0)).toBe('#ff8000');
    expect(rgbToHex(0, 0, 0)).toBe('#000000');
    expect(() => hexToRgb('#12')).toThrow(/Invalid colour/);
    expect(() => hexToRgb('zzzzzz')).toThrow();
  });
  it('round-trips HSV', () => {
    for (const c of [[255, 0, 0], [0, 255, 0], [12, 200, 99], [0, 0, 0], [255, 255, 255], [90, 90, 91]] as const) {
      const [h, s, v] = rgbToHsv(c[0], c[1], c[2]);
      expect(hsvToRgb(h, s, v)).toEqual(Array.from(c));
    }
    expect(rgbToHsv(0, 0, 255)).toEqual([240, 1, 1]);
  });
  it('finds the nearest colour', () => {
    const palette: [number, number, number][] = [[0, 0, 0], [255, 0, 0], [255, 255, 255]];
    expect(nearestColor(10, 10, 10, palette)).toBe(0);
    expect(nearestColor(250, 20, 10, palette)).toBe(1);
    expect(() => nearestColor(0, 0, 0, [])).toThrow();
  });
});
