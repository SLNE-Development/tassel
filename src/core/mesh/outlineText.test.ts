import { beforeAll, describe, expect, it } from 'vitest';
import { initManifold } from '../modifiers/boolean';
import { isClosedManifold, volume } from '../modifiers/testing';
import type { FontContour, FontOutline, PolyMesh } from '../types';
import { arial, arialChars } from './fixtures/fontFixture';
import { createOutlineText, flattenContour, outlineLineHeight } from './outlineText';
import { boundingBox, faceNormal, polyMeshSchema } from './polymesh';

beforeAll(() => initManifold());

const box = (mesh: PolyMesh) => boundingBox(mesh)!;
const glyph = (char: string) => arial.glyphs.find((g) => g.char === char)!;
/** Font units -> meters at size 1. */
const unit = 1 / arial.capHeight;

/** Number of separate pieces (faces connected through shared vertices). */
function pieces(mesh: PolyMesh): number {
  const parent = Array.from({ length: mesh.positions.length / 3 }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const face of mesh.faces) for (const v of face) parent[find(v)] = find(face[0]);
  return new Set(mesh.faces.flat().map(find)).size;
}

function expectSolid(mesh: PolyMesh, depth: number) {
  expect(polyMeshSchema.safeParse(mesh).success).toBe(true);
  expect(mesh.positions.every(Number.isFinite)).toBe(true);
  expect(mesh.positions.some((v) => Object.is(v, -0))).toBe(false);
  expect(mesh.faces.length).toBeGreaterThan(0);
  expect(mesh.faces.every((f) => f.length === 3 && new Set(f).size === 3)).toBe(true);
  expect(new Set(mesh.faces.flat()).size).toBe(mesh.positions.length / 3);
  expect(isClosedManifold(mesh)).toBe(true);
  expect(volume(mesh)).toBeGreaterThan(0);
  for (let i = 2; i < mesh.positions.length; i += 3) expect(mesh.positions[i] === 0 || mesh.positions[i] === depth).toBe(true);
  // What is in the front plane faces +Z, what is in the back plane -Z.
  for (const face of mesh.faces) {
    const zs = face.map((v) => mesh.positions[v * 3 + 2]);
    if (zs.every((z) => z === depth)) expect(faceNormal(mesh, face)[2]).toBeCloseTo(1, 6);
    if (zs.every((z) => z === 0)) expect(faceNormal(mesh, face)[2]).toBeCloseTo(-1, 6);
  }
}

/** Signed area of a contour's polygon in cap heights squared (positive = counter-clockwise). */
function signedArea(contour: FontContour): number {
  const polygon = flattenContour(contour, unit)!;
  let twice = 0;
  polygon.forEach(([x, y], i) => {
    const [nx, ny] = polygon[(i + 1) % polygon.length];
    twice += x * ny - nx * y;
  });
  return twice / 2;
}

/** A font with one glyph "x" made of the given contours. */
function fontOf(contours: FontContour[], advance = 1000): FontOutline {
  return { ...arial, capHeight: 1000, glyphs: [{ char: 'x', advance, contours }], missing: [], kerning: [] };
}

const square = (x: number, y: number, side: number, clockwise = false): FontContour => {
  const corners = [x, y, x + side, y, x + side, y + side, x, y + side];
  const coords = clockwise ? [0, 3, 2, 1].flatMap((i) => [corners[i * 2], corners[i * 2 + 1]]) : corners;
  return { ops: 'MLLL', coords };
};

const reversed = (contour: FontContour): FontContour => {
  // Only for polygons made of lines.
  const points: number[][] = [];
  for (let i = 0; i < contour.coords.length; i += 2) points.push([contour.coords[i], contour.coords[i + 1]]);
  return { ops: contour.ops, coords: points.reverse().flat() };
};

