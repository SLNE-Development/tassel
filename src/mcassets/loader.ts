import { assetPath, formatResourceLocation, parseResourceLocation } from '../core/minecraftAssets';
import { decodePng } from '../imaging/png';

// Reads vanilla Minecraft assets (textures, block/item models, item definitions, blockstates) by
// resource location from an `AssetSource`: the user's client .jar or resource pack folder through the
// Rust side (tauriSource.ts), or anything else that can read files (tests use an in-memory map).
// Every file is read at most once; concurrent requests for the same file share one read.

/** Where the files come from. Paths are pack-relative with forward slashes: `assets/minecraft/textures/block/stone.png`. */
export interface AssetSource {
  /** The file's bytes, or null if the pack has no such file. Other failures reject. */
  read(path: string): Promise<Uint8Array | null>;
  /** Files under a prefix (optional). */
  list?(prefix: string): Promise<string[]>;
}

/** Decoded pixels (RGBA, not premultiplied). */
export interface DecodedImage {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
}

/** Turns PNG bytes into pixels. The default handles every PNG: the built-in codec, else the browser's decoder. */
export type ImageDecoder = (bytes: Uint8Array) => Promise<DecodedImage | null>;

/** `.png.mcmeta` animation section; only what the loader interprets. */
export interface TextureAnimation {
  frametime?: number;
  interpolate?: boolean;
  frames?: (number | { index: number; time?: number })[];
  width?: number;
  height?: number;
}

export interface McTexture extends DecodedImage {
  /** Normalised id, e.g. `minecraft:block/stone`. */
  id: string;
  path: string;
  /** The PNG file as read. */
  bytes: Uint8Array;
  /** Animated textures are a vertical strip of frames; `frameHeight` is the height of one, `frames` how many. */
  frameHeight: number;
  frames: number;
  animation: TextureAnimation | null;
}

/** A face of a model element (Java block model format). */
export interface McFace {
  uv?: [number, number, number, number];
  texture: string;
  cullface?: string;
  rotation?: 0 | 90 | 180 | 270;
  tintindex?: number;
}

export interface McElement {
  from: [number, number, number];
  to: [number, number, number];
  rotation?: { origin: [number, number, number]; axis: 'x' | 'y' | 'z'; angle: number; rescale?: boolean };
  shade?: boolean;
  light_emission?: number;
  faces: Partial<Record<'north' | 'south' | 'east' | 'west' | 'up' | 'down', McFace>>;
  [key: string]: unknown;
}

export interface McDisplay {
  rotation?: [number, number, number];
  translation?: [number, number, number];
  scale?: [number, number, number];
}

/** A model file as stored: `assets/<ns>/models/<path>.json`. */
export interface McModelJson {
  parent?: string;
  textures?: Record<string, string>;
  elements?: McElement[];
  display?: Record<string, McDisplay>;
  ambientocclusion?: boolean;
  gui_light?: 'front' | 'side';
  texture_size?: [number, number];
  [key: string]: unknown;
}

/** A model with its parents applied (see `MinecraftAssets.resolveModel`). */
export interface ResolvedModel {
  id: string;
  /** The model and its ancestors, child first, as normalised ids. Built-in parents (`builtin/generated`) are included. */
  chain: string[];
  /**
   * Texture variables of the whole chain, children overriding parents, with `#var` references followed:
   * a value is a texture id (`minecraft:block/stone`) or, if the reference leads nowhere, the `#var` that is missing.
   */
  textures: Record<string, string>;
  /** The elements of the nearest model in the chain that has any; null if none has (e.g. item/generated models). */
  elements: McElement[] | null;
  /** Display transforms per context, children overriding parents key by key. */
  display: Record<string, McDisplay>;
  ambientocclusion: boolean;
  guiLight: 'front' | 'side';
  textureSize: [number, number] | null;
  /** `builtin/generated` (items drawn from their layer textures) or `builtin/entity` ancestry; null for plain models. */
  builtin: 'generated' | 'entity' | null;
}

const MAX_PARENT_DEPTH = 32;

