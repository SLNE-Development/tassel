import { describe, expect, it } from 'vitest';
import { clampFrame, firstKeyIn, formatSeconds, frameTime, hasKeyAt, lowerBound, navigationLists, neighbourKey, pictureCamera, playbackFrame, poseChange, splitPose, trackChannels } from './playhead';
import type { Animation, CameraKey, Key, Vec3 } from './types';

const keys = (...frames: number[]): Key<Vec3>[] => frames.map((frame) => ({ frame, value: [frame, 0, 0], interpolation: 'linear' }));
const cameraKey = (frame: number): CameraKey => ({ frame, position: [frame, 2, 5], target: [0, 0, 0], fov: 40, interpolation: 'linear' });

describe('playhead maths', () => {
  it('clamps to whole frames inside the animation', () => {
    expect(clampFrame(-3, 120)).toBe(0);
    expect(clampFrame(12.4, 120)).toBe(12);
    expect(clampFrame(12.5, 120)).toBe(13);
    expect(clampFrame(500, 120)).toBe(119);
    expect(clampFrame(Infinity, 120)).toBe(119);
    expect(clampFrame(NaN, 120)).toBe(0);
    expect(clampFrame(5, 1)).toBe(0);
  });

  it('turns frames into time', () => {
    expect(frameTime(48, 24)).toBe(2);
    expect(frameTime(15, 30)).toBe(0.5);
    expect(formatSeconds(2.5, 'en')).toBe('0:02.50');
    expect(formatSeconds(2.5, 'de')).toBe('0:02,50');
    expect(formatSeconds(75.04, 'en')).toBe('1:15.04');
  });

  it('plays in real time and drops frames instead of slowing down', () => {
    // 24 fps: after 1 s the playhead is 24 frames on, however few pictures were shown in between.
    expect(playbackFrame(0, 1, 24, 120, false)).toEqual({ frame: 24, ended: false });
    expect(playbackFrame(10, 0.5, 24, 120, false)).toEqual({ frame: 22, ended: false });
    // A slow display (one picture every 0.3 s) skips frames.
    expect([0.3, 0.6, 0.9].map((s) => playbackFrame(0, s, 30, 120, false).frame)).toEqual([9, 18, 27]);
    // 0.1 s at 30 fps is frame 3, not 2.9999.
    expect(playbackFrame(0, 0.1, 30, 120, false).frame).toBe(3);
    expect(playbackFrame(0, 0, 24, 120, false).frame).toBe(0);
  });

  it('stops on the last frame or loops', () => {
    expect(playbackFrame(0, 5, 24, 120, false)).toEqual({ frame: 119, ended: true });
    expect(playbackFrame(0, 119 / 24, 24, 120, false)).toEqual({ frame: 119, ended: true });
    expect(playbackFrame(0, 5, 24, 120, true)).toEqual({ frame: 0, ended: false });
    expect(playbackFrame(100, 1, 24, 120, true)).toEqual({ frame: 4, ended: false });
    expect(playbackFrame(0, 12.5, 24, 120, true).frame).toBe(60);
    // A one-frame animation has nowhere to go.
    expect(playbackFrame(0, 3, 24, 1, true)).toEqual({ frame: 0, ended: false });
    expect(playbackFrame(0, 3, 24, 1, false)).toEqual({ frame: 0, ended: true });
  });
});

