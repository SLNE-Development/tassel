import { beforeAll, describe, expect, it } from 'vitest';
import { array } from '../modifiers/array';
import { evaluateObject, initModifiers } from '../modifiers/evaluate';
import { mirror } from '../modifiers/mirror';
import { subdivide } from '../modifiers/subdivide';
import { cutCube } from '../modifiers/testing';
import type { DocState, Edge, Modifier, PolyMesh, SceneObject } from '../types';
import { bevelEdges } from './ops/bevel';
import { meshProblems } from './ops/checks';
import { deleteElements } from './ops/delete';
import { extrudeFaces, insetFaces } from './ops/extrude';
import { fillFace } from './ops/fill';
import { flipFaces } from './ops/flip';
import { loopCut } from './ops/loops';
import { mergeByDistance, mergeVertices } from './ops/merge';
import { subdivideFaces } from './ops/subdivide';
import { transformVertices } from './ops/transform';
import { faceArea } from './ops/util';
import { edges, polyMeshSchema, triangulate } from './polymesh';
import { createPrimitive } from './primitives';
import { edgeFaces } from './topology';
import { clearUvs, packUvs, transformUvs, unwrap, uvArea, uvCharts } from './uv';

/** An L-shaped outline (2 x 2 with a 1 x 1 corner missing) extruded by 1: concave top and bottom faces, six sides. */
function lShape(): PolyMesh {
  const outline = [0, 0, 2, 0, 2, 1, 1, 1, 1, 2, 0, 2]; // counter-clockwise seen from above, as (x, -z)
  const positions: number[] = [];
  for (const y of [0, 1]) for (let i = 0; i < 6; i++) positions.push(outline[i * 2], y, -outline[i * 2 + 1]);
  const faces = [[6, 7, 8, 9, 10, 11], [5, 4, 3, 2, 1, 0]];
  for (let i = 0; i < 6; i++) faces.push([i, (i + 1) % 6, ((i + 1) % 6) + 6, i + 6]);
  return { positions, faces };
}

const cube = createPrimitive('cube');
const solids: Record<string, PolyMesh> = {
  cube,
  cylinder: createPrimitive('cylinder', { segments: 16 }),
  uv_sphere: createPrimitive('uv_sphere', { segments: 12, rings: 6 }),
  torus: createPrimitive('torus', { segments: 12, minorSegments: 6 }),
  ico_sphere: createPrimitive('ico_sphere', { subdivisions: 1 }),
  'L shape': lShape(),
};
const solidList = Object.entries(solids);

/** Every face has one UV pair per corner, all finite. */
function expectAligned(mesh: PolyMesh): void {
  if (!mesh.uvs) return;
  expect(mesh.uvs.length).toBe(mesh.faces.length);
  mesh.uvs.forEach((uv, f) => {
    expect(uv.length, `face ${f}`).toBe(mesh.faces[f].length * 2);
    expect(uv.every(Number.isFinite), `face ${f}`).toBe(true);
  });
  expect(polyMeshSchema.safeParse(mesh).success).toBe(true);
}

interface Tri {
  face: number;
  uv: number[];
  area: number;
}

/** The triangles of the mesh in UV space, as the renderer gets them. */
function uvTriangles(mesh: PolyMesh): Tri[] {
  const soup = triangulate(mesh);
  const out: Tri[] = [];
  for (let t = 0; t < soup.triToFace.length; t++) {
    const uv = [...soup.uvs!.subarray(t * 6, t * 6 + 6)];
    out.push({ face: soup.triToFace[t], uv, area: uvArea(uv) });
  }
  return out;
}

/** True if the two triangles share interior area (touching edges or corners do not count). */
function trianglesOverlap(a: number[], b: number[], eps = 1e-7): boolean {
  for (const tri of [a, b]) {
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      const nx = tri[j * 2 + 1] - tri[i * 2 + 1];
      const ny = tri[i * 2] - tri[j * 2];
      const length = Math.hypot(nx, ny);
      if (length === 0) continue;
      const project = (t: number[]) => [0, 1, 2].map((k) => (t[k * 2] * nx + t[k * 2 + 1] * ny) / length);
      const [pa, pb] = [project(a), project(b)];
      if (Math.max(...pa) <= Math.min(...pb) + eps || Math.max(...pb) <= Math.min(...pa) + eps) return false;
    }
  }
  return true;
}

interface Box {
  min: [number, number];
  max: [number, number];
}

function chartBox(mesh: PolyMesh, chart: readonly number[]): Box {
  const box: Box = { min: [Infinity, Infinity], max: [-Infinity, -Infinity] };
  for (const f of chart) {
    mesh.uvs![f].forEach((x, i) => {
      box.min[i % 2] = Math.min(box.min[i % 2], x);
      box.max[i % 2] = Math.max(box.max[i % 2], x);
    });
  }
  return box;
}

/**
 * The checks every packed unwrap has to pass: all UVs inside 0..1, charts do not overlap and keep
 * `margin` distance from each other and from the border, no chart is folded over, and all charts
 * have the same texel density. `charts` defaults to the UV islands of the mesh; `mirrored` are faces
 * whose UVs are expected to run clockwise.
 */
