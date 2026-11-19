// Whole-image transforms: flip, rotate, resize, crop, frame reordering.
import type { TextureTransform } from '../../core/pixelOps';
import type { Rgba } from '../pixels';

function checkDims(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`Invalid image size ${width}x${height}: expected positive integers`);
  }
}

function copyPixel(dst: Uint8ClampedArray, di: number, src: Uint8ClampedArray, si: number): void {
  dst[di] = src[si];
  dst[di + 1] = src[si + 1];
  dst[di + 2] = src[si + 2];
  dst[di + 3] = src[si + 3];
}

/** Whole-image transform (see TextureTransform docs). Returns a new pixel array; the input is not touched. */
export function transformPixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  t: TextureTransform,
): { pixels: Rgba; width: number; height: number } {
  if (pixels.length !== width * height * 4) throw new Error(`Pixel data has ${pixels.length} bytes, expected ${width * height * 4}`);
  switch (t.op) {
    case 'flip': {
      const out = new Uint8ClampedArray(pixels.length) as Rgba;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const sx = t.axis === 'x' ? width - 1 - x : x;
          const sy = t.axis === 'y' ? height - 1 - y : y;
          copyPixel(out, (y * width + x) * 4, pixels, (sy * width + sx) * 4);
        }
      }
      return { pixels: out, width, height };
    }
    case 'rotate': {
      // result is height wide and width tall
      const out = new Uint8ClampedArray(pixels.length) as Rgba;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          // cw: the source pixel (x, y) lands at (height - 1 - y, x); ccw: at (y, width - 1 - x)
          const nx = t.direction === 'cw' ? height - 1 - y : y;
          const ny = t.direction === 'cw' ? x : width - 1 - x;
          copyPixel(out, (ny * height + nx) * 4, pixels, (y * width + x) * 4);
        }
      }
      return { pixels: out, width: height, height: width };
    }
    case 'resize': {
      checkDims(t.width, t.height);
      const out = new Uint8ClampedArray(t.width * t.height * 4) as Rgba;
      if (t.mode === 'canvas') {
        const w = Math.min(width, t.width);
        const h = Math.min(height, t.height);
        for (let y = 0; y < h; y++) out.set(pixels.subarray(y * width * 4, (y * width + w) * 4), y * t.width * 4);
      } else {
        for (let y = 0; y < t.height; y++) {
          const sy = Math.floor((y * height) / t.height);
          for (let x = 0; x < t.width; x++) {
            const sx = Math.floor((x * width) / t.width);
            copyPixel(out, (y * t.width + x) * 4, pixels, (sy * width + sx) * 4);
          }
        }
      }
      return { pixels: out, width: t.width, height: t.height };
    }
    case 'crop': {
      const { x, y, width: w, height: h } = t.rect;
      checkDims(w, h);
      if (!Number.isInteger(x) || !Number.isInteger(y)) throw new Error('Crop position must be integers');
      const out = new Uint8ClampedArray(w * h * 4) as Rgba;
      const x0 = Math.max(0, x);
      const x1 = Math.min(width, x + w);
      for (let dy = 0; dy < h; dy++) {
        const sy = y + dy;
        if (sy < 0 || sy >= height || x1 <= x0) continue;
        out.set(pixels.subarray((sy * width + x0) * 4, (sy * width + x1) * 4), (dy * w + (x0 - x)) * 4);
      }
      return { pixels: out, width: w, height: h };
    }
    case 'frames': {
      if (t.order.length === 0) throw new Error('A texture needs at least one frame');
      const frames = Math.floor(height / width);
      const frameBytes = width * width * 4;
      const out = new Uint8ClampedArray(frameBytes * t.order.length) as Rgba;
      t.order.forEach((index, k) => {
        if (index === null || !Number.isInteger(index) || index < 0 || index >= frames) return;
        out.set(pixels.subarray(index * frameBytes, (index + 1) * frameBytes), k * frameBytes);
      });
      return { pixels: out, width, height: width * t.order.length };
    }
  }
}
