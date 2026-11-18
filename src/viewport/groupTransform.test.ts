import { Euler, MathUtils, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { Transform, Vec3 } from '../core/types';
import { rotateAbout, scaleAbout } from './groupTransform';

const at = (position: Vec3, rotation: Vec3 = [0, 0, 0], scale: Vec3 = [1, 1, 1]): Transform => ({ position, rotation, scale });
const aboutAxis = (axis: Vec3, degrees: number) => new Quaternion().setFromAxisAngle(new Vector3(...axis), MathUtils.degToRad(degrees));
const close = (actual: Vec3, expected: Vec3) => actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 5));

describe('rotateAbout', () => {
  it('turns three cubes on the X axis onto the Z axis for 90° about Y', () => {
    const pivot = new Vector3(0, 0, 0);
    const q = aboutAxis([0, 1, 0], 90);
    const results = ([-2, 0, 2] as const).map((x) => rotateAbout(at([x, 0, 0]), pivot, q));
    expect(results.map((r) => r.position)).toEqual([
      [0, 0, 2],
      [0, 0, 0],
      [0, 0, -2],
    ]);
    for (const r of results) {
      expect(r.rotation).toEqual([0, 90, 0]);
      expect(r.scale).toEqual([1, 1, 1]);
    }
  });

  it('rotates about a pivot away from the origin', () => {
    const r = rotateAbout(at([3, 1, 0]), new Vector3(1, 1, 0), aboutAxis([0, 0, 1], 90));
    expect(r.position).toEqual([1, 3, 0]);
    expect(r.rotation).toEqual([0, 0, 90]);
  });

  it("composes with the object's own rotation: the world rotation is applied after it", () => {
    const r = rotateAbout(at([0, 0, 0], [0, 0, 30]), new Vector3(), aboutAxis([0, 0, 1], 45));
    close(r.rotation, [0, 0, 75]);
    // X 90° then world Y 90°: the object's local Y axis (world Z after the first turn) ends up on world X.
    const two = rotateAbout(at([0, 0, 0], [90, 0, 0]), new Vector3(), aboutAxis([0, 1, 0], 90));
    const [x, y, z] = two.rotation.map((a) => MathUtils.degToRad(a));
    const q = new Quaternion().setFromEuler(new Euler(x, y, z, 'XYZ'));
    close(new Vector3(0, 1, 0).applyQuaternion(q).toArray() as Vec3, [1, 0, 0]);
  });
});

describe('scaleAbout', () => {
  it('doubles distances and scales for a uniform factor 2', () => {
    const pivot = new Vector3(0, 0, 0);
    const results = ([-2, 0, 2] as const).map((x) => scaleAbout(at([x, 0, 0], [0, 30, 0], [1, 2, 3]), pivot, new Vector3(2, 2, 2)));
    expect(results.map((r) => r.position)).toEqual([
      [-4, 0, 0],
      [0, 0, 0],
      [4, 0, 0],
    ]);
    for (const r of results) {
      expect(r.scale).toEqual([2, 4, 6]);
      expect(r.rotation).toEqual([0, 30, 0]);
    }
  });

  it('scales along the world axes: exact for axis-aligned objects, also when turned by 90°', () => {
    const s = new Vector3(3, 1, 1);
    expect(scaleAbout(at([1, 1, 1]), new Vector3(0, 1, 1), s)).toEqual(at([3, 1, 1], [0, 0, 0], [3, 1, 1]));
    // Turned 90° about Y the object's local Z axis lies along world X.
    expect(scaleAbout(at([1, 0, 0], [0, 90, 0]), new Vector3(), s).scale).toEqual([1, 1, 3]);
  });

  it('approximates a non-uniform scale of a rotated object per local axis', () => {
    const r = scaleAbout(at([0, 0, 0], [0, 45, 0]), new Vector3(), new Vector3(2, 1, 1));
    // Local X and Z both sit at 45° to world X: |(2·cos45, 0, sin45)| = sqrt(2.5).
    close(r.scale, [Math.sqrt(2.5), 1, Math.sqrt(2.5)]);
    expect(r.rotation).toEqual([0, 45, 0]);
  });

  it('mirrors with a negative factor', () => {
    const r = scaleAbout(at([1, 0, 0]), new Vector3(), new Vector3(-1, 1, 1));
    expect(r.position).toEqual([-1, 0, 0]);
    expect(r.scale).toEqual([-1, 1, 1]);
  });
});
