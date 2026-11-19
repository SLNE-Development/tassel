import { z } from 'zod';
import { animationSchema, repairAnimation } from './animation';
import { polyMeshSchema } from './mesh/polymesh';
import { modifierSchema } from './modifiers/schema';
import { syncCuboidObject, uvSize, withKnownFaceTextures } from './minecraft/cuboid';
import { cuboidSchema, javaSettingsSchema, javaTextureRefSchema } from './minecraft/schema';
import { factoryMachineSchema, repairMachine } from './minecraft/factory/model';
import { isMinecraftFormat } from './formats';
import { itemSettingsFromJson, itemSettingsSchema, itemSettingsToJson } from './minecraft/items/document';
import { repairGroups } from './groups';
import { base64ImageSize } from './imageInfo';
import { MAX_TEXTURE_SIZE, materialFields, repairMaterials, textureDataProblem, textureSizeProblem } from './materials';
import { parseRenderSettings } from './render';
import { newId } from './state';
import { tryTextureLocation } from './textureLibrary';
import { blendModes, docFormats, textureMimeTypes, textureSlots } from './types';
import type { Doc, DocState, Group, Material, SceneObject, Texture } from './types';

// Project file format (.tessel): JSON, validated on load because files are untrusted input.

const textureLinkSchema = z
  .object({ namespace: z.string(), path: z.string() })
  .transform((link, ctx) => {
    const parsed = tryTextureLocation(`${link.namespace}:${link.path}`);
    if (!parsed) ctx.addIssue({ code: 'custom', message: `"${link.namespace}:${link.path}" is not a valid texture location` });
    return parsed ?? link;
  });

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
    // Minecraft documents only: where the texture lives in a resource pack.
    java: javaTextureRefSchema.optional(),
    // Linked to a texture library file (core/textureLibrary.ts); files written before the library have none.
    link: textureLinkSchema.optional(),
    // Flipbook animation (a vertical strip of square frames).
    animation: z.object({ frametime: z.number().int().min(1).max(100000), interpolate: z.boolean() }).optional(),
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
    if (texture.animation && texture.height % texture.width !== 0) {
      fail(`is animated, so its height (${texture.height}) must be a whole number of square frames of its width (${texture.width})`);
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
  // The kind of document (core/formats.ts). Files written before formats existed are free models.
  documentFormat: z.enum(docFormats).default('free'),
  // Minecraft Java model settings, present in minecraft_java and minecraft_factory documents.
  java: javaSettingsSchema.optional(),
  // The machine definition of a minecraft_factory document.
  factory: factoryMachineSchema.optional(),
  // The item definition of a minecraft_item document.
  item: itemSettingsSchema.optional(),
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
      // Minecraft cuboid elements; the mesh is derived from it again on load.
      cuboid: cuboidSchema.optional(),
    }),
  ),
  // In sibling order (DocState.groupOrder). Files written before groups existed have none.
  groups: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string(),
        parentId: z.string().nullable().default(null),
        pivot: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]).optional(),
      }),
    )
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
    // Free documents leave the key out, so their files stay exactly as before formats existed.
    ...(doc.state.format && doc.state.format !== 'free' ? { documentFormat: doc.state.format } : {}),
    ...(doc.state.java ? { java: doc.state.java } : {}),
    ...(doc.state.factory ? { factory: doc.state.factory } : {}),
    ...(doc.state.item ? { item: itemSettingsToJson(doc.state.item) } : {}),
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
  const format = parsed.data.documentFormat;
  const minecraft = isMinecraftFormat(format);
  const factory = format === 'minecraft_factory' ? repairMachine(parsed.data.factory ?? factoryMachineSchema.parse({})) : undefined;
  const java = minecraft ? (parsed.data.java ?? javaSettingsSchema.parse({})) : undefined;
  let item;
  if (format === 'minecraft_item') {
    try {
      item = itemSettingsFromJson(parsed.data.item ?? itemSettingsSchema.parse({ definition: { model: { type: 'minecraft:empty' } } }));
    } catch (error) {
      throw new Error(`Not a valid Tessel file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const size = uvSize({ java });
  const objects: Record<string, SceneObject> = {};
  const order: string[] = [];
  for (const raw of parsed.data.objects) {
    const id = Object.hasOwn(objects, raw.id) ? newId() : raw.id;
    // Cuboids only exist in Minecraft documents; their mesh is always derived, never trusted from the file.
    const { cuboid, ...rest } = raw;
    const obj: SceneObject = minecraft && cuboid ? syncCuboidObject({ ...rest, id, cuboid }, size) : { ...rest, id };
    objects[id] = obj;
    order.push(id);
  }
  const groups: Record<string, Group> = {};
  const groupOrder: string[] = [];
  for (const group of parsed.data.groups) {
    const id = Object.hasOwn(groups, group.id) ? newId() : group.id;
    const { pivot, ...rest } = group;
    groups[id] = minecraft && pivot ? { ...rest, id, pivot } : { ...rest, id };
    groupOrder.push(id);
  }
  // A duplicate texture or material id gets a new id (and so loses its references) instead of being dropped.
  const textures: Record<string, Texture> = {};
  for (const texture of parsed.data.textures) {
    const id = Object.hasOwn(textures, texture.id) ? newId() : texture.id;
    const { java: ref, link, ...rest } = texture;
    textures[id] = { ...rest, id, ...(minecraft && ref ? { java: ref } : {}), ...(link ? { link } : {}) };
  }
  const materials: Record<string, Material> = {};
  for (const material of parsed.data.materials) {
    const id = Object.hasOwn(materials, material.id) ? newId() : material.id;
    materials[id] = { ...material, id };
  }
  // Broken references are repaired rather than rejected: the geometry is what matters.
  for (const [id, obj] of Object.entries(objects)) if (obj.cuboid) objects[id] = withKnownFaceTextures(obj, textures);
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
      ...(minecraft ? { format, java: repairJavaSettings(java!, textures) } : {}),
      ...(factory ? { factory } : {}),
      ...(item ? { format, item } : {}),
      ...(parsed.data.render !== undefined && parsed.data.render !== null ? { render: parseRenderSettings(parsed.data.render) } : {}),
    },
  };
}

/** Drops a particle reference to a texture that is not in the document. */
function repairJavaSettings(java: NonNullable<DocState['java']>, textures: Readonly<Record<string, Texture>>): NonNullable<DocState['java']> {
  return java.particle !== null && !Object.hasOwn(textures, java.particle) ? { ...java, particle: null } : java;
}
