// Keyframe animation commands: objects that move, turn, grow and appear over time, and an animated camera.
// The model and its evaluation are in core/animation.ts; this file edits keys and answers queries.
import { z } from 'zod';
import {
  DEFAULT_CAMERA_FOV,
  MAX_FPS,
  MAX_FRAME_COUNT,
  MAX_KEYS,
  MAX_KEY_FRAME,
  animatedObjectIds,
  animatedState,
  animationChannels,
  animationSummary,
  cameraAt,
  countKeys,
  defaultAnimation,
  ease,
  replaceRange,
  withKey,
  withTracks,
  type AnimationChannel,
} from '../animation';
import { describeBounds, objectWorldBounds, worldBounds } from '../bounds';
import { objectsInGroup } from '../groups';
import { initModifiers } from '../modifiers/evaluate';
import { resolveGroupId, resolveObjectIds } from '../refs';
import { own } from '../state';
import { eulerMatrix, rotateAbout, roundVec3, scaleAbout } from '../transformMath';
import { keyInterpolations } from '../types';
import type { Animation, CameraKey, DocState, Key, ObjectTrack, Transform, Vec3 } from '../types';
import { defineCommand, docState, updateDocState, type CommandContext } from './registry';

/** Baked rotations get a key at least every this many degrees ... */
const MAX_BAKE_ANGLE = 5;
/** ... and often enough that an object never leaves its arc by more than this many meters (down to MIN_BAKE_ANGLE per key). */
const BAKE_TOLERANCE = 0.001;
const MIN_BAKE_ANGLE = 0.25;
/** Baked eased ('smooth') motions get a key at least every 1/32 of their duration, so that the easing is followed closely. */
const EASE_SEGMENTS = 32;
/** A camera orbit gets a key at least every this many degrees (the camera then stays within 0.02 % of the radius). */
const ORBIT_ANGLE = 2;

const num = z.number().finite();
const vec3 = z.tuple([num, num, num]);
const frameParam = z.number().int().min(0).max(MAX_KEY_FRAME);
const interpolationParam = z
  .enum(keyInterpolations)
  .default('smooth')
  .describe("How the value travels from this key to the NEXT key: 'linear' = constant speed, 'smooth' = ease in and out (starts and ends at rest), 'step' = hold, then jump.");

const TIME_HINT = 'Frames are integers starting at 0; time in seconds = frame / fps (see anim.get for fps and frameCount).';
const refHint = 'Each entry is an object id, an exact object name or a glob pattern with * and ? (case-sensitive); a pattern stands for all objects it matches.';
const idsParam = z.array(z.string()).optional().describe(`Objects. ${refHint} Default (if groupId is not given either): the current selection.`);
const groupParam = z.string().optional().describe('Group id or group name: all objects inside it, including nested groups, are included.');

const toVec3 = (s: number | Vec3): Vec3 => (typeof s === 'number' ? [s, s, s] : s);

/** The objects a command acts on: the given references plus everything inside the group; with neither, the selection. */
function targets(state: DocState, ids: readonly string[] | undefined, groupId: string | undefined): string[] {
  if (ids === undefined && groupId === undefined) {
    if (state.selection.length === 0) throw new Error('No objects given (ids or groupId) and nothing is selected');
    return [...state.selection];
  }
  const result = new Set(resolveObjectIds(state, ids ?? []));
  if (groupId !== undefined) for (const id of objectsInGroup(state, resolveGroupId(state, groupId))) result.add(id);
  if (result.size === 0) throw new Error(groupId !== undefined ? 'The group contains no objects' : 'The list of objects is empty');
  return [...result];
}

/**
 * Picks the objects and makes sure their evaluated meshes (needed for bounding boxes) are final: boolean
 * modifiers need the WASM engine, which loads asynchronously (a load failure leaves them skipped, as everywhere else).
 */
async function settle(ctx: CommandContext, pick: (state: DocState) => string[]): Promise<{ state: DocState; ids: string[] }> {
  const state = docState(ctx);
  const ids = pick(state);
  if (!ids.some((id) => state.objects[id].modifiers.some((m) => m.type === 'boolean' && m.enabled))) return { state, ids };
  await initModifiers().catch(() => {});
  const now = docState(ctx);
  return { state: now, ids: pick(now) };
}

const animationOf = (state: DocState): Animation => state.animation ?? defaultAnimation();

/** Stores the animation (one undo step) after checking the document-wide key limit. */
function commit(ctx: CommandContext, animation: Animation): void {
  const count = countKeys(animation);
  if (count > MAX_KEYS) {
    throw new Error(`This would give the animation ${count} keys, more than the ${MAX_KEYS} that are allowed. Use fewer objects, a shorter frame range, or remove keys with anim.clear.`);
  }
  updateDocState(ctx, (s) => ({ ...s, animation }));
}

/** `{ warnings }` when keys were written beyond the end of the animation range. */
function rangeWarning(animation: Animation, lastFrame: number): { warnings?: string[] } {
  if (lastFrame < animation.frameCount) return {};
  return {
    warnings: [
      `Frame ${lastFrame} is beyond the end of the animation (frameCount ${animation.frameCount} = frames 0..${animation.frameCount - 1}), so it is not played or exported. Extend it with anim.set_range { frameCount: ${lastFrame + 1} }.`,
    ],
  };
}

const seconds = (animation: Animation, frame: number) => Math.round((frame / animation.fps) * 1e6) / 1e6;

/** Centre of the objects' combined world bounding box in `pose`, or the mean of their positions if they have no vertices. */
function unitBounds(pose: DocState, ids: readonly string[]): { center: Vec3; min: Vec3 } {
  const bounds = worldBounds(pose, ids);
  if (bounds) return { center: describeBounds(bounds).center, min: bounds.min };
  const center = roundVec3([0, 1, 2].map((a) => ids.reduce((sum, id) => sum + pose.objects[id].transform.position[a], 0) / ids.length));
  return { center, min: center };
}

/**
 * The frames at which a baked motion from `fromFrame` to `toFrame` gets keys, each with its progress `s`
 * (0..1, eased for `smooth`): as few as possible such that `s` grows by at most `maxStep` from key to key
 * (as far as whole frames allow) and, for an eased motion, a key comes at least every 1/32 of the duration.
 * Always includes both ends.
 */
