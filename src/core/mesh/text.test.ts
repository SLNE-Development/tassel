import { beforeAll, describe, expect, it } from 'vitest';
import { initManifold } from '../modifiers/boolean';
import { isClosedManifold, volume } from '../modifiers/testing';
import type { PolyMesh } from '../types';
import { boundingBox, faceNormal, polyMeshSchema } from './polymesh';
import { glyphs } from './strokeFont';
import { createText, LINE_HEIGHT } from './text';

beforeAll(() => initManifold());

const box = (mesh: PolyMesh) => boundingBox(mesh)!;

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

describe('built-in font', () => {
  it('has the printable ASCII characters and the German letters', () => {
    for (let code = 32; code < 127; code++) expect(glyphs.has(String.fromCharCode(code)), String.fromCharCode(code)).toBe(true);
    for (const char of 'ÄÖÜäöüß€°–') expect(glyphs.has(char), char).toBe(true);
  });

  it.each([...glyphs.keys()].filter((char) => char !== ' '))('"%s" is a watertight solid', (char) => {
    const { mesh, skipped } = createText(char, { size: 1, depth: 0.2, align: 'left' });
    expect(skipped).toEqual([]);
    expectSolid(mesh, 0.2);
    // Starts at the alignment point and stays within the line.
    expect(box(mesh).min[0]).toBeCloseTo(0, 1);
    expect(box(mesh).min[1]).toBeGreaterThan(-0.3);
    expect(box(mesh).max[1]).toBeLessThan(1.25);
  });

  it('capital letters and digits stand on the baseline and are exactly as tall as the size', () => {
    for (const char of 'ABCDEFGHIJKLMNOPRSTUVWXYZ0123456789') {
      const b = box(createText(char, { size: 2 }).mesh);
      expect(b.min[1], char).toBeCloseTo(0, 5);
      expect(b.max[1], char).toBeCloseTo(2, 5);
    }
    // Lower case: x-height, ascenders up to the cap height, descenders below the baseline.
    expect(box(createText('x').mesh).max[1]).toBeCloseTo(4.9 / 6.9, 5);
    expect(box(createText('b').mesh).max[1]).toBeCloseTo(1, 5);
    expect(box(createText('p').mesh).min[1]).toBeCloseTo(-2 / 6.9, 5);
  });
});

