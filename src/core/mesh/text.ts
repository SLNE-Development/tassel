import { manifoldModule } from '../modifiers/boolean';
import type { PolyMesh } from '../types';
import { CAP_HEIGHT, DOT_RADIUS, glyphs, LETTER_SPACING, LINE_PITCH, STROKE_RADIUS, type Glyph, type Point } from './strokeFont';

export const textAlignments = ['left', 'center', 'right'] as const;
export type TextAlign = (typeof textAlignments)[number];

export interface TextOptions {
  /** Cap height (height of "H") in meters. */
  size?: number;
  /** Thickness along Z in meters. */
  depth?: number;
  align?: TextAlign;
}

export interface TextResult {
  mesh: PolyMesh;
  /** Characters of the text the font has no glyph for, each once, in the order they occur. */
  skipped: string[];
}

/** Line distance (baseline to baseline) as a multiple of the cap height. */
export const LINE_HEIGHT = LINE_PITCH / (CAP_HEIGHT + 2 * STROKE_RADIUS);

/** A glyph extruded from z = 0 to z = 1, x and y in grid units of the font. */
interface GlyphMesh {
  positions: number[];
  faces: number[][];
}

const built = new Map<Glyph, GlyphMesh>();

/** Regular polygon around `c`. With a multiple of four corners its extent along x and y is exactly the radius. */
function circle(c: Point, radius: number, corners: number): [number, number][] {
  const out: [number, number][] = [];
  for (let k = 0; k < corners; k++) {
    const a = (k / corners) * Math.PI * 2;
    out.push([c[0] + radius * Math.cos(a), c[1] + radius * Math.sin(a)]);
  }
  return out;
}

/**
 * Thickens the centre lines of a glyph into its outline (every segment becomes a capsule, all of
 * them are united) and extrudes that. The engine guarantees a closed manifold; a glyph made of
 * several separate parts (i, %, ...) is one closed manifold per part.
 */
function buildGlyph(glyph: Glyph): GlyphMesh {
  let mesh = built.get(glyph);
  if (mesh) return mesh;
  const m = manifoldModule();
  const parts = [];
  for (const stroke of glyph.strokes) {
    if (stroke.length === 1) parts.push(new m.CrossSection([circle(stroke[0], DOT_RADIUS, 16)]));
    for (let i = 0; i + 1 < stroke.length; i++) {
      const [a, b] = [stroke[i], stroke[i + 1]];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9) continue;
      parts.push(m.CrossSection.hull([[...circle(a, STROKE_RADIUS, 12), ...circle(b, STROKE_RADIUS, 12)]]));
    }
  }
  mesh = { positions: [], faces: [] };
  if (parts.length > 0) {
    const outline = m.CrossSection.union(parts);
    const solid = outline.extrude(1);
    const out = solid.getMesh();
    for (let i = 0; i < out.vertProperties.length; i += out.numProp) {
      // The engine stores 32-bit floats; z is known exactly.
      mesh.positions.push(out.vertProperties[i], out.vertProperties[i + 1], out.vertProperties[i + 2] < 0.5 ? 0 : 1);
    }
    for (let i = 0; i < out.triVerts.length; i += 3) mesh.faces.push([out.triVerts[i], out.triVerts[i + 1], out.triVerts[i + 2]]);
    solid.delete();
    outline.delete();
    parts.forEach((part) => part.delete());
  }
  built.set(glyph, mesh);
  return mesh;
}

/**
 * Extruded text in the built-in font, standing in the XY plane: the baseline of the first line is
 * y = 0 (further lines follow below), the back is z = 0 and the front, which reads correctly seen
 * from +Z, is z = depth. `align` places the lines relative to x = 0: starting there, centred on it
 * or ending there. Triangles only. Needs the geometry engine (`initManifold()`) to be loaded.
 */
export function createText(text: string, options: TextOptions = {}): TextResult {
  const { size = 1, depth = 0.1, align = 'center' } = options;
  const unit = size / (CAP_HEIGHT + 2 * STROKE_RADIUS);
  const skipped: string[] = [];
  const positions: number[] = [];
  const faces: number[][] = [];

  const lines = text.normalize('NFC').replace(/\r\n?/g, '\n').split('\n');
  lines.forEach((line, row) => {
    const known: Glyph[] = [];
    for (const char of line) {
      const glyph = glyphs.get(char);
      if (glyph) known.push(glyph);
      else if (!skipped.includes(char)) skipped.push(char);
    }
    // In grid units; every glyph takes its centre lines plus the stroke on both sides.
    const widths = known.map((glyph) => glyph.width + 2 * STROKE_RADIUS);
    const width = widths.reduce((sum, w) => sum + w, 0) + LETTER_SPACING * Math.max(0, known.length - 1);
    let pen = align === 'left' ? 0 : align === 'center' ? -width / 2 : -width;
    known.forEach((glyph, i) => {
      const mesh = buildGlyph(glyph);
      const base = positions.length / 3;
      for (let p = 0; p < mesh.positions.length; p += 3) {
        positions.push(
          (pen + STROKE_RADIUS + mesh.positions[p]) * unit + 0,
          (STROKE_RADIUS + mesh.positions[p + 1] - row * LINE_PITCH) * unit + 0,
          mesh.positions[p + 2] * depth,
        );
      }
      for (const face of mesh.faces) faces.push(face.map((v) => v + base));
      pen += widths[i] + LETTER_SPACING;
    });
  });
  return { mesh: { positions, faces }, skipped };
}
