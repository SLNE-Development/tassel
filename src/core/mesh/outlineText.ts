import { manifoldModule } from '../modifiers/boolean';
import type { FontContour, FontOutline } from '../types';
import type { TextOptions, TextResult } from './text';

/** Largest distance between a curve of a glyph and the polygon that stands for it, as a share of the cap height. */
const CURVE_TOLERANCE = 0.002;
/** Most pieces one curve segment is cut into. */
const MAX_CURVE_STEPS = 24;

type Polygon = [number, number][];

/** A glyph extruded from z = 0 to z = 1; x and y in cap heights. */
interface GlyphMesh {
  positions: number[];
  faces: number[][];
}

/**
 * The contour as a polygon in cap heights (`scale` = 1 / cap height). Curves are cut into as many
 * equal steps as it takes to stay within the tolerance, so small glyph details get few points and
 * large bows many. Returns null for a contour that is malformed or encloses nothing.
 */
export function flattenContour(contour: FontContour, scale: number): Polygon | null {
  const { ops, coords } = contour;
  if (typeof ops !== 'string' || !Array.isArray(coords) || ops[0] !== 'M') return null;
  const points: Polygon = [];
  const add = (x: number, y: number) => {
    const last = points[points.length - 1];
    if (!last || Math.abs(last[0] - x) > 1e-9 || Math.abs(last[1] - y) > 1e-9) points.push([x, y]);
  };
  // Second difference of a curve's control points -> steps that keep the polygon within the tolerance.
  const steps = (bend: number, factor: number) => Math.min(MAX_CURVE_STEPS, Math.max(1, Math.ceil(Math.sqrt((factor * bend) / CURVE_TOLERANCE))));
  let at = 0;
  let [x0, y0] = [0, 0];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const count = op === 'M' || op === 'L' ? 2 : op === 'Q' ? 4 : op === 'C' ? 6 : 0;
    if (count === 0 || (op === 'M') !== (i === 0) || at + count > coords.length) return null;
    const c: number[] = [];
    for (let k = 0; k < count; k++) {
      const v = coords[at + k];
      if (typeof v !== 'number' || !Number.isFinite(v)) return null;
      c.push(v * scale);
    }
    at += count;
    if (op === 'Q') {
      const n = steps(Math.hypot(x0 - 2 * c[0] + c[2], y0 - 2 * c[1] + c[3]), 0.25);
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        const [a, b, d] = [(1 - t) * (1 - t), 2 * t * (1 - t), t * t];
        add(a * x0 + b * c[0] + d * c[2], a * y0 + b * c[1] + d * c[3]);
      }
    } else if (op === 'C') {
      const bend = Math.max(Math.hypot(x0 - 2 * c[0] + c[2], y0 - 2 * c[1] + c[3]), Math.hypot(c[0] - 2 * c[2] + c[4], c[1] - 2 * c[3] + c[5]));
      const n = steps(bend, 0.75);
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        const s = 1 - t;
        const [a, b, d, e] = [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t];
        add(a * x0 + b * c[0] + d * c[2] + e * c[4], a * y0 + b * c[1] + d * c[3] + e * c[5]);
      }
    } else {
      add(c[0], c[1]);
    }
    [x0, y0] = [c[count - 2], c[count - 1]];
  }
  // The contour closes itself; a repeated start point would be a zero-length edge.
  const [first, last] = [points[0], points[points.length - 1]];
  if (points.length > 1 && Math.abs(first[0] - last[0]) < 1e-9 && Math.abs(first[1] - last[1]) < 1e-9) points.pop();
  return points.length >= 3 ? points : null;
}

/**
 * The glyph's contours filled and extruded. The fill rule is "non-zero", as font rasterisers use: a
 * hole is a contour running against its surroundings, whichever way round the font draws its outer
 * contours (TrueType and PostScript outlines do it in opposite directions), and contours that overlap
 * in the same direction (variable fonts, composed CJK glyphs) merge instead of cancelling. The engine
 * returns a closed manifold per separate part of the glyph.
 */
