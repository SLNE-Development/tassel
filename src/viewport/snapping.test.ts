import { describe, expect, it } from 'vitest';
import { snapSteps } from './snapping';

describe('Minecraft gizmo snapping', () => {
  it('snaps to a pixel and 22.5 degrees by default, finer with Shift and Ctrl', () => {
    expect(snapSteps(false, false)).toEqual({ translation: 1 / 16, rotation: 22.5 });
    expect(snapSteps(true, false)).toEqual({ translation: 1 / 64, rotation: 5.625 });
    expect(snapSteps(false, true).translation).toBeCloseTo(1 / 160);
    expect(snapSteps(false, true).rotation).toBeCloseTo(2.25);
    expect(snapSteps(true, true)).toEqual(snapSteps(false, true));
  });
});
