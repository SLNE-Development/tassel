// Minecraft Java block/item model JSON: export of a Minecraft document.
//
// Every key the exporter can write is a rule with a `since` / `until` version range (versions.ts). A new
// version that writes something differently adds a rule ending (`until`) at it and one starting (`since`) at
// it; the rules of older versions stay as they are, and golden files pin their output.
import { cuboidFaces } from '../types';
import type { Cuboid, CuboidFace, CuboidFaceName, DocState, Group, JavaModelSettings, SceneObject, Texture } from '../types';
import { modelBox, uvSize } from './cuboid';
import { tidy } from './space';
import { inRange, type Ranged } from './versions';

type Json = Record<string, unknown>;

/** What the rules of an element get. */
interface ElementInput {
  readonly obj: SceneObject & { cuboid: Cuboid };
  readonly state: DocState;
  readonly java: JavaModelSettings;
}

interface Rule<I> extends Ranged {
  readonly key: string;
  /** The value to write, or undefined to leave the key out. */
  write(input: I): unknown;
}

/** The texture variable as faces refer to it. */
function textureVar(state: DocState, id: string | null): string {
  const texture = id === null ? undefined : (Object.hasOwn(state.textures, id) ? state.textures[id] : undefined);
  return texture?.java ? `#${texture.java.key}` : '#missing';
}

/** `namespace:folder/name`; the namespace is left out when it is `minecraft`. */
export function textureLocation(texture: Texture): string {
  const ref = texture.java ?? { namespace: 'minecraft', folder: 'block', key: '' };
  const path = ref.folder ? `${ref.folder.replace(/\/+$/, '')}/${texture.name}` : texture.name;
  return ref.namespace && ref.namespace !== 'minecraft' ? `${ref.namespace}:${path}` : path;
}

const r = (n: number) => tidy(n);

function faceJson(face: CuboidFace, state: DocState, java: JavaModelSettings): Json {
  const [w, h] = uvSize({ java });
  const out: Json = { uv: [r((face.uv[0] * 16) / w), r((face.uv[1] * 16) / h), r((face.uv[2] * 16) / w), r((face.uv[3] * 16) / h)] };
  if (face.rotation !== 0) out.rotation = face.rotation;
  out.texture = textureVar(state, face.texture);
  if (face.cullface) out.cullface = face.cullface;
  if (face.tintIndex !== null) out.tintindex = face.tintIndex;
  return out;
}

const elementRules: readonly Rule<ElementInput>[] = [
  { key: 'name', since: '26.3', write: ({ obj }) => (obj.name === 'cube' ? undefined : obj.name) },
  {
    key: 'from',
    since: '26.3',
    write: ({ obj }) => modelBox(obj).from.map((v) => r(v - obj.cuboid.inflate)),
  },
  {
    key: 'to',
    since: '26.3',
    write: ({ obj }) => modelBox(obj).to.map((v) => r(v + obj.cuboid.inflate)),
  },
  { key: 'shade', since: '26.3', write: ({ obj }) => (obj.cuboid.shade ? undefined : false) },
  { key: 'light_emission', since: '26.3', write: ({ obj }) => (obj.cuboid.lightEmission > 0 ? obj.cuboid.lightEmission : undefined) },
  { key: 'shade_direction_override', since: '26.3', write: ({ obj }) => obj.cuboid.shadeDirectionOverride ?? undefined },
  {
    // 26.3: free rotation on all three axes, written as { x, y, z, origin } (+ rescale).
    key: 'rotation',
    since: '26.3',
    write: ({ obj }) => {
      const [x, y, z] = obj.transform.rotation;
      if (x === 0 && y === 0 && z === 0 && !obj.cuboid.rescale) return undefined;
      return { x: r(x), y: r(y), z: r(z), origin: modelBox(obj).origin, ...(obj.cuboid.rescale ? { rescale: true } : {}) };
    },
  },
  {
    key: 'faces',
    since: '26.3',
    write: ({ obj, state, java }) => {
      const faces: Json = {};
      for (const name of cuboidFaces) if (obj.cuboid.faces[name].enabled) faces[name] = faceJson(obj.cuboid.faces[name], state, java);
      return faces;
    },
  },
];

interface RootInput {
  readonly state: DocState;
  readonly java: JavaModelSettings;
  readonly elements: readonly Json[];
  readonly groups: readonly unknown[] | null;
}