function buildGlyph(contours: readonly FontContour[], scale: number): GlyphMesh {
  const mesh: GlyphMesh = { positions: [], faces: [] };
  const polygons = (Array.isArray(contours) ? contours : []).map((contour) => flattenContour(contour, scale)).filter((polygon) => polygon !== null);
  if (polygons.length === 0) return mesh;
  const m = manifoldModule();
  const outline = new m.CrossSection(polygons, 'NonZero');
  try {
    if (outline.isEmpty()) return mesh;
    const solid = outline.extrude(1);
    try {
      const out = solid.getMesh();
      for (let i = 0; i < out.vertProperties.length; i += out.numProp) {
        // The engine stores 32-bit floats; z is known exactly.
        mesh.positions.push(out.vertProperties[i], out.vertProperties[i + 1], out.vertProperties[i + 2] < 0.5 ? 0 : 1);
      }
      for (let i = 0; i < out.triVerts.length; i += 3) mesh.faces.push([out.triVerts[i], out.triVerts[i + 1], out.triVerts[i + 2]]);
    } finally {
      solid.delete();
    }
  } finally {
    outline.delete();
  }
  return mesh;
}

const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const finite = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

/** Baseline to baseline as a multiple of the cap height: the font's own line distance. */
export function outlineLineHeight(font: FontOutline): number {
  const pitch = finite(font.ascender, 0) - finite(font.descender, 0) + Math.max(0, finite(font.lineGap, 0));
  return (positive(pitch) ? pitch : 1.2 * font.unitsPerEm) / font.capHeight;
}

/**
 * Extruded text from the outlines of a font (`font` must cover the characters of `text`), laid out
 * like `createText`: standing in the XY plane, baseline of the first line at y = 0, back at z = 0,
 * front at z = depth, lines placed relative to x = 0 by `align`. Capital letters are `size` tall.
 * A line is as wide as its advance widths plus kerning; one character is one glyph, left to right.
 * Characters the font has no glyph for are left out and reported. Triangles only. Needs the geometry
 * engine (`initManifold()`) to be loaded.
 */
export function createOutlineText(text: string, font: FontOutline, options: TextOptions = {}): TextResult {
  const { size = 1, depth = 0.1, align = 'center' } = options;
  if (!positive(font.capHeight) || !positive(font.unitsPerEm)) throw new Error(`The font "${font.family}" has no usable metrics`);
  const scale = 1 / font.capHeight;
  const glyphs = new Map(font.glyphs.map((glyph) => [glyph.char, glyph]));
  const kerning = new Map(font.kerning.map((pair) => [`${pair.left}\n${pair.right}`, finite(pair.value, 0) * scale]));
  const pitch = outlineLineHeight(font);
  const meshes = new Map<string, GlyphMesh>();
  const skipped: string[] = [];
  const positions: number[] = [];
  const faces: number[][] = [];

  const lines = text.normalize('NFC').replace(/\r\n?/g, '\n').split('\n');
  lines.forEach((line, row) => {
    // Pen position of every glyph of the line, in cap heights from the start of the line.
    const placed: { char: string; x: number }[] = [];
    let pen = 0;
    let previous: string | null = null;
    for (const char of line) {
      const glyph = glyphs.get(char);
      if (!glyph) {
        if (!skipped.includes(char)) skipped.push(char);
        // A character that is left out separates its neighbours: no kerning across it.
        previous = null;
        continue;
      }
      if (previous !== null) pen += kerning.get(`${previous}\n${char}`) ?? 0;
      placed.push({ char, x: pen });
      pen += Math.max(0, finite(glyph.advance, 0)) * scale;
      previous = char;
    }
    const start = align === 'left' ? 0 : align === 'center' ? -pen / 2 : -pen;
    for (const { char, x } of placed) {
      let mesh = meshes.get(char);
      if (!mesh) {
        mesh = buildGlyph(glyphs.get(char)!.contours, scale);
        meshes.set(char, mesh);
      }
      const base = positions.length / 3;
      for (let p = 0; p < mesh.positions.length; p += 3) {
        positions.push((start + x + mesh.positions[p]) * size + 0, (mesh.positions[p + 1] - row * pitch) * size + 0, mesh.positions[p + 2] * depth);
      }
      for (const face of mesh.faces) faces.push(face.map((v) => v + base));
    }
  });
  return { mesh: { positions, faces }, skipped };
}
