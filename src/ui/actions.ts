import { execute, selectDocState, useApp } from '../app/store';
import { exportGltf, openProject, saveProject } from '../bridge/files';
import { primitiveTypes } from '../core/mesh/primitives';
import { shadings, tools, viewPresets, workspaces, type ViewPreset } from '../core/types';
import { primitiveLabels, shadingLabels, toolLabels, viewLabels, workspaceLabels } from './labels';
import { notifyError, notifyInfo, notifySuccess } from './toast';
import { useUi } from './uiStore';

/**
 * A UI action: something the user can trigger from a menu, a shortcut or the command palette.
 * This list is the single source for shortcuts; menus and tooltips derive their labels from it.
 */
export interface Action {
  id: string;
  title: string;
  /** Palette group, e.g. "Datei". */
  group: string;
  /** Shortcuts like "Ctrl+Shift+Z", "Delete" or "Numpad1". The first one is shown in the UI. */
  keys?: readonly string[];
  /** Also fires while a text field has focus. */
  inInputs?: boolean;
  /** Registry command this action stands for, so the palette does not list it twice. */
  command?: string;
  /** Not listed in the command palette. */
  hidden?: boolean;
  run(): unknown;
}

const hasSelection = () => selectDocState(useApp.getState()).selection.length > 0;

/** Runs `fn` on the selection, or tells the user that nothing is selected. */
function onSelection(fn: () => unknown) {
  return () => (hasSelection() ? fn() : notifyInfo('Nichts ausgewählt'));
}

const viewKeys: Partial<Record<ViewPreset, string>> = {
  front: 'Numpad1',
  back: 'Ctrl+Numpad1',
  right: 'Numpad3',
  left: 'Ctrl+Numpad3',
  top: 'Numpad7',
  bottom: 'Ctrl+Numpad7',
};

const toolKeys = { select: 'Q', move: 'G', rotate: 'R', scale: 'S' } as const;

/** Asks for confirmation if the document has unsaved changes, otherwise closes it right away. */
export function requestCloseDoc(id: string): unknown {
  const doc = useApp.getState().docs[id];
  if (!doc) return;
  if (doc.dirty) return useUi.setState({ closeDocId: id });
  return execute('document.close', { id });
}

export async function saveActiveDoc(saveAs = false): Promise<boolean> {
  const saved = await saveProject({ saveAs });
  if (saved) notifySuccess('Gespeichert', useApp.getState().docs[useApp.getState().activeDocId]?.name);
  return saved;
}

async function exportActiveDoc(binary: boolean) {
  if (await exportGltf({ binary })) notifySuccess('Exportiert', binary ? 'GLB-Datei geschrieben' : 'glTF-Datei geschrieben');
}

