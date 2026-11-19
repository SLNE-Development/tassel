// Parent models of a Minecraft Java model.
//
// A model may name a parent ("block/cube_all", "mymod:item/base", "item/generated"); the game merges the
// chain: texture variables (children win), elements of the nearest model that has any, display per context.
// Tessel keeps the parent as a reference (exported unchanged) and can additionally take a snapshot of what
// the chain provides (`JavaModelSettings.inherited`), which the viewport shows read-only and which
// `mergeInherited` turns into the model's own elements and textures.
//
// Parents are read through a `JavaModelSource`: the app's source tries the resource pack the model was
// opened from, the active project, then the vanilla assets (src/bridge/javaModels.ts).
import { formatResourceLocation, parseResourceLocation } from '../minecraftAssets';
import { newId } from '../state';
import type { Cuboid, CuboidFace, CuboidFaceName, DocState, JavaImage, JavaInherited, SceneObject, Texture, Vec3 } from '../types';
import { cuboidFaces } from '../types';
import { blankFace, syncCuboidObject } from './cuboid';
import { textureLocation } from './javaExport';
import { MISSING_TEXTURE_PNG, importJavaModel, parseLocation } from './javaImport';
import { modelToWorld, subVec, tidy } from './space';

/** Where parent models and their textures come from. Missing files resolve to null. */
export interface JavaModelSource {
  /** A model file as parsed JSON, by resource location (`minecraft:block/cube_all`). */
  model(id: string): Promise<unknown>;
  /** A texture PNG by resource location (`minecraft:block/stone`). */
  texture(id: string): Promise<JavaImage | null>;
}

/** Builds a source per model file: `anchor` is the path the model was opened from, if any. */
export interface JavaModelSourceService {
  source(anchor: string | null): JavaModelSource;
}

const MAX_DEPTH = 32;
type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `namespace:path` with the namespace, or null for something that is not a resource location. */
export function normaliseId(id: string): string | null {
  try {
    return formatResourceLocation(parseResourceLocation(id));
  } catch {
    return null;
  }
}

const isBuiltin = (id: string) => /^(minecraft:)?builtin\//.test(id.trim().toLowerCase());

/** Follows `#var` references; returns the final value, or the last `#var` if the chain leads nowhere. */
export function followVariable(textures: Readonly<Record<string, string>>, value: string): string {
  let current = value;
  const seen = new Set<string>();
  while (current.startsWith('#')) {
    const name = current.slice(1);
    if (seen.has(name) || !Object.hasOwn(textures, name)) return current;
    seen.add(name);
    current = textures[name];
  }
  return current;
}

/** Every variable of `textures` resolved to a normalised texture id; unresolved and invalid ones are left out. */
export function resolveVariables(textures: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(textures)) {
    const value = followVariable(textures, `#${key}`);
    const id = value.startsWith('#') ? null : normaliseId(value);
    if (id) out[key] = id;
  }
  return out;
}

export interface ParentResolution {
  /** Null if the model has no parent or not even the first parent was found. */
  inherited: JavaInherited | null;
  warnings: string[];
}

/**
 * Reads the parent chain of a model and the images of the textures it provides. `own` are the model's own
 * texture variables as written (they decide which inherited variables are used); `have` are texture ids whose
 * image the document already has (not read again).
 */
