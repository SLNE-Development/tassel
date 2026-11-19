import { execute, selectDocState, useApp } from '../app/store';
import { exportFile, importFile, openProject, saveProject } from '../bridge/files';
import { openModelDialog } from './modelImport/modelImportFlows';
import { openBakeDialog } from './bake/bakeStore';
import { openRenderDialog } from './render/renderStore';
import { commandsById } from '../core/commands';
import { commandAllowedIn, FREE_ONLY, MINECRAFT_ONLY } from '../core/formats';
import { primitiveTypes } from '../core/mesh/primitives';
import { elementModes, shadings, tools, viewPresets, workspaces, type DocFormat, type ExportFormat, type ViewPreset } from '../core/types';
import { getT, type Dictionary } from '../i18n';
import { groupSelection, newEmptyGroup, ungroupSelection } from './groupActions';
import { activeFormat } from './format';
import { runOp } from './live';
import { minecraftActions } from './minecraft/minecraftActions';
import { modelImportActions } from './modelImport/modelImportActions';
import { paintActions } from './paint/paintActions';
import { previewActions } from './preview/previewActions';
import { timelineActions } from './timeline/timelineActions';
import { notifyError, notifyInfo, notifySuccess } from './toast';
import { useUi } from './uiStore';
import { uvActions } from './uv/uvActions';
import { activeProject, pull, push, setPanelOpen, targetDir, togglePanel, useProjects } from './projects/projectsStore';

/**
 * A UI action: something the user can trigger from a menu, a shortcut or the command palette.
 * This list is the single source for shortcuts; menus and tooltips derive their labels from it.
 */
export interface Action {
  id: string;
  /** In the current UI language; read it while rendering, never store it. */
  title: string;
  /** Palette group, e.g. "Datei" / "File". */
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
  /**
   * Document formats the action is offered in; absent = what its registry `command` allows, else every
   * format. Menus, the tool rail, the palette and shortcuts leave out actions that do not fit the active
   * document (see `actionAllowedIn`).
   */
  formats?: readonly DocFormat[];
  /** Further condition for offering the action (palette, shortcuts), e.g. the workspace it belongs to. */
  available?(): boolean;
  run(): unknown;
}

type Text = (t: Dictionary) => string;

/** Defines an action whose title and palette group follow the UI language: both are looked up on every read. */
const action = ({ title, group, ...rest }: Omit<Action, 'title' | 'group'> & { title: Text; group: keyof Dictionary['groups'] }): Action => ({
  ...rest,
  get title() {
    return title(getT());
  },
  get group() {
    return getT().groups[group];
  },
});

export const inEditMode = () => selectDocState(useApp.getState()).edit !== null;

/**
 * Actions that are only offered in free documents, by id prefix; for the action families that are built
 * from other modules (UV, painting, the timeline) and do not all stand for a registry command.
 */
const freeOnlyPrefixes = ['uv.', 'paint.', 'timeline.', 'video.', 'bake.'];

/** Whether the action works in a document of this format: its own `formats`, and what its registry command allows. */
export function actionAllowedIn(action: Pick<Action, 'id' | 'formats' | 'command'>, format: DocFormat): boolean {
  const declared = action.formats ?? (freeOnlyPrefixes.some((prefix) => action.id.startsWith(prefix)) ? FREE_ONLY : undefined);
  if (declared && !declared.includes(format)) return false;
  const def = action.command ? commandsById.get(action.command) : undefined;
  return !def || commandAllowedIn(def.id, def.formats, format);
}

/** Whether the action fits the active document's format. */
export const isAllowedHere = (action: Action) => actionAllowedIn(action, activeFormat());

/** Whether the action is offered in the current mode and document. */
export const isAvailable = (action: Action) =>
  isAllowedHere(action) && (!action.when || action.when === (inEditMode() ? 'edit' : 'object')) && (action.available?.() ?? true);

