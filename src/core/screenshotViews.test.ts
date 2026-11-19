import { describe, expect, it } from 'vitest';
import {
  MAX_SHEET_VIEWS,
  SHEET_GAP,
  axisWords,
  cameraBasis,
  describeCamera,
  describePreset,
  fitDistance,
  presetDirections,
  screenshotViews,
  sheetLayout,
  viewLabel,
} from './screenshotViews';
import { viewPresets } from './types';

describe('preset directions', () => {
  it('describes every preset in words', () => {
    expect(describePreset('front')).toEqual({ direction: 'camera at +Z looking toward -Z', imageRight: '+X', imageUp: '+Y' });
    expect(describePreset('back')).toEqual({ direction: 'camera at -Z looking toward +Z', imageRight: '-X', imageUp: '+Y' });
    expect(describePreset('right')).toEqual({ direction: 'camera at +X looking toward -X', imageRight: '-Z', imageUp: '+Y' });
    expect(describePreset('left')).toEqual({ direction: 'camera at -X looking toward +X', imageRight: '+Z', imageUp: '+Y' });
    expect(describePreset('top')).toEqual({ direction: 'camera at +Y looking toward -Y', imageRight: '+X', imageUp: '-Z' });
    expect(describePreset('bottom')).toEqual({ direction: 'camera at -Y looking toward +Y', imageRight: '+X', imageUp: '+Z' });
    expect(describePreset('iso')).toEqual({
      direction: 'camera at (+X, +Y, +Z) looking toward (-X, -Y, -Z)',
      imageRight: '(+X, -Z)',
      imageUp: '+Y',
    });
  });

  it('has a direction for every preset', () => {
    expect(Object.keys(presetDirections).sort()).toEqual([...viewPresets].sort());
  });

  it('does not depend on where the scene is', () => {
    expect(describeCamera([10, 5, 25], [10, 5, 5])).toEqual(describePreset('front'));
  });

  it('names a raised camera as such', () => {
    expect(describeCamera([7, 5, 9], [0, 1, 0])).toEqual({
      direction: 'camera at (+X, +Y, +Z) looking toward (-X, -Y, -Z)',
      imageRight: '(+X, -Z)',
      imageUp: '+Y',
    });
    expect(describeCamera([0.5, 1, 9], [0, 1, 0]).direction).toBe('camera at +Z looking toward -Z');
  });
});

describe('axisWords', () => {
  it('names the substantial axes only', () => {
    expect(axisWords([0, 0, -3])).toBe('-Z');
    expect(axisWords([1, 0.05, 0])).toBe('+X');
    expect(axisWords([1, -1, 0])).toBe('(+X, -Y)');
    expect(axisWords([1, 1, 1])).toBe('(+X, +Y, +Z)');
    expect(axisWords([0, 0, 0])).toBe('0');
  });
});

describe('cameraBasis', () => {
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  it('is orthonormal and right-handed for an arbitrary camera', () => {
    const { back, right, up } = cameraBasis([3, 7, -2], [1, 1, 1]);
    for (const v of [back, right, up]) expect(dot(v, v)).toBeCloseTo(1);
    expect(dot(back, right)).toBeCloseTo(0);
    expect(dot(back, up)).toBeCloseTo(0);
    expect(dot(right, up)).toBeCloseTo(0);
    expect(up[1]).toBeGreaterThan(0);
  });

  it('handles a camera straight above, straight below and on its target', () => {
    expect(describeCamera([0, 5, 0], [0, 0, 0])).toEqual(describePreset('top'));
    expect(describeCamera([0, -5, 0], [0, 0, 0])).toEqual(describePreset('bottom'));
    expect(describeCamera([1, 1, 1], [1, 1, 1]).direction).toBe('camera at +Z looking toward -Z');
  });
});

describe('screenshotViews', () => {
  it('uses the single view by default', () => {
    expect(screenshotViews({ view: 'iso' })).toEqual([{ name: 'iso', view: 'iso' }]);
  });

  it('prefers a camera over the view, and views over both', () => {
    const camera = { position: [1, 2, 3] as [number, number, number], target: [0, 0, 0] as [number, number, number] };
    expect(screenshotViews({ view: 'current', camera })).toEqual([{ name: 'camera', view: camera }]);
    expect(screenshotViews({ view: 'current', camera, views: ['front', camera, 'current'] })).toEqual([
      { name: 'front', view: 'front' },
      { name: 'camera 2', view: camera },
      { name: 'current', view: 'current' },
    ]);
  });

  it('ignores an empty list', () => {
    expect(screenshotViews({ view: 'top', views: [] })).toEqual([{ name: 'top', view: 'top' }]);
  });
});

describe('viewLabel', () => {
  it('names the view, the camera side and the image axes', () => {
    expect(viewLabel('front', describePreset('front'))).toBe('front | camera at +Z looking toward -Z | right +X, up +Y');
  });
});

