import type { ProjectEntry } from '../../bridge/projects';

// Pure helpers of the Projects panel: paths inside a project, file kinds and the visible tree rows.

/** What a file in a project is, by extension. */
export type FileKind = 'tessel' | 'model' | 'image' | 'mesh' | 'data';

const kinds: Record<string, FileKind> = {
  tessel: 'tessel',
  json: 'model',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  glb: 'mesh',
  gltf: 'mesh',
  obj: 'mesh',
  stl: 'mesh',
  ply: 'mesh',
  fbx: 'mesh',
};

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function fileKind(name: string): FileKind {
  return kinds[extensionOf(name)] ?? 'data';
}

/** File name without its extension. */
export function stemOf(name: string): string {
  const base = name.split('/').pop() ?? name;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/** Folder of a relative path ('' for the project folder itself). */
export function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

/** `dir/name`, or `name` at the top. */
export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** The absolute path of a project file, with the separator the project folder uses. */
export function absolutePath(root: string, relative: string): string {
  const separator = root.includes('\\') ? '\\' : '/';
  const trimmed = root.replace(/[\\/]+$/, '');
  return relative ? `${trimmed}${separator}${relative.split('/').join(separator)}` : trimmed;
}

/** `relative` if the absolute `path` lies inside the project folder `root`, otherwise null. */
export function relativeTo(root: string, path: string): string | null {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const base = norm(root);
  const full = norm(path);
  const caseless = /^[a-zA-Z]:/.test(base);
  const prefix = `${base}/`;
  const inside = caseless ? full.toLowerCase().startsWith(prefix.toLowerCase()) : full.startsWith(prefix);
  return inside ? full.slice(prefix.length) : null;
}

/** Adds `.extension` unless the name already ends with it. */
export function withExtension(name: string, extension: string): string {
  return name.toLowerCase().endsWith(`.${extension}`) ? name : `${name}.${extension}`;
}

/** Characters that no platform allows in a file name; checked before asking the desktop side. */
export function nameProblem(name: string): 'empty' | 'invalid' | null {
  const trimmed = name.trim();
  if (!trimmed) return 'empty';
  // eslint-disable-next-line no-control-regex
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(trimmed) || trimmed === '.' || trimmed === '..' || trimmed.endsWith('.')) return 'invalid';
  return null;
}

/** A folder name for a cloned repository: the repository name. */
export function folderForRepo(fullName: string): string {
  return fullName.split('/').pop() ?? fullName;
}

export interface TreeRow {
  entry: ProjectEntry;
  depth: number;
  expanded: boolean;
}

/** The rows the tree shows: the top-level entries and, below every expanded folder, its loaded entries. */
export function treeRows(entries: Record<string, ProjectEntry[]>, expanded: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (dir: string, depth: number) => {
    for (const entry of entries[dir] ?? []) {
      const open = entry.kind === 'dir' && expanded.has(entry.path);
      rows.push({ entry, depth, expanded: open });
      if (open) walk(entry.path, depth + 1);
    }
  };
  walk('', 0);
  return rows;
}

/** The paths of a renamed entry and of everything below it, mapped to their new place. */
export function movedPath(path: string, from: string, to: string): string {
  if (path === from) return to;
  return path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path;
}
