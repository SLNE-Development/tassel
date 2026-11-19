import { z } from 'zod';
import { animationWarning, duplicateTracks } from '../animation';
import { boundingBox, meshStats } from '../mesh/polymesh';
import { evaluateObject, initModifiers } from '../modifiers/evaluate';
import { createPrimitive, primitiveShape, primitiveTypes } from '../mesh/primitives';
import { groupWithDescendants } from '../groups';
import { transformMatrix } from '../modifiers/boolean';
import { withTransform } from '../modifiers/worldOffsets';
import { REFS_HINT, globMatcher, resolveGroupId, resolveMaterialId, resolveObjectId, resolveObjectIds } from '../refs';
import { newId, uniqueName } from '../state';
import type { DocState, SceneObject, Vec3 } from '../types';
import { defineCommand, docState, updateDocState, vec3, type CommandContext } from './registry';
import { boundsResult, objectResults } from './results';
import { elementInfo } from './cuboid';

const primitiveNames: Record<(typeof primitiveTypes)[number], string> = {
  cube: 'Würfel',
  plane: 'Ebene',
  uv_sphere: 'Kugel',
  ico_sphere: 'Ikosphäre',
  cylinder: 'Zylinder',
  cone: 'Kegel',
  torus: 'Torus',
  arc: 'Bogen',
};

/** The object for an id or a name pattern that matches exactly one object. */
function requireObject(state: DocState, ref: string): SceneObject {
  return state.objects[resolveObjectId(state, ref)];
}

/** Explicit ids / name patterns (all matches), or the current selection if none are given. */
function targetIds(state: DocState, ids: string[] | undefined): readonly string[] {
  const list = ids ? resolveObjectIds(state, ids) : state.selection;
  if (list.length === 0) throw new Error('No objects given and nothing is selected');
  return list;
}

function names(state: DocState): string[] {
  return Object.values(state.objects).map((o) => o.name);
}

function summary(obj: SceneObject) {
  return {
    id: obj.id,
    name: obj.name,
    visible: obj.visible,
    groupId: obj.groupId,
    materialId: obj.materialId,
    transform: obj.transform,
    ...meshStats(obj.mesh),
    // Minecraft cuboid elements: their box, pivot and faces in model-space pixels (see cuboid_list).
    ...(obj.cuboid ? { element: elementInfo({ ...obj, cuboid: obj.cuboid }) } : {}),
  };
}

const idsParam = z.array(z.string()).optional().describe(`Objects: ${REFS_HINT}. Defaults to the current selection.`);
const objectRef = z.string().describe('Object id, exact name, or a glob pattern that matches exactly one object.');

const selectMode = z.enum(['replace', 'add', 'remove', 'toggle']).default('replace');

/** Filters shared by scene.list_objects and scene.select_by. */
const objectFilters = {
  name: z
    .string()
    .min(1)
    .optional()
    .describe('Only objects whose name matches this glob (* = any run of characters, ? = one character; case-sensitive, whole name), e.g. "Belt *".'),
  materialId: z.string().nullable().optional().describe('Only objects with this material (id or name); null = only objects without a material.'),
  groupId: z
    .string()
    .nullable()
    .optional()
    .describe('Only objects inside this group (id or name), including those in groups nested in it; null = only objects at top level (in no group).'),
};

interface ObjectFilter {
  name?: string;
  materialId?: string | null;
  groupId?: string | null;
  visible?: boolean;
}

/** Ids of the objects that pass all given filters, in outliner order. */
function filterObjects(state: DocState, filter: ObjectFilter): string[] {
  const matchesName = filter.name === undefined ? null : globMatcher(filter.name);
  const materialId = filter.materialId == null ? filter.materialId : resolveMaterialId(state, filter.materialId);
  const groups = filter.groupId == null ? null : groupWithDescendants(state, resolveGroupId(state, filter.groupId));
  return state.order.filter((id) => {
    const obj = state.objects[id];
    if (matchesName && !matchesName(obj.name)) return false;
    if (materialId !== undefined && obj.materialId !== materialId) return false;
    if (filter.groupId === null && obj.groupId !== null) return false;
    if (groups && (obj.groupId === null || !groups.has(obj.groupId))) return false;
    if (filter.visible !== undefined && obj.visible !== filter.visible) return false;
    return true;
  });
}

