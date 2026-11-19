import { describe, expect, it } from 'vitest';
import { defaultRenderSettings, environmentPresets, sunDirection } from '../core/render';
import { buildEnvironment, equirectDirection, presetRadiance, sunColor } from './environment';
import { denoiseSigma } from './output';

const env = defaultRenderSettings.environment;
const noSun = { ...defaultRenderSettings.sun, enabled: false };

/** Light arriving on a surface with the given normal: the integral of radiance x cosine over the image. */
function irradiance(image: ReturnType<typeof buildEnvironment>, normal: readonly number[], channel = 1): number {
  const { width, height, data } = image;
  let sum = 0;
  for (let y = 0; y < height; y++) {
    const solid = ((2 * Math.PI) / width) * (Math.PI / height) * Math.cos(((y + 0.5) / height - 0.5) * Math.PI);
    for (let x = 0; x < width; x++) {
      const d = equirectDirection(x, y, width, height);
      const cos = d[0] * normal[0] + d[1] * normal[1] + d[2] * normal[2];
      if (cos > 0) sum += data[(y * width + x) * 4 + channel] * cos * solid;
    }
  }
  return sum;
}

describe('procedural environments', () => {
  it('maps pixels to directions as three.js reads an equirectangular image', () => {
    const d = equirectDirection(0, 0, 8, 4);
    expect(d[1]).toBeLessThan(0);
    expect(equirectDirection(3, 3, 8, 4)[1]).toBeGreaterThan(0);
    // u = 0.5 is +X, u = 0.75 is +Z.
    const mid = equirectDirection(511.5, 255.5, 1024, 512);
    expect(mid[0]).toBeCloseTo(1, 4);
    const quarter = equirectDirection(767.5, 255.5, 1024, 512);
    expect(quarter[2]).toBeCloseTo(1, 4);
  });

  it('gives finite, non-negative light for every preset', () => {
    for (const preset of environmentPresets) {
      const image = buildEnvironment({ preset, intensity: 1, rotation: 0 }, noSun, 64);
      expect(image.width).toBe(64);
      expect(image.height).toBe(32);
      expect(image.data.every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
      expect(irradiance(image, [0, 1, 0])).toBeGreaterThan(0.01);
    }
    // Neutral is the reference: evenly white, so a surface receives pi.
    expect(irradiance(buildEnvironment({ preset: 'neutral', intensity: 1, rotation: 0 }, noSun, 256), [0, 1, 0])).toBeCloseTo(Math.PI, 2);
    expect(irradiance(buildEnvironment({ preset: 'neutral', intensity: 2.5, rotation: 0 }, noSun, 64), [0, 1, 0])).toBeCloseTo(Math.PI * 2.5, 1);
  });

  it('puts the sun where its direction says, with the same light whatever its softness', () => {
    const base = irradiance(buildEnvironment(env, noSun, 1024), sunDirection(30, 40));
    for (const softness of [0.5, 2, 10]) {
      const sun = { enabled: true, azimuth: 30, elevation: 40, intensity: 4, softness };
      const image = buildEnvironment(env, sun, 2048);
      // The brightest pixel is at the sun.
      let best = 0;
      for (let p = 0; p < image.width * image.height; p++) if (image.data[p * 4 + 1] > image.data[best * 4 + 1]) best = p;
      const d = equirectDirection(best % image.width, Math.floor(best / image.width), image.width, image.height);
      const s = sunDirection(30, 40);
      expect(Math.acos(d[0] * s[0] + d[1] * s[1] + d[2] * s[2]) * (180 / Math.PI)).toBeLessThan(softness + 0.3);
      // A surface facing the sun gets the sun's intensity on top of the sky (green channel of a 0.95 green sun).
      const facing = irradiance(image, s) - base;
      expect(facing / (4 * sunColor.outdoor[1])).toBeGreaterThan(softness > 5 ? 0.93 : 0.97);
      expect(facing / (4 * sunColor.outdoor[1])).toBeLessThan(softness > 5 ? 1.2 : 1.12);
      // And nothing above what half floats can hold.
      expect(image.data.reduce((a, b) => Math.max(a, b), 0)).toBeLessThan(65000);
    }
  });

  it('lights from the sun side: a wall facing the sun is brighter than one facing away', () => {
    const sun = { enabled: true, azimuth: 90, elevation: 20, intensity: 4, softness: 2 };
    const image = buildEnvironment(env, sun, 1024);
    expect(irradiance(image, [1, 0, 0])).toBeGreaterThan(irradiance(image, [-1, 0, 0]) * 3);
    // Disabled or without intensity there is no sun at all.
    expect(buildEnvironment(env, { ...sun, enabled: false }).width).toBe(1024);
    const off = buildEnvironment(env, { ...sun, intensity: 0 }, 256);
    expect(off.data.reduce((a, b) => Math.max(a, b), 0)).toBeLessThan(5);
  });

  it('turns the surroundings with the rotation, counter-clockwise seen from above', () => {
    // The studio's key light is at azimuth -50 (front left). Turned by +90 degrees it is at +40 seen from above... i.e. it moved from -X towards +Z, then on to +X.
    const key = sunDirection(-50, 38);
    const at = (rotation: number, d: readonly number[]) => {
      const r = (rotation * Math.PI) / 180;
      const inSky: [number, number, number] = [d[0] * Math.cos(r) - d[2] * Math.sin(r), d[1], d[0] * Math.sin(r) + d[2] * Math.cos(r)];
      return presetRadiance('studio', inSky, null)[1];
    };
    expect(at(0, key)).toBeGreaterThan(3);
    // A rotation about +Y by +90 degrees takes +Z to +X.
    const turned = [key[2], key[1], -key[0]];
    expect(at(90, turned)).toBeGreaterThan(3);
    expect(at(90, key)).toBeLessThan(1);
    const image = buildEnvironment({ preset: 'studio', intensity: 1, rotation: 90 }, noSun, 512);
    const plain = buildEnvironment({ preset: 'studio', intensity: 1, rotation: 0 }, noSun, 512);
    // Turning does not change the light from straight above.
    expect(irradiance(image, [0, 1, 0])).toBeCloseTo(irradiance(plain, [0, 1, 0]), 1);
    // The image itself is turned the same way.
    const green = (img: typeof image, d: readonly number[]) => {
      const x = Math.min(img.width - 1, Math.floor((Math.atan2(d[2], d[0]) / (2 * Math.PI) + 0.5) * img.width));
      const y = Math.min(img.height - 1, Math.floor((Math.asin(d[1]) / Math.PI + 0.5) * img.height));
      return img.data[(y * img.width + x) * 4 + 1];
    };
    expect(green(plain, key)).toBeGreaterThan(3);
    expect(green(image, turned)).toBeGreaterThan(3);
    expect(green(image, key)).toBeLessThan(1);
  });
});

describe('denoiseSigma', () => {
  it('is off at strength 0 and backs off with the sample count', () => {
    expect(denoiseSigma(0, 64)).toBe(0);
    expect(denoiseSigma(0.5, 0)).toBe(0);
    expect(denoiseSigma(0.5, 4)).toBe(denoiseSigma(0.5, 16));
    expect(denoiseSigma(0.5, 64)).toBeCloseTo(denoiseSigma(0.5, 16) / 2);
    expect(denoiseSigma(1, 1024)).toBeLessThan(denoiseSigma(1, 256));
  });
});
