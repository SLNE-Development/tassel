import { own } from '../state';
import type { AppState } from '../types';
import { runCommand, type AnyCommand, type CommandContext } from './registry';

/**
 * Per-call document targeting: a command can be run against an open document that is not the
 * active (visible) one, so that several MCP clients can each build in their own tab.
 *
 * What a `documentId` means for a command:
 * - `scoped`: the command runs with a context in which that document is the active one, for reads
 *   and writes; which tab is visible does not change and undo history is recorded on that document.
 *   This includes the view.* commands: a screenshot renders that document off-screen, and the camera
 *   commands work on its remembered camera (see `ViewportService`).
 * - `visible-only`: the command changes a setting of the one viewport the user looks at (tool, shading);
 *   a `documentId` other than the visible document is rejected.
 * - `as-id`: the command already takes the document as `id`; `documentId` stands for it when `id` is missing.
 * - `as-param`: the command has a `documentId` parameter of its own and runs unscoped (it also needs to
 *   know which document is visible); the per-call `documentId` is handed to it as that parameter.
 * - `ignored`: the command is not tied to one document.
 */
export type DocumentTargeting = 'scoped' | 'visible-only' | 'as-id' | 'as-param' | 'ignored';

/** document.* commands whose optional `id` names the document they act on. */
const DOCUMENT_ID_COMMANDS = new Set(['document.close', 'document.rename', 'document.serialize', 'document.mark_saved']);

export function documentTargeting(commandId: string): DocumentTargeting {
  if (DOCUMENT_ID_COMMANDS.has(commandId)) return 'as-id';
  // The tool and the shading are settings of the whole app: what they change is what the user sees.
  if (commandId === 'view.set_tool' || commandId === 'view.set_shading') return 'visible-only';
  if (commandId === 'app.get_state') return 'as-param';
  if (commandId.startsWith('document.') || commandId.startsWith('preferences.') || commandId.startsWith('app.')) return 'ignored';
  return 'scoped';
}

/** Explains `documentId` to MCP clients; referenced from app.get_state and document.list. */
export const DOCUMENT_ID_HINT =
  'Every tool takes an optional top-level "documentId": the call then runs against that open document instead of the active (visible) one, without switching tabs, and its undo step is recorded on that document - so several agents can each build in their own document. The user can switch tabs at any time and calls without documentId act on whatever tab is visible at that moment, so to keep working on your model pass its id as documentId on every call. Calls from all clients run strictly one after another: they interleave at the granularity of single commands, never inside one. view_screenshot renders that document off-screen and view_get_camera / view_set_camera / view_set_view / view_frame work on its own remembered camera, all without changing what the user sees; view_set_tool and view_set_shading are settings of the whole app and reject a documentId that is not the visible document. document_* and preferences_* tools and the other app_* tools ignore it, except document_close / document_rename / document_serialize / document_mark_saved, where it stands for "id".';

/** One-line description of the `documentId` property in a tool's input schema. */
export function documentIdDescription(commandId: string): string {
  switch (documentTargeting(commandId)) {
    case 'scoped':
      return 'Optional: id of an open document (see document_list) to act on instead of the active one, without switching tabs. Ids and names in the other parameters are then looked up in that document.';
    case 'visible-only':
      return 'Optional. This tool changes a setting of the whole app, i.e. what the user sees: a documentId other than the visible document is rejected.';
    case 'as-param':
      return 'Optional: id of an open document (see document_list) to report on instead of the visible one.';
    case 'as-id':
      return 'Optional: the document to act on, same as "id" (used when "id" is not given).';
    case 'ignored':
      return 'Optional and ignored: this tool is not tied to one document.';
  }
}

export function requireOpenDocument(app: AppState, documentId: string) {
  const doc = own(app.docs, documentId);
  if (doc) return doc;
  const open = app.docOrder
    .slice(0, 10)
    .map((id) => `${id} (${JSON.stringify(app.docs[id].name)})`)
    .join(', ');
  const shown = documentId.length > 80 ? `${documentId.slice(0, 77)}...` : documentId;
  throw new Error(`Document "${shown}" does not exist: documentId must be the id of an open document. Open documents: ${open}${app.docOrder.length > 10 ? ', ...' : ''}`);
}

/**
 * A context in which `documentId` is the active document. Reads see it as active; writes are applied
 * to it and leave the really active document id (the visible tab) as it is.
 */
export function targetContext(ctx: CommandContext, documentId: string): CommandContext {
  const closed = () => new Error(`Document "${documentId}" was closed while the command was running`);
  return {
    services: ctx.services,
    get() {
      const app = ctx.get();
      if (app.activeDocId === documentId) return app;
      if (!own(app.docs, documentId)) throw closed();
      return { ...app, activeDocId: documentId };
    },
    set(update) {
      ctx.set((app) => {
        if (app.activeDocId === documentId) return update(app);
        if (!own(app.docs, documentId)) throw closed();
        const scoped = { ...app, activeDocId: documentId };
        const next = update(scoped);
        if (next === scoped) return app;
        // A command that deliberately activates another document keeps that; otherwise the visible tab stays.
        return next.activeDocId === documentId ? { ...next, activeDocId: app.activeDocId } : next;
      });
    },
  };
}

/**
 * `runCommand` with optional document targeting (see `DocumentTargeting`). Without `documentId` it is
 * exactly `runCommand`. Rejects if the document is not open or the command cannot act on a document
 * that is not visible.
 */
export function runCommandOn(def: AnyCommand, ctx: CommandContext, rawParams: unknown, documentId?: string): Promise<unknown> {
  if (documentId === undefined) return runCommand(def, ctx, rawParams);
  let target = ctx;
  let params = rawParams;
  try {
    const app = ctx.get();
    const doc = requireOpenDocument(app, documentId);
    switch (documentTargeting(def.id)) {
      case 'visible-only':
        if (documentId !== app.activeDocId) {
          throw new Error(
            `${def.id} changes a setting of the whole app (what the user sees in the visible document), but documentId "${documentId}" (${JSON.stringify(doc.name)}) is not the visible document. ` +
              (def.id === 'view.set_shading'
                ? 'To see that document in another shading, pass "shading" to view_screenshot: it applies to that picture only.'
                : 'Tools only matter for working with the mouse; there is nothing to set for a document in the background.') +
              ' To change the setting for the user, call it without documentId.',
          );
        }
        break;
      case 'as-id':
      case 'as-param': {
        const key = documentTargeting(def.id) === 'as-id' ? 'id' : 'documentId';
        const given = (rawParams ?? {}) as Record<string, unknown>;
        if (typeof given === 'object' && !Array.isArray(given) && given[key] === undefined) params = { ...given, [key]: documentId };
        break;
      }
      case 'scoped':
        if (documentId !== app.activeDocId) target = targetContext(ctx, documentId);
        break;
      case 'ignored':
        break;
    }
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
  return runCommand(def, target, params);
}
