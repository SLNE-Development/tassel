// Minecraft resource locations and the asset-source service, without any I/O.
//
// Vanilla assets are never bundled: they are read from the user's own Minecraft install (a client
// .jar or an unpacked resource pack folder, see the `minecraftAssets` preference). The runtime loader
// lives in src/mcassets; this file only knows how a `namespace:path` id maps to a file in the pack.

export const DEFAULT_NAMESPACE = 'minecraft';

/** A parsed `namespace:path` id, e.g. `minecraft:block/stone`. */
export interface ResourceLocation {
  namespace: string;
  path: string;
}

/** The kinds of files an id can name, and where they live under `assets/<namespace>/`. */
export const assetKinds = {
  texture: { folder: 'textures', extension: '.png' },
  textureMeta: { folder: 'textures', extension: '.png.mcmeta' },
  model: { folder: 'models', extension: '.json' },
  /** Item model definitions (`assets/<ns>/items/`, Minecraft 1.21.4 and later). */
  itemDefinition: { folder: 'items', extension: '.json' },
  blockstate: { folder: 'blockstates', extension: '.json' },
} as const;
export type AssetKind = keyof typeof assetKinds;

const NAMESPACE = /^[a-z0-9_.-]+$/;
const PATH = /^[a-z0-9_.\-/]+$/;

/**
 * Parses `namespace:path` (the namespace defaults to `minecraft`). A leading `#` (a texture variable,
 * not an id) and anything Minecraft itself would reject throw an error naming the id.
 * Upper-case letters are accepted and lower-cased, as some older packs use them.
 */
export function parseResourceLocation(id: string, defaultNamespace = DEFAULT_NAMESPACE): ResourceLocation {
  const raw = id.trim().toLowerCase();
  const colon = raw.indexOf(':');
  const namespace = colon >= 0 ? raw.slice(0, colon) || defaultNamespace : defaultNamespace;
  const path = colon >= 0 ? raw.slice(colon + 1) : raw;
  if (!NAMESPACE.test(namespace)) throw new Error(`"${id}" is not a valid resource location: bad namespace "${namespace}"`);
  if (!path || !PATH.test(path) || path.startsWith('/') || path.endsWith('/') || path.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`"${id}" is not a valid resource location: bad path "${path}"`);
  }
  return { namespace, path };
}

/** `namespace:path`, always with the namespace. */
export function formatResourceLocation(location: ResourceLocation): string {
  return `${location.namespace}:${location.path}`;
}

/** The file of an id inside a pack, e.g. `texture` of `block/stone` → `assets/minecraft/textures/block/stone.png`. */
export function assetPath(kind: AssetKind, id: string | ResourceLocation): string {
  const location = typeof id === 'string' ? parseResourceLocation(id) : id;
  const { folder, extension } = assetKinds[kind];
  // Ids may already carry the extension ("block/stone.png"); it is not doubled.
  const path = location.path.endsWith(extension) ? location.path.slice(0, -extension.length) : location.path;
  return `assets/${location.namespace}/${folder}/${path}${extension}`;
}

/** What the asset source is: nothing configured, being opened, ready to read, or failed to open. */
export type MinecraftAssetsState = 'none' | 'loading' | 'ready' | 'error' | 'unavailable';

export interface MinecraftAssetsInfo {
  /** The configured path: a folder or a .jar. */
  path: string;
  kind: 'folder' | 'jar';
  /** Namespaces found under `assets/`. */
  namespaces: string[];
  /** The game version, when the source says so (client jars do). */
  version?: string | null;
  packFormat?: number | null;
}

export interface MinecraftAssetsStatus {
  state: MinecraftAssetsState;
  /** The `minecraftAssets` preference ("" = none). */
  path: string;
  info: MinecraftAssetsInfo | null;
  error: string | null;
}

/** A Minecraft client found in the standard launcher folder. */
export interface MinecraftInstall {
  version: string;
  /** Path of the client .jar. */
  path: string;
  /** Last modified, Unix seconds. */
  modified: number;
}

/** What the asset commands need from the app (src/mcassets implements it). */
export interface MinecraftAssetsService {
  status(): MinecraftAssetsStatus;
  /** Opens the source the preference names and waits until it is ready or failed. */
  reload(): Promise<MinecraftAssetsStatus>;
  detect(): Promise<MinecraftInstall[]>;
  /** Paths of files under a prefix such as `assets/minecraft/textures/block/`. */
  list(prefix: string): Promise<string[]>;
}
