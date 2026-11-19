import type { LucideIcon } from 'lucide-react';
import type { ComponentType } from 'react';
import { create } from 'zustand';
import type { DocFormat, Workspace } from '../../core/types';
import type { Dictionary } from '../../i18n';
import type { PanelDefaults } from './model';

/** What decides whether a panel has something to show. */
export interface PanelContext {
  format: DocFormat;
  /** The workspace the centre shows (item definitions always show `modeling`). */
  workspace: Workspace;
}

/**
 * A dockable panel. The component renders the panel's whole content, usually a flex column with a
 * `<header>` (or `<h2>`) on top: the dock makes that header the drag handle and gives it a context
 * menu, so panels keep their own titles and header buttons.
 */
export interface PanelDef extends PanelDefaults {
  title: (t: Dictionary) => string;
  icon: LucideIcon;
  component: ComponentType;
  /** UI action that toggles the panel; its shortcut is shown in View > Panels. */
  shortcutAction?: string;
  /** When the panel has something to show; elsewhere it is hidden (but stays where it is docked). Default: always. */
  when?: (context: PanelContext) => boolean;
  /**
   * For panels whose open state another store also tracks (and its own close button changes): the
   * dock keeps that store and the layout in step, both ways.
   */
  binding?: {
    isOpen(): boolean;
    setOpen(open: boolean): void;
    subscribe(listener: () => void): () => void;
  };
}

interface RegistryState {
  panels: readonly PanelDef[];
}

export const usePanelRegistry = create<RegistryState>(() => ({ panels: [] }));

/**
 * Registers (or replaces) a dockable panel. Layouts that have never seen it put it at its default
 * place once; after that it stays where the user docks it. Returns the unregister function.
 */
export function registerPanel(def: PanelDef): () => void {
  usePanelRegistry.setState((s) => ({ panels: [...s.panels.filter((p) => p.id !== def.id), def] }));
  return () => usePanelRegistry.setState((s) => ({ panels: s.panels.filter((p) => p !== def) }));
}

export const getPanels = (): readonly PanelDef[] => usePanelRegistry.getState().panels;
export const getPanel = (id: string): PanelDef | undefined => getPanels().find((p) => p.id === id);

export const isShown = (def: PanelDef | undefined, context: PanelContext): boolean => !!def && (def.when?.(context) ?? true);
