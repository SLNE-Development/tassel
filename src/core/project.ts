import { z } from 'zod';
import { animationSchema, repairAnimation } from './animation';
import { polyMeshSchema } from './mesh/polymesh';
import { modifierSchema } from './modifiers/schema';
import { repairGroups } from './groups';
import { base64ImageSize } from './imageInfo';
import { MAX_TEXTURE_SIZE, materialFields, repairMaterials, textureDataProblem, textureSizeProblem } from './materials';
import { parseRenderSettings } from './render';
import { newId } from './state';
import { blendModes, textureMimeTypes, textureSlots } from './types';
import type { Doc, DocState, Group, Material, SceneObject, Texture } from './types';

// Project file format (.tessel): JSON, validated on load because files are untrusted input.

const vec3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);

const textureSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    mimeType: z.enum(textureMimeTypes),
    data: z.string(),
    width: z.number(),
    height: z.number(),
    // Paint layers, bottom first. Files written before texture painting existed have none.
    layers: z
      .array(
        z.object({
          id: z.string().min(1),
          name: z.string(),
          visible: z.boolean(),
          opacity: z.number().min(0).max(1),
          blend: z.enum(blendModes),
          data: z.string(),
        }),
      )
      .optional(),
  })
  .superRefine((texture, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message: `texture "${texture.name}": ${message}` });
    const validSize = (n: number) => Number.isInteger(n) && n >= 1 && n <= MAX_TEXTURE_SIZE;
    if (!validSize(texture.width) || !validSize(texture.height)) {
      fail(`width and height must be integers from 1 to ${MAX_TEXTURE_SIZE}`);
    }
    const problem = textureDataProblem(texture.mimeType, texture.data);
    if (problem === 'empty') fail('has no image data');
    else if (problem === 'tooLarge') fail('image data is larger than 64 MB');
    else if (problem === 'notBase64') fail('image data is not valid base64');
    else if (problem === 'signature') fail(`image data is not an image of type ${texture.mimeType}`);
    // A size that disagrees with the image file's own header would let a file claim to be small and decode huge.
    // (A header this reader cannot make sense of is let through: the geometry of an old file matters more.)
    else {
      const header = textureSizeProblem(texture.data, texture.width, texture.height);
      if (header && header !== 'unreadable') {
        fail(`is ${header.width} x ${header.height} pixels according to its image data, not ${texture.width} x ${texture.height}`);
      }
    }
    if (!texture.layers) return;
    // Layers are PNGs of exactly the texture's size, and the texture's own image is then the flattened PNG.
    if (texture.layers.length === 0) fail('has an empty list of paint layers');
    if (texture.mimeType !== 'image/png') fail('has paint layers but its image is not a PNG');
    if (new Set(texture.layers.map((layer) => layer.id)).size !== texture.layers.length) fail('has two paint layers with the same id');
    for (const layer of texture.layers) {
      const size = textureDataProblem('image/png', layer.data) ? null : base64ImageSize(layer.data);
      if (!size) fail(`paint layer "${layer.name}" is not a valid PNG image`);
      else if (size.width !== texture.width || size.height !== texture.height) {
        fail(`paint layer "${layer.name}" is ${size.width} x ${size.height} pixels, but the texture is ${texture.width} x ${texture.height}`);
      }
    }
  });

const materialSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  ...materialFields,
  maps: z.object(Object.fromEntries(textureSlots.map((slot) => [slot, z.string().optional()]))).default({}),
});

const projectSchema = z.object({
  format: z.literal('tessel'),
  version: z.literal(1),
  name: z.string(),
  objects: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string(),
      visible: z.boolean(),
      transform: z.object({ position: vec3, rotation: vec3, scale: vec3 }),
      mesh: polyMeshSchema,
      // Added after the first version of the format; older files simply lack them.
      modifiers: z.array(modifierSchema).default([]),
      smooth: z.boolean().default(false),
      groupId: z.string().nullable().default(null),
      materialId: z.string().nullable().default(null),
    }),
  ),
  // In sibling order (DocState.groupOrder). Files written before groups existed have none.
  groups: z
    .array(z.object({ id: z.string().min(1), name: z.string(), parentId: z.string().nullable().default(null) }))
    .default([]),
  // Files written before materials existed have neither.
  materials: z.array(materialSchema).default([]),
  textures: z.array(textureSchema).default([]),
  // Render settings (core/render.ts), read leniently field by field. Files written before rendering existed have none.
  render: z.unknown().optional(),
  // Keyframe animation (core/animation.ts). Files written before animation existed, and documents without one, have none.
  animation: animationSchema.optional(),
});

export const PROJECT_EXTENSION = 'tessel';

export function serializeProject(doc: Doc): string {
  const project = {
    format: 'tessel',
    version: 1,
    name: doc.name,
    objects: doc.state.order.map((id) => doc.state.objects[id]),
    groups: doc.state.groupOrder.map((id) => doc.state.groups[id]),
    materials: Object.values(doc.state.materials),
    textures: Object.values(doc.state.textures),
    // Only documents whose render settings were changed carry them.
    ...(doc.state.render ? { render: doc.state.render } : {}),
    ...(doc.state.animation ? { animation: doc.state.animation } : {}),
  };
  return JSON.stringify(project);
}

/** Parses and validates a project file. Throws with a readable message if it is not valid. */
export function parseProject(json: string): { name: string; state: DocState } {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('File is not valid JSON');
  }
  const parsed = projectSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Not a valid Tessel file: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
  const objects: Record<string, SceneObject> = {};
  const order: string[] = [];
  for (const obj of parsed.data.objects) {
    const id = Object.hasOwn(objects, obj.id) ? newId() : obj.id;
    objects[id] = { ...obj, id };
    order.push(id);
  }
  const groups: Record<string, Group> = {};
  const groupOrder: string[] = [];
  for (const group of parsed.data.groups) {
    const id = Object.hasOwn(groups, group.id) ? newId() : group.id;
    groups[id] = { ...group, id };
    groupOrder.push(id);
  }
  // A duplicate texture or material id gets a new id (and so loses its references) instead of being dropped.
  const textures: Record<string, Texture> = {};
  for (const texture of parsed.data.textures) {
    const id = Object.hasOwn(textures, texture.id) ? newId() : texture.id;
    textures[id] = { ...texture, id };
  }
  const materials: Record<string, Material> = {};
  for (const material of parsed.data.materials) {
    const id = Object.hasOwn(materials, material.id) ? newId() : material.id;
    materials[id] = { ...material, id };
  }
  // Broken references are repaired rather than rejected: the geometry is what matters.
  const grouped = repairGroups(objects, groups);
  const repaired = repairMaterials(grouped.objects, materials, textures);
  // Animation keys are sorted and made unique per frame; tracks of objects that are not in the file are dropped.
  let animation;
  try {
    animation = parsed.data.animation ? repairAnimation(parsed.data.animation, repaired.objects) : undefined;
  } catch (error) {
    throw new Error(`Not a valid Tessel file: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    name: parsed.data.name,
    state: {
      objects: repaired.objects,
      order,
      groups: grouped.groups,
      groupOrder,
      materials: repaired.materials,
      textures,
      selection: [],
      activeId: null,
      edit: null,
      ...(animation ? { animation } : {}),
      ...(parsed.data.render !== undefined && parsed.data.render !== null ? { render: parseRenderSettings(parsed.data.render) } : {}),
    },
  };
}
