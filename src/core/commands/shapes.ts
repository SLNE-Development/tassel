import { z } from 'zod';
import { createOutlineText } from '../mesh/outlineText';
import { boundingBox } from '../mesh/polymesh';
import { createText, LINE_HEIGHT, textAlignments, type TextResult } from '../mesh/text';
import { createTube } from '../mesh/tube';
import { initManifold } from '../modifiers/boolean';
import { resolveGroupId, resolveMaterialId } from '../refs';
import { newId, uniqueName } from '../state';
import type { PolyMesh, SceneObject, Transform } from '../types';
import { defineCommand, docState, updateDocState, vec3, type CommandContext } from './registry';
import { boundsResult } from './results';

const finiteVec3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);

const placement = {
  name: z.string().min(1).optional(),
  groupId: z.string().nullable().default(null).describe('Group (id or name) to add the object to. Default: top level.'),
  materialId: z.string().nullable().default(null).describe('Material (id or name) of the object. Default: none.'),
};

/** Adds the object to the active document and makes it the selection, like scene.add_primitive. */
function addObject(
  ctx: CommandContext,
  p: { name?: string; groupId: string | null; materialId: string | null },
  defaultName: string,
  mesh: PolyMesh,
  transform: Transform,
  smooth: boolean,
): SceneObject {
  const state = docState(ctx);
  const obj: SceneObject = {
    id: newId(),
    name: uniqueName(
      Object.values(state.objects).map((o) => o.name),
      p.name ?? defaultName,
    ),
    visible: true,
    transform,
    mesh,
    modifiers: [],
    smooth,
    groupId: p.groupId === null ? null : resolveGroupId(state, p.groupId),
    materialId: p.materialId === null ? null : resolveMaterialId(state, p.materialId),
  };
  updateDocState(ctx, (s) => ({
    ...s,
    objects: { ...s.objects, [obj.id]: obj },
    order: [...s.order, obj.id],
    selection: [obj.id],
    activeId: obj.id,
    edit: null,
  }));
  return obj;
}

