import { CanvasTexture, Color, EquirectangularReflectionMapping, SRGBColorSpace } from 'three/webgpu';
import { floor, fract, mix, screenCoordinate, step, uniform, vec3 } from 'three/tsl';
import type { SkyLook } from './scenes';

// Backgrounds of the viewport: a painted panorama for the scenes (gradient sky, square sun or moon,
// stars) and a screen-space checkerboard for the plain background.

const WIDTH = 1024;
const HEIGHT = 512;

/** Deterministic pseudo-random numbers for the stars. */
function random(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/** Paints a sky panorama (equirectangular: x = direction around, y = from straight up to straight down). */
export function skyTexture(look: SkyLook): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const context = canvas.getContext('2d')!;
  const gradient = context.createLinearGradient(0, 0, 0, HEIGHT);
  gradient.addColorStop(0, look.top);
  gradient.addColorStop(0.32, look.top);
  gradient.addColorStop(0.5, look.horizon);
  gradient.addColorStop(0.56, look.horizon);
  gradient.addColorStop(1, look.bottom);
  context.fillStyle = gradient;
  context.fillRect(0, 0, WIDTH, HEIGHT);

  if (look.stars) {
    const rnd = random(1234567);
    for (let i = 0; i < look.stars; i++) {
      const x = rnd() * WIDTH;
      // Fewer stars towards the horizon.
      const y = (rnd() ** 1.6) * HEIGHT * 0.48;
      const size = rnd() < 0.08 ? 2 : 1;
      context.fillStyle = `rgba(255, 255, 255, ${0.35 + rnd() * 0.65})`;
      context.fillRect(x, y, size, size);
    }
  }

  if (look.sun) {
    const { azimuth, elevation, color, size, glow } = look.sun;
    const x = ((azimuth + 180) / 360) * WIDTH;
    const y = ((90 - elevation) / 180) * HEIGHT;
    const half = (size / 360) * WIDTH;
    if (glow) {
      const halo = context.createRadialGradient(x, y, half, x, y, half * 6);
      halo.addColorStop(0, `${glow}aa`);
      halo.addColorStop(1, `${glow}00`);
      context.fillStyle = halo;
      context.fillRect(x - half * 6, y - half * 6, half * 12, half * 12);
    }
    // Minecraft's sun and moon are squares.
    context.fillStyle = color;
    context.fillRect(x - half, y - half, half * 2, half * 2);
  }

  const texture = new CanvasTexture(canvas);
  texture.mapping = EquirectangularReflectionMapping;
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/** A checkerboard fixed to the screen, in device pixels; colours and cell size can change without a rebuild. */
export function checkerBackground() {
  const a = uniform(new Color('#2a2f33'));
  const b = uniform(new Color('#353b40'));
  const cell = uniform(12);
  const cells = floor(screenCoordinate.xy.div(cell));
  const odd = step(0.5, fract(cells.x.add(cells.y).mul(0.5)));
  const node = vec3(mix(a, b, odd));
  return {
    node,
    set(light: string, dark: string, cellPixels: number) {
      a.value.set(light);
      b.value.set(dark);
      cell.value = cellPixels;
    },
  };
}
