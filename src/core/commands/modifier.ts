import { z } from 'zod';
import { applyModifier, evaluateObject, initModifiers } from '../modifiers/evaluate';
import { modifierCommandParams, modifierParams } from '../modifiers/schema';
import { resolveObjectId } from '../refs';
import { newId, own } from '../state';
import { modifierTypes, type DocState, type Modifier, type ModifierType, type SceneObject } from '../types';
import { defineCommand, docState, updateDocState, type CommandContext } from './registry';

const objectIdParam = z.string().optional().describe('Object id or name (exact, or a glob matching exactly one object). Defaults to the active object.');

const paramNames = Object.keys(modifierCommandParams) as (keyof typeof modifierCommandParams)[];
type TypeParams = { [K in keyof typeof modifierCommandParams]?: z.infer<(typeof modifierCommandParams)[K]> };

function requireObject(state: DocState, objectId: string | undefined): SceneObject {
  const id = objectId === undefined ? state.activeId : resolveObjectId(state, objectId);
  if (!id) throw new Error('No objectId given and there is no active object');
  const object = own(state.objects, id);
  if (!object) throw new Error(`Object "${id}" does not exist`);
  return object;
}

function requireModifier(object: SceneObject, modifierId: string): Modifier {
  const modifier = object.modifiers.find((m) => m.id === modifierId);
  if (!modifier) throw new Error(`Object "${object.id}" has no modifier "${modifierId}"`);
  return modifier;
}

/** The given type parameters merged over `current`, validated. Rejects parameters of other modifier types. */
function mergeParams(state: DocState, object: SceneObject, type: ModifierType, current: object, given: TypeParams) {
  const shape = modifierParams[type].shape;
  const merged: Record<string, unknown> = { ...current };
  for (const name of paramNames) {
    if (given[name] === undefined) continue;
    if (!(name in shape)) {
      throw new Error(`"${name}" is not a parameter of a ${type} modifier (it has: ${Object.keys(shape).join(', ')})`);
    }
    merged[name] = name === 'axes' ? { ...(merged.axes as object), ...given.axes } : given[name];
  }
  if (type === 'boolean' && given.targetId != null) {
    // The target may be given by name; the modifier stores its id.
    const targetId = resolveObjectId(state, given.targetId);
    if (targetId === object.id) throw new Error('An object cannot be its own boolean target');
    merged.targetId = targetId;
  }
  return merged;
}

function setModifiers(ctx: CommandContext, objectId: string, modifiers: readonly Modifier[], mesh?: SceneObject['mesh']): void {
  updateDocState(ctx, (s) => ({
    ...s,
    objects: { ...s.objects, [objectId]: { ...s.objects[objectId], modifiers, ...(mesh ? { mesh } : {}) } },
  }));
}

/** Evaluates the object and reports the modifier's error, if it has one, so that callers see it right away. */
async function modifierError(ctx: CommandContext, objectId: string, modifier: Modifier): Promise<{ error?: string }> {
  if (!modifier.enabled) return {};
  if (modifier.type === 'boolean') {
    try {
      await initModifiers();
    } catch {
      return { error: 'The boolean engine failed to load' };
    }
  }
  const state = docState(ctx);
  if (!own(state.objects, objectId)) return {};
  const error = evaluateObject(state, objectId).errors[modifier.id];
  return error ? { error } : {};
}

