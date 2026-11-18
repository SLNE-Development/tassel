import { create } from 'zustand';
import { commandsById } from '../core/commands';
import { runCommand, type CommandContext } from '../core/commands/registry';
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

/**
 * Runs a command by id. This is the single entry point for the UI, shortcuts and MCP.
 * Rejects with an Error (invalid params, unknown object, ...) that callers should show to the user.
 *
 * Commands run one at a time: while an asynchronous command (painting, baking, import) is still
 * working, later commands wait for it. Undo history is recorded by comparing the state before and
 * after a command, which is only correct if no other command changes the state in between.
 * When nothing is running, the command starts synchronously as before.
 */
export function execute(id: string, params?: unknown): Promise<unknown> {
  const def = commandsById.get(id);
  if (!def) return Promise.reject(new Error(`Unknown command "${id}"`));
  const start = () => runCommand(def, ctx, params);
  const result = tail ? tail.then(start) : start();
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
