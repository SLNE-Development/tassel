// Result building blocks shared by commands: what an AI client needs to know about the objects a command touched.
import { describeBounds, objectWorldBounds, worldBounds } from '../bounds';
import { initModifiers } from '../modifiers/evaluate';
import type { DocState } from '../types';
import { docState, type CommandContext } from './registry';

/** World-space `{ min, max, center, size }` of the objects' evaluated meshes, or null without vertices. */
export function boundsResult(state: DocState, ids: readonly string[]) {
  const bounds = worldBounds(state, ids);
  return bounds ? describeBounds(bounds) : null;
}

/**
 * `{ objects: [{ id, name, transform, bounds }], bounds }` for objects of the current document state:
 * per object its world bounds, plus the union. Loads the boolean engine first if one of them needs it.
 */
export async function objectResults(ctx: CommandContext, ids: readonly string[]) {
  if (ids.some((id) => docState(ctx).objects[id]?.modifiers.some((m) => m.type === 'boolean' && m.enabled))) {
    await initModifiers().catch(() => {});
  }
  const state = docState(ctx);
  const present = ids.filter((id) => Object.hasOwn(state.objects, id));
  return {
    objects: present.map((id) => {
      const o = state.objects[id];
      const bounds = objectWorldBounds(state, id);
      return { id, name: o.name, transform: o.transform, bounds: bounds ? describeBounds(bounds) : null };
    }),
    bounds: boundsResult(state, present),
  };
}