export const modifierCommands = [
  defineCommand({
    id: 'modifier.add',
    title: 'Modifikator hinzufügen',
    description:
      'Add a non-destructive modifier to the end of an object\'s modifier stack. Modifiers are evaluated top to bottom on the base mesh in local space; the base mesh stays editable. Types: mirror (across local planes through the origin, welds the seam), subdivision (Catmull-Clark smoothing), array (count copies, each moved by offset and/or turned by rotation about pivot relative to the previous one: a row, a radial array with rotation [0, 360 / count, 0] and offset [0, 0, 0], or a spiral with both; offsetSpace "world" gives the offset in world meters along the world axes instead of local units, as the object stands at that moment - afterwards the copies move rigidly with the object, i.e. rotating or scaling it with any command turns / scales the row too and rewrites the stored offset. By default the array offset is in the LOCAL units of the object, i.e. before its scale and rotation: world offset = offset x object scale, turned with the object - an offset of 2 on an object with scale 0.5 moves each copy 1 m), boolean (union / difference / intersect with another object; both meshes must be closed manifolds). Pass only the parameters of the chosen type. Returns the modifier id, the objectId it was added to, and "error" if the modifier currently cannot be evaluated (it is then skipped).',
    params: z.object({ objectId: objectIdParam, type: z.enum(modifierTypes), ...modifierCommandParams }),
    async run(ctx, p) {
      const { objectId, type, ...given } = p;
      const state = docState(ctx);
      const object = requireObject(state, objectId);
      const defaults = modifierParams[type].parse({});
      const params = modifierParams[type].parse(mergeParams(state, object, type, defaults, given));
      const modifier = { id: newId(), enabled: true, type, ...params } as Modifier;
      setModifiers(ctx, object.id, [...object.modifiers, modifier]);
      return { id: modifier.id, objectId: object.id, ...(await modifierError(ctx, object.id, modifier)) };
    },
  }),

  defineCommand({
    id: 'modifier.update',
    title: 'Modifikator ändern',
    description:
      'Change parameters of a modifier and/or enable or disable it. Omitted parameters stay unchanged. An array offset with offsetSpace "world" is in world meters along the world axes for the object as it stands now; when the object is rotated or scaled later, the copies move rigidly with it and the stored offset is rewritten accordingly. Returns "error" if the modifier currently cannot be evaluated.',
    params: z.object({
      objectId: objectIdParam,
      modifierId: z.string(),
      enabled: z.boolean().optional().describe('Disabled modifiers are skipped but keep their settings.'),
      ...modifierCommandParams,
    }),
    async run(ctx, p) {
      const { objectId, modifierId, enabled, ...given } = p;
      const state = docState(ctx);
      const object = requireObject(state, objectId);
      const { id, enabled: wasEnabled, type, ...current } = requireModifier(object, modifierId);
      const params = modifierParams[type].parse(mergeParams(state, object, type, current, given));
      const modifier = { id, enabled: enabled ?? wasEnabled, type, ...params } as Modifier;
      setModifiers(
        ctx,
        object.id,
        object.modifiers.map((m) => (m.id === id ? modifier : m)),
      );
      return { id, objectId: object.id, ...(await modifierError(ctx, object.id, modifier)) };
    },
  }),

  defineCommand({
    id: 'modifier.remove',
    title: 'Modifikator entfernen',
    description: 'Remove a modifier from an object without applying it.',
    params: z.object({ objectId: objectIdParam, modifierId: z.string() }),
    run(ctx, p) {
      const object = requireObject(docState(ctx), p.objectId);
      requireModifier(object, p.modifierId);
      setModifiers(
        ctx,
        object.id,
        object.modifiers.filter((m) => m.id !== p.modifierId),
      );
      return { objectId: object.id, modifierId: p.modifierId };
    },
  }),

  defineCommand({
    id: 'modifier.move',
    title: 'Modifikator verschieben',
    description:
      'Move a modifier to another position in the stack (0 = first to be evaluated; values past the end move it to the end). The order matters: mirror then subdivision gives a different result than the reverse.',
    params: z.object({ objectId: objectIdParam, modifierId: z.string(), index: z.number().int().min(0) }),
    run(ctx, p) {
      const object = requireObject(docState(ctx), p.objectId);
      const modifier = requireModifier(object, p.modifierId);
      const rest = object.modifiers.filter((m) => m !== modifier);
      const index = Math.min(p.index, rest.length);
      if (object.modifiers[index] !== modifier) {
        setModifiers(ctx, object.id, [...rest.slice(0, index), modifier, ...rest.slice(index)]);
      }
      return { index };
    },
  }),

  defineCommand({
    id: 'modifier.apply',
    title: 'Modifikator anwenden',
    description:
      'Bake a modifier into the object\'s base mesh and remove it from the stack. The modifier is applied to the base mesh as if it were first in the stack, so apply modifiers from the top down to keep the result unchanged. Fails if the modifier cannot be evaluated (e.g. a boolean without a valid target) and while the object is in edit mode.',
    params: z.object({ objectId: objectIdParam, modifierId: z.string() }),
    async run(ctx, p) {
      const { id, modifiers } = requireObject(docState(ctx), p.objectId);
      if (modifiers.some((m) => m.id === p.modifierId && m.type === 'boolean')) await initModifiers();
      const state = docState(ctx);
      const object = requireObject(state, id);
      const modifier = requireModifier(object, p.modifierId);
      if (state.edit?.objectId === id) throw new Error('Cannot apply a modifier while the object is in edit mode; exit edit mode first');
      const mesh = applyModifier(state, object, object.mesh, modifier);
      setModifiers(
        ctx,
        id,
        object.modifiers.filter((m) => m !== modifier),
        mesh,
      );
      return { objectId: id, vertices: mesh.positions.length / 3, faces: mesh.faces.length };
    },
  }),
];
