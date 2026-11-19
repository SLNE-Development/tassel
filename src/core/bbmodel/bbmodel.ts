// Blockbench project (.bbmodel, plain JSON) -> a Tessel document. Written from the public description of the
// JSON layout only. java_block projects become Minecraft Java documents (through the Java model importer);
// every other model format becomes a free document with the group rotations baked into the objects.
import { imageSize } from '../imageInfo';
import { defaultMaterial } from '../materials';
import { cuboidMesh, syncCuboidObject } from '../minecraft/cuboid';
import { MISSING_TEXTURE_PNG, importJavaModel } from '../minecraft/javaImport';
import { emptyDocState, newId, uniqueName } from '../state';
import { cuboidFaces } from '../types';
import type { Cuboid, CuboidFace, CuboidFaceName, DocState, Group, Material, PolyMesh, SceneObject, Texture, Vec3 } from '../types';
import { boxUvFaces } from './boxUv';
import { IDENTITY, apply, blockbenchToTesselEuler, eulerXyz, matrixFromBlockbench, mul, round, type Mat3 } from './rotation';

export interface BbImportImages {
  [textureIndex: number]: { data: string; width: number; height: number };
}

export interface BbImportReport {
  format: 'minecraft_java' | 'free';
  modelFormat: string;
  formatVersion: string;
  elements: number;
  dropped: { kind: string; name: string; reason: string }[];
  warnings: string[];
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every(isNumber);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const vec3 = (v: unknown, fallback: Vec3 = [0, 0, 0]): Vec3 => (isVec3(v) ? [v[0], v[1], v[2]] : [...fallback]);

/** Quick check whether a parsed JSON value looks like a Blockbench project. */
export function isBbmodel(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (isObject(value.meta) && value.meta.format_version !== undefined) return true;
  return (Array.isArray(value.elements) || Array.isArray(value.cubes)) && Array.isArray(value.outliner);
}

// ---------------------------------------------------------------------------------------------------------------
// Parsed project

interface BbTexture {
  index: number;
  name: string;
  id: string;
  namespace: string;
  folder: string;
  particle: boolean;
  uuid: string;
  width: number | null;
  height: number | null;
  uvWidth: number | null;
  uvHeight: number | null;
  /** base64 without prefix, or null */
  data: string | null;
  mimeType: Texture['mimeType'];
}

interface BbElement {
  raw: Json;
  type: string;
  uuid: string;
  name: string;
}

type TreeNode =
  | { kind: 'element'; index: number }
  | { kind: 'group'; name: string; origin: Vec3; rotation: Vec3; visible: boolean; children: TreeNode[] };

/** What a face's texture reference points at. */
type FaceTexture = { kind: 'disabled' } | { kind: 'blank' } | { kind: 'texture'; index: number };

const MIME_BY_TYPE: Record<string, Texture['mimeType']> = { png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg', webp: 'image/webp' };

function readTextures(raw: unknown, images: BbImportImages, warnings: string[]): BbTexture[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry, index) => {
    const t = isObject(entry) ? entry : {};
    let data: string | null = null;
    let mimeType: Texture['mimeType'] = 'image/png';
    if (typeof t.source === 'string' && t.source.startsWith('data:')) {
      const comma = t.source.indexOf(',');
      const header = t.source.slice(5, comma >= 0 ? comma : 5);
      const type = /^image\/([a-z]+)/i.exec(header)?.[1]?.toLowerCase();
      if (type && MIME_BY_TYPE[type]) mimeType = MIME_BY_TYPE[type];
      if (comma >= 0 && t.source.slice(comma + 1)) data = t.source.slice(comma + 1);
    }
    const external = images[index];
    let width = isNumber(t.width) && t.width > 0 ? t.width : null;
    let height = isNumber(t.height) && t.height > 0 ? t.height : null;
    if (data === null && external) {
      data = external.data;
      mimeType = 'image/png';
      width = external.width;
      height = external.height;
    }
    const name = str(t.name, `texture_${index}`);
    if (data === null) warnings.push(`Texture "${name}" has no image data and was not found next to the project file; a placeholder is shown instead`);
    else if (width === null || height === null) {
      try {
        const size = imageSize(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
        if (size) {
          width ??= size.width;
          height ??= size.height;
        }
      } catch {
        /* size stays unknown */
      }
    }
    return {
      index,
      name,
      id: str(t.id).replace(/^#/, ''),
      namespace: str(t.namespace),
      folder: str(t.folder),
      particle: t.particle === true,
      uuid: str(t.uuid),
      width,
      height,
      uvWidth: isNumber(t.uv_width) && t.uv_width > 0 ? t.uv_width : null,
      uvHeight: isNumber(t.uv_height) && t.uv_height > 0 ? t.uv_height : null,
      data,
      mimeType,
    };
  });
}

function resolveFaceTexture(face: unknown, textures: readonly BbTexture[], warn: (message: string) => void): FaceTexture {
  if (!isObject(face)) return { kind: 'disabled' };
  const ref = face.texture;
  if (ref === null) return { kind: 'disabled' };
  if (ref === false || ref === undefined) return { kind: 'blank' };
  let found: BbTexture | undefined;
  if (typeof ref === 'number') found = textures[ref];
  else if (typeof ref === 'string') {
    const key = ref.replace(/^#/, '');
    found = textures.find((t) => t.uuid && t.uuid === key) ?? textures.find((t) => t.id !== '' && t.id === key);
    if (!found && /^\d+$/.test(key)) found = textures[Number(key)];
  }
  if (!found) {
    warn(`A face refers to the texture ${JSON.stringify(ref)}, which does not exist`);
    return { kind: 'blank' };
  }
  return { kind: 'texture', index: found.index };
}

function readTree(root: Json, elements: readonly BbElement[], ignored: ReadonlySet<string>, warnings: string[]): TreeNode[] {
  const byUuid = new Map<string, number>();
  elements.forEach((e, i) => {
    if (e.uuid) byUuid.set(e.uuid, i);
  });
  const groupData = new Map<string, Json>();
  if (Array.isArray(root.groups)) for (const g of root.groups) if (isObject(g) && typeof g.uuid === 'string') groupData.set(g.uuid, g);
  const used = new Set<number>();
  const walk = (list: unknown[]): TreeNode[] => {
    const out: TreeNode[] = [];
    for (const node of list) {
      if (typeof node === 'string') {
        const index = byUuid.get(node);
        if (index === undefined) {
          if (!ignored.has(node)) warnings.push(`The outliner refers to the unknown element "${node}"`);
        } else if (!used.has(index)) {
          used.add(index);
          out.push({ kind: 'element', index });
        }
      } else if (isObject(node)) {
        const data: Json = { ...(typeof node.uuid === 'string' ? (groupData.get(node.uuid) ?? {}) : {}), ...node };
        out.push({
          kind: 'group',
          name: str(data.name) || 'group',
          origin: vec3(data.origin),
          rotation: vec3(data.rotation),
          visible: data.visibility !== false,
          children: Array.isArray(node.children) ? walk(node.children) : [],
        });
      }
    }
    return out;
  };
  const tree = walk(Array.isArray(root.outliner) ? root.outliner : []);
  elements.forEach((_, index) => {
    if (!used.has(index)) tree.push({ kind: 'element', index });
  });
  return tree;
}

type Rect = [number, number, number, number];

/** The six face UV rectangles of a cube in UV pixels, or null for a face without one. */
function cubeFaceUvs(el: Json, boxUv: boolean, from: Vec3, to: Vec3, faces: Json): Record<CuboidFaceName, Rect | null> {
  const out = {} as Record<CuboidFaceName, Rect | null>;
  if (boxUv) {
    const o = el.uv_offset;
    const offset: [number, number] = Array.isArray(o) && o.length >= 2 && isNumber(o[0]) && isNumber(o[1]) ? [o[0], o[1]] : [0, 0];
    const rects = boxUvFaces(offset, [Math.abs(to[0] - from[0]), Math.abs(to[1] - from[1]), Math.abs(to[2] - from[2])], el.mirror_uv === true);
    for (const name of cuboidFaces) out[name] = rects[name];
    return out;
  }
  for (const name of cuboidFaces) {
    const f = faces[name];
    const uv = isObject(f) ? f.uv : undefined;
    out[name] = Array.isArray(uv) && uv.length >= 4 && uv.slice(0, 4).every(isNumber) ? [uv[0], uv[1], uv[2], uv[3]] : null;
  }
  return out;
}

function fileBaseName(name: string): string {
  return name.replace(/\.(bbmodel|json)$/i, '').trim().replace(/\s+/g, '_') || 'model';
}

type Rotation = 0 | 90 | 180 | 270;
const faceRotation = (face: unknown): Rotation =>
  isObject(face) && (face.rotation === 90 || face.rotation === 180 || face.rotation === 270) ? face.rotation : 0;

// ---------------------------------------------------------------------------------------------------------------

export function importBbmodel(text: string, opts: { name?: string; images?: BbImportImages } = {}): { state: DocState; report: BbImportReport } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new Error('The Blockbench project file is not valid JSON');
  }
  if (!isObject(parsed)) throw new Error('The Blockbench project file is not a JSON object');
  const root = parsed;
  const meta = isObject(root.meta) ? root.meta : {};
  const warnings: string[] = [];
  const dropped: BbImportReport['dropped'] = [];
  const modelFormat = str(meta.model_format) || (meta.bone_rig === true ? 'free' : 'java_block');
  const formatVersion = meta.format_version === undefined ? '' : String(meta.format_version);
  const isJava = modelFormat === 'java_block';
  const res: [number, number] =
    isObject(root.resolution) && isNumber(root.resolution.width) && isNumber(root.resolution.height) && root.resolution.width > 0 && root.resolution.height > 0
      ? [root.resolution.width, root.resolution.height]
      : [16, 16];

  // Elements: cubes (and meshes outside Java) are kept, everything else is listed as dropped.
  const rawElements = Array.isArray(root.elements) ? root.elements : Array.isArray(root.cubes) ? root.cubes : [];
  const elements: BbElement[] = [];
  const droppedUuids = new Set<string>();
  for (const entry of rawElements) {
    if (!isObject(entry)) continue;
    const type = str(entry.type) || 'cube';
    const name = str(entry.name) || (type === 'mesh' ? 'mesh' : 'cube');
    if (type === 'cube' || (type === 'mesh' && !isJava)) {
      elements.push({ raw: entry, type, uuid: str(entry.uuid), name });
      continue;
    }
    if (typeof entry.uuid === 'string') droppedUuids.add(entry.uuid);
    if (type === 'mesh') dropped.push({ kind: 'mesh', name, reason: 'Meshes cannot be part of a Minecraft Java model' });
    else if (type === 'locator') dropped.push({ kind: 'locator', name, reason: 'Locators are not supported' });
    else dropped.push({ kind: type, name, reason: `Elements of type "${type}" are not supported` });
  }
  if (Array.isArray(root.animations)) {
    for (const a of root.animations) dropped.push({ kind: 'animation', name: isObject(a) ? str(a.name, 'animation') : 'animation', reason: 'Animations are not imported' });
  }

  const textures = readTextures(root.textures, opts.images ?? {}, warnings);
  const tree = readTree(root, elements, droppedUuids, warnings);
  const ctx: Ctx = { root, elements, textures, tree, res, boxUvDefault: meta.box_uv === true, warnings, name: opts.name };
  const result = isJava ? buildJava(ctx) : buildFree(ctx);
  return {
    state: result.state,
    report: { format: isJava ? 'minecraft_java' : 'free', modelFormat, formatVersion, elements: result.count, dropped, warnings },
  };
}

interface Ctx {
  root: Json;
  elements: BbElement[];
  textures: BbTexture[];
  tree: TreeNode[];
  res: [number, number];
  boxUvDefault: boolean;
  warnings: string[];
  name: string | undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// java_block

function buildJava(ctx: Ctx): { state: DocState; count: number } {
  const { root, elements, textures, tree, res, warnings } = ctx;
  const cubes = elements.map((e, i) => ({ e, i })).filter(({ e }) => e.type === 'cube');
  const emitIndex = new Map<number, number>();
  cubes.forEach(({ i }, n) => emitIndex.set(i, n));

  // Textures -> variables and resource locations.
  const keys: string[] = [];
  const javaTextures: Record<string, string> = {};
  const images: Record<string, { data: string; width: number; height: number }> = {};
  const usedKeys = new Set<string>();
  const usedLocations = new Set<string>();
  let particleKey: string | null = null;
  for (const t of textures) {
    let key = t.id || String(t.index);
    if (usedKeys.has(key)) {
      let n = 2;
      while (usedKeys.has(`${key}_${n}`)) n++;
      warnings.push(`Texture variable "${key}" is used twice; "${t.name}" is renamed to "${key}_${n}"`);
      key = `${key}_${n}`;
    }
    usedKeys.add(key);
    const baseName = t.name.replace(/\.png$/i, '').trim().replace(/\s+/g, '_') || `texture_${t.index}`;
    const folder = t.folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const prefix = t.namespace && t.namespace !== 'minecraft' ? `${t.namespace}:` : '';
    const make = (n: string) => `${prefix}${folder ? `${folder}/` : ''}${n}`;
    let location = make(baseName);
    if (usedLocations.has(location)) {
      let n = 2;
      while (usedLocations.has(make(`${baseName}_${n}`))) n++;
      warnings.push(`Textures share the file name "${baseName}"; "${t.name}" is imported as "${baseName}_${n}"`);
      location = make(`${baseName}_${n}`);
    }
    usedLocations.add(location);
    keys.push(key);
    javaTextures[key] = location;
    images[location] = { data: t.data ?? MISSING_TEXTURE_PNG, width: t.data ? (t.width ?? 16) : 16, height: t.data ? (t.height ?? 16) : 16 };
    if (t.particle && particleKey === null) particleKey = key;
  }
  if (particleKey !== null && particleKey !== 'particle' && !('particle' in javaTextures)) javaTextures.particle = `#${particleKey}`;

  // Elements.
  const faceWarned = new Set<string>();
  const warnOnce = (m: string) => {
    if (!faceWarned.has(m)) {
      faceWarned.add(m);
      warnings.push(m);
    }
  };
  const javaElements = cubes.map(({ e }) => {
    const el = e.raw;
    const from = vec3(el.from);
    const to = vec3(el.to);
    if (!isVec3(el.from) || !isVec3(el.to)) warnings.push(`Element "${e.name}" has no valid "from" / "to"; it was imported as an empty cube`);
    const origin = vec3(el.origin);
    const rotation = vec3(el.rotation);
    const rot = rotation.filter((v) => v !== 0).length > 1 ? blockbenchToTesselEuler(rotation) : rotation;
    const boxUv = typeof el.box_uv === 'boolean' ? el.box_uv : ctx.boxUvDefault;
    const faces = isObject(el.faces) ? el.faces : {};
    const uvs = cubeFaceUvs(el, boxUv, from, to, faces);
    const outFaces: Json = {};
    for (const name of cuboidFaces) {
      const face = faces[name];
      const tex = resolveFaceTexture(face, textures, warnOnce);
      if (tex.kind === 'disabled' || !isObject(face)) continue;
      const out: Json = {};
      const uv = uvs[name];
      if (uv) out.uv = [(uv[0] * 16) / res[0], (uv[1] * 16) / res[1], (uv[2] * 16) / res[0], (uv[3] * 16) / res[1]];
      const turn = boxUv ? 0 : faceRotation(face);
      if (turn !== 0) out.rotation = turn;
      if (tex.kind === 'texture') out.texture = `#${keys[tex.index]}`;
      if (typeof face.cullface === 'string' && (cuboidFaces as readonly string[]).includes(face.cullface)) out.cullface = face.cullface;
      if (isNumber(face.tint) && face.tint >= 0) out.tintindex = Math.floor(face.tint);
      outFaces[name] = out;
    }
    const out: Json = {
      name: e.name,
      from,
      to,
      rotation: { origin, x: rot[0], y: rot[1], z: rot[2], ...(el.rescale === true ? { rescale: true } : {}) },
      faces: outFaces,
    };
    if (el.shade === false) out.shade = false;
    if (isNumber(el.light_emission) && el.light_emission > 0) out.light_emission = Math.min(15, Math.floor(el.light_emission));
    return out;
  });

  // Groups, and the visibility each element inherits from them.
  const visibleByIndex = new Map<number, boolean>();
  const toJavaTree = (nodes: TreeNode[], visible: boolean): unknown[] => {
    const out: unknown[] = [];
    for (const node of nodes) {
      if (node.kind === 'element') {
        visibleByIndex.set(node.index, visible);
        const n = emitIndex.get(node.index);
        if (n !== undefined) out.push(n);
      } else {
        if (node.rotation.some((v) => v !== 0)) warnings.push(`Group "${node.name}" has a rotation, which is ignored (Java models cannot rotate groups)`);
        out.push({ name: node.name, origin: node.origin, children: toJavaTree(node.children, visible && node.visible) });
      }
    }
    return out;
  };
  const groups = toJavaTree(tree, true);

  const synthetic: Json = isObject(root.unhandled_root_fields) ? { ...root.unhandled_root_fields } : {};
  for (const known of ['parent', 'ambientocclusion', 'gui_light', 'texture_size', 'display', 'credit']) delete synthetic[known];
  if (typeof root.parent === 'string' && root.parent) synthetic.parent = root.parent;
  if (typeof root.ambientocclusion === 'boolean') synthetic.ambientocclusion = root.ambientocclusion;
  if (root.front_gui_light === true) synthetic.gui_light = 'front';
  if (res[0] !== 16 || res[1] !== 16) synthetic.texture_size = res;
  synthetic.textures = javaTextures;
  synthetic.elements = javaElements;
  synthetic.groups = groups;
  if (isObject(root.display)) {
    const display: Json = {};
    for (const [slot, value] of Object.entries(root.display)) {
      if (!isObject(value)) continue;
      const entry: Json = {};
      if (isVec3(value.rotation)) entry.rotation = vec3(value.rotation);
      if (isVec3(value.translation)) entry.translation = vec3(value.translation);
      if (isVec3(value.scale)) {
        const mirror = Array.isArray(value.mirror) ? value.mirror : [];
        entry.scale = vec3(value.scale).map((s, i) => (mirror[i] === true ? -s : s));
      }
      display[slot] = entry;
    }
    synthetic.display = display;
  }

  const fileName = fileBaseName(ctx.name ?? (str(root.model_identifier) || str(root.name) || 'model'));
  const imported = importJavaModel(JSON.stringify(synthetic), { fileName, images });
  warnings.push(...imported.warnings);
  const state = imported.state;

  // Cuboid fields that the Java format has no key for.
  const objects: Record<string, SceneObject> = { ...state.objects };
  const textureSize = state.java?.textureSize ?? res;
  cubes.forEach(({ e, i }, n) => {
    const id = state.order[n];
    const obj = id ? objects[id] : undefined;
    if (!obj?.cuboid) return;
    const el = e.raw;
    const cuboid: Cuboid = {
      ...obj.cuboid,
      inflate: isNumber(el.inflate) ? el.inflate : 0,
      locked: el.locked === true,
      export: el.export !== false,
      color: isNumber(el.color) ? Math.max(0, Math.min(7, Math.floor(el.color))) : 0,
    };
    objects[id] = syncCuboidObject({ ...obj, cuboid, visible: el.visibility !== false && (visibleByIndex.get(i) ?? true) }, textureSize);
  });
  return { state: { ...state, objects }, count: cubes.length };
}

// ---------------------------------------------------------------------------------------------------------------
// every other format -> free document

/** Newell normal (not normalised) of a polygon. */
function normalOf(points: readonly Vec3[]): Vec3 {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    x += (a[1] - b[1]) * (a[2] + b[2]);
    y += (a[2] - b[2]) * (a[0] + b[0]);
    z += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [x, y, z];
}

const length = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);

/** The vertex loop of a mesh face: quads may come in any order, so the loop with the largest area is used. */
function faceLoop(keys: readonly string[], position: (key: string) => Vec3): string[] {
  if (keys.length !== 4) return [...keys];
  const [a, b, c, d] = keys;
  const candidates = [
    [a, b, c, d],
    [a, b, d, c],
    [a, c, b, d],
  ];
  let best = candidates[0];
  let bestArea = -1;
  for (const candidate of candidates) {
    const s = length(normalOf(candidate.map(position)));
    if (s > bestArea + 1e-9) {
      best = candidate;
      bestArea = s;
    }
  }
  const reference = normalOf([a, b, c].map(position));
  const normal = normalOf(best.map(position));
  const dot = reference[0] * normal[0] + reference[1] * normal[1] + reference[2] * normal[2];
  return dot < 0 ? [...best].reverse() : best;
}

interface Piece {
  mesh: PolyMesh;
  /** Texture index per face of `mesh`. */
  faceTextures: (number | null)[];
}

function mostUsed(values: readonly (number | null)[]): number | null {
  const counts = new Map<number, number>();
  for (const v of values) if (v !== null) counts.set(v, (counts.get(v) ?? 0) + 1);
  if (counts.size === 0) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
}

/** Merges corners that share a position into shared vertices (cube quads are built corner by corner). */
function weld(mesh: { positions: number[]; faces: number[][]; uvs: number[][] }): PolyMesh {
  const index = new Map<string, number>();
  const positions: number[] = [];
  const remap: number[] = [];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const p = [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]].map((v) => round(v, 6));
    const key = p.join(',');
    let n = index.get(key);
    if (n === undefined) {
      n = positions.length / 3;
      index.set(key, n);
      positions.push(...p);
    }
    remap.push(n);
  }
  return { positions, faces: mesh.faces.map((f) => f.map((v) => remap[v])), uvs: mesh.uvs };
}

