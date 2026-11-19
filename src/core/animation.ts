// Keyframe animation: evaluation of a document at a frame, the pure helpers the anim.* commands use to
// edit keys, and validation of the animation in project files. DOM-free.
//
// Model (see `Animation` in types.ts): per object up to four channels (position, rotation, scale, visible),
// each a list of keys sorted by integer frame, plus one list of camera keys. `DocState.objects` always holds
// the static values; `animatedState(state, frame)` gives the document as it looks at a frame.
//
// Interpolation between a key and the next one is chosen by the FIRST of the two:
// - 'linear': straight.
// - 'smooth': the same straight path travelled with a cubic ease in and out (3t² - 2t³): it starts and ends
//   at rest and never overshoots. (Not a spline through neighbouring keys - a chain of smooth keys stops at
//   every key. Motions that must pass through keys without stopping are baked as linear keys, as
//   anim.add_motion / anim.follow_path / anim.camera_orbit do.)
// - 'step': holds the value and jumps at the next key.
// Position, scale, camera position / target / fov: per component. Rotation: the Euler XYZ keys are
// turned into quaternions and interpolated by slerp, i.e. about one fixed axis along the SHORTEST way; two
// keys that differ by more than 180° therefore turn the short way round (0° -> 270° about Y runs 90°
// backwards, 0° -> 360° does not move). Longer turns need intermediate keys less than 180° apart.
// `visible` has no in-between: it is the value of the last key at or before the frame.
// Before the first key the first value holds, after the last key the last value.
import { z } from 'zod';
import { localizeWorldOffsets } from './modifiers/worldOffsets';
import { own } from './state';
import { keyInterpolations } from './types';
import type { Animation, CameraKey, DocState, Key, KeyInterpolation, ObjectTrack, SceneObject, Transform, Vec3 } from './types';

export const DEFAULT_FPS = 24;
export const DEFAULT_FRAME_COUNT = 120;
export const MAX_FPS = 120;
export const MAX_FRAME_COUNT = 100_000;
/** Largest frame a key may be on (keys may lie beyond `frameCount`; they are just not played). */
export const MAX_KEY_FRAME = 1_000_000;
/** Largest number of keys (all channels of all objects plus camera keys) in one document. */
export const MAX_KEYS = 200_000;
export const DEFAULT_CAMERA_FOV = 40;

export const animationChannels = ['position', 'rotation', 'scale', 'visible'] as const;
export type AnimationChannel = (typeof animationChannels)[number];

export interface CameraFrame {
  position: Vec3;
  target: Vec3;
  /** Vertical field of view in degrees. */
  fov: number;
}

export function defaultAnimation(): Animation {
  return { fps: DEFAULT_FPS, frameCount: DEFAULT_FRAME_COUNT, tracks: {}, camera: [] };
}

// ---------------------------------------------------------------------------------------------------------
// Evaluation

/** Progress 0..1 between two keys after the easing of an interpolation mode (`t` = linear progress 0..1). */
export function ease(interpolation: KeyInterpolation, t: number): number {
  if (interpolation === 'linear') return t;
  if (interpolation === 'smooth') return t * t * (3 - 2 * t);
  return 0;
}

