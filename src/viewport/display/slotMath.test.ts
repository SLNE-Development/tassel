import { Matrix4, Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { builtInPresets, IDENTITY, type DisplayTransform } from '../../core/minecraft/display';
import { MODEL_OFFSET, displayMatrix, firstPersonAnchor, frameAnchor, groundLift, headAnchor, mul, shelfLift, thirdPersonHand } from './slotMath';

const MIRROR = new Matrix4().makeScale(-1, 1, 1);
const at = (m: Matrix4, p = new Vector3()) => p.clone().applyMatrix4(m);
const close = (a: Matrix4, b: Matrix4) => a.elements.forEach((v, i) => expect(v).toBeCloseTo(b.elements[i], 6));

describe('display slot math', () => {
  it('shows a left hand as the mirror image of the same values in the right hand', () => {
    const t: DisplayTransform = { rotation: [12, -70, 35], translation: [1.5, 3, -2], scale: [0.85, 0.6, 1.2] };
    close(displayMatrix(t, true), mul(MIRROR, displayMatrix(t, false), MIRROR));
    // The whole chain too: the left arm is the mirror image of the right one.
    for (const holder of ['player', 'zombie', 'armor_stand'] as const) {
      close(mul(thirdPersonHand(holder, true, 22.5), displayMatrix(t, true)), mul(MIRROR, thirdPersonHand(holder, false, 22.5), displayMatrix(t, false), MIRROR));
    }
    close(mul(firstPersonAnchor('normal', true), displayMatrix(t, true)), mul(MIRROR, firstPersonAnchor('normal', false), displayMatrix(t, false), MIRROR));
  });

  it('puts the right hand on the right (-X) side at hand height', () => {
    const hand = at(thirdPersonHand('player', false, 0));
    expect(hand.x).toBeLessThan(-0.25);
    expect(hand.y).toBeGreaterThan(0.6);
    expect(hand.y).toBeLessThan(1);
    expect(at(thirdPersonHand('armor_stand_small', false, 0)).y).toBeLessThan(0.5);
    expect(at(thirdPersonHand('baby_zombie', false, 0)).y).toBeLessThan(0.6);
    // Raising the arm brings the hand forward (+Z) and up.
    const raised = at(thirdPersonHand('player', false, 90));
    expect(raised.z).toBeGreaterThan(0.5);
    expect(raised.y).toBeGreaterThan(hand.y);
  });

  it('wears head items on top of the head and facing forward with the default item preset', () => {
    const head = mul(headAnchor('player', 0), displayMatrix(builtInPresets[0].slots.head!, false), MODEL_OFFSET);
    const centre = at(head, new Vector3(0, 0.5, 0));
    expect(centre.y).toBeGreaterThan(1.5);
    expect(centre.y).toBeLessThan(2.4);
    // The model's south face (+Z) looks the way the player looks.
    const south = at(head, new Vector3(0, 0.5, 0.5)).sub(centre);
    expect(south.z).toBeGreaterThan(0);
  });

  it('stands the armor stand ground preset on the ground at full size', () => {
    const head = mul(headAnchor('armor_stand', 0), displayMatrix(builtInPresets[4].slots.head!, false), MODEL_OFFSET);
    expect(at(head, new Vector3(0, 0, 0)).y).toBeCloseTo(0, 1);
    expect(at(head, new Vector3(0, 1, 0)).y).toBeCloseTo(1, 1);
  });

  it('draws first-person items low on the right of the view, in front of the camera', () => {
    const p = at(firstPersonAnchor('normal', false));
    expect(p.x).toBeGreaterThan(0);
    expect(p.y).toBeLessThan(0);
    expect(p.z).toBeLessThan(0);
  });

  it('puts framed items just in front of the wall, and lifts ground and shelf items by their bounds', () => {
    const framed = mul(frameAnchor('frame'), displayMatrix(IDENTITY, false), MODEL_OFFSET);
    expect(at(framed, new Vector3(0, 0.5, 0)).z).toBeCloseTo(-0.4375, 6);
    expect(at(mul(frameAnchor('top'), MODEL_OFFSET), new Vector3(0, 0.5, 0)).y).toBeCloseTo(0.0625, 6);
    expect(groundLift(-0.25, 0.1)).toBeCloseTo(0.4125, 6);
    expect(shelfLift(-0.1, 0.1, 'bottom')).toBeCloseTo(0.35, 6);
    expect(shelfLift(-0.1, 0.1, 'top')).toBeCloseTo(0.65, 6);
  });
});
