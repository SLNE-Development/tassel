import { isMinecraft } from '../formats';
import { z } from 'zod';
import { colorSchema } from '../materials';
import { faceRegions, frameCount, frameHeight, imageMirror, mirrorAxes, mirrorMaps, regionsAt } from '../minecraft/paintRegions';
import {
  brushShapes,
  copyBrushModes,
  pixelBlendModes,
  selectModes,
  transformedSize,
  type MirrorMap,
  type PixelOp,
  type PixelRect,
  type TextureTransform,
} from '../pixelOps';
import { own } from '../state';
import type { DocState, ImagingService, Texture } from '../types';
import { MAX_PAINT_SIZE, MAX_STROKE_POINTS, requirePaintable } from './paint';
import { defineCommand, docState, updateDocState, type CommandContext } from './registry';

// Pixel-art painting (Minecraft textures, but it works on any texture): every tool is one command and one
// undo step. Core describes the edit (core/pixelOps.ts); the imaging service computes the pixels with the
// same pure code the paint UI previews with (src/imaging/pixelArt).

function imagingOf(ctx: CommandContext): ImagingService {
  if (!ctx.services.imaging) throw new Error('The imaging service is not ready yet');
  return ctx.services.imaging;
}

/** The layer an edit goes to: the given one, else the top layer; null for a texture without layers (its image is edited). */
function resolveLayer(texture: Texture, layerId: string | undefined): string | null {
  const layers = texture.layers;
  if (!layers?.length) {
    if (layerId !== undefined) throw new Error(`Texture "${texture.name}" has no paint layers; leave layerId out to edit its image`);
    return null;
  }
  if (layerId === undefined) return layers[layers.length - 1].id;
  if (!layers.some((layer) => layer.id === layerId)) throw new Error(`Texture "${texture.name}" has no layer "${layerId}" (see paint.list_layers)`);
  return layerId;
}

/** Stores the edited texture unless the document changed it while the pixels were computed. */
function commit(ctx: CommandContext, before: Texture, after: Texture): void {
  if (own(docState(ctx).textures, before.id) !== before) {
    throw new Error(`Texture "${before.name}" was changed or removed while this command was working, so nothing was changed. Run one paint command at a time.`);
  }
  if (after !== before) updateDocState(ctx, (s) => ({ ...s, textures: { ...s.textures, [after.id]: after } }));
}

interface Target {
  textureId: string;
  layerId?: string;
}

/** Runs one pixel op on the target and stores the result. */
async function edit(ctx: CommandContext, p: Target, makeOp: (state: DocState, texture: Texture) => PixelOp | null) {
  const state = docState(ctx);
  const texture = requirePaintable(state, p.textureId);
  const layerId = resolveLayer(texture, p.layerId);
  const op = makeOp(state, texture);
  if (!op) return { textureId: texture.id, layerId, changed: false };
  const result = await imagingOf(ctx).pixelEdit(texture, layerId, op);
  if (!result.changed) return { textureId: texture.id, layerId, changed: false };
  const next: Texture =
    layerId === null
      ? { ...texture, mimeType: 'image/png', data: result.flattened }
      : { ...texture, data: result.flattened, layers: texture.layers!.map((layer) => (layer.id === layerId ? { ...layer, data: result.layer } : layer)) };
  commit(ctx, texture, next);
  return { textureId: texture.id, layerId, changed: true };
}

// ------------------------------------------------------------------ parameters

const textureId = z.string().describe('Texture id (see texture.list)');
const layerId = z.string().optional().describe('Layer id (paint.list_layers). Default: the top layer; textures without layers are edited directly.');
const coord = z.number().int().min(-100_000).max(100_000);
const px = z.tuple([coord, coord]).describe('[x, y] in texture pixels, y down (row 0 = top)');
const unit = z.number().min(0).max(1);
const tolerance = unit.default(0).describe('0 = exactly the same colour; up to 1 = any colour');
const frame = z.number().int().min(0).optional().describe('Animated textures: the frame (0 = top) whose face areas are meant. Default 0.');
const rectSchema = z.object({ x: coord, y: coord, width: z.number().int().min(0).max(MAX_PAINT_SIZE), height: z.number().int().min(0).max(MAX_PAINT_SIZE) });

