import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_KEYS, animatedState, cameraAt } from '../animation';
import { parseProject, serializeProject } from '../project';
import { activeDoc, createAppState } from '../state';
import { eulerMatrix } from '../transformMath';
import type { Animation, AppState, DocState, ObjectTrack, Transform, Vec3 } from '../types';
import { commands } from './index';
import { runCommand, type AnyCommand, type CommandContext } from './registry';

const byId = new Map<string, AnyCommand>(commands.map((c) => [c.id, c]));

let app: AppState;
const ctx: CommandContext = {
  get: () => app,
  set: (update) => {
    app = update(app);
  },
  services: { viewport: null, exporter: null },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function run(id: string, params?: unknown): Promise<any> {
  const def = byId.get(id);
  if (!def) throw new Error(`Unknown command ${id}`);
  return runCommand(def, ctx, params);
}

const doc = () => activeDoc(app);
const state = (): DocState => doc().state;
const anim = (): Animation => state().animation!;
const track = (id: string): ObjectTrack => anim().tracks[id];
const frames = (keys: readonly { frame: number }[] | undefined) => (keys ?? []).map((k) => k.frame);
/** Transform of an object at a frame. */
const at = (id: string, frame: number): Transform => animatedState(state(), frame).objects[id].transform;
const pos = (id: string, frame: number): Vec3 => at(id, frame).position;

async function cube(position: Vec3 = [0, 0, 0], params: Record<string, unknown> = {}): Promise<string> {
  return (await run('scene.add_primitive', { type: 'cube', position, ...params })).id;
}

function expectVec(actual: readonly number[], expected: readonly number[], digits = 6) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((v, i) => expect(v, `component ${i} of [${actual.join(', ')}] vs [${expected.join(', ')}]`).toBeCloseTo(expected[i], digits));
}

function expectSameOrientation(a: Vec3, b: Vec3, digits = 5) {
  expectVec(eulerMatrix(a), eulerMatrix(b), digits);
}

/** The animation is well-formed: keys sorted, unique, on whole frames; tracks only for existing objects, never empty. */
function invariantErrors(s: DocState): string[] {
  const errors: string[] = [];
  const animation = s.animation;
  if (!animation) return errors;
  const check = (keys: readonly { frame: number }[], what: string) => {
    if (keys.length === 0) errors.push(`${what}: empty channel`);
    keys.forEach((k, i) => {
      if (!Number.isInteger(k.frame) || k.frame < 0) errors.push(`${what}: bad frame ${k.frame}`);
      if (i > 0 && keys[i - 1].frame >= k.frame) errors.push(`${what}: not sorted / unique at frame ${k.frame}`);
    });
  };
  for (const [id, t] of Object.entries(animation.tracks)) {
    if (!Object.hasOwn(s.objects, id)) errors.push(`track for missing object ${id}`);
    const channels = Object.entries(t);
    if (channels.length === 0) errors.push(`empty track ${id}`);
    for (const [channel, keys] of channels) check(keys, `${id}.${channel}`);
  }
  if (animation.camera.length > 0) check(animation.camera, 'camera');
  return errors;
}

/** Runs a mutating command and checks that it is exactly one undo step that undo/redo restore by identity. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function expectUndoable(id: string, params: unknown): Promise<any> {
  const before = state();
  const past = doc().past.length;
  const result = await run(id, params);
  const after = state();
  expect(after).not.toBe(before);
  expect(doc().past).toHaveLength(past + 1);
  expect(invariantErrors(after)).toEqual([]);
  await run('history.undo');
  expect(state()).toBe(before);
  await run('history.redo');
  expect(state()).toBe(after);
  return result;
}

/** Runs a command that must fail and must not change the document. */
async function expectError(id: string, params: unknown, message: string | RegExp) {
  const before = state();
  const past = doc().past.length;
  await expect(run(id, params)).rejects.toThrow(message);
  expect(state()).toBe(before);
  expect(doc().past).toHaveLength(past);
}