function bakeFrames(fromFrame: number, toFrame: number, smooth: boolean, maxStep: number): { frame: number; s: number }[] {
  const span = toFrame - fromFrame;
  const progress = (f: number) => (smooth ? ease('smooth', (f - fromFrame) / span) : (f - fromFrame) / span);
  const maxFrames = smooth ? span / EASE_SEGMENTS : Infinity;
  const out = [{ frame: fromFrame, s: 0 }];
  let lastFrame = fromFrame;
  let lastS = 0;
  for (let f = fromFrame + 1; f < toFrame; f++) {
    // A key is due here if the next frame would already be too far from the last key.
    if (progress(f + 1) - lastS > maxStep + 1e-12 || f + 1 - lastFrame > maxFrames + 1e-9) {
      lastFrame = f;
      lastS = progress(f);
      out.push({ frame: f, s: lastS });
    }
  }
  out.push({ frame: toFrame, s: 1 });
  return out;
}

type TrackDraft = { -readonly [C in AnimationChannel]?: ObjectTrack[C] };

const channelParam = (what: string) =>
  z
    .union([vec3, z.literal(true)])
    .optional()
    .describe(`${what}, or true to key the object's current static value.`);

const keyOut = <T>(k: Key<T>) => ({ frame: k.frame, value: k.value, interpolation: k.interpolation });

