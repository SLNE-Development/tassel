import { invoke, isTauri } from '@tauri-apps/api/core';
import { useApp } from '../app/store';
import { projectsApi, type ProjectEntry, type ProjectInfo } from '../bridge/projects';
import { base64ImageSize } from '../core/imageInfo';
import { activeDoc } from '../core/state';
import {
  PROJECT_CONFIG_FILE,
  defaultProjectConfig,
  fileTextureLink,
  linkLocation,
  parseMcmeta,
  parseProjectConfig,
  resolveLink,
  rewriteModelTextures,
  rewriteProjectLinks,
  serializeProjectConfig,
  textureFilePath,
  type LibraryEntry,
  type LibrarySource,
  type ProjectConfig,
  type TextureLibraryService,
  type TextureLink,
} from '../core/textureLibrary';
import { getMinecraftAssets, minecraftAssetsStatus, onMinecraftAssetsChange } from '../mcassets';
import { relativeTo } from '../ui/projects/projectModel';
import { useProjects } from '../ui/projects/projectsStore';

// The texture library of the desktop app: the project's resource pack and the extra library folders
// through the Rust `texlib_*` commands (src-tauri/src/texlib.rs), vanilla through the Minecraft
// assets loader (read-only). Entries are cached; `onLibraryChange` tells the UI when they change.

interface LibraryFolder {
  source: string;
  id: string;
  name: string;
  path: string;
  exists: boolean;
}

interface ScannedTexture {
  file: string;
  namespace: string;
  path: string;
  size: number;
  modified: number;
  width: number;
  height: number;
  mcmeta?: string;
}

interface Scan {
  assets: string;
  textures: ScannedTexture[];
  truncated: boolean;
}

const api = {
  folders: () => invoke<LibraryFolder[]>('texlib_folders'),
  addFolder: (path: string, name?: string) => invoke<LibraryFolder>('texlib_add_folder', { path, name }),
  removeFolder: (id: string) => invoke<void>('texlib_remove_folder', { id }),
  scan: (source: string) => invoke<Scan>('texlib_scan', { source }),
  read: (source: string, file: string) => invoke<string>('texlib_read', { source, file }),
  readText: (source: string, file: string) => invoke<string>('texlib_read_text', { source, file }),
  write: (source: string, file: string, data: { base64?: string; text?: string }) => invoke<number>('texlib_write', { source, file, ...data }),
  trash: (source: string, file: string) => invoke<void>('texlib_trash', { source, file }),
  move: (source: string, from: string, to: string) => invoke<void>('texlib_move', { source, from, to }),
  stat: (source: string, files: string[]) => invoke<(number | null)[]>('texlib_stat', { source, files }),
  listFiles: (source: string, dir: string) => invoke<ProjectEntry[]>('texlib_list_files', { source, dir }),
  reveal: (source: string, file?: string) => invoke<void>('texlib_reveal', { source, file }),
};

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

// ---- which project ------------------------------------------------------------------------------

/** The project of the library: the one the active document's file is in, else the Projects panel's active one. */
export async function libraryProject(): Promise<ProjectInfo | null> {
  let { projects } = useProjects.getState();
  if (projects.length === 0) {
    projects = await projectsApi.list().catch(() => []);
    if (projects.length > 0 && useProjects.getState().projects.length === 0) useProjects.setState({ projects });
  }
  const app = useApp.getState();
  const filePath = app.docs[app.activeDocId] ? activeDoc(app).filePath : null;
  const containing = filePath ? projects.find((p) => p.exists && relativeTo(p.path, filePath) !== null) : undefined;
  const active = projects.find((p) => p.id === useProjects.getState().activeId && p.exists);
  return containing ?? active ?? null;
}

// ---- the cache ----------------------------------------------------------------------------------

interface SourceScan {
  source: LibrarySource;
  /** `assets` or '' (the folder that holds the namespaces). */
  assets: string;
  entries: LibraryEntry[];
  truncated: boolean;
  error: string | null;
}

let scans: SourceScan[] = [];
let scannedKey = '';
let scanning: Promise<SourceScan[]> | null = null;
let vanillaCache: { key: string; entries: LibraryEntry[] } | null = null;
const baselines = new Map<string, string>();
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of listeners) listener();
}

