import { useRef } from 'react';
import { create } from 'zustand';
import { execute, useApp } from '../app/store';
import { activeDoc } from '../core/state';
import type { DocState } from '../core/types';
import { notifyError } from './toast';

type Params = Record<string, unknown>;

/**
 * One undoable change that can be re-run with other parameters: every re-run first undoes its
 * own previous run, so however often it is applied, the document ends up with one undo step.
 * It only ever undoes its own change: once anything else has touched the document, the next
 * `apply` is simply a new change.
 */
export class LiveEdit {
  /** Parameters of the last run that succeeded. */
  params: Params = {};
  /** True between the undo and the re-run, when the document is not what this edit left behind. */
  busy = false;
  /** Whether the last run changed the document (and so left an undo step). */
  applied = false;
  private docId: string | null = null;
  private state: DocState | null = null;
  private pending: { id: string; params: Params } | null = null;
  private draining: Promise<void> | null = null;

  /** True while the document is exactly what this edit's last run left behind. */
  intact(): boolean {
    const doc = activeDoc(useApp.getState());
    return doc.id === this.docId && doc.state === this.state;
  }

  /** Runs the command, replacing this edit's previous run. Rejects if the command fails. */
  async run(id: string, params: Params): Promise<void> {
    // Undo only what is ours: the last run changed the document and nothing else has since.
    const replace = this.applied && this.intact();
    this.busy = true;
    try {
      if (replace) await execute('history.undo');
      const before = activeDoc(useApp.getState());
      try {
        await execute(id, params);
      } catch (error) {
        // Put our previous run back; it stays the one this edit owns.
        if (replace) await execute('history.redo');
        throw error;
      }
      const after = activeDoc(useApp.getState());
      this.docId = after.id;
      this.state = after.state;
      this.applied = after.id === before.id && after.state !== before.state;
      this.params = params;
    } finally {
      this.busy = false;
    }
  }

  /**
   * Like `run`, for streams of changes (scrubbing): calls that arrive while one is running are
   * collapsed to the latest. Errors go to a toast. Resolves when everything queued has run.
   */
  apply(id: string, params: Params): Promise<void> {
    this.pending = { id, params };
    this.draining ??= this.drain().finally(() => (this.draining = null));
    return this.draining;
  }

  private async drain(): Promise<void> {
    while (this.pending) {
      const { id, params } = this.pending;
      this.pending = null;
      await this.run(id, params).catch(notifyError);
    }
  }
}

/**
 * For scrub fields: `scrub` previews every value of one drag through a command, `end` closes the
 * drag. Whatever happened in between is one undo step.
 */
export function useLiveEdit(): { scrub(id: string, params: Params): void; end(): void } {
  const edit = useRef<LiveEdit | null>(null);
  return {
    scrub: (id, params) => void (edit.current ??= new LiveEdit()).apply(id, params),
    end: () => {
      edit.current = null;
    },
  };
}

// --- "Letzte Aktion" -------------------------------------------------------------------------

export interface LastOp {
  commandId: string;
  /** Overrides the command's title in the panel, e.g. the primitive's name. */
  title?: string;
  params: Params;
}

/** The operation whose parameters the "Letzte Aktion" panel shows, or null. */
export const useLastOp = create<{ op: LastOp | null }>(() => ({ op: null }));

let lastEdit: LiveEdit | null = null;

function forget(): void {
  lastEdit = null;
  if (useLastOp.getState().op) useLastOp.setState({ op: null });
}

// The panel may only ever redo its own operation: drop it as soon as anything else changes the document.
useApp.subscribe(() => {
  if (lastEdit && !lastEdit.busy && !lastEdit.intact()) forget();
});

/** Runs an operation and offers its parameters in the "Letzte Aktion" panel. Rejects if it fails. */
export async function runOp(commandId: string, params: Params = {}, title?: string): Promise<void> {
  forget();
  const edit = new LiveEdit();
  await edit.run(commandId, params);
  // Offered even if nothing changed: another value (a larger merge distance, say) may well do something.
  lastEdit = edit;
  useLastOp.setState({ op: { commandId, title, params } });
}

/** Re-runs the last operation with other parameters. Still one undo step. */
export function tweakOp(params: Params): void {
  const edit = lastEdit;
  const op = useLastOp.getState().op;
  if (!edit || !op) return;
  useLastOp.setState({ op: { ...op, params } });
  void edit.apply(op.commandId, params).then(() => {
    // A failed run leaves the previous one in place; show its values again.
    const current = useLastOp.getState().op;
    if (lastEdit === edit && current && current.params !== edit.params) useLastOp.setState({ op: { ...current, params: edit.params } });
  });
}
