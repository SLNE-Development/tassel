// Opening .json / .bbmodel files from the open dialog, drag & drop and the project panel, and the
// follow-up question what to do with a Java model's parent.
import { invoke, isTauri } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { create } from 'zustand';
import { execute } from '../../app/store';
import type { ParentMode } from '../../core/minecraft/openModel';
import { modelFileKind } from '../../core/modelFiles';
import { getT } from '../../i18n';
import { notifyError, notifyInfo, notifySuccess } from '../toast';

const PARENT_MODE_KEY = 'tessel.parentMode';

/** The remembered answer to the parent question, or null to ask. */
export function rememberedParentMode(): ParentMode | null {
  try {
    const value = localStorage.getItem(PARENT_MODE_KEY);
    return value === 'show' || value === 'merge' || value === 'reference' ? value : null;
  } catch {
    return null;
  }
}

export function rememberParentMode(mode: ParentMode | null): void {
  try {
    if (mode) localStorage.setItem(PARENT_MODE_KEY, mode);
    else localStorage.removeItem(PARENT_MODE_KEY);
  } catch {
    // Not remembered; the question comes again.
  }
}

interface ImportUi {
  /** The document whose parent question is open. */
  parentPrompt: { docId: string; parent: string } | null;
  folderOpen: boolean;
}

export const useModelImport = create<ImportUi>(() => ({ parentPrompt: null, folderOpen: false }));

interface OpenedResult {
  id: string;
  name: string;
  warnings?: string[];
  dropped?: unknown[];
  parent?: { chain: string[]; elements: number; elementsOverridden: boolean } | null;
}

/** Notes, and for Java models with inherited elements the parent question. */
function afterOpen(result: OpenedResult, asked: boolean): void {
  const t = getT();
  const notes = result.warnings ?? [];
  const dropped = (result.dropped ?? []) as { kind: string; name: string; reason: string }[];
  if (dropped.length > 0) notifyInfo(t.modelImport.dropped(dropped.length), dropped.map((d) => `${d.kind} "${d.name}": ${d.reason}`).join(' · '));
  if (notes.length > 0) notifyInfo(t.files.importNotes(notes.length), notes.join(' '));
  const parent = result.parent;
  if (asked && parent && parent.elements > 0 && !parent.elementsOverridden) {
    useModelImport.setState({ parentPrompt: { docId: result.id, parent: parent.chain[0] ?? '' } });
  }
}

/** Opens model files (.json, .bbmodel) or Tessel projects by path, each in a new tab. */
export async function openModelPaths(paths: readonly string[]): Promise<void> {
  const mode = rememberedParentMode();
  for (const path of paths) {
    try {
      if (path.toLowerCase().endsWith('.tessel')) {
        const json = await invoke<string>('read_text_file', { path });
        const name = path.split(/[\\/]/).pop()!.replace(/\.tessel$/i, '');
        await execute('document.load', { json, filePath: path, name });
        continue;
      }
      if (!modelFileKind(path)) {
        notifyInfo(getT().modelImport.dropUnsupported(path.split(/[\\/]/).pop() ?? path));
        continue;
      }
      const result = (await execute('document.open_model_file', { path, parent: mode ?? 'show' })) as OpenedResult;
      afterOpen(result, mode === null && paths.length === 1);
    } catch (error) {
      notifyError(error);
    }
  }
}

/** File > Open Model: one or more .json / .bbmodel files. */
export async function openModelDialog(): Promise<void> {
  if (!isTauri()) throw new Error(getT().files.desktopOnly);
  const chosen = await open({ multiple: true, directory: false, filters: [{ name: getT().modelImport.modelFiles, extensions: ['json', 'bbmodel'] }] });
  if (!chosen) return;
  await openModelPaths(Array.isArray(chosen) ? chosen : [chosen]);
}

/** Files dropped onto the window (HTML drag & drop gives their content, not their path). */
export async function openDroppedFiles(files: readonly File[]): Promise<void> {
  const mode = rememberedParentMode();
  for (const file of files) {
    const dot = file.name.lastIndexOf('.');
    const stem = dot > 0 ? file.name.slice(0, dot) : file.name;
    const kind = file.name.toLowerCase().endsWith('.tessel') ? 'tessel' : modelFileKind(file.name);
    try {
      if (!kind) {
        notifyInfo(getT().modelImport.dropUnsupported(file.name));
        continue;
      }
      const text = await file.text();
      if (kind === 'tessel') {
        await execute('document.load', { json: text, name: stem });
        continue;
      }
      const result = (
        kind === 'bbmodel'
          ? await execute('document.import_bbmodel', { text, name: stem })
          : await execute('document.import_java', { json: text, name: stem, fileName: stem, parent: mode ?? 'show' })
      ) as OpenedResult;
      afterOpen(result, mode === null && files.length === 1);
    } catch (error) {
      notifyError(error);
    }
  }
}

/** The answer to the parent question for the document it was asked about (which is then the active one). */
export async function answerParentPrompt(mode: ParentMode, remember: boolean): Promise<void> {
  useModelImport.setState({ parentPrompt: null });
  if (remember) rememberParentMode(mode);
  if (mode === 'show') return;
  try {
    if (mode === 'reference') await execute('minecraft.hide_parent');
    else {
      const merged = (await execute('minecraft.merge_parent')) as { elements: number; textures: number };
      notifySuccess(getT().modelImport.parent.merged(merged.elements, merged.textures));
    }
  } catch (error) {
    notifyError(error);
  }
}

/** Opens the window-wide drop target: model files and projects dropped anywhere that no panel handles. */
export function installModelDrop(target: Window = window): () => void {
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  const over = (e: DragEvent) => {
    if (!hasFiles(e) || e.defaultPrevented) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };
  const drop = (e: DragEvent) => {
    // A panel (materials, textures) took it already.
    if (!hasFiles(e) || e.defaultPrevented) return;
    e.preventDefault();
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length > 0) void openDroppedFiles(files);
  };
  target.addEventListener('dragover', over);
  target.addEventListener('drop', drop);
  return () => {
    target.removeEventListener('dragover', over);
    target.removeEventListener('drop', drop);
  };
}
