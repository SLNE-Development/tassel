// Adding what an importer (or another project file) holds to a document: fresh ids, unique names,
// references rewired, materials and textures reused where the document already has the same ones,
// and the whole model placed as a unit. Pure functions, so a command gets one undo step out of them.
import { MAX_TEXTURE_BASE64, MAX_TEXTURE_SIZE, materialFields, textureDataProblem } from '../materials';
import { worldBounds } from '../bounds';
import { bakeWorldOffsets, carryWorldOffsets } from '../modifiers/worldOffsets';
import { placeObject, placementMatrix, type Placement } from '../placement';
import { globMatcher } from '../refs';
import { newId, own, uniqueName } from '../state';
import { textureMimeTypes, textureSlots } from '../types';
import type { DocState, Group, ImportedScene, Material, Modifier, SceneObject, Texture, TextureSlot } from '../types';
import type { z } from 'zod';

export interface ImportOptions extends Placement {
  /** Existing group (id) that becomes the parent of what is imported; null / undefined = top level. */
  groupId?: string | null;
  /** Wrap everything imported, including the file's own groups, in ONE new group with this name. */
  groupName?: string;
  /** Use existing identical materials and textures instead of adding copies. Default true. */
  reuseMaterials?: boolean;
}

function fieldOr<T>(schema: z.ZodType<T>, value: unknown, fallback: T): T {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

/** A name without the ".001" style suffix that `uniqueName` adds to copies. */
export function baseName(name: string): string {
  return name.replace(/\.\d{3}$/, '');
}

/**
 * Whether two textures are the same image: same type, same pixel size, the same encoded file (the base64
 * text is compared directly, so byte for byte) and the same paint layers (name, visibility, opacity,
 * blend mode and image of each; layer ids do not count). Names do not count either.
 */
export function sameTexture(a: Omit<Texture, 'id' | 'name'>, b: Omit<Texture, 'id' | 'name'>): boolean {
  if (a.mimeType !== b.mimeType || a.width !== b.width || a.height !== b.height || a.data !== b.data) return false;
  const la = a.layers ?? [];
  const lb = b.layers ?? [];
  if ((a.layers === undefined) !== (b.layers === undefined) || la.length !== lb.length) return false;
  return la.every((x, i) => {
    const y = lb[i];
    return x.name === y.name && x.visible === y.visible && x.opacity === y.opacity && x.blend === y.blend && x.data === y.data;
  });
}

const VALUE_FIELDS = ['metallic', 'roughness', 'emissiveStrength', 'normalScale'] as const;

/**
 * Whether two materials are the same: same name apart from a ".001" style suffix, same colours, same
 * numeric values (within 1e-6) and, slot by slot, the same texture image (see `sameTexture`).
 */
export function sameMaterial(a: Material, b: Material, textures: Readonly<Record<string, Texture>>): boolean {
  if (baseName(a.name) !== baseName(b.name) || a.baseColor !== b.baseColor || a.emissive !== b.emissive) return false;
  if (VALUE_FIELDS.some((field) => !(Math.abs(a[field] - b[field]) <= 1e-6))) return false;
  return textureSlots.every((slot) => {
    const ta = a.maps[slot];
    const tb = b.maps[slot];
    if (ta === undefined || tb === undefined) return ta === tb;
    if (ta === tb) return true;
    const x = own(textures, ta);
    const y = own(textures, tb);
    return x !== undefined && y !== undefined && sameTexture(x, y);
  });
}

type Brief = { id: string; name: string; reused: boolean };

/**
 * Adds textures and materials to copies of the document's records. With `reuse`, a texture that the
 * document already has (`sameTexture`) and a material that it already has (`sameMaterial`; for a
 * `nameOnly` material the name alone decides) are not added: the existing one is used. Only what was in
 * the document before counts, so two equal materials of one file stay two.
 */
function addAssets(state: DocState, scene: Pick<ImportedScene, 'textures' | 'materials'>, fallbackName: string, reuse: boolean, warnings: string[]) {
  const existingTextures = Object.values(state.textures);
  const textures: Record<string, Texture> = { ...state.textures };
  const textureNames = existingTextures.map((t) => t.name);
  const reusedIds = new Set<string>();
  // Textures: the same rules as texture.add; one that breaks them is left out.
  const textureIds = scene.textures.map((texture) => {
    const validSize = (n: number) => Number.isInteger(n) && n >= 1 && n <= MAX_TEXTURE_SIZE;
    const problem = !textureMimeTypes.includes(texture.mimeType)
      ? 'unsupported image type'
      : !validSize(texture.width) || !validSize(texture.height)
        ? `size must be 1..${MAX_TEXTURE_SIZE} pixels`
        : textureDataProblem(texture.mimeType, texture.data) === 'tooLarge'
          ? `larger than ${MAX_TEXTURE_BASE64 / (1024 * 1024)} MB of base64`
          : textureDataProblem(texture.mimeType, texture.data)
            ? 'not a valid image file'
            : null;
    if (problem) {
      warnings.push(`Skipped the texture "${texture.name}": ${problem}`);
      return null;
    }
    const known = reuse ? existingTextures.find((t) => sameTexture(t, texture)) : undefined;
    if (known) {
      reusedIds.add(known.id);
      return known.id;
    }
    const added: Texture = { ...texture, id: newId(), name: uniqueName(textureNames, texture.name || fallbackName) };
    textureNames.push(added.name);
    textures[added.id] = added;
    return added.id;
  });

  const existingMaterials = Object.values(state.materials);
  const materials: Record<string, Material> = { ...state.materials };
  const materialNames = existingMaterials.map((m) => m.name);
  const materialIds = scene.materials.map((source) => {
    const maps: Partial<Record<TextureSlot, string>> = {};
    for (const slot of textureSlots) {
      const index = source.maps[slot];
      const textureId = index === undefined ? null : textureIds[index];
      if (textureId) maps[slot] = textureId;
    }
    const name = source.name || fallbackName;
    const material: Material = {
      id: newId(),
      name,
      baseColor: fieldOr(materialFields.baseColor, source.baseColor, '#b9b5ae'),
      metallic: fieldOr(materialFields.metallic, source.metallic, 0),
      roughness: fieldOr(materialFields.roughness, source.roughness, 0.6),
      emissive: fieldOr(materialFields.emissive, source.emissive, '#000000'),
      emissiveStrength: fieldOr(materialFields.emissiveStrength, source.emissiveStrength, 1),
      normalScale: fieldOr(materialFields.normalScale, source.normalScale, 1),
      maps,
    };
    if (reuse) {
      const candidates = existingMaterials.filter((m) => (source.nameOnly ? baseName(m.name) === baseName(name) : sameMaterial(m, material, textures)));
      const known = candidates.find((m) => m.name === name) ?? candidates[0];
      if (known) {
        reusedIds.add(known.id);
        return known.id;
      }
    }
    const added: Material = { ...material, name: uniqueName(materialNames, name) };
    materialNames.push(added.name);
    materials[added.id] = added;
    return added.id;
  });

  const brief = (ids: readonly (string | null)[], record: Readonly<Record<string, { id: string; name: string }>>): Brief[] =>
    [...new Set(ids.filter((id) => id !== null))].map((id) => ({ id, name: record[id].name, reused: reusedIds.has(id) }));
  const briefMaterials = brief(materialIds, materials);
  const briefTextures = brief(textureIds, textures);
  return {
    textures,
    materials,
    textureIds,
    materialIds,
    result: {
      materials: briefMaterials,
      textures: briefTextures,
      reused: { materials: briefMaterials.filter((m) => m.reused).length, textures: briefTextures.filter((t) => t.reused).length },
    },
  };
}

/**
 * Adds what an importer read to the document: new ids, names made unique, references rewired, the model
 * placed as a unit (see `ImportOptions`). Returns the new state and what was added.
 */
export function addImported(state: DocState, scene: ImportedScene, fallbackName: string, options: ImportOptions = {}) {
  const warnings = [...scene.warnings];
  const parentId = options.groupId ?? null;
  if (parentId !== null && !own(state.groups, parentId)) throw new Error(`Group "${parentId}" does not exist`);
  const assets = addAssets(state, scene, fallbackName, options.reuseMaterials ?? true, warnings);

  const sources = scene.keepEmptyGroups ? scene.objects : scene.objects.filter((o) => o.mesh.faces.length > 0);
  if (sources.length === 0) throw new Error('The file contains no meshes, so there is nothing to import');

  // Groups: all of them for a merged project, otherwise only those that end up with objects inside.
  const usedGroups = new Set<number>();
  for (const o of sources) {
    for (let g = o.group; g !== null && scene.groups[g] && !usedGroups.has(g); g = scene.groups[g].parent) usedGroups.add(g);
  }
  const groups: Record<string, Group> = { ...state.groups };
  const groupNames = Object.values(state.groups).map((g) => g.name);
  const newGroups: Group[] = [];
  const addGroup = (name: string, parent: string | null) => {
    const group: Group = { id: newId(), name: uniqueName(groupNames, name), parentId: parent };
    groupNames.push(group.name);
    groups[group.id] = group;
    newGroups.push(group);
    return group.id;
  };
  // What is at top level in the file goes into the wrapping group, or the given parent group.
  const wrapper = options.groupName !== undefined ? addGroup(options.groupName, parentId) : null;
  const top = wrapper ?? parentId;
  const groupIds = new Map<number, string>();
  scene.groups.forEach((source, index) => {
    if (!scene.keepEmptyGroups && !usedGroups.has(index)) return;
    // Parents come first; a parent that is missing or comes later puts the group at top level.
    groupIds.set(index, addGroup(source.name || fallbackName, (source.parent !== null && groupIds.get(source.parent)) || top));
  });

  const placement = placementMatrix(options);
  const objects: Record<string, SceneObject> = { ...state.objects };
  const objectNames = state.order.map((id) => state.objects[id].name);
  const idOfKey = new Map<string, string>();
  const newObjects: SceneObject[] = sources.map((source) => {
    const placed = placement ? placeObject(source.transform, source.mesh, placement) : { transform: source.transform, mesh: source.mesh, baked: false };
    const object: SceneObject = {
      id: newId(),
      name: uniqueName(objectNames, source.name || fallbackName),
      visible: source.visible ?? true,
      transform: placed.transform,
      mesh: placed.mesh,
      // World-space array offsets of the model turn and scale with the placement, like the model itself.
      modifiers: !placement || !source.modifiers
        ? (source.modifiers ?? [])
        : placed.baked
          ? bakeWorldOffsets(source.modifiers, placement)
          : carryWorldOffsets(source.modifiers, source.transform, placed.transform),
      smooth: source.smooth,
      groupId: (source.group !== null && groupIds.get(source.group)) || top,
      materialId: (source.material !== null && assets.materialIds[source.material]) || null,
    };
    if (placed.baked && object.modifiers.length > 0) {
      warnings.push(
        `"${object.name}": this placement (non-uniform or negative scale on a rotated object) has no position / rotation / scale form, so it was baked into the vertices; the object's modifiers now act in that baked space`,
      );
    }
    if (source.key !== undefined) idOfKey.set(source.key, object.id);
    objectNames.push(object.name);
    return object;
  });
  for (const object of newObjects) {
    // Boolean modifiers point at objects of the file: rewired to the new ids, or cleared.
    const modifiers = object.modifiers.map((m): Modifier => (m.type === 'boolean' && m.targetId !== null ? { ...m, targetId: idOfKey.get(m.targetId) ?? null } : m));
    objects[object.id] = object.modifiers.length > 0 ? { ...object, modifiers } : object;
  }

  const ids = newObjects.map((o) => o.id);
  const next: DocState = {
    ...state,
    objects,
    order: [...state.order, ...ids],
    groups,
    groupOrder: [...state.groupOrder, ...newGroups.map((g) => g.id)],
    materials: assets.materials,
    textures: assets.textures,
    selection: ids,
    activeId: ids[ids.length - 1],
    edit: null,
  };
  const brief = (items: readonly { id: string; name: string }[]) => items.map(({ id, name }) => ({ id, name }));
  return {
    state: next,
    result: {
      objects: brief(newObjects),
      groups: brief(newGroups),
      ...(wrapper !== null ? { groupId: wrapper } : {}),
      ...assets.result,
      bounds: worldBounds(next, ids),
      warnings,
    },
  };
}

/** A parsed project file as an importer's scene: everything in it, modifiers and empty groups included. */
export function projectToScene(state: DocState): ImportedScene {
  const textureIndex = new Map<string, number>();
  const textures = Object.values(state.textures).map(({ id, ...texture }, index) => {
    textureIndex.set(id, index);
    return texture;
  });
  const materialIndex = new Map<string, number>();
  const materials = Object.values(state.materials).map(({ id, maps, ...material }, index) => {
    materialIndex.set(id, index);
    const indexed: Partial<Record<TextureSlot, number>> = {};
    for (const slot of textureSlots) {
      const texture = maps[slot] === undefined ? undefined : textureIndex.get(maps[slot]);
      if (texture !== undefined) indexed[slot] = texture;
    }
    return { ...material, maps: indexed };
  });
  // Parents before their children, siblings in their order.
  const groupIndex = new Map<string, number>();
  const groups: ImportedScene['groups'] = [];
  const addGroup = (id: string, depth: number): number | null => {
    const known = groupIndex.get(id);
    if (known !== undefined) return known;
    const group = own(state.groups, id);
    if (!group || depth > state.groupOrder.length) return null;
    const parent = group.parentId === null ? null : addGroup(group.parentId, depth + 1);
    const index = groups.push({ name: group.name, parent }) - 1;
    groupIndex.set(id, index);
    return index;
  };
  for (const id of state.groupOrder) addGroup(id, 0);
  const objects: ImportedScene['objects'] = [];
  for (const id of state.order) {
    const object = own(state.objects, id);
    if (!object) continue;
    objects.push({
      name: object.name,
      mesh: object.mesh,
      transform: object.transform,
      smooth: object.smooth,
      visible: object.visible,
      modifiers: object.modifiers,
      key: id,
      material: object.materialId === null ? null : (materialIndex.get(object.materialId) ?? null),
      group: object.groupId === null ? null : (groupIndex.get(object.groupId) ?? null),
    });
  }
  return { objects, groups, keepEmptyGroups: true, materials, textures, warnings: [] };
}

/**
 * Copies materials of another project (and the textures they use) into the document. `names` limits
 * them to those matching one of the entries (exact name, or a glob with * and ?). A material the
 * document already has (`sameMaterial`) is reused instead of copied.
 */
export function addMaterials(state: DocState, project: DocState, names?: readonly string[]) {
  const scene = projectToScene(project);
  if (scene.materials.length === 0) throw new Error('The project contains no materials');
  let wanted = scene.materials.map((_, index) => index);
  if (names) {
    const picked = new Set<number>();
    for (const pattern of names) {
      const exact = wanted.filter((index) => scene.materials[index].name === pattern);
      const matches = exact.length > 0 ? exact : wanted.filter((index) => globMatcher(pattern)(scene.materials[index].name));
      if (matches.length === 0) {
        const available = scene.materials.slice(0, 20).map((m) => JSON.stringify(m.name));
        throw new Error(`No material named ${JSON.stringify(pattern)} in the project. It has: ${available.join(', ')}${scene.materials.length > 20 ? ', ...' : ''}`);
      }
      for (const index of matches) picked.add(index);
    }
    wanted = wanted.filter((index) => picked.has(index));
  }
  // Only the textures those materials use, with the map indices following.
  const textureOf = new Map<number, number>();
  const textures: ImportedScene['textures'] = [];
  const materials = wanted.map((index) => {
    const source = scene.materials[index];
    const maps: Partial<Record<TextureSlot, number>> = {};
    for (const slot of textureSlots) {
      const texture = source.maps[slot];
      if (texture === undefined) continue;
      if (!textureOf.has(texture)) textureOf.set(texture, textures.push(scene.textures[texture]) - 1);
      maps[slot] = textureOf.get(texture)!;
    }
    return { ...source, maps };
  });
  const warnings: string[] = [];
  const assets = addAssets(state, { textures, materials }, 'Material', true, warnings);
  const changed = assets.result.materials.some((m) => !m.reused) || assets.result.textures.some((t) => !t.reused);
  return {
    state: changed ? { ...state, materials: assets.materials, textures: assets.textures } : state,
    result: { ...assets.result, warnings },
  };
}