describe('sheetLayout', () => {
  it('chooses a grid as square as possible', () => {
    const grid = (n: number) => {
      const { columns, rows } = sheetLayout(n, 1800, 1800);
      return `${columns}x${rows}`;
    };
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map(grid)).toEqual(['1x1', '2x1', '2x2', '2x2', '3x2', '3x2', '3x3', '3x3', '3x3']);
  });

  it('lays four views out as a 2 x 2 sheet that covers the image exactly', () => {
    const { tiles, labelHeight, fontSize } = sheetLayout(4, 1600, 1200);
    expect(tiles.map((t) => t.tile)).toEqual([
      { x: 0, y: 0, width: 799, height: 599 },
      { x: 801, y: 0, width: 799, height: 599 },
      { x: 0, y: 601, width: 799, height: 599 },
      { x: 801, y: 601, width: 799, height: 599 },
    ]);
    expect(fontSize).toBe(16);
    expect(labelHeight).toBe(24);
    for (const { tile, image } of tiles) {
      expect(image).toEqual({ x: tile.x, y: tile.y + labelHeight, width: tile.width, height: tile.height - labelHeight });
    }
  });

  it('keeps tiles inside the image, apart and of whole pixels for every count and odd sizes', () => {
    for (const [width, height] of [
      [1024, 768],
      [1001, 777],
      [4096, 4096],
      [640, 333],
    ]) {
      for (let n = 1; n <= MAX_SHEET_VIEWS; n++) {
        const { tiles, columns, rows } = sheetLayout(n, width, height);
        expect(tiles).toHaveLength(n);
        tiles.forEach(({ tile, image }, i) => {
          for (const v of [...Object.values(tile), ...Object.values(image)]) expect(Number.isInteger(v)).toBe(true);
          expect(tile.x).toBeGreaterThanOrEqual(0);
          expect(tile.y).toBeGreaterThanOrEqual(0);
          expect(tile.x + tile.width).toBeLessThanOrEqual(width);
          expect(tile.y + tile.height).toBeLessThanOrEqual(height);
          // The last column and row end at the image's edge.
          if (i % columns === columns - 1) expect(tile.x + tile.width).toBe(width);
          if (Math.floor(i / columns) === rows - 1) expect(tile.y + tile.height).toBe(height);
          const next = tiles[i + 1];
          if (next && next.tile.y === tile.y) expect(next.tile.x).toBe(tile.x + tile.width + SHEET_GAP);
        });
      }
    }
  });

  it('refuses a sheet whose views would be too small, and impossible counts', () => {
    expect(() => sheetLayout(9, 64, 64)).toThrow(/9 views do not fit on a 64 x 64 image/);
    expect(() => sheetLayout(0, 800, 600)).toThrow(/1 to 9 views/);
    expect(() => sheetLayout(10, 800, 600)).toThrow(/1 to 9 views/);
    expect(() => sheetLayout(1, 64, 64)).not.toThrow();
  });
});

describe('fitDistance', () => {
  /** Largest |x| / |y| of the box corners in normalised device coordinates for a camera at that distance. */
  function extent(min: [number, number, number], max: [number, number, number], direction: [number, number, number], fov: number, aspect: number) {
    const centre = min.map((m, k) => (m + max[k]) / 2) as [number, number, number];
    const points = [0, 1, 2, 3, 4, 5, 6, 7].map((i): [number, number, number] => [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]]);
    const d = fitDistance(points, centre, direction, fov, aspect);
    const l = Math.hypot(...direction);
    const position = centre.map((c, k) => c + (direction[k] / l) * d) as [number, number, number];
    const { back, right, up } = cameraBasis(position, centre);
    const t = Math.tan((fov * Math.PI) / 360);
    let x = 0;
    let y = 0;
    let nearest = Infinity;
    for (let i = 0; i < 8; i++) {
      const c = [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]];
      const rel = c.map((v, k) => v - position[k]);
      const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      const depth = -dot(rel, back);
      nearest = Math.min(nearest, depth);
      x = Math.max(x, Math.abs(dot(rel, right)) / (depth * t * aspect));
      y = Math.max(y, Math.abs(dot(rel, up)) / (depth * t));
    }
    return { x, y, nearest, d };
  }

  it('fits the box tightly from every preset side and for any aspect ratio', () => {
    const boxes: [[number, number, number], [number, number, number]][] = [
      [[-4, -0.5, -1], [4, 4, 3.5]],
      [[10, 0, 0], [10.2, 6, 0.1]],
      [[-1, -1, -1], [1, 1, 1]],
    ];
    for (const [min, max] of boxes) {
      for (const direction of Object.values(presetDirections)) {
        for (const aspect of [799 / 575, 0.5, 3]) {
          const e = extent(min, max, direction, 40, aspect);
          // Everything inside, and one of the two directions nearly fills the frame.
          expect(Math.max(e.x, e.y)).toBeLessThan(0.95);
          // (A thin slab seen end-on cannot: the camera keeps its distance from the near end.)
          if (min[0] !== 10) expect(Math.max(e.x, e.y)).toBeGreaterThan(0.8);
          expect(e.nearest).toBeGreaterThan(e.d * 0.05);
        }
      }
    }
  });

  it('keeps its distance from a box seen end-on and from a flat one', () => {
    // A long thin bar seen along its length: the near end must stay well in front of the camera.
    const bar = extent([-0.01, -0.01, -5], [0.01, 0.01, 5], [0, 0, 1], 40, 1.5);
    expect(bar.nearest).toBeGreaterThan(1);
    // A plane seen from above.
    const plane = extent([-1, 0, -1], [1, 0, 1], [0, 1, 1e-4], 40, 1);
    expect(plane.y).toBeGreaterThan(0.85);
    expect(plane.y).toBeLessThan(0.95);
  });
});

describe('fitDistance with few points', () => {
  it('frames only what is there, not the box around it', () => {
    // Two points far apart along X at different depths: seen from the front, X decides.
    const d = fitDistance(
      [
        [-4, 0, -1],
        [4, 0, 3],
      ],
      [0, 0, 1],
      [0, 0, 1],
      40,
      1,
    );
    const t = Math.tan((40 * Math.PI) / 360);
    expect(d).toBeCloseTo((2 + 4 / t) * 1.08);
    expect(fitDistance([], [0, 0, 0], [0, 0, 1], 40, 1)).toBeGreaterThan(0);
  });
});
