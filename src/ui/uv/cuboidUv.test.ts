import { describe, expect, it } from 'vitest';
import { boxToUv, dragBox, snap, snapStep, topEdge, uvToBox } from './cuboidUv';

describe('cuboid UV rectangle', () => {
  it('converts between the stored rectangle and a box, keeping mirroring', () => {
    expect(uvToBox([2, 3, 6, 9])).toEqual({ x: 2, y: 3, w: 4, h: 6 });
    expect(uvToBox([6, 9, 2, 3])).toEqual({ x: 2, y: 3, w: 4, h: 6 });
    expect(boxToUv({ x: 1, y: 1, w: 4, h: 2 }, [6, 3, 2, 9])).toEqual([5, 1, 1, 3]);
    expect(boxToUv({ x: 1, y: 1, w: 4, h: 2 }, [0, 3, 2, 0])).toEqual([1, 3, 5, 1]);
  });

  it('snaps to whole pixels, quarters with Shift and tenths with Ctrl', () => {
    expect(snapStep(false, false)).toBe(1);
    expect(snapStep(true, false)).toBe(0.25);
    expect(snapStep(false, true)).toBe(0.1);
    expect(snap(2.6, 1)).toBe(3);
    expect(snap(2.6, 0.25)).toBe(2.5);
    expect(snap(0.34, 0.1)).toBe(0.3);
  });

  it('moves the box on the grid and keeps it inside the UV area', () => {
    const start = { x: 2, y: 2, w: 4, h: 4 };
    expect(dragBox(start, 'move', 1.4, -0.6, 1, [16, 16])).toEqual({ x: 3, y: 1, w: 4, h: 4 });
    expect(dragBox(start, 'move', 100, 100, 1, [16, 16])).toEqual({ x: 12, y: 12, w: 4, h: 4 });
    expect(dragBox(start, 'move', -100, -100, 1, [16, 16])).toEqual({ x: 0, y: 0, w: 4, h: 4 });
  });

  it('resizes by edges and corners without turning inside out', () => {
    const start = { x: 2, y: 2, w: 4, h: 4 };
    expect(dragBox(start, 'e', 3, 0, 1, [16, 16])).toEqual({ x: 2, y: 2, w: 7, h: 4 });
    expect(dragBox(start, 'w', -1, 0, 1, [16, 16])).toEqual({ x: 1, y: 2, w: 5, h: 4 });
    expect(dragBox(start, 'se', 1, 2, 1, [16, 16])).toEqual({ x: 2, y: 2, w: 5, h: 6 });
    expect(dragBox(start, 'e', -10, 0, 1, [16, 16])).toEqual({ x: 2, y: 2, w: 0, h: 4 });
    expect(dragBox(start, 'nw', 10, 10, 1, [16, 16])).toEqual({ x: 6, y: 6, w: 0, h: 0 });
    expect(dragBox(start, 'e', 0.3, 0, 0.25, [16, 16]).w).toBe(4.25);
  });

  it('puts the top of a rotated texture on the matching edge', () => {
    expect([0, 90, 180, 270].map(topEdge)).toEqual(['n', 'e', 's', 'w']);
  });
});
