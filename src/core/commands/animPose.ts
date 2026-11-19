// The animation commands of the timeline and the gizmo: posing objects at the playhead (keys where a
// channel is animated, the static transform where it is not) and moving single keys in time.
import { z } from 'zod';
import { MAX_KEYS, MAX_KEY_FRAME, animatedState, animationChannels, countKeys, defaultAnimation, withKey, withTracks, type AnimationChannel } from '../animation';
import { withTransform } from '../modifiers/worldOffsets';
import { hasKeyAt, lowerBound, splitPose } from '../playhead';
import { resolveObjectId, resolveObjectIds } from '../refs';
import { own } from '../state';
import { keyInterpolations } from '../types';
import type { Animation, CameraKey, Key, KeyInterpolation, ObjectTrack, Transform, Vec3 } from '../types';
import { defineCommand, docState, updateDocState } from './registry';

const num = z.number().finite();
const vec3 = z.tuple([num, num, num]);
const frameParam = z.number().int().min(0).max(MAX_KEY_FRAME);
const TIME_HINT = 'Frames are integers starting at 0; time in seconds = frame / fps (see anim.get for fps and frameCount).';
const refHint = 'an object id, an exact object name or a glob pattern with * and ? (case-sensitive)';

type TrackDraft = { -readonly [C in AnimationChannel]?: ObjectTrack[C] };

/** The interpolation a new key on `frame` gets when none is asked for: that of the key it replaces, else of the key before it, else smooth. */
function inheritedInterpolation(keys: readonly Key<Vec3>[] | undefined, frame: number): KeyInterpolation {
  if (!keys || keys.length === 0) return 'smooth';
  const i = lowerBound(keys, frame);
  if (i < keys.length && keys[i].frame === frame) return keys[i].interpolation;
  return i > 0 ? keys[i - 1].interpolation : 'smooth';
}

/** The keys with the one on `frame` moved to `toFrame` (replacing a key there); null if there is no key on `frame`. */
function moveKey<K extends { readonly frame: number }>(keys: readonly K[] | undefined, frame: number, toFrame: number): { keys: K[]; replaced: boolean } | null {
  if (!keys || !hasKeyAt(keys, frame)) return null;
  const key = keys[lowerBound(keys, frame)];
  const rest = keys.filter((k) => k.frame !== frame);
  return { keys: withKey(rest, { ...key, frame: toFrame }), replaced: hasKeyAt(rest, toFrame) };
}

