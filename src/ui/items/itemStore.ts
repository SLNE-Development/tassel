// UI state of the item definition editor: the selected node and the test inputs per document, the preview's
// status, and the wizard. The definition itself lives in the document and changes only through item.* commands.
import { useEffect } from 'react';
import { create } from 'zustand';
import { useApp } from '../../app/store';
import { evaluateItem, type EvaluationResult, type ItemTestInputs } from '../../core/minecraft/items/evaluate';
import type { VariantMode } from '../../core/minecraft/items/templates';
import type { Doc } from '../../core/types';
import { onMinecraftAssetsChange } from '../../mcassets';
import { setItemPreviewScene } from '../../viewport/itemPreview';
import { useProjects } from '../projects/projectsStore';
import { packAssets, packContext, reloadPackAssets } from './packAssets';
import { buildPreviewScene, type PreviewNote } from './previewScene';

export interface WizardState {
  namespace: string;
  itemId: string;
  base: string;
  mode: VariantMode;
  version?: string;
  /** Opened from a Minecraft Java model: create the definition for that model. */
  fromModel: boolean;
  /** Replace the active item definition's model instead of creating a new document. */
  replace?: boolean;
}

export interface PreviewStatus {
  state: 'idle' | 'loading' | 'ready';
  notes: PreviewNote[];
  /** Models drawn. */
  shown: string[];
}

interface ItemUiState {
  /** Selected node path per document; null = the file's root settings. */
  selected: Record<string, string | null>;
  inputs: Record<string, ItemTestInputs>;
  preview: Record<string, PreviewStatus>;
  /** Width of the tree pane as a fraction of the centre. */
  split: number;
  wizard: WizardState | null;
}

export const useItemUi = create<ItemUiState>(() => ({ selected: {}, inputs: {}, preview: {}, split: 0.42, wizard: null }));

export const DEFAULT_INPUTS: ItemTestInputs = { displayContext: 'gui', damage: 0, maxDamage: 250, count: 1, maxStackSize: 64 };

export function selectNode(docId: string, path: string | null): void {
  useItemUi.setState((s) => ({ selected: { ...s.selected, [docId]: path } }));
}

export function setInputs(docId: string, update: (inputs: ItemTestInputs) => ItemTestInputs): void {
  useItemUi.setState((s) => ({ inputs: { ...s.inputs, [docId]: update(s.inputs[docId] ?? DEFAULT_INPUTS) } }));
}

export const useInputs = (docId: string): ItemTestInputs => useItemUi((s) => s.inputs[docId] ?? DEFAULT_INPUTS);
export const useSelectedPath = (docId: string): string | null => useItemUi((s) => (Object.hasOwn(s.selected, docId) ? s.selected[docId] : ''));

/** What the definition picks for the document's test inputs (cheap; re-run on every render that needs it). */
export function evaluateDoc(doc: Doc, inputs: ItemTestInputs): EvaluationResult | null {
  return doc.state.item ? evaluateItem(doc.state.item.definition, inputs) : null;
}

// ---- preview controller --------------------------------------------------------------------------

let generation = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastKey = '';

async function rebuild(): Promise<void> {
  const app = useApp.getState();
  const doc = app.docs[app.activeDocId];
  const run = ++generation;
  // Scenes of closed documents are dropped.
  for (const id of Object.keys(useItemUi.getState().preview)) if (!app.docs[id]) setItemPreviewScene(id, null);
  if (!doc?.state.item) return;
  const inputs = useItemUi.getState().inputs[doc.id] ?? DEFAULT_INPUTS;
  const result = evaluateItem(doc.state.item.definition, inputs);
  const setStatus = (status: PreviewStatus) => useItemUi.setState((s) => ({ preview: { ...s.preview, [doc.id]: status } }));
  setStatus({ state: 'loading', notes: useItemUi.getState().preview[doc.id]?.notes ?? [], shown: [] });
  const assets = packAssets(packContext(doc.filePath));
  const outcome = await buildPreviewScene(result.rendered, assets, inputs).catch((error: unknown) => ({
    state: null,
    notes: [{ path: '', model: '', problem: 'error' as const, detail: error instanceof Error ? error.message : String(error) }],
  }));
  if (run !== generation) return;
  setItemPreviewScene(doc.id, outcome.state);
  const failed = new Set(outcome.notes.map((n) => n.path));
  setStatus({ state: 'ready', notes: outcome.notes, shown: result.rendered.filter((r) => r.kind === 'model' && !failed.has(r.path)).map((r) => r.model) });
}

function schedule(force = false): void {
  const app = useApp.getState();
  const doc = app.docs[app.activeDocId];
  const key = doc?.state.item ? `${doc.id}|${JSON.stringify(useItemUi.getState().inputs[doc.id] ?? null)}` : '';
  const definition = doc?.state.item?.definition;
  if (!force && key === lastKey && definition === lastDefinition) return;
  lastKey = key;
  lastDefinition = definition;
  if (!key) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void rebuild(), 120);
}
let lastDefinition: unknown;

/** Re-reads every model and texture (after files changed on disk) and rebuilds the preview. */
export function reloadPreview(): void {
  reloadPackAssets();
  schedule(true);
}

/** Keeps the viewport's item preview in step with the active item definition; mount once (Centre). */
export function useItemPreviewController(): void {
  useEffect(() => {
    const unsubscribers = [
      useApp.subscribe(() => schedule()),
      useItemUi.subscribe((s, prev) => s.inputs !== prev.inputs && schedule()),
      useProjects.subscribe((s, prev) => s.activeId !== prev.activeId && schedule(true)),
      onMinecraftAssetsChange(() => schedule(true)),
    ];
    schedule(true);
    return () => unsubscribers.forEach((u) => u());
  }, []);
}