/** Index of the last key at or before `frame`, -1 if the frame is before the first key. Keys are sorted. */
function keyIndex(keys: readonly { readonly frame: number }[], frame: number): number {
  let lo = 0;
  let hi = keys.length - 1;
  if (frame < keys[0].frame) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (keys[mid].frame <= frame) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// Result of `locate` (module-level instead of a returned object: this runs for every channel of every object per frame).
let atIndex = 0;
let atProgress = 0;

/**
 * Finds the key `frame` belongs to: `atIndex` is its index and `atProgress` the eased progress towards the
 * next key - 0 when the value is simply that of the key (on a key, held before the first / after the last
 * key, or a step).
 */
function locate(keys: readonly { readonly frame: number; readonly interpolation: KeyInterpolation }[], frame: number): void {
  const i = keyIndex(keys, frame);
  atProgress = 0;
  if (i < 0) {
    atIndex = 0;
    return;
  }
  atIndex = i;
  const a = keys[i];
  if (i === keys.length - 1 || frame === a.frame || a.interpolation === 'step') return;
  const t = (frame - a.frame) / (keys[i + 1].frame - a.frame);
  atProgress = a.interpolation === 'smooth' ? t * t * (3 - 2 * t) : t;
}

function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function vec3At(keys: readonly Key<Vec3>[], frame: number): Vec3 {
  locate(keys, frame);
  return atProgress === 0 ? keys[atIndex].value : lerp3(keys[atIndex].value, keys[atIndex + 1].value, atProgress);
}

/** Unit quaternion (x, y, z, w) of Euler XYZ angles in degrees (R = Rx * Ry * Rz), written to `out` at `at`. */
function eulerQuaternion(e: Vec3, out: Float64Array, at: number): void {
  const h = Math.PI / 360;
  const c1 = Math.cos(e[0] * h);
  const s1 = Math.sin(e[0] * h);
  const c2 = Math.cos(e[1] * h);
  const s2 = Math.sin(e[1] * h);
  const c3 = Math.cos(e[2] * h);
  const s3 = Math.sin(e[2] * h);
  out[at] = s1 * c2 * c3 + c1 * s2 * s3;
  out[at + 1] = c1 * s2 * c3 - s1 * c2 * s3;
  out[at + 2] = c1 * c2 * s3 + s1 * s2 * c3;
  out[at + 3] = c1 * c2 * c3 - s1 * s2 * s3;
}

/** Degrees rounded to 1e-6, whole degrees exactly (as `matrixEuler` in transformMath.ts does). */
function tidyDegrees(radians: number): number {
  const a = Math.round(radians * (180e6 / Math.PI)) / 1e6;
  const whole = Math.round(a);
  return (Math.abs(a - whole) < 2e-6 ? whole : a) + 0;
}

/** Euler XYZ angles in degrees of a unit quaternion; the same result as `matrixEuler(quaternionMatrix(...))`. */
function quaternionEuler(x: number, y: number, z: number, w: number): Vec3 {
  const m13 = Math.max(-1, Math.min(1, 2 * (x * z + y * w)));
  if (Math.abs(m13) < 0.9999999) {
    return [
      tidyDegrees(Math.atan2(2 * (x * w - y * z), 1 - 2 * (x * x + y * y))),
      tidyDegrees(Math.asin(m13)),
      tidyDegrees(Math.atan2(2 * (z * w - x * y), 1 - 2 * (y * y + z * z))),
    ];
  }
  return [tidyDegrees(Math.atan2(2 * (y * z + x * w), 1 - 2 * (x * x + z * z))), tidyDegrees(Math.asin(m13)), 0];
}

// Key arrays are immutable, so the quaternions of a rotation channel are computed once per array.
const quaternions = new WeakMap<readonly Key<Vec3>[], Float64Array>();

function rotationAt(keys: readonly Key<Vec3>[], frame: number): Vec3 {
  locate(keys, frame);
  if (atProgress === 0) return keys[atIndex].value;
  const t = atProgress;
  let q = quaternions.get(keys);
  if (!q) {
    q = new Float64Array(keys.length * 4);
    for (let k = 0; k < keys.length; k++) eulerQuaternion(keys[k].value, q, k * 4);
    quaternions.set(keys, q);
  }
  const i = atIndex * 4;
  const j = i + 4;
  let dot = q[i] * q[j] + q[i + 1] * q[j + 1] + q[i + 2] * q[j + 2] + q[i + 3] * q[j + 3];
  // q and -q are the same rotation: take the one on the near side, which is the short way round.
  const sign = dot < 0 ? -1 : 1;
  dot *= sign;
  let wa = 1 - t;
  let wb = t;
  if (dot < 0.999999) {
    const angle = Math.acos(dot);
    const sin = Math.sin(angle);
    wa = Math.sin((1 - t) * angle) / sin;
    wb = Math.sin(t * angle) / sin;
  }
  wb *= sign;
  const x = wa * q[i] + wb * q[j];
  const y = wa * q[i + 1] + wb * q[j + 1];
  const z = wa * q[i + 2] + wb * q[j + 2];
  const w = wa * q[i + 3] + wb * q[j + 3];
  const n = Math.sqrt(x * x + y * y + z * z + w * w);
  return quaternionEuler(x / n, y / n, z / n, w / n);
}

function visibleAt(keys: readonly Key<boolean>[], frame: number): boolean {
  const i = keyIndex(keys, frame);
  return keys[i < 0 ? 0 : i].value;
}

const same3 = (a: Vec3, b: Vec3) => a === b || (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]);