describe('glyph solids from font outlines', () => {
  it.each([...arialChars].filter((char) => char !== ' '))('"%s" is a watertight solid', (char) => {
    const { mesh, skipped } = createOutlineText(char, arial, { size: 1, depth: 0.2, align: 'left' });
    expect(skipped).toEqual([]);
    expectSolid(mesh, 0.2);
  });

  it('cuts the holes out: the area of a letter is its outer contour minus its counters', () => {
    for (const [char, holes] of [['O', 1], ['A', 1], ['B', 2], ['8', 2], ['e', 1], ['H', 0]] as const) {
      const areas = glyph(char).contours.map(signedArea);
      // TrueType: the outer contour runs clockwise, the counters against it.
      expect(areas.filter((a) => a > 0), char).toHaveLength(holes);
      const expected = Math.abs(areas.reduce((sum, a) => sum + a, 0));
      const { mesh } = createOutlineText(char, arial, { size: 1, depth: 0.5 });
      expect(volume(mesh) / 0.5, char).toBeCloseTo(expected, 5);
      expect(expected, char).toBeLessThan(Math.max(...areas.map(Math.abs)) + 1e-9);
      expect(pieces(mesh), char).toBe(1);
    }
  });

  it('keeps separate parts of a glyph as separate solids', () => {
    const { mesh } = createOutlineText('i', arial);
    expect(pieces(mesh)).toBe(2);
    expectSolid(mesh, 0.1);
    expect(volume(mesh) / 0.1).toBeCloseTo(glyph('i').contours.map(signedArea).reduce((sum, a) => sum + Math.abs(a), 0), 5);
  });

  it('fills the same shape whichever way round the font draws its contours', () => {
    const ring = [square(0, 0, 1000, true), square(250, 250, 500)];
    const truetype = createOutlineText('x', fontOf(ring), { depth: 1 }).mesh;
    const postscript = createOutlineText('x', fontOf(ring.map(reversed)), { depth: 1 }).mesh;
    expect(volume(truetype)).toBeCloseTo(0.75, 6);
    expect(volume(postscript)).toBeCloseTo(0.75, 6);
    expectSolid(truetype, 1);
    expectSolid(postscript, 1);
    // Hole listed before its outer contour.
    expect(volume(createOutlineText('x', fontOf([...ring].reverse()), { depth: 1 }).mesh)).toBeCloseTo(0.75, 6);
  });

  it('merges contours that overlap in the same direction instead of cutting them out of each other', () => {
    // Two strokes of a composed glyph crossing: 1000 x 200 and 200 x 1000, sharing 200 x 200.
    const bar = (x: number, y: number, w: number, h: number): FontContour => ({ ops: 'MLLL', coords: [x, y, x, y + h, x + w, y + h, x + w, y] });
    const cross = [bar(0, 400, 1000, 200), bar(400, 0, 200, 1000)];
    const { mesh } = createOutlineText('x', fontOf(cross), { depth: 1 });
    expect(volume(mesh)).toBeCloseTo(0.2 + 0.2 - 0.04, 6);
    expect(pieces(mesh)).toBe(1);
    expectSolid(mesh, 1);
    // A contour running the other way inside one of the strokes is still a hole.
    const withHole = createOutlineText('x', fontOf([...cross, square(100, 450, 100)]), { depth: 1 }).mesh;
    expect(volume(withHole)).toBeCloseTo(0.36 - 0.01, 6);
  });

  it('turns quadratic and cubic curves into polygons that stay close to the curve', () => {
    // A circle of radius 500 around (500, 500) from four cubic Beziers (PostScript outlines).
    const k = 500 * 0.5522847498;
    const cubic: FontContour = {
      ops: 'MCCCC',
      coords: [1000, 500, 1000, 500 + k, 500 + k, 1000, 500, 1000, 500 - k, 1000, 0, 500 + k, 0, 500, 0, 500 - k, 500 - k, 0, 500, 0, 500 + k, 0, 1000, 500 - k, 1000, 500],
    };
    const polygon = flattenContour(cubic, 0.001)!;
    expect(polygon.length).toBeGreaterThanOrEqual(24);
    expect(polygon.length).toBeLessThanOrEqual(64);
    for (const [x, y] of polygon) expect(Math.hypot(x - 0.5, y - 0.5)).toBeCloseTo(0.5, 3);
    const disc = createOutlineText('x', fontOf([cubic]), { depth: 1 }).mesh;
    expect(volume(disc)).toBeGreaterThan(Math.PI * 0.25 * 0.99);
    expect(volume(disc)).toBeLessThan(Math.PI * 0.25);
    expectSolid(disc, 1);

    // The same circle, roughly, from four quadratic Beziers (TrueType outlines).
    const quadratic: FontContour = { ops: 'MQQQQ', coords: [1000, 500, 1000, 1000, 500, 1000, 0, 1000, 0, 500, 0, 0, 500, 0, 1000, 0, 1000, 500] };
    const rounded = flattenContour(quadratic, 0.001)!;
    expect(rounded.length).toBeGreaterThanOrEqual(24);
    // Every point is on its curve: between the circle and the square around it.
    for (const [x, y] of rounded) expect(Math.hypot(x - 0.5, y - 0.5)).toBeGreaterThan(0.499);
    // Straight outlines get no extra points.
    expect(flattenContour(square(0, 0, 1000), 0.001)).toHaveLength(4);
  });

  it('ignores malformed contours and refuses fonts without metrics', () => {
    const good = square(0, 0, 1000);
    const bad: FontContour[] = [
      { ops: 'LLL', coords: [0, 0, 1, 0, 1, 1] },
      { ops: 'MLL', coords: [0, 0, 1, 0] },
      { ops: 'MLX', coords: [0, 0, 1, 0, 1, 1] },
      { ops: 'MLML', coords: [0, 0, 1, 0, 1, 1, 0, 1] },
      { ops: 'MLL', coords: [0, 0, Number.NaN, 0, 1, 1] },
      { ops: 'ML', coords: [0, 0, 500, 500] },
      { ops: 'MLLL', coords: [5, 5, 5, 5, 5, 5, 5, 5] },
    ];
    for (const contour of bad) expect(flattenContour(contour, 1)).toBeNull();
    expect(volume(createOutlineText('x', fontOf([...bad, good]), { depth: 1 }).mesh)).toBeCloseTo(1, 6);
    expect(createOutlineText('x', fontOf(bad)).mesh.faces).toHaveLength(0);
    expect(() => createOutlineText('x', { ...arial, capHeight: 0 })).toThrow(/no usable metrics/);
    expect(() => createOutlineText('x', { ...arial, capHeight: Number.NaN })).toThrow(/no usable metrics/);
  });
});