describe('createText', () => {
  it('"A": bounds follow size and depth, back at z = 0, front at z = depth', () => {
    const { mesh, skipped } = createText('A', { size: 2.5, depth: 0.3 });
    expect(skipped).toEqual([]);
    expectSolid(mesh, 0.3);
    expect(pieces(mesh)).toBe(1);
    const b = box(mesh);
    expect(b.min[1]).toBeCloseTo(0, 5);
    expect(b.max[1]).toBeCloseTo(2.5, 5);
    expect(b.min[2]).toBe(0);
    expect(b.max[2]).toBe(0.3);
    // Centred on x = 0; an A is 4.9 of 6.9 grid units wide.
    expect(b.max[0]).toBeCloseTo((2.5 * 4.9) / 6.9 / 2, 5);
    expect(b.min[0]).toBeCloseTo((-2.5 * 4.9) / 6.9 / 2, 5);
  });

  it('defaults: 1 m cap height, 0.1 m deep, centred', () => {
    const b = box(createText('H').mesh);
    expect(b.min.map((v) => +v.toFixed(5))).toEqual([+(-2.45 / 6.9).toFixed(5), 0, 0]);
    expect(b.max.map((v) => +v.toFixed(5))).toEqual([+(2.45 / 6.9).toFixed(5), 1, 0.1]);
  });

  it('"Tessel": one watertight solid per letter', () => {
    const { mesh, skipped } = createText('Tessel', { size: 0.5, depth: 0.05 });
    expect(skipped).toEqual([]);
    expectSolid(mesh, 0.05);
    expect(pieces(mesh)).toBe(6);
    const b = box(mesh);
    expect(b.min[1]).toBeCloseTo(0, 6);
    expect(b.max[1]).toBeCloseTo(0.5, 6);
    expect(b.min[0]).toBeCloseTo(-b.max[0], 6);
    // T 4, e 3, s 2.6, s 2.6, e 3, l 0 wide, plus the stroke around each letter and five gaps.
    expect(b.max[0] - b.min[0]).toBeCloseTo(((15.2 + 6 * 0.9 + 5) / 6.9) * 0.5, 5);
    // Letters with several parts are one solid per part.
    expect(pieces(createText('i').mesh)).toBe(2);
    expect(pieces(createText('%').mesh)).toBe(3);
    expect(pieces(createText('Ä:').mesh)).toBe(5);
  });

  it('scales with size and depth', () => {
    const one = createText('Tessel 3D', { size: 1, depth: 1 }).mesh;
    const big = createText('Tessel 3D', { size: 3, depth: 0.5 }).mesh;
    expect(big.faces).toEqual(one.faces);
    expect(volume(big)).toBeCloseTo(volume(one) * 9 * 0.5, 4);
    expectSolid(big, 0.5);
  });

  it('aligns every line relative to x = 0', () => {
    const text = 'Wide line\nI';
    const left = createText(text, { align: 'left' }).mesh;
    const center = createText(text, { align: 'center' }).mesh;
    const right = createText(text, { align: 'right' }).mesh;
    for (const mesh of [left, center, right]) expectSolid(mesh, 0.1);
    const width = box(left).max[0];
    expect(box(left).min[0]).toBeCloseTo(0, 6);
    expect(box(right).max[0]).toBeCloseTo(0, 6);
    expect(box(right).min[0]).toBeCloseTo(-width, 6);
    expect(box(center).min[0]).toBeCloseTo(-width / 2, 6);
    expect(box(center).max[0]).toBeCloseTo(width / 2, 6);
    // The short second line follows the same rule on its own.
    const second = (mesh: PolyMesh) => {
      const xs: number[] = [];
      for (let i = 0; i < mesh.positions.length; i += 3) if (mesh.positions[i + 1] < -0.2) xs.push(mesh.positions[i]);
      return [Math.min(...xs), Math.max(...xs)];
    };
    const stroke = 0.9 / 6.9;
    expect(second(left)[0]).toBeCloseTo(0, 6);
    expect(second(left)[1]).toBeCloseTo(stroke, 6);
    expect(second(center)[0]).toBeCloseTo(-stroke / 2, 6);
    expect(second(center)[1]).toBeCloseTo(stroke / 2, 6);
    expect(second(right)[0]).toBeCloseTo(-stroke, 6);
    expect(second(right)[1]).toBeCloseTo(0, 6);
  });

  it('puts each further line one line height below the previous one', () => {
    const size = 2;
    const { mesh } = createText('AB\nC\r\nD', { size });
    expectSolid(mesh, 0.1);
    expect(pieces(mesh)).toBe(4);
    const b = box(mesh);
    expect(b.max[1]).toBeCloseTo(size, 5);
    expect(b.min[1]).toBeCloseTo(-2 * LINE_HEIGHT * size, 4);
    expect(LINE_HEIGHT).toBeCloseTo(11 / 6.9, 12);
    // The second line alone, moved down.
    const c = createText('C', { size }).mesh;
    const ys = new Set(c.positions.filter((_, i) => i % 3 === 1).map((y) => +(y - LINE_HEIGHT * size).toFixed(6)));
    const inSecondLine = mesh.positions.filter((y, i) => i % 3 === 1 && y < -0.5 && y > -LINE_HEIGHT * size - 0.5);
    expect(inSecondLine.length).toBe(c.positions.length / 3);
    for (const y of inSecondLine) expect(ys.has(+y.toFixed(6))).toBe(true);
    // An empty line still takes its height.
    expect(box(createText('A\n\nA', { size }).mesh).min[1]).toBeCloseTo(-2 * LINE_HEIGHT * size, 5);
  });

  it('skips characters without a glyph and reports each of them once', () => {
    const { mesh, skipped } = createText('A☃B\tC☃ \u{1F600}', { align: 'left' });
    expect(skipped).toEqual(['☃', '\t', '\u{1F600}']);
    expect(mesh).toEqual(createText('ABC ', { align: 'left' }).mesh);
    expectSolid(mesh, 0.1);
    const nothing = createText('☃☃');
    expect(nothing.mesh.faces).toEqual([]);
    expect(nothing.skipped).toEqual(['☃']);
    // Names of Object.prototype members are just letters.
    expect(createText('constructor').skipped).toEqual([]);
    expect(createText('__proto__').skipped).toEqual([]);
  });

  it('spaces take room, and decomposed umlauts are found', () => {
    const width = (text: string) => box(createText(text, { align: 'left' }).mesh).max[0];
    expect(width('A A')).toBeCloseTo(width('AA') + (1.2 + 0.9 + 1) / 6.9, 6);
    expect(createText('Ä').mesh).toEqual(createText('Ä').mesh);
    expect(createText('Straße 5°').skipped).toEqual([]);
  });

  it('stays fast and sane at the length limit', () => {
    const text = 'The quick brown fox jumps over the lazy dog 0123456789. '.repeat(9).slice(0, 500);
    const { mesh } = createText(text, { size: 0.2, depth: 0.02 });
    expect(isClosedManifold(mesh)).toBe(true);
    expect(mesh.faces.length).toBeLessThan(150_000);
  });
});