const rootRules: readonly Rule<RootInput>[] = [
  { key: 'credit', since: '26.3', write: ({ java }) => java.credit || undefined },
  { key: 'parent', since: '26.3', write: ({ java }) => java.parent || undefined },
  { key: 'ambientocclusion', since: '26.3', write: ({ java }) => (java.ambientOcclusion ? undefined : false) },
  {
    key: 'texture_size',
    since: '26.3',
    write: ({ java }) => (java.textureSize[0] === 16 && java.textureSize[1] === 16 ? undefined : [...java.textureSize]),
  },
  {
    key: 'textures',
    since: '26.3',
    write: ({ state, java }) => {
      const textures = sortedTextures(state);
      if (textures.length === 0 && java.particle === null) return undefined;
      const out: Json = {};
      for (const texture of textures) out[texture.java!.key] = textureLocation(texture);
      const particle = java.particle !== null && Object.hasOwn(state.textures, java.particle) ? state.textures[java.particle] : undefined;
      if (particle) out.particle = textureLocation(particle);
      return out;
    },
  },
  { key: 'elements', since: '26.3', write: ({ elements }) => (elements.length > 0 ? elements : undefined) },
  { key: 'gui_light', since: '26.3', write: ({ java }) => java.guiLight ?? undefined },
  { key: 'display', since: '26.3', write: ({ java }) => (java.display && Object.keys(java.display).length > 0 ? java.display : undefined) },
  { key: 'groups', since: '26.3', write: ({ groups }) => groups ?? undefined },
];

/** Textures of the document that have a resource location, ordered by variable (numbers numerically). */
function sortedTextures(state: DocState): Texture[] {
  return Object.values(state.textures)
    .filter((t) => t.java)
    .sort((a, b) => a.java!.key.localeCompare(b.java!.key, 'en', { numeric: true }));
}

function exportable(obj: SceneObject): obj is SceneObject & { cuboid: Cuboid } {
  return !!obj.cuboid && obj.cuboid.export && cuboidFaces.some((f: CuboidFaceName) => obj.cuboid!.faces[f].enabled);
}

/**
 * Elements in document order (so that a model read and written again keeps its element order) and the group
 * tree, whose children are per level the nested groups and then the indices of the group's elements.
 */
function walkOutliner(state: DocState, ids: ReadonlySet<string> | null) {
  const order = state.order.map((id) => state.objects[id]).filter((o) => exportable(o) && (!ids || ids.has(o.id))) as (SceneObject & {
    cuboid: Cuboid;
  })[];
  const childGroups = (parent: string | null) => state.groupOrder.map((id) => state.groups[id]).filter((g) => g.parentId === parent);
  const walk = (parent: string | null): unknown[] => [
    ...childGroups(parent).map((group) => groupJson(group, walk(group.id))),
    ...order.flatMap((obj, index) => (obj.groupId === parent ? [index] : [])),
  ];
  return { order, tree: walk(null) };
}

function groupJson(group: Group, children: unknown[]): Json {
  return { name: group.name, origin: group.pivot ?? [8, 8, 8], color: 0, children };
}

/** The document as a model JSON object (keys in the order Minecraft's own models and Blockbench use). */
export function javaModelObject(state: DocState, opts: { ids?: readonly string[] } = {}): Json {
  const java = state.java;
  if (!java) throw new Error('The document is not a Minecraft Java model');
  const { order, tree } = walkOutliner(state, opts.ids ? new Set(opts.ids) : null);
  const elements = order.map((obj) => {
    const out: Json = {};
    for (const rule of elementRules) {
      if (!inRange(rule, java.version)) continue;
      const value = rule.write({ obj, state, java });
      if (value !== undefined) out[rule.key] = value;
    }
    return out;
  });
  const groups = Object.keys(state.groups).length > 0 ? tree : null;
  const model: Json = {};
  for (const rule of rootRules) {
    if (!inRange(rule, java.version)) continue;
    const value = rule.write({ state, java, elements, groups });
    if (value !== undefined) model[rule.key] = value;
  }
  // Keys of an imported model that Tessel does not know go back out unchanged.
  for (const [key, value] of Object.entries(java.extra ?? {})) if (!Object.hasOwn(model, key)) model[key] = value;
  return model;
}

/**
 * Model JSON text: tab-indented like Blockbench, except that number arrays (from, to, uv, origin, ...)
 * stay on one line. Ends with a newline.
 */
export function exportJavaModel(state: DocState, opts: { ids?: readonly string[] } = {}): string {
  return `${stringify(javaModelObject(state, opts), '')}\n`;
}

function stringify(value: unknown, indent: string): string {
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v === 'number')) return `[${value.map((v) => JSON.stringify(v)).join(', ')}]`;
    if (value.length === 0) return '[]';
    const inner = indent + '\t';
    return `[\n${value.map((v) => inner + stringify(v, inner)).join(',\n')}\n${indent}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return '{}';
    const inner = indent + '\t';
    return `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${stringify(v, inner)}`).join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
