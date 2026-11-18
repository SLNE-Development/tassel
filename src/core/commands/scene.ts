import { z } from 'zod';
import { boundingBox, meshStats } from '../mesh/polymesh';
import { evaluateObject, initModifiers } from '../modifiers/evaluate';
import { createPrimitive, primitiveShape, primitiveTypes } from '../mesh/primitives';
import { newId, uniqueName } from '../state';
import type { DocState, SceneObject } from '../types';
import { defineCommand, docState, updateDocState, vec3 } from './registry';

const primitiveNames: Record<(typeof primitiveTypes)[number], string> = {
  cube: 'Würfel',
  plane: 'Ebene',
  uv_sphere: 'Kugel',
  ico_sphere: 'Ikosphäre',
  cylinder: 'Zylinder',
  cone: 'Kegel',
  torus: 'Torus',
};

function requireObject(state: DocState, id: string): SceneObject {
  const obj = state.objects[id];
  if (!obj) throw new Error(`Object "${id}" does not exist`);
  return obj;
}

/** Explicit ids, or the current selection if none are given. */
function targetIds(state: DocState, ids: string[] | undefined): readonly string[] {
  const list = ids ?? state.selection;
  if (list.length === 0) throw new Error('No objects given and nothing is selected');
  list.forEach((id) => requireObject(state, id));
  return list;
}

function names(state: DocState): string[] {
  return Object.values(state.objects).map((o) => o.name);
}

function summary(obj: SceneObject) {
  return { id: obj.id, name: obj.name, visible: obj.visible, transform: obj.transform, ...meshStats(obj.mesh) };
}

const idsParam = z.array(z.string()).optional().describe('Object ids. Defaults to the current selection.');

