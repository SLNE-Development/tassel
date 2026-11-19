// Reading model files from disk for the import commands (implemented by src/bridge/javaModels.ts in the app,
// by fakes in tests). Kept free of I/O so the commands stay testable.
import type { JavaModelSourceService } from './minecraft/parents';
import type { JavaImage } from './types';

export const modelFileExtensions = ['json', 'bbmodel'] as const;
export type ModelFileKind = (typeof modelFileExtensions)[number];

/** `json` or `bbmodel` for a path with one of those extensions, else null. */
export function modelFileKind(path: string): ModelFileKind | null {
  const ext = path.split('.').pop()?.toLowerCase();
  return ext === 'json' || ext === 'bbmodel' ? ext : null;
}

export interface ModelFileService extends JavaModelSourceService {
  /** Absolute paths of the .json and .bbmodel files in a folder (and its subfolders when `recursive`). */
  list(folder: string, recursive: boolean): Promise<string[]>;
  /** A Java model with the images of its own textures found in its resource pack (keyed by location as written). */
  readJava(path: string): Promise<{ json: string; images: Record<string, JavaImage> }>;
  /** A Blockbench project with the images of textures that are not embedded but found on disk (keyed by texture index). */
  readBbmodel(path: string): Promise<{ text: string; images: Record<number, JavaImage> }>;
  /** Writes a .tessel or .json file; refuses to replace an existing file unless `overwrite`. */
  write(path: string, text: string, overwrite: boolean): Promise<void>;
}

/** Path helpers that work for both Windows and POSIX paths. */
export function splitPath(path: string): { dir: string; stem: string; ext: string; sep: string } {
  const sep = path.includes('\\') && !path.includes('/') ? '\\' : path.includes('\\') ? '\\' : '/';
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const dir = cut >= 0 ? path.slice(0, cut) : '';
  const file = cut >= 0 ? path.slice(cut + 1) : path;
  const dot = file.lastIndexOf('.');
  return { dir, stem: dot > 0 ? file.slice(0, dot) : file, ext: dot > 0 ? file.slice(dot + 1) : '', sep };
}

/** `path` relative to `root` (both absolute, same style), or null if it is not inside it. Separators become '/'. */
export function relativePath(root: string, path: string): string | null {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const r = norm(root);
  const p = norm(path);
  const caseless = /^[a-z]:/i.test(r);
  const head = p.slice(0, r.length);
  if (!(caseless ? head.toLowerCase() === r.toLowerCase() : head === r) || p[r.length] !== '/') return null;
  return p.slice(r.length + 1);
}

/** Joins an absolute folder and a '/'-separated relative path in the folder's style. */
export function joinPath(folder: string, rel: string): string {
  const sep = folder.includes('\\') ? '\\' : '/';
  return `${folder.replace(/[\\/]+$/, '')}${sep}${rel.split('/').join(sep)}`;
}
