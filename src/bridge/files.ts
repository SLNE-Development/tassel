import { invoke, isTauri } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { execute, selectActiveDoc, useApp } from '../app/store';
import { importFormats, type ExportFormat, type ExportResult, type ImportFormat } from '../core/types';
import { documentName, getT } from '../i18n';

const projectFilter = () => ({ name: getT().files.project, extensions: ['tessel'] });

function requireDesktop(): void {
  if (!isTauri()) throw new Error(getT().files.desktopOnly);
}

/** File name without folder. */
function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** File name without folder and extension. */
function fileStem(path: string): string {
  const name = fileName(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Appends the extension if the user typed a name without it. */
function withExtension(path: string, extension: string): string {
  return path.toLowerCase().endsWith(`.${extension}`) ? path : `${path}.${extension}`;
}

/** Characters that are not allowed in Windows file names are replaced so the dialog accepts the suggestion. */
function suggestedFileName(name: string, extension: string): string {
  const safe = name.replace(/[<>:"/\\|?*]/g, '_').trim() || getT().documents.untitled;
  return `${safe}.${extension}`;
}

/** Shows an open dialog and loads the chosen .tessel project into a new tab. */
export async function openProject(): Promise<void> {
  requireDesktop();
  const path = await open({ multiple: false, directory: false, filters: [projectFilter()] });
  if (!path) return;
  const json = await invoke<string>('read_text_file', { path });
  await execute('document.load', { json, filePath: path, name: fileStem(path) });
}

/** Shows an open dialog and opens the chosen Minecraft Java model (.json) as a new Minecraft document. */
export async function openJavaModel(): Promise<{ warnings: string[]; parent: unknown } | null> {
  requireDesktop();
  const path = await open({ multiple: false, directory: false, filters: [{ name: getT().files.formats.json, extensions: ['json'] }] });
  if (!path) return null;
  // The backend also reads the texture images it finds in the resource pack the model is in.
  const read = await invoke<{ json: string; images: Record<string, { data: string; width: number; height: number }> }>('read_java_model_file', { path });
  const stem = fileStem(path);
  return (await execute('document.import_java', { json: read.json, images: read.images, name: stem, fileName: stem, sourcePath: path })) as {
    warnings: string[];
    parent: unknown;
  };
}

/** Saves the active document; asks for a path if it has none or `saveAs` is set. Resolves false if cancelled. */
export async function saveProject(opts?: { saveAs?: boolean }): Promise<boolean> {
  requireDesktop();
  const current = selectActiveDoc(useApp.getState());
  let path = opts?.saveAs ? null : current.filePath;
  if (!path) {
    const chosen = await save({
      defaultPath: current.filePath ?? suggestedFileName(documentName(current), 'tessel'),
      filters: [projectFilter()],
    });
    if (!chosen) return false;
    path = withExtension(chosen, 'tessel');
  }
  // Serialize after the dialog, by id: the document the user was asked about is the one that gets written.
  const doc = (await execute('document.serialize', { id: current.id })) as { id: string; json: string };
  await invoke('write_text_file', { path, contents: doc.json });
  await execute('document.mark_saved', { id: doc.id, filePath: path, name: fileStem(path) });
  return true;
}

/**
 * Asks for a path and exports the active document in the given format. Resolves false if cancelled.
 * OBJ also writes its .mtl and texture images into the chosen folder.
 */
export async function exportFile(format: ExportFormat, opts?: { selectionOnly?: boolean }): Promise<boolean> {
  requireDesktop();
  const params = { format, selectionOnly: opts?.selectionOnly ?? false };
  // Export first, so problems (e.g. nothing selected) show up before the user picks a file.
  let exported = (await execute('export.file', params)) as ExportResult;

  // A Minecraft model is named after its model file name, not the document.
  const javaName = (exported as { fileName?: string }).fileName?.replace(/\.json$/, '');
  const chosen = await save({
    defaultPath: suggestedFileName(javaName ?? documentName(selectActiveDoc(useApp.getState())), format),
    filters: [{ name: getT().files.formats[format], extensions: [format] }],
  });
  if (!chosen) return false;
  const path = withExtension(chosen, format);

  if (format === 'obj') {
    // The .obj names its side files after itself, so it is written again for the chosen name.
    exported = (await execute('export.file', { ...params, name: fileStem(path) })) as ExportResult;
    await invoke('write_obj_export', {
      path,
      text: exported.text ?? '',
      mtlName: exported.mtlName ?? '',
      mtl: exported.mtl ?? '',
      files: exported.files ?? [],
    });
  } else if (exported.text !== undefined) {
    await invoke('write_text_file', { path, contents: exported.text });
  } else {
    await invoke('write_binary_file', { path, base64: exported.base64 ?? '' });
  }
  return true;
}

export interface ImportOutcome {
  objects: { id: string; name: string }[];
  warnings: string[];
}

/** Shows an open dialog and imports the chosen 3D file into the active document. Resolves null if cancelled. */
export async function importFile(): Promise<ImportOutcome | null> {
  requireDesktop();
  const path = await open({
    multiple: false,
    directory: false,
    filters: [{ name: getT().files.models, extensions: [...importFormats] }],
  });
  if (!path) return null;
  const format = path.split('.').pop()?.toLowerCase() as ImportFormat;
  if (!importFormats.includes(format)) throw new Error(getT().files.unsupported(fileName(path)));
  const base64 = await invoke<string>('read_binary_file', { path });
  return (await execute('import.file', { format, name: fileName(path), base64 })) as ImportOutcome;
}

const imageExtensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const;

/**
 * Saves a rendered image: in the desktop app through a save dialog, in a plain browser as a download.
 * `name` is the suggested file name without extension. Resolves false if the dialog was cancelled.
 */
export async function saveImage(image: { mimeType: keyof typeof imageExtensions; base64: string }, name: string): Promise<boolean> {
  const extension = imageExtensions[image.mimeType];
  if (!isTauri()) {
    const link = document.createElement('a');
    link.href = `data:${image.mimeType};base64,${image.base64}`;
    link.download = suggestedFileName(name, extension);
    link.click();
    return true;
  }
  const chosen = await save({
    defaultPath: suggestedFileName(name, extension),
    filters: [{ name: getT().render.imageFile(extension === 'jpg' ? 'JPEG' : extension.toUpperCase()), extensions: extension === 'jpg' ? ['jpg', 'jpeg'] : [extension] }],
  });
  if (!chosen) return false;
  const path = extension === 'jpg' && chosen.toLowerCase().endsWith('.jpeg') ? chosen : withExtension(chosen, extension);
  await invoke('write_binary_file', { path, base64: image.base64 });
  return true;
}

/** A file from base64 data as a download (plain browser). Large files go through a Blob: data URLs have length limits. */
async function download(mimeType: string, base64: string, fileName: string): Promise<void> {
  const blob = await (await fetch(`data:${mimeType};base64,${base64}`)).blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const videoExtensions = { 'video/mp4': 'mp4', 'video/webm': 'webm' } as const;

/**
 * Saves an exported video: in the desktop app through a save dialog, in a plain browser as a download.
 * `name` is the suggested file name without extension. Resolves false if the dialog was cancelled.
 */
export async function saveVideo(video: { mimeType: keyof typeof videoExtensions; base64: string }, name: string): Promise<boolean> {
  const extension = videoExtensions[video.mimeType];
  if (!isTauri()) {
    await download(video.mimeType, video.base64, suggestedFileName(name, extension));
    return true;
  }
  const chosen = await save({
    defaultPath: suggestedFileName(name, extension),
    filters: [{ name: getT().video.file(extension.toUpperCase()), extensions: [extension] }],
  });
  if (!chosen) return false;
  await invoke('write_binary_file', { path: withExtension(chosen, extension), base64: video.base64 });
  return true;
}