/**
 * The transform of an object with this track at a (possibly fractional) frame: `transform` itself when
 * nothing differs from it, and the static arrays for channels that have no keys or equal the static value.
 */
function transformAt(track: ObjectTrack, transform: Transform, frame: number): Transform {
  let position = transform.position;
  let rotation = transform.rotation;
  let scale = transform.scale;
  if (track.position && track.position.length > 0) {
    const v = vec3At(track.position, frame);
    if (!same3(v, position)) position = v;
  }
  if (track.rotation && track.rotation.length > 0) {
    const v = rotationAt(track.rotation, frame);
    if (!same3(v, rotation)) rotation = v;
  }
  if (track.scale && track.scale.length > 0) {
    const v = vec3At(track.scale, frame);
    if (!same3(v, scale)) scale = v;
  }
  return position === transform.position && rotation === transform.rotation && scale === transform.scale ? transform : { position, rotation, scale };
}

/**
 * Transform and visibility of an object with this track at a (possibly fractional) frame. Channels
 * without keys give the static values (same array identity); if nothing differs, `transform` itself.
 */
export function evaluateTrack(track: ObjectTrack, transform: Transform, visible: boolean, frame: number): { transform: Transform; visible: boolean } {
  return { transform: transformAt(track, transform, frame), visible: track.visible && track.visible.length > 0 ? visibleAt(track.visible, frame) : visible };
}

/**
 * The object as it is shown with an animated transform. A world-space array offset is given for the static
 * transform, and the row of copies belongs to the object: when the animated rotation or scale differs from
 * the static one, the offset is replaced by its local form for the STATIC transform, so the copies turn and
 * scale rigidly with the object instead of staying along the world axes. The converted list is cached per
 * static modifier list, so it is the same on every frame and evaluateObject does not recompute during playback.
 */
function turned(obj: SceneObject, transform: Transform, visible: boolean): SceneObject {
  if (obj.modifiers.length === 0 || (transform.rotation === obj.transform.rotation && transform.scale === obj.transform.scale)) return { ...obj, transform, visible };
  return { ...obj, transform, visible, modifiers: localizeWorldOffsets(obj.modifiers, obj.transform) };
}

// What `animatedState` last returned per document state. Its objects are reused for objects whose values
// have not changed since (they rest), and the whole result when the same frame is asked for again.
const lastResult = new WeakMap<DocState, { frame: number; result: DocState }>();
// The ids of a `tracks` record (immutable), so that they are not listed again for every frame.
const trackIds = new WeakMap<object, string[]>();

/**
 * The document as it looks at a frame (may be fractional): objects with tracks get their evaluated
 * `transform` and `visible`, everything else is untouched - except that world-space array offsets of an
 * object shown with another rotation or scale than its static one are given in local form (see `turned`).
 *
 * Identity guarantees (caches in the viewport and in evaluateObject rely on them):
 * - no animation, no tracks, or no object differs from its static values at this frame: returns `state` itself;
 * - objects without a track, and animated objects whose evaluated values equal their static ones, are the same objects as in `state`;
 * - an animated object whose values did not change since the previous call for this state (it rests) is the same object as returned by that call;
 * - calling again with the same state and frame returns the same result object.
 * `selection`, `edit`, `animation` etc. are passed through, so the result is a complete DocState.
 */
