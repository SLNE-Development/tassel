// Object-level operations that replace many small calls with one (transform a whole group, mirror, bake
// transforms, raw meshes, one-shot booleans) and queries that tell a client that cannot see what is where
// (ray casts, world bounds, overlaps).
import { z } from 'zod';
import { animationWarning } from '../animation';
import { describeBounds, objectWorldBounds, worldBounds, type Bounds } from '../bounds';
import { objectsInGroup } from '../groups';
import { checkMesh } from '../mesh/check';
import { flipFaces } from '../mesh/ops/flip';
import { meshStats, polyMeshSchema } from '../mesh/polymesh';
import { createPrimitive, primitiveShape, primitiveTypes } from '../mesh/primitives';
import { relativeMatrix } from '../modifiers/boolean';
import { applyModifier, evaluateObject, initModifiers } from '../modifiers/evaluate';
import { raycast } from '../raycast';
import { resolveGroupId, resolveMaterialId, resolveObjectId, resolveObjectIds } from '../refs';
import { newId, own, uniqueName } from '../state';
import { applyMat, determinant, eulerMatrix, matrixEuler, rotateAbout, roundVec3, scaleAbout } from '../transformMath';
import { booleanOperations, type DocState, type Modifier, type PolyMesh, type SceneObject, type Transform, type Vec3 } from '../types';
import { defineCommand, docState, updateDocState, type CommandContext } from './registry';

const MAX_ELEMENTS = 2_000_000;

const num = z.number().finite();
const vec3 = z.tuple([num, num, num]);
const scaleParam = z.union([num, vec3]);

const refHint = 'Each entry is an object id, an exact object name or a glob pattern with * and ? (case-sensitive); a pattern stands for all objects it matches.';
const idsParam = (fallback: string) => z.array(z.string()).optional().describe(`Objects. ${refHint} ${fallback}`);
const groupParam = (what: string) => z.string().optional().describe(`Group id or group name: ${what}`);

const toVec3 = (s: number | Vec3): Vec3 => (typeof s === 'number' ? [s, s, s] : s);

/** Mesh coordinates written by a bake are rounded to a nanometre, so that 90° turns give 0 and not 6e-17. */
const tidy = (v: number) => Math.round(v * 1e9) / 1e9 + 0;

function objectNames(state: DocState): string[] {
  return Object.values(state.objects).map((o) => o.name);
}

/** The objects a command acts on: the given references plus everything inside the group, else the fallback. */
function targets(state: DocState, ids: readonly string[] | undefined, groupId: string | undefined, fallback: 'selection' | 'all' | 'visible'): string[] {
  if (ids === undefined && groupId === undefined) {
    if (fallback === 'all') return [...state.order];
    if (fallback === 'visible') return state.order.filter((id) => state.objects[id].visible);
    if (state.selection.length === 0) throw new Error('No objects given (ids or groupId) and nothing is selected');
    return [...state.selection];
  }
  const result = new Set(resolveObjectIds(state, ids ?? []));
  if (groupId !== undefined) for (const id of objectsInGroup(state, resolveGroupId(state, groupId))) result.add(id);
  if (result.size === 0) throw new Error(groupId !== undefined ? 'The group contains no objects' : 'The list of objects is empty');
  return [...result];
}

/**
 * Picks the objects and makes sure their evaluated meshes are final: boolean modifiers need the WASM
 * engine, which loads asynchronously (a load failure leaves them skipped, as everywhere else).
 */
async function settle(ctx: CommandContext, pick: (state: DocState) => string[]): Promise<{ state: DocState; ids: string[] }> {
  const state = docState(ctx);
  const ids = pick(state);
  if (!ids.some((id) => state.objects[id].modifiers.some((m) => m.type === 'boolean' && m.enabled))) return { state, ids };
  await initModifiers().catch(() => {});
  const now = docState(ctx);
  return { state: now, ids: pick(now) };
}

function boundsOf(state: DocState, ids: readonly string[]) {
  const bounds = worldBounds(state, ids);
  return bounds ? describeBounds(bounds) : null;
}

/** `{ warnings: [...] }` for a result when animated objects were changed without adjusting their keys, else nothing. */
function keysNotAdjusted(state: DocState, ids: readonly string[], what: string): { warnings?: string[] } {
  const warning = animationWarning(state, ids, what);
  return warning ? { warnings: [warning] } : {};
}

const brief = (o: SceneObject) => ({ id: o.id, name: o.name, transform: o.transform });

/** All faces turned around; UVs follow their corners. */
function flipAll(mesh: PolyMesh): PolyMesh {
  return flipFaces(
    mesh,
    mesh.faces.map((_, i) => i),
  ).mesh;
}

