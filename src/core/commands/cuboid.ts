import { z } from 'zod';
import { autoUv, createCuboid, cuboidSize, faceDimensions, modelBox, uvSize } from '../minecraft/cuboid';
import { direction, pxVec3, uvRect, uvRotation } from '../minecraft/schema';
import { MODEL_ORIGIN_PX, addVec, modelToWorld, subVec, tidy, worldToModel } from '../minecraft/space';
import { apply, eulerMatrix, mapDirection, mapFaces, matrixEuler, mirrorMatrix, multiply, quarterTurn, transpose, type Mat3 } from '../minecraft/transforms';
import { REFS_HINT, resolveGroupId, resolveObjectIds } from '../refs';
import { newId, own, uniqueName } from '../state';
import { cuboidFaces } from '../types';
import type { Cuboid, CuboidFace, CuboidFaceName, DocState, SceneObject, Texture, Vec3 } from '../types';
import { defineCommand, docState, updateDocState, type CommandContext } from './registry';

type CuboidObject = SceneObject & { cuboid: Cuboid };

const axisParam = z.enum(['x', 'y', 'z']);
const AXIS = { x: 0, y: 1, z: 2 } as const;

/** Everything about an element in model space (px), as the cuboid_* tools report it. */
export function elementInfo(obj: CuboidObject) {
  const { from, to, origin } = modelBox(obj);
  const { from: _f, to: _t, ...rest } = obj.cuboid;
  return { id: obj.id, name: obj.name, visible: obj.visible, groupId: obj.groupId, from, to, origin, rotation: obj.transform.rotation, ...rest };
}

/** The texture for an id or exact name. */
export function resolveTextureId(state: DocState, ref: string): string {
  if (own(state.textures, ref)) return ref;
  const byName = Object.values(state.textures).filter((t) => t.name === ref || t.java?.key === ref);
  if (byName.length === 1) return byName[0].id;
  if (byName.length > 1) throw new Error(`Texture name "${ref}" is ambiguous; use its id`);
  throw new Error(`Texture "${ref}" does not exist (see texture_list)`);
}

/** Cuboid elements for explicit refs, or the selected elements; non-elements in the selection are skipped. */
function targetElements(state: DocState, ids: readonly string[] | undefined): CuboidObject[] {
  const list = ids ? resolveObjectIds(state, ids) : state.selection;
  if (list.length === 0) throw new Error('No elements given and nothing is selected');
  const elements = list.map((id) => state.objects[id]).filter((o): o is CuboidObject => !!o?.cuboid);
  if (elements.length === 0) throw new Error('None of the given objects is a cuboid element');
  if (ids) {
    const notCuboid = list.find((id) => !state.objects[id]?.cuboid);
    if (notCuboid) throw new Error(`"${state.objects[notCuboid].name}" is not a cuboid element`);
  }
  return elements;
}

/** Writes changed elements back; locked elements are refused for geometry changes. */
function store(ctx: CommandContext, changed: readonly SceneObject[]) {
  updateDocState(ctx, (s) => {
    const objects = { ...s.objects };
    for (const obj of changed) if (own(objects, obj.id)) objects[obj.id] = obj;
    return { ...s, objects };
  });
  const state = docState(ctx);
  return { elements: changed.map((o) => elementInfo(state.objects[o.id] as CuboidObject)) };
}

function refuseLocked(elements: readonly CuboidObject[]) {
  const locked = elements.find((e) => e.cuboid.locked);
  if (locked) throw new Error(`"${locked.name}" is locked; unlock it first (cuboid_update locked: false)`);
}

/** An element with new model-space from / to and origin. */
function placed(obj: CuboidObject, from: Readonly<Vec3>, to: Readonly<Vec3>, origin: Readonly<Vec3>): CuboidObject {
  const lo: Vec3 = [Math.min(from[0], to[0]), Math.min(from[1], to[1]), Math.min(from[2], to[2])];
  const hi: Vec3 = [Math.max(from[0], to[0]), Math.max(from[1], to[1]), Math.max(from[2], to[2])];
  return {
    ...obj,
    transform: { ...obj.transform, position: modelToWorld(origin), scale: [1, 1, 1] },
    cuboid: { ...obj.cuboid, from: subVec(lo, origin).map(tidy) as Vec3, to: subVec(hi, origin).map(tidy) as Vec3 },
  };
}

