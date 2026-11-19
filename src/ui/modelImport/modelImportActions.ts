import { execute } from '../../app/store';
import { looksLikeJavaModel } from '../../core/commands/modelImport';
import { MINECRAFT_ONLY } from '../../core/formats';
import { getT, type Dictionary } from '../../i18n';
import type { Action } from '../actions';
import { registerProjectFileOpener } from '../projects/projectsStore';
import { notifySuccess } from '../toast';
import { openModelPaths, useModelImport } from './modelImportFlows';

type Define = (action: Omit<Action, 'title' | 'group'> & { title: (t: Dictionary) => string; group: 'file' | 'minecraft' }) => Action;

async function mergeParent() {
  const merged = (await execute('minecraft.merge_parent')) as { elements: number; textures: number };
  notifySuccess(getT().modelImport.parent.merged(merged.elements, merged.textures));
}

/** File > Import Folder and the parent model actions of Minecraft documents. */
export const modelImportActions = (action: Define): Action[] => [
  action({ id: 'file.import_folder', title: (t) => t.modelImport.importFolder, group: 'file', command: 'document.convert_models', run: () => useModelImport.setState({ folderOpen: true }) }),
  action({ id: 'mc.show_parent', title: (t) => t.modelImport.parent.showAction, group: 'minecraft', command: 'minecraft.show_parent', formats: MINECRAFT_ONLY, run: () => execute('minecraft.show_parent') }),
  action({ id: 'mc.hide_parent', title: (t) => t.modelImport.parent.hideAction, group: 'minecraft', command: 'minecraft.hide_parent', formats: MINECRAFT_ONLY, run: () => execute('minecraft.hide_parent') }),
  action({ id: 'mc.merge_parent', title: (t) => t.modelImport.parent.mergeAction, group: 'minecraft', command: 'minecraft.merge_parent', formats: MINECRAFT_ONLY, run: mergeParent }),
];

let registered = false;

/** Lets the Projects panel open .json models and .bbmodel projects (by their absolute path, so parents and textures are found in the pack). */
export function registerModelFileOpeners(): void {
  if (registered) return;
  registered = true;
  for (const extension of ['json', 'bbmodel']) {
    registerProjectFileOpener(extension, async (file) => {
      // Blockstates, item definitions, lang files ... are not models: someone else may open them.
      if (extension === 'json' && !looksLikeJavaModel(await file.readText())) return false;
      await openModelPaths([file.absolutePath]);
      return true;
    });
  }
}
