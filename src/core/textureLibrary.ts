// Texture library: textures that live as PNG files in a resource pack (a project's own
// `assets/<namespace>/textures/**`, extra library folders, or the vanilla assets) and that documents
// *link* to by resource location instead of embedding a copy for good. DOM-free and I/O-free: the
// files are reached through `TextureLibraryService` (implemented in src/texlib).

import { parseResourceLocation } from './minecraftAssets';
import type { Texture } from './types';

/** Where a linked texture lives: `namespace:path`, `path` below `textures/` without `.png` (e.g. `block/oak_planks`). */
export interface TextureLink {
  readonly namespace: string;
  readonly path: string;
}

/** `namespace:path`, always with the namespace. */
export function linkLocation(link: TextureLink): string {
  return `${link.namespace}:${link.path}`;
}

/** As a Minecraft model writes it: the namespace is left out when it is `minecraft`. */
export function shortLinkLocation(link: TextureLink): string {
  return link.namespace === 'minecraft' ? link.path : linkLocation(link);
}

/**
 * Parses what a user or agent may type for a texture: `ns:folder/name`, `folder/name` (default
 * namespace), with or without `.png`, a leading `textures/`, or a whole `assets/ns/textures/...png` path.
 */
export function parseTextureLocation(text: string, defaultNamespace = 'minecraft'): TextureLink {
  let raw = text.trim().replace(/\\/g, '/');
  const fromFile = fileTextureLink(raw);
  if (fromFile) return fromFile;
  raw = raw.replace(/\.png$/i, '');
  const colon = raw.indexOf(':');
  const namespace = colon >= 0 ? raw.slice(0, colon) : '';
  let path = colon >= 0 ? raw.slice(colon + 1) : raw;
  path = path.replace(/^textures\//, '');
  const parsed = parseResourceLocation(`${namespace || defaultNamespace}:${path}`);
  return { namespace: parsed.namespace, path: parsed.path };
}

/** Parses a location or returns null instead of throwing. */
export function tryTextureLocation(text: string, defaultNamespace?: string): TextureLink | null {
  try {
    return parseTextureLocation(text, defaultNamespace);
  } catch {
    return null;
  }
}

/** The folder part of the path (`block` for `block/stone`, '' for `stone`). */
export function linkFolder(link: TextureLink): string {
  const slash = link.path.lastIndexOf('/');
  return slash < 0 ? '' : link.path.slice(0, slash);
}

/** The file name without `.png`. */
export function linkName(link: TextureLink): string {
  return link.path.slice(link.path.lastIndexOf('/') + 1);
}

export function joinLink(namespace: string, folder: string, name: string): TextureLink {
  const cleanFolder = folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return parseTextureLocation(`${namespace}:${cleanFolder ? `${cleanFolder}/` : ''}${name}`);
}

export function sameLink(a: TextureLink | undefined, b: TextureLink | undefined): boolean {
  return !!a && !!b && a.namespace === b.namespace && a.path === b.path;
}

/** `assets/<ns>/textures/<path>.png` (or without `assets/` for a library whose root is an assets folder). */
export function textureFilePath(link: TextureLink, assets = 'assets'): string {
  return `${assets ? `${assets}/` : ''}${link.namespace}/textures/${link.path}.png`;
}

/** The link of a texture file path inside a pack, or null if the path is not a texture. */
export function fileTextureLink(file: string): TextureLink | null {
  const match = /^(?:.*\/)?assets\/([^/]+)\/textures\/(.+)\.png$/i.exec(file.replace(/\\/g, '/')) ?? /^([^/]+)\/textures\/(.+)\.png$/i.exec(file.replace(/\\/g, '/'));
  if (!match) return null;
  try {
    const parsed = parseResourceLocation(`${match[1]}:${match[2]}`);
    return { namespace: parsed.namespace, path: parsed.path };
  } catch {
    return null;
  }
}

/** The Minecraft resource location of a texture with a link or a Java reference, else null. */
export function textureLink(texture: Pick<Texture, 'link' | 'java' | 'name'>): TextureLink | null {
  if (texture.link) return texture.link;
  if (!texture.java) return null;
  return tryTextureLocation(`${texture.java.namespace || 'minecraft'}:${texture.java.folder ? `${texture.java.folder.replace(/^\/+|\/+$/g, '')}/` : ''}${texture.name}`);
}

// ---- project configuration ------------------------------------------------------------------------

/** The small config file at the root of a project, shared with the team through git. */
export const PROJECT_CONFIG_FILE = 'tessel.project.json';

export interface ProjectTextureConfig {
  /** Namespace new library textures go into, e.g. `surf_textures`; null = ask / `minecraft`. */
  readonly defaultNamespace: string | null;
  /** Folder below `textures/` new textures go into, e.g. `block`. */
  readonly defaultFolder: string;
}

export interface ProjectConfig {
  readonly textures: ProjectTextureConfig;
}

export const defaultProjectConfig: ProjectConfig = { textures: { defaultNamespace: null, defaultFolder: 'block' } };

const NAMESPACE = /^[a-z0-9_.-]+$/;
const FOLDER = /^[a-z0-9_.\-/]*$/;

export function validNamespace(namespace: string): boolean {
  return NAMESPACE.test(namespace);
}

export function validFolder(folder: string): boolean {
  return FOLDER.test(folder) && !folder.startsWith('/') && !folder.endsWith('/') && !folder.split('/').some((p) => p === '..' || p === '.' || (p === '' && folder !== ''));
}

/** Reads the config leniently: unknown keys are ignored here (and kept by `serializeProjectConfig`), bad values fall back. */
export function parseProjectConfig(text: string | null | undefined): ProjectConfig {
  if (!text) return defaultProjectConfig;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${PROJECT_CONFIG_FILE} is not valid JSON`);
  }
  const textures = (raw && typeof raw === 'object' ? (raw as Record<string, unknown>).textures : undefined) as Record<string, unknown> | undefined;
  const namespace = typeof textures?.defaultNamespace === 'string' && validNamespace(textures.defaultNamespace) ? textures.defaultNamespace : null;
  const folder = typeof textures?.defaultFolder === 'string' && validFolder(textures.defaultFolder) ? textures.defaultFolder : defaultProjectConfig.textures.defaultFolder;
  return { textures: { defaultNamespace: namespace, defaultFolder: folder } };
}

/** The config as pretty JSON; other keys of the previous file (e.g. from newer Tessel versions) are kept. */
export function serializeProjectConfig(config: ProjectConfig, previous?: string | null): string {
  let base: Record<string, unknown> = {};
  try {
    const parsed: unknown = previous ? JSON.parse(previous) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) base = parsed as Record<string, unknown>;
  } catch {
    // A broken file is replaced.
  }
  const oldTextures = base.textures && typeof base.textures === 'object' ? (base.textures as Record<string, unknown>) : {};
  const textures = { ...oldTextures, defaultNamespace: config.textures.defaultNamespace, defaultFolder: config.textures.defaultFolder };
  return `${JSON.stringify({ ...base, textures }, null, 2)}\n`;
}

// ---- animation (.mcmeta) --------------------------------------------------------------------------

export interface TextureAnimation {
  /** Number of frames (from the frame list, or the image height / frame height). */
  readonly frames: number;
  /** Ticks per frame (default 1). */
  readonly frametime: number;
  readonly interpolate: boolean;
  /** Pixel size of one frame. */
  readonly frameWidth: number;
  readonly frameHeight: number;
}

/** Animation info of a texture from its `.png.mcmeta`, or null if it has none or the file is unreadable. */
export function parseMcmeta(text: string | null | undefined, width: number, height: number): TextureAnimation | null {
  if (!text) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const animation = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).animation : undefined;
  if (!animation || typeof animation !== 'object') return null;
  const a = animation as Record<string, unknown>;
  const positive = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);
  // Without explicit sizes frames are square, as wide as the image.
  const frameWidth = positive(a.width) ?? (positive(a.height) ? width : Math.min(width, height));
  const frameHeight = positive(a.height) ?? frameWidth;
  const list = Array.isArray(a.frames) ? a.frames.length : 0;
  const frames = list > 0 ? list : Math.max(1, Math.floor(height / Math.max(1, frameHeight)) * Math.max(1, Math.floor(width / Math.max(1, frameWidth))));
  return { frames, frametime: positive(a.frametime) ?? 1, interpolate: a.interpolate === true, frameWidth, frameHeight };
}

// ---- library sources and entries --------------------------------------------------------------------

export const librarySourceKinds = ['project', 'folder', 'vanilla'] as const;
export type LibrarySourceKind = (typeof librarySourceKinds)[number];

export interface LibrarySource {
  /** `project:<id>`, `folder:<id>` or `vanilla`. */
  readonly id: string;
  readonly kind: LibrarySourceKind;
  readonly name: string;
  /** Absolute folder (not for vanilla). */
  readonly path?: string;
  readonly readOnly: boolean;
  /** False when the folder is missing or the vanilla assets are not configured. */
  readonly available: boolean;
}

/** One texture file of a source. */
export interface LibraryEntry {
  /** `namespace:path`. */
  readonly location: string;
  readonly namespace: string;
  readonly path: string;
  readonly source: string;
  readonly sourceKind: LibrarySourceKind;
  /** Relative to the source root. */
  readonly file: string;
  readonly width: number;
  readonly height: number;
  /** Bytes; 0 when unknown (vanilla). */
  readonly size: number;
  /** Last change in ms since 1970; 0 when unknown. */
  readonly modified: number;
  readonly animation: TextureAnimation | null;
  readonly readOnly: boolean;
}

/** Sources are searched in this order: the project first, then the extra folders, vanilla last. */
const sourceRank: Record<LibrarySourceKind, number> = { project: 0, folder: 1, vanilla: 2 };

/**
 * The entry a link resolves to: the first source (project, then library folders in their order, then
 * vanilla) that has a file at the location. `preferSource` wins if it has one.
 */
export function resolveLink(entries: readonly LibraryEntry[], link: TextureLink, preferSource?: string): LibraryEntry | null {
  const location = linkLocation(link);
  let best: LibraryEntry | null = null;
  for (const entry of entries) {
    if (entry.location !== location) continue;
    if (preferSource && entry.source === preferSource) return entry;
    if (!best || sourceRank[entry.sourceKind] < sourceRank[best.sourceKind]) best = entry;
  }
  return best;
}

export interface LibraryQuery {
  readonly source?: string;
  readonly namespace?: string;
  /** Folder below `textures/`; matches that folder and everything below it. */
  readonly folder?: string;
  /** Words that must all appear in the location (case-insensitive). */
  readonly search?: string;
}

/** Entries matching a query, sorted by location then source rank; a location shadowed by a higher-ranked source is kept (callers show both). */
export function filterEntries(entries: readonly LibraryEntry[], query: LibraryQuery): LibraryEntry[] {
  const words = (query.search ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const folder = query.folder?.replace(/^\/+|\/+$/g, '');
  return entries
    .filter((e) => !query.source || e.source === query.source)
    .filter((e) => !query.namespace || e.namespace === query.namespace)
    .filter((e) => !folder || e.path.startsWith(`${folder}/`))
    .filter((e) => words.every((w) => e.location.includes(w)))
    .sort((a, b) => a.location.localeCompare(b.location) || sourceRank[a.sourceKind] - sourceRank[b.sourceKind]);
}

/** Namespaces and their folders (every level), for the browser tree. */
export function libraryTree(entries: readonly LibraryEntry[]): { namespace: string; folders: string[]; count: number }[] {
  const byNamespace = new Map<string, { folders: Set<string>; count: number }>();
  for (const entry of entries) {
    const item = byNamespace.get(entry.namespace) ?? { folders: new Set<string>(), count: 0 };
    item.count++;
    const parts = entry.path.split('/').slice(0, -1);
    for (let i = 1; i <= parts.length; i++) item.folders.add(parts.slice(0, i).join('/'));
    byNamespace.set(entry.namespace, item);
  }
  return [...byNamespace.entries()]
    .sort(([a], [b]) => (a === 'minecraft' ? 1 : b === 'minecraft' ? -1 : a.localeCompare(b)))
    .map(([namespace, item]) => ({ namespace, folders: [...item.folders].sort(), count: item.count }));
}

// ---- keeping linked textures in step with their files ----------------------------------------------

/**
 * What to do when a linked texture's file was read: `baseline` is the file content this session last
 * read or wrote for the location (undefined before the first read).
 * - `same`: the document already shows the file.
 * - `update`: take the file (the document has no unsaved pixel changes of its own).
 * - `local`: keep the document's pixels; they are newer and will be written on save.
 * - `conflict`: both changed; the document keeps its pixels (saving overwrites the file).
 */
export function syncDecision(textureData: string, fileData: string, baseline: string | undefined): 'same' | 'update' | 'local' | 'conflict' {
  if (fileData === textureData) return 'same';
  if (baseline === undefined || textureData === baseline) return 'update';
  if (fileData === baseline) return 'local';
  return 'conflict';
}

/** Linked textures whose pixels differ from what the library file had when last read or written. */
export function pendingWrites(textures: Readonly<Record<string, Texture>>, baseline: (location: string) => string | undefined): Texture[] {
  return Object.values(textures).filter((t) => t.link && t.mimeType === 'image/png' && baseline(linkLocation(t.link)) !== undefined && baseline(linkLocation(t.link)) !== t.data);
}

// ---- rewriting references after a move ------------------------------------------------------------

/**
 * A model JSON with every texture reference to `from` changed to `to` (short form for minecraft), or
 * null when it has none. Only values of the "textures" object count; the file keeps its formatting
 * where the references can be replaced in place.
 */
export function rewriteModelTextures(text: string, from: TextureLink, to: TextureLink): string | null {
  let model: unknown;
  try {
    model = JSON.parse(text);
  } catch {
    return null;
  }
  if (!model || typeof model !== 'object' || Array.isArray(model)) return null;
  const textures = (model as Record<string, unknown>).textures;
  if (!textures || typeof textures !== 'object' || Array.isArray(textures)) return null;
  const forms = new Set([linkLocation(from), shortLinkLocation(from)]);
  const matches = (value: unknown) => {
    if (typeof value !== 'string' || value.startsWith('#')) return false;
    const link = tryTextureLocation(value);
    return !!link && sameLink(link, from) && forms.has(value);
  };
  const keys = Object.keys(textures).filter((k) => matches((textures as Record<string, unknown>)[k]));
  if (keys.length === 0) return null;
  const replacement = JSON.stringify(shortLinkLocation(to));
  // In place: each matching string literal must appear exactly as often as the textures object holds it.
  let out = text;
  let inPlace = true;
  for (const form of new Set(keys.map((k) => (textures as Record<string, string>)[k]))) {
    const literal = JSON.stringify(form);
    const count = out.split(literal).length - 1;
    const expected = keys.filter((k) => (textures as Record<string, string>)[k] === form).length;
    if (count !== expected) {
      inPlace = false;
      break;
    }
    out = out.split(literal).join(replacement);
  }
  if (inPlace) return out;
  const next = { ...(model as Record<string, unknown>), textures: { ...textures } as Record<string, unknown> };
  for (const k of keys) (next.textures as Record<string, unknown>)[k] = shortLinkLocation(to);
  return `${JSON.stringify(next, null, 2)}\n`;
}

/** A .tessel file whose textures linked to `from` now link to `to`, or null when it has none. */
export function rewriteProjectLinks(text: string, from: TextureLink, to: TextureLink): string | null {
  let project: { textures?: unknown };
  try {
    project = JSON.parse(text) as { textures?: unknown };
  } catch {
    return null;
  }
  if (!project || !Array.isArray(project.textures)) return null;
  let changed = false;
  const textures = project.textures.map((texture: unknown) => {
    const t = texture as Partial<Texture> | null;
    if (!t || !t.link || !sameLink(t.link, from)) return texture;
    changed = true;
    return relinkedFields(t as Texture, to);
  });
  return changed ? JSON.stringify({ ...project, textures }) : null;
}

/** The fields of a texture that change when it is linked to `link`: the link and, in Minecraft documents, name and Java location. */
export function relinkedFields<T extends Pick<Texture, 'name' | 'java'>>(texture: T, link: TextureLink): T & { link: TextureLink } {
  return {
    ...texture,
    link: { namespace: link.namespace, path: link.path },
    ...(texture.java ? { name: linkName(link), java: { ...texture.java, namespace: link.namespace, folder: linkFolder(link) } } : {}),
  };
}

/** The service behind the library commands (src/texlib). Rejects with clear English messages. */
export interface TextureLibraryService {
  /** The sources in search order. */
  sources(): Promise<LibrarySource[]>;
  /** Every entry of every available source (cached; `refresh` rescans). */
  entries(opts?: { refresh?: boolean }): Promise<LibraryEntry[]>;
  /** The file a link resolves to, with its PNG as base64; null if no source has it. Records the baseline. */
  read(link: TextureLink, opts?: { source?: string }): Promise<{ entry: LibraryEntry; data: string } | null>;
  /**
   * Writes a PNG (base64) to the location in a writable source (default: where it resolves, else the
   * project). Optionally its `.mcmeta` text. Records the baseline. Returns the entry.
   */
  write(link: TextureLink, data: string, opts?: { source?: string; mcmeta?: string }): Promise<LibraryEntry>;
  /** Moves a texture file (and its .mcmeta) inside its source; `rewrite` also updates project models and .tessel files. */
  move(from: TextureLink, to: TextureLink, opts?: { source?: string; rewrite?: boolean }): Promise<{ entry: LibraryEntry; rewritten: string[] }>;
  reveal(link: TextureLink, opts?: { source?: string }): Promise<void>;
  /** The project's config and the project's source id (null without a project). */
  config(): Promise<{ project: string | null; config: ProjectConfig }>;
  setConfig(config: ProjectConfig): Promise<void>;
  addFolder(path: string, name?: string): Promise<LibrarySource>;
  removeFolder(id: string): Promise<void>;
  /** The content this session last read or wrote for a location. */
  baseline(location: string): string | undefined;
}