const paintFields = {
  color: colorSchema('Paint colour').default('#000000'),
  opacity: unit.default(1),
  blend: z.enum(pixelBlendModes).default('default').describe(`How the paint mixes with the pixels: ${pixelBlendModes.join(', ')}`),
  lockAlpha: z.boolean().default(false).describe("Keep every pixel's alpha: transparent pixels stay transparent"),
  erase: z.boolean().default(false).describe('Remove alpha instead of painting'),
};

const mode = z.enum(selectModes).optional();
const selectionShape = z.discriminatedUnion('shape', [
  z.object({ shape: z.literal('rect'), x: coord, y: coord, width: z.number().int().min(0), height: z.number().int().min(0), mode }),
  z.object({ shape: z.literal('ellipse'), x: coord, y: coord, width: z.number().int().min(0), height: z.number().int().min(0), mode }),
  z.object({ shape: z.literal('lasso'), points: z.array(px).min(3).max(10_000), mode }),
  z.object({ shape: z.literal('wand'), x: coord, y: coord, tolerance, mode }),
  z.object({ shape: z.literal('color'), x: coord, y: coord, tolerance, mode }),
  z.object({ shape: z.literal('mask'), x: coord, y: coord, width: z.number().int().min(0), height: z.number().int().min(0), bits: z.string(), mode }),
]);
const selection = z
  .array(selectionShape)
  .max(256)
  .optional()
  .describe(
    `Limits the edit to selected pixels: shapes applied in order (mode ${selectModes.join(' | ')}, default replace). rect/ellipse: a pixel rectangle (ellipse inscribed); lasso: polygon through pixel corners; wand: connected pixels of similar colour around x,y; color: all pixels of similar colour; mask: base64 bits, one per pixel of the rectangle, rows padded to bytes, MSB first.`,
  );

const mirror = z
  .object({
    axes: z.array(z.enum(mirrorAxes)).max(2).default([]).describe('Minecraft models: mirror across the model X and/or Z axis'),
    mode: z.enum(['global', 'local']).default('global').describe("global: onto the mirror-image element across the model's centre; local: within each element"),
    image: z.boolean().default(false).describe('Mirror across the vertical centre line of the image (2D editor symmetry)'),
  })
  .optional();

const brushFields = {
  size: z.number().int().min(1).max(256).default(1).describe('Brush size in pixels'),
  shape: z.enum(brushShapes).default('square'),
};

/** Mirror painting settings as the pixel commands take them. */
export interface PixelMirror {
  readonly axes: readonly ('x' | 'z')[];
  readonly mode: 'global' | 'local';
  readonly image: boolean;
}

/** The mirror maps of the commands' `mirror` parameter (the paint UI previews with the same). */
export function pixelMirror(state: DocState, texture: Texture, m: PixelMirror | undefined, frameIndex = 0): MirrorMap[] | undefined {
  if (!m) return undefined;
  const maps: MirrorMap[] = [];
  if (m.axes.length > 0) {
    if (!isMinecraft(state)) throw new Error('Mirror painting across model axes needs a Minecraft Java document; use mirror.image for image symmetry');
    maps.push(...mirrorMaps(state, texture.id, m.axes, m.mode, frameIndex));
  }
  if (m.image) maps.push(imageMirror(texture, frameIndex));
  return maps.length > 0 ? maps : undefined;
}

function checkBreaks(breaks: readonly number[], count: number): void {
  breaks.forEach((at, i) => {
    if (at <= (i > 0 ? breaks[i - 1] : 0) || at >= count) {
      throw new Error(`breaks must be strictly increasing indices into points, each > 0 and < ${count} (the number of points): got ${at} at breaks[${i}]`);
    }
  });
}

const points = z.array(px).min(1, 'points is empty').max(MAX_STROKE_POINTS);
const breaks = z.array(z.number().int()).optional().describe('Indices into points at which a new, unconnected line starts');