export function animatedState(state: DocState, frame: number): DocState {
  const tracks = state.animation?.tracks;
  if (!tracks) return state;
  const cached = lastResult.get(state);
  if (cached && cached.frame === frame) return cached.result;
  let ids = trackIds.get(tracks);
  if (!ids) {
    ids = Object.keys(tracks);
    trackIds.set(tracks, ids);
  }
  const statics = state.objects;
  const before = cached && cached.result !== state ? cached.result.objects : null;
  let objects: Record<string, SceneObject> | null = null;
  for (let n = 0; n < ids.length; n++) {
    const id = ids[n];
    const obj = statics[id];
    // Not there, or something inherited from Object.prototype (an id such as "toString").
    if (obj === undefined || obj.id !== id) continue;
    const track = tracks[id];
    const transform = transformAt(track, obj.transform, frame);
    const visible = track.visible && track.visible.length > 0 ? visibleAt(track.visible, frame) : obj.visible;
    if (transform === obj.transform && visible === obj.visible) continue;
    const previous = before ? before[id] : undefined;
    objects ??= { ...statics };
    objects[id] =
      previous &&
      previous.visible === visible &&
      same3(previous.transform.position, transform.position) &&
      same3(previous.transform.rotation, transform.rotation) &&
      same3(previous.transform.scale, transform.scale)
        ? previous
        : turned(obj, transform, visible);
  }
  const result = objects ? { ...state, objects } : state;
  lastResult.set(state, { frame, result });
  return result;
}

/** The animated camera at a (possibly fractional) frame, or null when there are no camera keys. */
export function cameraAt(animation: Animation | undefined, frame: number): CameraFrame | null {
  const keys = animation?.camera;
  if (!keys || keys.length === 0) return null;
  locate(keys, frame);
  const a = keys[atIndex];
  if (atProgress === 0) return { position: a.position, target: a.target, fov: a.fov };
  const b = keys[atIndex + 1];
  const t = atProgress;
  return { position: lerp3(a.position, b.position, t), target: lerp3(a.target, b.target, t), fov: a.fov + (b.fov - a.fov) * t };
}

// ---------------------------------------------------------------------------------------------------------
// Summaries

function trackKeyCount(track: ObjectTrack): number {
  return (track.position?.length ?? 0) + (track.rotation?.length ?? 0) + (track.scale?.length ?? 0) + (track.visible?.length ?? 0);
}

/** Number of keys in the whole animation (all channels of all objects plus the camera keys). */
export function countKeys(animation: Animation): number {
  let n = animation.camera.length;
  for (const track of Object.values(animation.tracks)) n += trackKeyCount(track);
  return n;
}

/** Ids of the objects that have a track, in outliner order. */
export function animatedObjectIds(state: DocState): string[] {
  const tracks = state.animation?.tracks;
  if (!tracks) return [];
  return state.order.filter((id) => Object.hasOwn(tracks, id));
}

/**
 * The animation in a few numbers, for listings and status lines; null when the document has no animation
 * at all. `firstKeyFrame` / `lastKeyFrame` are null when there is no key.
 */
