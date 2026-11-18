// Extending baked charts into the empty space around them. DOM-free.

const NEIGHBOURS = [
  [1, 0, 2],
  [-1, 0, 2],
  [0, 1, 2],
  [0, -1, 2],
  [1, 1, 1],
  [1, -1, 1],
  [-1, 1, 1],
  [-1, -1, 1],
] as const;

/**
 * Grows the covered texels of an RGBA image by `radius` texels: ring by ring, every empty texel next
 * to filled ones gets their average colour (direct neighbours count double). Bilinear filtering and
 * mipmaps then find chart colours beyond the chart borders instead of the background. The image wraps
 * around at its edges, like the repeating textures of the viewport. `covered` (one byte per texel,
 * non-zero = filled) is not changed. Returns the number of texels filled.
 */
export function dilate(pixels: Uint8ClampedArray | Uint8Array, covered: Uint8Array, size: number, radius: number): number {
  // 0 = empty, 1 = original, k + 1 = filled by ring k.
  const level = new Uint8Array(size * size);
  for (let i = 0; i < level.length; i++) if (covered[i]) level[i] = 1;
  const wrap = (x: number, y: number) => ((y + size) % size) * size + ((x + size) % size);
  let frontier: number[] = [];
  let filled = 0;
  for (let ring = 1; ring <= radius; ring++) {
    // The empty texels next to the previous ring, each once.
    const next: number[] = [];
    if (ring === 1) {
      // The first ring borders the original texels, which are too many to keep as a list.
      for (let y = 0, j = 0; y < size; y++) {
        for (let x = 0; x < size; x++, j++) {
          if (level[j] !== 0) continue;
          for (const [dx, dy] of NEIGHBOURS) {
            if (level[wrap(x + dx, y + dy)] === 1) {
              next.push(j);
              break;
            }
          }
        }
      }
    } else {
      for (const i of frontier) {
        const x = i % size;
        const y = (i - x) / size;
        for (const [dx, dy] of NEIGHBOURS) {
          const j = wrap(x + dx, y + dy);
          if (level[j] === 0) {
            level[j] = 255; // queued
            next.push(j);
          }
        }
      }
    }
    if (next.length === 0) break;
    for (const j of next) {
      const x = j % size;
      const y = (j - x) / size;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let weight = 0;
      for (const [dx, dy, w] of NEIGHBOURS) {
        const k = wrap(x + dx, y + dy);
        // Only texels of earlier rings, so the result does not depend on the order within a ring.
        if (level[k] === 0 || level[k] > ring) continue;
        r += pixels[k * 4] * w;
        g += pixels[k * 4 + 1] * w;
        b += pixels[k * 4 + 2] * w;
        a += pixels[k * 4 + 3] * w;
        weight += w;
      }
      pixels[j * 4] = Math.round(r / weight);
      pixels[j * 4 + 1] = Math.round(g / weight);
      pixels[j * 4 + 2] = Math.round(b / weight);
      pixels[j * 4 + 3] = Math.round(a / weight);
    }
    for (const j of next) level[j] = ring + 1;
    filled += next.length;
    frontier = next;
  }
  return filled;
}
