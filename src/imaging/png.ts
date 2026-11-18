// A small PNG codec for paint layers: 8-bit RGBA in, 8-bit RGBA out, bit-exact and NOT premultiplied.
// (A 2D canvas stores premultiplied pixels, so encoding or decoding translucent pixels through it changes
// their colours; painted layers are mostly translucent.) Deflate comes from the platform's
// CompressionStream, which browsers and Node both have, so this file is DOM-free.
import type { Rgba } from './pixels';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = crcTable[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Inflates into a buffer of exactly `size` bytes; anything else means the file is damaged (or a decompression bomb). */
async function inflate(parts: readonly Uint8Array<ArrayBuffer>[], size: number): Promise<Uint8Array<ArrayBuffer>> {
  const out = new Uint8Array(size);
  let length = 0;
  const reader = new Blob(parts as Uint8Array<ArrayBuffer>[]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.length > size) {
        await reader.cancel();
        throw new Error('too much data');
      }
      out.set(value, length);
      length += value.length;
    }
  } catch {
    throw new Error('The PNG image is damaged');
  }
  if (length !== size) throw new Error('The PNG image is damaged');
  return out;
}

/** Encodes RGBA pixels (not premultiplied) as a PNG file. Lossless. */
export async function encodePng(pixels: Uint8ClampedArray, width: number, height: number): Promise<Uint8Array<ArrayBuffer>> {
  // Every row gets the "up" filter (difference to the row above): cheap, and painted images, which are
  // mostly flat or smooth, deflate well with it.
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  // Four bytes at a time: a pixel is one 32-bit word, and the bytes of two words are subtracted (mod 256,
  // without borrowing into the next byte) as ((a | H) - (b & ~H)) ^ ((a ^ ~b) & H), H = the high bit of each byte.
  const aligned = pixels.byteOffset % 4 === 0 ? pixels : new Uint8ClampedArray(pixels);
  const words = new Uint32Array(aligned.buffer, aligned.byteOffset, width * height);
  const row = new Uint32Array(width);
  const rowBytes = new Uint8Array(row.buffer);
  for (let y = 0; y < height; y++) {
    const start = y * width;
    if (y === 0) row.set(words.subarray(0, width));
    else {
      for (let x = 0; x < width; x++) {
        const a = words[start + x];
        const b = words[start + x - width];
        row[x] = ((a | 0x80808080) - (b & 0x7f7f7f7f)) ^ ((a ^ ~b) & 0x80808080);
      }
    }
    raw[y * (stride + 1)] = 2;
    raw.set(rowBytes, y * (stride + 1) + 1);
  }
  const data = await deflate(raw);

  const file = new Uint8Array(8 + 25 + 12 + data.length + 12);
  const view = new DataView(file.buffer);
  file.set(SIGNATURE);
  let p = 8;
  const chunk = (type: string, length: number, write: (at: number) => void) => {
    view.setUint32(p, length);
    for (let i = 0; i < 4; i++) file[p + 4 + i] = type.charCodeAt(i);
    write(p + 8);
    view.setUint32(p + 8 + length, crc32(file, p + 4, p + 8 + length));
    p += 12 + length;
  };
  chunk('IHDR', 13, (at) => {
    view.setUint32(at, width);
    view.setUint32(at + 4, height);
    file[at + 8] = 8; // bit depth
    file[at + 9] = 6; // RGBA
  });
  chunk('IDAT', data.length, (at) => file.set(data, at));
  chunk('IEND', 0, () => {});
  return file;
}

/**
 * Decodes a PNG file to RGBA pixels (not premultiplied). Handles what this codec and most tools write:
 * 8 bits per channel, grey / RGB with or without alpha, not interlaced. Returns null for other variants
 * (palette, 16 bit, interlaced, colour-key transparency) so the caller can use another decoder.
 * Throws if the file is damaged. The caller checks the size in the header before calling this.
 */
export async function decodePng(bytes: Uint8Array<ArrayBuffer>): Promise<{ width: number; height: number; pixels: Rgba } | null> {
  if (bytes.length < 33 || SIGNATURE.some((v, i) => bytes[i] !== v)) throw new Error('The image is not a PNG file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const colorType = bytes[25];
  if (bytes[24] !== 8 || bytes[28] !== 0 || ![0, 2, 4, 6].includes(colorType)) return null;
  const channels = [1, 0, 3, 0, 2, 0, 4][colorType];

  const parts: Uint8Array<ArrayBuffer>[] = [];
  for (let p = 8; p + 12 <= bytes.length; ) {
    const length = view.getUint32(p);
    const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
    if (p + 12 + length > bytes.length) throw new Error('The PNG image is damaged');
    if (type === 'tRNS') return null;
    if (type === 'IDAT') parts.push(bytes.subarray(p + 8, p + 8 + length));
    if (type === 'IEND') break;
    p += 12 + length;
  }

  const stride = width * channels;
  const raw = await inflate(parts, (stride + 1) * height);
  // Undo the row filters in place. (One loop per filter type: this runs over every byte of the image.)
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1) + 1;
    const end = start + stride;
    const filter = raw[start - 1];
    // The row above; for the first row, a row of zeros stands in (the filter byte and what follows are not read as such).
    const up = y > 0 ? stride + 1 : 0;
    if (filter === 0 || (filter === 2 && y === 0)) continue;
    if (filter === 1) {
      for (let i = start + channels; i < end; i++) raw[i] += raw[i - channels];
    } else if (filter === 2) {
      for (let i = start; i < end; i++) raw[i] += raw[i - up];
    } else if (filter === 3) {
      for (let i = start; i < end; i++) {
        const left = i >= start + channels ? raw[i - channels] : 0;
        raw[i] += (left + (up ? raw[i - up] : 0)) >> 1;
      }
    } else if (filter === 4) {
      for (let i = start; i < end; i++) {
        const inside = i >= start + channels;
        const left = inside ? raw[i - channels] : 0;
        const above = up ? raw[i - up] : 0;
        const aboveLeft = up && inside ? raw[i - up - channels] : 0;
        const estimate = left + above - aboveLeft;
        const dl = Math.abs(estimate - left);
        const da = Math.abs(estimate - above);
        const dal = Math.abs(estimate - aboveLeft);
        raw[i] += dl <= da && dl <= dal ? left : da <= dal ? above : aboveLeft;
      }
    } else throw new Error('The PNG image is damaged');
  }

  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0, o = 0; y < height; y++) {
    let i = y * (stride + 1) + 1;
    if (channels === 4) {
      pixels.set(raw.subarray(i, i + stride), o);
      o += stride;
      continue;
    }
    for (let x = 0; x < width; x++, o += 4, i += channels) {
      const grey = channels < 3;
      pixels[o] = raw[i];
      pixels[o + 1] = grey ? raw[i] : raw[i + 1];
      pixels[o + 2] = grey ? raw[i] : raw[i + 2];
      pixels[o + 3] = channels === 2 ? raw[i + 1] : 255;
    }
  }
  return { width, height, pixels };
}