export function animationSummary(state: DocState) {
  const animation = state.animation;
  if (!animation) return null;
  let first = Infinity;
  let last = -Infinity;
  const see = (keys: readonly { readonly frame: number }[] | undefined) => {
    if (!keys || keys.length === 0) return;
    first = Math.min(first, keys[0].frame);
    last = Math.max(last, keys[keys.length - 1].frame);
  };
  for (const track of Object.values(animation.tracks)) for (const channel of animationChannels) see(track[channel]);
  see(animation.camera);
  return {
    fps: animation.fps,
    frameCount: animation.frameCount,
    /** Length in seconds. */
    duration: animation.frameCount / animation.fps,
    animatedObjects: Object.keys(animation.tracks).length,
    cameraKeys: animation.camera.length,
    keyCount: countKeys(animation),
    firstKeyFrame: first === Infinity ? null : first,
    lastKeyFrame: last === -Infinity ? null : last,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Editing (pure; every function returns new arrays / objects)

/** The keys with `key` put in at its frame, replacing a key that is already there. */
export function withKey<K extends { readonly frame: number }>(keys: readonly K[] | undefined, key: K): K[] {
  if (!keys || keys.length === 0) return [key];
  const i = keyIndex(keys, key.frame);
  if (i >= 0 && keys[i].frame === key.frame) return [...keys.slice(0, i), key, ...keys.slice(i + 1)];
  return [...keys.slice(0, i + 1), key, ...keys.slice(i + 1)];
}

/** The keys with everything from `fromFrame` to `toFrame` (both included) replaced by `fresh` (sorted, inside that range). */
export function replaceRange<K extends { readonly frame: number }>(keys: readonly K[] | undefined, fromFrame: number, toFrame: number, fresh: readonly K[]): K[] {
  if (!keys || keys.length === 0) return [...fresh];
  return [...keys.filter((k) => k.frame < fromFrame), ...fresh, ...keys.filter((k) => k.frame > toFrame)];
}

/** The track without empty channels, or null if no channel has a key. */
function cleanTrack(track: ObjectTrack): ObjectTrack | null {
  const clean: { -readonly [C in AnimationChannel]?: ObjectTrack[C] } = {};
  let any = false;
  for (const channel of animationChannels) {
    const keys = track[channel];
    if (!keys || keys.length === 0) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    clean[channel] = keys as any;
    any = true;
  }
  return any ? clean : null;
}

/** The animation with the object's track replaced; channels without keys are dropped, and so is a track without channels. */
export function withTrack(animation: Animation, id: string, track: ObjectTrack): Animation {
  return withTracks(animation, [[id, track]]);
}

/** `withTrack` for several objects at once. */
export function withTracks(animation: Animation, entries: Iterable<readonly [string, ObjectTrack]>): Animation {
  const tracks = { ...animation.tracks };
  for (const [id, track] of entries) {
    const clean = cleanTrack(track);
    if (clean) tracks[id] = clean;
    else delete tracks[id];
  }
  return { ...animation, tracks };
}

/** The state without tracks of objects that no longer exist (the same state if there are none). */
export function pruneAnimation(state: DocState): DocState {
  const animation = state.animation;
  if (!animation) return state;
  let tracks: Record<string, ObjectTrack> | null = null;
  for (const id of Object.keys(animation.tracks)) {
    if (Object.hasOwn(state.objects, id)) continue;
    tracks ??= { ...animation.tracks };
    delete tracks[id];
  }
  return tracks ? { ...state, animation: { ...animation, tracks } } : state;
}

/**
 * The animation with the tracks of the source objects copied to their copies ([sourceId, copyId] pairs);
 * `offset` is added to the copied position keys (the copies were moved by it). Returns the same animation
 * (or undefined) when no source is animated.
 */
export function duplicateTracks(animation: Animation | undefined, pairs: readonly (readonly [string, string])[], offset: Vec3 = [0, 0, 0]): Animation | undefined {
  if (!animation) return animation;
  let tracks: Record<string, ObjectTrack> | null = null;
  const moved = offset.some((v) => v !== 0);
  for (const [source, copy] of pairs) {
    const track = own(animation.tracks, source);
    if (!track) continue;
    tracks ??= { ...animation.tracks };
    tracks[copy] =
      moved && track.position
        ? { ...track, position: track.position.map((k) => ({ ...k, value: [k.value[0] + offset[0], k.value[1] + offset[1], k.value[2] + offset[2]] as Vec3 })) }
        : track;
  }
  return tracks ? { ...animation, tracks } : animation;
}

/**
 * A sentence for command results when a command changed the static transform or the mesh of animated
 * objects without adjusting their keys; undefined when none of the objects is animated.
 */
export function animationWarning(state: DocState, ids: readonly string[], what: string): string | undefined {
  const tracks = state.animation?.tracks;
  if (!tracks) return undefined;
  const animated = ids.filter((id) => Object.hasOwn(tracks, id));
  if (animated.length === 0) return undefined;
  const names = animated.slice(0, 3).map((id) => JSON.stringify(own(state.objects, id)?.name ?? id));
  const list = names.join(', ') + (animated.length > 3 ? ` and ${animated.length - 3} more` : '');
  return `${animated.length === 1 ? 'Object' : 'Objects'} ${list} ${animated.length === 1 ? 'has' : 'have'} animation keys: ${what}`;
}

// ---------------------------------------------------------------------------------------------------------
// Project files (untrusted input)

const finite = z.number().finite();
const vec3 = z.tuple([finite, finite, finite]);
const frame = z.number().int().min(0).max(MAX_KEY_FRAME);
const interpolation = z.enum(keyInterpolations).default('smooth');
const keyOf = <T extends z.ZodType>(value: T) => z.object({ frame, value, interpolation });
const scaleValue = vec3.refine((v) => v.every((s) => s !== 0), 'animation: a scale key must not be 0 on any axis');

/** The `animation` entry of a project file. Order and uniqueness of keys are repaired by `repairAnimation`. */
export const animationSchema = z.object({
  fps: z.number().min(1).max(MAX_FPS).default(DEFAULT_FPS),
  frameCount: z.number().int().min(1).max(MAX_FRAME_COUNT).default(DEFAULT_FRAME_COUNT),
  tracks: z
    .record(
      z.string(),
      z.object({
        position: z.array(keyOf(vec3)).optional(),
        rotation: z.array(keyOf(vec3)).optional(),
        scale: z.array(keyOf(scaleValue)).optional(),
        visible: z.array(keyOf(z.boolean())).optional(),
      }),
    )
    .default({}),
  camera: z
    .array(z.object({ frame, position: vec3, target: vec3, fov: z.number().min(1).max(179).default(DEFAULT_CAMERA_FOV), interpolation }))
    .default([]),
});

/** Sorted by frame with one key per frame (of several keys on one frame the last one in the file wins). */
function tidyKeys<K extends { readonly frame: number }>(keys: readonly K[]): K[] {
  let sorted = true;
  for (let i = 1; i < keys.length && sorted; i++) sorted = keys[i - 1].frame < keys[i].frame;
  if (sorted) return [...keys];
  const byFrame = new Map<number, K>();
  for (const key of keys) byFrame.set(key.frame, key);
  return [...byFrame.values()].sort((a, b) => a.frame - b.frame);
}

/**
 * Makes a parsed `animation` entry consistent with the document: tracks of objects that do not exist are
 * dropped, keys are sorted and made unique per frame, empty channels and tracks are removed. Throws when
 * the file holds more than MAX_KEYS keys.
 */
export function repairAnimation(parsed: z.infer<typeof animationSchema>, objects: Readonly<Record<string, unknown>>): Animation {
  let count = parsed.camera.length;
  for (const track of Object.values(parsed.tracks)) count += trackKeyCount(track);
  if (count > MAX_KEYS) throw new Error(`the animation has ${count} keys, more than the ${MAX_KEYS} that are allowed`);
  const tracks: Record<string, ObjectTrack> = {};
  for (const id of Object.keys(parsed.tracks)) {
    if (!Object.hasOwn(objects, id)) continue;
    const track = parsed.tracks[id];
    const clean = cleanTrack({
      ...(track.position ? { position: tidyKeys(track.position) } : {}),
      ...(track.rotation ? { rotation: tidyKeys(track.rotation) } : {}),
      ...(track.scale ? { scale: tidyKeys(track.scale) } : {}),
      ...(track.visible ? { visible: tidyKeys(track.visible) } : {}),
    });
    if (clean) tracks[id] = clean;
  }
  return { fps: parsed.fps, frameCount: parsed.frameCount, tracks, camera: tidyKeys(parsed.camera) };
}