function toggleEditMode() {
  const state = selectDocState(useApp.getState());
  if (!state.edit && !state.activeId) return notifyInfo(getT().toasts.noActiveObject, getT().toasts.noActiveObjectHint);
  return execute('edit.toggle');
}

/** A mesh operation: runs with its defaults and then offers its parameters in the "Letzte Aktion" panel. */
const meshOp = (id: string, title: Text, command: string, keys?: readonly string[], params?: Record<string, unknown>, panelTitle = title): Action =>
  action({
    id,
    title,
    group: 'mesh',
    keys,
    when: 'edit',
    command,
    run: () => runOp(command, params, panelTitle),
  });

/** "Verschmelzen: Mitte" is just "Verschmelzen" in the panel, which shows the rest as a field. */
const mergeOp = (id: string, title: Text, command: string, params?: Record<string, unknown>): Action =>
  meshOp(id, title, command, undefined, params, (t) => t.actions.merge);

/** A mesh selection command (not undoable, no parameters). */
const meshSelect = (command: string, title: Text, keys: readonly string[]): Action =>
  action({
    id: command,
    title,
    group: 'mesh',
    keys,
    when: 'edit',
    command,
    run: () => execute(command),
  });

const elementKeys = { vertex: '1', edge: '2', face: '3' } as const;

const hasSelection = () => selectDocState(useApp.getState()).selection.length > 0;

/** Runs `fn` on the selection, or tells the user that nothing is selected. */
function onSelection(fn: () => unknown) {
  return () => (hasSelection() ? fn() : notifyInfo(getT().toasts.nothingSelected));
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
  if (saved) notifySuccess(getT().toasts.saved, useApp.getState().docs[useApp.getState().activeDocId]?.name);
  return saved;
}

async function exportActiveDoc(format: ExportFormat) {
  if (await exportFile(format)) notifySuccess(getT().toasts.exported, getT().files.written(getT().files.formats[format]));
}

async function importIntoActiveDoc() {
  const result = await importFile();
  if (!result) return;
  notifySuccess(getT().files.imported, getT().files.importedObjects(result.objects.length));
  // What the file had but could not be imported; the texts come from the command, like error messages.
  if (result.warnings.length > 0) notifyInfo(getT().files.importNotes(result.warnings.length), result.warnings.join(' '));
}

