import { execute, selectDocState, useApp } from '../app/store';
import { exportGltf, openProject, saveProject } from '../bridge/files';
import { primitiveTypes } from '../core/mesh/primitives';
import { elementModes, shadings, tools, viewPresets, workspaces, type ViewPreset } from '../core/types';
import { elementLabels, primitiveLabels, shadingLabels, toolLabels, viewLabels, workspaceLabels } from './labels';
import { runOp } from './live';
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
  /** Shortcuts that replace `keys` while in edit mode. */
  editKeys?: readonly string[];
  /** Mode the action belongs to. Its shortcuts only fire there, and the palette only lists it there. */
  when?: 'object' | 'edit';
  /** Also fires while a text field has focus. */
  inInputs?: boolean;
  /** Registry command this action stands for, so the palette does not list it twice. */
  command?: string;
  /** Not listed in the command palette. */
  hidden?: boolean;
  run(): unknown;
}

export const inEditMode = () => selectDocState(useApp.getState()).edit !== null;

/** Whether the action is offered in the current mode. */
export const isAvailable = (action: Action) => !action.when || action.when === (inEditMode() ? 'edit' : 'object');

function toggleEditMode() {
  const state = selectDocState(useApp.getState());
  if (!state.edit && !state.activeId) return notifyInfo('Kein aktives Objekt', 'Wähle ein Objekt aus, um sein Netz zu bearbeiten.');
  return execute('edit.toggle');
}

/** A mesh operation: runs with its defaults and then offers its parameters in the "Letzte Aktion" panel. */
const meshOp = (id: string, title: string, command: string, keys?: readonly string[], params?: Record<string, unknown>): Action => ({
  id,
  title,
  group: 'Netz',
  keys,
  when: 'edit',
  command,
  // "Verschmelzen: Mitte" is just "Verschmelzen" in the panel, which shows the rest as a field.
  run: () => runOp(command, params, title.split(':')[0]),
});

/** A mesh selection command (not undoable, no parameters). */
const meshSelect = (command: string, title: string, keys: readonly string[]): Action => ({
  id: command,
  title,
  group: 'Netz',
  keys,
  when: 'edit',
  command,
  run: () => execute(command),
});

