import { crc32, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { imageSize } from '../core/imageInfo';
import { decodePng, encodePng } from './png';

function noise(length: number, seed = 1): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(length);
  let s = seed;
  for (let i = 0; i < length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

/**
 * A PNG written independently of the codec under test (zlib from Node), with the row filters 0..4 in turn.
 * `samples` are the raw channel values, `channels` per pixel.
 */
function referencePng(samples: Uint8Array | Uint8ClampedArray, width: number, height: number, colorType: number, options: { bitDepth?: number; interlace?: number; extra?: Buffer[] } = {}) {
  const channels = [1, 0, 3, 1, 2, 0, 4][colorType];
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const filter = y % 5;
    raw[y * (stride + 1)] = filter;
    for (let i = 0; i < stride; i++) {
      const at = (row: number, index: number) => (row < 0 || index < 0 ? 0 : samples[row * stride + index]);
      const left = at(y, i - channels);
      const up = at(y - 1, i);
      const upLeft = at(y - 1, i - channels);
      const paeth = () => {
        const p = left + up - upLeft;
        const [a, b, c] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];
        return a <= b && a <= c ? left : b <= c ? up : upLeft;
      };
      const predicted = [0, left, up, Math.floor((left + up) / 2), paeth()][filter];
      raw[y * (stride + 1) + 1 + i] = (samples[y * stride + i] - predicted) & 255;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = options.bitDepth ?? 8;
  header[9] = colorType;
  header[12] = options.interlace ?? 0;
  const compressed = deflateSync(raw);
  const half = compressed.length >> 1;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      ...(options.extra ?? []),
      // Split over two IDAT chunks, as encoders may.
      chunk('IDAT', compressed.subarray(0, half)),
      chunk('IDAT', compressed.subarray(half)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

describe('PNG codec', () => {
  it('round-trips RGBA pixels bit for bit, translucent ones included', async () => {
    for (const [width, height] of [
      [1, 1],
      [7, 5],
      [64, 33],
    ]) {
      const pixels = noise(width * height * 4, width);
      const file = await encodePng(pixels, width, height);
      expect([...file.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(imageSize(file)).toEqual({ width, height });
      expect(await decodePng(file)).toEqual({ width, height, pixels });
    }
  });

  it('writes valid chunks and the same file for the same pixels', async () => {
    const pixels = noise(16 * 16 * 4, 5);
    const file = await encodePng(pixels, 16, 16);
    expect(await encodePng(pixels, 16, 16)).toEqual(file);
    const view = new DataView(file.buffer);
    const types: string[] = [];
    for (let p = 8; p < file.length; ) {
      const length = view.getUint32(p);
      types.push(String.fromCharCode(...file.subarray(p + 4, p + 8)));
      expect(view.getUint32(p + 8 + length)).toBe(crc32(file.subarray(p + 4, p + 8 + length)));
      p += 12 + length;
    }
    expect(types).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect([...file.subarray(24, 29)]).toEqual([8, 6, 0, 0, 0]); // 8 bit, RGBA, not interlaced
  });

  it('compresses flat images to almost nothing', async () => {
    const pixels = new Uint8ClampedArray(512 * 512 * 4).fill(128);
    const file = await encodePng(pixels, 512, 512);
    expect(file.length).toBeLessThan(6000);
    expect((await decodePng(file))!.pixels).toEqual(pixels);
  });

  it('decodes every row filter and the 8-bit colour types of other encoders', async () => {
    const width = 9;
    const height = 11;
    const rgba = noise(width * height * 4, 3);
    expect((await decodePng(referencePng(rgba, width, height, 6)))!.pixels).toEqual(rgba);

    const rgb = noise(width * height * 3, 4);
    const fromRgb = (await decodePng(referencePng(rgb, width, height, 2)))!.pixels;
    const grey = noise(width * height, 5);
    const fromGrey = (await decodePng(referencePng(grey, width, height, 0)))!.pixels;
    const greyAlpha = noise(width * height * 2, 6);
    const fromGreyAlpha = (await decodePng(referencePng(greyAlpha, width, height, 4)))!.pixels;
    for (let p = 0; p < width * height; p++) {
      expect([...fromRgb.subarray(p * 4, p * 4 + 4)]).toEqual([rgb[p * 3], rgb[p * 3 + 1], rgb[p * 3 + 2], 255]);
      expect([...fromGrey.subarray(p * 4, p * 4 + 4)]).toEqual([grey[p], grey[p], grey[p], 255]);
      expect([...fromGreyAlpha.subarray(p * 4, p * 4 + 4)]).toEqual([greyAlpha[p * 2], greyAlpha[p * 2], greyAlpha[p * 2], greyAlpha[p * 2 + 1]]);
    }
  });

  it('leaves the PNG variants it does not read to another decoder', async () => {
    const samples = noise(4 * 4 * 4, 8);
    expect(await decodePng(referencePng(samples, 4, 4, 6, { bitDepth: 16 }))).toBeNull();
    expect(await decodePng(referencePng(samples, 4, 4, 6, { interlace: 1 }))).toBeNull();
    expect(await decodePng(referencePng(samples, 4, 4, 3))).toBeNull(); // palette
    const transparency = Buffer.from([0, 0, 0, 6, 0x74, 0x52, 0x4e, 0x53, 0, 1, 0, 2, 0, 3, 0, 0, 0, 0]); // tRNS colour key
    expect(await decodePng(referencePng(noise(4 * 4 * 3), 4, 4, 2, { extra: [transparency] }))).toBeNull();
  });

  it('rejects damaged files', async () => {
    const file = await encodePng(noise(8 * 8 * 4), 8, 8);
    await expect(decodePng(file.slice(0, 40))).rejects.toThrow('The PNG image is damaged');
    const corrupt = file.slice();
    corrupt[45] ^= 0xff;
    corrupt[50] ^= 0xff;
    await expect(decodePng(corrupt)).rejects.toThrow('The PNG image is damaged');
    await expect(decodePng(new Uint8Array(100))).rejects.toThrow('not a PNG file');
    // The data inflates to more (or less) than the header promises: a decompression bomb is cut off.
    const taller = await encodePng(noise(8 * 16 * 4), 8, 16);
    new DataView(taller.buffer).setUint32(20, 8);
    await expect(decodePng(taller)).rejects.toThrow('The PNG image is damaged');
    const shorter = await encodePng(noise(8 * 8 * 4), 8, 8);
    new DataView(shorter.buffer).setUint32(20, 16);
    await expect(decodePng(shorter)).rejects.toThrow('The PNG image is damaged');
  });
});
