// Minecraft Java block/item model JSON -> a new Minecraft document state.
//
// Like the exporter, every key is read by a rule with a version range, so a later version can change how a
// key is read without touching older versions. Unknown root keys are kept (JavaModelSettings.extra) and
// written back on export. "parent" is kept as text; resolving the parent chain is parents.ts' job, which can
// hand the variables and textures the parents provide in through the options.
import { emptyDocState, newId, uniqueName } from '../state';
import { cuboidFaces } from '../types';
import type { Cuboid, CuboidFace, CuboidFaceName, DocState, Group, JavaModelSettings, SceneObject, Texture, Vec3 } from '../types';
import { blankFace, createCuboid, syncCuboidObject } from './cuboid';
import { defaultJavaSettings } from './schema';
import { modelToWorld, subVec, tidy } from './space';
import { DEFAULT_VERSION, inRange, isJavaVersion, type Ranged } from './versions';

/** A 16 x 16 magenta and black checker PNG, for textures whose image is not available. */
export const MISSING_TEXTURE_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAI0lEQVR42mP4wfDjPz7MwMCAH48aMCwMIKSACAtGDRj6BgAA9VT3EP8L2v4AAAAASUVORK5CYII=';

/** Root keys the importer understands; everything else goes into `extra`. */
const KNOWN_ROOT_KEYS = new Set(['credit', 'parent', 'ambientocclusion', 'texture_size', 'textures', 'elements', 'gui_light', 'display', 'groups']);

export interface JavaImportOptions {
  /** Target version of the new document. Default: the newest. */
  version?: string;
  /** Model file name without .json. */
  fileName?: string;
  /** Texture images by resource location as written in the model ("block/stone", "mymod:item/x"), PNG base64. */
  images?: Readonly<Record<string, { data: string; width: number; height: number }>>;
  /** Variables the parent chain defines: references to them are kept quietly (`textureRefs`). */
  inheritedVariables?: ReadonlySet<string>;
  /**
   * Texture variable -> resolved location the parent chain provides. Faces that use a variable the model
   * does not define itself get that texture (its image looked up in `images` by the same location).
   */
  inheritedTextures?: Readonly<Record<string, string>>;
}