export async function resolveParentChain(
  parent: string,
  source: JavaModelSource,
  own: Readonly<Record<string, string>> = {},
  have: ReadonlySet<string> = new Set(),
): Promise<ParentResolution> {
  const warnings: string[] = [];
  const missing: string[] = [];
  const chain: string[] = [];
  const models: Json[] = [];
  let builtin: JavaInherited['builtin'] = null;
  let current: string | undefined = parent.trim() || undefined;
  while (current !== undefined) {
    if (isBuiltin(current)) {
      const name = normaliseId(current) ?? current;
      chain.push(name);
      builtin = name.endsWith('/generated') ? 'generated' : name.endsWith('/entity') ? 'entity' : null;
      break;
    }
    const id = normaliseId(current);
    if (!id) {
      warnings.push(`"${current}" is not a valid parent model id`);
      break;
    }
    if (chain.includes(id)) {
      warnings.push(`The parent models form a cycle: ${[...chain, id].join(' → ')}`);
      break;
    }
    if (chain.length >= MAX_DEPTH) {
      warnings.push(`The parent chain is deeper than ${MAX_DEPTH} models; the rest was not read`);
      break;
    }
    let model: unknown;
    try {
      model = await source.model(id);
    } catch (error) {
      warnings.push(`Parent model "${id}" could not be read: ${(error as Error).message}`);
      missing.push(id);
      break;
    }
    if (!isObject(model)) {
      warnings.push(`Parent model "${id}" was not found in the resource pack, the project or the Minecraft assets`);
      missing.push(id);
      break;
    }
    chain.push(id);
    models.push(model);
    current = typeof model.parent === 'string' && model.parent.trim() ? model.parent : undefined;
  }
  if (chain.length === 0) return { inherited: null, warnings };

  const textures: Record<string, string> = {};
  const display: Record<string, unknown> = {};
  let elements: unknown[] | null = null;
  let textureSize: [number, number] | null = null;
  for (const model of [...models].reverse()) {
    if (isObject(model.textures)) for (const [k, v] of Object.entries(model.textures)) if (typeof v === 'string') textures[k] = v;
    if (isObject(model.display)) for (const [k, v] of Object.entries(model.display)) display[k] = v;
    if (Array.isArray(model.elements)) elements = model.elements;
    const size = model.texture_size;
    if (Array.isArray(size) && size.length === 2 && size.every((n) => Number.isInteger(n) && n >= 1 && n <= 4096)) textureSize = [size[0], size[1]];
  }

  // Images of every texture the merged chain (with the model's own variables on top) ends up using.
  const images: Record<string, JavaImage> = {};
  const textureMisses: string[] = [];
  for (const id of new Set(Object.values(resolveVariables({ ...textures, ...own })))) {
    if (have.has(id)) continue;
    const image = await source.texture(id).catch(() => null);
    if (image) images[id] = image;
    else textureMisses.push(id);
  }
  if (textureMisses.length > 0) {
    warnings.push(`Textures not found (a placeholder is shown): ${textureMisses.join(', ')}`);
    missing.push(...textureMisses);
  }
  return { inherited: { chain, builtin, textures, elements, textureSize, display, images, missing }, warnings };
}

/** The model's own texture variables as the file would write them: key -> location, plus the kept references. */
export function ownVariables(state: DocState): Record<string, string> {
  const out: Record<string, string> = {};
  for (const texture of Object.values(state.textures)) if (texture.java) out[texture.java.key] = textureLocation(texture);
  const particle = state.java?.particle;
  if (particle && Object.hasOwn(state.textures, particle)) out.particle = textureLocation(state.textures[particle]);
  for (const [key, value] of Object.entries(state.java?.textureRefs ?? {})) if (!Object.hasOwn(out, key)) out[key] = value;
  return out;
}

/** Texture variable -> the texture to draw it with: the document's own texture, or an inherited image. */
export function effectiveTextures(state: DocState): Map<string, Texture> {
  const inherited = state.java?.inherited;
  const byId = new Map<string, Texture>();
  for (const texture of Object.values(state.textures)) {
    const id = texture.java ? normaliseId(textureLocation(texture)) : null;
    if (id && !byId.has(id)) byId.set(id, texture);
  }
  const out = new Map<string, Texture>();
  for (const [key, id] of Object.entries(resolveVariables({ ...(inherited?.textures ?? {}), ...ownVariables(state) }))) {
    let texture = byId.get(id);
    if (!texture) {
      const image = inherited?.images[id];
      const location = parseLocation(id);
      texture = {
        id: `inherited:${id}`,
        name: location.name,
        mimeType: 'image/png',
        data: image?.data ?? MISSING_TEXTURE_PNG,
        width: image?.width ?? 16,
        height: image?.height ?? 16,
        java: { namespace: location.namespace, folder: location.folder, key },
      };
      byId.set(id, texture);
    }
    out.set(key, texture);
  }
  return out;
}

const elementsCache = new WeakMap<JavaInherited, { textures: DocState['textures']; refs: unknown; state: DocState }>();

/**
 * The parent's elements as a document of their own (read-only preview), drawn with the model's textures.
 * Null when nothing is inherited or the model has elements of its own (which replace the parent's in the game).
 */
export function inheritedElementsState(state: DocState): DocState | null {
  const inherited = state.java?.inherited;
  if (!inherited?.elements || inherited.elements.length === 0 || state.order.length > 0) return null;
  const cached = elementsCache.get(inherited);
  if (cached && cached.textures === state.textures && cached.refs === state.java?.textureRefs) return cached.state;
  const textures = effectiveTextures(state);
  const images: Record<string, JavaImage> = {};
  const variables: Record<string, string> = {};
  for (const [key, texture] of textures) {
    const id = normaliseId(textureLocation(texture)) ?? textureLocation(texture);
    variables[key] = id;
    images[id] = { data: texture.data, width: texture.width, height: texture.height };
  }
  const json = { textures: variables, elements: inherited.elements, ...(inherited.textureSize ? { texture_size: inherited.textureSize } : {}) };
  const preview = importJavaModel(JSON.stringify(json), { version: state.java!.version, images }).state;
  elementsCache.set(inherited, { textures: state.textures, refs: state.java?.textureRefs, state: preview });
  return preview;
}

