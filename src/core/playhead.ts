// The playhead of the timeline: pure maths for playback, key navigation and the timeline's own
// commands (which keys a row has, where a dragged pose is written). DOM-free.
import { animationChannels, cameraAt, type AnimationChannel } from './animation';
import { own } from './state';
import type { Animation, ObjectTrack, Transform, Vec3 } from './types';

/** The last frame of an animation of `frameCount` frames. */
export const lastFrame = (frameCount: number) => Math.max(0, Math.floor(frameCount) - 1);

/** A whole frame inside 0 .. frameCount - 1. */
export function clampFrame(frame: number, frameCount: number): number {
  if (Number.isNaN(frame)) return 0;
  return Math.min(lastFrame(frameCount), Math.max(0, Math.round(frame)));
}

/** Time of a frame in seconds. */
export const frameTime = (frame: number, fps: number) => frame / fps;

/**
 * Where playback is after `elapsed` seconds of real time, having started on `startFrame`: playback runs at
 * `fps` whatever the display manages, so frames are dropped rather than played late. Without `loop` it
 * stops on the last frame (`ended`); with it, it wraps round to frame 0.
 */
export function playbackFrame(startFrame: number, elapsed: number, fps: number, frameCount: number, loop: boolean): { frame: number; ended: boolean } {
  const count = Math.max(1, Math.floor(frameCount));
  // The small bias keeps e.g. 0.1 s * 30 fps from landing on 2.9999999.
  const advanced = Math.floor(startFrame + Math.max(0, elapsed) * fps + 1e-6);
  if (loop) return { frame: ((advanced % count) + count) % count, ended: false };
  return advanced >= count - 1 ? { frame: count - 1, ended: true } : { frame: Math.max(0, advanced), ended: false };
}

/** `m:ss.ff` style reading of a time, e.g. 0:02.50 for 2.5 s (two decimals of a second). */
export function formatSeconds(seconds: number, locale: string): string {
  const total = Math.max(0, seconds);
  const minutes = Math.floor(total / 60);
  const rest = total - minutes * 60;
  const text = rest.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2, minimumIntegerDigits: 2, useGrouping: false });
  return `${minutes}:${text}`;
}

// ---------------------------------------------------------------------------------------------------------
// Keys of a timeline row

type Frames = readonly { readonly frame: number }[];

/** The channels of a track that have keys, as their key lists. */
export function trackChannels(track: ObjectTrack | undefined): Frames[] {
  if (!track) return [];
  const lists: Frames[] = [];
  for (const channel of animationChannels) {
    const keys = track[channel];
    if (keys && keys.length > 0) lists.push(keys);
  }
  return lists;
}

/** Index of the first key on `frame` or later (keys are sorted); `keys.length` if there is none. */
export function lowerBound(keys: Frames, frame: number): number {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].frame < frame) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export const hasKeyAt = (keys: Frames, frame: number) => {
  const i = lowerBound(keys, frame);
  return i < keys.length && keys[i].frame === frame;
};

/** The first frame in `from .. to` (both included) on which one of the lists has a key, or null. */
export function firstKeyIn(lists: readonly Frames[], from: number, to: number): number | null {
  let best: number | null = null;
  for (const keys of lists) {
    const i = lowerBound(keys, from);
    if (i < keys.length && keys[i].frame <= to && (best === null || keys[i].frame < best)) best = keys[i].frame;
  }
  return best;
}

/** The nearest key frame after (`direction` 1) or before (-1) `frame` in any of the lists, or null. */
export function neighbourKey(lists: readonly Frames[], frame: number, direction: 1 | -1): number | null {
  let best: number | null = null;
  for (const keys of lists) {
    if (direction === 1) {
      const i = lowerBound(keys, frame + 1);
      if (i < keys.length && (best === null || keys[i].frame < best)) best = keys[i].frame;
    } else {
      const i = lowerBound(keys, frame) - 1;
      if (i >= 0 && (best === null || keys[i].frame > best)) best = keys[i].frame;
    }
  }
  return best;
}

/** The key lists the transport's "previous / next key" look at: the tracks of these objects and the camera. */
export function navigationLists(animation: Animation | undefined, ids: readonly string[]): Frames[] {
  if (!animation) return [];
  const lists: Frames[] = [];
  for (const id of ids) lists.push(...trackChannels(own(animation.tracks, id)));
  if (animation.camera.length > 0) lists.push(animation.camera);
  return lists;
}

// ---------------------------------------------------------------------------------------------------------
// Auto-key

export const transformChannels = ['position', 'rotation', 'scale'] as const satisfies readonly AnimationChannel[];
export type TransformChannel = (typeof transformChannels)[number];

/**
 * Where a pose given for an object goes: channels that already have keys get a key (`keyed`), channels
 * without keys change the static transform (`plain`). With `autoKey` off every given channel is keyed.
 */
export function splitPose(
  track: ObjectTrack | undefined,
  pose: Partial<Record<TransformChannel, Vec3>>,
  autoKey: boolean,
): { keyed: TransformChannel[]; plain: TransformChannel[] } {
  const keyed: TransformChannel[] = [];
  const plain: TransformChannel[] = [];
  for (const channel of transformChannels) {
    if (pose[channel] === undefined) continue;
    const animated = (track?.[channel]?.length ?? 0) > 0;
    (!autoKey || animated ? keyed : plain).push(channel);
  }
  return { keyed, plain };
}

const same3 = (a: Vec3, b: Vec3) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/** The channels in which `next` differs from `shown`, with the new values. */
export function poseChange(shown: Transform, next: Partial<Transform>): Partial<Record<TransformChannel, Vec3>> {
  const change: Partial<Record<TransformChannel, Vec3>> = {};
  for (const channel of transformChannels) {
    const value = next[channel];
    if (value && !same3(value, shown[channel])) change[channel] = value;
  }
  return change;
}

// ---------------------------------------------------------------------------------------------------------
// Pictures of a frame (view.screenshot, render.image)

export const FRAME_HINT =
  '"frame" renders the document as its animation shows it at that frame (may be fractional, e.g. 12.5; frames start at 0, time = frame / fps, see anim_get) instead of the static pose: animated objects are where their keys put them. ' +
  'With "frame", a document that has camera keys is looked at through its ANIMATED camera at that frame unless you give a view yourself; "useAnimationCamera": false keeps the normal camera, true insists on the animated one (an error if there are no camera keys). ' +
  'The playhead the user sees in the timeline does not move.';

/**
 * The animated camera a picture of `frame` is taken through, or null for the camera the picture would
 * have anyway. `explicitView`: the caller chose a view or camera themselves. Throws when the animated
 * camera is insisted on but cannot be used.
 */
export function pictureCamera(animation: Animation | undefined, frame: number | undefined, useAnimationCamera: boolean | undefined, explicitView: boolean) {
  if (useAnimationCamera === false) return null;
  if (frame === undefined) {
    if (useAnimationCamera) throw new Error('useAnimationCamera needs "frame": the animated camera is different at every frame.');
    return null;
  }
  const camera = cameraAt(animation, frame);
  if (useAnimationCamera) {
    if (explicitView) throw new Error('useAnimationCamera cannot be combined with a view or camera of your own: leave out "view" / "camera" / "views", or set useAnimationCamera to false.');
    if (!camera) throw new Error('The document has no camera keys, so there is no animated camera (anim_set_camera_key or anim_camera_orbit create them). Leave out useAnimationCamera to use the normal camera.');
  }
  return explicitView ? null : camera;
}