export interface JavaImportResult {
  state: DocState;
  /** Things that could not be imported exactly, in English. */
  warnings: string[];
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(isNumber);
const isDirection = (v: unknown): v is CuboidFaceName => typeof v === 'string' && (cuboidFaces as readonly string[]).includes(v);

interface ReadContext {
  readonly version: string;
  readonly warnings: string[];
  readonly textureSize: readonly [number, number];
  /** Texture variable -> texture id. */
  readonly textureIds: ReadonlyMap<string, string>;
  /** Variables the parent chain defines (no warning when a face uses one of them). */
  readonly inherited?: ReadonlySet<string>;
}

interface ReadRule<T> extends Ranged {
  read(raw: Json, ctx: ReadContext, into: T): T;
}

/** Splits `namespace:folder/name` into its parts (namespace minecraft when absent). */
export function parseLocation(location: string): { namespace: string; folder: string; name: string } {
  const colon = location.indexOf(':');
  const namespace = colon >= 0 ? location.slice(0, colon) : 'minecraft';
  const path = colon >= 0 ? location.slice(colon + 1) : location;
  const slash = path.lastIndexOf('/');
  return { namespace: namespace || 'minecraft', folder: slash >= 0 ? path.slice(0, slash) : '', name: slash >= 0 ? path.slice(slash + 1) : path };
}

/** Minecraft's UV for a face that has none: taken from the element's position (in 0..16 units). */
export function defaultFaceUv(face: CuboidFaceName, from: Readonly<Vec3>, to: Readonly<Vec3>): [number, number, number, number] {
  const [x1, y1, z1] = from;
  const [x2, y2, z2] = to;
  switch (face) {
    case 'down':
      return [x1, 16 - z2, x2, 16 - z1];
    case 'up':
      return [x1, z1, x2, z2];
    case 'north':
      return [16 - x2, 16 - y2, 16 - x1, 16 - y1];
    case 'south':
      return [x1, 16 - y2, x2, 16 - y1];
    case 'west':
      return [z1, 16 - y2, z2, 16 - y1];
    case 'east':
      return [16 - z2, 16 - y2, 16 - z1, 16 - y1];
  }
}

interface ElementDraft {
  name: string;
  from: Vec3;
  to: Vec3;
  origin: Vec3;
  rotation: Vec3;
  cuboid: Cuboid;
}

function readFace(raw: unknown, name: CuboidFaceName, draft: ElementDraft, ctx: ReadContext): CuboidFace {
  if (!isObject(raw)) return { ...blankFace([0, 0, 0, 0]), enabled: false };
  const [w, h] = ctx.textureSize;
  const uv16 = Array.isArray(raw.uv) && raw.uv.length === 4 && raw.uv.every(isNumber) ? (raw.uv as number[]) : defaultFaceUv(name, draft.from, draft.to);
  const uv: [number, number, number, number] = [tidy((uv16[0] * w) / 16), tidy((uv16[1] * h) / 16), tidy((uv16[2] * w) / 16), tidy((uv16[3] * h) / 16)];
  const variable = typeof raw.texture === 'string' ? raw.texture.replace(/^#/, '') : null;
  const texture = variable === null ? null : (ctx.textureIds.get(variable) ?? null);
  if (variable !== null && variable !== 'missing' && texture === null && !ctx.inherited?.has(variable)) ctx.warnings.push(`Face texture "#${variable}" is not defined in "textures"`);
  const rotation = raw.rotation === 90 || raw.rotation === 180 || raw.rotation === 270 ? raw.rotation : 0;
  return {
    enabled: true,
    texture,
    uv,
    rotation,
    tintIndex: Number.isInteger(raw.tintindex) && (raw.tintindex as number) >= 0 ? (raw.tintindex as number) : null,
    cullface: isDirection(raw.cullface) ? raw.cullface : null,
  };
}

const elementRules: readonly ReadRule<ElementDraft>[] = [
  { since: '26.3', read: (raw, _c, d) => (typeof raw.name === 'string' && raw.name ? { ...d, name: raw.name } : d) },
  {
    since: '26.3',
    read: (raw, ctx, d) => {
      if (!isVec3(raw.from) || !isVec3(raw.to)) {
        ctx.warnings.push('An element without valid "from" / "to" was skipped');
        throw new SkipElement();
      }
      return { ...d, from: raw.from, to: raw.to };
    },
  },
  {
    // Both rotation forms: { origin, axis, angle } (before 1.21.11) and { x, y, z, origin } (multi-axis).
    since: '26.3',
    read: (raw, _c, d) => {
      const rot = raw.rotation;
      if (!isObject(rot)) return d;
      const origin = isVec3(rot.origin) ? rot.origin : d.origin;
      let rotation: Vec3 = [0, 0, 0];
      if (typeof rot.axis === 'string' && isNumber(rot.angle)) {
        const index = ['x', 'y', 'z'].indexOf(rot.axis);
        if (index >= 0) rotation = rotation.map((v, i) => (i === index ? (rot.angle as number) : v)) as Vec3;
      } else {
        rotation = [isNumber(rot.x) ? rot.x : 0, isNumber(rot.y) ? rot.y : 0, isNumber(rot.z) ? rot.z : 0];
      }
      return { ...d, origin, rotation, cuboid: { ...d.cuboid, rescale: rot.rescale === true } };
    },
  },
  { since: '26.3', read: (raw, _c, d) => (raw.shade === false ? { ...d, cuboid: { ...d.cuboid, shade: false } } : d) },
  {
    since: '26.3',
    read: (raw, _c, d) =>
      Number.isInteger(raw.light_emission) ? { ...d, cuboid: { ...d.cuboid, lightEmission: Math.max(0, Math.min(15, raw.light_emission as number)) } } : d,
  },
  {
    since: '26.3',
    read: (raw, _c, d) => (isDirection(raw.shade_direction_override) ? { ...d, cuboid: { ...d.cuboid, shadeDirectionOverride: raw.shade_direction_override } } : d),
  },
  {
    since: '26.3',
    read: (raw, ctx, d) => {
      const faces = isObject(raw.faces) ? raw.faces : {};
      const out = {} as Record<CuboidFaceName, CuboidFace>;
      for (const name of cuboidFaces) out[name] = readFace(faces[name], name, d, ctx);
      return { ...d, cuboid: { ...d.cuboid, faces: out } };
    },
  },
];

class SkipElement extends Error {}

function readElement(raw: unknown, ctx: ReadContext): ElementDraft | null {
  if (!isObject(raw)) {
    ctx.warnings.push('An element that is not an object was skipped');
    return null;
  }
  let draft: ElementDraft = { name: 'cube', from: [0, 0, 0], to: [16, 16, 16], origin: [8, 8, 8], rotation: [0, 0, 0], cuboid: createCuboid([0, 0, 0], [0, 0, 0], null) };
  try {
    for (const rule of elementRules) if (inRange(rule, ctx.version)) draft = rule.read(raw, ctx, draft);
  } catch (error) {
    if (error instanceof SkipElement) return null;
    throw error;
  }
  return draft;
}

/** Reads the "groups" tree: nested { name, origin, children: [index | group] }. */
function readGroups(raw: unknown, warnings: string[]) {
  const groups: Group[] = [];
  const elementGroup = new Map<number, string>();
  const walk = (list: unknown[], parentId: string | null) => {
    for (const child of list) {
      if (isNumber(child)) {
        if (parentId !== null) elementGroup.set(child, parentId);
      } else if (isObject(child)) {
        const group: Group = {
          id: newId(),
          name: typeof child.name === 'string' && child.name ? child.name : 'group',
          parentId,
          ...(isVec3(child.origin) ? { pivot: child.origin } : {}),
        };
        groups.push(group);
        if (Array.isArray(child.children)) walk(child.children, group.id);
      }
    }
  };
  if (Array.isArray(raw)) walk(raw, null);
  else if (raw !== undefined) warnings.push('"groups" is not a list and was ignored');
  return { groups, elementGroup };
}

/** Parses model JSON text into a new Minecraft document state. Throws on text that is not a JSON object. */
export function importJavaModel(text: string, opts: JavaImportOptions = {}): JavaImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new Error('The model file is not valid JSON');
  }
  if (!isObject(raw)) throw new Error('The model file is not a JSON object');
  const version = opts.version ?? DEFAULT_VERSION;
  if (!isJavaVersion(version)) throw new Error(`Unknown Minecraft Java version "${version}"`);
  const warnings: string[] = [];