function expectPacked(mesh: PolyMesh, margin: number, charts = uvCharts(mesh), mirrored: readonly number[] = []): void {
  expectAligned(mesh);
  for (const uv of mesh.uvs!) for (const x of uv) expect(x >= 0 && x <= 1, `uv ${x}`).toBe(true);

  const chartOf = new Map<number, number>();
  charts.forEach((chart, i) => chart.forEach((f) => chartOf.set(f, i)));
  expect(chartOf.size).toBe(mesh.faces.length);

  // No fold: every triangle of the mesh is counter-clockwise in UV space, like on the surface.
  const triangles = uvTriangles(mesh);
  for (const t of triangles) expect(t.area * (mirrored.includes(t.face) ? -1 : 1), `triangle of face ${t.face}`).toBeGreaterThan(0);

  // No overlap between charts.
  for (let i = 0; i < triangles.length; i++) {
    for (let j = i + 1; j < triangles.length; j++) {
      if (chartOf.get(triangles[i].face) === chartOf.get(triangles[j].face)) continue;
      expect(trianglesOverlap(triangles[i].uv, triangles[j].uv), `faces ${triangles[i].face} and ${triangles[j].face} overlap`).toBe(false);
    }
  }

  // Margins: between the bounding rectangles of the charts and to the border.
  const tolerance = 1e-5;
  const boxes = charts.map((chart) => chartBox(mesh, chart));
  boxes.forEach((a, i) => {
    for (const k of [0, 1]) {
      expect(a.min[k]).toBeGreaterThanOrEqual(margin - tolerance);
      expect(a.max[k]).toBeLessThanOrEqual(1 - margin + tolerance);
    }
    for (let j = i + 1; j < boxes.length; j++) {
      const b = boxes[j];
      const gap = Math.max(a.min[0] - b.max[0], b.min[0] - a.max[0], a.min[1] - b.max[1], b.min[1] - a.max[1]);
      expect(gap, `charts ${i} and ${j}`).toBeGreaterThanOrEqual(margin - tolerance);
    }
  });

  // Uniform texel density: UV area per surface area is the same for every chart.
  const density = charts.map((chart) => {
    let [uv, surface] = [0, 0];
    for (const f of chart) {
      uv += Math.abs(uvArea(mesh.uvs![f]));
      surface += faceArea(mesh, mesh.faces[f]);
    }
    return uv / surface;
  });
  for (const d of density) expect(d / density[0]).toBeCloseTo(1, 2);
}

describe('the test solids', () => {
  it.each(solidList)('%s is a closed manifold', (_, mesh) => expect(meshProblems(mesh)).toEqual([]));
});

describe.each(solidList)('unwrap %s', (name, mesh) => {
  it.each(['smart', 'box'] as const)('%s: packed charts without overlap, fold or density differences', (method) => {
    const result = unwrap(mesh, { method });
    expect(result.mesh.positions).toBe(mesh.positions);
    expect(result.mesh.faces).toBe(mesh.faces);
    expect(mesh.uvs).toBeUndefined();
    const charts = uvCharts(result.mesh);
    expect(result.charts).toBe(charts.length);
    expectPacked(result.mesh, 0.02, charts);
    expect(result.coverage).toBeGreaterThan(0.15);
    expect(result.coverage).toBeLessThanOrEqual(1);
    expect(result.coverage).toBeCloseTo(result.mesh.uvs!.reduce((sum, uv) => sum + uvArea(uv), 0), 5);
  });

  it.each(['smart', 'box'] as const)('%s is deterministic', (method) => {
    expect(unwrap(mesh, { method })).toEqual(unwrap(mesh, { method }));
    const copy: PolyMesh = { positions: [...mesh.positions], faces: mesh.faces.map((f) => [...f]) };
    expect(unwrap(copy, { method }).mesh.uvs).toEqual(unwrap(mesh, { method }).mesh.uvs);
  });

  it('smart with a wide margin and a small angle', () => {
    const result = unwrap(mesh, { method: 'smart', angle: 20, margin: 0.05 });
    // Many small charts may need a smaller margin than asked for; these meshes do not.
    expectPacked(result.mesh, name === 'ico_sphere' ? 0 : 0.05);
  });

  it.each(['planar', 'cylinder', 'sphere'] as const)('%s: aligned UVs and no face smeared across the texture', (method) => {
    for (const axis of ['x', 'y', 'z'] as const) {
      const result = unwrap(mesh, { method, axis });
      expectAligned(result.mesh);
      expect(result.charts).toBe(uvCharts(result.mesh).length);
      if (method === 'planar') continue;
      result.mesh.uvs!.forEach((uv, f) => {
        const us = uv.filter((_, i) => i % 2 === 0);
        // Round shapes around their own axis: a face covers a small part of the turn. Caps are projected flat.
        const span = Math.max(...us) - Math.min(...us);
        if (mesh.faces[f].length <= 4 && axis === 'y' && name !== 'L shape' && name !== 'cube') expect(span, `face ${f}`).toBeLessThan(0.25);
        expect(span, `face ${f}`).toBeLessThanOrEqual(1);
        for (let i = 1; i < uv.length; i += 2) expect(uv[i] >= 0 && uv[i] <= 1).toBe(true);
      });
    }
  });
});