const adjustment = z.discriminatedUnion('type', [
  z.object({ type: z.literal('brightness_contrast'), brightness: z.number().min(-1).max(1).default(0), contrast: z.number().min(-1).max(1).default(0) }),
  z.object({
    type: z.literal('hue_saturation'),
    hue: z.number().min(-180).max(180).default(0),
    saturation: z.number().min(-1).max(1).default(0),
    lightness: z.number().min(-1).max(1).default(0),
  }),
  z.object({ type: z.literal('opacity'), factor: z.number().min(0).max(4) }),
  z.object({ type: z.literal('invert') }),
  z.object({
    type: z.literal('curves'),
    rgb: z.array(z.tuple([unit, unit])).min(2).max(32).optional(),
    r: z.array(z.tuple([unit, unit])).min(2).max(32).optional(),
    g: z.array(z.tuple([unit, unit])).min(2).max(32).optional(),
    b: z.array(z.tuple([unit, unit])).min(2).max(32).optional(),
    a: z.array(z.tuple([unit, unit])).min(2).max(32).optional(),
  }),
  z.object({ type: z.literal('limit_palette'), colors: z.array(colorSchema('Palette colour')).min(1).max(1024) }),
]);

/** Stores a transformed texture (new image, layers, maybe a new size). */
async function transform(ctx: CommandContext, texture: Texture, t: TextureTransform, extra: Partial<Texture> = {}): Promise<Texture> {
  const size = transformedSize(texture.width, texture.height, t);
  if (size.width < 1 || size.height < 1 || size.width > MAX_PAINT_SIZE || size.height > MAX_PAINT_SIZE) {
    throw new Error(`The texture would be ${size.width} x ${size.height} pixels; sizes from 1 to ${MAX_PAINT_SIZE} are possible`);
  }
  const out = await imagingOf(ctx).transformTexture(texture, t);
  const next: Texture = {
    ...texture,
    ...extra,
    mimeType: 'image/png',
    data: out.data,
    width: out.width,
    height: out.height,
    ...(texture.layers && out.layers ? { layers: texture.layers.map((layer, i) => ({ ...layer, data: out.layers![i] })) } : {}),
  };
  // A strip that is no longer made of square frames cannot stay animated.
  const animated = next.animation && next.height % next.width === 0 ? next : (({ animation: _, ...rest }) => rest)(next);
  commit(ctx, texture, animated);
  return animated;
}

/** The `.mcmeta` text of an animated texture (null if it is not animated). */
export function mcmetaText(texture: Texture): string | null {
  if (!texture.animation) return null;
  const animation: Record<string, unknown> = { frametime: texture.animation.frametime };
  if (texture.animation.interpolate) animation.interpolate = true;
  return `${JSON.stringify({ animation }, null, 2)}\n`;
}

const fillModes = ['face', 'element', 'selected', 'connected', 'same_color', 'all'] as const;

