import { beforeEach, describe, expect, it } from 'vitest';
import { animatedState } from '../animation';
import { activeDoc, createAppState } from '../state';
import type { AppState, DocState, ObjectTrack, Vec3 } from '../types';
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
  return runCommand(byId.get(id)!, ctx, params);
}

const doc = () => activeDoc(app);
const state = (): DocState => doc().state;
const track = (id: string): ObjectTrack | undefined => state().animation?.tracks[id];
const frames = (keys: readonly { frame: number }[] | undefined) => (keys ?? []).map((k) => k.frame);
const at = (id: string, frame: number) => animatedState(state(), frame).objects[id].transform;

async function cube(position: Vec3 = [0, 0, 0], name?: string): Promise<string> {
  return (await run('scene.add_primitive', { type: 'cube', position, ...(name ? { name } : {}) })).id;
}

beforeEach(() => {
  app = createAppState();
});

describe('anim.set_pose', () => {
  it('keys each object with its own values in one undo step', async () => {
    const a = await cube([0, 0, 0]);
    const b = await cube([5, 0, 0]);
    const steps = doc().past.length;
    const result = await run('anim.set_pose', {
      frame: 12,
      items: [
        { id: a, position: [1, 2, 3] },
        { id: b, position: [7, 0, 0], rotation: [0, 90, 0] },
      ],
    });
    expect(doc().past.length).toBe(steps + 1);
    expect(result.keyed).toEqual([
      { id: a, channels: ['position'] },
      { id: b, channels: ['position', 'rotation'] },
    ]);
    expect(result.moved).toEqual([]);
    expect(result.time).toBe(0.5);
    expect(track(a)!.position).toEqual([{ frame: 12, value: [1, 2, 3], interpolation: 'smooth' }]);
    expect(track(b)!.rotation![0].value).toEqual([0, 90, 0]);
    // The static transform is untouched.
    expect(state().objects[a].transform.position).toEqual([0, 0, 0]);
    await run('history.undo');
    expect(state().animation).toBeUndefined();
  });

  it('auto-key keys animated channels and moves the rest statically', async () => {
    const a = await cube([0, 0, 0]);
    await run('anim.add_motion', { ids: [a], fromFrame: 0, toFrame: 20, translate: [10, 0, 0], interpolation: 'linear' });
    const steps = doc().past.length;
    // What a gizmo drag at frame 10 reports: the object was displayed at x = 5 and is now somewhere else, and turned.
    const result = await run('anim.set_pose', { frame: 10, items: [{ id: a, position: [5, 3, 0], rotation: [0, 45, 0] }], autoKey: true });
    expect(doc().past.length).toBe(steps + 1);
    expect(result.keyed).toEqual([{ id: a, channels: ['position'] }]);
    expect(result.moved).toEqual([{ id: a, channels: ['rotation'] }]);
    expect(frames(track(a)!.position)).toEqual([0, 10, 20]);
    expect(track(a)!.rotation).toBeUndefined();
    expect(state().objects[a].transform.rotation).toEqual([0, 45, 0]);
    expect(state().objects[a].transform.position).toEqual([0, 0, 0]);
    // The displayed pose at the playhead is exactly what was dragged to.
    expect(at(a, 10).position).toEqual([5, 3, 0]);
    expect(at(a, 10).rotation).toEqual([0, 45, 0]);
    // The new key inherits the interpolation of the move it was dropped into.
    expect(track(a)!.position![1].interpolation).toBe('linear');
    await run('history.undo');
    expect(frames(track(a)!.position)).toEqual([0, 20]);
    expect(state().objects[a].transform.rotation).toEqual([0, 0, 0]);
  });

  it('auto-key on an object without keys is a plain move', async () => {
    const a = await cube([0, 0, 0]);
    const b = await cube([2, 0, 0]);
    await run('anim.set_key', { ids: [b], frame: 0, position: true });
    await run('anim.set_pose', { frame: 30, items: [{ id: a, position: [4, 0, 0] }], autoKey: true });
    expect(track(a)).toBeUndefined();
    expect(state().objects[a].transform.position).toEqual([4, 0, 0]);
  });

  it('without channels keys the pose as displayed at that frame', async () => {
    const a = await cube([0, 0, 0]);
    await run('anim.add_motion', { ids: [a], fromFrame: 0, toFrame: 20, translate: [10, 0, 0], interpolation: 'linear' });
    await run('anim.set_pose', { frame: 5, items: [{ id: a }] });
    expect(frames(track(a)!.position)).toEqual([0, 5, 20]);
    expect(track(a)!.position![1].value).toEqual([2.5, 0, 0]);
    expect(frames(track(a)!.rotation)).toEqual([5]);
    expect(frames(track(a)!.scale)).toEqual([5]);
    // With auto-key only the animated channels are touched.
    const b = await cube([0, 0, 5]);
    await run('anim.set_key', { ids: [b], frame: 0, position: true });
    const result = await run('anim.set_pose', { frame: 9, items: [{ id: b }], autoKey: true });
    expect(result.keyed).toEqual([{ id: b, channels: ['position'] }]);
    expect(result.moved).toEqual([]);
    expect(track(b)!.rotation).toBeUndefined();
  });

  it('takes the interpolation that is asked for, replaces a key on the frame and accepts names', async () => {
    const a = await cube([0, 0, 0], 'Crate');
    await run('anim.set_pose', { frame: 4, items: [{ id: 'Crate', position: [1, 0, 0] }], interpolation: 'step' });
    await run('anim.set_pose', { frame: 4, items: [{ id: 'Crate', position: [2, 0, 0] }] });
    expect(track(a)!.position).toEqual([{ frame: 4, value: [2, 0, 0], interpolation: 'step' }]);
  });

  it('rejects bad input without changing anything', async () => {
    const a = await cube();
    const before = state();
    await expect(run('anim.set_pose', { frame: 1, items: [{ id: a, scale: [1, 0, 1] }] })).rejects.toThrow(/must not be 0/);
    await expect(run('anim.set_pose', { frame: 1, items: [{ id: 'nope', position: [0, 0, 0] }] })).rejects.toThrow();
    await expect(run('anim.set_pose', { frame: 1, items: [{ id: 'toString', position: [0, 0, 0] }] })).rejects.toThrow();
    await expect(run('anim.set_pose', { frame: 1.5, items: [{ id: a }] })).rejects.toThrow();
    await expect(run('anim.set_pose', { frame: 1, items: [] })).rejects.toThrow();
    expect(state()).toBe(before);
  });

  it('warns about a key beyond the end of the animation', async () => {
    const a = await cube();
    const result = await run('anim.set_pose', { frame: 500, items: [{ id: a, position: [1, 0, 0] }] });
    expect(result.warnings[0]).toMatch(/beyond the end/);
  });
});