describe('smart unwrap', () => {
  it('cube at the default angle: six square charts of the same size', () => {
    const result = unwrap(cube, { method: 'smart' });
    expect(result.charts).toBe(6);
    const sizes = uvCharts(result.mesh).map((chart) => {
      const box = chartBox(result.mesh, chart);
      return [box.max[0] - box.min[0], box.max[1] - box.min[1]];
    });
    for (const [w, h] of sizes) {
      expect(w).toBeCloseTo(sizes[0][0], 5);
      expect(h).toBeCloseTo(w, 5);
    }
    // Three squares side by side with four margins fill the width.
    expect(sizes[0][0]).toBeCloseTo((1 - 4 * 0.02) / 3, 4);
    expect(result.coverage).toBeCloseTo(6 * sizes[0][0] ** 2, 4);
  });

  it('side faces stand upright: v grows with y', () => {
    const { mesh } = unwrap(cube, { method: 'smart' });
    // Face 0 is +Z [4,5,6,7]: bottom left, bottom right, top right, top left seen from outside.
    const [u4, v4, u5, v5, u6, v6, u7, v7] = mesh.uvs![0];
    expect(u5).toBeGreaterThan(u4);
    expect(v5).toBeCloseTo(v4, 6);
    expect(v6).toBeGreaterThan(v5);
    expect(u6).toBeCloseTo(u5, 6);
    expect([u7, v7]).toEqual([u4, v6]);
  });

  it('a larger angle merges faces into fewer charts', () => {
    const sphere = solids.uv_sphere;
    const counts = [10, 45, 66, 89].map((angle) => unwrap(sphere, { method: 'smart', angle }).charts);
    expect(counts[0]).toBeGreaterThan(counts[1]);
    expect(counts[1]).toBeGreaterThanOrEqual(counts[2]);
    expect(counts[2]).toBeGreaterThanOrEqual(counts[3]);
    expect(counts[3]).toBeGreaterThanOrEqual(2);
    // Angle 0 on a cube still keeps coplanar faces together.
    expect(unwrap(subdivideFaces(cube, [0, 1, 2, 3, 4, 5], 1).mesh, { method: 'smart', angle: 0 }).charts).toBe(6);
  });

  it('a flat plane is one chart filling the square up to the margins', () => {
    const plane = createPrimitive('plane');
    const result = unwrap(plane, { method: 'smart', margin: 0.02 });
    expect(result.charts).toBe(1);
    const box = chartBox(result.mesh, [0]);
    expect(box).toEqual({ min: [0.02, 0.02], max: [0.98, 0.98] });
    expect(result.coverage).toBeCloseTo(0.96 * 0.96, 6);
    // x runs to the right, -z up.
    plane.faces[0].forEach((v, i) => {
      expect(result.mesh.uvs![0][i * 2]).toBe(plane.positions[v * 3] > 0 ? 0.98 : 0.02);
      expect(result.mesh.uvs![0][i * 2 + 1]).toBe(plane.positions[v * 3 + 2] < 0 ? 0.98 : 0.02);
    });
  });

  it('keeps the aspect of a chart: a 2 : 1 rectangle fills the width and half the height', () => {
    const plane = createPrimitive('plane');
    const wide: PolyMesh = { positions: plane.positions.map((x, i) => (i % 3 === 0 ? x * 2 : x)), faces: plane.faces };
    const box = chartBox(unwrap(wide, { method: 'smart', margin: 0.1 }).mesh, [0]);
    expect(box.min[0]).toBeCloseTo(0.1, 6);
    expect(box.max[0]).toBeCloseTo(0.9, 6);
    expect(box.max[1] - box.min[1]).toBeCloseTo(0.4, 6);
    expect((box.min[1] + box.max[1]) / 2).toBeCloseTo(0.5, 6);
  });

  it('turns a diagonal chart to its smallest rectangle', () => {
    // A 4 x 1 strip lying diagonally in the XZ plane.
    const [c, s] = [Math.cos(Math.PI / 4), Math.sin(Math.PI / 4)];
    const corners = [-2, -0.5, 2, -0.5, 2, 0.5, -2, 0.5];
    const positions: number[] = [];
    for (let i = 0; i < 8; i += 2) positions.push(corners[i] * c - corners[i + 1] * s, 0, -(corners[i] * s + corners[i + 1] * c));
    const result = unwrap({ positions, faces: [[0, 1, 2, 3]] }, { method: 'smart', margin: 0 });
    const box = chartBox(result.mesh, [0]);
    expect(box.max[0] - box.min[0]).toBeCloseTo(1, 5);
    expect(box.max[1] - box.min[1]).toBeCloseTo(0.25, 5);
    expect(result.coverage).toBeCloseTo(0.25, 5);
  });

  it('many charts: the margin shrinks instead of failing', () => {
    const mesh = createPrimitive('ico_sphere', { subdivisions: 3 }); // 1280 triangles
    const result = unwrap(mesh, { method: 'smart', angle: 0, margin: 0.1 });
    expect(result.charts).toBe(1280);
    expectAligned(result.mesh);
    for (const uv of result.mesh.uvs!) for (const x of uv) expect(x >= 0 && x <= 1).toBe(true);
    expect(result.coverage).toBeGreaterThan(0);
  });

  it('only the given faces: the others keep their UVs, or get 0,0', () => {
    const fresh = unwrap(cube, { method: 'smart', faces: [4] });
    expect(fresh.charts).toBe(1);
    expect(chartBox(fresh.mesh, [4])).toEqual({ min: [0.02, 0.02], max: [0.98, 0.98] });
    for (const f of [0, 1, 2, 3, 5]) expect(fresh.mesh.uvs![f]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);

    const all = unwrap(cube, { method: 'smart' }).mesh;
    const again = unwrap(all, { method: 'planar', faces: [4, 5] }).mesh;
    for (const f of [0, 1, 2, 3]) expect(again.uvs![f]).toBe(all.uvs![f]);
    expect(again.uvs![4]).not.toEqual(all.uvs![4]);
    expect(() => unwrap(cube, { method: 'smart', faces: [6] })).toThrow('Face 6 does not exist');
  });

  it('handles faces without area and empty meshes', () => {
    const mesh: PolyMesh = { positions: [0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 0, 1], faces: [[0, 1, 2], [0, 1, 3]] };
    for (const method of ['smart', 'box', 'planar', 'cylinder', 'sphere'] as const) expectAligned(unwrap(mesh, { method }).mesh);
    expect(unwrap({ positions: [], faces: [] }, { method: 'smart' })).toMatchObject({ charts: 0, coverage: 0, mesh: { uvs: [] } });
  });
});

describe('box unwrap', () => {
  it('cube: six charts; sphere: six charts, one per direction', () => {
    expect(unwrap(cube, { method: 'box' }).charts).toBe(6);
    expect(unwrap(createPrimitive('uv_sphere'), { method: 'box' }).charts).toBe(6);
  });

  it('separate regions facing the same way are separate charts', () => {
    const result = unwrap(lShape(), { method: 'box' });
    // Top, bottom, and six sides (two each face +X and -Z, at different depths).
    expect(result.charts).toBe(8);
  });
});