export const shapeCommands = [
  defineCommand({
    id: 'scene.add_tube',
    title: 'Rohr hinzufügen',
    description:
      'Add a round tube that follows a polyline, as one new object, and select it: a rod, strut, pipe, rail or cable. With 2 points it is a cylinder from the first point to the second, so no rotation angles have to be worked out. points are WORLD positions in meters (Y is up); the tube passes exactly through them (its centre line). The new object\'s origin is placed at the first point, with no rotation and scale 1. The cross-section is carried along the path without twisting; corners are mitred, so every straight piece keeps the exact radius (for a rounded bend pass several points along the curve). closed joins the last point back to the first (a ring, no caps). caps closes the two ends of an open tube; with caps false an open tube is a hollow shell and not a closed solid. Fails if fewer than 2 different points remain after dropping repeated ones, or if the path reverses by 180 degrees in one point. Returns the id, name and transform of the new object, its world-space bounds { min, max, center, size }, the length of the centre line, and the vertex and face counts.',
    params: z.object({
      points: z.array(finiteVec3).min(2).max(2000).describe('Centre line of the tube: world positions [x, y, z] in meters, at least 2.'),
      radius: z.number().positive().finite().optional().describe('Radius of the tube in meters. Required unless radii is given.'),
      radii: z
        .array(z.number().positive().finite())
        .max(2000)
        .optional()
        .describe('Radius per point in meters (same length as points), for tapered tubes. Overrides radius.'),
      segments: z.number().int().min(3).max(128).default(12).describe('Sides of the round cross-section (default 12; 6-8 is enough for thin rods).'),
      closed: z.boolean().default(false).describe('Join the last point to the first (needs at least 3 points). A closed tube has no caps.'),
      caps: z.boolean().default(true).describe('Close both ends of an open tube with a flat cap.'),
      smooth: z.boolean().default(true).describe('Smooth shading (rounded look). false shows the flat sides.'),
      ...placement,
    }),
    run(ctx, p) {
      if (p.radius === undefined && !p.radii) throw new Error('Give radius (one value in meters) or radii (one value per point)');
      const origin = p.points[0];
      const local = p.points.map((q): [number, number, number] => [q[0] - origin[0], q[1] - origin[1], q[2] - origin[2]]);
      const mesh = createTube(local, { radius: p.radius, radii: p.radii, segments: p.segments, closed: p.closed, caps: p.caps });
      let length = 0;
      for (let i = 1; i < local.length + (p.closed ? 1 : 0); i++) {
        const [a, b] = [local[i - 1], local[i % local.length]];
        length += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      }
      const obj = addObject(ctx, p, 'Rohr', mesh, { position: origin, rotation: [0, 0, 0], scale: [1, 1, 1] }, p.smooth);
      return {
        id: obj.id,
        name: obj.name,
        transform: obj.transform,
        bounds: boundsResult(docState(ctx), [obj.id]),
        length,
        vertices: mesh.positions.length / 3,
        faces: mesh.faces.length,
      };
    },
  }),

  defineCommand({
    id: 'scene.add_text',
    title: 'Text hinzufügen',
    description:
      `Add extruded 3D text for signs and labels as one new mesh object and select it. In the object's local space the text stands upright in the XY plane: it reads left to right along +X, up is +Y, and it faces +Z (readable from the +Z side); the baseline of the first line is y = 0, the back of the letters is z = 0 and the front z = depth. align places every line relative to local x = 0: "center" (default) centres it there, "left" starts there, "right" ends there. size is the cap height in meters: capital letters are that tall. Use \\n for several lines. position / rotation (Euler XYZ degrees) / scale place the object; to put text on a wall facing +X, rotate it by [0, 90, 0].

font chooses the typeface. "default" (or leaving it out) is the built-in font, which always exists: a rounded single-stroke sans with A-Z, a-z, 0-9, common punctuation, the German umlauts and sharp s, the euro and degree signs; its lower-case letters without ascender are 0.7 of size, descenders (g, p, y) reach 0.3 below the baseline, each further line is ${LINE_HEIGHT.toFixed(2)} x size below the previous one, and a line is as wide as its ink; bold and italic do nothing for it. Any other value is the family name of a font INSTALLED ON THIS COMPUTER, e.g. "Arial", "Segoe UI", "Times New Roman" (case does not matter; font_list lists what is installed; only available in the desktop app). bold and italic pick that style of the family; if the family does not have it, the closest style it has is used and reported, never a faked one. With an installed font the letters are the font's own outlines (curves become polygons fine enough to look round), capital letters are size tall, everything else has the font's proportions, letters are spaced by the font's advance widths and pair kerning (a line is as wide as its advances, so the ink can start slightly right of the alignment point), and lines are the font's own line distance apart. Text is set one character per glyph from left to right: no ligatures, no contextual shaping (Arabic, Indic scripts and emoji sequences do not come out right), no right-to-left text; colour fonts give their plain outlines.

Characters the font has no glyph for are left out and listed in "skipped". Fails if no character of the text has a glyph, if the family is not installed (the message names similar families), or if an installed font is asked for outside the desktop app. Returns the id, name and transform of the new object, its world-space bounds { min, max, center, size }, "localBounds" { min, max } (the box of the text in its own space, before position / rotation / scale: its width is max[0] - min[0]), font { family, style, weight } (what was actually used; style is regular, bold, italic or bold-italic), skipped, and the vertex and face counts. Every letter is a closed solid made of triangles.`,
    params: z.object({
      text: z.string().min(1).max(500).describe('The text, at most 500 characters. \\n starts a new line.'),
      size: z.number().positive().finite().default(1).describe('Cap height in meters (height of a capital letter).'),
      depth: z.number().positive().finite().default(0.1).describe('Thickness of the letters along local Z in meters.'),
      font: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .default('default')
        .describe('"default" = the built-in font, or the family name of an installed font such as "Arial" (see font_list).'),
      bold: z.boolean().default(false).describe('Bold style of an installed font. Ignored by the built-in font.'),
      italic: z.boolean().default(false).describe('Italic style of an installed font. Ignored by the built-in font.'),
      align: z.enum(textAlignments).default('center').describe('Horizontal placement of each line relative to local x = 0.'),
      position: vec3.default([0, 0, 0]).describe('World position of the object origin (baseline of the first line, at the alignment point).'),
      rotation: vec3.default([0, 0, 0]).describe('Euler XYZ in degrees'),
      scale: vec3.default([1, 1, 1]),
      ...placement,
    }),
    async run(ctx, p) {
      await initManifold();
      let built: TextResult;
      let font: { family: string; style: string; weight: number };
      if (p.font.toLowerCase() === 'default') {
        built = createText(p.text, p);
        font = { family: 'default', style: 'regular', weight: 400 };
      } else {
        const fonts = ctx.services.fonts;
        if (!fonts) {
          throw new Error(
            `The font ${JSON.stringify(p.font)} cannot be used: system fonts are only available in the desktop app. Use font "default" (the built-in font).`,
          );
        }
        // The same text the generator lays out: composed characters, line feeds as the only line breaks.
        const text = p.text.normalize('NFC').replace(/\r\n?/g, '\n');
        const outline = await fonts.outline({ family: p.font, bold: p.bold, italic: p.italic, text });
        built = createOutlineText(text, outline, p);
        font = { family: outline.family, style: outline.style.style, weight: outline.style.weight };
      }
      const { mesh, skipped } = built;
      if (mesh.faces.length === 0) {
        throw new Error(
          skipped.length > 0
            ? `None of the characters has a glyph in ${font.family === 'default' ? 'the built-in font' : `the font "${font.family}"`} (skipped: ${JSON.stringify(skipped.join(''))})`
            : 'The text contains only spaces',
        );
      }
      const name = p.text.replace(/\s+/g, ' ').trim().slice(0, 40) || 'Text';
      const obj = addObject(ctx, p, name, mesh, { position: p.position, rotation: p.rotation, scale: p.scale }, false);
      return {
        id: obj.id,
        name: obj.name,
        transform: obj.transform,
        bounds: boundsResult(docState(ctx), [obj.id]),
        localBounds: boundingBox(mesh),
        font,
        skipped,
        vertices: mesh.positions.length / 3,
        faces: mesh.faces.length,
      };
    },
  }),
];