describe('anim.move_key', () => {
  it('moves the keys on one frame and leaves the others, as one undo step', async () => {
    const a = await cube();
    for (const frame of [0, 10, 20]) await run('anim.set_key', { ids: [a], frame, position: [frame, 0, 0], rotation: [0, frame, 0], interpolation: 'linear' });
    const steps = doc().past.length;
    const result = await run('anim.move_key', { ids: [a], frame: 10, toFrame: 30 });
    expect(doc().past.length).toBe(steps + 1);
    expect(result).toMatchObject({ moved: 2, replaced: 0, ids: [a], cameraKeyMoved: false });
    // Unlike anim.shift_keys the key passes the one on frame 20.
    expect(frames(track(a)!.position)).toEqual([0, 20, 30]);
    expect(track(a)!.position![2]).toEqual({ frame: 30, value: [10, 0, 0], interpolation: 'linear' });
    expect(frames(track(a)!.rotation)).toEqual([0, 20, 30]);
    await run('history.undo');
    expect(frames(track(a)!.position)).toEqual([0, 10, 20]);
  });

  it('replaces a key on the target frame and can be limited to channels', async () => {
    const a = await cube();
    for (const frame of [0, 10]) await run('anim.set_key', { ids: [a], frame, position: [frame, 0, 0], scale: [1, 1, 1] });
    const result = await run('anim.move_key', { ids: [a], frame: 0, toFrame: 10, channels: ['position'] });
    expect(result).toMatchObject({ moved: 1, replaced: 1 });
    expect(track(a)!.position).toHaveLength(1);
    expect(track(a)!.position![0]).toMatchObject({ frame: 10, value: [0, 0, 0] });
    expect(frames(track(a)!.scale)).toEqual([0, 10]);
  });

  it('moves a camera key, alone or with objects, and defaults to the selection', async () => {
    const a = await cube();
    await run('anim.set_key', { ids: [a], frame: 5, position: true });
    await run('anim.set_camera_key', { frame: 5, position: [0, 2, 8], target: [0, 0, 0] });
    await run('anim.set_camera_key', { frame: 50, position: [8, 2, 0], target: [0, 0, 0] });
    const camera = await run('anim.move_key', { camera: true, frame: 5, toFrame: 7 });
    expect(camera).toMatchObject({ moved: 1, cameraKeyMoved: true, ids: [] });
    expect(frames(state().animation!.camera)).toEqual([7, 50]);
    expect(frames(track(a)!.position)).toEqual([5]);
    await run('scene.select', { ids: [a] });
    await run('anim.move_key', { frame: 5, toFrame: 6 });
    expect(frames(track(a)!.position)).toEqual([6]);
  });

  it('fails clearly when there is nothing to move', async () => {
    const a = await cube();
    await run('anim.set_key', { ids: [a], frame: 5, position: true });
    await expect(run('anim.move_key', { ids: [a], frame: 6, toFrame: 9 })).rejects.toThrow(/No key on frame 6/);
    await expect(run('anim.move_key', { ids: [a], frame: 5, toFrame: 5 })).rejects.toThrow(/nothing to move/);
    await expect(run('anim.move_key', { camera: true, frame: 5, toFrame: 9 })).rejects.toThrow(/No key/);
    await run('scene.select', { ids: [] });
    await expect(run('anim.move_key', { frame: 5, toFrame: 9 })).rejects.toThrow(/nothing is selected/);
    await expect(run('anim.move_key', { ids: [a], frame: 5, toFrame: -1 })).rejects.toThrow();
  });
});
