// Parent models of Minecraft Java documents: show the parent chain read-only, merge it in, or keep the reference only.
import { z } from 'zod';
import { inheritedSummary, mergeInherited, ownVariables, normaliseId, resolveParentChain } from '../minecraft/parents';
import { textureLocation } from '../minecraft/javaExport';
import type { DocState } from '../types';
import { defineCommand, docState, updateDocState, type CommandContext } from './registry';
import { MINECRAFT_ONLY } from '../formats';

function requireJava(state: DocState) {
  if (!state.java) throw new Error('The document is not a Minecraft Java model');
  return state.java;
}

/** Reads the parent chain of the active document again and shows it. Returns the warnings. */
export async function refreshParent(ctx: CommandContext): Promise<string[]> {
  const state = docState(ctx);
  const java = requireJava(state);
  if (!java.parent.trim()) throw new Error('The model has no parent');
  const service = ctx.services.modelFiles;
  if (!service) throw new Error('Parent models cannot be read here (no file access)');
  const have = new Set(Object.values(state.textures).flatMap((t) => (t.java ? (normaliseId(textureLocation(t)) ?? []) : [])));
  const { inherited, warnings } = await resolveParentChain(java.parent, service.source(java.sourcePath ?? null), ownVariables(state), have);
  if (!inherited) throw new Error(warnings.join(' ') || `The parent model "${java.parent}" was not found`);
  updateDocState(ctx, (s) => ({ ...s, java: { ...s.java!, inherited } }));
  return warnings;
}

const parentResult = (ctx: CommandContext) => {
  const state = docState(ctx);
  return { parent: requireJava(state).parent, shown: !!state.java?.inherited, inherited: inheritedSummary(state) };
};

export const minecraftParentCommands = [
  defineCommand({
    id: 'minecraft.get_parent',
    title: 'Elternmodell abfragen',
    description:
      'Get the parent model of a Minecraft Java model and, if it is shown, what the parent chain provides: chain (nearest parent first), builtin ("generated" = item drawn from layer0..4, "entity", or null), elements (count), elementsOverridden (the model has its own elements, which replace the parent\'s in the game), textures (every texture variable resolved through the chain), displayContexts and missing (models or textures not found).',
    params: z.object({}),
    formats: MINECRAFT_ONLY,
    history: false,
    run(ctx) {
      return parentResult(ctx);
    },
  }),

  defineCommand({
    id: 'minecraft.show_parent',
    title: 'Elternmodell anzeigen',
    description:
      'Read the parent model chain of a Minecraft Java model (from the resource pack the model was opened from, the active project, then the vanilla Minecraft assets) and show what it provides read-only: the parent\'s elements when the model has none of its own, generated items (item/generated, item/handheld) as their flat extruded layer0..4 textures, inherited texture variables. Nothing of it is exported; the parent stays a reference. Also refreshes an already shown parent.',
    params: z.object({}),
    formats: MINECRAFT_ONLY,
    async run(ctx) {
      const warnings = await refreshParent(ctx);
      return { ...parentResult(ctx), warnings };
    },
  }),

  defineCommand({
    id: 'minecraft.hide_parent',
    title: 'Nur Elternverweis behalten',
    description: 'Stop showing the parent model of a Minecraft Java model: only the "parent" reference is kept (the exported file does not change).',
    params: z.object({}),
    formats: MINECRAFT_ONLY,
    run(ctx) {
      requireJava(docState(ctx));
      updateDocState(ctx, (s) => {
        const { inherited: _dropped, ...java } = s.java!;
        return { ...s, java };
      });
      return parentResult(ctx);
    },
  }),

  defineCommand({
    id: 'minecraft.merge_parent',
    title: 'Elternmodell übernehmen',
    description:
      'Make what the parent chain provides part of the Minecraft Java model itself: the parent\'s elements (only if the model has no elements of its own - in the game own elements replace the parent\'s), the textures they use and the display transforms the model does not set. The "parent" reference stays. Reads the parent first if it is not shown. Generated items have nothing to merge. Returns { elements, textures } added.',
    params: z.object({}),
    formats: MINECRAFT_ONLY,
    async run(ctx) {
      const warnings = docState(ctx).java?.inherited ? [] : await refreshParent(ctx);
      const result = mergeInherited(docState(ctx));
      updateDocState(ctx, () => result.state);
      return { elements: result.elements, textures: result.textures, warnings };
    },
  }),
];