/** World-space bounding box of the object as displayed (after its modifiers), or null if it has no vertices. */
function worldBounds(state: DocState, obj: SceneObject): { min: Vec3; max: Vec3 } | null {
  const { positions } = evaluateObject(state, obj.id).mesh;
  if (positions.length === 0) return null;
  const m = transformMatrix(obj.transform);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    const [x, y, z] = [positions[i], positions[i + 1], positions[i + 2]];
    for (let axis = 0; axis < 3; axis++) {
      const v = m[axis * 4] * x + m[axis * 4 + 1] * y + m[axis * 4 + 2] * z + m[axis * 4 + 3];
      if (v < min[axis]) min[axis] = v;
      if (v > max[axis]) max[axis] = v;
    }
  }
  return { min, max };
}

/** Combines `ids` with the object selection as scene.select does and stores the result. */
function applySelection(ctx: CommandContext, ids: readonly string[], mode: z.infer<typeof selectMode>) {
  const state = docState(ctx);
  const current = new Set(mode === 'replace' ? [] : state.selection);
  for (const id of ids) {
    if (mode === 'remove' || (mode === 'toggle' && current.has(id))) current.delete(id);
    else current.add(id);
  }
  const selection = [...current];
  const lastAdded = [...ids].reverse().find((id) => current.has(id));
  const activeId = lastAdded ?? (state.activeId && current.has(state.activeId) ? state.activeId : (selection.at(-1) ?? null));
  updateDocState(ctx, (s) => ({ ...s, selection, activeId, edit: s.edit && s.edit.objectId === activeId ? s.edit : null }));
  return { selection, activeId };
}

