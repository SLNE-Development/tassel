import { describe, expect, it } from 'vitest';
import { avcLevel, codecCandidates, fallbackNote, vp9Level } from './codecs';

describe('video codecs', () => {
  it('picks the H.264 level by picture size and frame rate', () => {
    expect(avcLevel(640, 360, 30)).toBe(30);
    expect(avcLevel(1280, 720, 30)).toBe(31);
    expect(avcLevel(1280, 720, 60)).toBe(32);
    expect(avcLevel(1920, 1080, 30)).toBe(40);
    expect(avcLevel(1920, 1080, 60)).toBe(42);
    expect(avcLevel(3840, 2160, 30)).toBe(51);
    expect(avcLevel(3840, 2160, 60)).toBe(52);
    expect(avcLevel(4096, 4096, 120)).toBe(62);
  });

  it('picks the VP9 level', () => {
    expect(vp9Level(640, 360, 30)).toBe(30);
    expect(vp9Level(1280, 720, 30)).toBe(31);
    expect(vp9Level(1920, 1080, 30)).toBe(40);
    expect(vp9Level(3840, 2160, 30)).toBe(50);
  });

  it('prefers H.264 for MP4 and falls back to VP9 and AV1', () => {
    const list = codecCandidates('mp4', 1920, 1080, 30);
    expect(list.map((c) => c.codec)).toEqual(['avc1.640028', 'avc1.4d0028', 'avc1.42e028', 'vp09.00.40.08', 'av01.0.08M.08']);
    expect(list.map((c) => c.mux)).toEqual(['avc', 'avc', 'avc', 'vp9', 'av1']);
    expect(codecCandidates('mp4', 640, 360, 24)[0].codec).toBe('avc1.64001e');
    expect(codecCandidates('mp4', 3840, 2160, 30)[0].codec).toBe('avc1.640033');
  });

  it('prefers VP9 for WebM', () => {
    const list = codecCandidates('webm', 1280, 720, 30);
    expect(list.map((c) => [c.name, c.mux])).toEqual([
      ['VP9', 'V_VP9'],
      ['VP8', 'V_VP8'],
      ['AV1', 'V_AV1'],
    ]);
  });

  it('explains a fallback and stays silent for the first choice', () => {
    const [h264, , , vp9] = codecCandidates('mp4', 1280, 720, 30);
    expect(fallbackNote('mp4', h264)).toBeNull();
    expect(fallbackNote('mp4', vp9)).toMatch(/no H\.264 encoder.*encoded as VP9/);
    const [webmVp9, vp8] = codecCandidates('webm', 1280, 720, 30);
    expect(fallbackNote('webm', webmVp9)).toBeNull();
    expect(fallbackNote('webm', vp8)).toMatch(/encoded as VP8/);
  });
});