/** The layer textures of a generated item (layer0..layer4 that resolve to something), bottom first. */
export function generatedLayers(state: DocState): { key: string; texture: Texture }[] {
  if (state.java?.inherited?.builtin !== 'generated' || state.order.length > 0) return [];
  const textures = effectiveTextures(state);
  const out: { key: string; texture: Texture }[] = [];
  for (let i = 0; i <= 4; i++) {
    const texture = textures.get(`layer${i}`);
    if (texture) out.push({ key: `layer${i}`, texture });
  }
  return out;
}

export interface LayerPixels {
  texture: Texture;
  width: number;
  height: number;
  /** RGBA, row by row from the top. */
  pixels: ArrayLike<number>;
}

/**
 * The flat item the game builds from layer textures ("item/generated"): the image on the north and south
 * faces of a 1 px thick slab (z 7.5..8.5), and for every opaque pixel the sides that border transparency,
 * textured with that pixel. Animated textures (taller than wide) use their first frame. Layers sit 0.001 px
 * apart so they do not flicker. Returns the elements as a document (read-only preview).
 */
export function generatedItemState(layers: readonly LayerPixels[]): DocState {
  const objects: Record<string, SceneObject> = {};
  const order: string[] = [];
  const textures: Record<string, Texture> = {};
  const origin: Vec3 = [8, 8, 8];
  const add = (name: string, from: Vec3, to: Vec3, faces: Partial<Record<CuboidFaceName, CuboidFace>>) => {
    const all = Object.fromEntries(cuboidFaces.map((f) => [f, faces[f] ?? { ...blankFace([0, 0, 0, 0]), enabled: false }])) as Record<CuboidFaceName, CuboidFace>;
    const cuboid: Cuboid = {
      from: subVec(from, origin).map(tidy) as Vec3,
      to: subVec(to, origin).map(tidy) as Vec3,
      inflate: 0,
      rescale: false,
      shade: true,
      lightEmission: 0,
      shadeDirectionOverride: null,
      locked: true,
      export: false,
      color: 0,
      faces: all,
    };
    const id = newId();
    const obj: SceneObject = {
      id,
      name,
      visible: true,
      transform: { position: modelToWorld(origin), rotation: [0, 0, 0], scale: [1, 1, 1] },
      mesh: { positions: [], faces: [] },
      modifiers: [],
      smooth: false,
      groupId: null,
      materialId: null,
      cuboid,
    };
    objects[id] = syncCuboidObject(obj, [16, 16]);
    order.push(id);
  };
  layers.forEach((layer, index) => {
    const { width, height, pixels, texture } = layer;
    if (width <= 0 || height <= 0) return;
    textures[texture.id] = texture;
    const frame = height > width && height % width === 0 ? width : height;
    const pw = 16 / width;
    const ph = 16 / frame;
    const vScale = 16 / height; // texture px -> UV units (the preview's texture size is 16 x 16)
    const uScale = 16 / width;
    const lift = index * 0.001;
    const z1 = 7.5 - lift;
    const z2 = 8.5 + lift;
    const face = (uv: [number, number, number, number]): CuboidFace => ({ ...blankFace(uv, texture.id) });
    add(`layer${index}`, [0, 0, z1], [16, 16, z2], { north: face([16, 0, 0, frame * vScale]), south: face([0, 0, 16, frame * vScale]) });
    const opaque = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < frame && pixels[(y * width + x) * 4 + 3] > 0;
    for (let y = 0; y < frame; y++) {
      for (let x = 0; x < width; x++) {
        if (!opaque(x, y)) continue;
        const uv: [number, number, number, number] = [x * uScale, y * vScale, (x + 1) * uScale, (y + 1) * vScale];
        const sides: Partial<Record<CuboidFaceName, CuboidFace>> = {};
        if (!opaque(x - 1, y)) sides.west = face(uv);
        if (!opaque(x + 1, y)) sides.east = face(uv);
        if (!opaque(x, y - 1)) sides.up = face(uv);
        if (!opaque(x, y + 1)) sides.down = face(uv);
        if (Object.keys(sides).length === 0) continue;
        const x1 = x * pw;
        const y1 = 16 - (y + 1) * ph;
        add(`layer${index}_${x}_${y}`, [x1, y1, z1], [x1 + pw, y1 + ph, z2], sides);
      }
    }
  });
  return { ...emptyPreview, objects, order, textures, format: 'minecraft_java', java: { ...previewJava } };
}

