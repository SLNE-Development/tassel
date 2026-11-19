import { commandTitles } from '../i18n/en';
import type { Doc, DocState, HistoryStep } from './types';

// The labels of a document's undo snapshots, for the History panel and `history.list`.
//
// Every snapshot of a document (each entry of `past`, the current `state`, each entry of `future`)
// carries the step that produced it: `pastSteps`, `step` and `futureSteps` run parallel to them.
// The oldest snapshot is the document as it was created or opened (an "origin" step) until the
// history limit drops it; from then on the oldest one left is labelled with the command that made it.

/** Commands that create a document from nothing: their origin entry reads "New document", every other one "Opened". */
const NEW_DOCUMENT_COMMANDS = new Set(['document.new', 'document.close', 'document.new_item']);

export function originStep(command = 'document.new', time = Date.now()): HistoryStep {
  return { command, time, origin: true };
}

/** Whether an origin entry is a new document (else an opened or imported one). */
export function isNewDocumentOrigin(step: HistoryStep): boolean {
  return NEW_DOCUMENT_COMMANDS.has(step.command);
}

/**
 * An entry's label for MCP clients (English, like the tool descriptions); the UI builds its own in
 * the UI language (`historyLabel` in src/ui/history). `title` names a command by id.
 */
export function historyLabel(step: HistoryStep, title: (command: string) => string | undefined, origin: { newDocument: string; opened: string }): string {
  if (step.origin) return isNewDocumentOrigin(step) ? origin.newDocument : origin.opened;
  const name = title(step.command) ?? (step.command || '?');
  return step.detail ? `${name}: ${step.detail}` : name;
}

export const englishHistoryLabel = (step: HistoryStep): string => historyLabel(step, (id) => commandTitles[id], { newDocument: 'New Document', opened: 'Opened' });

export interface HistoryEntry {
  /** 0 = the oldest snapshot still kept. */
  readonly index: number;
  readonly step: HistoryStep;
  /** The document is at this snapshot now. */
  readonly current: boolean;
  /** Undone: after the current snapshot, dropped by the next change. */
  readonly undone: boolean;
}

/** A step for a snapshot whose step was not recorded (documents built by hand in tests or older code). */
const unknownStep: HistoryStep = { command: '', time: 0 };

/** `steps` cut or padded to `count`, keeping its newest (`fromEnd`) or oldest end; padding is `unknownStep`. */
function aligned(steps: readonly HistoryStep[] | undefined, count: number, fromEnd: boolean): HistoryStep[] {
  const list = steps ?? [];
  if (list.length === count) return [...list];
  if (fromEnd) return Array.from({ length: count }, (_, i) => list[list.length - count + i] ?? unknownStep);
  return Array.from({ length: count }, (_, i) => list[i] ?? unknownStep);
}

/** The document's history from the oldest snapshot to the newest undone one. */
export function historyEntries(doc: Doc): HistoryEntry[] {
  const past = aligned(doc.pastSteps, doc.past.length, true);
  const future = aligned(doc.futureSteps, doc.future.length, false);
  const steps = [...past, doc.step ?? unknownStep, ...future];
  const current = past.length;
  return steps.map((step, index) => ({ index, step, current: index === current, undone: index > current }));
}

/** Index of the current snapshot in `historyEntries`. */
export function currentHistoryIndex(doc: Doc): number {
  return doc.past.length;
}

/**
 * The document moved to snapshot `index` of `historyEntries` (as many undos or redos as that takes,
 * in one go). Returns the document itself when it is already there. Throws for an index out of range.
 */
export function gotoHistory(doc: Doc, index: number): Doc {
  const total = doc.past.length + 1 + doc.future.length;
  if (!Number.isInteger(index) || index < 0 || index >= total) throw new Error(`History index ${index} is out of range: the document has entries 0 to ${total - 1}`);
  const current = doc.past.length;
  if (index === current) return doc;
  const pastSteps = aligned(doc.pastSteps, doc.past.length, true);
  const futureSteps = aligned(doc.futureSteps, doc.future.length, false);
  const states: DocState[] = [...doc.past, doc.state, ...doc.future];
  const steps: HistoryStep[] = [...pastSteps, doc.step ?? unknownStep, ...futureSteps];
  return {
    ...doc,
    state: states[index],
    step: steps[index],
    past: states.slice(0, index),
    pastSteps: steps.slice(0, index),
    future: states.slice(index + 1),
    futureSteps: steps.slice(index + 1),
    dirty: true,
  };
}

// ---- details --------------------------------------------------------------------------------------

type Named = { readonly name: string };

function nameIn(state: DocState | undefined, id: unknown): string | undefined {
  if (!state || typeof id !== 'string') return undefined;
  const lookup = (map: Readonly<Record<string, Named>>) => (Object.hasOwn(map, id) ? map[id].name : undefined);
  return lookup(state.objects) ?? lookup(state.groups) ?? lookup(state.materials) ?? lookup(state.textures);
}

/** The single id an item list names (`[{ id }]` or `['id']`), if it names exactly one. */
function single(value: unknown): unknown {
  if (!Array.isArray(value) || value.length !== 1) return undefined;
  const [item] = value as unknown[];
  return typeof item === 'object' && item !== null && 'id' in item ? (item as { id: unknown }).id : item;
}

/**
 * A short detail for a step, cheap to find: the name of the one object (group, material, texture) the
 * command named or created. Undefined when there is none or several.
 */
export function stepDetail(params: unknown, result: unknown, before: DocState | undefined, after: DocState): string | undefined {
  const p = (typeof params === 'object' && params !== null ? params : {}) as Record<string, unknown>;
  const r = (typeof result === 'object' && result !== null ? result : {}) as Record<string, unknown>;
  const candidates = [p.id, p.objectId, p.textureId, p.materialId, p.groupId, single(p.ids), single(p.items), single(p.objects), r.id];
  for (const id of candidates) {
    const name = nameIn(after, id) ?? nameIn(before, id);
    if (name) return name;
  }
  // One object added (or removed) without being named in the parameters.
  if (before && after.order.length !== before.order.length && Math.abs(after.order.length - before.order.length) === 1) {
    const [larger, smaller] = after.order.length > before.order.length ? [after, before] : [before, after];
    const id = larger.order.find((o) => !Object.hasOwn(smaller.objects, o));
    const name = nameIn(larger, id);
    if (name) return name;
  }
  return undefined;
}
