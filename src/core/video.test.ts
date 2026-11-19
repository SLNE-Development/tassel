import { describe, expect, it } from 'vitest';
import { MAX_VIDEO_BYTES, defaultBitrate, planVideo } from './video';

const base = { fps: 24, frameCount: 120, width: 1280, height: 720, format: 'mp4' as const };

describe('planVideo', () => {
  it('defaults to the whole animation', () => {
    const plan = planVideo(base);
    expect(plan).toMatchObject({ fromFrame: 0, toFrame: 119, frames: 120, fps: 24, seconds: 5, width: 1280, height: 720, format: 'mp4', warnings: [] });
    expect(plan.bitrate).toBe(defaultBitrate(1280, 720, 24));
  });

  it('counts both ends of the range', () => {
    expect(planVideo({ ...base, fromFrame: 10, toFrame: 10 })).toMatchObject({ frames: 1, seconds: 1 / 24 });
    expect(planVideo({ ...base, fps: 30, frameCount: 90, fromFrame: 0, toFrame: 89 })).toMatchObject({ frames: 90, seconds: 3 });
    expect(planVideo({ ...base, fromFrame: 24 })).toMatchObject({ fromFrame: 24, toFrame: 119, frames: 96, seconds: 4 });
  });

  it('rounds odd sizes to even ones and says so', () => {
    const plan = planVideo({ ...base, width: 641, height: 359 });
    expect([plan.width, plan.height]).toEqual([642, 360]);
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toMatch(/641 x 359 was rounded to 642 x 360/);
    expect(planVideo({ ...base, width: 4095, height: 64 }).width).toBe(4096);
  });

  it('refuses ranges outside the animation', () => {
    expect(() => planVideo({ ...base, toFrame: 120 })).toThrow(/beyond the end of the animation.*anim\.set_range \{ frameCount: 121 \}/);
    expect(() => planVideo({ ...base, fromFrame: 500 })).toThrow(/beyond the end/);
    expect(() => planVideo({ ...base, fromFrame: 20, toFrame: 10 })).toThrow(/must not be before/);
    expect(() => planVideo({ ...base, fromFrame: -1 })).toThrow(/whole frame number/);
    expect(() => planVideo({ ...base, toFrame: 1.5 })).toThrow(/whole frame number/);
  });

  it('refuses sizes and bitrates out of range', () => {
    expect(() => planVideo({ ...base, width: 32 })).toThrow(/width must be between 64 and 4096/);
    expect(() => planVideo({ ...base, height: 5000 })).toThrow(/height must be between/);
    expect(() => planVideo({ ...base, width: NaN })).toThrow(/width/);
    expect(() => planVideo({ ...base, bitrate: 10 })).toThrow(/bitrate must be between/);
    expect(() => planVideo({ ...base, bitrate: Infinity })).toThrow(/bitrate/);
  });

  it('caps frames x pixels at ten minutes of 4K', () => {
    // Exactly the limit: 10 minutes of 3840 x 2160 at 30 fps (a low bitrate keeps the file within its own limit).
    const most = { fps: 30, frameCount: 18000, width: 3840, height: 2160, format: 'mp4' as const, bitrate: 1_000_000 };
    expect(planVideo(most).frames).toBe(18000);
    expect(() => planVideo({ ...most, frameCount: 18001 })).toThrow(/too large.*at most 18000 frames \(600 s\)/);
    // Smaller pictures may run longer.
    expect(planVideo({ fps: 30, frameCount: 100000, width: 640, height: 360, format: 'webm', bitrate: 400_000 }).frames).toBe(100000);
  });

  it('caps the file size by bitrate and length and says what would fit', () => {
    const long = { fps: 30, frameCount: 30 * 600, width: 1920, height: 1080, format: 'mp4' as const };
    // 10 minutes at the default 7.5 Mbit/s would be 560 MB.
    expect(() => planVideo(long)).toThrow(/would be about \d+ MB.*more than the 256 MB.*bitrate of at most \d+/);
    const fits = Math.floor((MAX_VIDEO_BYTES * 8) / 600);
    expect(planVideo({ ...long, bitrate: fits }).bitrate).toBe(fits);
  });

  it('scales the default bitrate with size and frame rate, within bounds', () => {
    expect(defaultBitrate(1280, 720, 30)).toBe(3_317_760);
    expect(defaultBitrate(64, 64, 1)).toBe(1_000_000);
    expect(defaultBitrate(4096, 4096, 120)).toBe(60_000_000);
  });
});