/** Runs a query and checks that it changes nothing. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function query(id: string, params?: unknown): Promise<any> {
  const before = state();
  const past = doc().past.length;
  const result = await run(id, params);
  expect(state()).toBe(before);
  expect(doc().past).toHaveLength(past);
  return result;
}

beforeEach(() => {
  app = createAppState();
});

describe('registration', () => {
  it('registers the animation commands', () => {
    expect(
      commands
        .map((c) => c.id)
        .filter((id) => id.startsWith('anim.'))
        .sort(),
    ).toEqual([
      'anim.add_motion',
      'anim.camera_orbit',
      'anim.clear',
      'anim.delete_camera_key',
      'anim.delete_key',
      'anim.evaluate',
      'anim.follow_path',
      'anim.get',
      'anim.move_key',
      'anim.set_camera_key',
      'anim.set_key',
      'anim.set_pose',
      'anim.set_range',
      'anim.shift_keys',
    ]);
  });

  it('new documents have no animation', async () => {
    expect(state().animation).toBeUndefined();
    expect(await query('anim.get')).toMatchObject({ fps: 24, frameCount: 120, duration: 5, keyCount: 0, total: 0, objects: [], camera: { count: 0, keys: [] } });
  });
});

describe('anim.set_range', () => {
  it('sets fps and frameCount', async () => {
    const result = await expectUndoable('anim.set_range', { fps: 30, frameCount: 90 });
    expect(result).toMatchObject({ fps: 30, frameCount: 90, duration: 3, keysBeyondEnd: 0 });
    expect(anim()).toMatchObject({ fps: 30, frameCount: 90, tracks: {}, camera: [] });
    await expectUndoable('anim.set_range', { frameCount: 48 });
    expect(anim()).toMatchObject({ fps: 30, frameCount: 48 });
    await expectUndoable('anim.set_range', { fps: 12.5 });
    expect(anim()).toMatchObject({ fps: 12.5, frameCount: 48 });
  });

  it('keeps keys beyond a shortened end and reports them', async () => {
    const id = await cube();
    await run('anim.set_key', { ids: [id], frame: 100 });
    await run('anim.set_camera_key', { frame: 110, position: [0, 0, 5], target: [0, 0, 0] });
    const result = await expectUndoable('anim.set_range', { frameCount: 50 });
    expect(result.keysBeyondEnd).toBe(4);
    expect(result.warnings[0]).toContain('4 keys');
    expect(frames(track(id).position)).toEqual([100]);
    expect(frames(anim().camera)).toEqual([110]);
  });

  it('rejects bad values', async () => {
    await expectError('anim.set_range', {}, 'at least one of fps or frameCount');
    for (const params of [{ fps: 0 }, { fps: 121 }, { fps: Infinity }, { frameCount: 0 }, { frameCount: 100_001 }, { frameCount: 10.5 }, { fps: '24' }]) {
      await expectError('anim.set_range', params, /./);
    }
  });
});

describe('anim.set_key', () => {
  it('with no channel keys the current static pose', async () => {
    const id = await cube([1, 2, 3], { rotation: [0, 45, 0], scale: [2, 2, 2] });
    const result = await expectUndoable('anim.set_key', { ids: [id], frame: 12 });
    expect(result).toMatchObject({ ids: [id], frame: 12, time: 0.5, channels: ['position', 'rotation', 'scale'], keyCount: 3 });
    expect(result.warnings).toBeUndefined();
    expect(track(id)).toEqual({
      position: [{ frame: 12, value: [1, 2, 3], interpolation: 'smooth' }],
      rotation: [{ frame: 12, value: [0, 45, 0], interpolation: 'smooth' }],
      scale: [{ frame: 12, value: [2, 2, 2], interpolation: 'smooth' }],
    });
    // A new document animation starts with the defaults.
    expect(anim()).toMatchObject({ fps: 24, frameCount: 120, camera: [] });
  });

  it('keys given values, `true` for the current value, and visibility', async () => {
    const id = await cube([1, 0, 0]);
    await expectUndoable('anim.set_key', { ids: [id], frame: 0, position: true, interpolation: 'linear' });
    await expectUndoable('anim.set_key', { ids: [id], frame: 24, position: [5, 0, 0], visible: false, interpolation: 'linear' });
    expect(track(id)).toEqual({
      position: [
        { frame: 0, value: [1, 0, 0], interpolation: 'linear' },
        { frame: 24, value: [5, 0, 0], interpolation: 'linear' },
      ],
      visible: [{ frame: 24, value: false, interpolation: 'step' }],
    });
    expectVec(pos(id, 12), [3, 0, 0]);
    expect(animatedState(state(), 23).objects[id].visible).toBe(false); // the first visibility key holds before it
    // The static object is untouched.
    expect(state().objects[id].transform.position).toEqual([1, 0, 0]);
    expect(state().objects[id].visible).toBe(true);
  });

  it('replaces a key on the same frame and keeps keys sorted', async () => {
    const id = await cube();
    for (const [frame, x] of [
      [20, 2],
      [0, 0],
      [10, 1],
      [20, 9],
    ]) {
      await expectUndoable('anim.set_key', { ids: [id], frame, position: [x, 0, 0] });
    }
    expect(track(id).position!.map((k) => [k.frame, k.value[0]])).toEqual([
      [0, 0],
      [10, 1],
      [20, 9],
    ]);
  });

  it('targets: selection, names, groups', async () => {
    const a = await cube([0, 0, 0], { name: 'Kiste A' });
    const b = await cube([1, 0, 0], { name: 'Kiste B' });
    const c = await cube([2, 0, 0], { name: 'Anderes' });
    const group = (await run('group.create', { ids: [a, b], name: 'Kisten' })).id;
    await run('scene.select', { ids: [c] });
    await expectUndoable('anim.set_key', { frame: 0 });
    expect(Object.keys(anim().tracks)).toEqual([c]);
    await expectUndoable('anim.set_key', { ids: ['Kiste *'], frame: 5, rotation: [0, 90, 0] });
    expect(Object.keys(anim().tracks).sort()).toEqual([a, b, c].sort());
    await expectUndoable('anim.set_key', { groupId: 'Kisten', frame: 8, scale: [2, 2, 2] });
    expect(frames(track(a).scale)).toEqual([8]);
    expect(frames(track(b).scale)).toEqual([8]);
    expect(track(c).scale![0].frame).toBe(0);
    expect(group).toBeTruthy();
    // The selection is not changed by keying.
    expect(state().selection).toEqual([c]);
  });

  it('warns when the key is beyond the end of the animation', async () => {
    const id = await cube();
    const result = await run('anim.set_key', { ids: [id], frame: 120 });
    expect(result.warnings[0]).toContain('anim.set_range { frameCount: 121 }');
    expect((await run('anim.set_key', { ids: [id], frame: 119 })).warnings).toBeUndefined();
  });

  it('rejects bad input', async () => {
    const id = await cube();
    await run('scene.select', { ids: [] });
    await expectError('anim.set_key', { frame: 0 }, 'nothing is selected');
    await expectError('anim.set_key', { ids: [], frame: 0 }, 'empty');
    await expectError('anim.set_key', { ids: ['nope'], frame: 0 }, 'does not exist');
    for (const key of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      await expectError('anim.set_key', { ids: [key], frame: 0 }, 'does not exist');
      await expectError('anim.set_key', { groupId: key, frame: 0 }, 'does not exist');
      await expectError('anim.add_motion', { ids: [key], fromFrame: 0, toFrame: 5, translate: [1, 0, 0] }, 'does not exist');
      await expectError('anim.follow_path', { ids: [key], fromFrame: 0, toFrame: 5, points: [[0, 0, 0], [1, 0, 0]] }, 'does not exist');
      await expectError('anim.delete_key', { ids: [key], frame: 0 }, 'does not exist');
      await expectError('anim.clear', { ids: [key] }, 'does not exist');
      await expectError('anim.shift_keys', { ids: [key], delta: 1 }, 'does not exist');
      await expect(run('anim.get', { ids: [key] })).rejects.toThrow('does not exist');
      await expect(run('anim.evaluate', { ids: [key], frame: 0 })).rejects.toThrow('does not exist');
    }
    await expectError('anim.set_key', { ids: [id], frame: 0, scale: [1, 0, 1] }, 'scale must not be 0');
    for (const params of [
      { ids: [id] },
      { ids: [id], frame: -1 },
      { ids: [id], frame: 1.5 },
      { ids: [id], frame: 1_000_001 },
      { ids: [id], frame: 0, position: [0, 0, Infinity] },
      { ids: [id], frame: 0, position: [0, 0] },
      { ids: [id], frame: 0, rotation: false },
      { ids: [id], frame: 0, interpolation: 'bezier' },
      { ids: [id], frame: 0, visible: 'yes' },
    ]) {
      await expectError('anim.set_key', params, /./);
    }
    // A static scale of 0 cannot be keyed either.
    await run('scene.set_transform', { items: [{ id, scale: [0, 1, 1] }] });
    await expectError('anim.set_key', { ids: [id], frame: 0 }, 'scale of 0');
  });

  it('refuses to exceed the key limit of the document', async () => {
    const id = await cube();
    // A document that is already full (built directly; real documents get there with baked motions).
    const position = Array.from({ length: MAX_KEYS }, (_, frame) => ({ frame, value: [0, 0, 0] as Vec3, interpolation: 'linear' as const }));
    app = { ...app, docs: { [doc().id]: { ...doc(), state: { ...state(), animation: { fps: 24, frameCount: 120, tracks: { [id]: { position } }, camera: [] } } } } };
    await expectError('anim.set_key', { ids: [id], frame: 3, rotation: [0, 0, 0] }, `more than the ${MAX_KEYS}`);
    await expectError('anim.set_camera_key', { frame: 0, position: [0, 0, 5], target: [0, 0, 0] }, `more than the ${MAX_KEYS}`);
    // Replacing a key is still fine.
    await run('anim.set_key', { ids: [id], frame: 3, position: [1, 1, 1] });
    expect(track(id).position![3].value).toEqual([1, 1, 1]);
  });
});

describe('anim.delete_key and anim.clear', () => {
  it('deletes keys of one frame, by channel', async () => {
    const a = await cube();
    const b = await cube([2, 0, 0]);
    await run('anim.set_key', { ids: [a, b], frame: 0 });
    await run('anim.set_key', { ids: [a, b], frame: 10 });
    await run('anim.set_key', { ids: [a], frame: 10, visible: false });
    const one = await expectUndoable('anim.delete_key', { ids: [a, b], frame: 10, channels: ['rotation'] });
    expect(one).toMatchObject({ removed: 2, ids: [a, b] });
    expect(frames(track(a).rotation)).toEqual([0]);
    expect(frames(track(a).position)).toEqual([0, 10]);
    const rest = await expectUndoable('anim.delete_key', { ids: [a], frame: 10 });
    expect(rest.removed).toBe(3);
    expect(track(a).visible).toBeUndefined();
    // Deleting the last keys removes the track.
    await expectUndoable('anim.delete_key', { ids: [a], frame: 0 });
    expect(anim().tracks[a]).toBeUndefined();
    expect(Object.keys(anim().tracks)).toEqual([b]);
    expect(animatedState(state(), 5).objects[a]).toBe(state().objects[a]);
  });

  it('fails when there is no such key', async () => {
    const a = await cube();
    await expectError('anim.delete_key', { ids: [a], frame: 3 }, 'No key on frame 3');
    await run('anim.set_key', { ids: [a], frame: 3, position: true });
    await expectError('anim.delete_key', { ids: [a], frame: 3, channels: ['scale', 'visible'] }, 'No key on frame 3 in the channels scale, visible');
    await expectError('anim.delete_key', { ids: [a], frame: 3, channels: [] }, /./);
    await expectError('anim.delete_key', { ids: [a], frame: 3, channels: ['colour'] }, /./);
  });

  it('clear removes whole tracks, the camera keys, or everything', async () => {
    const a = await cube();
    const b = await cube([2, 0, 0]);
    const c = await cube([4, 0, 0]);
    await run('anim.set_range', { fps: 30 });
    await run('anim.set_key', { ids: [a, b, c], frame: 0 });
    await run('anim.set_key', { ids: [a, b, c], frame: 9 });
    await run('anim.set_camera_key', { frame: 0, position: [0, 0, 5], target: [0, 0, 0] });
    await run('scene.select', { ids: [a] });
    expect(await expectUndoable('anim.clear', {})).toEqual({ ids: [a], cameraKeysRemoved: 0, removed: 6 });
    expect(Object.keys(anim().tracks).sort()).toEqual([b, c].sort());
    expect(await expectUndoable('anim.clear', { camera: true })).toEqual({ ids: [], cameraKeysRemoved: 1, removed: 1 });
    expect(Object.keys(anim().tracks)).toHaveLength(2);
    await run('anim.set_camera_key', { frame: 0, position: [0, 0, 5], target: [0, 0, 0] });
    expect(await expectUndoable('anim.clear', { ids: [b], camera: true })).toEqual({ ids: [b], cameraKeysRemoved: 1, removed: 7 });
    await run('anim.set_camera_key', { frame: 0, position: [0, 0, 5], target: [0, 0, 0] });
    expect(await expectUndoable('anim.clear', { all: true })).toEqual({ ids: [c], cameraKeysRemoved: 1, removed: 7 });
    expect(anim()).toEqual({ fps: 30, frameCount: 120, tracks: {}, camera: [] });
    // Nothing to remove: no undo step.
    const past = doc().past.length;
    expect(await run('anim.clear', { all: true })).toEqual({ ids: [], cameraKeysRemoved: 0, removed: 0 });
    expect(await run('anim.clear', { ids: [a] })).toEqual({ ids: [], cameraKeysRemoved: 0, removed: 0 });
    expect(doc().past).toHaveLength(past);
  });
});

describe('anim.shift_keys', () => {
  async function setup() {
    const a = await cube();
    const b = await cube([2, 0, 0]);
    for (const frame of [0, 10, 20]) await run('anim.set_key', { ids: [a, b], frame, position: [frame, 0, 0] });
    await run('anim.set_key', { ids: [a], frame: 15, visible: false });
    for (const frame of [5, 25]) await run('anim.set_camera_key', { frame, position: [0, 0, 5], target: [0, 0, 0] });
    return { a, b };
  }

  it('moves keys later, from a frame on', async () => {
    const { a, b } = await setup();
    const result = await expectUndoable('anim.shift_keys', { ids: [a], fromFrame: 10, delta: 7 });
    expect(result).toMatchObject({ moved: 3, ids: [a], cameraKeysMoved: false, lastKeyFrame: 27 });
    expect(frames(track(a).position)).toEqual([0, 17, 27]);
    expect(frames(track(a).visible)).toEqual([22]);
    expect(track(a).position![1].value).toEqual([10, 0, 0]);
    expect(frames(track(b).position)).toEqual([0, 10, 20]);
    expect(frames(anim().camera)).toEqual([5, 25]);
  });

  it('moves keys earlier, the camera alone, and everything', async () => {
    const { a, b } = await setup();
    await expectUndoable('anim.shift_keys', { ids: [a], fromFrame: 10, delta: -9 });
    expect(frames(track(a).position)).toEqual([0, 1, 11]);
    expect(await expectUndoable('anim.shift_keys', { camera: true, delta: 100 })).toMatchObject({ moved: 2, ids: [], cameraKeysMoved: true, lastKeyFrame: 125 });
    expect(frames(anim().camera)).toEqual([105, 125]);
    expect(frames(track(b).position)).toEqual([0, 10, 20]);
    const all = await expectUndoable('anim.shift_keys', { all: true, delta: 3 });
    expect(all.moved).toBe(9);
    expect(all.warnings[0]).toContain('beyond the end');
    expect(frames(track(a).position)).toEqual([3, 4, 14]);
    expect(frames(track(b).position)).toEqual([3, 13, 23]);
    expect(frames(anim().camera)).toEqual([108, 128]);
    // Default target: the selection.
    await run('scene.select', { ids: [b] });
    await expectUndoable('anim.shift_keys', { delta: 1 });
    expect(frames(track(b).position)).toEqual([4, 14, 24]);
    expect(frames(track(a).position)).toEqual([3, 4, 14]);
  });

  it('rejects collisions and frames out of range without changing anything', async () => {
    const { a, b } = await setup();
    await expectError('anim.shift_keys', { ids: [a], fromFrame: 10, delta: -10 }, /frame 10 would collide with or overtake its key on frame 0/);
    await expectError('anim.shift_keys', { ids: [a], fromFrame: 20, delta: -12 }, /frame 20 would collide with or overtake its key on frame 10/);
    await expectError('anim.shift_keys', { ids: [a, b], delta: -1 }, /would land before frame 0/);
    await expectError('anim.shift_keys', { ids: [a], delta: 999_990 }, /beyond frame 1000000/);
    await expectError('anim.shift_keys', { ids: [a], delta: 0 }, 'delta must not be 0');
    await expectError('anim.shift_keys', { ids: [a], fromFrame: 500, delta: 5 }, 'nothing to shift');
    await expectError('anim.shift_keys', { ids: [a], delta: 1.5 }, /./);
    // One colliding object stops the whole command.
    await run('anim.set_key', { ids: [b], frame: 9, position: [9, 0, 0] });
    await expectError('anim.shift_keys', { ids: [a, b], fromFrame: 10, delta: -5 }, /collide/);
  });
});

describe('anim.add_motion', () => {
  it('translates with two keys per object and eases by default', async () => {
    const a = await cube([1, 0, 0]);
    const result = await expectUndoable('anim.add_motion', { ids: [a], fromFrame: 10, toFrame: 18, translate: [8, 0, 0] });
    expect(result).toMatchObject({ ids: [a], fromFrame: 10, toFrame: 18, channels: ['position'], keyFrames: [10, 18], keysWritten: 2 });
    expect(result.fromTime).toBeCloseTo(10 / 24, 6);
    expect(result.objects).toEqual([{ id: a, name: state().objects[a].name, from: state().objects[a].transform, to: { ...state().objects[a].transform, position: [9, 0, 0] } }]);
    expect(track(a)).toEqual({
      position: [
        { frame: 10, value: [1, 0, 0], interpolation: 'smooth' },
        { frame: 18, value: [9, 0, 0], interpolation: 'smooth' },
      ],
    });
    expect(pos(a, 0)).toEqual([1, 0, 0]);
    expectVec(pos(a, 12), [1 + 8 * 0.15625, 0, 0]);
    expectVec(pos(a, 14), [5, 0, 0]);
    expect(pos(a, 18)).toEqual([9, 0, 0]);
    expect(pos(a, 99)).toEqual([9, 0, 0]);
    // Until the motion starts the object is the static one.
    expect(animatedState(state(), 10)).toBe(state());
  });

  it('linear and step', async () => {
    const a = await cube();
    const b = await cube();
    await run('anim.add_motion', { ids: [a], fromFrame: 0, toFrame: 10, translate: [10, 0, 0], interpolation: 'linear' });
    expectVec(pos(a, 2.5), [2.5, 0, 0]);
    await run('anim.add_motion', { ids: [b], fromFrame: 0, toFrame: 10, rotate: [0, 90, 0], translate: [10, 0, 0], interpolation: 'step' });
    expect(frames(track(b).rotation)).toEqual([0, 10]);
    expect(at(b, 9.9)).toEqual(state().objects[b].transform);
    expect(at(b, 10)).toMatchObject({ position: [10, 0, 0], rotation: [0, 90, 0] });
  });

  it('rotates a group 180° about a pivot: every object stays on its circle and ends exactly at the transformed pose', async () => {
    const ids = [await cube([2, 0, 0]), await cube([4, 1, 0], { rotation: [0, 30, 0] }), await cube([1, -0.5, 3], { rotation: [10, 20, 30], scale: [1, 2, 0.5] })];
    await run('group.create', { ids, name: 'Arm' });
    await run('anim.set_range', { frameCount: 200 });
    const pivot: Vec3 = [0.5, 0, -0.25];
    const starts = ids.map((id) => state().objects[id].transform);
    const params = { rotate: [0, 180, 0], pivot };

    // What scene.transform_objects makes of it is the reference for the end pose.
    await run('scene.transform_objects', { groupId: 'Arm', ...params });
    const expected = ids.map((id) => state().objects[id].transform);
    await run('history.undo');
    expect(ids.map((id) => state().objects[id].transform)).toEqual(starts);

    const result = await expectUndoable('anim.add_motion', { groupId: 'Arm', fromFrame: 20, toFrame: 140, ...params });
    expect(result.ids).toEqual(ids);
    expect(result.pivot).toEqual(pivot);
    expect(result.channels).toEqual(['position', 'rotation']);
    expect(result.keyFrames[0]).toBe(20);
    expect(result.keyFrames.at(-1)).toBe(140);
    expect(result.keysWritten).toBe(result.keyFrames.length * 2 * 3);

    ids.forEach((id, n) => {
      // Exact at both ends; at rest outside.
      expect(at(id, 20)).toEqual(starts[n]);
      expect(at(id, 0)).toEqual(starts[n]);
      expect(at(id, 140)).toEqual(expected[n]);
      expect(at(id, 199)).toEqual(expected[n]);
      expect(result.objects[n]).toEqual({ id, name: state().objects[id].name, from: starts[n], to: expected[n] });

      const radius = Math.hypot(starts[n].position[0] - pivot[0], starts[n].position[2] - pivot[2]);
      const startAngle = Math.atan2(-(starts[n].position[2] - pivot[2]), starts[n].position[0] - pivot[0]);
      let previous = 0;
      for (let f = 20; f <= 140; f += 0.25) {
        const t = at(id, f);
        const dx = t.position[0] - pivot[0];
        const dz = t.position[2] - pivot[2];
        // On the circle (within the 1 mm baking tolerance; exact to rounding on the key frames), at constant height.
        expect(Math.abs(Math.hypot(dx, dz) - radius), `frame ${f}`).toBeLessThan(Number.isInteger(f) && result.keyFrames.includes(f) ? 2e-6 : 0.00105);
        expect(t.position[1]).toBeCloseTo(starts[n].position[1], 6);
        expect(t.scale).toEqual(starts[n].scale);
        // The angle travelled grows monotonically from 0 to 180 degrees and follows the easing.
        let angle = ((Math.atan2(-dz, dx) - startAngle) * 180) / Math.PI;
        if (angle < -1e-3) angle += 360;
        expect(angle).toBeGreaterThanOrEqual(previous - 1e-3);
        previous = angle;
        const u = (f - 20) / 120;
        expect(Math.abs(angle - 180 * (u * u * (3 - 2 * u)))).toBeLessThan(0.2);
        // The object itself has turned by the same angle (it moves like a rigid part of the group).
        const turned = eulerMatrix(t.rotation);
        const want = eulerMatrix([0, angle, 0]);
        const start = eulerMatrix(starts[n].rotation);
        const composed = [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => want[r * 3] * start[c] + want[r * 3 + 1] * start[3 + c] + want[r * 3 + 2] * start[6 + c]));
        turned.forEach((v, i) => expect(Math.abs(v - composed[i])).toBeLessThan(2e-3));
      }
      expect(previous).toBeCloseTo(180, 3);
    });

    // Baked keys are linear and at most 5 degrees (and 1/32 of the duration) apart.
    const keys = track(ids[0]).rotation!;
    expect(keys.slice(0, -1).every((k) => k.interpolation === 'linear')).toBe(true);
    expect(keys.at(-1)!.interpolation).toBe('smooth');
    for (let i = 1; i < keys.length; i++) expect(keys[i].frame - keys[i - 1].frame).toBeLessThanOrEqual(4);
  });

  it('chains: a second motion starts from the evaluated pose', async () => {
    const a = await cube([2, 0, 0]);
    const b = await cube([3, 0, 0]);
    await run('group.create', { ids: [a, b], name: 'Paar' });
    await expectUndoable('anim.add_motion', { groupId: 'Paar', fromFrame: 0, toFrame: 24, rotate: [0, 90, 0], pivot: [0, 0, 0], interpolation: 'linear' });
    expectVec(pos(a, 24), [0, 0, -2]);
    expectVec(pos(b, 24), [0, 0, -3]);
    // Second motion later: lift by 1 m; the default pivot / start is the pose at frame 48 (= the end of the first).
    const second = await expectUndoable('anim.add_motion', { groupId: 'Paar', fromFrame: 48, toFrame: 72, translate: [0, 1, 0], interpolation: 'linear' });
    expect(second.objects[0].from.position).toEqual([0, 0, -2]);
    expectVec(pos(a, 36), [0, 0, -2]);
    expectVec(pos(a, 60), [0, 0.5, -2]);
    expectVec(pos(a, 72), [0, 1, -2]);
    // Third motion directly after: another quarter turn about the world origin, starting from the lifted pose.
    await expectUndoable('anim.add_motion', { groupId: 'Paar', fromFrame: 72, toFrame: 96, rotate: [0, 90, 0], pivot: [0, 0, 0], interpolation: 'linear' });
    expectVec(pos(a, 96), [-2, 1, 0]);
    expectVec(pos(b, 96), [-3, 1, 0]);
    expectSameOrientation(at(a, 96).rotation, [0, 180, 0]);
    expectVec(pos(a, 84), [-Math.SQRT2, 1, -Math.SQRT2], 3);
    // The earlier motions are untouched.
    expectVec(pos(a, 12), [Math.SQRT2, 0, -Math.SQRT2], 3);
    expectSameOrientation(at(a, 12).rotation, [0, 45, 0], 3);
    // The default pivot is the centre of the unit at fromFrame.
    const spin = await run('anim.add_motion', { groupId: 'Paar', fromFrame: 96, toFrame: 110, rotate: [0, 180, 0] });
    expectVec(spin.pivot, [-2.5, 1, 0]);
    expectVec(pos(a, 110), [-3, 1, 0]);
    expectVec(pos(b, 110), [-2, 1, 0]);
  });

  it('turns of any size: a full turn goes all the way round', async () => {
    const a = await cube([1, 0, 0]);
    const result = await run('anim.add_motion', { ids: [a], fromFrame: 0, toFrame: 100, rotate: [0, 360, 0], pivot: [0, 0, 0], interpolation: 'linear' });
    expect(result.keyFrames.length).toBeGreaterThanOrEqual(73);
    expectVec(pos(a, 25), [0, 0, -1], 5);
    expectVec(pos(a, 50), [-1, 0, 0], 5);
    expectVec(pos(a, 75), [0, 0, 1], 5);
    expectVec(pos(a, 100), [1, 0, 0]);
    expectSameOrientation(at(a, 50).rotation, [0, 180, 0]);
    expectSameOrientation(at(a, 62.5).rotation, [0, 225, 0], 3);
  });

  it('keeps distant objects on the arc with more keys, as far as whole frames allow', async () => {
    const far = await cube([50, 0, 0]);
    await run('anim.set_range', { frameCount: 2000 });
    const result = await run('anim.add_motion', { ids: [far], fromFrame: 0, toFrame: 1000, rotate: [0, 90, 0], pivot: [0, 0, 0], interpolation: 'linear' });
    // 50 m from the pivot a 1 mm sag allows 0.72 degrees per key: at least 125 segments.
    expect(result.keyFrames.length).toBeGreaterThan(125);
    for (let f = 0; f <= 1000; f += 3.7) expect(Math.abs(Math.hypot(pos(far, f)[0], pos(far, f)[2]) - 50)).toBeLessThan(0.00105);
  });

  it('scales about the pivot together with a move', async () => {
    const a = await cube([2, 0, 0]);
    const result = await expectUndoable('anim.add_motion', { ids: [a], fromFrame: 0, toFrame: 10, scale: 3, translate: [0, 1, 0], pivot: [0, 0, 0], interpolation: 'linear' });
    expect(result.channels).toEqual(['position', 'scale']);
    expect(at(a, 10)).toEqual({ position: [6, 1, 0], rotation: [0, 0, 0], scale: [3, 3, 3] });
    expectVec(at(a, 5).position, [4, 0.5, 0]);
    expectVec(at(a, 5).scale, [2, 2, 2]);
    expect(track(a).rotation).toBeUndefined();
    // Same end pose as scene.transform_objects, also for a non-uniform scale with rotation.
    const b = await cube([1, 2, 3], { rotation: [0, 0, 90] });
    const params = { scale: [2, 1, 0.5], rotate: [90, 0, 0], translate: [1, 1, 1], pivot: [1, 0, 0] };
    await run('scene.transform_objects', { ids: [b], ...params });
    const expected = state().objects[b].transform;
    await run('history.undo');
    await run('anim.add_motion', { ids: [b], fromFrame: 0, toFrame: 30, ...params });
    expect(at(b, 30)).toEqual(expected);
    expect(Object.keys(track(b)).sort()).toEqual(['position', 'rotation', 'scale']);
  });

  it('replaces the keys of its channels inside its frame range and leaves the rest alone', async () => {
    const a = await cube();
    for (const frame of [0, 5, 10, 15, 20]) await run('anim.set_key', { ids: [a], frame, position: [0, frame, 0], rotation: [0, 0, frame], interpolation: 'linear' });
    await expectUndoable('anim.add_motion', { ids: [a], fromFrame: 5, toFrame: 15, translate: [1, 0, 0], interpolation: 'linear' });
    expect(track(a).position!.map((k) => [k.frame, ...k.value])).toEqual([
      [0, 0, 0, 0],
      [5, 0, 5, 0],
      [15, 1, 5, 0],
      [20, 0, 20, 0],
    ]);
    expect(frames(track(a).rotation)).toEqual([0, 5, 10, 15, 20]);
  });

  it('rejects bad input', async () => {
    const a = await cube();
    const base = { ids: [a], fromFrame: 0, toFrame: 10 };
    await expectError('anim.add_motion', base, 'at least one of translate, rotate or scale');
    await expectError('anim.add_motion', { ...base, translate: [0, 0, 0], rotate: [0, 0, 0], scale: 1 }, 'at least one of translate, rotate or scale');
    await expectError('anim.add_motion', { ...base, toFrame: 0, translate: [1, 0, 0] }, 'toFrame must be greater than fromFrame');
    await expectError('anim.add_motion', { ...base, fromFrame: 20, translate: [1, 0, 0] }, 'toFrame must be greater than fromFrame');
    await expectError('anim.add_motion', { ...base, scale: 0 }, 'greater than 0');
    await expectError('anim.add_motion', { ...base, scale: [1, -1, 1] }, 'greater than 0');
    await expectError('anim.add_motion', { ...base, translate: [NaN, 0, 0] }, /./);
    await expectError('anim.add_motion', { ...base, toFrame: 10.5, translate: [1, 0, 0] }, /./);
    await expectError('anim.add_motion', { ids: [a], toFrame: 10, translate: [1, 0, 0] }, /./);
    await run('scene.select', { ids: [] });
    await expectError('anim.add_motion', { fromFrame: 0, toFrame: 10, translate: [1, 0, 0] }, 'nothing is selected');
  });
});

describe('anim.follow_path', () => {
  const route: Vec3[] = [
    [0, 1, 0],
    [6, 1, 0],
    [6, 1, -4],
    [6, 3, -4],
  ];
  const routeLength = 12;
  /** Distance travelled along `route` of a point on it, or NaN if it is off the route. */
  function travelled(p: Vec3): number {
    let done = 0;
    for (let i = 0; i + 1 < route.length; i++) {
      const a = route[i];
      const b = route[i + 1];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const t = ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1]) + (p[2] - a[2]) * (b[2] - a[2])) / (length * length);
      const off = Math.hypot(a[0] + (b[0] - a[0]) * t - p[0], a[1] + (b[1] - a[1]) * t - p[1], a[2] + (b[2] - a[2]) * t - p[2]);
      if (off < 1e-5 && t > -1e-6 && t < 1 + 1e-6) return done + t * length;
      done += length;
    }
    return NaN;
  }

  it('moves the anchor along the route at constant speed and is exact at both ends', async () => {
    const a = await cube([10, 10, 10]);
    await run('anim.set_range', { fps: 25 });
    const result = await expectUndoable('anim.follow_path', { ids: [a], points: route, fromFrame: 10, toFrame: 59 });
    expect(result).toMatchObject({ ids: [a], anchor: [10, 10, 10], length: 12, fromFrame: 10, toFrame: 59 });
    expect(result.speed).toBeCloseTo((12 / 49) * 25, 5);
    // Corners at 10 + 49 * 6/12 = 34.5 and 10 + 49 * 10/12 = 50.83: keys on the whole frames around them.
    expect(result.keyFrames).toEqual([10, 34, 35, 50, 51, 59]);
    expect(result.keysWritten).toBe(6);
    expect(track(a).position!.every((k) => k.interpolation === 'linear')).toBe(true);
    expect(track(a).rotation).toBeUndefined();
    expect(pos(a, 10)).toEqual([0, 1, 0]);
    expect(pos(a, 59)).toEqual([6, 3, -4]);
    expect(pos(a, 0)).toEqual([0, 1, 0]);
    expect(pos(a, 100)).toEqual([6, 3, -4]);
    // On every whole frame the object is on the route, exactly as far along as constant speed says.
    for (let f = 10; f <= 59; f++) expect(travelled(pos(a, f)), `frame ${f}`).toBeCloseTo((routeLength * (f - 10)) / 49, 5);
    // Between whole frames too, except inside the single frame in which a corner is passed.
    for (const f of [10.5, 20.25, 33.9, 35.1, 49.99, 51.5, 58.75]) expect(travelled(pos(a, f)), `frame ${f}`).toBeCloseTo((routeLength * (f - 10)) / 49, 5);
    expect(result.objects[0].from.position).toEqual([0, 1, 0]);
    expect(result.objects[0].to.position).toEqual([6, 3, -4]);
  });

  it('is exact at corners that fall on whole frames', async () => {
    const a = await cube();
    const result = await run('anim.follow_path', { ids: [a], points: route, fromFrame: 0, toFrame: 24 });
    expect(result.keyFrames).toEqual([0, 12, 20, 24]);
    expect(pos(a, 12)).toEqual([6, 1, 0]);
    expect(pos(a, 20)).toEqual([6, 1, -4]);
    expectVec(pos(a, 6), [3, 1, 0]);
    expectVec(pos(a, 22), [6, 2, -4]);
  });

  it('moves a group as a unit, by its centre, underside or an explicit anchor', async () => {
    const a = await cube([0, 0.5, 0]);
    const b = await cube([0, 1.5, 0], { scale: [0.5, 1, 0.5] });
    await run('group.create', { ids: [a, b], name: 'Kiste' });
    const points = [
      [5, 0, 5],
      [9, 0, 5],
    ];
    const bottom = await expectUndoable('anim.follow_path', { groupId: 'Kiste', points, fromFrame: 0, toFrame: 8, anchor: 'bottom' });
    // The cubes are 2 m wide: together they reach from y = -0.5 to y = 2.5.
    expect(bottom.anchor).toEqual([0, -0.5, 0]);
    expect(pos(a, 0)).toEqual([5, 1, 5]);
    expect(pos(b, 0)).toEqual([5, 2, 5]);
    expectVec(pos(b, 4), [7, 2, 5]);
    expect(pos(a, 8)).toEqual([9, 1, 5]);
    await run('history.undo');
    const center = await run('anim.follow_path', { groupId: 'Kiste', points, fromFrame: 0, toFrame: 8 });
    expect(center.anchor).toEqual([0, 1, 0]);
    expect(pos(a, 8)).toEqual([9, -0.5, 5]);
    await run('history.undo');
    const custom = await run('anim.follow_path', { groupId: 'Kiste', points, fromFrame: 0, toFrame: 8, anchor: [1, 0, 0] });
    expect(custom.anchor).toEqual([1, 0, 0]);
    expect(pos(a, 8)).toEqual([8, 0.5, 5]);
  });

  it('orient turns the unit about the vertical axis through the anchor to face the way it travels', async () => {
    const body = await cube([0, 0, 0]);
    const nose = await cube([1, 0, 0], { scale: [0.2, 0.2, 0.2] });
    const points = [
      [0, 0, 0],
      [4, 0, 0],
      [4, 0, -4],
      [4, 2, -4],
      [0, 2, -4],
    ];
    const result = await expectUndoable('anim.follow_path', { ids: [body, nose], points, fromFrame: 0, toFrame: 28, orient: true, anchor: [0, 0, 0] });
    // Corners on frames 8, 16 and 20; the turn happens in the frame after each corner.
    expect(result.keyFrames).toEqual([0, 8, 9, 16, 17, 20, 21, 28]);
    expect(result.keysWritten).toBe(8 * 2 * 2);
    // First leg (+X): as modelled, the nose ahead of the body.
    expect(at(body, 4)).toMatchObject({ position: [2, 0, 0], rotation: [0, 0, 0] });
    expectVec(pos(nose, 4), [3, 0, 0]);
    expect(pos(body, 8)).toEqual([4, 0, 0]);
    expect(at(body, 8).rotation).toEqual([0, 0, 0]);
    // Second leg (-Z): turned 90 degrees counter-clockwise seen from above, the nose still ahead.
    expectSameOrientation(at(body, 12).rotation, [0, 90, 0]);
    expectVec(pos(body, 12), [4, 0, -2]);
    expectVec(pos(nose, 12), [4, 0, -3]);
    // Straight up: keeps the heading.
    expectSameOrientation(at(body, 18.5).rotation, [0, 90, 0]);
    expectVec(pos(nose, 18.5), [4, 1.25, -5]);
    // Last leg (-X): half a turn from the start.
    expectSameOrientation(at(body, 25).rotation, [0, 180, 0]);
    expectVec(pos(body, 25), [1.5, 2, -4]);
    expectVec(pos(nose, 25), [0.5, 2, -4]);
    expect(pos(body, 28)).toEqual([0, 2, -4]);
    expectVec(pos(nose, 28), [-1, 2, -4]);
  });

  it('closed returns to the first point; duplicate points are ignored', async () => {
    const a = await cube();
    const result = await run('anim.follow_path', {
      ids: [a],
      points: [
        [0, 0, 0],
        [0, 0, 0],
        [3, 0, 0],
        [3, 0, 4],
      ],
      fromFrame: 0,
      toFrame: 12,
      closed: true,
    });
    expect(result.length).toBe(12);
    expect(result.keyFrames).toEqual([0, 3, 7, 12]);
    expect(pos(a, 3)).toEqual([3, 0, 0]);
    expect(pos(a, 7)).toEqual([3, 0, 4]);
    expectVec(pos(a, 9.5), [1.5, 0, 2]);
    expect(pos(a, 12)).toEqual([0, 0, 0]);
  });

  it('chains with other motions and replaces keys in its range', async () => {
    const a = await cube([1, 0, 0]);
    await run('anim.add_motion', { ids: [a], fromFrame: 0, toFrame: 10, rotate: [0, 90, 0], pivot: [0, 0, 0], interpolation: 'linear' });
    // Travel on from where the turn ended (anchor = its centre there), keeping the orientation.
    const result = await run('anim.follow_path', { ids: [a], points: [[0, 0, -1], [0, 5, -1]], fromFrame: 10, toFrame: 20 });
    expectVec(result.anchor, [0, 0, -1]);
    expectVec(pos(a, 5), [Math.SQRT1_2, 0, -Math.SQRT1_2], 3);
    expectVec(pos(a, 15), [0, 2.5, -1]);
    expectSameOrientation(at(a, 15).rotation, [0, 90, 0]);
    expect(track(a).position!.filter((k) => k.frame >= 10).map((k) => k.frame)).toEqual([10, 20]);
  });

  it('rejects bad input', async () => {
    const a = await cube();
    const base = { ids: [a], fromFrame: 0, toFrame: 10 };
    await expectError('anim.follow_path', { ...base, points: [[1, 1, 1], [1, 1, 1]] }, 'all the same');
    await expectError('anim.follow_path', { ...base, points: [[1, 1, 1]] }, /./);
    await expectError('anim.follow_path', { ...base, points: [[0, 0, 0], [1, 0]] }, /./);
    await expectError('anim.follow_path', { ...base, points: [[0, 0, 0], [1, 0, Infinity]] }, /./);
    await expectError('anim.follow_path', { ...base, toFrame: 0, points: [[0, 0, 0], [1, 0, 0]] }, 'toFrame must be greater than fromFrame');
    await expectError('anim.follow_path', { ...base, points: [[0, 0, 0], [1, 0, 0]], anchor: 'top' }, /./);
    await expectError('anim.follow_path', { ...base, points: Array.from({ length: 10_001 }, (_, i) => [i, 0, 0]) }, /./);
  });
});

