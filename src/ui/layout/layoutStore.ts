import { create } from 'zustand';
import * as model from './model';
import type { DockLayout, DropTarget } from './model';
import { getPanel, getPanels, usePanelRegistry, type PanelDef } from './registry';

// The current dock layout, the user's named layouts, and their persistence.

export const STORAGE_KEY = 'tessel.layout';
/** Longest name of a saved layout. */
export const MAX_NAME_LENGTH = 40;

export interface LayoutState {
  layout: DockLayout;
  /** Named layouts, by name. */
  saved: Record<string, DockLayout>;
  /** The saved layout last applied or saved (shown as checked in the menu); null after a reset. */
  current: string | null;
  /** The "Layouts" dialog (save, delete). */
  manageOpen: boolean;
}

export interface StoredLayouts {
  version: 1;
  layout: DockLayout;
  saved: Record<string, DockLayout>;
  current: string | null;
}

/** Reads what `serializeLayouts` wrote; null when there is nothing usable (the default layout applies then). */
export function parseStoredLayouts(raw: unknown): StoredLayouts | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const layout = model.parseLayout(value.layout);
  if (!layout) return null;
  const saved: Record<string, DockLayout> = {};
  if (typeof value.saved === 'object' && value.saved !== null)
    for (const [name, entry] of Object.entries(value.saved)) {
      const parsed = model.parseLayout(entry);
      const clean = cleanName(name);
      if (parsed && clean) saved[clean] = parsed;
    }
  const current = typeof value.current === 'string' && saved[value.current] ? value.current : null;
  return { version: 1, layout, saved, current };
}

export const serializeLayouts = (state: Pick<LayoutState, 'layout' | 'saved' | 'current'>): string =>
  JSON.stringify({ version: 1, layout: state.layout, saved: state.saved, current: state.current } satisfies StoredLayouts);

/** A layout name as it is stored: trimmed, single spaces, not too long. Empty if nothing is left. */
export const cleanName = (name: string): string => name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);


export const useLayout = create<LayoutState>(() => ({
  layout: model.defaultLayout([]),
  saved: {},
  current: null,
  manageOpen: false,
}));

function read(): unknown {
  try {
    const text = globalThis.localStorage?.getItem(STORAGE_KEY);
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave(): void {
  if (saveTimer !== null) return;
  // Dragging a divider changes the layout on every pointer move; write once it settles.
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, serializeLayouts(useLayout.getState()));
    } catch {
      // Storage full or unavailable: the layout still applies for this session.
    }
  }, 250);
}

// ---- operations --------------------------------------------------------------------------------

/** Changes the current layout. */
export function updateLayout(change: (layout: DockLayout) => DockLayout): void {
  const before = useLayout.getState().layout;
  const after = change(before);
  if (after !== before) useLayout.setState({ layout: after });
}

export const openPanel = (id: string) => updateLayout((l) => model.openPanel(l, id, getPanel(id)));
export const closePanel = (id: string) => updateLayout((l) => model.closePanel(l, id));
export const togglePanel = (id: string) => updateLayout((l) => model.togglePanel(l, id, getPanel(id)));
export const movePanel = (id: string, target: DropTarget) => updateLayout((l) => model.movePanel(l, id, target, getPanel(id)));
export const setCollapsed = (groupId: string, collapsed: boolean) => updateLayout((l) => model.setCollapsed(l, groupId, collapsed));
export const setColumnWidth = (columnId: string, width: number) => updateLayout((l) => model.setColumnWidth(l, columnId, width));

export const usePanelOpen = (id: string): boolean => useLayout((s) => model.isPanelOpen(s.layout, id));

/** Saves the current layout under a name (replacing a layout of that name). */
export function saveLayout(name: string): void {
  const clean = cleanName(name);
  if (!clean) return;
  useLayout.setState((s) => ({ saved: { ...s.saved, [clean]: s.layout }, current: clean }));
}

export function applyLayout(name: string): void {
  const saved = useLayout.getState().saved[name];
  if (!saved) return;
  useLayout.setState({ layout: model.reconcile(saved, getPanels()), current: name });
}

export function deleteLayout(name: string): void {
  useLayout.setState((s) => {
    const { [name]: _, ...saved } = s.saved;
    return { saved, current: s.current === name ? null : s.current };
  });
}

/** Back to the default layout (the saved layouts stay). */
export function resetLayout(): void {
  useLayout.setState({ layout: model.defaultLayout(getPanels()), current: null });
}

// ---- start-up ----------------------------------------------------------------------------------

/** Keeps a panel's own open flag (another store) and the layout in step. */
function bind(def: PanelDef): () => void {
  const binding = def.binding!;
  const fromStore = () => {
    const open = binding.isOpen();
    if (open !== model.isPanelOpen(useLayout.getState().layout, def.id)) (open ? openPanel : closePanel)(def.id);
  };
  const unsubscribeStore = binding.subscribe(fromStore);
  const unsubscribeLayout = useLayout.subscribe((s, previous) => {
    if (s.layout === previous.layout) return;
    const open = model.isPanelOpen(s.layout, def.id);
    if (open !== binding.isOpen()) binding.setOpen(open);
  });
  return () => {
    unsubscribeStore();
    unsubscribeLayout();
  };
}

let started = false;

/**
 * Loads the stored layout (or the default), fits it to the registered panels, and from then on saves
 * every change and places panels registered later. Call once, after the built-in panels are registered.
 */
export function initLayout(): void {
  if (started) return;
  started = true;
  const stored = parseStoredLayouts(read());
  const panels = getPanels();
  const layout = stored ? model.reconcile(stored.layout, panels) : model.defaultLayout(panels);
  useLayout.setState({ layout, saved: stored?.saved ?? {}, current: stored?.current ?? null });

  const bindings = new Map<PanelDef, () => void>();
  const attach = (defs: readonly PanelDef[], firstRun: boolean) => {
    for (const [def, unbind] of bindings)
      if (!defs.includes(def)) {
        unbind();
        bindings.delete(def);
      }
    for (const def of defs) {
      if (!def.binding || bindings.has(def)) continue;
      // Before there was a stored layout the panel's own flag decided (older versions kept it there); after that the layout does.
      const open = def.binding.isOpen();
      if (!stored && firstRun) {
        if (open !== model.isPanelOpen(useLayout.getState().layout, def.id)) (open ? openPanel : closePanel)(def.id);
      } else if (open !== model.isPanelOpen(useLayout.getState().layout, def.id)) def.binding.setOpen(!open);
      bindings.set(def, bind(def));
    }
  };
  attach(panels, true);
  usePanelRegistry.subscribe((s, previous) => {
    if (s.panels === previous.panels) return;
    updateLayout((l) => model.reconcile(l, s.panels));
    attach(s.panels, false);
  });
  useLayout.subscribe((s, previous) => {
    if (s.layout !== previous.layout || s.saved !== previous.saved || s.current !== previous.current) scheduleSave();
  });
}