describe('projections', () => {
  it('planar along y: a top view with x to the right and -z up; the bottom gets the same image', () => {
    const { mesh, charts } = unwrap(cube, { method: 'planar' });
    // Face 4 is +Y [7,6,2,3], face 5 is -Y [0,1,5,4].
    expect(mesh.uvs![4]).toEqual([0, 0, 1, 0, 1, 1, 0, 1]);
    expect(mesh.uvs![5]).toEqual([0, 1, 1, 1, 1, 0, 0, 0]);
    expect(uvArea(mesh.uvs![4])).toBe(1);
    expect(uvArea(mesh.uvs![5])).toBe(-1);
    // The side faces are seen edge-on.
    expect(uvArea(mesh.uvs![0])).toBe(0);
    expect(charts).toBe(1);
  });

  it('planar along x and z: seen from the positive side, y up', () => {
    // Face 2 is +X [5,1,2,6]: from outside, +Z is on the left.
    expect(unwrap(cube, { method: 'planar', axis: 'x' }).mesh.uvs![2]).toEqual([0, 0, 1, 0, 1, 1, 0, 1]);
    // Face 0 is +Z [4,5,6,7].
    expect(unwrap(cube, { method: 'planar', axis: 'z' }).mesh.uvs![0]).toEqual([0, 0, 1, 0, 1, 1, 0, 1]);
  });

  it('planar keeps the proportions: the longer side fills 0..1, the other is centred', () => {
    const wide: PolyMesh = { positions: cube.positions.map((x, i) => (i % 3 === 0 ? x * 2 : x)), faces: cube.faces };
    expect(unwrap(wide, { method: 'planar' }).mesh.uvs![4]).toEqual([0, 0.25, 1, 0.25, 1, 0.75, 0, 0.75]);
  });

  const segments = 8;
  const cylinder = createPrimitive('cylinder', { segments });
  const isSide = (mesh: PolyMesh, f: number) => mesh.faces[f].length === 4;

  it('cylinder: u once around (front = 0.5, growing to the right), v along the axis, caps flat', () => {
    const { mesh } = unwrap(cylinder, { method: 'cylinder' });
    let sideArea = 0;
    mesh.faces.forEach((face, f) => {
      const uv = mesh.uvs![f];
      if (!isSide(mesh, f)) {
        // A cap: the circle inscribed in the square.
        face.forEach((v, i) => {
          expect(uv[i * 2]).toBeCloseTo(0.5 + cylinder.positions[v * 3] / 2, 6);
          expect(uv[i * 2 + 1]).toBeCloseTo(0.5 - cylinder.positions[v * 3 + 2] / 2, 6);
        });
        return;
      }
      const us = uv.filter((_, i) => i % 2 === 0);
      expect(Math.max(...us) - Math.min(...us)).toBeCloseTo(1 / segments, 6);
      expect(Math.min(...us)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...us)).toBeLessThanOrEqual(1);
      face.forEach((v, i) => {
        const [x, y, z] = cylinder.positions.slice(v * 3, v * 3 + 3);
        expect(uv[i * 2 + 1]).toBe(y > 0 ? 1 : 0);
        // Away from the seam at the back the angle gives u directly.
        if (z > 0 || Math.abs(x) > 1e-9) expect(uv[i * 2]).toBeCloseTo(0.5 + Math.atan2(x, z) / (2 * Math.PI), 6);
      });
      // Counter-clockwise like on the surface: the texture is not mirrored.
      expect(uvArea(uv)).toBeGreaterThan(0);
      sideArea += uvArea(uv);
    });
    expect(sideArea).toBeCloseTo(1, 6);
    // The side is one island (cut at the seam), each cap its own.
    expect(uvCharts(mesh).length).toBe(3);
  });

  it('cylinder: faces across the seam stay in one piece', () => {
    // Turned by half a segment, so that the seam at the back runs through the middle of a face.
    const turned = transformVertices(cylinder, cylinder.faces.flat(), { rotate: [0, 180 / segments, 0], pivot: [0, 0, 0] }).mesh;
    const { mesh } = unwrap(turned, { method: 'cylinder' });
    let outside = 0;
    mesh.faces.forEach((_, f) => {
      if (!isSide(mesh, f)) return;
      const us = mesh.uvs![f].filter((_, i) => i % 2 === 0);
      expect(Math.max(...us) - Math.min(...us)).toBeCloseTo(1 / segments, 6);
      expect(uvArea(mesh.uvs![f])).toBeCloseTo(1 / segments, 6);
      if (Math.min(...us) < 0 || Math.max(...us) > 1) outside++;
    });
    expect(outside).toBe(1);
  });

  it('cylinder around x and z', () => {
    for (const [axis, rotate] of [['x', [0, 0, -90]], ['z', [90, 0, 0]]] as const) {
      const turned = transformVertices(cylinder, cylinder.faces.flat(), { rotate: [...rotate], pivot: [0, 0, 0] }).mesh;
      const { mesh } = unwrap(turned, { method: 'cylinder', axis });
      let sideArea = 0;
      mesh.faces.forEach((_, f) => {
        if (isSide(mesh, f)) sideArea += Math.abs(uvArea(mesh.uvs![f]));
      });
      expect(sideArea).toBeCloseTo(1, 5);
    }
  });

  it('sphere: latitude as v, poles get the middle u of their triangle', () => {
    const sphere = createPrimitive('uv_sphere', { segments: 8, rings: 4 });
    const { mesh } = unwrap(sphere, { method: 'sphere' });
    let area = 0;
    mesh.faces.forEach((face, f) => {
      const uv = mesh.uvs![f];
      const us = uv.filter((_, i) => i % 2 === 0);
      expect(Math.max(...us) - Math.min(...us)).toBeLessThanOrEqual(1 / 8 + 1e-6);
      face.forEach((v, i) => {
        const [x, y, z] = sphere.positions.slice(v * 3, v * 3 + 3);
        expect(uv[i * 2 + 1]).toBeCloseTo(0.5 + Math.asin(y) / Math.PI, 6);
        if (Math.abs(y) === 1) {
          const others = us.filter((_, k) => k !== i);
          expect(others.length).toBe(2);
          expect(uv[i * 2]).toBeCloseTo((others[0] + others[1]) / 2, 6);
        } else if (z > 0 || Math.abs(x) > 1e-9) expect(uv[i * 2]).toBeCloseTo(0.5 + Math.atan2(x, z) / (2 * Math.PI), 6);
      });
      expect(uvArea(uv)).toBeGreaterThan(0);
      area += uvArea(uv);
    });
    // Everything but the gaps between the pole triangles: 2 rows of quads, 2 rows of triangles.
    expect(area).toBeCloseTo(0.5 + 0.25, 6);
    expect(uvCharts(mesh).length).toBe(1);
  });
});