function buildFree(ctx: Ctx): { state: DocState; count: number } {
  const { elements, textures, tree, res, warnings } = ctx;
  const docTextures: Record<string, Texture> = {};
  const materials: Record<string, Material> = {};
  const materialOf = new Map<number, string>();
  const textureIds: string[] = [];
  for (const t of textures) {
    const id = newId();
    textureIds.push(id);
    docTextures[id] = {
      id,
      name: t.name.replace(/\.(png|jpe?g|webp)$/i, '') || `texture_${t.index}`,
      mimeType: t.data ? t.mimeType : 'image/png',
      data: t.data ?? MISSING_TEXTURE_PNG,
      width: t.data ? (t.width ?? 16) : 16,
      height: t.data ? (t.height ?? 16) : 16,
    };
  }
  const materialFor = (index: number): string => {
    let id = materialOf.get(index);
    if (!id) {
      id = newId();
      materials[id] = { ...defaultMaterial, id, name: docTextures[textureIds[index]].name, baseColor: '#ffffff', maps: { baseColor: textureIds[index] } };
      materialOf.set(index, id);
    }
    return id;
  };
  const uvSizeOf = (textureIndex: number | null): [number, number] => {
    const t = textureIndex === null ? undefined : textures[textureIndex];
    return [t?.uvWidth ?? res[0], t?.uvHeight ?? res[1]];
  };
  const faceWarned = new Set<string>();
  const warnOnce = (m: string) => {
    if (!faceWarned.has(m)) {
      faceWarned.add(m);
      warnings.push(m);
    }
  };
  /** The texture most of the faces use, with a warning if the faces use more than one. */
  const dominantTexture = (name: string, faceTextures: readonly (number | null)[]): number | null => {
    const distinct = new Set(faceTextures.filter((t): t is number => t !== null));
    if (distinct.size > 1) warnings.push(`Element "${name}" uses more than one texture; only the most used one is kept`);
    return mostUsed(faceTextures);
  };

  const buildCube = (e: BbElement): (Piece & { texture: number | null }) | null => {
    const el = e.raw;
    const from = vec3(el.from);
    const to = vec3(el.to);
    if (!isVec3(el.from) || !isVec3(el.to)) warnings.push(`Element "${e.name}" has no valid "from" / "to"; it was imported as an empty cube`);
    const origin = vec3(el.origin);
    const boxUv = typeof el.box_uv === 'boolean' ? el.box_uv : ctx.boxUvDefault;
    const faces = isObject(el.faces) ? el.faces : {};
    const uvs = cubeFaceUvs(el, boxUv, from, to, faces);
    const resolved = {} as Record<CuboidFaceName, FaceTexture>;
    for (const name of cuboidFaces) resolved[name] = resolveFaceTexture(faces[name], textures, warnOnce);
    const textureOf = (name: CuboidFaceName): number | null => {
      const r = resolved[name];
      return r.kind === 'texture' ? r.index : null;
    };
    const dominant = dominantTexture(
      e.name,
      cuboidFaces.filter((n) => resolved[n].kind !== 'disabled').map(textureOf),
    );
    const size = uvSizeOf(dominant);
    const faceMap = {} as Record<CuboidFaceName, CuboidFace>;
    for (const name of cuboidFaces) {
      faceMap[name] = {
        enabled: resolved[name].kind !== 'disabled',
        texture: null,
        uv: uvs[name] ?? [0, 0, size[0], size[1]],
        rotation: boxUv ? 0 : faceRotation(faces[name]),
        tintIndex: null,
        cullface: null,
      };
    }
    const cuboid: Cuboid = {
      from: from.map((v, i) => Math.min(v, to[i]) - origin[i]) as Vec3,
      to: from.map((v, i) => Math.max(v, to[i]) - origin[i]) as Vec3,
      inflate: isNumber(el.inflate) ? el.inflate : 0,
      rescale: false,
      shade: true,
      lightEmission: 0,
      shadeDirectionOverride: null,
      locked: false,
      export: true,
      color: 0,
      faces: faceMap,
    };
    const full = cuboidMesh(cuboid, size);
    // Leave the disabled faces out and drop the vertices that only they used.
    const positions: number[] = [];
    const outFaces: number[][] = [];
    const outUvs: number[][] = [];
    const faceTextures: (number | null)[] = [];
    cuboidFaces.forEach((name, f) => {
      if (!faceMap[name].enabled) return;
      const base = positions.length / 3;
      for (const vi of full.faces[f]) positions.push(full.positions[vi * 3], full.positions[vi * 3 + 1], full.positions[vi * 3 + 2]);
      outFaces.push(full.faces[f].map((_, k) => base + k));
      outUvs.push([...(full.uvs?.[f] ?? [])]);
      faceTextures.push(textureOf(name));
    });
    if (outFaces.length === 0) return null;
    return { mesh: weld({ positions, faces: outFaces, uvs: outUvs }), faceTextures, texture: dominant };
  };

  const buildMesh = (e: BbElement): (Piece & { texture: number | null }) | null => {
    const el = e.raw;
    const vertices = isObject(el.vertices) ? el.vertices : {};
    const rawFaces = Object.values(isObject(el.faces) ? el.faces : {});
    const position = (key: string): Vec3 => vec3(vertices[key]);
    const resolved = rawFaces.map((f) => resolveFaceTexture(f, textures, warnOnce));
    const textureOf = (i: number): number | null => {
      const r = resolved[i];
      return r.kind === 'texture' ? r.index : null;
    };
    const live = rawFaces.map((_, i) => i).filter((i) => resolved[i].kind !== 'disabled');
    const dominant = dominantTexture(e.name, live.map(textureOf));
    const [uw, uh] = uvSizeOf(dominant);
    const indexOf = new Map<string, number>();
    const positions: number[] = [];
    const faces: number[][] = [];
    const uvs: number[][] = [];
    const faceTextures: (number | null)[] = [];
    for (const fi of live) {
      const f = rawFaces[fi];
      if (!isObject(f)) continue;
      const keys = Array.isArray(f.vertices) ? f.vertices.filter((k): k is string => typeof k === 'string' && isVec3(vertices[k])) : [];
      if (keys.length < 3) continue;
      const uvMap = isObject(f.uv) ? f.uv : {};
      const indices: number[] = [];
      const faceUv: number[] = [];
      for (const key of faceLoop(keys, position)) {
        let index = indexOf.get(key);
        if (index === undefined) {
          index = positions.length / 3;
          indexOf.set(key, index);
          positions.push(...position(key).map((v) => round(v / 16, 6)));
        }
        indices.push(index);
        const uv = uvMap[key];
        const [u, v] = Array.isArray(uv) && isNumber(uv[0]) && isNumber(uv[1]) ? [uv[0], uv[1]] : [0, 0];
        faceUv.push(round(u / uw, 6), round(1 - v / uh, 6));
      }
      faces.push(indices);
      uvs.push(faceUv);
      faceTextures.push(textureOf(fi));
    }
    if (faces.length === 0) return null;
    return { mesh: { positions, faces, uvs }, faceTextures, texture: dominant };
  };

  const objects: Record<string, SceneObject> = {};
  const order: string[] = [];
  const groups: Record<string, Group> = {};
  const groupOrder: string[] = [];
  const names: string[] = [];

  /** `world` maps a point of the current group's frame to world px: p -> m p + t. */
  const walk = (nodes: TreeNode[], parentId: string | null, world: { m: Mat3; t: Vec3 }, visible: boolean) => {
    for (const node of nodes) {
      if (node.kind === 'group') {
        const group: Group = { id: newId(), name: node.name, parentId };
        groups[group.id] = group;
        groupOrder.push(group.id);
        // The group turns its content about its origin o: p -> Rg (p - o) + o.
        const rg = matrixFromBlockbench(node.rotation);
        const turned = apply(rg, node.origin);
        const shift = apply(world.m, [node.origin[0] - turned[0], node.origin[1] - turned[1], node.origin[2] - turned[2]]);
        walk(node.children, group.id, { m: mul(world.m, rg), t: [world.t[0] + shift[0], world.t[1] + shift[1], world.t[2] + shift[2]] }, visible && node.visible);
        continue;
      }
      const e = elements[node.index];
      const piece = e.type === 'mesh' ? buildMesh(e) : buildCube(e);
      if (!piece) {
        warnings.push(`Element "${e.name}" has no faces and was skipped`);
        continue;
      }
      const el = e.raw;
      const p = apply(world.m, vec3(el.origin));
      const name = uniqueName(names, e.name);
      names.push(name);
      const id = newId();
      objects[id] = {
        id,
        name,
        visible: visible && el.visibility !== false,
        transform: {
          position: [round((p[0] + world.t[0]) / 16, 6), round((p[1] + world.t[1]) / 16, 6), round((p[2] + world.t[2]) / 16, 6)],
          rotation: eulerXyz(mul(world.m, matrixFromBlockbench(vec3(el.rotation)))),
          scale: [1, 1, 1],
        },
        mesh: piece.mesh,
        modifiers: [],
        smooth: false,
        groupId: parentId,
        materialId: piece.texture === null ? null : materialFor(piece.texture),
      };
      order.push(id);
    }
  };
  walk(tree, null, { m: IDENTITY, t: [0, 0, 0] }, true);

  return { state: { ...emptyDocState, objects, order, groups, groupOrder, materials, textures: docTextures }, count: order.length };
}