describe('keys of a row', () => {
  const a = keys(0, 10, 20, 40);
  const b = keys(5, 20, 100);

  it('finds keys by binary search', () => {
    expect(lowerBound(a, 0)).toBe(0);
    expect(lowerBound(a, 11)).toBe(2);
    expect(lowerBound(a, 41)).toBe(4);
    expect(hasKeyAt(a, 20)).toBe(true);
    expect(hasKeyAt(a, 21)).toBe(false);
    expect(hasKeyAt([], 0)).toBe(false);
  });

  it('finds the first key in a range and the neighbours of a frame', () => {
    expect(firstKeyIn([a, b], 1, 9)).toBe(5);
    expect(firstKeyIn([a, b], 41, 99)).toBeNull();
    expect(firstKeyIn([a, b], 41, 100)).toBe(100);
    expect(neighbourKey([a, b], 10, 1)).toBe(20);
    expect(neighbourKey([a, b], 10, -1)).toBe(5);
    expect(neighbourKey([a, b], 0, -1)).toBeNull();
    expect(neighbourKey([a, b], 100, 1)).toBeNull();
    expect(neighbourKey([a, b], 7, 1)).toBe(10);
    expect(neighbourKey([], 7, 1)).toBeNull();
  });

  it('lists the channels with keys, and what the transport steps through', () => {
    expect(trackChannels(undefined)).toEqual([]);
    expect(trackChannels({ position: a, rotation: [], scale: b })).toEqual([a, b]);
    const animation: Animation = { fps: 24, frameCount: 120, tracks: { one: { position: a }, two: { scale: b } }, camera: [cameraKey(33)] };
    const lists = navigationLists(animation, ['one', 'toString', 'missing']);
    expect(lists).toHaveLength(2);
    expect(neighbourKey(lists, 20, 1)).toBe(33);
    expect(navigationLists(undefined, ['one'])).toEqual([]);
  });
});

describe('auto-key', () => {
  const pose = { position: [1, 2, 3] as Vec3, rotation: [0, 90, 0] as Vec3 };

  it('keys animated channels and writes the others to the static transform', () => {
    expect(splitPose({ position: keys(0, 10) }, pose, true)).toEqual({ keyed: ['position'], plain: ['rotation'] });
    expect(splitPose({ rotation: keys(0) }, pose, true)).toEqual({ keyed: ['rotation'], plain: ['position'] });
    expect(splitPose(undefined, pose, true)).toEqual({ keyed: [], plain: ['position', 'rotation'] });
    // An empty channel is not animated.
    expect(splitPose({ position: [] }, { position: [1, 2, 3] }, true)).toEqual({ keyed: [], plain: ['position'] });
  });

  it('keys every given channel without auto-key', () => {
    expect(splitPose(undefined, pose, false)).toEqual({ keyed: ['position', 'rotation'], plain: [] });
    expect(splitPose({ scale: keys(0) }, { scale: [2, 2, 2] }, false)).toEqual({ keyed: ['scale'], plain: [] });
  });

  it('reports only the channels a drag changed', () => {
    const shown = { position: [0, 0, 0] as Vec3, rotation: [0, 0, 0] as Vec3, scale: [1, 1, 1] as Vec3 };
    expect(poseChange(shown, { position: [0, 0, 0], rotation: [0, 45, 0] })).toEqual({ rotation: [0, 45, 0] });
    expect(poseChange(shown, { position: [1, 0, 0], scale: [1, 1, 1] })).toEqual({ position: [1, 0, 0] });
    expect(poseChange(shown, {})).toEqual({});
  });
});

describe('camera of a picture at a frame', () => {
  const animation: Animation = { fps: 24, frameCount: 120, tracks: {}, camera: [cameraKey(0), cameraKey(10)] };
  const still: Animation = { fps: 24, frameCount: 120, tracks: {}, camera: [] };

  it('is the animated camera by default when a frame is given and nothing else was chosen', () => {
    expect(pictureCamera(animation, 5, undefined, false)).toEqual({ position: [5, 2, 5], target: [0, 0, 0], fov: 40 });
    expect(pictureCamera(animation, 2.5, undefined, false)?.position).toEqual([2.5, 2, 5]);
    expect(pictureCamera(animation, 5, undefined, true)).toBeNull();
    expect(pictureCamera(animation, undefined, undefined, false)).toBeNull();
    expect(pictureCamera(still, 5, undefined, false)).toBeNull();
    expect(pictureCamera(undefined, 5, undefined, false)).toBeNull();
    expect(pictureCamera(animation, 5, false, false)).toBeNull();
  });

  it('refuses the animated camera where it cannot be used', () => {
    expect(pictureCamera(animation, 5, true, false)?.position).toEqual([5, 2, 5]);
    expect(() => pictureCamera(animation, undefined, true, false)).toThrow(/needs "frame"/);
    expect(() => pictureCamera(animation, 5, true, true)).toThrow(/cannot be combined/);
    expect(() => pictureCamera(still, 5, true, false)).toThrow(/no camera keys/);
  });
});
