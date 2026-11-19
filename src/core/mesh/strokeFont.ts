// The built-in font of `scene.add_text`: a rounded single-stroke sans ("technical lettering"). Each
// glyph is a set of centre lines on a grid; `text.ts` thickens them into outlines of constant stroke
// width. Grid: baseline y = 0, x-height 4, cap height 6, descenders to -2; x starts at 0.

export type Point = readonly [number, number];
/** A polyline; a single point is a dot. */
export type Stroke = readonly Point[];

export interface Glyph {
  /** Width of the centre lines (the advance adds the stroke width and the letter spacing). */
  readonly width: number;
  readonly strokes: readonly Stroke[];
}

/** Half the stroke width, in grid units. */
export const STROKE_RADIUS = 0.45;
/** Radius of dots (period, i-dot, umlaut dots). */
export const DOT_RADIUS = 0.56;
export const CAP_HEIGHT = 6;
/** Free space between the outlines of neighbouring glyphs. */
export const LETTER_SPACING = 1;
/** Baseline to baseline, in grid units. */
export const LINE_PITCH = 11;

/** Points from a flat list x0, y0, x1, y1, ... */
function P(...flat: number[]): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
}

/**
 * Elliptical arc around (cx, cy) from angle `from` to `to` in degrees (0 = +x, 90 = +y). Besides its
 * two ends it has a point at every multiple of 22.5 degrees in between, so the left-, right-, top- and
 * bottommost points of a round shape are always part of it and glyphs are exactly as tall as intended.
 */
function A(cx: number, cy: number, rx: number, ry: number, from: number, to: number): Point[] {
  const STEP = 22.5;
  const angles = [from];
  const direction = Math.sign(to - from);
  // Multiples closer than 4 degrees to an end are left out, they would only add a tiny segment.
  for (let k = Math.ceil(Math.min(from, to) / STEP); k * STEP < Math.max(from, to); k++) {
    if (Math.abs(k * STEP - from) > 4 && Math.abs(k * STEP - to) > 4) angles.push(k * STEP);
  }
  angles.sort((a, b) => direction * (a - b));
  angles.push(to);
  return angles.map((angle): Point => {
    const a = (angle * Math.PI) / 180;
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
  });
}

const mirror = (width: number, strokes: Stroke[]): Stroke[] => strokes.map((s) => s.map(([x, y]): Point => [width - x, y]));
const turn = (width: number, strokes: Stroke[]): Stroke[] => strokes.map((s) => s.map(([x, y]): Point => [width - x, CAP_HEIGHT - y]));
const shift = (dx: number, strokes: Stroke[]): Stroke[] => strokes.map((s) => s.map(([x, y]): Point => [x + dx, y]));

// Shapes shared by several glyphs.
const capO = (w: number): Stroke => [...A(w / 2, 6 - w / 2, w / 2, w / 2, 0, 180), ...A(w / 2, w / 2, w / 2, w / 2, 180, 360), [w, 6 - w / 2]];
const capC: Stroke = [...A(2, 4, 2, 2, 25, 180), ...A(2, 2, 2, 2, 180, 335)];
const capS: Stroke = [...A(2, 4.5, 2, 1.5, 30, 270), ...A(2, 1.5, 2, 1.5, 90, -150)];
const capP: Stroke[] = [P(0, 0, 0, 6), [...P(0, 6, 2.5, 6), ...A(2.5, 4.5, 1.5, 1.5, 90, -90), ...P(0, 3)]];
const capU: Stroke = [...P(0, 6, 0, 2), ...A(2, 2, 2, 2, 180, 360), ...P(4, 6)];
const capA: Stroke[] = [P(0, 0, 2, 6, 4, 0), P(0.67, 2, 3.33, 2)];
const bowl: Stroke = A(1.5, 2, 1.5, 2, 0, 360);
const lowU: Stroke[] = [[...P(0, 4, 0, 1.5), ...A(1.5, 1.5, 1.5, 1.5, 180, 360), ...P(3, 4)], P(3, 4, 3, 0)];
const six: Stroke[] = [[...A(1.75, 4.25, 1.75, 1.75, 35, 180), ...P(0, 1.75), ...A(1.75, 1.75, 1.75, 1.75, 180, 540)]];
const dots = (y: number, ...xs: number[]): Stroke[] => xs.map((x) => P(x, y));
const paren: Stroke[] = [A(4.5, 2.5, 4.5, 4.5, 128, 232)];
const bracket: Stroke[] = [P(1.5, 6.5, 0, 6.5, 0, -1.5, 1.5, -1.5)];
const brace: Stroke[] = [P(2, 6.5, 1.3, 6.2, 1, 5.5, 1, 3.3, 0, 2.5, 1, 1.7, 1, -0.5, 1.3, -1.2, 2, -1.5)];
const comma: Stroke = P(0.35, 0.1, 0, -1.1);

