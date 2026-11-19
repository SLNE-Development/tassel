// The procedural surroundings of a render as an equirectangular HDR image: pure maths, no DOM, no three.js.
// Nothing is downloaded; every preset is a function of the direction.
import { discSolidAngle, sunDirection, type EnvironmentPreset, type RenderSettings } from '../core/render';
import type { Vec3 } from '../core/types';

type Rgb = [number, number, number];

const DEG = Math.PI / 180;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const scale = (a: Rgb, s: number): Rgb => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The colour of the sun for each preset (linear, brightest channel 1). */
export const sunColor: Record<EnvironmentPreset, Rgb> = {
  outdoor: [1, 0.95, 0.88],
  studio: [1, 1, 1],
  sunset: [1, 0.5, 0.2],
  night: [1, 1, 1],
  neutral: [1, 1, 1],
};

/** A rectangular light on the sphere around the scene, soft at its edges: a studio soft box. */
interface SoftBox {
  /** Direction of its centre: azimuth from +Z towards +X and elevation, in degrees. */
  azimuth: number;
  elevation: number;
  /** Half extents in degrees. */
  halfWidth: number;
  halfHeight: number;
  radiance: Rgb;
}

interface Box extends SoftBox {
  centre: Vec3;
  right: Vec3;
  up: Vec3;
}

function prepare(box: SoftBox): Box {
  const centre = sunDirection(box.azimuth, box.elevation);
  // Horizontal tangent; for a box straight above, any horizontal direction.
  const a = box.azimuth * DEG;
  const right: Vec3 = [Math.cos(a), 0, -Math.sin(a)];
  const up: Vec3 = [centre[1] * right[2] - centre[2] * right[1], centre[2] * right[0] - centre[0] * right[2], centre[0] * right[1] - centre[1] * right[0]];
  return { ...box, centre, right, up };
}

/** How much of the box a direction sees: 1 inside, falling to 0 over a soft border. */
function boxCoverage(box: Box, d: Vec3): number {
  const forward = dot(d, box.centre);
  if (forward <= 0.05) return 0;
  const x = Math.atan2(dot(d, box.right), forward) / DEG;
  const y = Math.atan2(dot(d, box.up), forward) / DEG;
  const border = 4;
  return (1 - smoothstep(box.halfWidth - border, box.halfWidth + border, Math.abs(x))) * (1 - smoothstep(box.halfHeight - border, box.halfHeight + border, Math.abs(y)));
}

const studioBoxes = [
  { azimuth: -50, elevation: 38, halfWidth: 26, halfHeight: 18, radiance: [4.6, 4.5, 4.4] },
  { azimuth: 65, elevation: 22, halfWidth: 30, halfHeight: 20, radiance: [0.55, 0.57, 0.6] },
  { azimuth: 165, elevation: 40, halfWidth: 14, halfHeight: 24, radiance: [2.6, 2.6, 2.7] },
  { azimuth: 0, elevation: 90, halfWidth: 20, halfHeight: 20, radiance: [0.7, 0.7, 0.7] },
].map((box) => prepare(box as SoftBox));

const nightBoxes = [
  { azimuth: -60, elevation: 48, halfWidth: 18, halfHeight: 14, radiance: [3.2, 4.2, 6] },
  { azimuth: 140, elevation: 25, halfWidth: 12, halfHeight: 20, radiance: [1.6, 1, 0.5] },
].map((box) => prepare(box as SoftBox));

function boxes(list: readonly Box[], d: Vec3, base: Rgb): Rgb {
  const out: Rgb = [...base];
  for (const box of list) {
    const c = boxCoverage(box, d);
    if (c === 0) continue;
    out[0] += box.radiance[0] * c;
    out[1] += box.radiance[1] * c;
    out[2] += box.radiance[2] * c;
  }
  return out;
}

/**
 * Radiance of a preset's surroundings in direction `d` (unit vector, Y up), without the sun disc.
 * `sun` is the direction towards the sun, or null without one: skies brighten around it.
 */
export function presetRadiance(preset: EnvironmentPreset, d: Vec3, sun: Vec3 | null): Rgb {
  const y = d[1];
  switch (preset) {
    case 'neutral':
      return [1, 1, 1];
    case 'studio': {
      // A dim room: slightly lighter towards the floor's bounce and at eye level.
      const room = 0.03 + 0.04 * (1 - Math.abs(y)) + (y < 0 ? 0.05 * -y : 0);
      return boxes(studioBoxes, d, [room, room, room * 1.03]);
    }
    case 'night': {
      const room = 0.004 + 0.006 * (1 - Math.abs(y));
      return boxes(nightBoxes, d, [room * 0.8, room * 0.9, room * 1.3]);
    }
    case 'outdoor': {
      // About a fifth of what a sunlit white surface sends back, as under a real clear sky.
      const zenith: Rgb = [0.1, 0.17, 0.36];
      const horizon: Rgb = [0.34, 0.38, 0.44];
      let sky = mix(horizon, zenith, Math.pow(clamp01(y), 0.45));
      if (sun) {
        // The sky is brighter and whiter around the sun.
        const near = clamp01(dot(d, sun));
        const glow = 0.14 * Math.pow(near, 8) + 0.6 * Math.pow(near, 180);
        sky = [sky[0] + glow, sky[1] + glow * 0.95, sky[2] + glow * 0.85];
      }
      const ground: Rgb = [0.3, 0.3, 0.31];
      return mix(ground, sky, smoothstep(-0.03, 0.03, y));
    }
    case 'sunset': {
      // How much this direction faces the sun's side of the horizon.
      const flat = sun ? Math.hypot(sun[0], sun[2]) : 0;
      const towards = sun && flat > 1e-6 ? clamp01(((d[0] * sun[0] + d[2] * sun[2]) / flat) * 0.5 + 0.5) : 0.5;
      const glowing = mix([0.2, 0.11, 0.15], [0.85, 0.34, 0.11], towards * towards);
      const high: Rgb = [0.035, 0.05, 0.14];
      const band = mix(glowing, [0.2, 0.13, 0.22], smoothstep(0, 0.35, y));
      let sky = mix(band, high, smoothstep(0.1, 0.8, y));
      if (sun) {
        const near = clamp01(dot(d, sun));
        const glow = 0.4 * Math.pow(near, 24);
        sky = [sky[0] + glow, sky[1] + glow * 0.5, sky[2] + glow * 0.2];
      }
      const ground: Rgb = [0.13, 0.1, 0.12];
      return mix(ground, sky, smoothstep(-0.03, 0.03, y));
    }
  }
}

