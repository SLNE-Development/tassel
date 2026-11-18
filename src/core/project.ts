import { z } from 'zod';
import { polyMeshSchema } from './mesh/polymesh';
import { modifierSchema } from './modifiers/schema';
import { repairGroups } from './groups';
import { MAX_TEXTURE_SIZE, materialFields, repairMaterials, textureDataProblem } from './materials';
import { newId } from './state';
import { textureMimeTypes, textureSlots } from './types';
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
  })
  .superRefine((texture, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message: `Textur "${texture.name}": ${message}` });
    const validSize = (n: number) => Number.isInteger(n) && n >= 1 && n <= MAX_TEXTURE_SIZE;
    if (!validSize(texture.width) || !validSize(texture.height)) {
      fail(`Breite und Höhe müssen ganze Zahlen von 1 bis ${MAX_TEXTURE_SIZE} sein`);
    }
    const problem = textureDataProblem(texture.mimeType, texture.data);
    if (problem === 'empty') fail('enthält keine Bilddaten');
    else if (problem === 'tooLarge') fail('Bilddaten sind größer als 64 MB');
    else if (problem === 'notBase64') fail('Bilddaten sind kein gültiges Base64');
    else if (problem === 'signature') fail(`Bilddaten sind kein Bild vom Typ ${texture.mimeType}`);
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
  };
  return JSON.stringify(project);
}

/** Parses and validates a project file. Throws with a readable message if it is not valid. */
export function parseProject(json: string): { name: string; state: DocState } {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('Datei ist kein gültiges JSON');
  }
  const parsed = projectSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Keine gültige Tessel-Datei: ${parsed.error.issues[0]?.message ?? 'unbekannt'}`);
  const objects: Record<string, SceneObject> = {};
  const order: string[] = [];
  for (const obj of parsed.data.objects) {
    const id = obj.id in objects ? newId() : obj.id;
    objects[id] = { ...obj, id };
    order.push(id);
  }
  const groups: Record<string, Group> = {};
  const groupOrder: string[] = [];
  for (const group of parsed.data.groups) {
    const id = group.id in groups ? newId() : group.id;
    groups[id] = { ...group, id };
    groupOrder.push(id);
  }
  // A duplicate texture or material id gets a new id (and so loses its references) instead of being dropped.
  const textures: Record<string, Texture> = {};
  for (const texture of parsed.data.textures) {
    const id = texture.id in textures ? newId() : texture.id;
    textures[id] = { ...texture, id };
  }
  const materials: Record<string, Material> = {};
  for (const material of parsed.data.materials) {
    const id = material.id in materials ? newId() : material.id;
    materials[id] = { ...material, id };
  }
  // Broken references are repaired rather than rejected: the geometry is what matters.
  const grouped = repairGroups(objects, groups);
  const repaired = repairMaterials(grouped.objects, materials, textures);
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
    },
  };
}