describe('uv islands, pack, transform, clear', () => {
  const smart = unwrap(cube, { method: 'smart' }).mesh;

  it('uvCharts: faces sharing an edge with the same UVs on both sides', () => {
    expect(uvCharts(cube)).toEqual([]);
    expect(uvCharts(smart)).toEqual([[0], [1], [2], [3], [4], [5]]);
    const grid = subdivideFaces(cube, [0, 1, 2, 3, 4, 5], 1).mesh;
    const charts = uvCharts(unwrap(grid, { method: 'smart' }).mesh);
    expect(charts.length).toBe(6);
    for (const chart of charts) expect(chart.length).toBe(4);
    expect(uvCharts(unwrap(grid, { method: 'smart' }).mesh, [0, 1, 2, 3, 4])).toEqual(expect.arrayContaining([expect.any(Array)]));
  });

  it('transform: scale, then rotate about the pivot, then translate', () => {
    const mesh: PolyMesh = { positions: createPrimitive('plane').positions, faces: [[0, 1, 2, 3]], uvs: [[0, 0, 1, 0, 1, 1, 0, 1]] };
    expect(transformUvs(mesh, null, { translate: [0.25, -0.5] }).uvs![0]).toEqual([0.25, -0.5, 1.25, -0.5, 1.25, 0.5, 0.25, 0.5]);
    // The default pivot is the centre of the UVs.
    expect(transformUvs(mesh, null, { scale: 0.5 }).uvs![0]).toEqual([0.25, 0.25, 0.75, 0.25, 0.75, 0.75, 0.25, 0.75]);
    expect(transformUvs(mesh, null, { scale: [2, 1], pivot: [0, 0] }).uvs![0]).toEqual([0, 0, 2, 0, 2, 1, 0, 1]);
    expect(transformUvs(mesh, null, { rotate: 90 }).uvs![0]).toEqual([1, 0, 1, 1, 0, 1, 0, 0]);
    expect(transformUvs(mesh, null, { rotate: 90, pivot: [0, 0] }).uvs![0]).toEqual([0, 0, 0, 1, -1, 1, -1, 0]);
    expect(transformUvs(mesh, null, { scale: [2, 1], rotate: 90, translate: [1, 0], pivot: [0, 0] }).uvs![0]).toEqual([1, 0, 1, 2, 0, 2, 0, 0]);
    expect(mesh.uvs![0]).toEqual([0, 0, 1, 0, 1, 1, 0, 1]);
  });

  it('transform: only the given faces', () => {
    const moved = transformUvs(smart, [2], { translate: [1, 0] });
    expect(moved.uvs![2]).toEqual(smart.uvs![2].map((x, i) => (i % 2 === 0 ? Math.round((x + 1) * 1e6) / 1e6 : x)));
    for (const f of [0, 1, 3, 4, 5]) expect(moved.uvs![f]).toBe(smart.uvs![f]);
    expect(() => transformUvs(cube, null, { rotate: 1 })).toThrow('no UVs');
    expect(() => transformUvs(smart, [9], { rotate: 1 })).toThrow('Face 9 does not exist');
  });

  it('pack: after scaling and moving charts they are packed again at the same density', () => {
    let mesh = transformUvs(smart, [0], { scale: 3 });
    mesh = transformUvs(mesh, [1], { scale: 0.1, translate: [0.7, 0.3], rotate: 30 });
    mesh = transformUvs(mesh, [3], { translate: [5, -2] });
    const packed = packUvs(mesh, 0.02);
    expect(packed.charts).toBe(6);
    expectPacked(packed.mesh, 0.02);
    // The turned chart is upright again, so the result is the fresh layout up to the order of the charts.
    expect(packed.coverage).toBeCloseTo(unwrap(cube, { method: 'smart' }).coverage, 4);
    // Packing again changes nothing but rounding.
    const again = packUvs(packed.mesh, 0.02);
    expectPacked(again.mesh, 0.02);
    expect(again.coverage).toBeCloseTo(packed.coverage, 4);
    expect(again).toEqual(packUvs(packed.mesh, 0.02));
    expectPacked(packUvs(mesh, 0.08).mesh, 0.08);
    expect(() => packUvs(cube, 0.02)).toThrow('no UVs');
  });

  it('pack: a projection is cut into its islands', () => {
    const cylinder = createPrimitive('cylinder', { segments: 12 });
    const packed = packUvs(unwrap(cylinder, { method: 'cylinder' }).mesh, 0.03);
    expect(packed.charts).toBe(3);
    // The bottom cap is seen from above, so it is mirrored, and stays so.
    const bottom = cylinder.faces.findIndex((face) => face.length > 4 && face.every((v) => cylinder.positions[v * 3 + 1] < 0));
    expectPacked(packed.mesh, 0.03, uvCharts(packed.mesh), [bottom]);
  });

  it('pack: only the given faces', () => {
    const packed = packUvs(smart, 0.02, [4]);
    expect(packed.charts).toBe(1);
    const box = chartBox(packed.mesh, [4]);
    for (const k of [0, 1]) {
      expect(box.min[k]).toBeCloseTo(0.02, 4);
      expect(box.max[k]).toBeCloseTo(0.98, 4);
    }
    for (const f of [0, 1, 2, 3, 5]) expect(packed.mesh.uvs![f]).toBe(smart.uvs![f]);
  });

  it('clear removes the UVs', () => {
    const cleared = clearUvs(smart);
    expect(cleared).toEqual(cube);
    expect('uvs' in cleared).toBe(false);
    expect(clearUvs(cube)).toBe(cube);
  });
});

