// Actions, file handling and project integration of item definition documents.
import { invoke, isTauri } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { execute, selectActiveDoc, selectDocState, useApp } from '../../app/store';
import { ITEM_DEFINITION_ONLY, MINECRAFT_ONLY } from '../../core/formats';
import { looksLikeItemDefinition } from '../../core/minecraft/items/codec';
import { itemFilePath, itemLocationFromPath, modelLocationFromPath } from '../../core/minecraft/items/document';
import { DEFAULT_VERSION } from '../../core/minecraft/versions';
import { getT, type Dictionary } from '../../i18n';
import type { Action } from '../actions';
import { absolutePath } from '../projects/projectModel';
import { activeProject, refreshTree, registerProjectFileOpener } from '../projects/projectsStore';
import { notifyInfo, notifySuccess } from '../toast';
import { useItemUi } from './itemStore';
import { packContext } from './packAssets';

type Define = (action: Omit<Action, 'title' | 'group'> & { title: (t: Dictionary) => string; group: 'file' | 'minecraft' }) => Action;

/** Opens the wizard for a new item definition (from a Minecraft Java document: for that model). */
export function openItemWizard(): void {
  const state = selectDocState(useApp.getState());
  const doc = selectActiveDoc(useApp.getState());
  if (state.java) {
    const fromPath = doc.filePath ? modelLocationFromPath(doc.filePath) : null;
    const namespace = Object.values(state.textures).find((t) => t.java && t.java.namespace !== 'minecraft')?.java?.namespace ?? 'minecraft';
    const base = fromPath ?? `${namespace}:item/${state.java.fileName}`;
    useItemUi.setState({ wizard: { namespace: base.split(':')[0], itemId: state.java.fileName, base, mode: 'range', version: state.java.version, fromModel: true } });
    return;
  }
  useItemUi.setState({ wizard: { namespace: 'minecraft', itemId: '', base: '', mode: 'range', version: DEFAULT_VERSION, fromModel: false } });
}

async function validate() {
  const t = getT().items;
  const result = (await execute('item.validate')) as { issues: unknown[] };
  if (result.issues.length === 0) notifySuccess(t.noIssues);
  else notifyInfo(`${t.check}: ${result.issues.length}`);
}

export const itemActions = (action: Define): Action[] => [
  action({ id: 'file.new_item', title: (t) => t.items.actions.newItem, group: 'file', command: 'document.new_item', run: openItemWizard }),
  action({ id: 'mc.create_item', title: (t) => t.items.actions.createForModel, group: 'minecraft', command: 'minecraft.create_item_definition', formats: MINECRAFT_ONLY, run: openItemWizard }),
  action({ id: 'item.check', title: (t) => t.items.actions.validate, group: 'minecraft', command: 'item.validate', formats: ITEM_DEFINITION_ONLY, run: validate }),
];

/**
 * Saves the active item definition as its .json file: to the file it came from, else (or with saveAs) to a
 * chosen path, suggested at assets/<namespace>/items/<id>.json of the open project. Resolves false if cancelled.
 */
export async function saveItemDefinition(saveAs = false): Promise<boolean> {
  if (!isTauri()) throw new Error(getT().files.desktopOnly);
  const doc = selectActiveDoc(useApp.getState());
  const item = doc.state.item;
  if (!item) return false;
  let path = !saveAs && doc.filePath?.toLowerCase().endsWith('.json') ? doc.filePath : null;
  if (!path) {
    const { project, prefix } = packContext(doc.filePath);
    const suggestion = project ? absolutePath(project.path, prefix + itemFilePath(item)) : `${item.id.split('/').pop()}.json`;
    const chosen = await save({ defaultPath: suggestion, filters: [{ name: getT().files.formats.json, extensions: ['json'] }] });
    if (!chosen) return false;
    path = chosen.toLowerCase().endsWith('.json') ? chosen : `${chosen}.json`;
  }
  const exported = (await execute('item.export_json', {}, { documentId: doc.id })) as { text: string };
  await invoke('write_text_file', { path, contents: exported.text });
  const location = itemLocationFromPath(path);
  if (location && (location.namespace !== item.namespace || location.id !== item.id)) {
    await execute('item.set_settings', { namespace: location.namespace, itemId: location.id }, { documentId: doc.id });
  }
  await execute('document.mark_saved', { id: doc.id, filePath: path, name: path.split(/[\\/]/).pop()!.replace(/\.json$/i, '') });
  if (activeProject()) void refreshTree();
  return true;
}

/** Item definitions in the project tree open as item definition documents (other .json files are left to others). */
export function registerItemFileOpener(): () => void {
  return registerProjectFileOpener('json', async ({ path, absolutePath: file, readText }) => {
    const open = Object.values(useApp.getState().docs).find((d) => d.filePath === file);
    if (open && open.state.item) {
      await execute('document.switch', { id: open.id });
      return true;
    }
    const text = await readText();
    let raw: unknown;
    try {
      raw = JSON.parse(text.replace(/^﻿/, ''));
    } catch {
      return false;
    }
    if (!looksLikeItemDefinition(raw) && !(itemLocationFromPath(path) && typeof raw === 'object')) return false;
    await execute('document.import_item', { json: text, filePath: file });
    return true;
  });
}