export const sceneCommands = [
  defineCommand({
    id: 'scene.list_objects',
    title: 'Objekte auflisten',
    description:
      'List the objects of the active document in outliner order, each with id, name, visible, transform (position in meters, rotation as Euler XYZ degrees, scale), base mesh statistics, groupId (the group it is in, null at top level; see group.list for the group tree) and materialId (its material or null; see material.list). Without parameters all objects are listed (up to limit). Filters combine with AND: name (glob), groupId (recursive: everything inside the group and the groups nested in it), materialId, visible. Paging: offset and limit apply after filtering; "total" is the number of objects that pass the filters, "objects" the requested page, so more remain while offset + objects.length < total. includeBounds adds "bounds": { min, max } in world space of each object as displayed (after modifiers), null for an object without vertices. "selection" is the current object selection (ids) of the whole document, independent of the filters.',
    params: z.object({
      ...objectFilters,
      visible: z.boolean().optional().describe('Only visible (true) or only hidden (false) objects.'),
      offset: z.number().int().min(0).default(0).describe('Number of matching objects to skip.'),
      limit: z.number().int().min(1).max(5000).default(500).describe('Maximum number of objects returned.'),
      includeBounds: z.boolean().default(false).describe('Add the world-space bounding box of every returned object.'),
    }),
    async run(ctx, p) {
      const ids = filterObjects(docState(ctx), p);
      const page = ids.slice(p.offset, p.offset + p.limit);
      if (p.includeBounds) {
        // Booleans can only be evaluated once the WASM is there; without it the bounds are those before the boolean.
        const before = docState(ctx);
        if (page.some((id) => before.objects[id].modifiers.some((m) => m.type === 'boolean' && m.enabled))) await initModifiers().catch(() => {});
      }
      const state = docState(ctx);
      const objects = page
        .filter((id) => state.objects[id] !== undefined)
        .map((id) => ({ ...summary(state.objects[id]), ...(p.includeBounds ? { bounds: worldBounds(state, state.objects[id]) } : {}) }));
      return { total: ids.length, objects, selection: state.selection };
    },
  }),

  defineCommand({
    id: 'scene.get_object',
    title: 'Objekt abfragen',
    description:
      'Get one object: transform, groupId (its group or null), materialId (its material or null), base mesh statistics and local bounding box, its modifiers, smooth shading flag, and "evaluated": the statistics of the mesh after all enabled modifiers (what is rendered and exported). "errors" maps modifier ids to the reason why that modifier is currently skipped. Set includeMesh to also get the vertex positions and faces of the base mesh.',
    params: z.object({ id: objectRef, includeMesh: z.boolean().default(false) }),
    async run(ctx, p) {
      // Booleans can only be evaluated once the WASM is there; a load failure shows up in `errors`.
      const { id, modifiers } = requireObject(docState(ctx), p.id);
      if (modifiers.some((m) => m.type === 'boolean' && m.enabled)) await initModifiers().catch(() => {});
      const state = docState(ctx);
      const obj = requireObject(state, id);
      const evaluated = evaluateObject(state, id);
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
      'Add a primitive mesh object (centered on its origin, Y is up, units are meters) and select it. Types: cube (size, or dimensions [x, y, z] for a box), plane, uv_sphere, ico_sphere, cylinder, cone, torus, and arc: a ring segment (annulus sector) lying in the XZ plane around the Y axis, e.g. a conveyor curve, rail or arch, with innerRadius, outerRadius, height, angle and startAngle; it sweeps counter-clockwise seen from above, starting at +X for startAngle 0 and turning towards -Z. Pass groupId to put it into an existing group and materialId to give it an existing material. Returns the id, name and transform of the new object and its world-space bounds { min, max, center, size }.',
    params: z.object({
      type: z.enum(primitiveTypes),
      name: z.string().min(1).optional(),
      position: vec3.default([0, 0, 0]),
      rotation: vec3.default([0, 0, 0]).describe('Euler XYZ in degrees'),
      scale: vec3.default([1, 1, 1]),
      groupId: z.string().nullable().default(null).describe('Group (id or name) to add the object to. Default: top level.'),
      materialId: z.string().nullable().default(null).describe('Material (id or name) of the object. Default: none.'),
      ...primitiveShape,
    }),
    run(ctx, p) {
      const { type, name, position, rotation, scale, groupId: groupRef, materialId: materialRef, ...shape } = p;
      const state = docState(ctx);
      const groupId = groupRef === null ? null : resolveGroupId(state, groupRef);
      const materialId = materialRef === null ? null : resolveMaterialId(state, materialRef);
      const mesh = createPrimitive(type, shape);
      const obj: SceneObject = {
        id: newId(),
        name: uniqueName(names(state), name ?? primitiveNames[type]),
        visible: true,
        transform: { position, rotation, scale },
        mesh,
        modifiers: [],
        smooth: false,
        groupId,
        materialId,
      };
      updateDocState(ctx, (s) => ({
        ...s,
        objects: { ...s.objects, [obj.id]: obj },
        order: [...s.order, obj.id],
        selection: [obj.id],
        activeId: obj.id,
        edit: null,
      }));
      return { id: obj.id, name: obj.name, transform: obj.transform, bounds: boundsResult(docState(ctx), [obj.id]) };
    },
  }),

  defineCommand({
    id: 'scene.delete_objects',
    title: 'Objekte löschen',
    description: 'Delete objects (defaults to the current selection). Groups they were in stay, even if now empty. Their animation keys are deleted with them.',
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
    description:
      'Duplicate objects (defaults to the current selection) and select the copies. Each copy stays in the group of its original and shares its material; animation keys of the original are copied too (position keys moved by `offset`). Returns `objects` (id, name, transform and world-space bounds { min, max, center, size } of every copy) and `bounds`, the box around all copies.',
    params: z.object({ ids: idsParam, offset: vec3.default([0, 0, 0]).describe('Translation applied to the copies') }),
    run(ctx, p) {
      const state = docState(ctx);
      const taken = names(state);
      // Each entry is resolved on its own: an object that is given twice is copied twice, as it always was.
      const sources = p.ids ? p.ids.flatMap((ref) => resolveObjectIds(state, [ref])) : targetIds(state, undefined);
      if (sources.length === 0) throw new Error('No objects given and nothing is selected');
      const copies = sources.map((id): SceneObject => {
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
        ...s,
        objects: { ...s.objects, ...Object.fromEntries(copies.map((c) => [c.id, c])) },
        order: [...s.order, ...copies.map((c) => c.id)],
        selection: copies.map((c) => c.id),
        activeId: copies.at(-1)?.id ?? null,
        edit: null,
        // Animated originals give animated copies (position keys moved by the offset).
        ...(s.animation ? { animation: duplicateTracks(s.animation, sources.map((id, i) => [id, copies[i].id] as const), p.offset) } : {}),
      }));
      return objectResults(
        ctx,
        copies.map((c) => c.id),
      );
    },
  }),

  defineCommand({
    id: 'scene.set_transform',
    title: 'Transformation setzen',
    description:
      'Set position, rotation (Euler XYZ in degrees) and/or scale of one or more objects. Omitted fields stay unchanged. Everything that belongs to the object turns and scales with it, including the copies of an array modifier with a world-space offset (its `offset` is rewritten for the new rotation / scale). All items form a single undo step. This is the STATIC transform: on an animated object, channels that have animation keys keep following their keys (the result then carries `warnings`).',
    params: z.object({
      items: z
        .array(z.object({ id: objectRef, position: vec3.optional(), rotation: vec3.optional(), scale: vec3.optional() }))
        .min(1),
    }),
    run(ctx, p) {
      const state = docState(ctx);
      const items = p.items.map((item) => ({ ...item, id: resolveObjectId(state, item.id) }));
      updateDocState(ctx, (s) => {
        const objects = { ...s.objects };
        for (const { id, position, rotation, scale } of items) {
          const t = objects[id].transform;
          // World-space array offsets turn and scale with the object.
          objects[id] = withTransform(objects[id], { position: position ?? t.position, rotation: rotation ?? t.rotation, scale: scale ?? t.scale });
        }
        return { ...s, objects };
      });
      const moved = items.filter((item) => item.position || item.rotation || item.scale).map((item) => item.id);
      const warning = animationWarning(
        state,
        moved,
        'the static transform was changed, but channels that have keys keep following their keys (see anim.get); use anim.set_key or anim.add_motion to change the animated pose.',
      );
      return warning ? { ok: true, warnings: [warning] } : undefined;
    },
  }),

  defineCommand({
    id: 'scene.rename_object',
    title: 'Objekt umbenennen',
    description: 'Rename an object. Names are made unique by appending .001, .002, ...',
    params: z.object({ id: objectRef, name: z.string().min(1) }),
    run(ctx, p) {
      const state = docState(ctx);
      const { id } = requireObject(state, p.id);
      const others = Object.values(state.objects).filter((o) => o.id !== id);
      const name = uniqueName(
        others.map((o) => o.name),
        p.name,
      );
      updateDocState(ctx, (s) => ({ ...s, objects: { ...s.objects, [id]: { ...s.objects[id], name } } }));
      return { id, name };
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
      'Change the object selection. mode: replace (default), add, remove or toggle. An empty list deselects everything: scene.select { ids: [] }. Returns the new selection (ids) and the active object id.',
    params: z.object({ ids: z.array(z.string()).describe(`Objects: ${REFS_HINT}.`), mode: selectMode }),
    history: false,
    run(ctx, p) {
      return applySelection(ctx, resolveObjectIds(docState(ctx), p.ids), p.mode);
    },
  }),

  defineCommand({
    id: 'scene.select_by',
    title: 'Nach Eigenschaft auswählen',
    description:
      'Select objects by property instead of by id. Filters combine with AND and at least one is required: name (glob such as "Belt *"), materialId (objects using that material; null = objects without one), groupId (everything inside that group including nested groups; null = objects in no group). mode: replace (default; the matches become the selection, so no match deselects everything), add, remove or toggle (each match individually). The last match becomes the active object. Leaves edit mode unless the edited object stays the active one. Not an undo step. Returns "matched" (ids of the objects that passed the filters, in outliner order), the new "selection" and "activeId".',
    params: z.object({ ...objectFilters, mode: selectMode }),
    history: false,
    run(ctx, p) {
      if (p.name === undefined && p.materialId === undefined && p.groupId === undefined) {
        throw new Error('Give at least one of name, materialId, groupId (use scene.select_all to select everything)');
      }
      const matched = filterObjects(docState(ctx), p);
      return { matched, ...applySelection(ctx, matched, p.mode) };
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