const emptyPreview: DocState = { objects: {}, order: [], groups: {}, groupOrder: [], materials: {}, textures: {}, selection: [], activeId: null, edit: null };
const previewJava = {
  version: '26.3',
  fileName: 'preview',
  parent: '',
  ambientOcclusion: true,
  guiLight: null,
  textureSize: [16, 16] as const,
  credit: '',
  particle: null,
};

/**
 * Makes what the parent chain provides the model's own: its elements (only if the model has none; in the
 * game a model's own elements replace the parent's), the textures they use and the display transforms the
 * model does not set itself. The parent reference stays. Throws for generated items (nothing to merge).
 */
export function mergeInherited(state: DocState): { state: DocState; elements: number; textures: number } {
  const java = state.java;
  const inherited = java?.inherited;
  if (!java || !inherited) throw new Error('The parent model is not loaded; show it first (minecraft_show_parent)');
  if (inherited.builtin === 'generated' && !inherited.elements) {
    throw new Error('A generated item has no parent elements to merge: it is drawn from its layer textures');
  }
  const preview = inheritedElementsState(state);
  const textures: Record<string, Texture> = { ...state.textures };
  const byLocation = new Map<string, string>();
  for (const t of Object.values(state.textures)) if (t.java) byLocation.set(normaliseId(textureLocation(t)) ?? textureLocation(t), t.id);
  const keys = new Set(Object.values(state.textures).flatMap((t) => (t.java ? [t.java.key] : [])));
  const remap = new Map<string, string>();
  let addedTextures = 0;
  for (const t of Object.values(preview?.textures ?? {})) {
    const location = normaliseId(textureLocation(t)) ?? textureLocation(t);
    const existing = byLocation.get(location);
    if (existing) {
      remap.set(t.id, existing);
      continue;
    }
    let key = t.java?.key ?? '0';
    for (let i = 2; keys.has(key); i++) key = `${t.java?.key ?? 'texture'}_${i}`;
    keys.add(key);
    const id = newId();
    textures[id] = { ...t, id, java: { ...(t.java ?? { namespace: 'minecraft', folder: 'block' }), key } };
    byLocation.set(location, id);
    remap.set(t.id, id);
    addedTextures++;
  }
  const objects: Record<string, SceneObject> = { ...state.objects };
  const order = [...state.order];
  for (const id of preview?.order ?? []) {
    const obj = preview!.objects[id];
    const faces = Object.fromEntries(
      cuboidFaces.map((f) => {
        const face = obj.cuboid!.faces[f];
        return [f, { ...face, texture: face.texture === null ? null : (remap.get(face.texture) ?? null) }];
      }),
    ) as Record<CuboidFaceName, CuboidFace>;
    objects[id] = { ...obj, cuboid: { ...obj.cuboid!, faces } };
    order.push(id);
  }
  const display = { ...inherited.display, ...(java.display ?? {}) };
  const textureSize = inherited.textureSize && preview && java.textureSize[0] === 16 && java.textureSize[1] === 16 ? inherited.textureSize : java.textureSize;
  const { inherited: _dropped, ...rest } = java;
  return {
    state: {
      ...state,
      objects,
      order,
      textures,
      java: { ...rest, textureSize: [textureSize[0], textureSize[1]], ...(Object.keys(display).length > 0 ? { display } : {}) },
    },
    elements: preview?.order.length ?? 0,
    textures: addedTextures,
  };
}

/** A short description of the inherited snapshot for commands and panels. */
export function inheritedSummary(state: DocState) {
  const inherited = state.java?.inherited;
  if (!inherited) return null;
  const overridden = state.order.length > 0 && (inherited.elements?.length ?? 0) > 0;
  return {
    chain: inherited.chain,
    builtin: inherited.builtin,
    elements: inherited.elements?.length ?? 0,
    /** The model's own elements replace the parent's in the game, so the parent's are not shown. */
    elementsOverridden: overridden,
    textures: Object.fromEntries([...effectiveTextures(state)].map(([key, t]) => [key, textureLocation(t)])),
    displayContexts: Object.keys(inherited.display),
    missing: inherited.missing,
  };
}