/** Browser fallback for PNGs the built-in codec does not read (palette images, which Mojang uses a lot). */
async function browserDecode(bytes: Uint8Array): Promise<DecodedImage | null> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return null;
  const bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/png' }));
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: bitmap.width, height: bitmap.height, pixels: data.data };
  } finally {
    bitmap.close();
  }
}

export const defaultDecoder: ImageDecoder = async (bytes) => {
  const own = await decodePng(new Uint8Array(bytes) as Uint8Array<ArrayBuffer>).catch(() => null);
  if (own) return { width: own.width, height: own.height, pixels: new Uint8ClampedArray(own.pixels.buffer, own.pixels.byteOffset, own.pixels.byteLength) };
  return browserDecode(bytes);
};

const normalise = (id: string) => formatResourceLocation(parseResourceLocation(id));
const isBuiltin = (id: string) => /^(minecraft:)?builtin\//.test(id.trim().toLowerCase());

/**
 * Typed, cached access to the files of a Minecraft resource pack or client jar.
 *
 * Ids are resource locations (`namespace:path`, namespace defaulting to `minecraft`); a missing file
 * resolves to null, a malformed id or a broken file rejects.
 */
export class MinecraftAssets {
  private readonly files = new Map<string, Promise<Uint8Array | null>>();
  private readonly jsons = new Map<string, Promise<unknown>>();
  private readonly textures = new Map<string, Promise<McTexture | null>>();
  private readonly decode: ImageDecoder;

  constructor(
    readonly source: AssetSource,
    options: { decode?: ImageDecoder } = {},
  ) {
    this.decode = options.decode ?? defaultDecoder;
  }

  /** A pack file by path (`assets/minecraft/...`). A failed read is not cached, so it can be retried. */
  file(path: string): Promise<Uint8Array | null> {
    let pending = this.files.get(path);
    if (!pending) {
      pending = this.source.read(path);
      this.files.set(path, pending);
      pending.catch(() => this.files.delete(path));
    }
    return pending;
  }

  /** A JSON file by path, parsed; null if missing. */
  json<T = unknown>(path: string): Promise<T | null> {
    let pending = this.jsons.get(path);
    if (!pending) {
      pending = this.file(path).then((bytes) => {
        if (!bytes) return null;
        try {
          // Some vanilla files start with a byte order mark.
          return JSON.parse(new TextDecoder().decode(bytes).replace(/^﻿/, ''));
        } catch (error) {
          throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
        }
      });
      this.jsons.set(path, pending);
      pending.catch(() => this.jsons.delete(path));
    }
    return pending as Promise<T | null>;
  }

  /** The PNG bytes of a texture, e.g. `block/stone` or `minecraft:entity/player/wide/steve`. */
  textureBytes(id: string): Promise<Uint8Array | null> {
    return this.file(assetPath('texture', id));
  }

  /** A texture decoded to pixels, with its animation strip described. */
  texture(id: string): Promise<McTexture | null> {
    const key = normalise(id);
    let pending = this.textures.get(key);
    if (!pending) {
      pending = this.loadTexture(key);
      this.textures.set(key, pending);
      pending.catch(() => this.textures.delete(key));
    }
    return pending;
  }

  private async loadTexture(id: string): Promise<McTexture | null> {
    const path = assetPath('texture', id);
    const bytes = await this.file(path);
    if (!bytes) return null;
    const image = await this.decode(bytes);
    if (!image) throw new Error(`Could not decode ${path}`);
    const meta = await this.json<{ animation?: TextureAnimation }>(assetPath('textureMeta', id)).catch(() => null);
    const animation = meta?.animation ?? null;
    let frameHeight = image.height;
    if (animation) {
      // Frames are square unless the meta gives a size.
      const frameWidth = animation.width ?? Math.min(image.width, image.height);
      frameHeight = animation.height ?? frameWidth;
      if (frameHeight <= 0 || image.height % frameHeight !== 0) frameHeight = image.height;
    }
    return { id, path, bytes, ...image, frameHeight, frames: Math.max(1, Math.floor(image.height / frameHeight)), animation };
  }

