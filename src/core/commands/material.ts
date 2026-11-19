import { z } from 'zod';
import { defaultMaterial, materialFields } from '../materials';
import { REFS_HINT, resolveMaterialId, resolveObjectIds } from '../refs';
import { newId, own, uniqueName } from '../state';
import { textureSlots } from '../types';
import type { DocState, Material, TextureSlot } from '../types';
import { defineCommand, docState, updateDocState } from './registry';

/** The material for an id or a name (exact, or a glob that matches exactly one material). */
function requireMaterial(state: DocState, ref: string): Material {
  return state.materials[resolveMaterialId(state, ref)];
}

const materialRef = z.string().describe('Material id, exact material name, or a glob pattern that matches exactly one material.');

function materialNames(state: DocState, exceptId?: string): string[] {
  return Object.values(state.materials)
    .filter((m) => m.id !== exceptId)
    .map((m) => m.name);
}

/** Returns `state` with the material assigned to the objects; objects that already have it keep their identity. */
function assign(state: DocState, objectIds: readonly string[], materialId: string | null): DocState {
  const objects = { ...state.objects };
  for (const id of objectIds) if (objects[id].materialId !== materialId) objects[id] = { ...objects[id], materialId };
  return { ...state, objects };
}

// All optional: material.create fills in the defaults, material.update leaves omitted fields alone.
const optionalFields = {
  baseColor: materialFields.baseColor.optional(),
  metallic: materialFields.metallic.optional().describe('0 = dielectric, 1 = metal'),
  roughness: materialFields.roughness.optional().describe('0 = mirror-like, 1 = fully rough'),
  emissive: materialFields.emissive.optional(),
  emissiveStrength: materialFields.emissiveStrength.optional().describe('Multiplier for the emissive colour, 0..100'),
  normalScale: materialFields.normalScale.optional().describe('Strength of the normal map, 0..10'),
};

const mapsParam = z
  .object(Object.fromEntries(textureSlots.map((slot) => [slot, z.string().nullable().optional()])))
  .strict()
  .optional()
  .describe(
    `Texture id per slot (${textureSlots.join(', ')}); null clears a slot, omitted slots stay unchanged. Texture ids come from texture.add / texture.list.`,
  );