export const sceneCommands = [
  defineCommand({
    id: 'scene.list_objects',
    title: 'Objekte auflisten',
    description: 'List all objects of the active document with transform and mesh statistics.',
    params: z.object({}),
    run(ctx) {
      const state = docState(ctx);
      return { objects: state.order.map((id) => summary(state.objects[id])), selection: state.selection };
    },
  }),

  defineCommand({
    id: 'scene.get_object',
    title: 'Objekt abfragen',
    description:
      'Get one object: transform, base mesh statistics and local bounding box, its modifiers, smooth shading flag, and "evaluated": the statistics of the mesh after all enabled modifiers (what is rendered and exported). "errors" maps modifier ids to the reason why that modifier is currently skipped. Set includeMesh to also get the vertex positions and faces of the base mesh.',
    params: z.object({ id: z.string(), includeMesh: z.boolean().default(false) }),
    async run(ctx, p) {
      // Booleans can only be evaluated once the WASM is there; a load failure shows up in `errors`.
      const hasBoolean = requireObject(docState(ctx), p.id).modifiers.some((m) => m.type === 'boolean' && m.enabled);
      if (hasBoolean) await initModifiers().catch(() => {});
      const state = docState(ctx);
      const obj = requireObject(state, p.id);
      const evaluated = evaluateObject(state, p.id);
      return {
        ...summary(obj),
        boundingBox: boundingBox(obj.mesh),
        smooth: obj.smooth,
        modifiers: obj.modifiers,
        evaluated: meshStats(evaluated.mesh),
        errors: evaluated.errors,
        ...(p.includeMesh ? { mesh: obj.mesh } : {}),
      };
    },
  }),

  defineCommand({
    id: 'scene.add_primitive',
    title: 'Grundkörper hinzufügen',
    description:
      'Add a primitive mesh object (centered on its origin, Y is up, units are meters) and select it. Returns the new object id.',
    params: z.object({
      type: z.enum(primitiveTypes),
      name: z.string().min(1).optional(),
      position: vec3.default([0, 0, 0]),
      rotation: vec3.default([0, 0, 0]).describe('Euler XYZ in degrees'),
      scale: vec3.default([1, 1, 1]),
      ...primitiveShape,
    }),
    run(ctx, p) {
      const { type, name, position, rotation, scale, ...shape } = p;
      const mesh = createPrimitive(type, shape);
      const state = docState(ctx);
      const obj: SceneObject = {
        id: newId(),
        name: uniqueName(names(state), name ?? primitiveNames[type]),
        visible: true,
        transform: { position, rotation, scale },
        mesh,
        modifiers: [],
        smooth: false,
      };
      updateDocState(ctx, (s) => ({
        objects: { ...s.objects, [obj.id]: obj },
        order: [...s.order, obj.id],
        selection: [obj.id],
        activeId: obj.id,
        edit: null,
      }));
      return { id: obj.id, name: obj.name };
    },
  }),

  defineCommand({
    id: 'scene.delete_objects',
    title: 'Objekte löschen',
    description: 'Delete objects (defaults to the current selection).',
    params: z.object({ ids: idsParam }),
    run(ctx, p) {
      const remove = new Set(targetIds(docState(ctx), p.ids));
      updateDocState(ctx, (s) => {
        const objects = { ...s.objects };
        remove.forEach((id) => delete objects[id]);
        const selection = s.selection.filter((id) => !remove.has(id));
        return {
          ...s,
          objects,
          order: s.order.filter((id) => !remove.has(id)),
          selection,
          activeId: s.activeId && !remove.has(s.activeId) ? s.activeId : (selection.at(-1) ?? null),
        };
      });
      return { deleted: [...remove] };
    },
  }),

  defineCommand({
    id: 'scene.duplicate_objects',
    title: 'Objekte duplizieren',
    description: 'Duplicate objects (defaults to the current selection) and select the copies. Returns the new ids.',
    params: z.object({ ids: idsParam, offset: vec3.default([0, 0, 0]).describe('Translation applied to the copies') }),
    run(ctx, p) {
      const state = docState(ctx);
      const taken = names(state);
      const copies = targetIds(state, p.ids).map((id): SceneObject => {
        const src = state.objects[id];
        const name = uniqueName(taken, src.name);
        taken.push(name);
        const [x, y, z] = src.transform.position;
        return {
          ...src,
          id: newId(),
          name,
          transform: { ...src.transform, position: [x + p.offset[0], y + p.offset[1], z + p.offset[2]] },
        };
      });
      updateDocState(ctx, (s) => ({
        objects: { ...s.objects, ...Object.fromEntries(copies.map((c) => [c.id, c])) },
        order: [...s.order, ...copies.map((c) => c.id)],
        selection: copies.map((c) => c.id),
        activeId: copies.at(-1)?.id ?? null,
        edit: null,
      }));
      return { objects: copies.map((c) => ({ id: c.id, name: c.name })) };
    },
  }),

  defineCommand({
    id: 'scene.set_transform',
    title: 'Transformation setzen',
    description:
      'Set position, rotation (Euler XYZ in degrees) and/or scale of one or more objects. Omitted fields stay unchanged. All items form a single undo step.',
    params: z.object({
      items: z
        .array(z.object({ id: z.string(), position: vec3.optional(), rotation: vec3.optional(), scale: vec3.optional() }))
        .min(1),
    }),
    run(ctx, p) {
      const state = docState(ctx);
      p.items.forEach((item) => requireObject(state, item.id));
      updateDocState(ctx, (s) => {
        const objects = { ...s.objects };
        for (const { id, position, rotation, scale } of p.items) {
          const t = objects[id].transform;
          objects[id] = {
            ...objects[id],
            transform: { position: position ?? t.position, rotation: rotation ?? t.rotation, scale: scale ?? t.scale },
          };
        }
        return { ...s, objects };
      });
    },
  }),

  defineCommand({
    id: 'scene.rename_object',
    title: 'Objekt umbenennen',
    description: 'Rename an object. Names are made unique by appending .001, .002, ...',
    params: z.object({ id: z.string(), name: z.string().min(1) }),
    run(ctx, p) {
      const state = docState(ctx);
      requireObject(state, p.id);
      const others = Object.values(state.objects).filter((o) => o.id !== p.id);
      const name = uniqueName(
        others.map((o) => o.name),
        p.name,
      );
      updateDocState(ctx, (s) => ({ ...s, objects: { ...s.objects, [p.id]: { ...s.objects[p.id], name } } }));
      return { id: p.id, name };
    },
  }),

  defineCommand({
    id: 'scene.set_visible',
    title: 'Sichtbarkeit setzen',
    description: 'Show or hide objects (defaults to the current selection).',
    params: z.object({ ids: idsParam, visible: z.boolean() }),
    run(ctx, p) {
      const ids = targetIds(docState(ctx), p.ids);
      updateDocState(ctx, (s) => {
        const objects = { ...s.objects };
        for (const id of ids) objects[id] = { ...objects[id], visible: p.visible };
        return { ...s, objects };
      });
    },
  }),

  defineCommand({
    id: 'scene.set_smooth',
    title: 'Glatt schattieren',
    description:
      'Switch objects (defaults to the current selection) between smooth shading (averaged vertex normals) and flat shading. Only the shading changes, not the geometry.',
    params: z.object({ ids: idsParam, smooth: z.boolean() }),
    run(ctx, p) {
      const ids = targetIds(docState(ctx), p.ids);
      updateDocState(ctx, (s) => {
        const objects = { ...s.objects };
        for (const id of ids) objects[id] = { ...objects[id], smooth: p.smooth };
        return { ...s, objects };
      });
    },
  }),

  defineCommand({
    id: 'scene.select',
    title: 'Auswählen',
    description:
      'Change the object selection. mode: replace (default), add, remove or toggle. Use an empty ids list with replace to deselect everything.',
    params: z.object({ ids: z.array(z.string()), mode: z.enum(['replace', 'add', 'remove', 'toggle']).default('replace') }),
    history: false,
    run(ctx, p) {
      const state = docState(ctx);
      p.ids.forEach((id) => requireObject(state, id));
      const current = new Set(p.mode === 'replace' ? [] : state.selection);
      for (const id of p.ids) {
        if (p.mode === 'remove' || (p.mode === 'toggle' && current.has(id))) current.delete(id);
        else current.add(id);
      }
      const selection = [...current];
      const lastAdded = [...p.ids].reverse().find((id) => current.has(id));
      const activeId =
        lastAdded ?? (state.activeId && current.has(state.activeId) ? state.activeId : (selection.at(-1) ?? null));
      updateDocState(ctx, (s) => ({ ...s, selection, activeId, edit: s.edit && s.edit.objectId === activeId ? s.edit : null }));
      return { selection, activeId };
    },
  }),

  defineCommand({
    id: 'scene.select_all',
    title: 'Alles auswählen',
    description: 'Select all objects of the active document.',
    params: z.object({}),
    history: false,
    run(ctx) {
      updateDocState(ctx, (s) => ({ ...s, selection: [...s.order], activeId: s.activeId ?? s.order.at(-1) ?? null }));
      return { selection: docState(ctx).selection };
    },
  }),
];