describe('text layout with a font', () => {
  it('makes flat capital letters exactly as tall as the size, standing on the baseline', () => {
    for (const char of 'HBTL') {
      const b = box(createOutlineText(char, arial, { size: 2 }).mesh);
      expect(b.min[1], char).toBeCloseTo(0, 6);
      expect(b.max[1], char).toBeCloseTo(2, 6);
    }
    // Round letters overshoot a little, descenders go below the baseline: the font's own proportions.
    const o = box(createOutlineText('O', arial, { size: 2 }).mesh);
    expect(o.max[1]).toBeGreaterThan(2);
    expect(o.max[1]).toBeLessThan(2.06);
    expect(o.min[1]).toBeLessThan(0);
    expect(box(createOutlineText('g', arial, { size: 2 }).mesh).min[1]).toBeCloseTo(2 * -431 * unit, 2);
  });

  it('extrudes from z = 0 to the depth', () => {
    const b = box(createOutlineText('Tessel', arial, { size: 0.3, depth: 0.02 }).mesh);
    expect(b.min[2]).toBe(0);
    expect(b.max[2]).toBe(0.02);
    const defaults = box(createOutlineText('H', arial).mesh);
    expect(defaults.max[1]).toBeCloseTo(1, 6);
    expect(defaults.max[2]).toBe(0.1);
  });

  it('places lines by their advance width: left, centre, right', () => {
    const size = 2;
    const width = (glyph('H').advance + glyph('B').advance) * unit * size;
    const left = box(createOutlineText('HB', arial, { size, align: 'left' }).mesh);
    const center = box(createOutlineText('HB', arial, { size, align: 'center' }).mesh);
    const right = box(createOutlineText('HB', arial, { size, align: 'right' }).mesh);
    const fallback = box(createOutlineText('HB', arial, { size }).mesh);
    // The ink of "H" starts at its left side bearing.
    const bearing = Math.min(...glyph('H').contours[0].coords.filter((_, i) => i % 2 === 0));
    expect(left.min[0]).toBeCloseTo(bearing * unit * size, 5);
    expect(left.min[0]).toBeGreaterThan(0);
    expect(left.min[0] - center.min[0]).toBeCloseTo(width / 2, 5);
    expect(left.min[0] - right.min[0]).toBeCloseTo(width, 5);
    expect(right.max[0]).toBeLessThan(0);
    expect(fallback).toEqual(center);
    // Blanks at the ends count: they are part of the line.
    const padded = box(createOutlineText(' H', arial, { size, align: 'left' }).mesh);
    expect(padded.min[0] - box(createOutlineText('H', arial, { size, align: 'left' }).mesh).min[0]).toBeCloseTo(glyph(' ').advance * unit * size, 5);
  });

  it('applies pair kerning between directly adjacent letters', () => {
    const plain: FontOutline = { ...arial, kerning: [] };
    const kerned = box(createOutlineText('AV', arial, { align: 'left' }).mesh);
    const loose = box(createOutlineText('AV', plain, { align: 'left' }).mesh);
    expect(arial.kerning).toContainEqual({ left: 'A', right: 'V', value: -152 });
    expect(loose.max[0] - kerned.max[0]).toBeCloseTo(152 * unit, 6);
    expect(kerned.min[0]).toBeCloseTo(loose.min[0], 6);
    // Kerning adds up along the line and counts for its width.
    const ava = box(createOutlineText('AVA', arial, { align: 'right' }).mesh);
    const avaLoose = box(createOutlineText('AVA', plain, { align: 'right' }).mesh);
    expect(ava.min[0] - avaLoose.min[0]).toBeCloseTo(2 * 152 * unit, 6);
    // "HB" has no kerning pair.
    expect(box(createOutlineText('HB', arial).mesh)).toEqual(box(createOutlineText('HB', plain).mesh));
    // A character that is left out separates its neighbours.
    const apart = createOutlineText('A☃V', arial, { align: 'left' });
    expect(apart.skipped).toEqual(['☃']);
    expect(box(apart.mesh)).toEqual(loose);
  });

  it('sets several lines at the font line distance, each aligned on its own', () => {
    const pitch = (1854 + 434 + 67) * unit;
    expect(outlineLineHeight(arial)).toBeCloseTo(pitch, 9);
    const size = 0.5;
    const one = box(createOutlineText('H', arial, { size }).mesh);
    const two = box(createOutlineText('H\nH', arial, { size }).mesh);
    const three = box(createOutlineText('H\r\nHTL\rH', arial, { size }).mesh);
    expect(two.max[1]).toBeCloseTo(size, 6);
    expect(two.min[1]).toBeCloseTo(-pitch * size, 6);
    expect(three.min[1]).toBeCloseTo(-2 * pitch * size, 6);
    expect(two.min[0]).toBeCloseTo(one.min[0], 6);
    // The long middle line is centred as well, so the block is wider on both sides.
    expect(three.min[0]).toBeLessThan(one.min[0]);
    expect(three.max[0]).toBeGreaterThan(one.max[0]);
    // An empty line keeps its place.
    expect(box(createOutlineText('H\n\nH', arial, { size }).mesh).min[1]).toBeCloseTo(-2 * pitch * size, 6);
    expectSolid(createOutlineText('He\nTo', arial, { depth: 0.1 }).mesh, 0.1);
    // Fonts without usable line metrics fall back to 1.2 em.
    expect(outlineLineHeight({ ...arial, ascender: 0, descender: 0, lineGap: 0 })).toBeCloseTo((1.2 * 2048) / 1466, 9);
  });

  it('leaves out characters without a glyph and reports each once', () => {
    const { mesh, skipped } = createOutlineText('T☃e☃ ✓', arial);
    expect(skipped).toEqual(['☃', '✓']);
    expectSolid(mesh, 0.1);
    const nothing = createOutlineText('☃', arial);
    expect(nothing.mesh.faces).toHaveLength(0);
    expect(nothing.skipped).toEqual(['☃']);
    expect(createOutlineText('  ', arial)).toEqual({ mesh: { positions: [], faces: [] }, skipped: [] });
  });

  it('keeps a typical word at a reasonable polygon count', () => {
    const { mesh } = createOutlineText('Tessel', arial, { size: 1, depth: 0.1 });
    expect(pieces(mesh)).toBe(6);
    expect(mesh.faces.length).toBeGreaterThan(300);
    expect(mesh.faces.length).toBeLessThan(2500);
    // Round letters stay round: "O" gets enough corners along its outer contour.
    const o = createOutlineText('O', arial).mesh;
    expect(o.positions.length / 3).toBeGreaterThan(80);
    expect(o.positions.length / 3).toBeLessThan(400);
  });
});