/** Model-space bounds of elements (unrotated boxes). */
function boundsOf(elements: readonly CuboidObject[]): { min: Vec3; max: Vec3; center: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const e of elements) {
    const { from, to } = modelBox(e);
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], from[i], to[i]);
      max[i] = Math.max(max[i], from[i], to[i]);
    }
  }
  return { min, max, center: [0, 1, 2].map((i) => tidy((min[i] + max[i]) / 2)) as Vec3 };
}

/** Applies an orthogonal map (mirror or quarter turn) about `center` to an element. */
function transformed(obj: CuboidObject, m: Mat3, center: Readonly<Vec3>): CuboidObject {
  const { from, to, origin } = modelBox(obj);
  const map = (p: Readonly<Vec3>) => addVec(center, apply(m, subVec(p, center))).map(tidy) as Vec3;
  const moved = placed(obj, map(from), map(to), map(origin));
  // The element's own rotation is conjugated: geometry = origin + R p becomes M origin + (M R M^T) (M p).
  const rotation = matrixEuler(multiply(multiply(m, eulerMatrix(obj.transform.rotation)), transpose(m)));
  return {
    ...moved,
    transform: { ...moved.transform, rotation },
    cuboid: {
      ...moved.cuboid,
      faces: mapFaces(obj.cuboid, m),
      shadeDirectionOverride: mapDirection(m, obj.cuboid.shadeDirectionOverride),
    },
  };
}

const idsParam = z.array(z.string()).optional().describe(`Elements: ${REFS_HINT}. Defaults to the selected elements.`);
const facesParam = z
  .array(direction)
  .optional()
  .describe('Faces (north, east, south, west, up, down). Default: all six.');

const MC_HINT =
  'Coordinates are Minecraft model-space pixels: one block spans 0..16 on every axis (+X east, +Y up, +Z south); in the viewport 1 px = 1/16 m and model point [8, 0, 8] is the world origin.';

