import { z } from 'zod';
import { polyMeshSchema } from './mesh/polymesh';
import { modifierSchema } from './modifiers/schema';
import { repairGroups } from './groups';
import { newId } from './state';
import type { Doc, DocState, Group, SceneObject } from './types';

// Project file format (.tessel): JSON, validated on load because files are untrusted input.

const vec3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);

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
    }),
  ),
  // In sibling order (DocState.groupOrder). Files written before groups existed have none.
  groups: z
    .array(z.object({ id: z.string().min(1), name: z.string(), parentId: z.string().nullable().default(null) }))
    .default([]),
});

export const PROJECT_EXTENSION = 'tessel';

export function serializeProject(doc: Doc): string {
  const project = {
    format: 'tessel',
    version: 1,
    name: doc.name,
    objects: doc.state.order.map((id) => doc.state.objects[id]),
    groups: doc.state.groupOrder.map((id) => doc.state.groups[id]),
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
  // Broken group references are repaired rather than rejected: the geometry is what matters.
  const repaired = repairGroups(objects, groups);
  return {
    name: parsed.data.name,
    state: { ...repaired, order, groupOrder, selection: [], activeId: null, edit: null },
  };
}
