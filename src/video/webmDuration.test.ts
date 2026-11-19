import { describe, expect, it } from 'vitest';
import { fixWebmDuration } from './webmDuration';

/** A stand-in for a WebM header: some bytes, then the Duration element with `value`. */
function header(value: number, at = 40, size = 200): ArrayBuffer {
  const buffer = new ArrayBuffer(size);
  const bytes = new Uint8Array(buffer);
  bytes.fill(0x11);
  bytes.set([0x44, 0x89, 0x88], at);
  new DataView(buffer).setFloat64(at + 3, value);
  return buffer;
}

describe('fixWebmDuration', () => {
  it('replaces the start time of the last frame by the real length', () => {
    // 72 frames at 24 fps: the muxer wrote 2958 ms.
    const buffer = header(2958);
    expect(fixWebmDuration(buffer, 3000, 1000 / 24)).toBe(true);
    expect(new DataView(buffer).getFloat64(43)).toBe(3000);
    // Nothing else changed.
    expect(new Uint8Array(buffer)[39]).toBe(0x11);
    expect(new Uint8Array(buffer)[51]).toBe(0x11);
  });

  it('leaves a file alone whose duration is not what the muxer writes', () => {
    for (const value of [3000.5, 100, -1, NaN]) {
      const buffer = header(value);
      expect(fixWebmDuration(buffer, 3000, 1000 / 24)).toBe(false);
      expect(Object.is(new DataView(buffer).getFloat64(43), value)).toBe(true);
    }
  });

  it('does nothing without the element, in tiny buffers, or far into the file', () => {
    expect(fixWebmDuration(new ArrayBuffer(0), 3000, 40)).toBe(false);
    expect(fixWebmDuration(new ArrayBuffer(8), 3000, 40)).toBe(false);
    expect(fixWebmDuration(new Uint8Array(500).fill(0x44).buffer, 3000, 40)).toBe(false);
    expect(fixWebmDuration(header(2958, 5000, 6000), 3000, 1000 / 24)).toBe(false);
    // A single frame: the muxer wrote 0.
    const one = header(0);
    expect(fixWebmDuration(one, 1000 / 24, 1000 / 24)).toBe(true);
  });
});
