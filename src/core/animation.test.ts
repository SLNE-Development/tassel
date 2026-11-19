import { describe, expect, it } from 'vitest';
import {
  animatedObjectIds,
  animatedState,
  animationSummary,
  cameraAt,
  countKeys,
  defaultAnimation,
  duplicateTracks,
  ease,
  evaluateTrack,
  pruneAnimation,
  replaceRange,
  withKey,
  withTrack,
} from './animation';
import { emptyDocState } from './state';
import { apply3, eulerMatrix } from './transformMath';
import type { Animation, DocState, Key, KeyInterpolation, ObjectTrack, SceneObject, Transform, Vec3 } from './types';

const mesh = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], faces: [[0, 1, 2]] };
const rest: Transform = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };

function object(id: string, transform: Transform = rest): SceneObject {
  return { id, name: id, visible: true, transform, mesh, modifiers: [], smooth: false, groupId: null, materialId: null };
}

function doc(objects: SceneObject[], tracks: Record<string, ObjectTrack>, extra: Partial<Animation> = {}): DocState {
  return {
    ...emptyDocState,
    objects: Object.fromEntries(objects.map((o) => [o.id, o])),
    order: objects.map((o) => o.id),
    animation: { ...defaultAnimation(), tracks, ...extra },
  };
}

const key = <T>(frame: number, value: T, interpolation: KeyInterpolation = 'linear'): Key<T> => ({ frame, value, interpolation });

/** Position of an object with only these position keys at a frame. */
function positionAt(keys: Key<Vec3>[], frame: number): Vec3 {
  return evaluateTrack({ position: keys }, rest, true, frame).transform.position;
}

function rotationAt(keys: Key<Vec3>[], frame: number): Vec3 {
  return evaluateTrack({ rotation: keys }, rest, true, frame).transform.rotation;
}

function expectVec(actual: readonly number[], expected: readonly number[], digits = 9) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i], digits));
}

/** Two Euler rotations describe the same orientation. */
function expectSameOrientation(a: Vec3, b: Vec3, digits = 5) {
  expectVec(eulerMatrix(a), eulerMatrix(b), digits);
}