const table: [string, number, Stroke[]][] = [
  [' ', 1.2, []],
  ['A', 4, capA],
  ['B', 4, [P(0, 0, 0, 6), [...P(0, 6, 2.3, 6), ...A(2.3, 4.5, 1.5, 1.5, 90, -90), ...P(0, 3)], [...P(0, 3, 2.5, 3), ...A(2.5, 1.5, 1.5, 1.5, 90, -90), ...P(0, 0)]]],
  ['C', 4, [capC]],
  ['D', 4, [[...P(0, 0, 0, 6, 1, 6), ...A(1, 3, 3, 3, 90, -90), ...P(0, 0)]]],
  ['E', 3.5, [P(3.5, 0, 0, 0, 0, 6, 3.5, 6), P(0, 3, 3, 3)]],
  ['F', 3.5, [P(0, 0, 0, 6, 3.5, 6), P(0, 3, 3, 3)]],
  ['G', 4, [[...A(2, 4, 2, 2, 25, 180), ...A(2, 2, 2, 2, 180, 360), ...P(4, 3, 2.2, 3)]]],
  ['H', 4, [P(0, 0, 0, 6), P(4, 0, 4, 6), P(0, 3, 4, 3)]],
  ['I', 0, [P(0, 0, 0, 6)]],
  ['J', 3, [[...P(3, 6, 3, 1.5), ...A(1.5, 1.5, 1.5, 1.5, 0, -180)]]],
  ['K', 4, [P(0, 0, 0, 6), P(4, 6, 0, 2.2), P(1.4, 3.5, 4, 0)]],
  ['L', 3.5, [P(0, 6, 0, 0, 3.5, 0)]],
  ['M', 5, [P(0, 0, 0, 6, 2.5, 1.5, 5, 6, 5, 0)]],
  ['N', 4, [P(0, 0, 0, 6, 4, 0, 4, 6)]],
  ['O', 4, [capO(4)]],
  ['P', 4, capP],
  ['Q', 4, [capO(4), P(2.5, 1.6, 4, 0)]],
  ['R', 4, [...capP, P(2, 3, 4, 0)]],
  ['S', 4, [capS]],
  ['T', 4, [P(0, 6, 4, 6), P(2, 6, 2, 0)]],
  ['U', 4, [capU]],
  ['V', 4, [P(0, 6, 2, 0, 4, 6)]],
  ['W', 6, [P(0, 6, 1.5, 0, 3, 4.5, 4.5, 0, 6, 6)]],
  ['X', 4, [P(0, 0, 4, 6), P(0, 6, 4, 0)]],
  ['Y', 4, [P(0, 6, 2, 3, 4, 6), P(2, 3, 2, 0)]],
  ['Z', 4, [P(0, 6, 4, 6, 0, 0, 4, 0)]],
  ['Ä', 4, [...capA, ...dots(7.3, 1.1, 2.9)]],
  ['Ö', 4, [capO(4), ...dots(7.3, 1.1, 2.9)]],
  ['Ü', 4, [capU, ...dots(7.3, 1.1, 2.9)]],

  ['a', 3, [bowl, P(3, 4, 3, 0)]],
  ['b', 3, [bowl, P(0, 6, 0, 0)]],
  ['c', 3, [A(1.5, 2, 1.5, 2, 45, 315)]],
  ['d', 3, [bowl, P(3, 6, 3, 0)]],
  ['e', 3, [[...P(0, 2, 3, 2), ...A(1.5, 2, 1.5, 2, 0, 315)]]],
  ['f', 2, [[...A(1.5, 5, 1, 1, 50, 180), ...P(0.5, 0)], P(0, 4, 1.7, 4)]],
  ['g', 3, [bowl, [...P(3, 4, 3, -0.5), ...A(1.5, -0.5, 1.5, 1.5, 0, -150)]]],
  ['h', 3, [P(0, 6, 0, 0), [...P(0, 2.5), ...A(1.5, 2.5, 1.5, 1.5, 180, 0), ...P(3, 0)]]],
  ['i', 0.22, [P(0.11, 4, 0.11, 0), ...dots(5.7, 0.11)]],
  ['j', 1.11, [[...P(1, 4, 1, -1), ...A(0, -1, 1, 1, 0, -90)], ...dots(5.7, 1)]],
  ['k', 3, [P(0, 6, 0, 0), P(2.8, 4, 0, 1.5), P(1.1, 2.5, 3, 0)]],
  ['l', 0, [P(0, 6, 0, 0)]],
  ['m', 5, [P(0, 4, 0, 0), [...P(0, 2.75), ...A(1.25, 2.75, 1.25, 1.25, 180, 0), ...P(2.5, 0)], [...P(2.5, 2.75), ...A(3.75, 2.75, 1.25, 1.25, 180, 0), ...P(5, 0)]]],
  ['n', 3, [P(0, 4, 0, 0), [...P(0, 2.5), ...A(1.5, 2.5, 1.5, 1.5, 180, 0), ...P(3, 0)]]],
  ['o', 3, [bowl]],
  ['p', 3, [bowl, P(0, 4, 0, -2)]],
  ['q', 3, [bowl, P(3, 4, 3, -2)]],
  ['r', 2.2, [P(0, 4, 0, 0), [...P(0, 2.5), ...A(1.5, 2.5, 1.5, 1.5, 180, 60)]]],
  ['s', 2.6, [[...A(1.3, 3, 1.3, 1, 30, 270), ...A(1.3, 1, 1.3, 1, 90, -150)]]],
  ['t', 2.2, [[...P(0.7, 6, 0.7, 1), ...A(1.7, 1, 1, 1, 180, 300)], P(0, 4, 2, 4)]],
  ['u', 3, lowU],
  ['v', 3, [P(0, 4, 1.5, 0, 3, 4)]],
  ['w', 4.5, [P(0, 4, 1.1, 0, 2.25, 3.2, 3.4, 0, 4.5, 4)]],
  ['x', 3, [P(0, 0, 3, 4), P(0, 4, 3, 0)]],
  ['y', 3, [P(0, 4, 1.5, 0), P(3, 4, 0.75, -2)]],
  ['z', 3, [P(0, 4, 3, 4, 0, 0, 3, 0)]],
  ['ä', 3, [bowl, P(3, 4, 3, 0), ...dots(5.7, 0.7, 2.3)]],
  ['ö', 3, [bowl, ...dots(5.7, 0.7, 2.3)]],
  ['ü', 3, [...lowU, ...dots(5.7, 0.7, 2.3)]],
  ['ß', 3.3, [[...P(0, 0, 0, 4.7), ...A(1.3, 4.7, 1.3, 1.3, 180, -60), ...A(1.6, 1.7, 1.7, 1.7, 100, -140)]]],

  ['0', 3.5, [capO(3.5)]],
  ['1', 2, [P(0, 4.5, 2, 6, 2, 0)]],
  ['2', 3.5, [[...A(1.75, 4.25, 1.75, 1.75, 170, -45), ...P(0, 0, 3.5, 0)]]],
  ['3', 3.5, [[...A(1.75, 4.5, 1.75, 1.5, 150, -90), ...A(1.75, 1.5, 1.75, 1.5, 90, -150)]]],
  ['4', 3.5, [P(2.75, 0, 2.75, 6, 0, 2, 3.5, 2)]],
  ['5', 3.5, [[...P(3.25, 6, 0.3, 6, 0, 3.4), ...A(1.75, 1.9, 1.75, 1.9, 125, -150)]]],
  ['6', 3.5, six],
  ['7', 3.5, [P(0, 6, 3.5, 6, 1.2, 0)]],
  ['8', 3.5, [A(1.75, 4.6, 1.4, 1.4, -90, 270), A(1.75, 1.6, 1.75, 1.6, 90, 450)]],
  ['9', 3.5, turn(3.5, six)],

  ['.', 0.22, dots(0.11, 0.11)],
  [',', 0.35, [comma]],
  [':', 0.22, [...dots(0.11, 0.11), ...dots(3.3, 0.11)]],
  [';', 0.35, [comma, ...dots(3.3, 0.24)]],
  ['!', 0.22, [P(0.11, 6, 0.11, 1.9), ...dots(0.11, 0.11)]],
  ['?', 3, [[...A(1.5, 4.5, 1.5, 1.5, 170, -60), ...P(1.5, 2.6, 1.5, 1.9)], ...dots(0.11, 1.5)]],
  ['-', 2.5, [P(0, 2.5, 2.5, 2.5)]],
  ['–', 4, [P(0, 2.5, 4, 2.5)]],
  ['_', 4, [P(0, -1, 4, -1)]],
  ['+', 4, [P(0, 3, 4, 3), P(2, 1, 2, 5)]],
  ['=', 4, [P(0, 2, 4, 2), P(0, 4, 4, 4)]],
  ['/', 3, [P(0, 0, 3, 6)]],
  ['\\', 3, [P(0, 6, 3, 0)]],
  ['|', 0, [P(0, -1.5, 0, 6.5)]],
  ['(', 1.73, paren],
  [')', 1.73, mirror(1.73, paren)],
  ['[', 1.5, bracket],
  [']', 1.5, mirror(1.5, bracket)],
  ['{', 2, brace],
  ['}', 2, mirror(2, brace)],
  ['<', 3.5, [P(3.5, 5, 0, 3, 3.5, 1)]],
  ['>', 3.5, [P(0, 5, 3.5, 3, 0, 1)]],
  ["'", 0, [P(0, 6, 0, 4.6)]],
  ['"', 1.4, [P(0, 6, 0, 4.6), P(1.4, 6, 1.4, 4.6)]],
  ['`', 1, [P(0, 6.2, 1, 5)]],
  ['^', 3, [P(0, 3.5, 1.5, 6, 3, 3.5)]],
  ['~', 4, [P(0, 2.5, 0.5, 3.2, 1.2, 3.4, 2, 3, 2.8, 2.6, 3.5, 2.8, 4, 3.5)]],
  ['*', 2.6, [P(1.3, 5.5, 1.3, 2.5), P(0, 4.75, 2.6, 3.25), P(0, 3.25, 2.6, 4.75)]],
  ['#', 4, [P(1.2, 0, 1.2, 6), P(2.8, 0, 2.8, 6), P(0, 2, 4, 2), P(0, 4, 4, 4)]],
  ['%', 4.5, [P(0.5, 0, 4, 6), A(1, 5, 1, 1, 0, 360), A(3.5, 1, 1, 1, 0, 360)]],
  ['&', 4, [[...P(4, 0), ...A(1.8, 4.8, 1.2, 1.2, 205, -25), ...A(1.9, 1.7, 1.9, 1.7, 160, 370)]]],
  ['@', 6, [A(3, 3, 1.2, 1.2, 0, 360), [...P(4.2, 4.2, 4.2, 2.4), ...A(5.1, 2.4, 0.9, 0.9, 180, 360), ...A(3, 3, 3, 3, 0, 300)]]],
  ['$', 4, [capS, P(2, -0.8, 2, 6.8)]],
  ['€', 4.6, [...shift(0.6, [capC]), P(0, 3.6, 3, 3.6), P(0, 2.4, 2.8, 2.4)]],
  ['°', 2, [A(1, 5, 1, 1, 0, 360)]],
];

export const glyphs: ReadonlyMap<string, Glyph> = new Map(table.map(([char, width, strokes]) => [char, { width, strokes }]));