  const textureSize: [number, number] =
    Array.isArray(raw.texture_size) && raw.texture_size.length === 2 && raw.texture_size.every((n) => Number.isInteger(n) && n >= 1 && n <= 4096)
      ? [raw.texture_size[0] as number, raw.texture_size[1] as number]
      : [16, 16];

  // Textures: one document texture per resource location; "#var" entries are aliases of another variable.
  const textures: Record<string, Texture> = {};
  const textureIds = new Map<string, string>();
  const byLocation = new Map<string, string>();
  const aliases: [string, string][] = [];
  let particle: string | null = null;
  const rawTextures = isObject(raw.textures) ? raw.textures : {};
  for (const [key, value] of Object.entries(rawTextures)) {
    if (typeof value !== 'string') continue;
    if (value.startsWith('#')) {
      aliases.push([key, value.slice(1)]);
      continue;
    }
    let id = byLocation.get(value);
    if (!id) {
      id = newId();
      const location = parseLocation(value);
      const image = opts.images?.[value];
      if (!image) warnings.push(`Texture "${value}" was not found; a placeholder is shown instead`);
      textures[id] = {
        id,
        name: location.name,
        mimeType: 'image/png',
        data: image?.data ?? MISSING_TEXTURE_PNG,
        width: image?.width ?? 16,
        height: image?.height ?? 16,
        java: { namespace: location.namespace, folder: location.folder, key: key === 'particle' ? `particle_${Object.keys(textures).length}` : key },
      };
      byLocation.set(value, id);
    } else if (key !== 'particle' && textures[id].java!.key.startsWith('particle_')) {
      // The image was first seen as the particle; it takes the name of this real variable.
      textures[id] = { ...textures[id], java: { ...textures[id].java!, key } };
    } else if (key !== 'particle') {
      warnings.push(`Texture variables "${key}" and "${textures[id].java!.key}" use the same image; "${key}" is merged into it`);
    }
    if (key === 'particle') particle = id;
    else textureIds.set(key, id);
  }
  const textureRefs: Record<string, string> = {};
  for (const [key, target] of aliases) {
    const id = textureIds.get(target);
    if (!id) {
      // Defined by the parent model: kept as a reference and written back on export.
      textureRefs[key] = `#${target}`;
      if (!opts.inheritedVariables?.has(target)) {
        warnings.push(`Texture variable "${key}" refers to "#${target}", which the model does not define (it may come from the parent model)`);
      }
      continue;
    }
    if (key === 'particle') particle = id;
    else {
      textureIds.set(key, id);
      warnings.push(`Texture variable "${key}" is an alias of "#${target}"; faces using it now use "#${target}"`);
    }
  }
  // Faces that use a variable only the parent model defines get that texture (written out explicitly on export).
  if (opts.inheritedTextures && Array.isArray(raw.elements)) {
    for (const element of raw.elements) {
      const faces = isObject(element) && isObject(element.faces) ? Object.values(element.faces) : [];
      for (const face of faces) {
        const variable = isObject(face) && typeof face.texture === 'string' ? face.texture.replace(/^#/, '') : null;
        const location = variable !== null ? opts.inheritedTextures[variable] : undefined;
        if (variable === null || location === undefined || textureIds.has(variable) || location.startsWith('#')) continue;
        let id = byLocation.get(location);
        if (!id) {
          id = newId();
          const parsed = parseLocation(location);
          const image = opts.images?.[location];
          if (!image) warnings.push(`Texture "${location}" was not found; a placeholder is shown instead`);
          textures[id] = {
            id,
            name: parsed.name,
            mimeType: 'image/png',
            data: image?.data ?? MISSING_TEXTURE_PNG,
            width: image?.width ?? 16,
            height: image?.height ?? 16,
            java: { namespace: parsed.namespace, folder: parsed.folder, key: variable },
          };
          byLocation.set(location, id);
        }
        textureIds.set(variable, id);
      }
    }
  }
  // A particle texture that is only used as particle keeps a readable variable.
  if (particle && textures[particle].java!.key.startsWith('particle_')) textures[particle] = { ...textures[particle], java: { ...textures[particle].java!, key: 'particle_texture' } };

  const ctx: ReadContext = { version, warnings, textureSize, textureIds, inherited: opts.inheritedVariables };
  const { groups, elementGroup } = readGroups(raw.groups, warnings);
  const objects: Record<string, SceneObject> = {};
  const order: string[] = [];
  const names: string[] = [];
  (Array.isArray(raw.elements) ? raw.elements : []).forEach((rawElement, index) => {
    const draft = readElement(rawElement, ctx);
    if (!draft) return;
    const id = newId();
    const lo: Vec3 = [0, 1, 2].map((i) => Math.min(draft.from[i], draft.to[i])) as Vec3;
    const hi: Vec3 = [0, 1, 2].map((i) => Math.max(draft.from[i], draft.to[i])) as Vec3;
    const name = uniqueName(names, draft.name);
    names.push(name);
    const obj: SceneObject = {
      id,
      name,
      visible: true,
      transform: { position: modelToWorld(draft.origin), rotation: draft.rotation, scale: [1, 1, 1] },
      mesh: { positions: [], faces: [] },
      modifiers: [],
      smooth: false,
      groupId: elementGroup.get(index) ?? null,
      materialId: null,
      cuboid: { ...draft.cuboid, from: subVec(lo, draft.origin).map(tidy) as Vec3, to: subVec(hi, draft.origin).map(tidy) as Vec3 },
    };
    objects[id] = syncCuboidObject(obj, textureSize);
    order.push(id);
  });
  if (!Array.isArray(raw.elements) && raw.elements !== undefined) warnings.push('"elements" is not a list and was ignored');

  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) if (!KNOWN_ROOT_KEYS.has(key)) extra[key] = value;
  const java: JavaModelSettings = defaultJavaSettings({
    version,
    fileName: opts.fileName ?? 'model',
    parent: typeof raw.parent === 'string' ? raw.parent : '',
    ambientOcclusion: raw.ambientocclusion !== false,
    guiLight: raw.gui_light === 'front' || raw.gui_light === 'side' ? raw.gui_light : null,
    textureSize,
    credit: typeof raw.credit === 'string' ? raw.credit : '',
    particle,
    ...(isObject(raw.display) ? { display: raw.display } : {}),
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
    ...(Object.keys(textureRefs).length > 0 ? { textureRefs } : {}),
  });
  return {
    state: {
      ...emptyDocState,
      objects,
      order,
      groups: Object.fromEntries(groups.map((g) => [g.id, g])),
      groupOrder: groups.map((g) => g.id),
      textures,
      format: 'minecraft_java',
      java,
    },
    warnings,
  };
}
