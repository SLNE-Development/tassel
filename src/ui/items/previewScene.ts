// Builds the viewport scene of an item definition: the models it picks for the test inputs, read through the
// pack/vanilla loader, turned into Minecraft cuboid elements by the regular Java model importer and laid
// into one Minecraft document state. Items drawn from layer textures (item/generated) become one flat
// element per layer; tint sources colour the faces with their tintindex.
import { tintPreviewColor } from '../../core/minecraft/items/colors';
import type { ItemTestInputs, RenderedModel } from '../../core/minecraft/items/evaluate';
import type { Json } from '../../core/minecraft/items/types';
import { importJavaModel } from '../../core/minecraft/javaImport';
import { emptyDocState } from '../../core/state';
import type { DocState, Group, SceneObject, Texture, Vec3 } from '../../core/types';
import { encodePng } from '../../imaging/png';
import { toBase64 } from '../../io/bytes';
import type { DecodedImage, McElement, McFace, MinecraftAssets, McTexture } from '../../mcassets';

export interface PreviewNote {
  /** Node path of the leaf it is about. */
  path: string;
  model: string;
  problem: 'missing' | 'error' | 'special' | 'nothing' | 'noElements';
  detail?: string;
}

export interface PreviewOutcome {
  state: DocState | null;
  notes: PreviewNote[];
}

type Image = { data: string; width: number; height: number };

function firstFrame(texture: McTexture): DecodedImage {
  if (texture.frameHeight >= texture.height) return texture;
  return { width: texture.width, height: texture.frameHeight, pixels: texture.pixels.slice(0, texture.width * texture.frameHeight * 4) };
}

function tint(image: DecodedImage, hex: string): DecodedImage {
  const rgb = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255];
  const pixels = new Uint8ClampedArray(image.pixels);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = (pixels[i] * r) / 255;
    pixels[i + 1] = (pixels[i + 1] * g) / 255;
    pixels[i + 2] = (pixels[i + 2] * b) / 255;
  }
  return { ...image, pixels };
}

async function pngImage(image: DecodedImage): Promise<Image> {
  return { data: toBase64(await encodePng(new Uint8ClampedArray(image.pixels), image.width, image.height)), width: image.width, height: image.height };
}

/** One flat element per layer texture, the way items without elements look (simplified: no pixel extrusion). */
function layerElements(textures: Readonly<Record<string, string>>): McElement[] {
  const elements: McElement[] = [];
  for (let i = 0; Object.hasOwn(textures, `layer${i}`); i++) {
    const z = 8 + i * 0.02;
    const face = (uv: [number, number, number, number]): McFace => ({ uv, texture: `#layer${i}`, tintindex: i });
    elements.push({ from: [0, 0, z], to: [16, 16, z], faces: { south: face([0, 0, 16, 16]), north: face([16, 0, 0, 16]) } });
  }
  return elements;
}

/** Sum of the translations of decomposed transformations (rotation and scale are not shown). */
export function previewOffset(transformations: readonly Json[]): Vec3 {
  const offset: [number, number, number] = [0, 0, 0];
  for (const t of transformations) {
    if (t && typeof t === 'object' && !Array.isArray(t)) {
      const translation = (t as Record<string, Json>).translation;
      if (Array.isArray(translation) && translation.length === 3 && translation.every((n) => typeof n === 'number')) {
        for (let i = 0; i < 3; i++) offset[i] += translation[i] as number;
      }
    }
  }
  return offset;
}