/** Calls `listener` when the library's entries or sources change. */
export function onLibraryChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The scans as last loaded (sources with their entries and problems), for the panel. */
export function librarySnapshot(): readonly SourceScan[] {
  return scans;
}

async function currentSources(): Promise<LibrarySource[]> {
  const sources: LibrarySource[] = [];
  const project = await libraryProject();
  if (project) sources.push({ id: `project:${project.id}`, kind: 'project', name: project.name, path: project.path, readOnly: false, available: project.exists });
  const folders = await api.folders().catch(() => []);
  for (const folder of folders) sources.push({ id: folder.source, kind: 'folder', name: folder.name, path: folder.path, readOnly: false, available: folder.exists });
  const assets = minecraftAssetsStatus();
  sources.push({ id: 'vanilla', kind: 'vanilla', name: assets.info?.version ? `Minecraft ${assets.info.version}` : 'Minecraft', readOnly: true, available: assets.state === 'ready' });
  return sources;
}

function fromScan(source: LibrarySource, texture: ScannedTexture): LibraryEntry {
  return {
    location: `${texture.namespace}:${texture.path}`,
    namespace: texture.namespace,
    path: texture.path,
    source: source.id,
    sourceKind: source.kind,
    file: texture.file,
    width: texture.width,
    height: texture.height,
    size: texture.size,
    modified: texture.modified,
    animation: parseMcmeta(texture.mcmeta, texture.width, texture.height),
    readOnly: source.readOnly,
  };
}

async function scanVanilla(source: LibrarySource): Promise<SourceScan> {
  const assets = getMinecraftAssets();
  if (!assets) return { source, assets: 'assets', entries: [], truncated: false, error: null };
  const key = minecraftAssetsStatus().path;
  if (vanillaCache?.key !== key) {
    const namespaces = minecraftAssetsStatus().info?.namespaces ?? ['minecraft'];
    const entries: LibraryEntry[] = [];
    for (const namespace of namespaces) {
      const files = await assets.list(`assets/${namespace}/textures/`);
      const animated = new Set(files.filter((f) => f.endsWith('.png.mcmeta')).map((f) => f.slice(0, -'.mcmeta'.length)));
      for (const file of files) {
        const link = fileTextureLink(file);
        if (!link) continue;
        entries.push({
          location: linkLocation(link),
          ...link,
          source: source.id,
          sourceKind: 'vanilla',
          file,
          width: 0,
          height: 0,
          size: 0,
          modified: 0,
          // Frame counts need the image; the panel reads them when a texture is shown in detail.
          animation: animated.has(file) ? { frames: 0, frametime: 1, interpolate: false, frameWidth: 0, frameHeight: 0 } : null,
          readOnly: true,
        });
      }
    }
    vanillaCache = { key, entries };
  }
  return { source, assets: 'assets', entries: vanillaCache.entries, truncated: false, error: null };
}

async function scanAll(): Promise<SourceScan[]> {
  const sources = await currentSources();
  const results = await Promise.all(
    sources.map(async (source): Promise<SourceScan> => {
      if (!source.available) return { source, assets: 'assets', entries: [], truncated: false, error: null };
      try {
        if (source.kind === 'vanilla') return await scanVanilla(source);
        const scan = await api.scan(source.id);
        return { source, assets: scan.assets, entries: scan.textures.map((t) => fromScan(source, t)), truncated: scan.truncated, error: null };
      } catch (error) {
        return { source, assets: 'assets', entries: [], truncated: false, error: errorText(error) };
      }
    }),
  );
  scans = results;
  scannedKey = sources.map((s) => `${s.id}=${s.available}`).join('|');
  changed();
  return results;
}

async function ensureScans(refresh = false): Promise<SourceScan[]> {
  if (scanning) return scanning;
  // The project depends on the active document, so a different source list means a rescan.
  const key = (await currentSources()).map((s) => `${s.id}=${s.available}`).join('|');
  if (!refresh && key === scannedKey) return scans;
  scanning = scanAll().finally(() => {
    scanning = null;
  });
  return scanning;
}

/** The cached entry a link resolves to (no rescan). */
export function resolveCached(link: TextureLink): LibraryEntry | null {
  return resolveLink(allEntries(), link);
}