describe('interpolation between keys', () => {
  it('linear: exact at keys, straight in between, held outside', () => {
    const keys = [key<Vec3>(10, [0, 0, 0]), key<Vec3>(20, [10, -4, 2])];
    expect(positionAt(keys, 10)).toEqual([0, 0, 0]);
    expect(positionAt(keys, 20)).toEqual([10, -4, 2]);
    expectVec(positionAt(keys, 15), [5, -2, 1]);
    expectVec(positionAt(keys, 12.5), [2.5, -1, 0.5]);
    // Before the first and after the last key the value holds.
    expect(positionAt(keys, 0)).toEqual([0, 0, 0]);
    expect(positionAt(keys, 9.99)).toEqual([0, 0, 0]);
    expect(positionAt(keys, 20.01)).toEqual([10, -4, 2]);
    expect(positionAt(keys, 5000)).toEqual([10, -4, 2]);
  });

  it('smooth: cubic ease in and out between two keys, no overshoot', () => {
    const keys = [key<Vec3>(0, [0, 0, 0], 'smooth'), key<Vec3>(8, [8, 0, 0], 'smooth')];
    expect(positionAt(keys, 0)).toEqual([0, 0, 0]);
    expect(positionAt(keys, 8)).toEqual([8, 0, 0]);
    expectVec(positionAt(keys, 4), [4, 0, 0]);
    // 3t² - 2t³ at t = 0.25 and 0.75
    expectVec(positionAt(keys, 2), [8 * 0.15625, 0, 0]);
    expectVec(positionAt(keys, 6), [8 * 0.84375, 0, 0]);
    let previous = -1;
    for (let f = 0; f <= 8; f += 0.125) {
      const x = positionAt(keys, f)[0];
      expect(x).toBeGreaterThanOrEqual(previous);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(8);
      previous = x;
    }
    expect(ease('smooth', 0)).toBe(0);
    expect(ease('smooth', 1)).toBe(1);
  });

  it('step: holds and jumps at the next key', () => {
    const keys = [key<Vec3>(0, [1, 1, 1], 'step'), key<Vec3>(10, [5, 5, 5], 'step'), key<Vec3>(20, [9, 9, 9])];
    expect(positionAt(keys, 0)).toEqual([1, 1, 1]);
    expect(positionAt(keys, 9.999)).toEqual([1, 1, 1]);
    expect(positionAt(keys, 10)).toEqual([5, 5, 5]);
    expect(positionAt(keys, 19)).toEqual([5, 5, 5]);
    expect(positionAt(keys, 20)).toEqual([9, 9, 9]);
  });

  it('the interpolation of the FIRST key of a pair decides', () => {
    const keys = [key<Vec3>(0, [0, 0, 0], 'linear'), key<Vec3>(10, [10, 0, 0], 'step'), key<Vec3>(20, [20, 0, 0], 'smooth')];
    expectVec(positionAt(keys, 2.5), [2.5, 0, 0]);
    expect(positionAt(keys, 15)).toEqual([10, 0, 0]);
  });

  it('a single key holds everywhere, and many keys are found by frame', () => {
    expect(positionAt([key<Vec3>(50, [3, 2, 1], 'smooth')], 0)).toEqual([3, 2, 1]);
    expect(positionAt([key<Vec3>(50, [3, 2, 1], 'smooth')], 99)).toEqual([3, 2, 1]);
    const keys = Array.from({ length: 101 }, (_, i) => key<Vec3>(i * 3, [i, 0, 0]));
    for (const f of [0, 1.5, 3, 149.25, 150, 298.5, 300, 400]) expectVec(positionAt(keys, f), [Math.min(f, 300) / 3, 0, 0]);
  });

  it('scale and visibility', () => {
    const track: ObjectTrack = {
      scale: [key<Vec3>(0, [1, 1, 1]), key<Vec3>(10, [3, 1, 2])],
      visible: [key(5, false), key(10, true), key(20, false)],
    };
    const at = (f: number) => evaluateTrack(track, rest, true, f);
    expectVec(at(5).transform.scale, [2, 1, 1.5]);
    // Channels without keys keep the static arrays themselves.
    expect(at(5).transform.position).toBe(rest.position);
    expect(at(5).transform.rotation).toBe(rest.rotation);
    // Visibility switches at its keys; before the first key the first value holds.
    expect([0, 4.9, 5, 9.9, 10, 19.9, 20, 99].map((f) => at(f).visible)).toEqual([false, false, false, false, true, true, false, false]);
    // Without visibility keys the static flag is used.
    expect(evaluateTrack({}, rest, false, 3).visible).toBe(false);
  });
});

describe('rotation', () => {
  it('is exact at the keys and turns about one axis in between', () => {
    const keys = [key<Vec3>(0, [0, 0, 0]), key<Vec3>(10, [0, 90, 0])];
    expect(rotationAt(keys, 0)).toEqual([0, 0, 0]);
    expect(rotationAt(keys, 10)).toEqual([0, 90, 0]);
    expectVec(rotationAt(keys, 5), [0, 45, 0], 5);
    expectVec(rotationAt(keys, 2), [0, 18, 0], 5);
    expect(rotationAt(keys, 30)).toEqual([0, 90, 0]);
  });

  it('smooth eases the angle', () => {
    const keys = [key<Vec3>(0, [0, 0, 0], 'smooth'), key<Vec3>(8, [0, 0, 80], 'smooth')];
    expectVec(rotationAt(keys, 2), [0, 0, 80 * 0.15625], 5);
    expectVec(rotationAt(keys, 4), [0, 0, 40], 5);
  });

  it('takes the short way between two keys', () => {
    // 0 -> 270 about Y is 90 degrees backwards.
    const back = [key<Vec3>(0, [0, 0, 0]), key<Vec3>(10, [0, 270, 0])];
    expectSameOrientation(rotationAt(back, 5), [0, -45, 0]);
    expectSameOrientation(rotationAt(back, 10), [0, -90, 0]);
    // 0 -> 360 does not move at all.
    const full = [key<Vec3>(0, [0, 0, 0]), key<Vec3>(10, [0, 360, 0])];
    for (const f of [2.5, 5, 7.5]) expectSameOrientation(rotationAt(full, f), [0, 0, 0]);
    // 350 -> 10 passes through 0, not through 180.
    const wrap = [key<Vec3>(0, [350, 0, 0]), key<Vec3>(10, [10, 0, 0])];
    expectSameOrientation(rotationAt(wrap, 5), [0, 0, 0]);
    expectSameOrientation(rotationAt(wrap, 2.5), [355, 0, 0]);
  });

  it('intermediate keys make a long turn go all the way round', () => {
    const keys = [key<Vec3>(0, [0, 0, 0]), key<Vec3>(10, [0, 120, 0]), key<Vec3>(20, [0, 240, 0]), key<Vec3>(30, [0, 360, 0])];
    expectSameOrientation(rotationAt(keys, 5), [0, 60, 0]);
    expectSameOrientation(rotationAt(keys, 15), [0, 180, 0]);
    expectSameOrientation(rotationAt(keys, 25), [0, 300, 0]);
  });

  it('interpolates combined rotations along the single axis between them', () => {
    const a: Vec3 = [30, 40, 50];
    const b: Vec3 = [-20, 75, 110];
    const keys = [key(0, a), key(10, b)];
    // Equal steps: the turn from 0 to 5 equals the turn from 5 to 10 (R5 * R0^-1 = R10 * R5^-1).
    const m0 = eulerMatrix(a);
    const m5 = eulerMatrix(rotationAt(keys, 5));
    const m10 = eulerMatrix(b);
    const transpose = (m: readonly number[]) => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
    const mul = (x: readonly number[], y: readonly number[]) => [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => x[r * 3] * y[c] + x[r * 3 + 1] * y[3 + c] + x[r * 3 + 2] * y[6 + c]));
    expectVec(mul(m5, transpose(m0)), mul(m10, transpose(m5)), 5);
    // And a vector is carried continuously (no jump near the keys).
    const v: Vec3 = [1, 2, 3];
    expectVec(apply3(eulerMatrix(rotationAt(keys, 0.001)), v), apply3(m0, v), 3);
    expectVec(apply3(eulerMatrix(rotationAt(keys, 9.999)), v), apply3(m10, v), 3);
  });
});