export const cuboidCommands = [
  defineCommand({
    id: 'cuboid.add',
    title: 'Würfel-Element hinzufügen',
    description: `Add a cuboid element to a Minecraft Java model and select it. ${MC_HINT} from/to are the opposite corners; origin is the rotation origin (pivot), default the centre of the box; rotation is Euler XYZ in degrees about the origin. Every face gets auto UV and the given texture (id, name or texture variable; default: the first texture of the document, or none). Returns the element as cuboid_get does.`,
    params: z.object({
      from: pxVec3.default([0, 0, 0]),
      to: pxVec3.default([16, 16, 16]),
      origin: pxVec3.optional(),
      rotation: pxVec3.default([0, 0, 0]).describe('Euler XYZ in degrees.'),
      name: z.string().min(1).default('cube'),
      texture: z.string().nullable().optional().describe('Texture for all faces; null = none. Default: the first texture.'),
      groupId: z.string().nullable().default(null).describe('Group (id or name) to add the element to. Default: top level.'),
    }),
    run(ctx, p) {
      const state = docState(ctx);
      const texture = p.texture === null ? null : p.texture !== undefined ? resolveTextureId(state, p.texture) : (firstTexture(state)?.id ?? null);
      const origin = p.origin ?? ([0, 1, 2].map((i) => tidy((p.from[i] + p.to[i]) / 2)) as Vec3);
      const cuboid = createCuboid(subVec(p.from, origin), subVec(p.to, origin), texture, uvSize(state));
      const obj: SceneObject = {
        id: newId(),
        name: uniqueName(
          Object.values(state.objects).map((o) => o.name),
          p.name,
        ),
        visible: true,
        transform: { position: modelToWorld(origin), rotation: p.rotation, scale: [1, 1, 1] },
        mesh: { positions: [], faces: [] },
        modifiers: [],
        smooth: false,
        groupId: p.groupId === null ? null : resolveGroupId(state, p.groupId),
        materialId: null,
        cuboid,
      };
      updateDocState(ctx, (s) => ({ ...s, objects: { ...s.objects, [obj.id]: obj }, order: [...s.order, obj.id], selection: [obj.id], activeId: obj.id, edit: null }));
      return elementInfo(docState(ctx).objects[obj.id] as CuboidObject);
    },
  }),

  defineCommand({
    id: 'cuboid.list',
    title: 'Elemente auflisten',
    description: `List the cuboid elements of a Minecraft Java model in outliner order with their model-space from, to, origin, rotation, inflate, rescale, shade, lightEmission, shadeDirectionOverride, locked, export, color and faces (enabled, texture id, uv [x1, y1, x2, y2] in UV pixels, rotation, tintIndex, cullface). ${MC_HINT}`,
    params: z.object({ ids: z.array(z.string()).optional().describe(`Only these elements: ${REFS_HINT}.`) }),
    history: false,
    run(ctx, p) {
      const state = docState(ctx);
      const ids = p.ids ? resolveObjectIds(state, p.ids) : state.order;
      return { elements: ids.map((id) => state.objects[id]).filter((o): o is CuboidObject => !!o.cuboid).map(elementInfo), uvSize: uvSize(state) };
    },
  }),

  defineCommand({
    id: 'cuboid.update',
    title: 'Element ändern',
    description: `Change properties of cuboid elements. ${MC_HINT} from / to set the box (model space); origin moves only the pivot (the box stays where it is); rotation is Euler XYZ in degrees (26.3+: any angle on all three axes). inflate grows the box by that many px on every side (written into from/to on export). lightEmission 0-15; shadeDirectionOverride shades every face as if it faced that direction (null = off). locked elements refuse geometry changes. export: false leaves the element out of the exported model. color: marker colour 0-7. Changing the box does not touch the UVs; call cuboid_uv with op "auto" for that.`,
    params: z.object({
      ids: idsParam,
      from: pxVec3.optional(),
      to: pxVec3.optional(),
      origin: pxVec3.optional(),
      rotation: pxVec3.optional(),
      inflate: z.number().finite().optional(),
      rescale: z.boolean().optional(),
      shade: z.boolean().optional(),
      lightEmission: z.number().int().min(0).max(15).optional(),
      shadeDirectionOverride: direction.nullable().optional(),
      locked: z.boolean().optional(),
      export: z.boolean().optional(),
      color: z.number().int().min(0).max(7).optional(),
    }),
    run(ctx, p) {
      const elements = targetElements(docState(ctx), p.ids);
      if (p.from || p.to || p.origin || p.rotation || p.inflate !== undefined) refuseLocked(elements.filter(() => p.locked !== false));
      return store(
        ctx,
        elements.map((obj) => {
          const box = modelBox(obj);
          let next = p.from || p.to || p.origin ? placed(obj, p.from ?? box.from, p.to ?? box.to, p.origin ?? box.origin) : obj;
          if (p.rotation) next = { ...next, transform: { ...next.transform, rotation: p.rotation } };
          const { ids: _i, from: _f, to: _t, origin: _o, rotation: _r, ...flags } = p;
          const set = Object.fromEntries(Object.entries(flags).filter(([, v]) => v !== undefined));
          return { ...next, cuboid: { ...next.cuboid, ...set } };
        }),
      );
    },
  }),

  defineCommand({
    id: 'cuboid.move',
    title: 'Elemente verschieben',
    description: `Move cuboid elements (box and pivot together) by an offset in model-space pixels. ${MC_HINT}`,
    params: z.object({ ids: idsParam, offset: pxVec3 }),
    run(ctx, p) {
      const elements = targetElements(docState(ctx), p.ids);
      refuseLocked(elements);
      return store(
        ctx,
        elements.map((obj) => {
          const { from, to, origin } = modelBox(obj);
          return placed(obj, addVec(from, p.offset), addVec(to, p.offset), addVec(origin, p.offset));
        }),
      );
    },
  }),

  defineCommand({
    id: 'cuboid.resize',
    title: 'Elemente skalieren',
    description: `Resize cuboid elements along one axis by "amount" pixels (negative shrinks). side "max" moves the +side (east / up / south), "min" the -side, "both" grows from the centre (each side by half the amount). The pivot stays. A size never goes below 0. ${MC_HINT}`,
    params: z.object({ ids: idsParam, axis: axisParam, amount: z.number().finite(), side: z.enum(['min', 'max', 'both']).default('max') }),
    run(ctx, p) {
      const elements = targetElements(docState(ctx), p.ids);
      refuseLocked(elements);
      const a = AXIS[p.axis];
      return store(
        ctx,
        elements.map((obj) => {
          const { from, to, origin } = modelBox(obj);
          const lo = [...from] as Vec3;
          const hi = [...to] as Vec3;
          const amount = Math.max(p.amount, -(hi[a] - lo[a]));
          if (p.side === 'max') hi[a] += amount;
          else if (p.side === 'min') lo[a] -= amount;
          else {
            lo[a] -= amount / 2;
            hi[a] += amount / 2;
          }
          return placed(obj, lo, hi, origin);
        }),
      );
    },
  }),

  defineCommand({
    id: 'cuboid.set_pivot',
    title: 'Drehpunkt setzen',
    description: `Set the rotation origin (pivot) of cuboid elements without moving their boxes: to a model-space point, or with "center" to the centre of each element's box. ${MC_HINT}`,
    params: z.object({ ids: idsParam, origin: pxVec3.optional(), center: z.boolean().default(false) }),
    run(ctx, p) {
      if (!p.origin && !p.center) throw new Error('Give origin or center: true');
      const elements = targetElements(docState(ctx), p.ids);
      refuseLocked(elements);
      return store(
        ctx,
        elements.map((obj) => {
          const { from, to } = modelBox(obj);
          const origin = p.center ? ([0, 1, 2].map((i) => tidy((from[i] + to[i]) / 2)) as Vec3) : p.origin!;
          return placed(obj, from, to, origin);
        }),
      );
    },
  }),

  defineCommand({
    id: 'cuboid.flip',
    title: 'Elemente spiegeln',
    description: `Mirror cuboid elements along an axis about the centre of their common bounds (or, with around "block", about the block centre 8). Faces, UVs, cullfaces and rotations are mirrored with them, so the textures read mirrored as in Blockbench. ${MC_HINT}`,
    params: z.object({ ids: idsParam, axis: axisParam, around: z.enum(['selection', 'block']).default('selection') }),
    run(ctx, p) {
      const elements = targetElements(docState(ctx), p.ids);
      refuseLocked(elements);
      const center: Vec3 = p.around === 'block' ? [8, 8, 8] : boundsOf(elements).center;
      return store(ctx, elements.map((obj) => transformed(obj, mirrorMatrix(p.axis), center)));
    },
  }),

  defineCommand({
    id: 'cuboid.rotate90',
    title: 'Elemente um 90° drehen',
    description: `Turn cuboid elements by 90 degrees about an axis through the centre of their common bounds (around "block": the block centre 8, 8, 8). direction 1 is counter-clockwise looking down the positive axis, -1 clockwise. Boxes, pivots, faces with their UVs and cullfaces turn along. ${MC_HINT}`,
    params: z.object({ ids: idsParam, axis: axisParam, direction: z.union([z.literal(1), z.literal(-1)]).default(1), around: z.enum(['selection', 'block']).default('selection') }),
    run(ctx, p) {
      const elements = targetElements(docState(ctx), p.ids);
      refuseLocked(elements);
      const center: Vec3 = p.around === 'block' ? [8, 8, 8] : boundsOf(elements).center;
      return store(ctx, elements.map((obj) => transformed(obj, quarterTurn(p.axis, p.direction), center)));
    },
  }),

  defineCommand({
    id: 'cuboid.center',
    title: 'Elemente zentrieren',
    description: `Move cuboid elements together so that the centre of their common bounds lies on the block centre (8) on the given axes. Default axes: x and z (horizontally). ${MC_HINT}`,
    params: z.object({ ids: idsParam, axes: z.array(axisParam).min(1).default(['x', 'z']) }),
    run(ctx, p) {
      const elements = targetElements(docState(ctx), p.ids);
      refuseLocked(elements);
      const { center } = boundsOf(elements);
      const offset: Vec3 = [0, 0, 0];
      for (const axis of p.axes) offset[AXIS[axis]] = tidy(8 - center[AXIS[axis]]);
      return store(
        ctx,
        elements.map((obj) => {
          const { from, to, origin } = modelBox(obj);
          return placed(obj, addVec(from, offset), addVec(to, offset), addVec(origin, offset));
        }),
      );
    },
  }),

  defineCommand({
    id: 'cuboid.set_face',
    title: 'Flächen ändern',
    description:
      'Change faces of cuboid elements: enabled (false removes the face from the model), texture (id, name or texture variable; null = none), uv [x1, y1, x2, y2] in UV pixels (the document texture size; x1 > x2 mirrors), rotation (0/90/180/270, clockwise), tintIndex (integer; null = no tint) and cullface (north/east/south/west/up/down; null = none). Only the given fields change, on the given faces (default: all six).',
    params: z.object({
      ids: idsParam,
      faces: facesParam,
      enabled: z.boolean().optional(),
      texture: z.string().nullable().optional(),
      uv: uvRect.optional(),
      rotation: uvRotation.optional(),
      tintIndex: z.number().int().min(0).nullable().optional(),
      cullface: direction.nullable().optional(),
    }),
    run(ctx, p) {
      const state = docState(ctx);
      const elements = targetElements(state, p.ids);
      const patch: { -readonly [K in keyof CuboidFace]?: CuboidFace[K] } = {};
      if (p.enabled !== undefined) patch.enabled = p.enabled;
      if (p.texture !== undefined) patch.texture = p.texture === null ? null : resolveTextureId(state, p.texture);
      if (p.uv) patch.uv = p.uv;
      if (p.rotation !== undefined) patch.rotation = p.rotation;
      if (p.tintIndex !== undefined) patch.tintIndex = p.tintIndex;
      if (p.cullface !== undefined) patch.cullface = p.cullface;
      return store(ctx, elements.map((obj) => withFaces(obj, p.faces ?? cuboidFaces, (face) => ({ ...face, ...patch }))));
    },
  }),

  defineCommand({
    id: 'cuboid.uv',
    title: 'UV bearbeiten',
    description:
      'UV operations on faces of cuboid elements (default: all six faces). op: "auto" sizes each face\'s UV to the face (1 model px = 1 UV px), keeping its corner; "maximize" fills the whole texture (0, 0 to the texture size); "mirror_x" / "mirror_y" flip the UV horizontally / vertically; "rotate" turns the texture on the face by 90 degrees clockwise; "apply_to_all" copies the UV, rotation and texture of the face "source" to the given faces; "clear_rotation" sets rotation 0.',
    params: z.object({
      ids: idsParam,
      faces: facesParam,
      op: z.enum(['auto', 'maximize', 'mirror_x', 'mirror_y', 'rotate', 'apply_to_all', 'clear_rotation']),
      source: direction.optional().describe('apply_to_all: the face to copy from.'),
    }),
    run(ctx, p) {
      const state = docState(ctx);
      const size = uvSize(state);
      const elements = targetElements(state, p.ids);
      const faces = p.faces ?? cuboidFaces;
      if (p.op === 'apply_to_all' && !p.source) throw new Error('apply_to_all needs "source", the face to copy from');
      return store(
        ctx,
        elements.map((obj) => {
          if (p.op === 'auto') return { ...obj, cuboid: autoUv(obj.cuboid, size, faces) };
          const src = p.source ? obj.cuboid.faces[p.source] : null;
          return withFaces(obj, faces, (face) => {
            const [x1, y1, x2, y2] = face.uv;
            switch (p.op) {
              case 'maximize':
                return { ...face, uv: [0, 0, size[0], size[1]] };
              case 'mirror_x':
                return { ...face, uv: [x2, y1, x1, y2] };
              case 'mirror_y':
                return { ...face, uv: [x1, y2, x2, y1] };
              case 'rotate':
                return { ...face, rotation: ((face.rotation + 90) % 360) as CuboidFace['rotation'] };
              case 'clear_rotation':
                return { ...face, rotation: 0 };
              default:
                return { ...face, uv: src!.uv, rotation: src!.rotation, texture: src!.texture };
            }
          });
        }),
      );
    },
  }),

  defineCommand({
    id: 'cuboid.auto_cullface',
    title: 'Cullfaces automatisch setzen',
    description:
      'Set the cullface of every face of unrotated cuboid elements that lies on the outside of the block (x/y/z = 0 or 16) to that side, and clear it on all other faces, as Blockbench\'s "Set Cullfaces Automatically". Rotated elements are left as they are.',
    params: z.object({ ids: idsParam }),
    run(ctx, p) {
      const elements = targetElements(docState(ctx), p.ids);
      return store(
        ctx,
        elements.map((obj) => {
          if (obj.transform.rotation.some((r) => r !== 0)) return obj;
          const { from, to } = modelBox(obj);
          const inf = obj.cuboid.inflate;
          const onSide: Record<CuboidFaceName, boolean> = {
            west: from[0] - inf === 0,
            east: to[0] + inf === 16,
            down: from[1] - inf === 0,
            up: to[1] + inf === 16,
            north: from[2] - inf === 0,
            south: to[2] + inf === 16,
          };
          return withFaces(obj, cuboidFaces, (face, name) => ({ ...face, cullface: onSide[name] ? name : null }));
        }),
      );
    },
  }),

  defineCommand({
    id: 'cuboid.remove_blank_faces',
    title: 'Leere Flächen entfernen',
    description:
      'Disable the faces of cuboid elements that would show nothing: faces without a texture, faces whose UV rectangle has no area, and faces whose texture is fully transparent inside their UV rectangle. Returns the number of faces removed.',
    params: z.object({ ids: idsParam }),
    async run(ctx, p) {
      const state = docState(ctx);
      const size = uvSize(state);
      const elements = targetElements(state, p.ids);
      const blank = new Map<string, Set<CuboidFaceName>>();
      for (const obj of elements) {
        const set = new Set<CuboidFaceName>();
        for (const name of cuboidFaces) {
          const face = obj.cuboid.faces[name];
          if (!face.enabled) continue;
          const [x1, y1, x2, y2] = face.uv;
          const texture: Texture | undefined = face.texture === null ? undefined : own(state.textures, face.texture);
          if (!texture || x1 === x2 || y1 === y2) set.add(name);
          else if (ctx.services.imaging?.regionTransparent) {
            // UV px -> texture px.
            const sx = texture.width / size[0];
            const sy = texture.height / size[1];
            const rect = { x: Math.min(x1, x2) * sx, y: Math.min(y1, y2) * sy, width: Math.abs(x2 - x1) * sx, height: Math.abs(y2 - y1) * sy };
            if (await ctx.services.imaging.regionTransparent(texture, rect)) set.add(name);
          }
        }
        blank.set(obj.id, set);
      }
      let removed = 0;
      const changed = elements.map((obj) => {
        const set = blank.get(obj.id)!;
        removed += set.size;
        return withFaces(obj, [...set], (face) => ({ ...face, enabled: false }));
      });
      return { removed, ...store(ctx, changed) };
    },
  }),
];

function withFaces(obj: CuboidObject, names: readonly CuboidFaceName[], update: (face: CuboidFace, name: CuboidFaceName) => CuboidFace): CuboidObject {
  const faces = { ...obj.cuboid.faces };
  for (const name of names) faces[name] = update(faces[name], name);
  return { ...obj, cuboid: { ...obj.cuboid, faces } };
}

function firstTexture(state: DocState): Texture | undefined {
  return Object.values(state.textures)[0];
}

// Re-exported for the UI (the properties panel shows face sizes).
export { cuboidSize, faceDimensions, MODEL_ORIGIN_PX, worldToModel };