function allEntries(): LibraryEntry[] {
  return scans.flatMap((s) => s.entries);
}

function scanOf(source: string): SourceScan {
  const scan = scans.find((s) => s.source.id === source);
  if (!scan) throw new Error(`The texture library source "${source}" is not available`);
  return scan;
}

function writableSource(link: TextureLink, preferred?: string): SourceScan {
  if (preferred) {
    const scan = scanOf(preferred);
    if (scan.source.readOnly) throw new Error(`${scan.source.name} is read-only: import a copy into the project instead`);
    return scan;
  }
  const resolved = resolveLink(allEntries(), link);
  if (resolved?.readOnly) throw new Error(`${linkLocation(link)} is a read-only vanilla texture: import a copy into the project instead (library_import with link)`);
  if (resolved) return scanOf(resolved.source);
  const project = scans.find((s) => s.source.kind === 'project' && s.source.available);
  if (!project) throw new Error('No project is open to write library textures into: open or add a project in the Projects panel');
  return project;
}

/** Replaces or adds an entry in the cache after a write. */
function remember(scan: SourceScan, entry: LibraryEntry): void {
  scan.entries = [...scan.entries.filter((e) => e.location !== entry.location), entry];
  scans = [...scans];
  changed();
}

async function readEntry(entry: LibraryEntry): Promise<string | null> {
  if (entry.sourceKind === 'vanilla') {
    const bytes = await getMinecraftAssets()?.textureBytes(entry.location);
    return bytes ? bytesToBase64(bytes) : null;
  }
  try {
    return await api.read(entry.source, entry.file);
  } catch (error) {
    // Deleted since the last scan: report as missing.
    if (/does not exist|not found|cannot find|os error 2/i.test(errorText(error))) return null;
    throw error;
  }
}

/** Reads a library file's PNG as base64, for thumbnails (does not touch the baselines). */
export async function readLibraryImage(entry: LibraryEntry): Promise<string | null> {
  return readEntry(entry);
}

/** Last-modified times of library files, null when missing (for the watcher). */
export async function statFiles(source: string, files: string[]): Promise<(number | null)[]> {
  return api.stat(source, files);
}

/** Moves a library texture to the trash. */
export async function trashLibraryTexture(entry: LibraryEntry): Promise<void> {
  if (entry.readOnly) throw new Error('Vanilla textures are read-only');
  await api.trash(entry.source, entry.file);
  await ensureScans(true);
}