describe('animatedState', () => {
  const a = object('a', { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] });
  const b = object('b');
  const c = object('c');

  it('returns the state itself when nothing is animated', () => {
    const plain: DocState = { ...emptyDocState, objects: { a }, order: ['a'] };
    expect(animatedState(plain, 5)).toBe(plain);
    const empty = doc([a, b], {});
    expect(animatedState(empty, 5)).toBe(empty);
    // A track for an object that does not exist (any more) is ignored.
    const stale = doc([a], { gone: { position: [key<Vec3>(0, [9, 9, 9])] }, toString: { position: [key<Vec3>(0, [9, 9, 9])] } });
    expect(animatedState(stale, 5)).toBe(stale);
  });

  it('changes only animated objects; everything else keeps its identity', () => {
    const state = doc([a, b, c], { b: { position: [key<Vec3>(0, [0, 0, 0]), key<Vec3>(10, [10, 0, 0])] } });
    const at = animatedState(state, 5);
    expect(at).not.toBe(state);
    expect(at.objects.a).toBe(a);
    expect(at.objects.c).toBe(c);
    expect(at.objects.b).not.toBe(b);
    expectVec(at.objects.b.transform.position, [5, 0, 0]);
    expect(at.objects.b.transform.rotation).toBe(b.transform.rotation);
    expect(at.objects.b.mesh).toBe(b.mesh);
    // The rest of the document is passed through.
    expect(at.order).toBe(state.order);
    expect(at.animation).toBe(state.animation);
    // The static state is untouched.
    expect(state.objects.b).toBe(b);
    expect(b.transform.position).toEqual([0, 0, 0]);
  });

  it('gives the static object where the animated values equal the static ones', () => {
    const state = doc([a, b], { b: { position: [key<Vec3>(10, [0, 0, 0]), key<Vec3>(20, [10, 0, 0])] } });
    // Before the motion starts b rests at its static position: nothing differs, so the state itself comes back.
    expect(animatedState(state, 0)).toBe(state);
    expect(animatedState(state, 10)).toBe(state);
    expect(animatedState(state, 15)).not.toBe(state);
  });

  it('returns the same result for the same frame, and the same object while it rests', () => {
    const state = doc([a, b], { b: { position: [key<Vec3>(0, [0, 0, 0]), key<Vec3>(10, [10, 0, 0])], visible: [key(0, true), key(30, false)] } });
    expect(animatedState(state, 5)).toBe(animatedState(state, 5));
    const moving1 = animatedState(state, 5).objects.b;
    const moving2 = animatedState(state, 6).objects.b;
    expect(moving2).not.toBe(moving1);
    // After the last position key b rests: frame after frame gives the same object.
    const rest1 = animatedState(state, 12).objects.b;
    const rest2 = animatedState(state, 20).objects.b;
    expect(rest2).toBe(rest1);
    // ... until something changes again (it is hidden from frame 30).
    const hidden = animatedState(state, 30).objects.b;
    expect(hidden).not.toBe(rest1);
    expect(hidden.visible).toBe(false);
    expect(hidden.transform.position).toEqual([10, 0, 0]);
  });

  it('evaluates 10,000 objects with 3 tracks of 20 keys each fast enough for playback', () => {
    const count = 10_000;
    const objects: Record<string, SceneObject> = {};
    const tracks: Record<string, ObjectTrack> = {};
    const order: string[] = [];
    for (let i = 0; i < count; i++) {
      const id = `o${i}`;
      objects[id] = object(id);
      order.push(id);
      tracks[id] = {
        position: Array.from({ length: 20 }, (_, k) => key<Vec3>(k * 10, [i, k, k * 2], 'smooth')),
        rotation: Array.from({ length: 20 }, (_, k) => key<Vec3>(k * 10, [k * 7, k * 13, i % 90], 'linear')),
        scale: Array.from({ length: 20 }, (_, k) => key<Vec3>(k * 10, [1 + k, 1, 1], 'linear')),
      };
    }
    const state: DocState = { ...emptyDocState, objects, order, animation: { ...defaultAnimation(), tracks } };
    animatedState(state, 1.5); // warm-up (JIT, quaternions of the keys)
    let best = Infinity;
    for (let run = 0; run < 5; run++) {
      const frame = 33.3 + run * 17;
      const start = performance.now();
      const at = animatedState(state, frame);
      best = Math.min(best, performance.now() - start);
      expect(at.objects.o7.transform.position[0]).toBe(7);
    }
    // Measured: about 17-20 ms when all 10,000 objects move in all three channels at once (the worst case; ~3 ms of it
    // is copying the record of 10,000 objects, the rest mostly slerp + Euler conversion). The bound is generous for slow machines.
    if (process.env.ANIM_PERF) console.log(`animatedState, 10,000 objects: best ${best.toFixed(2)} ms`);
    expect(best).toBeLessThan(150);
    const at = animatedState(state, 45);
    expectVec(at.objects.o123.transform.position, [123, 4.5, 9]);
    expectVec(at.objects.o123.transform.scale, [5.5, 1, 1]);
  });
});