const axisIndex = { x: 0, y: 1, z: 2 } as const;

/**
 * The object mirrored across the world plane through `pivot` perpendicular to world axis `axis`.
 * Exact for every rotation and scale: the mesh is mirrored along the local axis `l` that is closest to
 * the world axis (L), and since F * R * S = (F * R * L) * S * L with F * R * L a proper rotation, the
 * transform stays a plain position / rotation / scale with the scale unchanged.
 */
function mirrorObject(obj: SceneObject, axis: number, pivot: Vec3): Pick<SceneObject, 'transform' | 'mesh' | 'modifiers'> {
  const r = [...eulerMatrix(obj.transform.rotation)];
  let l = 0;
  for (let i = 1; i < 3; i++) if (Math.abs(r[axis * 3 + i]) > Math.abs(r[axis * 3 + l])) l = i;
  for (let c = 0; c < 3; c++) r[axis * 3 + c] = -r[axis * 3 + c];
  for (let row = 0; row < 3; row++) r[row * 3 + l] = -r[row * 3 + l];
  const position = [...obj.transform.position] as Vec3;
  position[axis] = 2 * pivot[axis] - position[axis];
  const positions = obj.mesh.positions.map((v, i) => (i % 3 === l ? -v + 0 : v));
  // The array modifier's step is mirrored with the mesh: offset and pivot along the mirrored local axis (a
  // world-space offset along the world axis instead), and the turn about the two other axes runs the other way.
  const modifiers = obj.modifiers.map((m): Modifier => {
    if (m.type !== 'array') return m;
    const flip = m.offsetSpace === 'world' ? axis : l;
    return {
      ...m,
      offset: m.offset.map((v, i) => (i === flip ? -v + 0 : v)) as Vec3,
      ...(m.pivot ? { pivot: m.pivot.map((v, i) => (i === l ? -v + 0 : v)) as Vec3 } : {}),
      ...(m.rotation ? { rotation: m.rotation.map((v, i) => (i === l ? v : -v + 0)) as Vec3 } : {}),
    };
  });
  return {
    transform: { position: roundVec3(position), rotation: matrixEuler(r), scale: obj.transform.scale },
    mesh: flipAll({ ...obj.mesh, positions }),
    modifiers,
  };
}

function stateWithObjects(s: DocState, changed: readonly SceneObject[]): DocState {
  const objects = { ...s.objects };
  for (const obj of changed) objects[obj.id] = obj;
  return { ...s, objects };
}

function boxOf(b: Bounds | null) {
  return b ? describeBounds(b) : null;
}