export interface EnvironmentImage {
  width: number;
  height: number;
  /** RGBA float pixels, linear radiance, row 0 at the bottom (direction -Y), as three.js reads an equirectangular DataTexture. */
  data: Float32Array;
}

/** Radiance above which half-float textures (what the path tracer stores the image in) overflow. */
const MAX_RADIANCE = 60000;

/** The direction of pixel centre (x, y) of an equirectangular image, in three.js' mapping. */
export function equirectDirection(x: number, y: number, width: number, height: number): Vec3 {
  const phi = ((x + 0.5) / width - 0.5) * 2 * Math.PI;
  const theta = ((y + 0.5) / height - 0.5) * Math.PI;
  const c = Math.cos(theta);
  return [Math.cos(phi) * c, Math.sin(theta), Math.sin(phi) * c];
}

/**
 * The surroundings for the given settings: preset (turned by its rotation, scaled by its intensity)
 * plus the sun as a disc of the given angular radius. The disc is scaled so that a surface facing
 * the sun receives exactly `sun.intensity` of irradiance from it whatever its softness, which makes
 * softness change the shadows and not the brightness.
 */
export function buildEnvironment(environment: RenderSettings['environment'], sun: RenderSettings['sun'], width = sun.enabled ? 2048 : 1024): EnvironmentImage {
  const height = width / 2;
  const data = new Float32Array(width * height * 4);
  const toSun = sun.enabled && sun.intensity > 0 ? sunDirection(sun.azimuth, sun.elevation) : null;
  const rotation = environment.rotation * DEG;
  const cosR = Math.cos(rotation);
  const sinR = Math.sin(rotation);
  // The sky itself knows where the sun is, in its own (unrotated) frame.
  const sunInSky: Vec3 | null = toSun && [toSun[0] * cosR - toSun[2] * sinR, toSun[1], toSun[0] * sinR + toSun[2] * cosR];
  const radius = sun.softness * DEG;
  // One pixel of soft edge, so that a small disc is not a staircase.
  const edge = (Math.PI / height) * 0.75;
  const cosOuter = Math.cos(radius + edge);
  const disc = new Float32Array(toSun ? width * height : 0);
  let discEnergy = 0;

  for (let y = 0; y < height; y++) {
    const pixelSolidAngle = (2 * Math.PI) / width * (Math.PI / height) * Math.cos(((y + 0.5) / height - 0.5) * Math.PI);
    for (let x = 0; x < width; x++) {
      const d = equirectDirection(x, y, width, height);
      // Positive rotation turns the surroundings counter-clockwise seen from above: look up where this direction was.
      const inSky: Vec3 = [d[0] * cosR - d[2] * sinR, d[1], d[0] * sinR + d[2] * cosR];
      const rgb = scale(presetRadiance(environment.preset, inSky, sunInSky), environment.intensity);
      const i = (y * width + x) * 4;
      data[i] = rgb[0];
      data[i + 1] = rgb[1];
      data[i + 2] = rgb[2];
      data[i + 3] = 1;
      if (toSun) {
        const cosAngle = dot(d, toSun);
        if (cosAngle > cosOuter) {
          const coverage = 1 - smoothstep(radius - edge, radius + edge, Math.acos(Math.min(1, cosAngle)));
          disc[y * width + x] = coverage;
          discEnergy += coverage * pixelSolidAngle;
        }
      }
    }
  }

  if (toSun && discEnergy > 0) {
    const color = sunColor[environment.preset];
    // Irradiance on a surface facing the sun = radiance x solid angle (the disc is small).
    const radiance = Math.min(sun.intensity / discEnergy, MAX_RADIANCE);
    for (let p = 0; p < disc.length; p++) {
      if (disc[p] === 0) continue;
      data[p * 4] += color[0] * radiance * disc[p];
      data[p * 4 + 1] += color[1] * radiance * disc[p];
      data[p * 4 + 2] += color[2] * radiance * disc[p];
    }
  }
  return { width, height, data };
}

/** The ideal solid angle of the sun disc; exported for tests of the rasterised one. */
export const sunSolidAngle = (softness: number) => discSolidAngle(softness);