export const animPoseCommands = [
  defineCommand({
    id: 'anim.set_pose',
    title: 'Pose am Bild setzen',
    description:
      `Give objects a pose at one frame, each object its own values - what the timeline's "set key" and a gizmo drag on an animated object do. ${TIME_HINT} ` +
      '`items` lists per object any of `position` (WORLD space, meters, Y up - the object origin), `rotation` (Euler XYZ in degrees) and `scale` ([x, y, z] factors, none 0). ' +
      'With `autoKey: false` (default) every given channel gets a key on `frame` with that value (a key already there is replaced). ' +
      'With `autoKey: true` only channels that ALREADY have keys get a key; a given channel without keys changes the object\'s static transform instead (as scene.set_transform does), so an object that is not animated is simply moved. ' +
      'An item with none of the three channels keys position, rotation and scale as the object is DISPLAYED at that frame (its animated pose there) - "remember the pose it has right now"; with autoKey that touches only the channels that have keys. ' +
      '`interpolation` says how the value travels from the new key to the next one; without it a new key takes over the interpolation of the key it replaces, else of the key before it in that channel, else smooth - so a key dropped into a baked (linear) motion stays linear. ' +
      'To key the same value on many objects, or visibility, use anim.set_key; to move things relative to where they are, anim.add_motion. ' +
      'Returns `frame`, `time` (seconds), `keyed` and `moved` (per object the channels that got a key / whose static value changed) and `keyCount`. One undo step for all items.',
    params: z.object({
      frame: frameParam.describe('Frame of the keys (integer, 0 = start).'),
      items: z
        .array(
          z.object({
            id: z.string().describe(`The object: ${refHint} that matches exactly one object.`),
            position: vec3.optional().describe('World-space position [x, y, z] in meters.'),
            rotation: vec3.optional().describe('Euler XYZ in degrees.'),
            scale: vec3.optional().describe('Scale factors [x, y, z], none of them 0.'),
          }),
        )
        .min(1)
        .max(10_000),
      autoKey: z.boolean().default(false).describe('true: key only channels that already have keys and write the others to the static transform.'),
      interpolation: z.enum(keyInterpolations).optional().describe("'linear', 'smooth' or 'step' from the new keys to the next ones. Default: inherited (see above)."),
    }),
    run(ctx, p) {
      const state = docState(ctx);
      const animation = state.animation ?? defaultAnimation();
      const shown = animatedState(state, p.frame);
      const tracks = new Map<string, TrackDraft>();
      const statics = new Map<string, Transform>();
      const keyed: { id: string; channels: string[] }[] = [];
      const moved: { id: string; channels: string[] }[] = [];
      for (const item of p.items) {
        const id = resolveObjectId(state, item.id);
        const whole = item.position === undefined && item.rotation === undefined && item.scale === undefined;
        const displayed = shown.objects[id].transform;
        const pose = whole ? { position: displayed.position, rotation: displayed.rotation, scale: displayed.scale } : { position: item.position, rotation: item.rotation, scale: item.scale };
        if (pose.scale?.some((s) => s === 0)) throw new Error(`The scale of "${state.objects[id].name}" must not be 0 on any axis`);
        const track: TrackDraft = tracks.get(id) ?? { ...own(animation.tracks, id) };
        const split = splitPose(track, pose, p.autoKey);
        // "The pose as displayed" has nothing to say about channels that are not animated.
        if (whole && p.autoKey) split.plain = [];
        for (const channel of split.keyed) {
          track[channel] = withKey(track[channel], { frame: p.frame, value: pose[channel]!, interpolation: p.interpolation ?? inheritedInterpolation(track[channel], p.frame) });
        }
        if (split.keyed.length > 0) {
          tracks.set(id, track);
          keyed.push({ id, channels: split.keyed });
        }
        if (split.plain.length > 0) {
          let t = statics.get(id) ?? state.objects[id].transform;
          for (const channel of split.plain) t = { ...t, [channel]: pose[channel]! };
          statics.set(id, t);
          moved.push({ id, channels: split.plain });
        }
      }
      const next = tracks.size > 0 ? withTracks(animation, tracks) : animation;
      const count = countKeys(next);
      if (count > MAX_KEYS) throw new Error(`This would give the animation ${count} keys, more than the ${MAX_KEYS} that are allowed.`);
      if (tracks.size > 0 || statics.size > 0) {
        updateDocState(ctx, (s) => {
          let objects = s.objects;
          if (statics.size > 0) {
            const copy = { ...s.objects };
            for (const [id, transform] of statics) copy[id] = withTransform(copy[id], transform);
            objects = copy;
          }
          return { ...s, objects, ...(tracks.size > 0 ? { animation: next } : {}) };
        });
      }
      return {
        frame: p.frame,
        time: Math.round((p.frame / next.fps) * 1e6) / 1e6,
        keyed,
        moved,
        keyCount: count,
        ...(keyed.length > 0 && p.frame >= next.frameCount
          ? { warnings: [`Frame ${p.frame} is beyond the end of the animation (frames 0..${next.frameCount - 1}), so it is not played or exported. Extend it with anim.set_range { frameCount: ${p.frame + 1} }.`] }
          : {}),
      };
    },
  }),

  defineCommand({
    id: 'anim.move_key',
    title: 'Keyframe verschieben (einzeln)',
    description:
      `Move the keys that lie on ONE frame to another frame, leaving all other keys where they are - what dragging a key marker in the timeline does. ${TIME_HINT} ` +
      'Every key of the targets on `frame` (in all channels, or only in `channels`) moves to `toFrame` with its value and interpolation; a key already on `toFrame` in the same channel is replaced. ' +
      'Unlike anim.shift_keys (which moves a key AND everything after it) a moved key may pass other keys. ' +
      'Targets: the objects in `ids`; `camera: true` moves the camera key on that frame (alone, or together with the given objects); with neither, the selected objects. ' +
      'Fails if none of the targets has a key on `frame`. Returns `moved` (number of keys moved), `replaced` (keys on toFrame that were overwritten), `ids` of the objects whose keys moved and `cameraKeyMoved`. One undo step.',
    params: z.object({
      ids: z.array(z.string()).optional().describe(`Objects; each entry is ${refHint}. Default (unless camera is true): the selection.`),
      camera: z.boolean().default(false).describe('Move the camera key on that frame.'),
      frame: frameParam.describe('Frame the keys are on now.'),
      toFrame: frameParam.describe('Frame they are moved to.'),
      channels: z.array(z.enum(animationChannels)).min(1).optional().describe("Only keys of these object channels ('position', 'rotation', 'scale', 'visible'). Default: all."),
    }),
    run(ctx, p) {
      if (p.frame === p.toFrame) throw new Error('frame and toFrame are the same, so there is nothing to move');
      const state = docState(ctx);
      const animation = state.animation ?? defaultAnimation();
      let ids: string[];
      if (p.ids !== undefined) ids = resolveObjectIds(state, p.ids);
      else if (p.camera) ids = [];
      else {
        if (state.selection.length === 0) throw new Error('No objects given (ids) and nothing is selected');
        ids = [...state.selection];
      }
      const channels = p.channels ?? animationChannels;
      let moved = 0;
      let replaced = 0;
      const entries: [string, ObjectTrack][] = [];
      for (const id of ids) {
        const track = own(animation.tracks, id);
        if (!track) continue;
        const draft: TrackDraft = { ...track };
        let changed = false;
        for (const channel of channels) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const result = moveKey<Key<any>>(track[channel], p.frame, p.toFrame);
          if (!result) continue;
          draft[channel] = result.keys;
          moved++;
          if (result.replaced) replaced++;
          changed = true;
        }
        if (changed) entries.push([id, draft]);
      }
      let camera: readonly CameraKey[] = animation.camera;
      let cameraKeyMoved = false;
      if (p.camera) {
        const result = moveKey(animation.camera, p.frame, p.toFrame);
        if (result) {
          camera = result.keys;
          cameraKeyMoved = true;
          moved++;
          if (result.replaced) replaced++;
        }
      }
      if (moved === 0) throw new Error(`No key on frame ${p.frame} in the given targets (anim.get lists the keys)`);
      const next: Animation = { ...withTracks(animation, entries), camera };
      updateDocState(ctx, (s) => ({ ...s, animation: next }));
      return {
        moved,
        replaced,
        ids: entries.map(([id]) => id),
        cameraKeyMoved,
        frame: p.frame,
        toFrame: p.toFrame,
        ...(p.toFrame >= next.frameCount
          ? { warnings: [`Frame ${p.toFrame} is beyond the end of the animation (frames 0..${next.frameCount - 1}), so it is not played or exported. Extend it with anim.set_range { frameCount: ${p.toFrame + 1} }.`] }
          : {}),
      };
    },
  }),
];