export const sceneOpsCommands = [
  defineCommand({
    id: 'scene.transform_objects',
    title: 'Objekte gemeinsam transformieren',
    description:
      'Move, rotate and/or scale several objects as ONE unit, relative to where they are, in WORLD space (Y up, meters). ' +
      'Targets: the objects in `ids` plus every object inside the group `groupId` (including nested groups); with neither, the current selection. ' +
      'Order: scale, then rotate, then translate. `scale` (one factor or [x, y, z] along the world axes) and `rotate` (Euler XYZ in degrees about the world axes) ' +
      'happen about `pivot`, a world-space point that defaults to the centre of the combined world bounding box of the affected objects (after modifiers). ' +
      '`translate` is a world-space offset in meters. Example: rotate [0, 90, 0] turns a row of objects standing along X into a row along Z. ' +
      'Each object keeps a plain position / rotation / scale: rotation and a uniform scale are exact; a non-uniform scale of an object that is rotated ' +
      'against the world axes would need a shear, so its own scale is approximated per local axis (the position is still exact) - the same as the viewport gizmo does. ' +
      'Scale factors must not be 0; a negative factor mirrors (prefer scene.mirror_objects). The selection does not change. ' +
      'Returns `ids`, the new `transform` of every object, the `pivot` used and the new combined world `bounds` { min, max, center, size }. One undo step.',
    params: z.object({
      ids: idsParam('Default (if groupId is not given either): the current selection.'),
      groupId: groupParam('all objects inside it, including nested groups, are transformed too.'),
      translate: vec3.optional().describe('World-space offset in meters, applied last.'),
      rotate: vec3.optional().describe('Euler XYZ in degrees about the world axes through the pivot.'),
      scale: scaleParam.optional().describe('Factor (uniform) or [x, y, z] factors along the world axes, about the pivot.'),
      pivot: vec3.optional().describe('World-space centre of rotate and scale. Default: centre of the world bounding box of the affected objects.'),
    }),
    async run(ctx, p) {
      if (!p.translate && !p.rotate && p.scale === undefined) throw new Error('Give at least one of translate, rotate or scale');
      const scale = p.scale === undefined ? null : toVec3(p.scale);
      if (scale?.some((s) => s === 0)) throw new Error('scale factors must not be 0');
      const { state, ids } = await settle(ctx, (s) => targets(s, p.ids, p.groupId, 'selection'));
      const before = worldBounds(state, ids);
      const pivot: Vec3 =
        p.pivot ??
        (before
          ? describeBounds(before).center
          : roundVec3([0, 1, 2].map((a) => ids.reduce((sum, id) => sum + state.objects[id].transform.position[a], 0) / ids.length)));
      const rotation = p.rotate && p.rotate.some((a) => a !== 0) ? eulerMatrix(p.rotate) : null;
      const changed = ids.map((id): SceneObject => {
        const obj = state.objects[id];
        let t: Transform = obj.transform;
        if (scale && scale.some((s) => s !== 1)) t = scaleAbout(t, pivot, scale);
        if (rotation) t = rotateAbout(t, pivot, rotation);
        if (p.translate) t = { ...t, position: roundVec3(t.position.map((v, i) => v + p.translate![i])) };
        return { ...obj, transform: t };
      });
      updateDocState(ctx, (s) => stateWithObjects(s, changed));
      return {
        ids,
        objects: changed.map(brief),
        pivot,
        bounds: boundsOf(docState(ctx), ids),
        ...keysNotAdjusted(
          state,
          ids,
          'the static transform was changed, but the keys were NOT adjusted - channels that have keys keep following them. To animate a move use anim.add_motion.',
        ),
      };
    },
  }),

  defineCommand({
    id: 'scene.apply_transform',
    title: 'Transformation anwenden',
    description:
      "Bake parts of the object transform into the base mesh and reset them, so that the object looks exactly the same but its transform is 'clean': " +
      '`scale` (default true) resets the scale to [1, 1, 1], `rotation` (default true) resets the rotation to [0, 0, 0], `position` (default false) moves the object origin to the world origin [0, 0, 0]. ' +
      'The mesh vertices are moved accordingly (world-space positions stay identical; faces are re-wound if a negative scale is baked, so normals keep pointing outwards). ' +
      'Typical use: after a non-uniform scale, so that mesh edits, bevel widths and array offsets are in real meters again. ' +
      'Targets default to the current selection. Fails for an object that is in edit mode (call edit.exit first) and if a part that is kept has a scale of 0. ' +
      'Modifiers stay on the object unchanged; they work in LOCAL space, so an array offset or a mirror plane now means something different (e.g. after baking scale 2 an array offset of 1 is 1 m in the world instead of 2 m) - adjust them, or apply the modifiers first. ' +
      'Returns the objects with their new transform, and the (unchanged) world bounds. One undo step.',
    params: z.object({
      ids: idsParam('Default: the current selection.'),
      position: z.boolean().default(false).describe('Also bake the position: the object origin moves to the world origin.'),
      rotation: z.boolean().default(true),
      scale: z.boolean().default(true),
    }),
    run(ctx, p) {
      if (!p.position && !p.rotation && !p.scale) throw new Error('Nothing to apply: set at least one of position, rotation or scale to true');
      const state = docState(ctx);
      const ids = targets(state, p.ids, undefined, 'selection');
      const changed: SceneObject[] = [];
      for (const id of ids) {
        const obj = state.objects[id];
        if (state.edit?.objectId === id) throw new Error(`Object "${obj.name}" is in edit mode; call edit.exit before applying its transform`);
        const t = obj.transform;
        const kept: Transform = {
          position: p.position ? [0, 0, 0] : t.position,
          rotation: p.rotation ? [0, 0, 0] : t.rotation,
          scale: p.scale ? [1, 1, 1] : t.scale,
        };
        if (kept.position.every((v, i) => v === t.position[i]) && kept.rotation.every((v, i) => v === t.rotation[i]) && kept.scale.every((v, i) => v === t.scale[i])) {
          continue; // already clean
        }
        const m = relativeMatrix(t, kept);
        if (!m) throw new Error(`Object "${obj.name}" has a scale of 0 on an axis, which cannot be kept while other parts are applied; apply the scale too`);
        const src = obj.mesh.positions;
        const positions: number[] = new Array(src.length);
        for (let i = 0; i < src.length; i += 3) {
          const v = applyMat(m, src[i], src[i + 1], src[i + 2]);
          positions[i] = tidy(v[0]);
          positions[i + 1] = tidy(v[1]);
          positions[i + 2] = tidy(v[2]);
        }
        const mesh: PolyMesh = { ...obj.mesh, positions };
        changed.push({ ...obj, transform: kept, mesh: determinant(m) < 0 ? flipAll(mesh) : mesh });
      }
      if (changed.length > 0) updateDocState(ctx, (s) => stateWithObjects(s, changed));
      const now = docState(ctx);
      return {
        ids,
        applied: changed.length,
        objects: ids.map((id) => brief(now.objects[id])),
        bounds: boundsOf(now, ids),
        ...keysNotAdjusted(
          state,
          changed.map((o) => o.id),
          'the mesh now contains the applied transform, but the keys were NOT adjusted and still hold the old position / rotation / scale values, so the animated object looks different now. Re-key the applied channels (anim.set_key) or remove them (anim.delete_key / anim.clear).',
        ),
      };
    },
  }),

  defineCommand({
    id: 'scene.mirror_objects',
    title: 'Objekte spiegeln',
    description:
      'Mirror objects across a WORLD plane: the plane through `pivot` (world space, default: the world origin [0, 0, 0]) perpendicular to the world axis `axis` ' +
      "(axis 'x' = the YZ plane, i.e. left/right; 'y' = the XZ ground plane; 'z' = the XY plane). " +
      'With `duplicate` true (default) mirrored COPIES are created and become the selection (the last one active), e.g. the right wheel from the left one; ' +
      'they are named after their originals (made unique with .001, ...), share their material and stay in the same group unless `groupId` names another group. ' +
      'With `duplicate` false the objects themselves are mirrored (not allowed for the object in edit mode). ' +
      'The result is exact for any rotation and scale: the base mesh is mirrored in local space (faces re-wound so that normals still point outwards, UVs follow their corners) ' +
      'and position and rotation are adjusted; the scale stays as it is and never becomes negative through this command. ' +
      'Modifiers are kept: an array offset is mirrored too, and a boolean modifier whose target is mirrored in the same call points at the mirrored copy. ' +
      'Targets default to the current selection. Returns `ids` and `objects` (id, name, transform) of the mirrored objects/copies and their world `bounds`. One undo step.',
    params: z.object({
      ids: idsParam('Default: the current selection.'),
      axis: z.enum(['x', 'y', 'z']).describe('World axis the mirror plane is perpendicular to.'),
      pivot: vec3.default([0, 0, 0]).describe('A world-space point on the mirror plane.'),
      duplicate: z.boolean().default(true).describe('true: create mirrored copies; false: mirror the objects themselves.'),
      groupId: groupParam('put the mirrored copies into this group instead of the group of their originals (only with duplicate).'),
    }),
    run(ctx, p) {
      const state = docState(ctx);
      const ids = targets(state, p.ids, undefined, 'selection');
      const groupId = p.groupId === undefined ? undefined : resolveGroupId(state, p.groupId);
      if (groupId !== undefined && !p.duplicate) throw new Error('groupId is only used with duplicate: true (use group.move to move existing objects)');
      const axis = axisIndex[p.axis];
      if (!p.duplicate) {
        for (const id of ids) {
          if (state.edit?.objectId === id) throw new Error(`Object "${state.objects[id].name}" is in edit mode; call edit.exit before mirroring it`);
        }
        const changed = ids.map((id): SceneObject => ({ ...state.objects[id], ...mirrorObject(state.objects[id], axis, p.pivot) }));
        updateDocState(ctx, (s) => stateWithObjects(s, changed));
        return {
          ids,
          objects: changed.map(brief),
          bounds: boundsOf(docState(ctx), ids),
          ...keysNotAdjusted(
            state,
            ids,
            'the mesh and the static transform were mirrored, but the keys were NOT adjusted: position and rotation keys still describe the un-mirrored motion. Re-create the animation of these objects.',
          ),
        };
      }
      const taken = objectNames(state);
      const copyOf = new Map(ids.map((id) => [id, newId()]));
      const copies = ids.map((id): SceneObject => {
        const src = state.objects[id];
        const name = uniqueName(taken, src.name);
        taken.push(name);
        const mirrored = mirrorObject(src, axis, p.pivot);
        return {
          ...src,
          ...mirrored,
          id: copyOf.get(id)!,
          name,
          groupId: groupId ?? src.groupId,
          modifiers: mirrored.modifiers.map((m) =>
            // Fresh modifier ids; a boolean between two mirrored objects stays between their copies.
            m.type === 'boolean' && m.targetId !== null && copyOf.has(m.targetId)
              ? { ...m, id: newId(), targetId: copyOf.get(m.targetId)! }
              : { ...m, id: newId() },
          ),
        };
      });
      const newIds = copies.map((c) => c.id);
      updateDocState(ctx, (s) => ({
        ...stateWithObjects(s, copies),
        order: [...s.order, ...newIds],
        selection: newIds,
        activeId: newIds.at(-1) ?? null,
        edit: null,
      }));
      return {
        ids: newIds,
        objects: copies.map(brief),
        bounds: boundsOf(docState(ctx), newIds),
        ...keysNotAdjusted(state, ids, 'the mirrored copies are NOT animated (a mirrored motion is not derived); they stand at the mirrored static pose.'),
      };
    },
  }),

  defineCommand({
    id: 'scene.add_mesh',
    title: 'Netz aus Daten hinzufügen',
    description:
      'Create an object from raw mesh data in one call and select it. `positions`: the vertices in the LOCAL space of the new object (meters, Y up), ' +
      'either flat [x0, y0, z0, x1, y1, z1, ...] or as [[x, y, z], ...]. `faces`: one array of vertex indices (0-based) per face, 3 or more per face (triangles, quads, n-gons), ' +
      'listed COUNTER-CLOCKWISE seen from outside - the winding decides where the normal points. ' +
      '`uvs` (optional): per face one flat array [u0, v0, u1, v1, ...] with a (u, v) pair for every corner of that face in the same order (v up, usually 0..1). ' +
      '`position` / `rotation` (Euler XYZ degrees) / `scale` place the object in the world. Limits: at most 2,000,000 vertices and 2,000,000 faces; all numbers finite; ' +
      'every face needs at least 3 different vertices that exist. ' +
      'Returns id, name, mesh statistics, world `bounds` and `check` with `warnings`: a list of English sentences from a manifold check ' +
      '(open edges, faces wound against their neighbours with their indices, inside-out meshes, non-manifold edges, faces without area, unused vertices). ' +
      'An empty `warnings` list means a clean, closed, consistently outward-facing mesh. Warnings do not prevent the object from being created. One undo step.',
    params: z.object({
      name: z.string().min(1).optional(),
      positions: z
        .union([z.array(num).max(MAX_ELEMENTS * 3), z.array(vec3).max(MAX_ELEMENTS)])
        .describe('Vertex positions in local space: flat [x, y, z, x, y, z, ...] or [[x, y, z], ...].'),
      faces: z
        .array(z.array(z.number().int().nonnegative()))
        .max(MAX_ELEMENTS)
        .describe('Per face the indices of its vertices, counter-clockwise seen from outside.'),
      uvs: z.array(z.array(num)).max(MAX_ELEMENTS).optional().describe('Per face a flat [u, v, u, v, ...] array, one pair per corner.'),
      position: vec3.default([0, 0, 0]),
      rotation: vec3.default([0, 0, 0]).describe('Euler XYZ in degrees'),
      scale: scaleParam.default([1, 1, 1]),
      groupId: z.string().nullable().default(null).describe('Group (id or name) to add the object to. Default: top level.'),
      materialId: z.string().nullable().default(null).describe('Material (id or name) of the object. Default: none.'),
      smooth: z.boolean().default(false).describe('Smooth shading (averaged vertex normals) instead of flat.'),
    }),
    run(ctx, p) {
      const state = docState(ctx);
      const groupId = p.groupId === null ? null : resolveGroupId(state, p.groupId);
      const materialId = p.materialId === null ? null : resolveMaterialId(state, p.materialId);
      const positions = (typeof p.positions[0] === 'number' ? p.positions : (p.positions as Vec3[]).flat()) as number[];
      const parsed = polyMeshSchema.safeParse({ positions, faces: p.faces, ...(p.uvs ? { uvs: p.uvs } : {}) });
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue.path.length > 0 ? ` (at ${issue.path.join('.')})` : '';
        throw new Error(`Invalid mesh: ${issue.message}${where}`);
      }
      const vertexCount = positions.length / 3;
      if (vertexCount > MAX_ELEMENTS) throw new Error(`Invalid mesh: at most ${MAX_ELEMENTS} vertices are allowed`);
      if (vertexCount < 3 || p.faces.length === 0) throw new Error('Invalid mesh: at least 3 vertices and one face are needed');
      p.faces.forEach((face, f) => {
        if (new Set(face).size < 3) throw new Error(`Invalid mesh: face ${f} [${face.slice(0, 8).join(', ')}] needs at least 3 different vertices`);
      });
      const scale = toVec3(p.scale);
      const mesh: PolyMesh = p.uvs ? { positions, faces: p.faces, uvs: p.uvs } : { positions, faces: p.faces };
      const obj: SceneObject = {
        id: newId(),
        name: uniqueName(objectNames(state), p.name ?? 'Netz'),
        visible: true,
        transform: { position: p.position, rotation: p.rotation, scale },
        mesh,
        modifiers: [],
        smooth: p.smooth,
        groupId,
        materialId,
      };
      updateDocState(ctx, (s) => ({
        ...stateWithObjects(s, [obj]),
        order: [...s.order, obj.id],
        selection: [obj.id],
        activeId: obj.id,
        edit: null,
      }));
      const check = checkMesh(mesh);
      return {
        id: obj.id,
        name: obj.name,
        groupId,
        materialId,
        transform: obj.transform,
        ...meshStats(mesh),
        bounds: boundsOf(docState(ctx), [obj.id]),
        check: {
          closed: check.closed,
          openEdges: check.openEdges,
          nonManifoldEdges: check.nonManifoldEdges,
          flippedFaces: check.flippedFaces,
          flippedFaceCount: check.flippedFaceCount,
        },
        warnings: check.warnings,
      };
    },
  }),

  defineCommand({
    id: 'scene.boolean',
    title: 'Boolesche Operation',
    description:
      'One-shot boolean on an object (`objectId`, default: the active object): difference (default; cut the other shape out of the object), union (fuse) or intersect (keep the common volume). ' +
      'Give exactly ONE of: `targetId` (an existing object) or `cutter` (a temporary primitive described inline: `type` plus the shape parameters of scene.add_primitive, ' +
      'and `position` / `rotation` (Euler XYZ degrees) / `scale` in WORLD space, meters) - e.g. a cylinder cutter to drill a hole without creating and deleting a helper object. ' +
      'With `apply` true (default) the result is baked into the base mesh of the object (as modifier.apply does: the boolean acts on the base mesh, before any other modifiers of the object) ' +
      'and the target object is deleted (the cutter never appears) unless `keepTarget` is true. The baked mesh is triangulated and has no UVs (`uvsDropped`). Not allowed while the object is in edit mode. ' +
      'With `apply` false a non-destructive boolean modifier is added instead and the target (or the cutter, which then becomes a real object) is hidden; the result contains `modifierId` and `targetId`. ' +
      'Both meshes must be closed manifolds (watertight, no open edges). If the operation fails or the result would be empty, the command fails with the reason and the document is NOT changed. ' +
      'Afterwards the object is the selection and the active object. Returns objectId, name, mesh statistics of the result, world `bounds` and `removed` (ids of deleted objects). One undo step.',
    params: z.object({
      objectId: z.string().optional().describe('The object that is modified (id or name). Default: the active object.'),
      operation: z.enum(booleanOperations).default('difference').describe('difference = object minus target/cutter.'),
      targetId: z.string().optional().describe('The other object (id or name). Its mesh after its own modifiers is used.'),
      cutter: z
        .object({
          type: z.enum(primitiveTypes),
          position: vec3.default([0, 0, 0]).describe('World-space position of the centre of the primitive.'),
          rotation: vec3.default([0, 0, 0]).describe('Euler XYZ in degrees (world space).'),
          scale: scaleParam.default([1, 1, 1]),
          ...primitiveShape,
        })
        .optional()
        .describe('A temporary primitive in WORLD space to use instead of targetId.'),
      apply: z.boolean().default(true).describe('true: bake the result; false: add a boolean modifier and hide the target.'),
      keepTarget: z.boolean().default(false).describe('With apply: keep the target object (or keep the cutter as a new object) instead of removing it.'),
    }),
    async run(ctx, p) {
      if ((p.targetId === undefined) === (p.cutter === undefined)) throw new Error('Give exactly one of targetId or cutter');
      try {
        await initModifiers();
      } catch {
        throw new Error('The boolean engine failed to load');
      }
      const state = docState(ctx);
      const id = p.objectId !== undefined ? resolveObjectId(state, p.objectId) : state.activeId;
      if (!id || !own(state.objects, id)) throw new Error('No objectId given and there is no active object');
      const object = state.objects[id];
      if (p.apply && state.edit?.objectId === id) throw new Error('Cannot bake a boolean while the object is in edit mode; call edit.exit first (or pass apply: false)');

      let target: SceneObject;
      const isCutter = p.cutter !== undefined;
      if (p.cutter) {
        const { type, position, rotation, scale, ...shape } = p.cutter;
        if (toVec3(scale).some((s) => s === 0)) throw new Error('The cutter scale must not be 0');
        target = {
          id: newId(),
          name: uniqueName(objectNames(state), 'Schnittkörper'),
          visible: true,
          transform: { position, rotation, scale: toVec3(scale) },
          mesh: createPrimitive(type, shape),
          modifiers: [],
          smooth: false,
          groupId: object.groupId,
          materialId: null,
        };
      } else {
        const targetId = resolveObjectId(state, p.targetId!);
        if (targetId === id) throw new Error('An object cannot be its own boolean target');
        target = state.objects[targetId];
      }
      const modifier: Modifier = { id: newId(), enabled: true, type: 'boolean', operation: p.operation, targetId: target.id };
      const fail = (reason: string) => new Error(`Boolean ${p.operation} failed: ${reason}. The document was not changed.`);

      let next: DocState;
      let removed: string[] = [];
      if (p.apply) {
        const virtual = isCutter ? stateWithObjects(state, [target]) : state;
        let mesh: PolyMesh;
        try {
          mesh = applyModifier(virtual, object, object.mesh, modifier);
        } catch (error) {
          throw fail(error instanceof Error ? error.message.replace(/\.$/, '') : String(error));
        }
        if (mesh.faces.length === 0) throw fail('the result is empty (nothing of the object would remain)');
        const objects = { ...state.objects, [id]: { ...object, mesh } };
        let order = state.order;
        if (isCutter && p.keepTarget) {
          objects[target.id] = target;
          order = [...order, target.id];
        } else if (!isCutter && !p.keepTarget) {
          delete objects[target.id];
          order = order.filter((o) => o !== target.id);
          removed = [target.id];
        }
        next = { ...state, objects, order, selection: [id], activeId: id, edit: null };
      } else {
        const hidden = { ...target, visible: false };
        next = {
          ...state,
          objects: { ...state.objects, [hidden.id]: hidden, [id]: { ...object, modifiers: [...object.modifiers, modifier] } },
          order: isCutter ? [...state.order, hidden.id] : state.order,
          selection: [id],
          activeId: id,
          edit: state.edit?.objectId === id ? state.edit : null,
        };
        const error = evaluateObject(next, id).errors[modifier.id];
        if (error) throw fail(error.replace(/\.$/, ''));
      }
      updateDocState(ctx, () => next);
      const now = docState(ctx);
      return {
        objectId: id,
        name: object.name,
        operation: p.operation,
        applied: p.apply,
        ...meshStats(p.apply ? now.objects[id].mesh : evaluateObject(now, id).mesh),
        bounds: boundsOf(now, [id]),
        removed,
        ...(p.apply ? (object.mesh.uvs ? { uvsDropped: true } : {}) : { modifierId: modifier.id }),
        ...(own(now.objects, target.id) ? { targetId: target.id } : {}),
      };
    },
  }),

  defineCommand({
    id: 'scene.raycast',
    title: 'Strahl schießen',
    description:
      'Shoot a ray through the scene and get the nearest surface point it hits - for placing parts on surfaces whose height or slope is not known ' +
      '(e.g. origin high above, direction [0, -1, 0] to find the ground or a roof). `origin` and `direction` are in WORLD space (Y up, meters); the direction need not be normalised. ' +
      'Tested are the VISIBLE objects (all of them, or only those in `ids`; hidden objects are never hit), with their meshes after modifiers; faces are hit from both sides. ' +
      '`maxDistance` (meters) limits the ray. Returns { hit: false } or { hit: true, objectId, name, point (world), normal (unit, world, the geometric normal of the hit face pointing to its outside), ' +
      'distance (meters from origin), faceIndex (index of the face in the mesh after modifiers; equals the base mesh face index for objects without modifiers), ' +
      'frontFacing (false if the face was hit from behind, i.e. the origin is inside the object or the face is flipped) }. Changes nothing.',
    params: z.object({
      origin: vec3.describe('World-space start of the ray.'),
      direction: vec3.describe('World-space direction (any length, not all zero).'),
      maxDistance: z.number().positive().optional().describe('Maximum distance in meters. Default: unlimited.'),
      ids: idsParam('Default: all visible objects.'),
    }),
    history: false,
    async run(ctx, p) {
      const length = Math.hypot(...p.direction);
      if (!(length > 0)) throw new Error('direction must not be [0, 0, 0]');
      const direction = p.direction.map((v) => v / length) as Vec3;
      const { state, ids } = await settle(ctx, (s) =>
        (p.ids === undefined ? s.order : resolveObjectIds(s, p.ids)).filter((id) => s.objects[id].visible),
      );
      const hit = raycast(state, ids, p.origin, direction, p.maxDistance);
      if (!hit) return { hit: false };
      return {
        hit: true,
        objectId: hit.objectId,
        name: state.objects[hit.objectId].name,
        point: roundVec3(hit.point),
        normal: roundVec3(hit.normal),
        distance: Math.round(hit.distance * 1e6) / 1e6,
        faceIndex: hit.faceIndex,
        frontFacing: hit.frontFacing,
      };
    },
  }),

  defineCommand({
    id: 'scene.get_bounds',
    title: 'Begrenzungsrahmen abfragen',
    description:
      'World-space axis-aligned bounding boxes (meters, Y up) of objects, computed from their meshes after modifiers and their transforms. ' +
      'Targets: `ids` plus all objects inside `groupId` (nested groups included); with neither, ALL objects of the document. ' +
      'Returns `objects`: [{ id, name, visible, bounds: { min, max, center, size } }] (bounds is null for an object without vertices) and `bounds`: the union box of all of them (null if there is none). ' +
      'Use it to place things next to or on top of each other (e.g. the top of an object is bounds.max[1]). Changes nothing.',
    params: z.object({
      ids: idsParam('Default (if groupId is not given either): all objects.'),
      groupId: groupParam('all objects inside it, including nested groups.'),
    }),
    history: false,
    async run(ctx, p) {
      const { state, ids } = await settle(ctx, (s) => targets(s, p.ids, p.groupId, 'all'));
      return {
        objects: ids.map((id) => {
          const o = state.objects[id];
          return { id, name: o.name, visible: o.visible, bounds: boxOf(objectWorldBounds(state, id)) };
        }),
        bounds: boundsOf(state, ids),
      };
    },
  }),

  defineCommand({
    id: 'scene.check_overlaps',
    title: 'Überlappungen prüfen',
    description:
      'Find pairs of objects whose WORLD-space axis-aligned bounding boxes overlap. This is a BOUNDING-BOX test, not an exact mesh intersection: ' +
      'it reliably tells which objects are clearly apart, but two reported objects may still not touch (e.g. a sphere next to a box corner, or an L-shaped object around another), ' +
      'and rotated objects have larger boxes than their shape. Targets: `ids` plus all objects inside `groupId`; with neither, all VISIBLE objects. ' +
      'A pair is reported when the boxes overlap by MORE than `tolerance` meters on all three axes (default 0: boxes that only touch are not reported; ' +
      'a small positive value such as 0.001 ignores parts that are meant to sit flush or slightly sunk into each other; a negative value also reports boxes closer than that gap). ' +
      'Returns `pairs`: [{ a: { id, name }, b: { id, name }, overlap: { min, max, size }, volume }] sorted by overlap volume (cubic meters, largest first; at most `limit`), ' +
      '`total` (number of overlapping pairs) and `checked` (number of objects compared). Changes nothing.',
    params: z.object({
      ids: idsParam('Default (if groupId is not given either): all visible objects.'),
      groupId: groupParam('all objects inside it, including nested groups.'),
      tolerance: num.default(0).describe('Minimum overlap depth in meters on every axis.'),
      limit: z.number().int().min(1).max(5000).default(200).describe('Maximum number of pairs returned.'),
    }),
    history: false,
    async run(ctx, p) {
      const { state, ids } = await settle(ctx, (s) => targets(s, p.ids, p.groupId, 'visible'));
      const boxes = ids.map((id) => ({ id, box: objectWorldBounds(state, id) })).filter((b): b is { id: string; box: Bounds } => b.box !== null);
      const pairs: { a: string; b: string; min: Vec3; max: Vec3; volume: number }[] = [];
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i].box;
          const b = boxes[j].box;
          const min = a.min.map((v, k) => Math.max(v, b.min[k])) as Vec3;
          const max = a.max.map((v, k) => Math.min(v, b.max[k])) as Vec3;
          if (max[0] - min[0] > p.tolerance && max[1] - min[1] > p.tolerance && max[2] - min[2] > p.tolerance) {
            const volume = Math.max(0, max[0] - min[0]) * Math.max(0, max[1] - min[1]) * Math.max(0, max[2] - min[2]);
            pairs.push({ a: boxes[i].id, b: boxes[j].id, min, max, volume });
          }
        }
      }
      pairs.sort((x, y) => y.volume - x.volume);
      const ref = (id: string) => ({ id, name: state.objects[id].name });
      return {
        pairs: pairs.slice(0, p.limit).map((pair) => ({
          a: ref(pair.a),
          b: ref(pair.b),
          overlap: { min: pair.min, max: pair.max, size: roundVec3(pair.max.map((v, k) => v - pair.min[k])) },
          volume: Math.round(pair.volume * 1e9) / 1e9,
        })),
        total: pairs.length,
        checked: boxes.length,
      };
    },
  }),
];