describe('cameraAt', () => {
  it('is null without camera keys', () => {
    expect(cameraAt(undefined, 0)).toBeNull();
    expect(cameraAt(defaultAnimation(), 0)).toBeNull();
  });

  it('interpolates position, target and fov and holds outside the keys', () => {
    const animation: Animation = {
      ...defaultAnimation(),
      camera: [
        { frame: 10, position: [0, 0, 10], target: [0, 0, 0], fov: 40, interpolation: 'linear' },
        { frame: 20, position: [10, 4, 10], target: [2, 0, 0], fov: 60, interpolation: 'smooth' },
        { frame: 28, position: [10, 4, 2], target: [2, 0, 0], fov: 60, interpolation: 'step' },
        { frame: 40, position: [0, 0, 0.5], target: [1, 1, 1], fov: 20, interpolation: 'linear' },
      ],
    };
    expect(cameraAt(animation, 0)).toEqual({ position: [0, 0, 10], target: [0, 0, 0], fov: 40 });
    expect(cameraAt(animation, 10)).toEqual({ position: [0, 0, 10], target: [0, 0, 0], fov: 40 });
    const mid = cameraAt(animation, 15)!;
    expectVec(mid.position, [5, 2, 10]);
    expectVec(mid.target, [1, 0, 0]);
    expect(mid.fov).toBeCloseTo(50, 9);
    expectVec(cameraAt(animation, 22)!.position, [10, 4, 10 - 8 * 0.15625]);
    expect(cameraAt(animation, 39.9)).toEqual({ position: [10, 4, 2], target: [2, 0, 0], fov: 60 });
    expect(cameraAt(animation, 40)).toEqual({ position: [0, 0, 0.5], target: [1, 1, 1], fov: 20 });
    expect(cameraAt(animation, 4000)).toEqual({ position: [0, 0, 0.5], target: [1, 1, 1], fov: 20 });
  });
});