/** One model as a Minecraft document state, or a note why it cannot be shown. */
async function modelState(assets: MinecraftAssets, part: RenderedModel, inputs: ItemTestInputs): Promise<{ state: DocState } | { note: PreviewNote }> {
  const base = { path: part.path, model: part.model };
  let resolved;
  try {
    resolved = await assets.resolveModel(part.model);
  } catch (error) {
    return { note: { ...base, problem: 'error', detail: error instanceof Error ? error.message : String(error) } };
  }
  if (!resolved) return { note: { ...base, problem: 'missing' } };
  const textures: Record<string, string> = { ...resolved.textures };
  const elements = resolved.elements ?? (resolved.builtin === 'generated' || Object.hasOwn(textures, 'layer0') ? layerElements(textures) : null);
  if (!elements || elements.length === 0) return { note: { ...base, problem: 'noElements' } };

  // Faces with a tintindex that a tint source colours use a tinted copy of their texture.
  const colors = part.tints.map((t) => tintPreviewColor(t, inputs));
  const tintedVars = new Map<string, { source: string; color: string }>();
  const faces = elements.map((element) => ({
    ...element,
    faces: Object.fromEntries(
      Object.entries(element.faces).map(([dir, face]) => {
        if (!face || face.tintindex === undefined || !colors[face.tintindex] || !face.texture.startsWith('#')) return [dir, face];
        const variable = face.texture.slice(1);
        const name = `${variable}_tint${face.tintindex}`;
        tintedVars.set(name, { source: variable, color: colors[face.tintindex]! });
        return [dir, { ...face, texture: `#${name}` }];
      }),
    ),
  }));

  const images: Record<string, Image> = {};
  const load = async (id: string): Promise<McTexture | null> => (id.startsWith('#') ? null : assets.texture(id).catch(() => null));
  for (const id of new Set(Object.values(textures))) {
    const texture = await load(id);
    if (!texture) continue;
    images[id] = texture.frames > 1 ? await pngImage(firstFrame(texture)) : { data: toBase64(texture.bytes), width: texture.width, height: texture.height };
  }
  for (const [name, { source, color }] of tintedVars) {
    const id = textures[source];
    const texture = id ? await load(id) : null;
    const location = `${id ?? 'missing'}_tint_${color.slice(1)}`;
    textures[name] = location;
    if (texture) images[location] = await pngImage(tint(firstFrame(texture), color));
  }

  const json = { textures, elements: faces, ...(resolved.textureSize ? { texture_size: resolved.textureSize } : {}) };
  try {
    return { state: importJavaModel(JSON.stringify(json), { images, fileName: 'preview' }).state };
  } catch (error) {
    return { note: { ...base, problem: 'error', detail: error instanceof Error ? error.message : String(error) } };
  }
}

const modelCache = new WeakMap<MinecraftAssets, Map<string, Promise<{ state: DocState } | { note: PreviewNote }>>>();

function cachedModelState(assets: MinecraftAssets, part: RenderedModel, inputs: ItemTestInputs) {
  let byKey = modelCache.get(assets);
  if (!byKey) modelCache.set(assets, (byKey = new Map()));
  const key = `${part.model}|${part.tints.map((t) => tintPreviewColor(t, inputs) ?? '').join(',')}`;
  let pending = byKey.get(key);
  if (!pending) {
    pending = modelState(assets, part, inputs);
    byKey.set(key, pending);
  }
  return pending.then((result) => ('note' in result ? { note: { ...result.note, path: part.path } } : result));
}

/** The scene for everything the definition renders; models that cannot be shown are listed in `notes`. */
export async function buildPreviewScene(rendered: readonly RenderedModel[], assets: MinecraftAssets | null, inputs: ItemTestInputs): Promise<PreviewOutcome> {
  const notes: PreviewNote[] = [];
  const objects: Record<string, SceneObject> = {};
  const order: string[] = [];
  const groups: Record<string, Group> = {};
  const groupOrder: string[] = [];
  const textures: Record<string, Texture> = {};
  let java: DocState['java'];
  for (const part of rendered) {
    if (part.kind === 'special') {
      notes.push({ path: part.path, model: part.special ?? '', problem: 'special' });
      continue;
    }
    if (part.kind !== 'model') {
      notes.push({ path: part.path, model: part.kind, problem: 'nothing' });
      continue;
    }
    if (!part.model || !assets) {
      notes.push({ path: part.path, model: part.model, problem: 'missing' });
      continue;
    }
    const result = await cachedModelState(assets, part, inputs);
    if ('note' in result) {
      notes.push(result.note);
      continue;
    }
    const { state } = result;
    const offset = previewOffset(part.transformations);
    java ??= state.java;
    for (const sourceId of state.order) {
      const obj = state.objects[sourceId];
      // The same model can be rendered twice (composites): every copy needs ids of its own.
      const id = Object.hasOwn(objects, sourceId) ? `${sourceId}~${order.length}` : sourceId;
      const p = obj.transform.position;
      objects[id] = { ...obj, id, transform: { ...obj.transform, position: [p[0] + offset[0], p[1] + offset[1], p[2] + offset[2]] } };
      order.push(id);
    }
    Object.assign(groups, state.groups);
    groupOrder.push(...state.groupOrder);
    Object.assign(textures, state.textures);
  }
  if (order.length === 0) return { state: null, notes };
  return { state: { ...emptyDocState, format: 'minecraft_java', java, objects, order, groups, groupOrder, textures }, notes };
}