export const pixelPaintCommands = [
  defineCommand({
    id: 'paint.pixel_stroke',
    title: 'Pixelpinsel',
    description: `Pixel brush: paint pixel-exact lines through points (texture pixels [x, y], y DOWN, row 0 = top; unlike paint.stroke there is no anti-aliasing). Consecutive points are joined by straight pixel lines; breaks start new, unconnected lines (still one undo step). The brush is a size x size square or a round disc; pixelPerfect (size 1) removes the L-shaped corners of drawn lines. Each pixel is painted once per call at opacity with the blend mode; lockAlpha keeps transparency, erase removes. mirror repeats the stroke mirrored (Minecraft: across model axes; image: across the image centre). selection limits it. Works on the image directly for textures without layers. Example: a red 1-pixel line { textureId, points: [[0,0],[15,15]], color: "#ff0000" }.`,
    params: z.object({ textureId, layerId, points, breaks, ...brushFields, pixelPerfect: z.boolean().default(false), ...paintFields, mirror, selection, frame }),
    run(ctx, p) {
      checkBreaks(p.breaks ?? [], p.points.length);
      return edit(ctx, p, (state, texture) => ({
        op: 'stroke',
        points: p.points,
        ...(p.breaks?.length ? { breaks: p.breaks } : {}),
        brush: { size: p.size, shape: p.shape },
        pixelPerfect: p.pixelPerfect,
        paint: { color: p.color, opacity: p.opacity, blend: p.blend, lockAlpha: p.lockAlpha, erase: p.erase },
        mirror: pixelMirror(state, texture, p.mirror, p.frame),
        selection: p.selection,
      }));
    },
  }),

  defineCommand({
    id: 'paint.pixel_fill',
    title: 'Füllen',
    description: `Paint bucket. mode: face (the UV area of the face under pixel x,y, or of elementId + face), element (all faces of the element(s) under x,y, or of elementId), selected (all faces of the selected elements), connected (the connected pixels of similar colour around x,y, within tolerance), same_color (every pixel of similar colour to x,y), all (the whole layer). face/element/selected need a Minecraft Java document and only cover faces that show this texture. Painted with the colour, opacity, blend mode, lockAlpha / erase; mirror and selection as in paint.pixel_stroke.`,
    params: z.object({
      textureId,
      layerId,
      mode: z.enum(fillModes).default('connected'),
      x: coord.optional(),
      y: coord.optional(),
      elementId: z.string().optional(),
      face: z.enum(['north', 'east', 'south', 'west', 'up', 'down']).optional(),
      tolerance,
      ...paintFields,
      mirror,
      selection,
      frame,
    }),
    run(ctx, p) {
      return edit(ctx, p, (state, texture): PixelOp | null => {
        const paint = { color: p.color, opacity: p.opacity, blend: p.blend, lockAlpha: p.lockAlpha, erase: p.erase };
        const common = { paint, mirror: pixelMirror(state, texture, p.mirror, p.frame), selection: p.selection };
        const needPoint = () => {
          if (p.x === undefined || p.y === undefined) throw new Error(`mode "${p.mode}" needs the pixel x, y`);
          return { x: p.x, y: p.y };
        };
        if (p.mode === 'all') return { op: 'fill', mode: 'all', ...common };
        if (p.mode === 'connected' || p.mode === 'same_color') return { op: 'fill', mode: p.mode, ...needPoint(), tolerance: p.tolerance, ...common };
        if (!isMinecraft(state)) throw new Error(`mode "${p.mode}" fills the faces of Minecraft elements; it needs a Minecraft Java document`);
        let regions: PixelRect[];
        if (p.mode === 'selected') {
          regions = faceRegions(state, texture.id, { elementIds: state.selection, frame: p.frame }).map((r) => r.rect);
        } else if (p.elementId !== undefined) {
          if (!own(state.objects, p.elementId)?.cuboid) throw new Error(`"${p.elementId}" is not an element of this model`);
          regions = faceRegions(state, texture.id, { elementIds: [p.elementId], frame: p.frame })
            .filter((r) => p.mode === 'element' || p.face === undefined || r.face === p.face)
            .map((r) => r.rect);
          if (p.mode === 'face' && p.face === undefined) throw new Error('mode "face" with elementId also needs face');
        } else {
          const { x, y } = needPoint();
          const hit = regionsAt(state, texture.id, x, y, p.frame);
          if (hit.length === 0) return null;
          regions =
            p.mode === 'face' ? [hit[0].rect] : faceRegions(state, texture.id, { elementIds: [hit[0].elementId], frame: p.frame }).map((r) => r.rect);
        }
        if (regions.length === 0) return null;
        return { op: 'fill', mode: 'regions', regions, ...common };
      });
    },
  }),

  defineCommand({
    id: 'paint.shape',
    title: 'Form zeichnen',
    description:
      'Draw a rectangle or ellipse spanning the pixels from..to (both included). filled, or hollow with an outline lineWidth pixels thick drawn inside the shape. Paint, mirror and selection as in paint.pixel_stroke.',
    params: z.object({
      textureId,
      layerId,
      shape: z.enum(['rectangle', 'ellipse']).default('rectangle'),
      from: px,
      to: px,
      filled: z.boolean().default(false),
      lineWidth: z.number().int().min(1).max(256).default(1),
      ...paintFields,
      mirror,
      selection,
      frame,
    }),
    run(ctx, p) {
      return edit(ctx, p, (state, texture) => ({
        op: 'shape',
        shape: p.shape,
        from: p.from,
        to: p.to,
        filled: p.filled,
        lineWidth: p.lineWidth,
        paint: { color: p.color, opacity: p.opacity, blend: p.blend, lockAlpha: p.lockAlpha, erase: p.erase },
        mirror: pixelMirror(state, texture, p.mirror, p.frame),
        selection: p.selection,
      }));
    },
  }),

  defineCommand({
    id: 'paint.gradient',
    title: 'Verlauf',
    description:
      'Linear gradient from colors[0] at pixel `from` to colors[1] at pixel `to`, constant beyond both ends, over the whole layer or the selection. opacity, blend and lockAlpha as in paint.pixel_stroke.',
    params: z.object({
      textureId,
      layerId,
      from: px,
      to: px,
      colors: z.tuple([colorSchema('Start colour'), colorSchema('End colour')]),
      opacity: paintFields.opacity,
      blend: paintFields.blend,
      lockAlpha: paintFields.lockAlpha,
      selection,
    }),
    run(ctx, p) {
      return edit(ctx, p, () => ({
        op: 'gradient',
        from: p.from,
        to: p.to,
        colors: p.colors,
        paint: { opacity: p.opacity, blend: p.blend, lockAlpha: p.lockAlpha },
        selection: p.selection,
      }));
    },
  }),

  defineCommand({
    id: 'paint.move_pixels',
    title: 'Auswahl verschieben',
    description:
      'Move the selected pixels by dx, dy (copy: true leaves the originals in place). Moved pixels are drawn over what is at the destination; a move leaves transparency behind. Pixels moved outside the image are lost.',
    params: z.object({
      textureId,
      layerId,
      selection: z.array(selectionShape).min(1).max(256),
      dx: coord,
      dy: coord,
      copy: z.boolean().default(false),
    }),
    run(ctx, p) {
      return edit(ctx, p, () => (p.dx === 0 && p.dy === 0 ? null : { op: 'move', selection: p.selection, dx: p.dx, dy: p.dy, copy: p.copy }));
    },
  }),

  defineCommand({
    id: 'paint.copy_brush',
    title: 'Kopierpinsel',
    description:
      "Copy brush: a pixel brush stroke whose colours come from the layer itself (as it was before). mode copy: every painted pixel takes the colour at +offset [dx, dy] (clone stamp); pattern: the source rectangle repeated over the image (aligned to its corner); sample: the source rectangle stamped centred on every point of the stroke. opacity, blend and lockAlpha as in paint.pixel_stroke.",
    params: z.object({
      textureId,
      layerId,
      mode: z.enum(copyBrushModes).default('copy'),
      points,
      breaks,
      ...brushFields,
      offset: px.optional(),
      source: rectSchema.optional(),
      opacity: paintFields.opacity,
      blend: paintFields.blend,
      lockAlpha: paintFields.lockAlpha,
      selection,
    }),
    run(ctx, p) {
      checkBreaks(p.breaks ?? [], p.points.length);
      if (p.mode === 'copy' && !p.offset) throw new Error('mode "copy" needs offset');
      if (p.mode !== 'copy' && (!p.source || p.source.width < 1 || p.source.height < 1)) throw new Error(`mode "${p.mode}" needs a source rectangle`);
      return edit(ctx, p, () => ({
        op: 'copy_brush',
        mode: p.mode,
        points: p.points,
        ...(p.breaks?.length ? { breaks: p.breaks } : {}),
        brush: { size: p.size, shape: p.shape },
        ...(p.offset ? { offset: p.offset } : {}),
        ...(p.source ? { source: p.source } : {}),
        paint: { opacity: p.opacity, blend: p.blend, lockAlpha: p.lockAlpha },
        selection: p.selection,
      }));
    },
  }),

  defineCommand({
    id: 'paint.adjust',
    title: 'Bild anpassen',
    description:
      'Image adjustment on a layer (or the selection of it): brightness_contrast (-1..1 each), hue_saturation (hue degrees, saturation and lightness -1..1), opacity (alpha x factor), invert (colours), curves (control points [in, out] 0..1 per channel: rgb, r, g, b, a), limit_palette (every pixel to the nearest of colors). Example: { textureId, adjust: { type: "hue_saturation", hue: 30 } }.',
    params: z.object({ textureId, layerId, adjust: adjustment, selection }),
    run(ctx, p) {
      return edit(ctx, p, () => ({ op: 'adjust', adjust: p.adjust, selection: p.selection }));
    },
  }),

  defineCommand({
    id: 'paint.clear',
    title: 'Pixel löschen',
    description: 'Make the selected pixels (or the whole layer) transparent.',
    params: z.object({ textureId, layerId, selection }),
    run(ctx, p) {
      return edit(ctx, p, () => ({ op: 'clear', selection: p.selection }));
    },
  }),

  defineCommand({
    id: 'paint.clear_unused',
    title: 'Ungenutzten Texturbereich leeren',
    description:
      "Minecraft Java documents: make every pixel transparent that no element face shows (in every frame of an animated texture). Only faces that use this texture count.",
    params: z.object({ textureId, layerId }),
    run(ctx, p) {
      return edit(ctx, p, (state, texture) => {
        if (!isMinecraft(state)) throw new Error('paint.clear_unused needs a Minecraft Java document: it keeps what the elements show');
        const keep: PixelRect[] = [];
        for (let f = 0; f < frameCount(texture); f++) keep.push(...faceRegions(state, texture.id, { frame: f }).map((r) => r.rect));
        return { op: 'clear', keep };
      });
    },
  }),

  defineCommand({
    id: 'paint.set_pixels',
    title: 'Pixel setzen',
    description: 'Replace a rectangle of pixels with explicit values: rgba is base64 of width x height x 4 bytes (RGBA, not premultiplied, rows top to bottom).',
    params: z.object({ textureId, layerId, rect: rectSchema, rgba: z.string() }),
    run(ctx, p) {
      return edit(ctx, p, () => ({ op: 'set', rect: p.rect, rgba: p.rgba }));
    },
  }),

  defineCommand({
    id: 'paint.transform',
    title: 'Textur transformieren',
    description:
      'Change the whole texture, all layers alike: flip (axis x = mirror left-right, y = upside down), rotate (cw / ccw by 90 degrees; width and height swap), resize (mode canvas: pixels stay, anchored top-left, new space transparent; mode scale: nearest-neighbour scaling), crop (to rect). Minecraft UVs are not changed.',
    params: z.object({
      textureId,
      transform: z.discriminatedUnion('op', [
        z.object({ op: z.literal('flip'), axis: z.enum(['x', 'y']) }),
        z.object({ op: z.literal('rotate'), direction: z.enum(['cw', 'ccw']) }),
        z.object({
          op: z.literal('resize'),
          width: z.number().int().min(1).max(MAX_PAINT_SIZE),
          height: z.number().int().min(1).max(MAX_PAINT_SIZE),
          mode: z.enum(['canvas', 'scale']).default('canvas'),
        }),
        z.object({ op: z.literal('crop'), rect: rectSchema }),
      ]),
    }),
    async run(ctx, p) {
      const texture = requirePaintable(docState(ctx), p.textureId);
      const t = p.transform;
      if (t.op === 'crop' && (t.rect.width < 1 || t.rect.height < 1)) throw new Error('The crop rectangle is empty');
      if (t.op === 'resize' && t.width === texture.width && t.height === texture.height) return { id: texture.id, width: texture.width, height: texture.height };
      const next = await transform(ctx, texture, t);
      return { id: next.id, width: next.width, height: next.height };
    },
  }),

  defineCommand({
    id: 'paint.frames',
    title: 'Animationsbilder bearbeiten',
    description:
      'Edit the frames of a flipbook texture (a vertical strip of square frames, frame height = width; a still square texture is one frame). action add: a transparent frame at index (default: at the end); duplicate: a copy of frame index right after it; remove: frame index; move: frame index to position to. A texture with more than one frame becomes animated (frametime 1 tick unless set; see texture.set_animation).',
    params: z.object({
      textureId,
      action: z.enum(['add', 'duplicate', 'remove', 'move']),
      index: z.number().int().min(0).optional(),
      to: z.number().int().min(0).optional(),
    }),
    async run(ctx, p) {
      const texture = requirePaintable(docState(ctx), p.textureId);
      if (texture.height % texture.width !== 0) throw new Error(`Texture "${texture.name}" is ${texture.width} x ${texture.height}: a flipbook needs a height that is a multiple of its width`);
      const count = texture.height / texture.width;
      const order: (number | null)[] = Array.from({ length: count }, (_, i) => i);
      const at = (fallback: number) => {
        const i = p.index ?? fallback;
        if (i >= count + (p.action === 'add' ? 1 : 0)) throw new Error(`index must be 0..${count - (p.action === 'add' ? 0 : 1)}`);
        return i;
      };
      if (p.action === 'add') order.splice(at(count), 0, null);
      else if (p.action === 'duplicate') {
        const i = at(count - 1);
        order.splice(i + 1, 0, i);
      } else if (p.action === 'remove') {
        if (count === 1) throw new Error('The only frame cannot be removed');
        order.splice(at(count - 1), 1);
      } else {
        const i = at(count - 1);
        if (p.to === undefined || p.to >= count) throw new Error(`to must be 0..${count - 1}`);
        order.splice(p.to, 0, ...order.splice(i, 1));
      }
      if (texture.width * order.length > MAX_PAINT_SIZE) throw new Error(`More frames do not fit: a texture is at most ${MAX_PAINT_SIZE} pixels high`);
      const animation = order.length > 1 ? (texture.animation ?? { frametime: 1, interpolate: false }) : texture.animation;
      const next = await transform(ctx, texture, { op: 'frames', order }, animation ? { animation } : {});
      return { id: next.id, frames: next.height / next.width, height: next.height };
    },
  }),

  defineCommand({
    id: 'texture.set_animation',
    title: 'Texturanimation einstellen',
    description:
      'Make a texture a flipbook animation (or not): animation { frametime (game ticks per frame, 1 tick = 1/20 s), interpolate } or null to make it a still image again. The image must be a vertical strip of square frames (height a multiple of width); see paint.frames. Exported as the texture\'s .png.mcmeta (texture.export).',
    params: z.object({
      id: textureId,
      animation: z.object({ frametime: z.number().int().min(1).max(100_000).default(1), interpolate: z.boolean().default(false) }).nullable(),
    }),
    run(ctx, p) {
      const texture = own(docState(ctx).textures, p.id);
      if (!texture) throw new Error(`Texture "${p.id}" does not exist`);
      if (p.animation && texture.height % texture.width !== 0) {
        throw new Error(`Texture "${texture.name}" is ${texture.width} x ${texture.height}: an animated texture needs a height that is a multiple of its width`);
      }
      const { animation: _, ...still } = texture;
      const next: Texture = p.animation ? { ...texture, animation: p.animation } : still;
      if (JSON.stringify(next.animation) !== JSON.stringify(texture.animation)) updateDocState(ctx, (s) => ({ ...s, textures: { ...s.textures, [next.id]: next } }));
      return { id: texture.id, animation: next.animation ?? null, frames: next.animation ? frameCount(next) : 1, frameHeight: frameHeight(next) };
    },
  }),

  defineCommand({
    id: 'texture.export',
    title: 'Textur exportieren',
    description:
      'The texture as an image file to save: { fileName, mimeType, base64 } and, for an animated texture, mcmeta { fileName, text } (the .png.mcmeta Minecraft reads next to it). Painted textures are PNGs.',
    params: z.object({ id: textureId }),
    history: false,
    run(ctx, p) {
      const texture = own(docState(ctx).textures, p.id);
      if (!texture) throw new Error(`Texture "${p.id}" does not exist`);
      const extension = texture.mimeType === 'image/png' ? 'png' : texture.mimeType === 'image/jpeg' ? 'jpg' : 'webp';
      const fileName = `${texture.name}.${extension}`;
      const text = mcmetaText(texture);
      return { fileName, mimeType: texture.mimeType, base64: texture.data, ...(text ? { mcmeta: { fileName: `${fileName}.mcmeta`, text } } : {}) };
    },
  }),
];