describe('editing helpers', () => {
  it('withKey keeps keys sorted and replaces a key on the same frame', () => {
    let keys = withKey<Key<number>>(undefined, key(10, 1));
    keys = withKey(keys, key(5, 2));
    keys = withKey(keys, key(20, 3));
    keys = withKey(keys, key(12, 4));
    expect(keys.map((k) => k.frame)).toEqual([5, 10, 12, 20]);
    const replaced = withKey(keys, key(10, 9));
    expect(replaced.map((k) => [k.frame, k.value])).toEqual([
      [5, 2],
      [10, 9],
      [12, 4],
      [20, 3],
    ]);
    expect(keys[1].value).toBe(1);
  });

  it('replaceRange swaps the keys of a frame range', () => {
    const keys = [0, 5, 10, 15, 20].map((f) => key(f, f));
    expect(replaceRange(keys, 5, 15, [key(5, -1), key(9, -2), key(15, -3)]).map((k) => [k.frame, k.value])).toEqual([
      [0, 0],
      [5, -1],
      [9, -2],
      [15, -3],
      [20, 20],
    ]);
    expect(replaceRange(undefined, 0, 9, [key(1, 1)])).toEqual([key(1, 1)]);
  });

  it('withTrack drops empty channels and empty tracks', () => {
    let animation = withTrack(defaultAnimation(), 'a', { position: [key<Vec3>(0, [0, 0, 0])], rotation: [] });
    expect(animation.tracks).toEqual({ a: { position: [key<Vec3>(0, [0, 0, 0])] } });
    animation = withTrack(animation, 'a', { position: [] });
    expect(animation.tracks).toEqual({});
  });

  it('summary, key count and animated ids', () => {
    const plain: DocState = { ...emptyDocState };
    expect(animationSummary(plain)).toBeNull();
    expect(animatedObjectIds(plain)).toEqual([]);
    const state = doc(
      [object('a'), object('b'), object('c')],
      { c: { position: [key<Vec3>(4, [0, 0, 0]), key<Vec3>(90, [1, 0, 0])] }, a: { visible: [key(2, true)] } },
      { fps: 30, frameCount: 60, camera: [{ frame: 200, position: [0, 0, 1], target: [0, 0, 0], fov: 40, interpolation: 'linear' }] },
    );
    expect(animatedObjectIds(state)).toEqual(['a', 'c']);
    expect(countKeys(state.animation!)).toBe(4);
    expect(animationSummary(state)).toEqual({ fps: 30, frameCount: 60, duration: 2, animatedObjects: 2, cameraKeys: 1, keyCount: 4, firstKeyFrame: 2, lastKeyFrame: 200 });
    expect(animationSummary(doc([], {}))).toMatchObject({ fps: 24, frameCount: 120, duration: 5, keyCount: 0, firstKeyFrame: null, lastKeyFrame: null });
  });

  it('pruneAnimation drops tracks of missing objects and keeps identity otherwise', () => {
    const state = doc([object('a')], { a: { visible: [key(0, true)] }, gone: { visible: [key(0, true)] } });
    const pruned = pruneAnimation(state);
    expect(Object.keys(pruned.animation!.tracks)).toEqual(['a']);
    expect(pruneAnimation(pruned)).toBe(pruned);
    const plain: DocState = { ...emptyDocState };
    expect(pruneAnimation(plain)).toBe(plain);
  });

  it('duplicateTracks copies tracks and moves position keys by the offset', () => {
    const animation: Animation = { ...defaultAnimation(), tracks: { a: { position: [key<Vec3>(0, [1, 2, 3])], rotation: [key<Vec3>(0, [0, 90, 0])] } } };
    const next = duplicateTracks(animation, [['a', 'a2'], ['b', 'b2']], [10, 0, -1])!;
    expect(Object.keys(next.tracks).sort()).toEqual(['a', 'a2']);
    expect(next.tracks.a).toBe(animation.tracks.a);
    expect(next.tracks.a2.position).toEqual([key<Vec3>(0, [11, 2, 2])]);
    expect(next.tracks.a2.rotation).toBe(animation.tracks.a.rotation);
    expect(duplicateTracks(animation, [['b', 'b2']])).toBe(animation);
    expect(duplicateTracks(undefined, [['a', 'a2']])).toBeUndefined();
  });
});