describe('triangulate with UVs', () => {
  it('returns no uvs for a mesh without them', () => {
    expect(triangulate(cube).uvs).toBeUndefined();
    expect(triangulate(cube, true).uvs).toBeUndefined();
  });

  /** For planar UVs every triangle corner must carry the UV that belongs to its position. */
  function expectConsistent(mesh: PolyMesh, uvOf: (x: number, y: number, z: number) => [number, number]) {
    for (const smooth of [false, true]) {
      const soup = triangulate(mesh, smooth);
      expect(soup.uvs!.length).toBe(soup.triToFace.length * 6);
      for (let c = 0; c < soup.triToFace.length * 3; c++) {
        const [u, v] = uvOf(soup.positions[c * 3], soup.positions[c * 3 + 1], soup.positions[c * 3 + 2]);
        expect(soup.uvs![c * 2]).toBeCloseTo(u, 6);
        expect(soup.uvs![c * 2 + 1]).toBeCloseTo(v, 6);
      }
    }
  }

  it('fan: quads and convex n-gons', () => {
    const mesh = unwrap(createPrimitive('cylinder', { segments: 8 }), { method: 'planar' }).mesh;
    expectConsistent(mesh, (x, _, z) => [0.5 + x / 2, 0.5 - z / 2]);
  });

  it('ear clipping: the triangles of a concave face cover its UV polygon exactly', () => {
    const mesh = unwrap(lShape(), { method: 'planar' }).mesh;
    expectConsistent(mesh, (x, _, z) => [x / 2, -z / 2]);
    const triangles = uvTriangles(mesh);
    for (const f of [0, 1]) {
      const own = triangles.filter((t) => t.face === f);
      expect(own.length).toBe(4);
      const sign = f === 0 ? 1 : -1;
      for (const t of own) expect(t.area * sign).toBeGreaterThan(0);
      expect(own.reduce((sum, t) => sum + t.area, 0)).toBeCloseTo(uvArea(mesh.uvs![f]), 6);
      expect(uvArea(mesh.uvs![f])).toBeCloseTo(sign * 0.75, 6);
    }
  });

  it('concave quads (reflex corner at any position)', () => {
    // An arrow head in the XZ plane, counter-clockwise seen from above; corner 2 is the reflex one.
    const points = [0, 0, 2, -1, 0.5, 0, 2, 1];
    for (let shift = 0; shift < 4; shift++) {
      const positions: number[] = [];
      for (let i = 0; i < 4; i++) positions.push(points[((i + shift) % 4) * 2], 0, -points[((i + shift) % 4) * 2 + 1]);
      // Reversed so that it is counter-clockwise from above.
      const base: PolyMesh = { positions, faces: [[3, 2, 1, 0]] };
      const mesh = unwrap(base, { method: 'planar' }).mesh;
      expectConsistent(mesh, (x, _, z) => [0.5 + (x - 1) / 2, 0.5 - z / 2]);
      const triangles = uvTriangles(mesh);
      expect(triangles.length).toBe(2);
      for (const t of triangles) expect(t.area * Math.sign(uvArea(mesh.uvs![0]))).toBeGreaterThan(0);
      expect(triangles[0].area + triangles[1].area).toBeCloseTo(uvArea(mesh.uvs![0]), 6);
    }
  });
});

describe('mesh operations and UVs', () => {
  const withUvs = Object.fromEntries(solidList.map(([name, mesh]) => [name, unwrap(mesh, { method: 'smart' }).mesh]));
  const list = Object.entries(withUvs);
  const allVertices = (mesh: PolyMesh) => Array.from({ length: mesh.positions.length / 3 }, (_, i) => i);
  /** UV per vertex of a face. */
  const cornerUvs = (mesh: PolyMesh, f: number) => new Map(mesh.faces[f].map((v, i) => [v, [mesh.uvs![f][i * 2], mesh.uvs![f][i * 2 + 1]]]));

  describe.each(list)('%s', (name, mesh) => {
    const someFaces = mesh.faces.map((_, i) => i).filter((i) => i % 3 === 0);
    const edge = edges(mesh)[0] as Edge;

    it('operations that change the topology drop the UVs', () => {
      const results = [
        extrudeFaces(mesh, [0], 0.3),
        insetFaces(mesh, [0], 0.05, 0, false),
        insetFaces(mesh, someFaces, 0.01, 0.1, true),
        subdivideFaces(mesh, someFaces, 2),
        bevelEdges(mesh, [edge], 0.05, 2),
        fillFace(deleteElements(mesh, { faces: [0] }).mesh, mesh.faces[0], null),
      ];
      // Loop cuts need a quad.
      const quad = mesh.faces.find((face) => face.length === 4);
      expect(quad === undefined).toBe(name === 'ico_sphere');
      if (quad) results.push(loopCut(mesh, [Math.min(quad[0], quad[1]), Math.max(quad[0], quad[1])], 2));
      for (const result of results) {
        expect(result.mesh.uvs).toBeUndefined();
        expect('uvs' in result.mesh).toBe(false);
      }
    });

    it('transform keeps the UVs', () => {
      const result = transformVertices(mesh, mesh.faces[0], { translate: [0, 1, 0], rotate: [10, 20, 30], scale: [2, 1, 1] });
      expect(result.mesh.uvs).toBe(mesh.uvs);
      expectAligned(result.mesh);
    });

    it('flip keeps every corner on its UV', () => {
      const result = flipFaces(mesh, someFaces);
      expectAligned(result.mesh);
      mesh.faces.forEach((_, f) => {
        expect(cornerUvs(result.mesh, f)).toEqual(cornerUvs(mesh, f));
        if (someFaces.includes(f)) {
          expect(result.mesh.faces[f]).not.toEqual(mesh.faces[f]);
          expect(uvArea(result.mesh.uvs![f])).toBeCloseTo(-uvArea(mesh.uvs![f]), 9);
        } else expect(result.mesh.uvs![f]).toBe(mesh.uvs![f]);
      });
    });

    it('delete keeps the UVs of the remaining faces exactly', () => {
      const byFaces = deleteElements(mesh, { faces: someFaces }).mesh;
      expectAligned(byFaces);
      expect(byFaces.uvs).toEqual(mesh.uvs!.filter((_, f) => !someFaces.includes(f)));

      const vertex = mesh.faces[0][0];
      const byVertex = deleteElements(mesh, { vertices: [vertex] }).mesh;
      expectAligned(byVertex);
      expect(byVertex.uvs).toEqual(mesh.uvs!.filter((_, f) => !mesh.faces[f].includes(vertex)));

      const byEdge = deleteElements(mesh, { edges: [edge] }).mesh;
      expectAligned(byEdge);
      const gone = edgeFaces(mesh).get(`${edge[0]}:${edge[1]}`)!;
      expect(byEdge.uvs).toEqual(mesh.uvs!.filter((_, f) => !gone.includes(f)));

      const nothing = deleteElements(mesh, { faces: mesh.faces.map((_, f) => f) }).mesh;
      expect(nothing.uvs).toEqual([]);
    });

    it('merge keeps the UVs aligned with the surviving faces', () => {
      for (const at of ['center', 'first', 'last'] as const) {
        for (const vertices of [mesh.faces[0], [...edge], mesh.faces[0].slice(0, 3)]) {
          const result = mergeVertices(mesh, vertices, at).mesh;
          expect(result.uvs).toBeDefined();
          expectAligned(result);
          expect(result.faces.length).toBeLessThan(mesh.faces.length + 1);
        }
      }
      // Faces that are not touched keep their UVs: every UV list of the result that still has its length is an old one.
      const result = mergeVertices(mesh, [...edge], 'center').mesh;
      const old = new Set(mesh.uvs!.map((uv) => uv.join(',')));
      const untouched = result.uvs!.filter((uv) => old.has(uv.join(','))).length;
      expect(untouched).toBeGreaterThanOrEqual(result.faces.length - 8);
    });

    it('merge by distance keeps the UVs aligned', () => {
      const nothing = mergeByDistance(mesh, null, 1e-6).mesh;
      expect(nothing.uvs).toEqual(mesh.uvs);
      for (const distance of [0.3, 0.8, 5]) {
        const result = mergeByDistance(mesh, null, distance).mesh;
        expectAligned(result);
        if (result.faces.length > 0) expect(result.uvs).toBeDefined();
      }
      expectAligned(mergeByDistance(mesh, mesh.faces[0], 10).mesh);
      expectAligned(mergeByDistance(mesh, allVertices(mesh), 0.5).mesh);
    });

    it('chains stay aligned', () => {
      let current = mergeVertices(mesh, [...edge], 'first').mesh;
      current = flipFaces(current, [0, 1]).mesh;
      current = deleteElements(current, { faces: [2] }).mesh;
      current = transformVertices(current, [0, 1, 2], { scale: [2, 2, 2] }).mesh;
      expectAligned(current);
      expect(current.uvs).toBeDefined();
      expectAligned(packUvs(current, 0.02).mesh);
      expectAligned(unwrap(current, { method: 'box' }).mesh);
    });
  });

  it('merging the top of a cube: the sides become triangles that keep their bottom UVs', () => {
    const mesh = withUvs.cube;
    const result = mergeVertices(mesh, cube.faces[4], 'center').mesh;
    expect(result.faces.length).toBe(5);
    expect(result.uvs!.map((uv) => uv.length).sort()).toEqual([6, 6, 6, 6, 8]);
    // Face 0 (+Z [4,5,6,7]) lost one of its top corners; 4 and 5 are where they were.
    const before = cornerUvs(mesh, 0);
    const after = cornerUvs(result, 0);
    const [v4, v5] = [result.faces[0][0], result.faces[0][1]];
    expect(after.get(v4)).toEqual(before.get(4));
    expect(after.get(v5)).toEqual(before.get(5));
  });

  it('welding two halves keeps the UV seam', () => {
    // Two quads side by side with doubled vertices in the middle and separate UV charts.
    const mesh: PolyMesh = {
      positions: [0, 0, 0, 1, 0, 0, 1, 0, -1, 0, 0, -1, 1, 0, 0, 2, 0, 0, 2, 0, -1, 1, 0, -1],
      faces: [[0, 1, 2, 3], [4, 5, 6, 7]],
      uvs: [[0, 0, 0.4, 0, 0.4, 0.4, 0, 0.4], [0.6, 0.6, 1, 0.6, 1, 1, 0.6, 1]],
    };
    const result = mergeByDistance(mesh, null, 0.001).mesh;
    expect(result.positions.length).toBe(18);
    expect(result.uvs).toEqual(mesh.uvs);
    expect(uvCharts(result).length).toBe(2);
  });
});

