import { z } from 'zod';
import { resolveMaterialId } from '../refs';
import { colorSchema, textureBytes } from '../materials';
import { newId, own, uniqueName } from '../state';
import { blendModes, textureSlots } from '../types';
import type { DocState, ImagingService, PaintLayer, Texture } from '../types';
import { defineCommand, docState, updateDocState, type CommandContext } from './registry';

// Texture painting. Core never touches pixels: these commands await the ImagingService (src/imaging) and
// then store the new layer PNG and the new flattened `data` of the texture in ONE state update.

/** Largest texture side that can be painted. */
export const MAX_PAINT_SIZE = 8192;
export const MAX_STROKE_POINTS = 100_000;

function imagingOf(ctx: CommandContext): ImagingService {
  if (!ctx.services.imaging) throw new Error('The imaging service is not ready yet');
  return ctx.services.imaging;
}

/** A texture that can be painted (not too large). It may not have layers yet. */
export function requirePaintable(state: DocState, id: string): Texture {
  const texture = own(state.textures, id);
  if (!texture) throw new Error(`Texture "${id}" does not exist`);
  if (texture.width > MAX_PAINT_SIZE || texture.height > MAX_PAINT_SIZE) {
    throw new Error(
      `Texture "${texture.name}" is too large to paint or process: ${texture.width} x ${texture.height} pixels, the limit is ${MAX_PAINT_SIZE} x ${MAX_PAINT_SIZE}`,
    );
  }
  return texture;
}

type Layered = Texture & { readonly layers: readonly PaintLayer[] };

function requireLayered(state: DocState, id: string): Layered {
  const texture = requirePaintable(state, id);
  if (!texture.layers) throw new Error(`Texture "${texture.name}" has no paint layers yet. Call paint.add_layer first; it turns the image into the base layer.`);
  return texture as Layered;
}

function requireLayer(texture: Layered, layerId: string): number {
  const index = texture.layers.findIndex((layer) => layer.id === layerId);
  if (index < 0) throw new Error(`Texture "${texture.name}" has no layer "${layerId}" (see paint.list_layers)`);
  return index;
}

/**
 * Stores the edited texture. The pixel work was awaited, so the document may have changed meanwhile: if the
 * texture is no longer the object the edit was computed from, the edit is dropped instead of overwriting.
 */
function commit(ctx: CommandContext, before: Texture, after: Texture, update: (state: DocState) => DocState = (s) => s): void {
  if (own(docState(ctx).textures, before.id) !== before) {
    throw new Error(`Texture "${before.name}" was changed or removed while this command was working, so nothing was changed. Run one paint command at a time.`);
  }
  if (after !== before) updateDocState(ctx, (s) => update({ ...s, textures: { ...s.textures, [after.id]: after } }));
}

/** The texture with one layer's data replaced; every other layer keeps its identity. */
function withLayerData(texture: Layered, index: number, edit: { layer: string; flattened: string }): Texture {
  if (edit.layer === texture.layers[index].data && edit.flattened === texture.data) return texture;
  return { ...texture, data: edit.flattened, layers: texture.layers.map((layer, i) => (i === index ? { ...layer, data: edit.layer } : layer)) };
}

const contributes = (layer: PaintLayer) => layer.visible && layer.opacity > 0;

const textureId = z.string().describe('Texture id (see texture.list)');
const layerId = z.string().describe('Layer id (see paint.list_layers)');
const size = z.number().int().min(16).max(MAX_PAINT_SIZE);
const unit = z.number().min(0).max(1);

