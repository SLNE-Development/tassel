import { invoke, isTauri } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { execute, selectActiveDoc, useApp } from '../app/store';

const PROJECT_FILTER = { name: 'Forma-Projekt', extensions: ['forma'] };
const GLB_FILTER = { name: 'glTF Binär', extensions: ['glb'] };
const GLTF_FILTER = { name: 'glTF', extensions: ['gltf'] };

function requireDesktop(): void {
  if (!isTauri()) throw new Error('Nur in der Desktop-App verfügbar');
}

/** File name without folder and extension. */
function fileStem(path: string): string {
  const fileName = path.split(/[\\/]/).pop() ?? path;
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

/** Appends the extension if the user typed a name without it. */
function withExtension(path: string, extension: string): string {
  return path.toLowerCase().endsWith(`.${extension}`) ? path : `${path}.${extension}`;
}

/** Characters that are not allowed in Windows file names are replaced so the dialog accepts the suggestion. */
function suggestedFileName(name: string, extension: string): string {
  const safe = name.replace(/[<>:"/\\|?*]/g, '_').trim() || 'Unbenannt';
  return `${safe}.${extension}`;
}

/** Shows an open dialog and loads the chosen .forma project into a new tab. */
export async function openProject(): Promise<void> {
  requireDesktop();
  const path = await open({ multiple: false, directory: false, filters: [PROJECT_FILTER] });
  if (!path) return;
  const json = await invoke<string>('read_text_file', { path });
  await execute('document.load', { json, filePath: path, name: fileStem(path) });
}

/** Saves the active document; asks for a path if it has none or `saveAs` is set. Resolves false if cancelled. */
export async function saveProject(opts?: { saveAs?: boolean }): Promise<boolean> {
  requireDesktop();
  const current = selectActiveDoc(useApp.getState());
  let path = opts?.saveAs ? null : current.filePath;
  if (!path) {
    const chosen = await save({
      defaultPath: current.filePath ?? suggestedFileName(current.name, 'forma'),
      filters: [PROJECT_FILTER],
    });
    if (!chosen) return false;
    path = withExtension(chosen, 'forma');
  }
  // Serialize after the dialog, by id: the document the user was asked about is the one that gets written.
  const doc = (await execute('document.serialize', { id: current.id })) as { id: string; json: string };
  await invoke('write_text_file', { path, contents: doc.json });
  await execute('document.mark_saved', { id: doc.id, filePath: path, name: fileStem(path) });
  return true;
}

/** Asks for a path and exports the active document as GLB or glTF. Resolves false if cancelled. */
export async function exportGltf(opts: { binary: boolean; selectionOnly?: boolean }): Promise<boolean> {
  requireDesktop();
  const extension = opts.binary ? 'glb' : 'gltf';
  // Export first, so problems (e.g. nothing selected) show up before the user picks a file.
  const exported = (await execute('export.gltf', {
    binary: opts.binary,
    selectionOnly: opts.selectionOnly ?? false,
  })) as { base64?: string; text?: string };

  const chosen = await save({
    defaultPath: suggestedFileName(selectActiveDoc(useApp.getState()).name, extension),
    filters: [opts.binary ? GLB_FILTER : GLTF_FILTER],
  });
  if (!chosen) return false;
  const path = withExtension(chosen, extension);

  if (opts.binary) {
    await invoke('write_binary_file', { path, base64: exported.base64 ?? '' });
  } else {
    await invoke('write_text_file', { path, contents: exported.text ?? '' });
  }
  return true;
}