  /** A model file as stored (no parents applied), e.g. `block/stone` or `minecraft:item/diamond`. */
  model(id: string): Promise<McModelJson | null> {
    return this.json<McModelJson>(assetPath('model', id));
  }

  /** An item model definition (`assets/<ns>/items/<id>.json`, Minecraft 1.21.4+), e.g. `diamond_sword`. */
  itemDefinition(id: string): Promise<Record<string, unknown> | null> {
    return this.json(assetPath('itemDefinition', id));
  }

  /** A blockstate file, e.g. `oak_log`. */
  blockstate(id: string): Promise<Record<string, unknown> | null> {
    return this.json(assetPath('blockstate', id));
  }

  /** Lists pack files under a prefix; empty if the source cannot list. */
  async list(prefix: string): Promise<string[]> {
    return this.source.list ? this.source.list(prefix) : [];
  }

  /**
   * A model with its parent chain applied, the way the game does: texture variables merged (children
   * win) and `#var` references followed, elements from the nearest model that has them, display
   * transforms merged per context. Null if the model itself is missing; a missing ancestor, a parent
   * cycle or a chain deeper than 32 rejects with the chain so far.
   */
  async resolveModel(id: string): Promise<ResolvedModel | null> {
    const chain: string[] = [];
    const models: McModelJson[] = [];
    let builtin: ResolvedModel['builtin'] = null;
    let current: string | undefined = id;
    while (current !== undefined) {
      if (isBuiltin(current)) {
        const name = normalise(current);
        chain.push(name);
        builtin = name.endsWith('/generated') ? 'generated' : name.endsWith('/entity') ? 'entity' : null;
        break;
      }
      const key = normalise(current);
      if (chain.includes(key)) throw new Error(`Model parent cycle: ${[...chain, key].join(' → ')}`);
      if (chain.length >= MAX_PARENT_DEPTH) throw new Error(`Model parent chain deeper than ${MAX_PARENT_DEPTH}: ${chain.join(' → ')}`);
      const model = await this.model(key);
      if (!model) {
        if (chain.length === 0) return null;
        throw new Error(`Missing parent model ${key} of ${chain.join(' → ')}`);
      }
      chain.push(key);
      models.push(model);
      current = typeof model.parent === 'string' ? model.parent : undefined;
    }

    const rawTextures: Record<string, string> = {};
    const display: Record<string, McDisplay> = {};
    let elements: McElement[] | null = null;
    let ambientocclusion = true;
    let guiLight: ResolvedModel['guiLight'] = 'side';
    let textureSize: [number, number] | null = null;
    // Root first, so that children override.
    for (const model of [...models].reverse()) {
      Object.assign(rawTextures, model.textures ?? {});
      for (const [context, transform] of Object.entries(model.display ?? {})) display[context] = { ...transform };
      if (Array.isArray(model.elements)) elements = model.elements;
      if (typeof model.ambientocclusion === 'boolean') ambientocclusion = model.ambientocclusion;
      if (model.gui_light === 'front' || model.gui_light === 'side') guiLight = model.gui_light;
      if (Array.isArray(model.texture_size)) textureSize = model.texture_size;
    }
    const textures: Record<string, string> = {};
    for (const name of Object.keys(rawTextures)) textures[name] = resolveTextureVariable(rawTextures, `#${name}`);
    return { id: chain[0], chain, textures, elements, display, ambientocclusion, guiLight, textureSize, builtin };
  }

  /** Forgets every cached file, e.g. after the source changed on disk. */
  clear(): void {
    this.files.clear();
    this.jsons.clear();
    this.textures.clear();
  }
}

/**
 * Follows `#var` references through a model's texture variables until a texture id. A reference that
 * leads nowhere (or in a circle) comes back as the last `#var`. Ids are normalised (`minecraft:` added).
 */
export function resolveTextureVariable(textures: Readonly<Record<string, string>>, value: string): string {
  let current = value;
  const seen = new Set<string>();
  while (current.startsWith('#')) {
    const name = current.slice(1);
    if (seen.has(name) || !Object.hasOwn(textures, name)) return current;
    seen.add(name);
    current = textures[name];
  }
  try {
    return normalise(current);
  } catch {
    return current;
  }
}