export const actions: readonly Action[] = [
  // Datei
  action({ id: 'file.new', title: (t) => t.actions.new, group: 'file', keys: ['Ctrl+N'], inInputs: true, command: 'document.new', run: () => useUi.setState({ newDocOpen: true }) }),
  action({ id: 'file.open', title: (t) => t.actions.open, group: 'file', keys: ['Ctrl+O'], inInputs: true, run: () => openProject() }),
  action({ id: 'file.save', title: (t) => t.actions.save, group: 'file', keys: ['Ctrl+S'], inInputs: true, run: () => saveActiveDoc() }),
  action({ id: 'file.save_as', title: (t) => t.actions.saveAs, group: 'file', keys: ['Ctrl+Shift+S'], inInputs: true, run: () => saveActiveDoc(true) }),
  action({ id: 'file.open_java', title: (t) => t.modelImport.openModel, group: 'file', run: openModelDialog }),
  action({ id: 'file.import', title: (t) => t.files.import, group: 'file', command: 'import.file', formats: FREE_ONLY, run: importIntoActiveDoc }),
  action({ id: 'file.export_glb', title: (t) => t.actions.exportGlb, group: 'file', command: 'export.gltf', run: () => exportActiveDoc('glb') }),
  action({ id: 'file.export_gltf', title: (t) => t.actions.exportGltf, group: 'file', command: 'export.file', run: () => exportActiveDoc('gltf') }),
  ...(['obj', 'stl', 'ply', 'usdz'] as const).map((format) =>
    action({ id: `file.export_${format}`, title: (t) => t.files.exportAs(t.files.formats[format]), group: 'file', formats: FREE_ONLY, run: () => exportActiveDoc(format) }),
  ),
  action({ id: 'file.export_json', title: (t) => t.files.exportAs(t.files.formats.json), group: 'file', command: 'export.file', formats: MINECRAFT_ONLY, run: () => exportActiveDoc('json') }),
  action({ id: 'render.open', title: (t) => t.render.open, group: 'file', keys: ['F12'], inInputs: true, command: 'render.image', run: openRenderDialog }),
  action({ id: 'file.close', title: (t) => t.actions.close, group: 'file', command: 'document.close', run: () => requestCloseDoc(useApp.getState().activeDocId) }),

  // Bearbeiten
  action({ id: 'edit.undo', title: (t) => t.actions.undo, group: 'edit', keys: ['Ctrl+Z'], command: 'history.undo', run: () => execute('history.undo') }),
  action({ id: 'edit.redo', title: (t) => t.actions.redo, group: 'edit', keys: ['Ctrl+Shift+Z', 'Ctrl+Y'], command: 'history.redo', run: () => execute('history.redo') }),
  action({ id: 'edit.duplicate', when: 'object', title: (t) => t.actions.duplicate, group: 'edit', keys: ['Shift+D'], command: 'scene.duplicate_objects', run: onSelection(() => execute('scene.duplicate_objects')) }),
  action({ id: 'edit.delete', when: 'object', title: (t) => t.actions.delete, group: 'edit', keys: ['X', 'Delete'], command: 'scene.delete_objects', run: onSelection(() => execute('scene.delete_objects')) }),
  action({ id: 'edit.select_all', when: 'object', title: (t) => t.actions.selectAll, group: 'edit', keys: ['A'], command: 'scene.select_all', run: () => execute('scene.select_all') }),
  action({ id: 'edit.deselect', when: 'object', title: (t) => t.actions.deselect, group: 'edit', keys: ['Alt+A'], run: () => execute('scene.select', { ids: [] }) }),
  action({ id: 'edit.group', when: 'object', title: (t) => t.grouping.group, group: 'edit', keys: ['Ctrl+G'], command: 'group.create', run: groupSelection }),
  action({ id: 'edit.ungroup', when: 'object', title: (t) => t.grouping.ungroup, group: 'edit', keys: ['Ctrl+Shift+G'], command: 'group.ungroup', run: ungroupSelection }),
  action({ id: 'bake.open', when: 'object', title: (t) => t.bake.open, group: 'edit', run: openBakeDialog }),
  action({ id: 'edit.new_group', when: 'object', title: (t) => t.grouping.newEmpty, group: 'edit', run: () => newEmptyGroup() }),

  // Modus
  action({ id: 'mode.toggle', title: (t) => t.actions.toggleEditMode, group: 'mode', keys: ['Tab'], command: 'edit.toggle', run: toggleEditMode }),
  action({ id: 'mode.object', title: (t) => t.actions.objectMode, group: 'mode', when: 'edit', command: 'edit.exit', run: () => execute('edit.exit') }),
  action({ id: 'mode.edit', title: (t) => t.actions.editMode, group: 'mode', when: 'object', command: 'edit.enter', run: toggleEditMode }),
  ...elementModes.map((mode) =>
    action({
      id: `element.${mode}`,
      title: (t) => t.actions.elementMode(t.elements[mode].title),
      group: 'mode',
      keys: [elementKeys[mode]],
      when: 'edit',
      command: 'edit.set_element_mode',
      run: () => execute('edit.set_element_mode', { mode }),
    }),
  ),

  // Netz (edit mode)
  meshOp('mesh.extrude', (t) => t.actions.extrude, 'mesh.extrude', ['E']),
  meshOp('mesh.inset', (t) => t.actions.inset, 'mesh.inset', ['I']),
  meshOp('mesh.bevel', (t) => t.actions.bevel, 'mesh.bevel', ['Ctrl+B']),
  meshOp('mesh.loop_cut', (t) => t.actions.loopCut, 'mesh.loop_cut', ['Ctrl+R']),
  meshOp('mesh.subdivide', (t) => t.actions.subdivide, 'mesh.subdivide'),
  action({ id: 'mesh.merge_menu', title: (t) => t.actions.merge, group: 'mesh', keys: ['M'], when: 'edit', hidden: true, run: () => useUi.setState({ mergeMenuOpen: true }) }),
  mergeOp('mesh.merge_center', (t) => t.actions.mergeCenter, 'mesh.merge', { at: 'center' }),
  mergeOp('mesh.merge_first', (t) => t.actions.mergeFirst, 'mesh.merge', { at: 'first' }),
  mergeOp('mesh.merge_last', (t) => t.actions.mergeLast, 'mesh.merge', { at: 'last' }),
  mergeOp('mesh.merge_by_distance', (t) => t.actions.mergeByDistance, 'mesh.merge_by_distance'),
  meshOp('mesh.fill', (t) => t.actions.fill, 'mesh.fill', ['F']),
  meshOp('mesh.flip_normals', (t) => t.actions.flipNormals, 'mesh.flip_normals'),
  meshOp('mesh.delete', (t) => t.actions.delete, 'mesh.delete', ['X', 'Delete']),
  meshSelect('mesh.select_all', (t) => t.actions.selectAll, ['A']),
  meshSelect('mesh.select_none', (t) => t.actions.selectNone, ['Alt+A']),
  meshSelect('mesh.select_invert', (t) => t.actions.selectInvert, ['Ctrl+I']),
  meshSelect('mesh.select_linked', (t) => t.actions.selectLinked, ['Ctrl+L']),
  meshSelect('mesh.select_more', (t) => t.actions.selectMore, ['Ctrl+NumpadAdd']),
  meshSelect('mesh.select_less', (t) => t.actions.selectLess, ['Ctrl+NumpadSubtract']),

  // UV
  ...uvActions(action),

  // Malen
  ...paintActions(action),

  // Animation
  ...timelineActions(action),

  // Hinzufügen
  action({ id: 'add.menu', title: (t) => t.actions.addMenu, group: 'add', keys: ['Shift+A'], hidden: true, run: () => useUi.setState({ addMenuOpen: true }) }),
  ...primitiveTypes.map((type) =>
    action({
      id: `add.${type}`,
      title: (t) => t.actions.addPrimitive(t.primitives[type]),
      group: 'add',
      formats: FREE_ONLY,
      // The new object is named in the UI language; the command's own default name is German.
      run: () => runOp('scene.add_primitive', { type, name: getT().primitives[type] }, (t) => t.primitives[type]),
    }),
  ),
  action({
    id: 'add.text',
    title: (t) => t.actions.addPrimitive(t.shapes.text),
    group: 'add',
    formats: FREE_ONLY,
    run: () => runOp('scene.add_text', { text: getT().shapes.text }, (t) => t.shapes.text),
  }),

  // Minecraft Java
  ...minecraftActions(action),
  ...modelImportActions(action),

  // Ansicht
  ...shadings.map((shading) =>
    action({
      id: `shading.${shading}`,
      title: (t) => t.actions.shading(t.shadings[shading]),
      group: 'view',
      run: () => execute('view.set_shading', { shading }),
    }),
  ),
  action({
    id: 'shading.cycle',
    title: (t) => t.actions.cycleShading,
    group: 'view',
    keys: ['Z'],
    command: 'view.set_shading',
    run: () => {
      const next = shadings[(shadings.indexOf(useApp.getState().shading) + 1) % shadings.length];
      return execute('view.set_shading', { shading: next });
    },
  }),
  ...viewPresets.map((preset) =>
    action({
      id: `view.${preset}`,
      title: (t) => t.actions.view(t.views[preset]),
      group: 'view',
      keys: viewKeys[preset] ? [viewKeys[preset]] : undefined,
      run: () => execute('view.set_view', { preset }),
    }),
  ),
  ...previewActions(action),
  action({ id: 'view.frame', title: (t) => t.actions.frame, group: 'view', keys: ['F', 'NumpadDecimal'], editKeys: ['NumpadDecimal'], command: 'view.frame', run: () => execute('view.frame') }),

  // Werkzeug
  ...tools.map((tool) =>
    action({
      id: `tool.${tool}`,
      title: (t) => t.actions.tool(t.tools[tool]),
      group: 'tool',
      keys: [toolKeys[tool]],
      // Elements are resized in the element panel; the scale gizmo would only bake into the box.
      formats: tool === 'scale' ? FREE_ONLY : undefined,
      run: () => execute('view.set_tool', { tool }),
    }),
  ),

  // Arbeitsbereich
  ...workspaces.map((workspace) =>
    action({
      id: `workspace.${workspace}`,
      title: (t) => t.actions.workspace(t.workspaces[workspace]),
      group: 'workspace',
      formats: workspace === 'paint' ? FREE_ONLY : undefined,
      run: () => execute('app.set_workspace', { workspace }),
    }),
  ),

  // Projekt
  action({ id: 'projects.toggle', title: (t) => t.projects.togglePanel, group: 'project', keys: ['Ctrl+Shift+E'], inInputs: true, run: togglePanel }),
  action({
    id: 'projects.save_into',
    title: (t) => t.projects.saveInto,
    group: 'project',
    available: () => activeProject() !== null,
    run: () => {
      setPanelOpen(true);
      useProjects.setState({ prompt: { kind: 'saveInto', dir: targetDir() } });
    },
  }),
  action({ id: 'projects.github', title: (t) => t.projects.cloneFromGitHub, group: 'project', run: () => useProjects.setState({ githubOpen: true }) }),
  action({ id: 'git.pull', title: (t) => t.projects.pull, group: 'project', available: () => useProjects.getState().status?.isRepo === true, run: pull }),
  action({ id: 'git.commit', title: (t) => t.projects.commitTitle, group: 'project', available: () => (useProjects.getState().status?.files.length ?? 0) > 0, run: () => useProjects.setState({ commitOpen: true }) }),
  action({ id: 'git.push', title: (t) => t.projects.push, group: 'project', available: () => useProjects.getState().status?.isRepo === true, run: push }),

  action({ id: 'preferences.open', title: (t) => t.actions.preferences, group: 'file', keys: ['Ctrl+,'], inInputs: true, run: () => useUi.setState({ preferencesOpen: true }) }),
  action({ id: 'palette.open', title: (t) => t.actions.palette, group: 'view', keys: ['Ctrl+K'], inInputs: true, hidden: true, run: () => useUi.setState((s) => ({ paletteOpen: !s.paletteOpen })) }),
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

/** Label for a combo in the current UI language: "Ctrl+Shift+Z" becomes "Strg+Umschalt+Z" in German. */
export function formatCombo(text: string): string {
  const { numpad, ...names } = getT().keys;
  return text
    .split('+')
    .map((part) => (names as Record<string, string>)[part] ?? part.replace(/^Numpad/, numpad))
    .join('+');
}

/** Label of an action's primary shortcut in the given mode, or undefined if it has none there. */
export function comboLabel(action: Action, edit: boolean): string | undefined {
  if (edit && action.when === 'object') return undefined;
  const keys = (edit && action.editKeys) || action.keys;
  return keys?.[0] ? formatCombo(keys[0]) : undefined;
}

/**
 * Shortcut label of an action in the current mode and UI language. Not reactive: call it while rendering
 * something that re-renders on mode and language changes (or only exists while it is open, like a menu).
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
    ({ combo, mode: when, action }) =>
      (!when || when === mode) &&
      isAllowedHere(action) &&
      (action.available?.() ?? true) &&
      combo.ctrl === ctrl &&
      combo.shift === event.shiftKey &&
      combo.alt === event.altKey &&
      // Numpad keys only match numpad bindings: "1" picks vertex mode, "Num 1" the front view.
      (combo.key.startsWith('numpad') ? combo.key === code : !numpad && combo.key === key),
  )?.action;
}
