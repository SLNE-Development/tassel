import { z } from 'zod';
import { pruneAnimation } from '../animation';
import { originStep, stepDetail } from '../history';
import { commandAllowedIn, docFormat, formatError } from '../formats';
import { syncCuboids } from '../minecraft/cuboid';
import { activeDoc, own, withDoc } from '../state';
import type { AppState, DocFormat, DocState, HistoryStep, Services } from '../types';

export interface CommandContext {
  get(): AppState;
  set(update: (app: AppState) => AppState): void;
  services: Services;
}

/**
 * A command is the single way to change or query the editor. The UI, keyboard shortcuts and
 * the MCP server all go through the same commands.
 *
 * Undo is automatic: if a command changes a document's state, the previous state is pushed
 * onto that document's history. Set `history: false` for changes that should not be undoable
 * steps of their own (selection, undo/redo themselves).
 *
 * A result of the shape `{ image: { mimeType, base64 } }` is delivered to MCP clients as an image.
 */
export interface CommandDef<P extends z.ZodObject = z.ZodObject> {
  /** Dotted id, e.g. `scene.add_primitive`. The MCP tool name replaces the dot with an underscore. */
  id: string;
  /** Short German label for menus and the command palette. */
  title: string;
  /** English description for MCP clients. */
  description: string;
  params: P;
  history?: boolean;
  /**
   * For long-running commands that only read: other commands do not wait for this one to finish
   * (it still starts after the commands queued before it). Such a command must take what it needs
   * from the state when it starts, never write to the state, and have `history: false`.
   */
  concurrent?: boolean;
  /**
   * Document formats the command works in (core/formats.ts); absent = what `commandFormats` lists for its
   * id, which is every format for most commands. `runCommand` refuses the command in other documents, and
   * menus, the tool rail, the palette and the MCP descriptions follow the same rule.
   */
  formats?: readonly DocFormat[];
  run(ctx: CommandContext, params: z.infer<P>): unknown;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyCommand = CommandDef<any>;

export function defineCommand<P extends z.ZodObject>(def: CommandDef<P>): CommandDef<P> {
  return def;
}

export const vec3 = z.tuple([z.number(), z.number(), z.number()]);

/** Updates the active document's undoable state. */
export function updateDocState(ctx: CommandContext, update: (state: DocState) => DocState): void {
  ctx.set((app) => {
    const doc = activeDoc(app);
    // Cuboid elements keep their derived mesh (and a unit scale) whatever the command changed.
    const updated = syncCuboids(doc.state, update(doc.state));
    // Animation tracks cannot outlive their objects (whichever command deleted them).
    const next = updated.animation && updated.objects !== doc.state.objects ? pruneAnimation(updated) : updated;
    // Edit mode cannot outlive its object (deleted, or removed by undoing its creation elsewhere).
    const state = next.edit && !own(next.objects, next.edit.objectId) ? { ...next, edit: null } : next;
    return withDoc(app, { ...doc, state });
  });
}

export function docState(ctx: CommandContext): DocState {
  return activeDoc(ctx.get()).state;
}


/** Validates params, runs the command and records undo history for every document it changed. */
export async function runCommand(def: AnyCommand, ctx: CommandContext, rawParams: unknown): Promise<unknown> {
  const params = def.params.parse(rawParams ?? {});
  const doc = activeDoc(ctx.get());
  if (doc && !commandAllowedIn(def.id, def.formats, docFormat(doc.state))) throw formatError(def.id, def.formats, docFormat(doc.state), doc.name);
  const before = ctx.get().docs;
  const result = await def.run(ctx, params);
  const time = Date.now();
  const created = Object.values(ctx.get().docs).filter((doc) => !before[doc.id]);
  if (created.length > 0) {
    // A document this command created or opened starts its history with that command.
    ctx.set((app) => created.reduce((next, doc) => (next.docs[doc.id] ? withDoc(next, { ...next.docs[doc.id], step: originStep(def.id, time) }) : next), app));
  }
  if (def.history !== false) {
    ctx.set((app) => {
      let next = app;
      for (const doc of Object.values(app.docs)) {
        const prev = before[doc.id];
        if (prev && prev.state !== doc.state) {
          const limit = app.preferences.undoSteps;
          const detail = stepDetail(params, result, prev.state, doc.state);
          const step: HistoryStep = detail === undefined ? { command: def.id, time } : { command: def.id, detail, time };
          next = withDoc(next, {
            ...doc,
            dirty: true,
            past: [...prev.past, prev.state].slice(-limit),
            pastSteps: [...prev.pastSteps, prev.step].slice(-limit),
            future: [],
            futureSteps: [],
            step,
          });
        }
      }
      return next;
    });
  }
  return result ?? { ok: true };
}