describe('camera', () => {
  it('sets, replaces and deletes camera keys', async () => {
    expect(cameraAt(state().animation, 0)).toBeNull();
    const first = await expectUndoable('anim.set_camera_key', { frame: 24, position: [0, 2, 10], target: [0, 1, 0] });
    expect(first).toEqual({ frame: 24, time: 1, cameraKeys: 1 });
    expect(anim().camera).toEqual([{ frame: 24, position: [0, 2, 10], target: [0, 1, 0], fov: 40, interpolation: 'smooth' }]);
    await expectUndoable('anim.set_camera_key', { frame: 0, position: [10, 2, 0], target: [0, 1, 0], fov: 60, interpolation: 'linear' });
    expect(frames(anim().camera)).toEqual([0, 24]);
    const mid = cameraAt(anim(), 12)!;
    expectVec(mid.position, [5, 2, 5]);
    expect(mid.fov).toBeCloseTo(50, 9);
    await expectUndoable('anim.set_camera_key', { frame: 24, position: [0, 5, 10], target: [0, 0, 0], fov: 30 });
    expect(anim().camera).toHaveLength(2);
    expect(anim().camera[1]).toMatchObject({ position: [0, 5, 10], fov: 30 });
    expect(await expectUndoable('anim.delete_camera_key', { frame: 0 })).toEqual({ frame: 0, cameraKeys: 1 });
    await expectError('anim.delete_camera_key', { frame: 0 }, 'no camera key on frame 0');
    await expectUndoable('anim.delete_camera_key', { frame: 24 });
    expect(cameraAt(anim(), 5)).toBeNull();
  });

  it('rejects bad camera keys', async () => {
    await expectError('anim.set_camera_key', { frame: 0, position: [1, 1, 1], target: [1, 1, 1] }, 'must not be the same point');
    for (const params of [
      { position: [0, 0, 5], target: [0, 0, 0] },
      { frame: 0, position: [0, 0, 5] },
      { frame: 0, position: [0, 0, 5], target: [0, 0, 0], fov: 0 },
      { frame: 0, position: [0, 0, 5], target: [0, 0, 0], fov: 180 },
      { frame: -2, position: [0, 0, 5], target: [0, 0, 0] },
      { frame: 0, position: [0, 0, NaN], target: [0, 0, 0] },
    ]) {
      await expectError('anim.set_camera_key', params, /./);
    }
  });

  it('camera_orbit holds radius and height on the whole way round', async () => {
    const target: Vec3 = [2, 1, -3];
    const result = await expectUndoable('anim.camera_orbit', { target, radius: 8, height: 3, fromFrame: 10, toFrame: 100, fov: 35 });
    expect(result).toMatchObject({ fromFrame: 10, toFrame: 100, startPosition: [10, 4, -3], endPosition: [10, 4, -3] });
    expect(result.keysWritten).toBe(91); // 4 degrees per frame: a key on every frame
    expect(anim().camera.slice(0, -1).every((k) => k.interpolation === 'linear')).toBe(true);
    for (let f = 0; f <= 110; f += 0.25) {
      const camera = cameraAt(anim(), f)!;
      expect(camera.target).toEqual(target);
      expect(camera.fov).toBe(35);
      expect(camera.position[1]).toBeCloseTo(4, 9);
      const radius = Math.hypot(camera.position[0] - target[0], camera.position[2] - target[2]);
      // Exact on the keys; between two keys 4 degrees apart the chord dips by 8 * (1 - cos 2°) = 4.9 mm.
      expect(Math.abs(radius - 8), `frame ${f}`).toBeLessThan(Number.isInteger(f) ? 2e-6 : 0.005);
      // Constant angular speed, counter-clockwise seen from above (from +X towards -Z).
      if (f >= 10 && f <= 100 && Number.isInteger(f)) {
        const angle = (((f - 10) / 90) * 360 * Math.PI) / 180;
        expectVec(camera.position, [target[0] + 8 * Math.cos(angle), 4, target[2] - 8 * Math.sin(angle)], 5);
      }
    }
    expectVec(cameraAt(anim(), 55)!.position, [-6, 4, -3], 5);
  });

  it('camera_orbit: slow orbits get a key every 2 degrees and stay within 0.02 % of the radius', async () => {
    await run('anim.set_range', { frameCount: 3000 });
    const result = await run('anim.camera_orbit', { target: [0, 0, 0], radius: 20, height: -2, fromFrame: 0, toFrame: 2400, startAngle: 90, turns: -0.5 });
    // 180 degrees in steps of at most 2 degrees on whole frames: 26 frames per key.
    expect(result.keysWritten).toBe(Math.ceil(2400 / 26) + 1);
    expect(result.startPosition).toEqual([0, -2, -20]);
    expect(result.endPosition).toEqual([0, -2, 20]);
    for (let f = 0; f <= 2400; f += 7.3) {
      const camera = cameraAt(anim(), f)!;
      expect(Math.abs(Math.hypot(camera.position[0], camera.position[2]) - 20)).toBeLessThan(20 * 2e-4);
      expect(camera.position[1]).toBeCloseTo(-2, 9);
    }
    // Clockwise seen from above: from -Z over +X to +Z.
    expectVec(cameraAt(anim(), 1200)!.position, [20, -2, 0], 2);
  });

  it('camera_orbit: smooth eases the whole move, and existing keys in the range are replaced', async () => {
    await run('anim.set_camera_key', { frame: 0, position: [0, 9, 9], target: [0, 0, 0] });
    await run('anim.set_camera_key', { frame: 30, position: [9, 9, 9], target: [0, 0, 0] });
    await run('anim.set_camera_key', { frame: 110, position: [1, 1, 1], target: [0, 0, 0] });
    await expectUndoable('anim.camera_orbit', { target: [0, 0, 0], radius: 5, height: 0, fromFrame: 20, toFrame: 100, turns: 0.5, interpolation: 'smooth' });
    expect(frames(anim().camera)[0]).toBe(0);
    expect(frames(anim().camera).at(-1)).toBe(110);
    // The old key on frame 30 is gone: every key from 20 to 100 is on the orbit.
    for (const k of anim().camera.filter((c) => c.frame >= 20 && c.frame <= 100)) expect(Math.hypot(k.position[0], k.position[2])).toBeCloseTo(5, 5);
    for (const f of [20, 40, 60, 80, 100]) {
      const u = (f - 20) / 80;
      const angle = Math.PI * (u * u * (3 - 2 * u));
      expectVec(cameraAt(anim(), f)!.position, [5 * Math.cos(angle), 0, -5 * Math.sin(angle)], 2);
    }
    expect(cameraAt(anim(), 100)!.position).toEqual([-5, 0, 0]);
  });

  it('camera_orbit rejects bad input', async () => {
    const base = { target: [0, 0, 0], radius: 5, height: 1, fromFrame: 0, toFrame: 10 };
    await expectError('anim.camera_orbit', { ...base, toFrame: 0 }, 'toFrame must be greater than fromFrame');
    await expectError('anim.camera_orbit', { ...base, turns: 0 }, 'turns must not be 0');
    for (const patch of [{ radius: 0 }, { radius: -1 }, { height: Infinity }, { turns: 2000 }, { fov: 0 }, { interpolation: 'step' }, { target: [0, 0] }]) {
      await expectError('anim.camera_orbit', { ...base, ...patch }, /./);
    }
  });
});