export const textureLibrary: TextureLibraryService = {
  async sources() {
    return (await ensureScans()).map((s) => s.source);
  },

  async entries(opts) {
    await ensureScans(opts?.refresh);
    return allEntries();
  },

  async read(link, opts) {
    await ensureScans();
    let entry = resolveLink(allEntries(), link, opts?.source);
    // A file added since the last scan.
    if (!entry) {
      await ensureScans(true);
      entry = resolveLink(allEntries(), link, opts?.source);
    }
    if (!entry) return null;
    const data = await readEntry(entry);
    if (data === null) return null;
    baselines.set(entry.location, data);
    return { entry, data };
  },

  async write(link, data, opts) {
    await ensureScans();
    const scan = writableSource(link, opts?.source);
    const file = textureFilePath(link, scan.assets);
    const modified = await api.write(scan.source.id, file, { base64: data });
    if (opts?.mcmeta !== undefined) await api.write(scan.source.id, `${file}.mcmeta`, { text: opts.mcmeta });
    const previous = scan.entries.find((e) => e.location === linkLocation(link));
    const size = base64ImageSize(data) ?? { width: 0, height: 0 };
    const entry: LibraryEntry = {
      location: linkLocation(link),
      ...link,
      source: scan.source.id,
      sourceKind: scan.source.kind,
      file,
      ...size,
      size: Math.floor((data.length * 3) / 4),
      modified,
      animation: opts?.mcmeta !== undefined ? parseMcmeta(opts.mcmeta, size.width, size.height) : (previous?.animation ?? null),
      readOnly: false,
    };
    baselines.set(entry.location, data);
    remember(scan, entry);
    return entry;
  },

  async move(from, to, opts) {
    await ensureScans();
    const entry = resolveLink(allEntries(), from, opts?.source);
    if (!entry) throw new Error(`The texture library has no ${linkLocation(from)}`);
    if (entry.readOnly) throw new Error('Vanilla textures are read-only and cannot be moved');
    const scan = scanOf(entry.source);
    if (scan.entries.some((e) => e.location === linkLocation(to))) throw new Error(`${linkLocation(to)} already exists in ${scan.source.name}`);
    const target = textureFilePath(to, scan.assets);
    await api.move(scan.source.id, entry.file, target);
    const baseline = baselines.get(entry.location);
    if (baseline !== undefined) baselines.set(linkLocation(to), baseline);
    const rewritten = opts?.rewrite === false || scan.source.kind !== 'project' ? [] : await rewriteReferences(scan, from, to);
    await ensureScans(true);
    const moved = resolveLink(allEntries(), to, scan.source.id);
    if (!moved) throw new Error(`${linkLocation(to)} was moved but cannot be found again`);
    return { entry: moved, rewritten };
  },

  async reveal(link, opts) {
    await ensureScans();
    const entry = resolveLink(allEntries(), link, opts?.source);
    if (!entry) throw new Error(`The texture library has no ${linkLocation(link)}`);
    if (entry.sourceKind === 'vanilla') throw new Error('Vanilla textures are inside the Minecraft install and cannot be shown in the file manager');
    await api.reveal(entry.source, entry.file);
  },

  async config() {
    const project = await libraryProject();
    if (!project) return { project: null, config: defaultProjectConfig };
    const text = await projectsApi.readText(project.id, PROJECT_CONFIG_FILE).catch(() => null);
    let config: ProjectConfig = defaultProjectConfig;
    try {
      config = parseProjectConfig(text);
    } catch {
      // A broken config file behaves like none until it is saved again.
    }
    return { project: `project:${project.id}`, config };
  },

  async setConfig(config) {
    const project = await libraryProject();
    if (!project) throw new Error('No project is open');
    const previous = await projectsApi.readText(project.id, PROJECT_CONFIG_FILE).catch(() => null);
    await projectsApi.writeText(project.id, PROJECT_CONFIG_FILE, serializeProjectConfig(config, previous));
    changed();
  },

  async addFolder(path, name) {
    const folder = await api.addFolder(path, name);
    await ensureScans(true);
    return scanOf(folder.source).source;
  },

  async removeFolder(id) {
    await api.removeFolder(id.replace(/^folder:/, ''));
    await ensureScans(true);
  },

  baseline(location) {
    return baselines.get(location);
  },
};

/** Updates model JSONs (assets/<ns>/models/**) and .tessel files of a project that refer to a moved texture. */
async function rewriteReferences(scan: SourceScan, from: TextureLink, to: TextureLink): Promise<string[]> {
  const projectId = scan.source.id.replace(/^project:/, '');
  const files = await api.listFiles(scan.source.id, '');
  const rewritten: string[] = [];
  for (const file of files) {
    const isModel = /(^|\/)assets\/[^/]+\/models\/.+\.json$/i.test(file.path) || (!scan.assets && /^[^/]+\/models\/.+\.json$/i.test(file.path));
    const isProject = file.path.toLowerCase().endsWith('.tessel');
    if (!isModel && !isProject) continue;
    const text = await projectsApi.readText(projectId, file.path).catch(() => null);
    if (text === null) continue;
    const next = isModel ? rewriteModelTextures(text, from, to) : rewriteProjectLinks(text, from, to);
    if (next === null || next === text) continue;
    await projectsApi.writeText(projectId, file.path, next);
    rewritten.push(file.path);
  }
  return rewritten;
}

/** Registers the service (desktop app only) and rescans when the vanilla assets or the project change. */
export function installTextureLibrary(services: { textureLibrary?: TextureLibraryService | null }): void {
  if (!isTauri()) return;
  services.textureLibrary = textureLibrary;
  onMinecraftAssetsChange(() => {
    vanillaCache = null;
    void ensureScans(true);
  });
  let lastProject = useProjects.getState().activeId;
  let lastProjects = useProjects.getState().projects;
  useProjects.subscribe((state) => {
    if (state.activeId === lastProject && state.projects === lastProjects) return;
    lastProject = state.activeId;
    lastProjects = state.projects;
    void ensureScans();
  });
}