export const materialCommands = [
  defineCommand({
    id: 'material.create',
    title: 'Material erstellen',
    description:
      'Create a PBR material (metallic-roughness, as in glTF). Colours are "#rrggbb" in sRGB. Defaults: baseColor #b9b5ae, metallic 0, roughness 0.6, emissive #000000, emissiveStrength 1, normalScale 1. Pass assignTo to give it to objects right away; otherwise use material.assign. An object has at most one material, and many objects can share one. Texture maps are set afterwards with material.update. Names are made unique among all materials. Returns the new material id.',
    params: z.object({
      name: z.string().min(1).default('Material'),
      ...optionalFields,
      assignTo: z.array(z.string()).optional().describe(`Objects that get the new material: ${REFS_HINT}.`),
    }),
    run(ctx, p) {
      const { name, assignTo: assignRefs = [], ...fields } = p;
      const state = docState(ctx);
      const assignTo = resolveObjectIds(state, assignRefs);
      const given = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
      const material: Material = { id: newId(), name: uniqueName(materialNames(state), name), ...defaultMaterial, ...given };
      updateDocState(ctx, (s) => ({ ...assign(s, assignTo, material.id), materials: { ...s.materials, [material.id]: material } }));
      return { id: material.id, name: material.name };
    },
  }),

  defineCommand({
    id: 'material.update',
    title: 'Material ändern',
    description:
      'Change a material; omitted fields stay as they are. maps sets or clears (null) the texture of individual slots: baseColor, normal, roughness, metallic, emissive, occlusion. Textures are only visible on objects that have UVs (see uv.unwrap). Scalar maps (roughness, metallic, occlusion) are read from the image luminance and multiplied with the scalar value. Returns the updated material.',
    params: z.object({ id: materialRef, name: z.string().min(1).optional(), ...optionalFields, maps: mapsParam }),
    run(ctx, p) {
      const { id: ref, name, maps: mapChanges, ...fields } = p;
      const state = docState(ctx);
      const current = requireMaterial(state, ref);
      const id = current.id;
      const maps: Partial<Record<TextureSlot, string>> = { ...current.maps };
      for (const slot of textureSlots) {
        const textureId = mapChanges?.[slot];
        if (textureId === undefined) continue;
        if (textureId === null) delete maps[slot];
        else if (!own(state.textures, textureId)) throw new Error(`Texture "${textureId}" does not exist`);
        else maps[slot] = textureId;
      }
      const given = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
      const material: Material = {
        ...current,
        ...given,
        name: name === undefined ? current.name : uniqueName(materialNames(state, id), name),
        maps: mapChanges === undefined ? current.maps : maps,
      };
      updateDocState(ctx, (s) => ({ ...s, materials: { ...s.materials, [id]: material } }));
      return material;
    },
  }),

  defineCommand({
    id: 'material.delete',
    title: 'Material löschen',
    description:
      'Delete a material. Objects that used it fall back to no material (the default clay look); its textures stay in the document. Returns the ids of the objects that lost it.',
    params: z.object({ id: materialRef }),
    run(ctx, p) {
      const state = docState(ctx);
      p.id = requireMaterial(state, p.id).id;
      const users = state.order.filter((id) => state.objects[id].materialId === p.id);
      updateDocState(ctx, (s) => {
        const materials = { ...s.materials };
        delete materials[p.id];
        return { ...assign(s, users, null), materials };
      });
      return { deleted: p.id, unassigned: users };
    },
  }),

  defineCommand({
    id: 'material.duplicate',
    title: 'Material duplizieren',
    description:
      'Copy a material with all its values and texture maps (the textures themselves are shared, not copied). The copy is not assigned to any object. Returns the new material id.',
    params: z.object({ id: materialRef }),
    run(ctx, p) {
      const state = docState(ctx);
      const source = requireMaterial(state, p.id);
      const copy: Material = { ...source, id: newId(), name: uniqueName(materialNames(state), source.name) };
      updateDocState(ctx, (s) => ({ ...s, materials: { ...s.materials, [copy.id]: copy } }));
      return { id: copy.id, name: copy.name };
    },
  }),

  defineCommand({
    id: 'material.assign',
    title: 'Material zuweisen',
    description:
      'Give objects (defaults to the current selection) a material, or remove their material with materialId null. An object has exactly one material or none.',
    params: z.object({
      materialId: z.string().nullable().describe('Material id or name, or null for no material.'),
      ids: z.array(z.string()).optional().describe(`Objects: ${REFS_HINT}. Defaults to the current selection.`),
    }),
    run(ctx, p) {
      const state = docState(ctx);
      const materialId = p.materialId === null ? null : requireMaterial(state, p.materialId).id;
      const ids = p.ids ? resolveObjectIds(state, p.ids) : state.selection;
      if (ids.length === 0) throw new Error('No objects given and nothing is selected');
      updateDocState(ctx, (s) => assign(s, ids, materialId));
      return { materialId, ids: [...new Set(ids)] };
    },
  }),

  defineCommand({
    id: 'material.replace',
    title: 'Material ersetzen',
    description:
      'Replace one material by another on all objects that use it, in one undo step: every object whose material is "from" gets "to" instead. from and to are material ids or names; from null means "objects without a material", to null removes the material (default clay look). With ids only those objects are considered (they keep their material unless it is "from"). The material "from" itself is not deleted (see material.delete). The selection does not change. Returns { from, to } as material ids and "ids": the objects that were changed, in outliner order (empty if no object used "from").',
    params: z.object({
      from: z.string().nullable().describe('The material to replace: id or name; null = objects that have no material.'),
      to: z.string().nullable().describe('The material they get instead: id or name; null = no material.'),
      ids: z.array(z.string()).optional().describe(`Limit the replacement to these objects: ${REFS_HINT}. Default: all objects of the document.`),
    }),
    run(ctx, p) {
      const state = docState(ctx);
      const from = p.from === null ? null : requireMaterial(state, p.from).id;
      const to = p.to === null ? null : requireMaterial(state, p.to).id;
      if (from === to) throw new Error('from and to are the same material; nothing to replace');
      const scope = p.ids ? new Set(resolveObjectIds(state, p.ids)) : null;
      const ids = state.order.filter((id) => state.objects[id].materialId === from && (!scope || scope.has(id)));
      if (ids.length > 0) updateDocState(ctx, (s) => assign(s, ids, to));
      return { from, to, ids };
    },
  }),

  defineCommand({
    id: 'material.list',
    title: 'Materialien auflisten',
    description:
      'All materials of the active document with their values, maps (texture id per used slot; see texture.list) and objectIds (the objects using the material; empty for unused materials).',
    params: z.object({}),
    run(ctx) {
      const state = docState(ctx);
      return {
        materials: Object.values(state.materials).map((material) => ({
          ...material,
          objectIds: state.order.filter((id) => state.objects[id].materialId === material.id),
        })),
      };
    },
  }),
];
