import { create } from 'zustand';
import { commandsById } from '../core/commands';
import type { CommandContext } from '../core/commands/registry';
import { runCommandOn } from '../core/commands/targeting';
import { activeDoc, createAppState } from '../core/state';
import type { AppState, Doc, DocState, Services } from '../core/types';

/** The whole editor state. Read it with selectors; change it only through `execute`. */
export const useApp = create<AppState>(() => createAppState());

/** Services register themselves here when they are ready (viewport on mount, exporter at startup). */
export const services: Services = { viewport: null, exporter: null };

const ctx: CommandContext = {
  get: useApp.getState,
  set: (update) => useApp.setState(update, true),
  services,
};

/** The command currently running or queued last; null when idle. */
let tail: Promise<void> | null = null;

export interface ExecuteOptions {
  /**
   * Run the command against this open document instead of the active one, without switching the
   * visible tab: reads and writes see it as the active document and undo history is recorded on it.
   * View commands render that document off-screen and work on its remembered camera; the app-wide
   * view settings (tool, shading) reject a document that is not visible; document.* / preferences.* /
   * app.* ignore it or take it as their own parameter (see `documentTargeting` in core/commands/targeting.ts).
   */
  documentId?: string;
}

/**
 * Runs a command by id. This is the single entry point for the UI, shortcuts and MCP.
 * Rejects with an Error (invalid params, unknown object, ...) that callers should show to the user.
 *
 * Commands run one at a time: while an asynchronous command (painting, baking, import) is still
 * working, later commands wait for it. Undo history is recorded by comparing the state before and
 * after a command, which is only correct if no other command changes the state in between.
 * When nothing is running, the command starts synchronously as before.
 * This also holds for commands with `options.documentId`: several MCP clients working in different
 * documents interleave at the granularity of whole commands.
 */
export function execute(id: string, params?: unknown, options?: ExecuteOptions): Promise<unknown> {
  const def = commandsById.get(id);
  if (!def) return Promise.reject(new Error(`Unknown command "${id}"`));
  // The target is checked when the command starts, not when it is queued: the visible tab may change in between.
  const start = () => runCommandOn(def, ctx, params, options?.documentId);
  const result = tail ? tail.then(start) : start();
  // A concurrent command (a render) runs beside the queue: nothing waits for it.
  if (def.concurrent) return result;
  const settled: Promise<void> = result.then(
    () => undefined,
    () => undefined,
  );
  tail = settled;
  void settled.then(() => {
    if (tail === settled) tail = null;
  });
  return result;
}

export const selectActiveDoc = (app: AppState): Doc => activeDoc(app);
export const selectDocState = (app: AppState): DocState => activeDoc(app).state;