const elementKeys = { vertex: '1', edge: '2', face: '3' } as const;

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
  { id: 'edit.duplicate', when: 'object', title: 'Duplizieren', group: 'Bearbeiten', keys: ['Shift+D'], command: 'scene.duplicate_objects', run: onSelection(() => execute('scene.duplicate_objects')) },
  { id: 'edit.delete', when: 'object', title: 'Löschen', group: 'Bearbeiten', keys: ['X', 'Delete'], command: 'scene.delete_objects', run: onSelection(() => execute('scene.delete_objects')) },
  { id: 'edit.select_all', when: 'object', title: 'Alles auswählen', group: 'Bearbeiten', keys: ['A'], command: 'scene.select_all', run: () => execute('scene.select_all') },
  { id: 'edit.deselect', when: 'object', title: 'Auswahl aufheben', group: 'Bearbeiten', keys: ['Alt+A'], run: () => execute('scene.select', { ids: [] }) },

  // Modus
  { id: 'mode.toggle', title: 'Bearbeitungsmodus umschalten', group: 'Modus', keys: ['Tab'], command: 'edit.toggle', run: toggleEditMode },
  { id: 'mode.object', title: 'Objektmodus', group: 'Modus', when: 'edit', command: 'edit.exit', run: () => execute('edit.exit') },
  { id: 'mode.edit', title: 'Bearbeitungsmodus', group: 'Modus', when: 'object', command: 'edit.enter', run: toggleEditMode },
  ...elementModes.map(
    (mode): Action => ({
      id: `element.${mode}`,
      title: `Auswahlmodus: ${elementLabels[mode].title}`,
      group: 'Modus',
      keys: [elementKeys[mode]],
      when: 'edit',
      command: 'edit.set_element_mode',
      run: () => execute('edit.set_element_mode', { mode }),
    }),
  ),

  // Netz (edit mode)
  meshOp('mesh.extrude', 'Extrudieren', 'mesh.extrude', ['E']),
  meshOp('mesh.inset', 'Einsetzen', 'mesh.inset', ['I']),
  meshOp('mesh.bevel', 'Abschrägen', 'mesh.bevel', ['Ctrl+B']),
  meshOp('mesh.loop_cut', 'Schleifenschnitt', 'mesh.loop_cut', ['Ctrl+R']),
  meshOp('mesh.subdivide', 'Unterteilen', 'mesh.subdivide'),
  { id: 'mesh.merge_menu', title: 'Verschmelzen', group: 'Netz', keys: ['M'], when: 'edit', hidden: true, run: () => useUi.setState({ mergeMenuOpen: true }) },
  meshOp('mesh.merge_center', 'Verschmelzen: Mitte', 'mesh.merge', undefined, { at: 'center' }),
  meshOp('mesh.merge_first', 'Verschmelzen: Erster', 'mesh.merge', undefined, { at: 'first' }),
  meshOp('mesh.merge_last', 'Verschmelzen: Letzter', 'mesh.merge', undefined, { at: 'last' }),
  meshOp('mesh.merge_by_distance', 'Verschmelzen: Nach Abstand', 'mesh.merge_by_distance'),
  meshOp('mesh.fill', 'Füllen', 'mesh.fill', ['F']),
  meshOp('mesh.flip_normals', 'Normalen umkehren', 'mesh.flip_normals'),
  meshOp('mesh.delete', 'Löschen', 'mesh.delete', ['X', 'Delete']),
  meshSelect('mesh.select_all', 'Alles auswählen', ['A']),
  meshSelect('mesh.select_none', 'Nichts auswählen', ['Alt+A']),
  meshSelect('mesh.select_invert', 'Auswahl umkehren', ['Ctrl+I']),
  meshSelect('mesh.select_linked', 'Verbundene auswählen', ['Ctrl+L']),
  meshSelect('mesh.select_more', 'Auswahl erweitern', ['Ctrl+NumpadAdd']),
  meshSelect('mesh.select_less', 'Auswahl verkleinern', ['Ctrl+NumpadSubtract']),

  // Hinzufügen
  { id: 'add.menu', title: 'Hinzufügen', group: 'Hinzufügen', keys: ['Shift+A'], hidden: true, run: () => useUi.setState({ addMenuOpen: true }) },
  ...primitiveTypes.map(
    (type): Action => ({
      id: `add.${type}`,
      title: `${primitiveLabels[type].title} hinzufügen`,
      group: 'Hinzufügen',
      run: () => runOp('scene.add_primitive', { type }, primitiveLabels[type].title),
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
  { id: 'view.frame', title: 'Fokussieren', group: 'Ansicht', keys: ['F', 'NumpadDecimal'], editKeys: ['NumpadDecimal'], command: 'view.frame', run: () => execute('view.frame') },

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

const keyNames: Record<string, string> = {
  Ctrl: 'Strg',
  Shift: 'Umschalt',
  Alt: 'Alt',
  Delete: 'Entf',
  NumpadAdd: 'Num +',
  NumpadSubtract: 'Num −',
  NumpadDecimal: 'Num ,',
};

/** German label for a combo: "Ctrl+Shift+Z" becomes "Strg+Umschalt+Z". */
export function formatCombo(text: string): string {
  return text
    .split('+')
    .map((part) => keyNames[part] ?? part.replace(/^Numpad/, 'Num '))
    .join('+');
}

/** Label of an action's primary shortcut in the given mode, or undefined if it has none there. */
export function comboLabel(action: Action, edit: boolean): string | undefined {
  if (edit && action.when === 'object') return undefined;
  const keys = (edit && action.editKeys) || action.keys;
  return keys?.[0] ? formatCombo(keys[0]) : undefined;
}

/**
 * Shortcut label of an action in the current mode. Not reactive: call it while rendering something
 * that re-renders on mode changes (or only exists while it is open, like a menu).
 */
export function shortcutLabel(actionId: string): string | undefined {
  return comboLabel(getAction(actionId), inEditMode());
}

type Mode = 'object' | 'edit';

const bindings = actions.flatMap((action) => {
  const bind = (keys: readonly string[] | undefined, mode: Mode | undefined) => (keys ?? []).map((k) => ({ combo: parseCombo(k), action, mode }));
  return [...bind(action.keys, action.when ?? (action.editKeys ? 'object' : undefined)), ...bind(action.editKeys, 'edit')];
});

/** The action bound to a keyboard event, if any. */
export function matchShortcut(event: KeyboardEvent): Action | undefined {
  const key = event.key.toLowerCase();
  const code = event.code.toLowerCase();
  const ctrl = event.ctrlKey || event.metaKey;
  const mode: Mode = inEditMode() ? 'edit' : 'object';
  const numpad = code.startsWith('numpad');
  return bindings.find(
    ({ combo, mode: when }) =>
      (!when || when === mode) &&
      combo.ctrl === ctrl &&
      combo.shift === event.shiftKey &&
      combo.alt === event.altKey &&
      // Numpad keys only match numpad bindings: "1" picks vertex mode, "Num 1" the front view.
      (combo.key.startsWith('numpad') ? combo.key === code : !numpad && combo.key === key),
  )?.action;
}