describe('queries', () => {
  async function scene() {
    const a = await cube([0, 0, 0], { name: 'A' });
    const b = await cube([5, 0, 0], { name: 'B' });
    const c = await cube([9, 0, 0], { name: 'C' });
    await run('anim.set_range', { fps: 20, frameCount: 100 });
    await run('anim.add_motion', { ids: [a], fromFrame: 0, toFrame: 40, translate: [4, 0, 0], interpolation: 'linear' });
    await run('anim.add_motion', { ids: [b], fromFrame: 0, toFrame: 40, rotate: [0, 90, 0], pivot: [0, 0, 0], interpolation: 'linear' });
    await run('anim.set_key', { ids: [b], frame: 30, visible: false });
    await run('anim.set_camera_key', { frame: 0, position: [0, 5, 10], target: [0, 0, 0], interpolation: 'linear' });
    await run('anim.set_camera_key', { frame: 40, position: [0, 5, 20], target: [0, 0, 0] });
    return { a, b, c };
  }

  it('anim.get lists ranges, channels and keys', async () => {
    const { a, b, c } = await scene();
    const all = await query('anim.get');
    expect(all).toMatchObject({ fps: 20, frameCount: 100, duration: 5, firstKeyFrame: 0, lastKeyFrame: 40, total: 2 });
    expect(all.keyCount).toBe(2 + track(b).position!.length * 2 + 1 + 2);
    expect(all.objects.map((o: { id: string }) => o.id)).toEqual([a, b]);
    expect(all.objects[0]).toEqual({
      id: a,
      name: 'A',
      channels: {
        position: {
          count: 2,
          firstFrame: 0,
          lastFrame: 40,
          keys: [
            { frame: 0, value: [0, 0, 0], interpolation: 'linear' },
            { frame: 40, value: [4, 0, 0], interpolation: 'linear' },
          ],
        },
      },
    });
    expect(Object.keys(all.objects[1].channels)).toEqual(['position', 'rotation', 'visible']);
    expect(all.objects[1].channels.visible.keys).toEqual([{ frame: 30, value: false, interpolation: 'step' }]);
    expect(all.camera).toMatchObject({ count: 2, firstFrame: 0, lastFrame: 40 });
    expect(all.camera.keys[1]).toEqual({ frame: 40, position: [0, 5, 20], target: [0, 0, 0], fov: 40, interpolation: 'smooth' });

    // Filters, paging and caps.
    expect((await query('anim.get', { ids: [c, 'A'], camera: false })).objects.map((o: { id: string }) => o.id)).toEqual([a]);
    expect((await query('anim.get', { camera: false })).camera).toBeUndefined();
    const page = await query('anim.get', { offset: 1, limit: 1, includeKeys: false });
    expect(page.total).toBe(2);
    expect(page.objects).toHaveLength(1);
    expect(page.objects[0].channels.position).toEqual({ count: track(b).position!.length, firstFrame: 0, lastFrame: 40 });
    expect(page.camera).toEqual({ count: 2, firstFrame: 0, lastFrame: 40 });
    const capped = await query('anim.get', { ids: [b], maxKeys: 3 });
    expect(capped.objects[0].channels.rotation.keys).toHaveLength(3);
    expect(capped.objects[0].channels.rotation.truncated).toBe(true);
    expect(capped.objects[0].channels.visible.truncated).toBeUndefined();
    const ranged = await query('anim.get', { ids: [b], fromFrame: 35, toFrame: 40 });
    expect(ranged.objects[0].channels.position.keys.every((k: { frame: number }) => k.frame >= 35)).toBe(true);
    expect(ranged.objects[0].channels.visible.keys).toEqual([]);
    expect(ranged.camera.keys.map((k: { frame: number }) => k.frame)).toEqual([40]);
  });

  it('anim.evaluate tells where everything is at a frame', async () => {
    const { a, b, c } = await scene();
    const result = await query('anim.evaluate', { frame: 20 });
    expect(result).toMatchObject({ fps: 20, frameCount: 100, total: 2 });
    expect(result.samples).toHaveLength(1);
    const sample = result.samples[0];
    expect(sample).toMatchObject({ frame: 20, time: 1 });
    expect(sample.objects[0]).toEqual({ id: a, name: 'A', animated: true, visible: true, transform: { position: [2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, center: [2, 0, 0] });
    expect(sample.objects[1].id).toBe(b);
    expectVec(sample.objects[1].transform.position, [5 * Math.SQRT1_2, 0, -5 * Math.SQRT1_2], 3);
    expectVec(sample.objects[1].transform.rotation, [0, 45, 0], 3);
    expectVec(sample.objects[1].center, [5 * Math.SQRT1_2, 0, -5 * Math.SQRT1_2], 3);
    expectVec(sample.camera.position, [0, 5, 15]);
    expect(sample.camera.fov).toBe(40);

    // Several frames, explicit objects (animated or not), visibility.
    const many = await query('anim.evaluate', { frame: [0, 29.5, 30, 40, 99], ids: [b, c] });
    expect(many.total).toBe(2);
    expect(many.samples.map((s: { frame: number }) => s.frame)).toEqual([0, 29.5, 30, 40, 99]);
    expect(many.samples.map((s: { time: number }) => s.time)).toEqual([0, 1.475, 1.5, 2, 4.95]);
    expect(many.samples.map((s: { objects: { visible: boolean }[] }) => s.objects[0].visible)).toEqual([false, false, false, false, false]);
    expect(many.samples[3].objects[0].transform).toEqual({ position: [0, 0, -5], rotation: [0, 90, 0], scale: [1, 1, 1] });
    expect(many.samples[4].objects[1]).toEqual({ id: c, name: 'C', animated: false, visible: true, transform: { position: [9, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, center: [9, 0, 0] });
    expect(many.samples[4].camera.position).toEqual([0, 5, 20]);

    const paged = await query('anim.evaluate', { frame: 0, offset: 1, limit: 5 });
    expect(paged.samples[0].objects.map((o: { id: string }) => o.id)).toEqual([b]);
    await run('anim.clear', { camera: true });
    expect((await query('anim.evaluate', { frame: 0 })).samples[0].camera).toBeNull();
  });

  it('anim.evaluate rejects bad input', async () => {
    await scene();
    for (const params of [{}, { frame: -1 }, { frame: [] }, { frame: [0, NaN] }, { frame: Array.from({ length: 201 }, (_, i) => i) }, { frame: 0, limit: 0 }]) {
      await expect(run('anim.evaluate', params)).rejects.toThrow();
    }
    // An unanimated document simply has nothing to report.
    app = createAppState();
    expect(await query('anim.evaluate', { frame: 3 })).toEqual({ fps: 24, frameCount: 120, total: 0, samples: [{ frame: 3, time: 0.125, objects: [], camera: null }] });
  });
});

describe('housekeeping in other commands', () => {
  async function animated(position: Vec3 = [0, 0, 0], params: Record<string, unknown> = {}) {
    const id = await cube(position, params);
    await run('anim.add_motion', { ids: [id], fromFrame: 0, toFrame: 10, translate: [1, 0, 0], interpolation: 'linear' });
    return id;
  }

  it('deleting objects deletes their tracks; undo brings both back', async () => {
    const a = await animated();
    const b = await animated([3, 0, 0]);
    const before = state();
    await run('scene.delete_objects', { ids: [a] });
    expect(Object.keys(anim().tracks)).toEqual([b]);
    expect(invariantErrors(state())).toEqual([]);
    expect(doc().past.at(-1)).toBe(before);
    await run('history.undo');
    expect(state()).toBe(before);
    expect(Object.keys(anim().tracks).sort()).toEqual([a, b].sort());
  });

  it('deleting a group with its objects deletes their tracks too', async () => {
    const a = await animated();
    const b = await animated([3, 0, 0]);
    const keep = await animated([6, 0, 0]);
    const group = (await run('group.create', { ids: [a, b] })).id;
    await run('group.delete', { id: group });
    expect(Object.keys(anim().tracks)).toEqual([keep]);
    expect(invariantErrors(state())).toEqual([]);
  });

  it('duplicating copies the tracks, with position keys moved by the offset', async () => {
    const a = await animated([0, 0, 0]);
    const plain = await cube([5, 5, 5]);
    await run('anim.set_key', { ids: [a], frame: 5, rotation: [0, 90, 0] });
    const result = await run('scene.duplicate_objects', { ids: [a, plain], offset: [0, 2, 0] });
    const [copy, plainCopy] = result.objects.map((o: { id: string }) => o.id);
    expect(invariantErrors(state())).toEqual([]);
    expect(track(copy).position).toEqual([
      { frame: 0, value: [0, 2, 0], interpolation: 'linear' },
      { frame: 10, value: [1, 2, 0], interpolation: 'linear' },
    ]);
    expect(track(copy).rotation).toEqual(track(a).rotation);
    expect(track(a).position![0].value).toEqual([0, 0, 0]);
    expect(anim().tracks[plainCopy]).toBeUndefined();
    expectVec(pos(copy, 5), [0.5, 2, 0]);
    // One undo step removes the copies and their tracks.
    await run('history.undo');
    expect(Object.keys(anim().tracks)).toEqual([a]);
    // Without animated sources the animation object is not touched.
    const before = anim();
    await run('scene.duplicate_objects', { ids: [plain] });
    expect(anim()).toBe(before);
  });

  it('commands that change the static transform or the mesh of animated objects warn that keys were not adjusted', async () => {
    const a = await animated([1, 0, 0], { name: 'Kiste' });
    const plain = await cube([5, 0, 0]);
    const keys = track(a);
    const moved = await run('scene.transform_objects', { ids: [a, plain], translate: [0, 1, 0] });
    expect(moved.warnings).toHaveLength(1);
    expect(moved.warnings[0]).toContain('Object "Kiste" has animation keys');
    expect(moved.warnings[0]).toContain('NOT adjusted');
    expect((await run('scene.transform_objects', { ids: [plain], translate: [0, 1, 0] })).warnings).toBeUndefined();
    const set = await run('scene.set_transform', { items: [{ id: a, position: [2, 2, 2] }] });
    expect(set.warnings[0]).toContain('keep following their keys');
    expect(await run('scene.set_transform', { items: [{ id: plain, position: [2, 2, 2] }] })).toEqual({ ok: true });
    const applied = await run('scene.apply_transform', { ids: [a], position: true });
    expect(applied.warnings[0]).toContain('NOT adjusted');
    const mirrored = await run('scene.mirror_objects', { ids: [a], axis: 'x', duplicate: false });
    expect(mirrored.warnings[0]).toContain('NOT adjusted');
    const copies = await run('scene.mirror_objects', { ids: [a, plain], axis: 'x' });
    expect(copies.warnings[0]).toContain('NOT animated');
    expect(anim().tracks[copies.ids[0]]).toBeUndefined();
    expect((await run('scene.mirror_objects', { ids: [plain], axis: 'x' })).warnings).toBeUndefined();
    // None of them touched the keys.
    expect(track(a)).toBe(keys);
  });

  it('imports and new documents carry no animation', async () => {
    await animated();
    await run('document.new');
    expect(state().animation).toBeUndefined();
  });
});

describe('project files', () => {
  async function animatedDoc() {
    const a = await cube([0, 0, 0]);
    const b = await cube([2, 0, 0]);
    await run('anim.set_range', { fps: 30, frameCount: 240 });
    await run('anim.add_motion', { ids: [a], fromFrame: 0, toFrame: 30, rotate: [0, 90, 0], pivot: [1, 0, 0] });
    await run('anim.set_key', { ids: [b], frame: 12, visible: false });
    await run('anim.set_key', { ids: [b], frame: 5, scale: [2, 2, 2], interpolation: 'step' });
    await run('anim.camera_orbit', { target: [0, 0, 0], radius: 6, height: 2, fromFrame: 0, toFrame: 60, turns: 0.25 });
    return { a, b };
  }

  const reparse = (edit: (project: Record<string, unknown> & { animation: Record<string, unknown> }) => void) => {
    const project = JSON.parse(serializeProject(doc()));
    edit(project);
    return parseProject(JSON.stringify(project)).state;
  };

  it('round-trips the animation', async () => {
    await animatedDoc();
    const parsed = parseProject(serializeProject(doc()));
    expect(parsed.state.animation).toEqual(anim());
    expect(parsed.state.objects).toEqual(state().objects);
    expect(invariantErrors(parsed.state)).toEqual([]);
    // The loaded document plays the same.
    for (const f of [0, 7.5, 30, 100]) {
      expect(animatedState(parsed.state, f).objects).toEqual(animatedState(state(), f).objects);
      expect(cameraAt(parsed.state.animation, f)).toEqual(cameraAt(anim(), f));
    }
  });

  it('files without animation load without one, and documents without animation save none', async () => {
    await cube();
    const json = serializeProject(doc());
    expect(JSON.parse(json).animation).toBeUndefined();
    expect(parseProject(json).state.animation).toBeUndefined();
    expect('animation' in parseProject(json).state).toBe(false);
  });

  it('fills in defaults of a sparse animation', async () => {
    const { a } = await animatedDoc();
    const loaded = reparse((project) => {
      project.animation = { tracks: { [a]: { position: [{ frame: 3, value: [1, 2, 3] }] } }, camera: [{ frame: 0, position: [0, 0, 5], target: [0, 0, 0] }] };
    });
    expect(loaded.animation).toEqual({
      fps: 24,
      frameCount: 120,
      tracks: { [a]: { position: [{ frame: 3, value: [1, 2, 3], interpolation: 'smooth' }] } },
      camera: [{ frame: 0, position: [0, 0, 5], target: [0, 0, 0], fov: 40, interpolation: 'smooth' }],
    });
    expect(reparse((project) => (project.animation = {} as never)).animation).toEqual({ fps: 24, frameCount: 120, tracks: {}, camera: [] });
  });

  it('repairs unsorted and duplicate keys and drops tracks of missing objects and empty channels', async () => {
    const { a, b } = await animatedDoc();
    const key = (frame: number, x: number) => ({ frame, value: [x, 0, 0], interpolation: 'linear' });
    const loaded = reparse((project) => {
      project.animation.tracks = {
        [a]: { position: [key(20, 1), key(0, 2), key(10, 3), key(20, 4), key(0, 5)], rotation: [], visible: [{ frame: 9, value: true, interpolation: 'step' }] },
        [b]: { scale: [] },
        ghost: { position: [key(0, 0)] },
        toString: { position: [key(0, 0)] },
        ['__proto__']: { position: [key(0, 0)] },
      };
      const camera = (project.animation.camera as { frame: number }[]).slice(0, 3);
      project.animation.camera = [camera[2], camera[0], camera[1], { ...camera[0], fov: 77 }];
    });
    expect(invariantErrors(loaded)).toEqual([]);
    expect(Object.keys(loaded.animation!.tracks)).toEqual([a]);
    // Sorted; of several keys on one frame the last one in the file wins.
    expect(loaded.animation!.tracks[a]).toEqual({ position: [key(0, 5), key(10, 3), key(20, 4)], visible: [{ frame: 9, value: true, interpolation: 'step' }] });
    expect(frames(loaded.animation!.camera)).toEqual(frames(anim().camera.slice(0, 3)));
    expect(loaded.animation!.camera[0].fov).toBe(77);
    expect(Object.getPrototypeOf(loaded.animation!.tracks)).toBe(Object.prototype);
  });

  it('rejects animations that are not valid', async () => {
    const { a } = await animatedDoc();
    const invalid = 'Not a valid Tessel file';
    const key = (patch: Record<string, unknown>) => ({ frame: 0, value: [0, 0, 0], interpolation: 'linear', ...patch });
    const bad: ((animation: Record<string, unknown>) => void)[] = [
      (an) => (an.fps = 0),
      (an) => (an.fps = 500),
      (an) => (an.fps = '24'),
      (an) => (an.frameCount = 0),
      (an) => (an.frameCount = 1.5),
      (an) => (an.frameCount = 1e9),
      (an) => (an.tracks = []),
      (an) => (an.tracks = { [a]: [] }),
      (an) => (an.tracks = { [a]: { position: [key({ frame: -1 })] } }),
      (an) => (an.tracks = { [a]: { position: [key({ frame: 0.5 })] } }),
      (an) => (an.tracks = { [a]: { position: [key({ frame: 2_000_000 })] } }),
      (an) => (an.tracks = { [a]: { position: [key({ value: [0, 0] })] } }),
      (an) => (an.tracks = { [a]: { position: [key({ value: [0, 0, null] })] } }),
      (an) => (an.tracks = { [a]: { position: [key({ value: [0, 0, '1'] })] } }),
      (an) => (an.tracks = { [a]: { rotation: [key({ interpolation: 'bezier' })] } }),
      (an) => (an.tracks = { [a]: { scale: [key({ value: [1, 0, 1] })] } }),
      (an) => (an.tracks = { [a]: { visible: [key({ value: 1 })] } }),
      (an) => (an.camera = {}),
      (an) => (an.camera = [{ frame: 0, position: [0, 0, 5], target: [0, 0], fov: 40 }]),
      (an) => (an.camera = [{ frame: 0, position: [0, 0, 5], target: [0, 0, 0], fov: 0 }]),
      (an) => (an.camera = [{ frame: 0, position: [0, 0, 5], target: [0, 0, 0], fov: 1e9 }]),
    ];
    for (const [i, edit] of bad.entries()) expect(() => reparse((project) => edit(project.animation)), `case ${i}`).toThrow(invalid);
    expect(() => reparse((project) => (project.animation = [] as never))).toThrow(invalid);
    expect(() => reparse((project) => (project.animation = 'yes' as never))).toThrow(invalid);
    // The file itself is still fine without those edits.
    expect(reparse(() => {}).animation).toEqual(anim());
  });

  it('rejects files with more keys than the limit', async () => {
    const { a, b } = await animatedDoc();
    const many = (n: number) => Array.from({ length: n }, (_, frame) => ({ frame, value: [0, 0, 0], interpolation: 'linear' }));
    expect(() =>
      reparse((project) => {
        project.animation.tracks = { [a]: { position: many(MAX_KEYS / 2), rotation: many(MAX_KEYS / 2) }, [b]: { position: many(1) } };
        project.animation.camera = [];
      }),
    ).toThrow(`Not a valid Tessel file: the animation has ${MAX_KEYS + 1} keys, more than the ${MAX_KEYS} that are allowed`);
    const full = reparse((project) => {
      project.animation.tracks = { [a]: { position: many(MAX_KEYS / 2), rotation: many(MAX_KEYS / 2) } };
      project.animation.camera = [];
    });
    expect(full.animation!.tracks[a].position).toHaveLength(MAX_KEYS / 2);
  });
});
