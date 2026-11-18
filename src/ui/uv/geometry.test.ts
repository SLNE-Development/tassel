import { describe, expect, it } from 'vitest';
import { createPrimitive } from '../../core/mesh/primitives';
import { unwrap } from '../../core/mesh/uv';
import type { PolyMesh } from '../../core/types';
import { facesInRect, pickFace, uvGeometry } from './geometry';

/** Two unit quads side by side in UV space and a small one on top of the first. */
const mesh: PolyMesh = {
  positions: [0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 1, 0, 1, 1, 0, 2, 1, 0],
  faces: [
    [0, 1, 4, 3],
    [1, 2, 5, 4],
    [0, 1, 4],
  ],
  uvs: [
    [0, 0, 0.5, 0, 0.5, 0.5, 0, 0.5],
    [0.5, 0, 1, 0, 1, 0.5, 0.5, 0.5],
    [0.1, 0.1, 0.2, 0.1, 0.2, 0.2],
  ],
};

describe('uvGeometry', () => {
  it('is null without UVs and cached per UV set', () => {
    expect(uvGeometry({ positions: mesh.positions, faces: mesh.faces })).toBeNull();
    expect(uvGeometry(mesh)).toBe(uvGeometry({ ...mesh }));
  });

  it('finds charts, bounds and coverage', () => {
    const g = uvGeometry(mesh)!;
    expect(g.charts).toEqual([[0, 1], [2]]);
    expect([...g.chartOf]).toEqual([0, 0, 1]);
    expect([...g.bounds.slice(4, 8)]).toEqual([0.5, 0, 1, 0.5]);
    expect(g.coverage).toBeCloseTo(0.505);
  });

  it('agrees with the unwrap result of a cube', () => {
    const result = unwrap(createPrimitive('cube'), { method: 'smart' });
    const g = uvGeometry(result.mesh)!;
    expect(g.charts.length).toBe(result.charts);
    expect(g.coverage).toBeCloseTo(result.coverage, 5);
  });
});

describe('pickFace', () => {
  const g = uvGeometry(mesh)!;
  it('picks the face under the point, the smallest where faces overlap', () => {
    expect(pickFace(g, 0.4, 0.4)).toBe(0);
    expect(pickFace(g, 0.75, 0.25)).toBe(1);
    expect(pickFace(g, 0.18, 0.12)).toBe(2);
    expect(pickFace(g, 0.12, 0.18)).toBe(0);
    expect(pickFace(g, 0.5, 0.75)).toBe(-1);
  });
});

describe('facesInRect', () => {
  const g = uvGeometry(mesh)!;
  it('selects faces with a corner inside, an edge through or the rectangle inside them', () => {
    expect(facesInRect(g, 0.9, 0.4, 1.2, 0.6)).toEqual([1]);
    // Crosses the shared edge without containing any corner.
    expect(facesInRect(g, 0.45, 0.2, 0.55, 0.3)).toEqual([0, 1]);
    // Entirely inside face 0, next to the small triangle.
    expect(facesInRect(g, 0.3, 0.3, 0.35, 0.35)).toEqual([0]);
    // The drag direction does not matter.
    expect(facesInRect(g, 0.35, 0.35, 0.3, 0.3)).toEqual([0]);
    expect(facesInRect(g, 0.6, 0.6, 0.9, 0.9)).toEqual([]);
    // Cuts a corner of the triangle's bounding box only.
    expect(facesInRect(g, 0.1, 0.15, 0.14, 0.2)).toEqual([0]);
  });
});