export const animCommands = [
  defineCommand({
    id: 'anim.set_range',
    title: 'Animationsbereich festlegen',
    description:
      'Set the frame rate and/or the length of the animation of the document. `fps` = frames per second (1..120, default 24), `frameCount` = number of frames (1..100000, default 120): ' +
      'the animation plays and exports the frames 0 .. frameCount - 1, so its duration in seconds is frameCount / fps (e.g. 5 s at 24 fps = frameCount 120). ' +
      'Keys stay on their frame numbers: changing fps changes how fast they play, it does not move them. Shrinking frameCount keeps the keys beyond the new end (they are just not played) and reports them as `keysBeyondEnd`. ' +
      'Returns fps, frameCount, duration (seconds), animatedObjects, cameraKeys, keyCount, firstKeyFrame, lastKeyFrame. One undo step.',
    params: z.object({
      fps: z.number().min(1).max(MAX_FPS).optional().describe('Frames per second.'),
      frameCount: z.number().int().min(1).max(MAX_FRAME_COUNT).optional().describe('Length in frames; the last frame is frameCount - 1.'),
    }),
    run(ctx, p) {
      if (p.fps === undefined && p.frameCount === undefined) throw new Error('Give at least one of fps or frameCount');
      const current = animationOf(docState(ctx));
      const animation: Animation = { ...current, fps: p.fps ?? current.fps, frameCount: p.frameCount ?? current.frameCount };
      if (animation.fps !== current.fps || animation.frameCount !== current.frameCount || !docState(ctx).animation) commit(ctx, animation);
      let beyond = animation.camera.filter((k) => k.frame >= animation.frameCount).length;
      for (const track of Object.values(animation.tracks)) {
        for (const channel of animationChannels) beyond += (track[channel] ?? []).filter((k) => k.frame >= animation.frameCount).length;
      }
      return {
        ...animationSummary(docState(ctx)),
        keysBeyondEnd: beyond,
        ...(beyond > 0 ? { warnings: [`${beyond} keys lie on frames beyond the new end (frame ${animation.frameCount - 1}); they are kept but not played.`] } : {}),
      };
    },
  }),

  defineCommand({
    id: 'anim.set_key',
    title: 'Keyframe setzen',
    description:
      `Set keyframes on objects at one frame. ${TIME_HINT} ` +
      'Channels: `position` (WORLD space, meters, Y up - the object origin), `rotation` (Euler XYZ in degrees), `scale` ([x, y, z] factors, none 0) and `visible` (true / false; visibility switches exactly at its keys, there is no fading). ' +
      'Give a value to key that value on EVERY target object, or `true` (position / rotation / scale) to key each object\'s own current static value. ' +
      'With no channel at all, position, rotation and scale of each object are keyed at their current static values - "remember the pose as it is now at this frame". ' +
      'A key already on that frame in the same channel is replaced. `interpolation` says how the value gets from this key to the next one (default smooth). ' +
      'Between keys the value is interpolated, before the first key the first value holds, after the last key the last value; channels without keys keep the static value. ' +
      'Rotation is interpolated along the SHORTEST way between two keys: keys more than 180° apart turn the short way round, so key a long turn in steps below 180° (or use anim.add_motion, which does that for you). ' +
      'For moving or turning objects relative to where they are prefer anim.add_motion, for travelling along a route anim.follow_path. ' +
      'Targets: `ids` plus all objects inside `groupId`; with neither, the selection. Returns `ids`, `frame`, `time` (seconds), the `channels` that were keyed and `keyCount` (keys in the document). One undo step.',
    params: z.object({
      ids: idsParam,
      groupId: groupParam,
      frame: frameParam.describe('Frame of the key (integer, 0 = start).'),
      position: channelParam('World-space position [x, y, z] in meters'),
      rotation: channelParam('Euler XYZ in degrees'),
      scale: channelParam('Scale factors [x, y, z], none of them 0'),
      visible: z.boolean().optional().describe('Whether the object is shown from this frame on.'),
      interpolation: interpolationParam,
    }),
    run(ctx, p) {
      const state = docState(ctx);
      const ids = targets(state, p.ids, p.groupId);
      if (Array.isArray(p.scale) && p.scale.some((s) => s === 0)) throw new Error('scale must not be 0 on any axis');
      const pose = p.position === undefined && p.rotation === undefined && p.scale === undefined && p.visible === undefined;
      const transformChannels = (['position', 'rotation', 'scale'] as const).filter((c) => pose || p[c] !== undefined);
      const animation = animationOf(state);
      const entries = ids.map((id): [string, ObjectTrack] => {
        const obj = state.objects[id];
        const track: TrackDraft = { ...own(animation.tracks, id) };
        for (const channel of transformChannels) {
          const given = p[channel];
          const value = Array.isArray(given) ? given : obj.transform[channel];
          if (channel === 'scale' && value.some((s) => s === 0)) throw new Error(`Object "${obj.name}" has a scale of 0 on an axis, which cannot be keyed`);
          track[channel] = withKey(track[channel], { frame: p.frame, value, interpolation: p.interpolation });
        }
        if (p.visible !== undefined) track.visible = withKey(track.visible, { frame: p.frame, value: p.visible, interpolation: 'step' });
        return [id, track];
      });
      const next = withTracks(animation, entries);
      commit(ctx, next);
      return {
        ids,
        frame: p.frame,
        time: seconds(next, p.frame),
        channels: [...transformChannels, ...(p.visible !== undefined ? ['visible'] : [])],
        keyCount: countKeys(next),
        ...rangeWarning(next, p.frame),
      };
    },
  }),

  defineCommand({
    id: 'anim.delete_key',
    title: 'Keyframe löschen',
    description:
      `Delete the keys of objects on one frame. ${TIME_HINT} \`channels\` limits it to some of 'position', 'rotation', 'scale', 'visible' (default: all four). ` +
      'A channel that loses its last key is no longer animated and shows the static value again. Fails if none of the target objects has a key on that frame in those channels (anim.get lists the keys). ' +
      'Targets: `ids` plus all objects inside `groupId`; with neither, the selection. Returns `removed` (number of keys deleted) and `ids` of the objects that lost keys. One undo step.',
    params: z.object({
      ids: idsParam,
      groupId: groupParam,
      frame: frameParam,
      channels: z.array(z.enum(animationChannels)).min(1).optional().describe('Channels to delete the key from. Default: all.'),
    }),
    run(ctx, p) {
      const state = docState(ctx);
      const ids = targets(state, p.ids, p.groupId);
      const animation = animationOf(state);
      const channels = p.channels ?? animationChannels;
      let removed = 0;
      const entries: [string, ObjectTrack][] = [];
      for (const id of ids) {
        const track = own(animation.tracks, id);
        if (!track) continue;
        const draft: TrackDraft = { ...track };
        let changed = false;
        for (const channel of channels) {
          const keys: readonly Key<unknown>[] | undefined = track[channel];
          if (!keys?.some((k) => k.frame === p.frame)) continue;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          draft[channel] = keys.filter((k) => k.frame !== p.frame) as any;
          removed++;
          changed = true;
        }
        if (changed) entries.push([id, draft]);
      }
      if (removed === 0) throw new Error(`No key on frame ${p.frame} in the channels ${channels.join(', ')} of the given objects (anim.get lists the keys)`);
      commit(ctx, withTracks(animation, entries));
      return { removed, ids: entries.map(([id]) => id), frame: p.frame };
    },
  }),

  defineCommand({
    id: 'anim.clear',
    title: 'Animation entfernen',
    description:
      'Remove ALL keys of objects, so that they show their static transform and visibility again, and/or all camera keys. ' +
      'Targets: `ids` plus all objects inside `groupId`; `camera: true` removes the camera keys (alone, or together with the given objects); `all: true` removes every object track and the camera keys. ' +
      'With none of these, the tracks of the selected objects are removed. fps and frameCount stay as they are. ' +
      'Returns `ids` (objects that had keys and lost them), `cameraKeysRemoved` and `removed` (total number of keys deleted). One undo step (nothing happens if there was nothing to remove).',
    params: z.object({
      ids: idsParam,
      groupId: groupParam,
      camera: z.boolean().default(false).describe('Also remove all camera keys.'),
      all: z.boolean().default(false).describe('Remove the whole animation: all object tracks and all camera keys.'),
    }),
    run(ctx, p) {
      const state = docState(ctx);
      const animation = animationOf(state);
      const wanted = p.all ? Object.keys(animation.tracks) : p.camera && p.ids === undefined && p.groupId === undefined ? [] : targets(state, p.ids, p.groupId);
      const ids = wanted.filter((id) => own(animation.tracks, id));
      const camera = p.all || p.camera ? animation.camera.length : 0;
      const before = countKeys(animation);
      if (ids.length === 0 && camera === 0) return { ids: [], cameraKeysRemoved: 0, removed: 0 };
      const next: Animation = { ...withTracks(animation, ids.map((id) => [id, {}] as const)), camera: camera > 0 ? [] : animation.camera };
      commit(ctx, next);
      return { ids, cameraKeysRemoved: camera, removed: before - countKeys(next) };
    },
  }),

  defineCommand({
    id: 'anim.shift_keys',
    title: 'Keyframes verschieben',
    description:
      `Move keys in time: every key on frame >= \`fromFrame\` (default 0 = all keys) of the targets is moved by \`delta\` frames (positive = later, negative = earlier). ${TIME_HINT} ` +
      'Use it to delay a motion, to make room in the middle of an animation (fromFrame = where the gap starts) or to close a gap (negative delta). ' +
      'Targets: `ids` plus all objects inside `groupId`; `camera: true` shifts the camera keys (alone, or together with the given objects); `all: true` shifts every object track and the camera. With none of these: the selected objects. ' +
      'Nothing is changed and the command fails if a key would land before frame 0, beyond frame 1000000, or - with a negative delta - on or before an earlier key of the same channel that stays where it is (keys never overtake each other). ' +
      'The animation length (frameCount) is not changed. Returns `moved` (number of keys), `ids` of the objects whose keys moved and `lastKeyFrame`. One undo step.',
    params: z.object({
      ids: idsParam,
      groupId: groupParam,
      camera: z.boolean().default(false).describe('Also shift the camera keys.'),
      all: z.boolean().default(false).describe('Shift the keys of all objects and of the camera.'),
      fromFrame: frameParam.default(0).describe('Only keys on this frame or later are moved.'),
      delta: z.number().int().min(-MAX_KEY_FRAME).max(MAX_KEY_FRAME).describe('Number of frames to move by; negative = earlier.'),
    }),
    run(ctx, p) {
      if (p.delta === 0) throw new Error('delta must not be 0');
      const state = docState(ctx);
      const animation = animationOf(state);
      const wanted = p.all ? animatedObjectIds(state) : p.camera && p.ids === undefined && p.groupId === undefined ? [] : targets(state, p.ids, p.groupId);
      let moved = 0;
      const shift = <K extends { readonly frame: number }>(keys: readonly K[], what: string): readonly K[] => {
        const first = keys.findIndex((k) => k.frame >= p.fromFrame);
        if (first < 0) return keys;
        const start = keys[first].frame + p.delta;
        const end = keys[keys.length - 1].frame + p.delta;
        if (start < 0) throw new Error(`Cannot shift by ${p.delta}: the key of ${what} on frame ${keys[first].frame} would land before frame 0. Nothing was changed.`);
        if (end > MAX_KEY_FRAME) throw new Error(`Cannot shift by ${p.delta}: the key of ${what} on frame ${keys[keys.length - 1].frame} would land beyond frame ${MAX_KEY_FRAME}. Nothing was changed.`);
        if (first > 0 && start <= keys[first - 1].frame) {
          throw new Error(
            `Cannot shift by ${p.delta}: the key of ${what} on frame ${keys[first].frame} would collide with or overtake its key on frame ${keys[first - 1].frame}, which stays in place. Nothing was changed; delete that key first or shift by less.`,
          );
        }
        moved += keys.length - first;
        return [...keys.slice(0, first), ...keys.slice(first).map((k) => ({ ...k, frame: k.frame + p.delta }))];
      };
      const entries: [string, ObjectTrack][] = [];
      for (const id of wanted) {
        const track = own(animation.tracks, id);
        if (!track) continue;
        const draft: TrackDraft = {};
        const before = moved;
        for (const channel of animationChannels) {
          const keys = track[channel];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if (keys) draft[channel] = shift<Key<any>>(keys, `"${state.objects[id].name}" (${channel})`);
        }
        if (moved > before) entries.push([id, draft]);
      }
      const camera = p.all || p.camera ? shift(animation.camera, 'the camera') : animation.camera;
      if (moved === 0) throw new Error(`No keys on frame ${p.fromFrame} or later in the given targets, so there is nothing to shift`);
      const next: Animation = { ...withTracks(animation, entries), camera };
      commit(ctx, next);
      const lastKeyFrame = animationSummary(docState(ctx))!.lastKeyFrame!;
      return { moved, ids: entries.map(([id]) => id), cameraKeysMoved: camera !== animation.camera, lastKeyFrame, ...rangeWarning(next, lastKeyFrame) };
    },
  }),

  defineCommand({
    id: 'anim.add_motion',
    title: 'Bewegung hinzufügen',
    description:
      `Animate objects - or a whole group - AS ONE UNIT from frame \`fromFrame\` to frame \`toFrame\`: the simplest way to make things move. ${TIME_HINT} ` +
      'The start is the pose the objects have at `fromFrame` (their animated pose there, or the static one), the end is that pose transformed exactly as scene.transform_objects would transform it, in WORLD space (Y up, meters): ' +
      'first `scale` (one factor or [x, y, z] along the world axes, all > 0), then `rotate` (Euler XYZ in degrees about the world axes), both about `pivot` ' +
      '(a world-space point; default: the centre of the combined world bounding box of the objects at fromFrame), then `translate` (world-space offset in meters). ' +
      'Examples: translate [2, 0, 0] slides a crate 2 m along +X; rotate [0, 90, 0] with pivot at the base of a robot arm swings the whole arm group a quarter turn about the vertical axis through its base. ' +
      'Because the start is the evaluated pose at fromFrame, motions chain: add them in chronological order, each starting where (or after) the previous one ended. ' +
      'Before fromFrame and after toFrame the objects rest (unless other keys say otherwise). ' +
      "`interpolation` shapes the whole move: 'smooth' (default) eases in and out, 'linear' has constant speed, 'step' jumps at toFrame. " +
      'Keys written: position always, rotation if `rotate` is given, scale if `scale` is given; existing keys of those channels from fromFrame to toFrame are replaced, other channels and frames are untouched. ' +
      'A move without rotation is two keys per channel. A rotation is BAKED: every object gets a linear key at least every 5 degrees of the turn (more often far from the pivot, so that it stays within 1 mm of its circular arc, ' +
      'and for a smooth move at least every 1/32 of its duration), so objects swing along the arc instead of cutting straight across, and turns of any size work (rotate [0, 360, 0] is a full turn, 720 two turns). ' +
      'Angles of several axes at once are scaled together (the pose at 50 % is the rotation by half of each angle). ' +
      'Targets: `ids` plus all objects inside `groupId` (nested groups included); with neither, the selection. ' +
      'Returns `ids`, `pivot`, `fromFrame`, `toFrame`, `fromTime` / `toTime` (seconds), `keyFrames` (frames that got keys), `keysWritten` and per object its `from` and `to` transform. One undo step.',
    params: z.object({
      ids: idsParam,
      groupId: groupParam,
      fromFrame: frameParam.describe('Frame at which the motion starts.'),
      toFrame: frameParam.describe('Frame at which the motion is complete; must be greater than fromFrame.'),
      translate: vec3.optional().describe('World-space offset in meters, applied last.'),
      rotate: vec3.optional().describe('Euler XYZ in degrees about the world axes through the pivot; any size (360 = one full turn).'),
      scale: z.union([num, vec3]).optional().describe('Factor (uniform) or [x, y, z] factors along the world axes, about the pivot; each > 0.'),
      pivot: vec3.optional().describe('World-space centre of rotate and scale. Default: centre of the world bounding box of the objects at fromFrame.'),
      interpolation: interpolationParam,
    }),
    async run(ctx, p) {
      if (p.toFrame <= p.fromFrame) throw new Error('toFrame must be greater than fromFrame');
      const scale = p.scale === undefined ? null : toVec3(p.scale);
      if (scale?.some((s) => !(s > 0))) throw new Error('scale factors must be greater than 0 (an animated scale cannot pass through 0 or mirror)');
      const translate = p.translate && p.translate.some((v) => v !== 0) ? p.translate : null;
      const rotate = p.rotate && p.rotate.some((a) => a !== 0) ? p.rotate : null;
      const scaling = scale && scale.some((s) => s !== 1) ? scale : null;
      if (!translate && !rotate && !scaling) throw new Error('Give at least one of translate, rotate or scale (with an effect: not all 0, scale not 1)');
      const { state, ids } = await settle(ctx, (s) => targets(s, p.ids, p.groupId));
      const animation = animationOf(state);
      const pose = animatedState(state, p.fromFrame);
      const pivot = p.pivot ?? unitBounds(pose, ids).center;
      const starts = ids.map((id) => pose.objects[id].transform);

      // Where the keys go and how far the motion has got at each of them.
      const baked = rotate !== null && p.interpolation !== 'step';
      let samples: { frame: number; s: number }[];
      if (baked) {
        const reach = Math.max(...starts.map((t) => Math.hypot(t.position[0] - pivot[0], t.position[1] - pivot[1], t.position[2] - pivot[2]))) * Math.max(1, ...(scaling ?? [1]));
        // The step whose chord sags by the tolerance at that distance from the pivot.
        const sag = reach > BAKE_TOLERANCE ? (2 * Math.acos(1 - BAKE_TOLERANCE / reach) * 180) / Math.PI : MAX_BAKE_ANGLE;
        const step = Math.min(MAX_BAKE_ANGLE, Math.max(MIN_BAKE_ANGLE, sag));
        const angle = Math.abs(rotate[0]) + Math.abs(rotate[1]) + Math.abs(rotate[2]);
        samples = bakeFrames(p.fromFrame, p.toFrame, p.interpolation === 'smooth', step / angle);
      } else {
        samples = [
          { frame: p.fromFrame, s: 0 },
          { frame: p.toFrame, s: 1 },
        ];
      }
      const rotations = samples.map(({ s }) => (rotate ? eulerMatrix(s === 1 ? rotate : (rotate.map((a) => a * s) as Vec3)) : null));
      const poseAt = (start: Transform, i: number): Transform => {
        const s = samples[i].s;
        if (s === 0) return start;
        let t = start;
        if (scaling) t = scaleAbout(t, pivot, s === 1 ? scaling : (scaling.map((f) => 1 + (f - 1) * s) as Vec3));
        if (rotations[i]) t = rotateAbout(t, pivot, rotations[i]!);
        if (translate) t = { ...t, position: roundVec3(t.position.map((v, a) => v + translate[a] * s)) };
        return t;
      };

      const channels = (['position', 'rotation', 'scale'] as const).filter((c) => c === 'position' || (c === 'rotation' ? rotate : scaling));
      const last = samples.length - 1;
      const ends: Transform[] = [];
      const entries = ids.map((id, n): [string, ObjectTrack] => {
        const poses = samples.map((_, i) => poseAt(starts[n], i));
        ends.push(poses[last]);
        const track: TrackDraft = { ...own(animation.tracks, id) };
        for (const channel of channels) {
          const keys = samples.map(
            ({ frame }, i): Key<Vec3> => ({ frame, value: poses[i][channel], interpolation: baked && i < last ? 'linear' : p.interpolation }),
          );
          track[channel] = replaceRange(track[channel], p.fromFrame, p.toFrame, keys);
        }
        return [id, track];
      });
      const next = withTracks(animation, entries);
      commit(ctx, next);
      return {
        ids,
        pivot,
        fromFrame: p.fromFrame,
        toFrame: p.toFrame,
        fromTime: seconds(next, p.fromFrame),
        toTime: seconds(next, p.toFrame),
        channels,
        keyFrames: samples.map((s) => s.frame),
        keysWritten: samples.length * channels.length * ids.length,
        objects: ids.map((id, n) => ({ id, name: state.objects[id].name, from: starts[n], to: ends[n] })),
        ...rangeWarning(next, p.toFrame),
      };
    },
  }),

  defineCommand({
    id: 'anim.follow_path',
    title: 'Pfad folgen',
    description:
      `Move objects - or a whole group - as one unit along a route at CONSTANT speed from frame \`fromFrame\` to frame \`toFrame\`, e.g. a crate travelling along a conveyor. ${TIME_HINT} ` +
      '`points` are WORLD-space points [x, y, z] (meters, Y up) joined by straight lines; `closed: true` adds the way back to the first point. ' +
      'What travels along the route is the `anchor` of the unit: \'center\' (default) = the centre of the combined world bounding box of the objects at fromFrame, ' +
      "'bottom' = the centre of the underside of that box (use it with points lying ON the belt or floor surface), or an explicit world-space point [x, y, z]. " +
      'At fromFrame the anchor is at the first point (the unit jumps there if it was elsewhere - before fromFrame it rests at the first point unless earlier keys exist), at toFrame at the last point, ' +
      'and at every whole frame in between exactly on the route at the distance travelled so far (speed = route length / (toFrame - fromFrame) per frame; reported as `speed` in meters per second). ' +
      'The unit keeps its orientation unless `orient` is true: then it turns about the vertical (Y) axis through the anchor so that it keeps facing along the direction of travel; ' +
      'the pose at fromFrame counts as facing along the first segment, and at each corner the unit turns within one frame - for a rounded turn give several points along the curve. ' +
      'Keys written (linear): position, and rotation with `orient`, at fromFrame, toFrame and on the whole frames around each corner; existing keys of those channels from fromFrame to toFrame are replaced. ' +
      'The motion starts from the pose at fromFrame, so it chains with earlier motions; add motions in chronological order. ' +
      'Targets: `ids` plus all objects inside `groupId` (nested groups included); with neither, the selection. ' +
      'Returns `ids`, `anchor` (the world point used), `length` (meters), `speed` (m/s), `keyFrames`, `keysWritten` and per object its `from` and `to` transform. One undo step.',
    params: z.object({
      ids: idsParam,
      groupId: groupParam,
      points: z.array(vec3).min(2).max(10_000).describe('World-space route points in meters, in order of travel.'),
      fromFrame: frameParam.describe('Frame at which the unit is at the first point.'),
      toFrame: frameParam.describe('Frame at which the unit arrives at the last point; must be greater than fromFrame.'),
      orient: z.boolean().default(false).describe('Turn the unit about the vertical axis to face the direction of travel.'),
      closed: z.boolean().default(false).describe('Return to the first point at the end.'),
      anchor: z
        .union([z.enum(['center', 'bottom']), vec3])
        .default('center')
        .describe("The point of the unit that follows the route: 'center' or 'bottom' of its world bounding box at fromFrame, or a world-space point."),
    }),
    async run(ctx, p) {
      if (p.toFrame <= p.fromFrame) throw new Error('toFrame must be greater than fromFrame');
      // The route without zero-length segments, and the distance travelled at each of its points.
      const route: Vec3[] = [];
      for (const point of p.closed ? [...p.points, p.points[0]] : p.points) {
        const prev = route[route.length - 1];
        if (!prev || prev.some((v, a) => v !== point[a])) route.push(point);
      }
      if (route.length < 2) throw new Error('The points of the path are all the same, so there is nothing to travel along');
      const cum = [0];
      for (let i = 1; i < route.length; i++) cum.push(cum[i - 1] + Math.hypot(route[i][0] - route[i - 1][0], route[i][1] - route[i - 1][1], route[i][2] - route[i - 1][2]));
      const length = cum[cum.length - 1];
      const span = p.toFrame - p.fromFrame;

      const { state, ids } = await settle(ctx, (s) => targets(s, p.ids, p.groupId));
      const animation = animationOf(state);
      const pose = animatedState(state, p.fromFrame);
      const box = unitBounds(pose, ids);
      const anchor: Vec3 = p.anchor === 'center' ? box.center : p.anchor === 'bottom' ? [box.center[0], box.min[1], box.center[2]] : p.anchor;

      // Keys: both ends and the whole frames on either side of each corner; between them the route is straight.
      const frames = new Set([p.fromFrame, p.toFrame]);
      for (let i = 1; i < route.length - 1; i++) {
        const at = p.fromFrame + (cum[i] / length) * span;
        const whole = Math.round(at);
        if (Math.abs(at - whole) < 1e-7) {
          frames.add(whole);
          // The turn at a corner that falls on a whole frame happens during the following frame.
          if (p.orient && whole + 1 <= p.toFrame) frames.add(whole + 1);
        } else {
          frames.add(Math.floor(at));
          frames.add(Math.ceil(at));
        }
      }
      const keyFrames = [...frames].sort((a, b) => a - b);

      // Heading of each segment about Y (0 = +X, counter-clockwise seen from above); vertical segments keep the heading before them.
      const headings: number[] = [];
      let base: number | null = null;
      for (let i = 0; i + 1 < route.length; i++) {
        const dx = route[i + 1][0] - route[i][0];
        const dz = route[i + 1][2] - route[i][2];
        const heading: number | null = Math.hypot(dx, dz) > 1e-9 ? (Math.atan2(-dz, dx) * 180) / Math.PI : null;
        base ??= heading;
        headings.push(heading ?? headings[i - 1] ?? NaN);
      }
      const yawOf = (segment: number) => (p.orient && base !== null && !Number.isNaN(headings[segment]) ? headings[segment] - base : 0);

      let segment = 0;
      const stations = keyFrames.map((frame) => {
        if (frame === p.fromFrame) return { point: route[0], yaw: yawOf(0) };
        if (frame === p.toFrame) return { point: route[route.length - 1], yaw: yawOf(route.length - 2) };
        const d = (length * (frame - p.fromFrame)) / span;
        // The segment that holds d, a corner counting to the segment that arrives at it.
        while (segment < route.length - 2 && d > cum[segment + 1] + length * 1e-12) segment++;
        const a = route[segment];
        const b = route[segment + 1];
        const t = (d - cum[segment]) / (cum[segment + 1] - cum[segment]);
        const point: Vec3 = t >= 1 - 1e-9 ? b : [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
        return { point, yaw: yawOf(segment) };
      });
      const turns = stations.map(({ yaw }) => (yaw !== 0 ? eulerMatrix([0, yaw, 0]) : null));

      const last = keyFrames.length - 1;
      const result: { id: string; name: string; from: Transform; to: Transform }[] = [];
      const entries = ids.map((id): [string, ObjectTrack] => {
        const start = pose.objects[id].transform;
        const poses = stations.map(({ point }, i): Transform => {
          const t = turns[i] ? rotateAbout(start, anchor, turns[i]!) : start;
          return { ...t, position: roundVec3(t.position.map((v, a) => v + point[a] - anchor[a])) };
        });
        const track: TrackDraft = { ...own(animation.tracks, id) };
        for (const channel of p.orient ? (['position', 'rotation'] as const) : (['position'] as const)) {
          const keys = keyFrames.map((frame, i): Key<Vec3> => ({ frame, value: poses[i][channel], interpolation: 'linear' }));
          track[channel] = replaceRange(track[channel], p.fromFrame, p.toFrame, keys);
        }
        result.push({ id, name: state.objects[id].name, from: poses[0], to: poses[last] });
        return [id, track];
      });
      const next = withTracks(animation, entries);
      commit(ctx, next);
      return {
        ids,
        anchor,
        length: Math.round(length * 1e6) / 1e6,
        speed: Math.round(((length * next.fps) / span) * 1e6) / 1e6,
        fromFrame: p.fromFrame,
        toFrame: p.toFrame,
        fromTime: seconds(next, p.fromFrame),
        toTime: seconds(next, p.toFrame),
        keyFrames,
        keysWritten: keyFrames.length * (p.orient ? 2 : 1) * ids.length,
        objects: result,
        ...rangeWarning(next, p.toFrame),
      };
    },
  }),

  defineCommand({
    id: 'anim.set_camera_key',
    title: 'Kamera-Keyframe setzen',
    description:
      `Set a keyframe of the animated camera. ${TIME_HINT} \`position\` = where the camera is, \`target\` = the point it looks at (both WORLD space, meters, Y up; they must differ), ` +
      '`fov` = vertical field of view in degrees (default 40; smaller = more zoomed in). A camera key already on that frame is replaced. ' +
      '`interpolation` says how the camera gets from this key to the next one (default smooth = ease in and out; position, target and fov are each interpolated in a straight line). ' +
      'As soon as there is at least one camera key, playback and video export look through the animated camera (before the first key it holds the first pose, after the last key the last one); ' +
      'without camera keys they use the normal viewport camera. For a circular move around something use anim.camera_orbit. Returns `frame`, `time` (seconds) and `cameraKeys` (their number). One undo step.',
    params: z.object({
      frame: frameParam,
      position: vec3.describe('World-space position of the camera.'),
      target: vec3.describe('World-space point the camera looks at.'),
      fov: z.number().min(1).max(179).default(DEFAULT_CAMERA_FOV).describe('Vertical field of view in degrees.'),
      interpolation: interpolationParam,
    }),
    run(ctx, p) {
      if (p.position.every((v, a) => v === p.target[a])) throw new Error('position and target must not be the same point');
      const animation = animationOf(docState(ctx));
      const next: Animation = {
        ...animation,
        camera: withKey(animation.camera, { frame: p.frame, position: p.position, target: p.target, fov: p.fov, interpolation: p.interpolation }),
      };
      commit(ctx, next);
      return { frame: p.frame, time: seconds(next, p.frame), cameraKeys: next.camera.length, ...rangeWarning(next, p.frame) };
    },
  }),

  defineCommand({
    id: 'anim.delete_camera_key',
    title: 'Kamera-Keyframe löschen',
    description:
      'Delete the camera key on one frame (anim.get lists the camera keys; anim.clear { camera: true } removes all of them). Fails if there is no camera key on that frame. ' +
      'Without any camera key left, playback and export use the normal viewport camera again. Returns `cameraKeys` (how many remain). One undo step.',
    params: z.object({ frame: frameParam }),
    run(ctx, p) {
      const animation = animationOf(docState(ctx));
      const camera = animation.camera.filter((k) => k.frame !== p.frame);
      if (camera.length === animation.camera.length) throw new Error(`There is no camera key on frame ${p.frame} (anim.get lists the camera keys)`);
      commit(ctx, { ...animation, camera });
      return { frame: p.frame, cameraKeys: camera.length };
    },
  }),

  defineCommand({
    id: 'anim.camera_orbit',
    title: 'Kamerafahrt im Kreis',
    description:
      `Let the animated camera circle around a point while looking at it, from frame \`fromFrame\` to frame \`toFrame\`. ${TIME_HINT} ` +
      '`target` = the world-space point it looks at and circles around (meters, Y up); `radius` = horizontal distance of the camera from the vertical axis through the target; ' +
      '`height` = how far the camera is ABOVE the target (world Y of the camera = target Y + height; negative = below); both stay constant. ' +
      '`startAngle` (degrees) is where the camera starts: 0 = on the +X side of the target, 90 = on the -Z side, 180 = -X, 270 = +Z (counter-clockwise seen from above). ' +
      '`turns` = how many times it goes round by toFrame: 1 = a full circle, 0.25 = a quarter, negative = clockwise seen from above. `fov` = vertical field of view in degrees. ' +
      "`interpolation`: 'linear' (default) = constant angular speed, 'smooth' = eases in and out over the whole move. " +
      'The circle is baked into linear camera keys at least every 2 degrees (at most one per frame), so radius and height hold between keys too; existing camera keys from fromFrame to toFrame are replaced, others stay ' +
      '(before fromFrame the camera holds the start pose unless earlier camera keys exist). ' +
      'Returns `startPosition`, `endPosition`, `keyFrames` count as `keysWritten`, `fromTime` / `toTime` (seconds). One undo step.',
    params: z.object({
      target: vec3.describe('World-space point the camera looks at and circles around.'),
      radius: z.number().positive().max(1e6).describe('Horizontal distance from the target in meters.'),
      height: num.describe('Height of the camera above the target in meters (relative to target Y).'),
      fromFrame: frameParam,
      toFrame: frameParam.describe('Must be greater than fromFrame.'),
      startAngle: num.default(0).describe('Degrees; 0 = camera on the +X side of the target, counter-clockwise seen from above.'),
      turns: z.number().min(-1000).max(1000).default(1).describe('Number of revolutions; negative = clockwise seen from above.'),
      fov: z.number().min(1).max(179).default(DEFAULT_CAMERA_FOV).describe('Vertical field of view in degrees.'),
      interpolation: z.enum(['linear', 'smooth']).default('linear').describe('Constant angular speed, or ease in and out over the whole move.'),
    }),
    run(ctx, p) {
      if (p.toFrame <= p.fromFrame) throw new Error('toFrame must be greater than fromFrame');
      if (p.turns === 0) throw new Error('turns must not be 0 (for a camera that stands still use anim.set_camera_key)');
      const animation = animationOf(docState(ctx));
      const sweep = p.turns * 360;
      const samples = bakeFrames(p.fromFrame, p.toFrame, p.interpolation === 'smooth', ORBIT_ANGLE / Math.abs(sweep));
      const keys = samples.map(({ frame, s }, i): CameraKey => {
        const angle = ((p.startAngle + sweep * s) * Math.PI) / 180;
        return {
          frame,
          position: roundVec3([p.target[0] + p.radius * Math.cos(angle), p.target[1] + p.height, p.target[2] - p.radius * Math.sin(angle)]),
          target: p.target,
          fov: p.fov,
          interpolation: i < samples.length - 1 ? 'linear' : p.interpolation,
        };
      });
      const next: Animation = { ...animation, camera: replaceRange(animation.camera, p.fromFrame, p.toFrame, keys) };
      commit(ctx, next);
      return {
        fromFrame: p.fromFrame,
        toFrame: p.toFrame,
        fromTime: seconds(next, p.fromFrame),
        toTime: seconds(next, p.toFrame),
        startPosition: keys[0].position,
        endPosition: keys[keys.length - 1].position,
        keysWritten: keys.length,
        cameraKeys: next.camera.length,
        ...rangeWarning(next, p.toFrame),
      };
    },
  }),

  defineCommand({
    id: 'anim.get',
    title: 'Animation abfragen',
    description:
      'Read the animation of the document. Returns `fps`, `frameCount` (the animation shows the frames 0 .. frameCount - 1), `duration` (seconds), `keyCount`, `firstKeyFrame` / `lastKeyFrame` (null without keys), ' +
      '`total` (number of animated objects among the targets) and `objects`: per animated object `{ id, name, channels }` where `channels` has an entry for each animated channel ' +
      "('position' world meters, 'rotation' Euler XYZ degrees, 'scale', 'visible'): `{ count, firstFrame, lastFrame, keys: [{ frame, value, interpolation }] }`. " +
      '`camera` (unless `camera: false`): `{ count, firstFrame, lastFrame, keys: [{ frame, position, target, fov, interpolation }] }`, count 0 = the camera is not animated. ' +
      'A document that was never animated reports the defaults (24 fps, 120 frames) and no keys. ' +
      'Targets: `ids` plus all objects inside `groupId`; with neither, ALL animated objects. Objects are paged with `offset` / `limit` (more remain while offset + objects.length < total). ' +
      'Baked motions have many keys: `includeKeys: false` leaves the `keys` lists out (counts and frame ranges stay), `fromFrame` / `toFrame` list only the keys in that frame range, ' +
      'and at most `maxKeys` keys are listed per channel (`truncated: true` marks a shortened list). To see where things ARE at a frame use anim.evaluate. Changes nothing.',
    params: z.object({
      ids: z.array(z.string()).optional().describe(`Objects. ${refHint} Default (if groupId is not given either): all animated objects.`),
      groupId: groupParam,
      camera: z.boolean().default(true).describe('Include the camera keys.'),
      includeKeys: z.boolean().default(true).describe('List the keys themselves, not only counts and frame ranges.'),
      fromFrame: frameParam.optional().describe('Only list keys on this frame or later.'),
      toFrame: frameParam.optional().describe('Only list keys on this frame or earlier.'),
      maxKeys: z.number().int().min(1).max(5000).default(200).describe('Maximum number of keys listed per channel.'),
      offset: z.number().int().min(0).default(0).describe('Number of animated objects to skip.'),
      limit: z.number().int().min(1).max(1000).default(100).describe('Maximum number of objects returned.'),
    }),
    history: false,
    run(ctx, p) {
      const state = docState(ctx);
      const animation = animationOf(state);
      const all = p.ids === undefined && p.groupId === undefined ? animatedObjectIds(state) : targets(state, p.ids, p.groupId).filter((id) => own(animation.tracks, id));
      const list = <K extends { readonly frame: number }, O>(keys: readonly K[], out: (key: K) => O) => {
        const info = { count: keys.length, firstFrame: keys[0]?.frame ?? null, lastFrame: keys[keys.length - 1]?.frame ?? null };
        if (!p.includeKeys) return info;
        const inRange = keys.filter((k) => k.frame >= (p.fromFrame ?? 0) && k.frame <= (p.toFrame ?? Infinity));
        return { ...info, keys: inRange.slice(0, p.maxKeys).map(out), ...(inRange.length > p.maxKeys ? { truncated: true } : {}) };
      };
      const objects = all.slice(p.offset, p.offset + p.limit).map((id) => {
        const track = animation.tracks[id];
        return {
          id,
          name: state.objects[id].name,
          channels: {
            ...(track.position ? { position: list(track.position, keyOut) } : {}),
            ...(track.rotation ? { rotation: list(track.rotation, keyOut) } : {}),
            ...(track.scale ? { scale: list(track.scale, keyOut) } : {}),
            ...(track.visible ? { visible: list(track.visible, keyOut) } : {}),
          },
        };
      });
      const summary = animationSummary({ ...state, animation })!;
      return {
        fps: summary.fps,
        frameCount: summary.frameCount,
        duration: summary.duration,
        keyCount: summary.keyCount,
        firstKeyFrame: summary.firstKeyFrame,
        lastKeyFrame: summary.lastKeyFrame,
        total: all.length,
        objects,
        ...(p.camera ? { camera: list(animation.camera, (k) => ({ frame: k.frame, position: k.position, target: k.target, fov: k.fov, interpolation: k.interpolation })) } : {}),
      };
    },
  }),

  defineCommand({
    id: 'anim.evaluate',
    title: 'Animation auswerten',
    description:
      'Where is everything at a given frame? Evaluates the animation without playing it, so that timing can be checked by numbers. ' +
      `\`frame\` is one frame or a list of up to 200 frames (fractional frames are allowed). ${TIME_HINT} ` +
      'Returns `fps`, `frameCount` and `samples`: per frame `{ frame, time (seconds), objects: [{ id, name, animated, visible, transform: { position, rotation (Euler XYZ degrees), scale }, center }], camera }`. ' +
      '`center` is the centre of the object\'s WORLD bounding box at that frame (meters; null for an object without vertices) - compare centres of two objects to see whether they meet. ' +
      '`camera` is the animated camera `{ position, target, fov }` at that frame, or null when there are no camera keys (the viewport camera is used then). ' +
      'Targets: `ids` plus all objects inside `groupId` (animated or not); with neither, all ANIMATED objects. `total` is the number of target objects; they are paged with `offset` / `limit`. ' +
      'At most 5000 object samples (objects x frames) per call. Changes nothing.',
    params: z.object({
      frame: z.union([num.min(0).max(MAX_KEY_FRAME), z.array(num.min(0).max(MAX_KEY_FRAME)).min(1).max(200)]).describe('Frame or list of frames to evaluate.'),
      ids: z.array(z.string()).optional().describe(`Objects. ${refHint} Default (if groupId is not given either): all animated objects.`),
      groupId: groupParam,
      offset: z.number().int().min(0).default(0).describe('Number of target objects to skip.'),
      limit: z.number().int().min(1).max(1000).default(200).describe('Maximum number of objects per frame.'),
    }),
    history: false,
    async run(ctx, p) {
      const frames = typeof p.frame === 'number' ? [p.frame] : p.frame;
      const pick = (s: DocState) => (p.ids === undefined && p.groupId === undefined ? animatedObjectIds(s) : targets(s, p.ids, p.groupId));
      const { state, ids: all } = await settle(ctx, pick);
      const ids = all.slice(p.offset, p.offset + p.limit);
      if (ids.length * frames.length > 5000) {
        throw new Error(`${ids.length} objects x ${frames.length} frames are more than 5000 samples; ask for fewer frames or fewer objects (ids, groupId, limit)`);
      }
      const animation = animationOf(state);
      return {
        fps: animation.fps,
        frameCount: animation.frameCount,
        total: all.length,
        samples: frames.map((frame) => {
          const at = animatedState(state, frame);
          return {
            frame,
            time: seconds(animation, frame),
            objects: ids.map((id) => {
              const obj = at.objects[id];
              const bounds = objectWorldBounds(at, id);
              return {
                id,
                name: obj.name,
                animated: own(animation.tracks, id) !== undefined,
                visible: obj.visible,
                transform: { position: roundVec3(obj.transform.position), rotation: roundVec3(obj.transform.rotation), scale: roundVec3(obj.transform.scale) },
                center: bounds ? describeBounds(bounds).center : null,
              };
            }),
            camera: cameraAt(animation, frame),
          };
        }),
      };
    },
  }),
];