export const actions: readonly Action[] = [
  // Datei
  { id: 'file.new', title: 'Neu', group: 'Datei', keys: ['Ctrl+N'], inInputs: true, command: 'document.new', run: () => execute('document.new') },
  { id: 'file.open', title: 'Öffnen…', group: 'Datei', keys: ['Ctrl+O'], inInputs: true, run: () => openProject() },
  { id: 'file.save', title: 'Speichern', group: 'Datei', keys: ['Ctrl+S'], inInputs: true, run: () => saveActiveDoc() },
  { id: 'file.save_as', title: 'Speichern unter…', group: 'Datei', keys: ['Ctrl+Shift+S'], inInputs: true, run: () => saveActiveDoc(true) },
  { id: 'file.export_glb', title: 'Als GLB exportieren', group: 'Datei', command: 'export.gltf', run: () => exportActiveDoc(true) },
  { id: 'file.export_gltf', title: 'Als glTF exportieren', group: 'Datei', run: () => exportActiveDoc(false) },
  { id: 'file.close', title: 'Schließen', group: 'Datei', command: 'document.close', run: () => requestCloseDoc(useApp.getState().activeDocId) },

  // Bearbeiten
  { id: 'edit.undo', title: 'Rückgängig', group: 'Bearbeiten', keys: ['Ctrl+Z'], command: 'history.undo', run: () => execute('history.undo') },
  { id: 'edit.redo', title: 'Wiederholen', group: 'Bearbeiten', keys: ['Ctrl+Shift+Z', 'Ctrl+Y'], command: 'history.redo', run: () => execute('history.redo') },
  { id: 'edit.duplicate', title: 'Duplizieren', group: 'Bearbeiten', keys: ['Shift+D'], command: 'scene.duplicate_objects', run: onSelection(() => execute('scene.duplicate_objects')) },
  { id: 'edit.delete', title: 'Löschen', group: 'Bearbeiten', keys: ['X', 'Delete'], command: 'scene.delete_objects', run: onSelection(() => execute('scene.delete_objects')) },
  { id: 'edit.select_all', title: 'Alles auswählen', group: 'Bearbeiten', keys: ['A'], command: 'scene.select_all', run: () => execute('scene.select_all') },
  { id: 'edit.deselect', title: 'Auswahl aufheben', group: 'Bearbeiten', keys: ['Alt+A'], run: () => execute('scene.select', { ids: [] }) },

  // Hinzufügen
  { id: 'add.menu', title: 'Hinzufügen', group: 'Hinzufügen', keys: ['Shift+A'], hidden: true, run: () => useUi.setState({ addMenuOpen: true }) },
  ...primitiveTypes.map(
    (type): Action => ({
      id: `add.${type}`,
      title: `${primitiveLabels[type].title} hinzufügen`,
      group: 'Hinzufügen',
      run: () => execute('scene.add_primitive', { type }),
    }),
  ),

  // Ansicht
  ...shadings.map(
    (shading): Action => ({
      id: `shading.${shading}`,
      title: `Darstellung: ${shadingLabels[shading].title}`,
      group: 'Ansicht',
      run: () => execute('view.set_shading', { shading }),
    }),
  ),
  {
    id: 'shading.cycle',
    title: 'Darstellung wechseln',
    group: 'Ansicht',
    keys: ['Z'],
    command: 'view.set_shading',
    run: () => {
      const next = shadings[(shadings.indexOf(useApp.getState().shading) + 1) % shadings.length];
      return execute('view.set_shading', { shading: next });
    },
  },
  ...viewPresets.map(
    (preset): Action => ({
      id: `view.${preset}`,
      title: `Ansicht: ${viewLabels[preset]}`,
      group: 'Ansicht',
      keys: viewKeys[preset] ? [viewKeys[preset]] : undefined,
      run: () => execute('view.set_view', { preset }),
    }),
  ),
  { id: 'view.frame', title: 'Fokussieren', group: 'Ansicht', keys: ['F'], command: 'view.frame', run: () => execute('view.frame') },

  // Werkzeug
  ...tools.map(
    (tool): Action => ({
      id: `tool.${tool}`,
      title: `Werkzeug: ${toolLabels[tool].title}`,
      group: 'Werkzeug',
      keys: [toolKeys[tool]],
      run: () => execute('view.set_tool', { tool }),
    }),
  ),

  // Arbeitsbereich
  ...workspaces.map(
    (workspace): Action => ({
      id: `workspace.${workspace}`,
      title: `Arbeitsbereich: ${workspaceLabels[workspace].title}`,
      group: 'Arbeitsbereich',
      run: () => execute('app.set_workspace', { workspace }),
    }),
  ),

  { id: 'palette.open', title: 'Befehlspalette', group: 'Ansicht', keys: ['Ctrl+K'], inInputs: true, hidden: true, run: () => useUi.setState((s) => ({ paletteOpen: !s.paletteOpen })) },
];

const actionsById = new Map(actions.map((a) => [a.id, a]));

export function getAction(id: string): Action {
  const action = actionsById.get(id);
  if (!action) throw new Error(`Unknown action "${id}"`);
  return action;
}

/** Runs an action; failures end up in an error toast instead of an unhandled rejection. */
export async function runAction(id: string): Promise<void> {
  try {
    await getAction(id).run();
  } catch (error) {
    notifyError(error);
  }
}

/** `execute` for event handlers: errors become a toast. */
export function dispatch(id: string, params?: unknown): Promise<unknown> {
  return execute(id, params).catch(notifyError);
}

// --- Shortcuts -------------------------------------------------------------------------------

interface Combo {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

function parseCombo(text: string): Combo {
  const parts = text.split('+');
  const key = parts.pop()!;
  return { key: key.toLowerCase(), ctrl: parts.includes('Ctrl'), shift: parts.includes('Shift'), alt: parts.includes('Alt') };
}

const keyNames: Record<string, string> = { Ctrl: 'Strg', Shift: 'Umschalt', Alt: 'Alt', Delete: 'Entf' };

/** German label for a combo: "Ctrl+Shift+Z" becomes "Strg+Umschalt+Z". */
export function formatCombo(text: string): string {
  return text
    .split('+')
    .map((part) => keyNames[part] ?? part.replace(/^Numpad/, 'Num '))
    .join('+');
}

/** Label of an action's primary shortcut, or undefined if it has none. */
export function shortcutLabel(actionId: string): string | undefined {
  const keys = getAction(actionId).keys;
  return keys?.[0] ? formatCombo(keys[0]) : undefined;
}

const bindings = actions.flatMap((action) => (action.keys ?? []).map((keys) => ({ combo: parseCombo(keys), action })));

/** The action bound to a keyboard event, if any. */
export function matchShortcut(event: KeyboardEvent): Action | undefined {
  const key = event.key.toLowerCase();
  const code = event.code.toLowerCase();
  const ctrl = event.ctrlKey || event.metaKey;
  return bindings.find(
    ({ combo }) =>
      combo.ctrl === ctrl &&
      combo.shift === event.shiftKey &&
      combo.alt === event.altKey &&
      (combo.key.startsWith('numpad') ? combo.key === code : combo.key === key),
  )?.action;
}