describe('modifiers and UVs', () => {
  const half = unwrap(cutCube([0]), { method: 'smart' }).mesh;

  it('mirror: the mirrored half uses the same UVs, corner by corner', () => {
    const result = mirror(half, { x: true, y: false, z: false }, 0.001);
    expectAligned(result);
    expect(meshProblems(result)).toEqual([]);
    const count = half.faces.length;
    expect(result.faces.length).toBe(count * 2);
    for (let f = 0; f < count; f++) {
      expect(result.uvs![f]).toBe(half.uvs![f]);
      const n = result.faces[f].length;
      for (let i = 0; i < n; i++) {
        // Corner i of the copy is the mirror image of corner n - 1 - i of the original.
        const [a, b] = [result.faces[f + count][i] * 3, result.faces[f][n - 1 - i] * 3];
        expect(result.positions[a]).toBeCloseTo(-result.positions[b], 9);
        expect(result.positions.slice(a + 1, a + 3)).toEqual(result.positions.slice(b + 1, b + 3));
        expect(result.uvs![f + count].slice(i * 2, i * 2 + 2)).toEqual(result.uvs![f].slice((n - 1 - i) * 2, (n - i) * 2));
      }
      expect(uvArea(result.uvs![f + count])).toBeCloseTo(-uvArea(result.uvs![f]), 9);
    }
    expect(mirror(cutCube([0]), { x: true, y: false, z: false }, 0.001).uvs).toBeUndefined();
  });

  it('mirror: faces in the mirror plane are dropped together with their UVs', () => {
    // A closed half cube: the face in the plane x = 0 goes.
    const positions = cube.positions.map((x, i) => (i % 3 === 0 && x < 0 ? 0 : x));
    const closed = unwrap({ positions, faces: cube.faces }, { method: 'smart' }).mesh;
    const result = mirror(closed, { x: true, y: true, z: false }, 0.001);
    expectAligned(result);
    expect(result.uvs).toBeDefined();
    expect(result.faces.length).toBe(20);
  });

  it('array: every copy has the UVs of the original', () => {
    const mesh = unwrap(cube, { method: 'smart' }).mesh;
    const result = array(mesh, 3, [3, 0, 0]);
    expectAligned(result);
    expect(result.uvs!.length).toBe(18);
    result.uvs!.forEach((uv, f) => expect(uv).toBe(mesh.uvs![f % 6]));
    expect(array(cube, 3, [3, 0, 0]).uvs).toBeUndefined();
  });

  it('subdivision: UVs are interpolated within each face and seams stay open', () => {
    for (const [name, base] of solidList) {
      const mesh = unwrap(base, { method: 'smart' }).mesh;
      const result = subdivide(mesh, 1);
      expectAligned(result);
      let child = 0;
      mesh.faces.forEach((face, f) => {
        const uv = mesh.uvs![f];
        const n = face.length;
        let centre = [0, 0];
        for (let i = 0; i < n; i++) centre = [centre[0] + uv[i * 2] / n, centre[1] + uv[i * 2 + 1] / n];
        let area = 0;
        for (let i = 0; i < n; i++, child++) {
          const sub = result.uvs![child];
          expect(result.faces[child][0]).toBe(face[i]);
          // The corner keeps its UV, the other three are the edge midpoints and the centre.
          expect(sub.slice(0, 2)).toEqual(uv.slice(i * 2, i * 2 + 2));
          const next = ((i + 1) % n) * 2;
          expect(sub[2]).toBeCloseTo((uv[i * 2] + uv[next]) / 2, 12);
          expect(sub[3]).toBeCloseTo((uv[i * 2 + 1] + uv[next + 1]) / 2, 12);
          expect(sub[4]).toBeCloseTo(centre[0], 12);
          expect(sub[5]).toBeCloseTo(centre[1], 12);
          area += uvArea(sub);
        }
        // Convex faces are covered exactly (the concave L faces only approximately, around their centre).
        if (name !== 'L shape' || n === 4) expect(area).toBeCloseTo(uvArea(uv), 9);
      });
      // Charts neither merge nor fall apart.
      expect(uvCharts(result).length).toBe(uvCharts(mesh).length);
      const twice = subdivide(mesh, 2);
      expectAligned(twice);
      expect(twice.uvs!.length).toBe(twice.faces.length);
    }
    expect(subdivide(cube, 2).uvs).toBeUndefined();
  });

  describe('evaluated objects', () => {
    beforeAll(() => initModifiers());

    function object(id: string, mesh: PolyMesh, modifiers: Modifier[] = []): SceneObject {
      return {
        id,
        name: id,
        visible: true,
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        mesh,
        modifiers,
        smooth: false,
        groupId: null,
        materialId: null,
      } as SceneObject;
    }
    const scene = (...objects: SceneObject[]) =>
      ({
        objects: Object.fromEntries(objects.map((o) => [o.id, o])),
        order: objects.map((o) => o.id),
        groups: {},
        groupOrder: [],
        materials: {},
        textures: {},
        selection: [],
        activeId: null,
        edit: null,
      }) as DocState;

    it('a stack of mirror, array and subdivision carries the UVs through', () => {
      const stack: Modifier[] = [
        { id: 'm', enabled: true, type: 'mirror', axes: { x: true, y: false, z: false }, mergeDistance: 0.001 },
        { id: 'a', enabled: true, type: 'array', count: 2, offset: [3, 0, 0], rotation: [0, 0, 0], pivot: [0, 0, 0], offsetSpace: 'local' },
        { id: 's', enabled: true, type: 'subdivision', levels: 2 },
      ];
      const { mesh, errors } = evaluateObject(scene(object('a', half, stack)), 'a');
      expect(errors).toEqual({});
      expect(mesh.uvs).toBeDefined();
      expectAligned(mesh);
      expect(mesh.faces.length).toBe(5 * 2 * 2 * 16);
      expect(triangulate(mesh, true).uvs!.length).toBe(mesh.faces.length * 2 * 6);
      for (const uv of mesh.uvs!) for (const x of uv) expect(x >= 0 && x <= 1).toBe(true);
    });

    it('boolean results have no UVs', () => {
      const a = unwrap(cube, { method: 'smart' }).mesh;
      const b = unwrap(createPrimitive('cube', { size: 1 }), { method: 'smart' }).mesh;
      const target = { ...object('b', b), transform: { position: [1, 1, 1], rotation: [0, 0, 0], scale: [1, 1, 1] } } as SceneObject;
      for (const operation of ['union', 'difference', 'intersect'] as const) {
        const modifier: Modifier = { id: 'x', enabled: true, type: 'boolean', operation, targetId: 'b' };
        const { mesh, errors } = evaluateObject(scene(object('a', a, [modifier]), target), 'a');
        expect(errors).toEqual({});
        expect(mesh.faces.length).toBeGreaterThan(6);
        expect(mesh.uvs).toBeUndefined();
        expect(triangulate(mesh).uvs).toBeUndefined();
      }
    });
  });
});