export const paintCommands = [
  defineCommand({
    id: 'paint.create_texture',
    title: 'Maltextur erstellen',
    description: `Create a new texture for painting: one base layer filled with color ("#rrggbb", default mid grey). width and height are in pixels (16..${MAX_PAINT_SIZE}, default 1024). With materialId and slot (${textureSlots.join(', ')}) it is put into that material slot right away, so it shows on the objects using the material (they need UVs: uv.unwrap). Scalar maps (roughness, metallic, occlusion, height) are painted as greys. Paint with paint.stroke / paint.fill on the returned layerId. Returns { id, name, layerId }.`,
    params: z.object({
      name: z.string().min(1).default('Paint'),
      width: size.default(1024),
      height: size.default(1024),
      color: colorSchema('Fill colour').default('#808080'),
      materialId: z.string().optional().describe('Material id or name.'),
      slot: z.enum(textureSlots).optional(),
    }),
    async run(ctx, p) {
      if ((p.materialId === undefined) !== (p.slot === undefined)) throw new Error('Pass materialId and slot together, or neither');
      const requireMaterial = () => {
        // Accepts a material name; from here on p.materialId is the id.
        if (p.materialId !== undefined) p.materialId = resolveMaterialId(docState(ctx), p.materialId);
      };
      requireMaterial();
      const data = await imagingOf(ctx).blank(p.width, p.height, p.color);
      requireMaterial();
      const state = docState(ctx);
      const layer: PaintLayer = { id: newId(), name: 'Base', visible: true, opacity: 1, blend: 'normal', data };
      const texture: Texture = {
        id: newId(),
        name: uniqueName(
          Object.values(state.textures).map((t) => t.name),
          p.name,
        ),
        mimeType: 'image/png',
        data,
        width: p.width,
        height: p.height,
        layers: [layer],
      };
      updateDocState(ctx, (s) => {
        const next = { ...s, textures: { ...s.textures, [texture.id]: texture } };
        if (p.materialId === undefined || p.slot === undefined) return next;
        const material = s.materials[p.materialId];
        return { ...next, materials: { ...s.materials, [material.id]: { ...material, maps: { ...material.maps, [p.slot]: texture.id } } } };
      });
      return { id: texture.id, name: texture.name, layerId: layer.id };
    },
  }),

  defineCommand({
    id: 'paint.add_layer',
    title: 'Ebene hinzufügen',
    description:
      'Add a transparent paint layer to a texture, on top by default (index 0 = bottom). A texture without layers (e.g. an imported image) becomes layered first: its image becomes the base layer, converted to PNG. Layers have the size of the texture. Returns { layerId } (and baseLayerId if the base layer was created by this call).',
    params: z.object({
      textureId,
      name: z.string().min(1).optional().describe('Default: "Layer N"'),
      index: z.number().int().min(0).optional().describe('Position in the stack, 0 = bottom. Default: on top.'),
    }),
    async run(ctx, p) {
      const texture = requirePaintable(docState(ctx), p.textureId);
      const imaging = imagingOf(ctx);
      const base: PaintLayer | null = texture.layers
        ? null
        : { id: newId(), name: 'Base', visible: true, opacity: 1, blend: 'normal', data: await imaging.baseLayer(texture) };
      const layers = texture.layers ?? [base!];
      const index = p.index ?? layers.length;
      if (index > layers.length) throw new Error(`index must be 0..${layers.length}`);
      const layer: PaintLayer = {
        id: newId(),
        name: uniqueName(
          layers.map((l) => l.name),
          p.name ?? `Layer ${layers.length + 1}`,
        ),
        visible: true,
        opacity: 1,
        blend: 'normal',
        data: await imaging.blank(texture.width, texture.height, null),
      };
      // A transparent layer does not change the look, so the flattened image stays (for a new base layer: is that layer).
      commit(ctx, texture, {
        ...texture,
        mimeType: 'image/png',
        data: base ? base.data : texture.data,
        layers: [...layers.slice(0, index), layer, ...layers.slice(index)],
      });
      return base ? { layerId: layer.id, baseLayerId: base.id } : { layerId: layer.id };
    },
  }),

  defineCommand({
    id: 'paint.remove_layer',
    title: 'Ebene entfernen',
    description: 'Remove a paint layer from a texture. The last remaining layer cannot be removed (use texture.remove to delete the texture).',
    params: z.object({ textureId, layerId }),
    async run(ctx, p) {
      const texture = requireLayered(docState(ctx), p.textureId);
      const index = requireLayer(texture, p.layerId);
      if (texture.layers.length === 1) throw new Error('The last layer of a texture cannot be removed');
      const layers = texture.layers.filter((_, i) => i !== index);
      const data = contributes(texture.layers[index]) ? await imagingOf(ctx).flatten(texture.width, texture.height, layers) : texture.data;
      commit(ctx, texture, { ...texture, data, layers });
      return { removed: p.layerId };
    },
  }),

  defineCommand({
    id: 'paint.move_layer',
    title: 'Ebene verschieben',
    description: 'Move a paint layer to another position in the stack of its texture: index 0 = bottom, layer count - 1 = top.',
    params: z.object({ textureId, layerId, index: z.number().int().min(0) }),
    async run(ctx, p) {
      const texture = requireLayered(docState(ctx), p.textureId);
      const from = requireLayer(texture, p.layerId);
      if (p.index >= texture.layers.length) throw new Error(`index must be 0..${texture.layers.length - 1}`);
      if (p.index === from) return { layerId: p.layerId, index: from };
      const layers = texture.layers.filter((_, i) => i !== from);
      layers.splice(p.index, 0, texture.layers[from]);
      const data = contributes(texture.layers[from]) ? await imagingOf(ctx).flatten(texture.width, texture.height, layers) : texture.data;
      commit(ctx, texture, { ...texture, data, layers });
      return { layerId: p.layerId, index: p.index };
    },
  }),

  defineCommand({
    id: 'paint.update_layer',
    title: 'Ebene ändern',
    description: `Change a paint layer; omitted fields stay as they are. visible hides or shows it, opacity is 0..1, blend is how it mixes with the layers below (${blendModes.join(', ')}). Names are made unique within the texture. Returns the layer without its image data.`,
    params: z.object({
      textureId,
      layerId,
      name: z.string().min(1).optional(),
      visible: z.boolean().optional(),
      opacity: unit.optional(),
      blend: z.enum(blendModes).optional(),
    }),
    async run(ctx, p) {
      const texture = requireLayered(docState(ctx), p.textureId);
      const index = requireLayer(texture, p.layerId);
      const current = texture.layers[index];
      const others = texture.layers.filter((_, i) => i !== index).map((l) => l.name);
      const layer: PaintLayer = {
        ...current,
        name: p.name === undefined || p.name === current.name ? current.name : uniqueName(others, p.name),
        visible: p.visible ?? current.visible,
        opacity: p.opacity ?? current.opacity,
        blend: p.blend ?? current.blend,
      };
      const { data: _, ...summary } = layer;
      const mixChanged = layer.visible !== current.visible || layer.opacity !== current.opacity || layer.blend !== current.blend;
      if (!mixChanged && layer.name === current.name) return summary;
      const lookChanged = mixChanged && (contributes(current) || contributes(layer));
      const layers = texture.layers.map((l, i) => (i === index ? layer : l));
      // Only a change of the look needs pixel work; a new name re-encodes nothing.
      const data = lookChanged ? await imagingOf(ctx).flatten(texture.width, texture.height, layers) : texture.data;
      commit(ctx, texture, { ...texture, data, layers });
      return summary;
    },
  }),

  defineCommand({
    id: 'paint.merge_down',
    title: 'Nach unten zusammenführen',
    description:
      'Merge a paint layer into the layer directly below it: the layer is drawn onto the lower one with its opacity and blend mode and then removed. The merged layer keeps the id, name, opacity and blend mode of the lower layer; the look stays the same if the lower layer is a normal layer at full opacity (otherwise its own opacity and blend mode now also apply to the merged pixels). Both layers must be visible.',
    params: z.object({ textureId, layerId }),
    async run(ctx, p) {
      const texture = requireLayered(docState(ctx), p.textureId);
      const index = requireLayer(texture, p.layerId);
      if (index === 0) throw new Error('The bottom layer has no layer below it to merge into');
      const upper = texture.layers[index];
      const lower = texture.layers[index - 1];
      if (!upper.visible || !lower.visible) throw new Error('Both layers must be visible to merge them');
      const imaging = imagingOf(ctx);
      const merged: PaintLayer = { ...lower, data: await imaging.mergeDown(texture.width, texture.height, lower, upper) };
      const layers = texture.layers.flatMap((layer, i) => (i === index ? [] : i === index - 1 ? [merged] : [layer]));
      const data = await imaging.flatten(texture.width, texture.height, layers);
      commit(ctx, texture, { ...texture, data, layers });
      return { layerId: merged.id };
    },
  }),

  defineCommand({
    id: 'paint.flatten',
    title: 'Auf eine Ebene reduzieren',
    description:
      'Reduce a texture to a single paint layer that looks the same: the visible layers merged, hidden layers discarded. The layer keeps the id and name of the bottom layer. A texture without layers gets its image as the one layer (converted to PNG).',
    params: z.object({ textureId }),
    async run(ctx, p) {
      const texture = requirePaintable(docState(ctx), p.textureId);
      // The flattened image already exists: it is the texture's data.
      const data = texture.layers ? texture.data : await imagingOf(ctx).baseLayer(texture);
      const bottom = texture.layers?.[0];
      const layer: PaintLayer = { id: bottom?.id ?? newId(), name: bottom?.name ?? 'Base', visible: true, opacity: 1, blend: 'normal', data };
      const unchanged =
        texture.layers?.length === 1 && bottom!.data === data && bottom!.visible && bottom!.opacity === 1 && bottom!.blend === 'normal';
      commit(ctx, texture, unchanged ? texture : { ...texture, mimeType: 'image/png', data, layers: [layer] });
      return { layerId: layer.id };
    },
  }),

  defineCommand({
    id: 'paint.stroke',
    title: 'Pinselstrich',
    description: `Paint one brush stroke into a layer of a texture. points are texture coordinates [u, v] or [u, v, pressure] in stroke order: u to the right, v UP, both 0..1 across the texture (the same UVs as uv.get returns; points outside are allowed, the brush is clipped); 1..${MAX_STROKE_POINTS} points, one point makes a dot. size is the brush diameter in texture pixels, pressure (0..1, default 1) scales it per point. Round stamps are set along the polyline every spacing x diameter; hardness 1 gives a hard anti-aliased edge, 0 a soft falloff from the centre. The whole stroke is applied at opacity, so overlapping parts of one stroke do not get darker; separate strokes do add up. erase removes the layer's alpha instead of painting (color is ignored). Deterministic: the same call gives the same pixels. breaks (optional) splits points into several separate polylines that are still ONE stroke and one undo step: each entry is the index into points at which a new polyline starts (strictly increasing, each > 0 and < the number of points); the point before a break is not connected to the point at it, and overlapping polylines of the stroke do not get darker either. Use it to paint several separate marks in one undoable step, or a line that continues on another UV island across a seam. To find where to paint on a model, read its UVs with uv.get. Example: a red diagonal line: { textureId, layerId, points: [[0.1,0.1],[0.9,0.9]], color: "#ff0000", size: 24 }. Two dots and a line in one step: { textureId, layerId, points: [[0.2,0.8],[0.8,0.8],[0.2,0.3],[0.8,0.3]], breaks: [1, 2] }.`,
    params: z.object({
      textureId,
      layerId,
      points: z
        .array(z.array(z.number().finite()).min(2, 'A point is [u, v] or [u, v, pressure]').max(3, 'A point is [u, v] or [u, v, pressure]'))
        .min(1, 'points is empty: a stroke needs at least one point')
        .max(MAX_STROKE_POINTS, `A stroke can have at most ${MAX_STROKE_POINTS} points`),
      breaks: z
        .array(z.number().int())
        .optional()
        .describe('Indices into points at which a new, unconnected polyline of the same stroke starts: strictly increasing, each > 0 and < points.length'),
      color: colorSchema('Brush colour').default('#000000'),
      size: z.number().min(1).max(4096).default(32).describe('Brush diameter in texture pixels'),
      opacity: unit.default(1),
      hardness: unit.default(0.8),
      spacing: z.number().min(0.01).max(10).default(0.15).describe('Stamp distance as a fraction of the diameter'),
      erase: z.boolean().default(false),
    }),
    async run(ctx, p) {
      const texture = requireLayered(docState(ctx), p.textureId);
      const index = requireLayer(texture, p.layerId);
      const { textureId: _t, layerId: _l, points, breaks = [], ...brush } = p;
      breaks.forEach((at, i) => {
        if (at <= (i > 0 ? breaks[i - 1] : 0) || at >= points.length) {
          throw new Error(
            `breaks must be strictly increasing indices into points, each > 0 and < ${points.length} (the number of points): got ${at} at breaks[${i}]`,
          );
        }
      });
      const edit = await imagingOf(ctx).stroke(texture, p.layerId, brush, points, breaks);
      const next = withLayerData(texture, index, edit);
      commit(ctx, texture, next);
      return { textureId: texture.id, layerId: p.layerId, changed: next !== texture };
    },
  }),

  defineCommand({
    id: 'paint.fill',
    title: 'Ebene füllen',
    description:
      'Fill a whole paint layer with one colour ("#rrggbb"). opacity 1 (default) replaces every pixel with the opaque colour; a lower opacity lays the colour over what is there.',
    params: z.object({ textureId, layerId, color: colorSchema('Fill colour'), opacity: unit.default(1) }),
    async run(ctx, p) {
      const texture = requireLayered(docState(ctx), p.textureId);
      const index = requireLayer(texture, p.layerId);
      if (p.opacity === 0) return { textureId: texture.id, layerId: p.layerId, changed: false };
      const edit = await imagingOf(ctx).fill(texture, p.layerId, p.color, p.opacity);
      const next = withLayerData(texture, index, edit);
      commit(ctx, texture, next);
      return { textureId: texture.id, layerId: p.layerId, changed: next !== texture };
    },
  }),

  defineCommand({
    id: 'paint.list_layers',
    title: 'Ebenen auflisten',
    description:
      'The paint layers of a texture, bottom first: id, name, visible, opacity, blend and bytes (size of the layer image). The image data is not included. layers is empty for a texture that has not been painted yet (paint.add_layer makes it paintable).',
    params: z.object({ textureId }),
    run(ctx, p) {
      const texture = own(docState(ctx).textures, p.textureId);
      if (!texture) throw new Error(`Texture "${p.textureId}" does not exist`);
      return {
        textureId: texture.id,
        width: texture.width,
        height: texture.height,
        layers: (texture.layers ?? []).map(({ data, ...layer }) => ({ ...layer, bytes: textureBytes(data) })),
      };
    },
  }),
];
