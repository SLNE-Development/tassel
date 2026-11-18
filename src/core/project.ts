import { z } from 'zod';
import { polyMeshSchema } from './mesh/polymesh';
import { newId } from './state';
import type { Doc, DocState, SceneObject } from './types';

// Project file format (.forma): JSON, validated on load because files are untrusted input.

const vec3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);

const projectSchema = z.object({
  format: z.literal('forma'),
  version: z.literal(1),
  name: z.string(),
  objects: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string(),
      visible: z.boolean(),
      transform: z.object({ position: vec3, rotation: vec3, scale: vec3 }),
      mesh: polyMeshSchema,
    }),
  ),
});

export const PROJECT_EXTENSION = 'forma';

export function serializeProject(doc: Doc): string {
  const project: z.infer<typeof projectSchema> = {
    format: 'forma',
    version: 1,
    name: doc.name,
    objects: doc.state.order.map((id) => doc.state.objects[id] as z.infer<typeof projectSchema>['objects'][number]),
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
  if (!parsed.success) throw new Error(`Keine gültige Forma-Datei: ${parsed.error.issues[0]?.message ?? 'unbekannt'}`);
  const objects: Record<string, SceneObject> = {};
  const order: string[] = [];
  for (const obj of parsed.data.objects) {
    const id = obj.id in objects ? newId() : obj.id;
    objects[id] = { ...obj, id };
    order.push(id);
  }
  return { name: parsed.data.name, state: { objects, order, selection: [], activeId: null } };
}