describe('polyMeshSchema', () => {
  const mesh = unwrap(cube, { method: 'smart' }).mesh;

  it('accepts meshes with and without UVs and keeps them', () => {
    expect(polyMeshSchema.parse(mesh)).toEqual(mesh);
    const plain = polyMeshSchema.parse(cube);
    expect(plain).toEqual(cube);
    expect('uvs' in plain).toBe(false);
    expect(polyMeshSchema.parse({ positions: [], faces: [], uvs: [] })).toEqual({ positions: [], faces: [], uvs: [] });
    expect(polyMeshSchema.parse(unwrap(lShape(), { method: 'box' }).mesh).uvs!.length).toBe(8);
  });

  it('rejects misaligned or non-finite UVs', () => {
    const message = (uvs: unknown) => {
      const result = polyMeshSchema.safeParse({ ...cube, uvs });
      return result.success ? null : result.error.issues[0].message;
    };
    expect(message(mesh.uvs!.slice(1))).toBe('uvs must have one entry per face');
    expect(message([...mesh.uvs!, [0, 0, 0, 0, 0, 0, 0, 0]])).toBe('uvs must have one entry per face');
    expect(message([])).toBe('uvs must have one entry per face');
    expect(message(mesh.uvs!.map((uv, f) => (f === 3 ? uv.slice(2) : uv)))).toBe('uvs must hold two numbers per face corner');
    expect(message(mesh.uvs!.map((uv, f) => (f === 0 ? [...uv, 0] : uv)))).toBe('uvs must hold two numbers per face corner');
    expect(message(mesh.uvs!.map((uv, f) => (f === 5 ? [NaN, ...uv.slice(1)] : uv)))).not.toBeNull();
    expect(message(mesh.uvs!.map((uv, f) => (f === 5 ? [Infinity, ...uv.slice(1)] : uv)))).not.toBeNull();
    expect(message(mesh.uvs!.map((uv, f) => (f === 5 ? ['0', ...uv.slice(1)] : uv)))).not.toBeNull();
    expect(message('none')).not.toBeNull();
  });
});
