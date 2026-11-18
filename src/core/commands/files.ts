import { z } from 'zod';
import { MAX_TEXTURE_BASE64, MAX_TEXTURE_SIZE, materialFields, textureDataProblem } from '../materials';
import { activeDoc, newId, uniqueName } from '../state';
import { exportFormats, importFormats, textureMimeTypes, textureSlots } from '../types';
import type { DocState, ExportFormat, Group, ImportedScene, Material, SceneObject, Texture, TextureSlot } from '../types';
import { defineCommand, docState, updateDocState, type CommandContext } from './registry';

/** Upper limit for an imported file: 256 MB of base64 (192 MB on disk). */
export const MAX_IMPORT_BASE64 = 256 * 1024 * 1024;

async function exportFile(ctx: CommandContext, format: ExportFormat, selectionOnly: boolean, name?: string) {
  if (!ctx.services.exporter) throw new Error('The exporter is not ready yet');
  const state = docState(ctx);
  if (selectionOnly && state.selection.length === 0) throw new Error('Nothing is selected');
  const ids = selectionOnly ? state.selection : state.order;
  if (!ids.some((id) => state.objects[id]?.visible)) {
    throw new Error(selectionOnly ? 'Nothing to export: all selected objects are hidden' : 'Nothing to export: the document has no visible objects');
  }
  const result = await ctx.services.exporter.export(state, {
    format,
    ids: selectionOnly ? state.selection : undefined,
    name: name ?? activeDoc(ctx.get()).name,
  });
  return { format, ...result };
}

/** File name without folder and extension. */
function stem(name: string): string {
  const fileName = name.split(/[\\/]/).pop() ?? name;
  const dot = fileName.lastIndexOf('.');
  return (dot > 0 ? fileName.slice(0, dot) : fileName).trim();
}

function fieldOr<T>(schema: z.ZodType<T>, value: unknown, fallback: T): T {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

/**
 * Adds what an importer read to the document: new ids, names made unique, references rewired.
 * Returns the new state and what was added. Pure, so undo gets it as one step.
 */
export function addImported(state: DocState, scene: ImportedScene, fallbackName: string) {
  const warnings = [...scene.warnings];

  // Textures: the same rules as texture.add; one that breaks them is left out.
  const textures: Record<string, Texture> = { ...state.textures };
  const textureNames = Object.values(state.textures).map((t) => t.name);
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
    const added: Texture = { ...texture, id: newId(), name: uniqueName(textureNames, texture.name || fallbackName) };
    textureNames.push(added.name);
    textures[added.id] = added;
    return added.id;
  });

  const materials: Record<string, Material> = { ...state.materials };
  const materialNames = Object.values(state.materials).map((m) => m.name);
  const materialIds = scene.materials.map((source) => {
    const maps: Partial<Record<TextureSlot, string>> = {};
    for (const slot of textureSlots) {
      const index = source.maps[slot];
      const textureId = index === undefined ? null : textureIds[index];
      if (textureId) maps[slot] = textureId;
    }
    const material: Material = {
      id: newId(),
      name: uniqueName(materialNames, source.name || fallbackName),
      baseColor: fieldOr(materialFields.baseColor, source.baseColor, '#b9b5ae'),
      metallic: fieldOr(materialFields.metallic, source.metallic, 0),
      roughness: fieldOr(materialFields.roughness, source.roughness, 0.6),
      emissive: fieldOr(materialFields.emissive, source.emissive, '#000000'),
      emissiveStrength: fieldOr(materialFields.emissiveStrength, source.emissiveStrength, 1),
      normalScale: fieldOr(materialFields.normalScale, source.normalScale, 1),
      maps,
    };
    materialNames.push(material.name);
    materials[material.id] = material;
    return material.id;
  });

  // Only groups that end up with objects inside are created.
  const sources = scene.objects.filter((o) => o.mesh.faces.length > 0);
  const usedGroups = new Set<number>();
  for (const o of sources) {
    for (let g = o.group; g !== null && scene.groups[g] && !usedGroups.has(g); g = scene.groups[g].parent) usedGroups.add(g);
  }
  const groups: Record<string, Group> = { ...state.groups };
  const groupNames = Object.values(state.groups).map((g) => g.name);
  const groupIds = new Map<number, string>();
  const newGroups: Group[] = [];
  scene.groups.forEach((source, index) => {
    if (!usedGroups.has(index)) return;
    // Parents come first; a parent that is missing or comes later puts the group at top level.
    const group: Group = {
      id: newId(),
      name: uniqueName(groupNames, source.name || fallbackName),
      parentId: (source.parent !== null && groupIds.get(source.parent)) || null,
    };
    groupNames.push(group.name);
    groupIds.set(index, group.id);
    groups[group.id] = group;
    newGroups.push(group);
  });

  const objects: Record<string, SceneObject> = { ...state.objects };
  const objectNames = state.order.map((id) => state.objects[id].name);
  const newObjects: SceneObject[] = sources.map((source) => {
    const object: SceneObject = {
      id: newId(),
      name: uniqueName(objectNames, source.name || fallbackName),
      visible: true,
      transform: source.transform,
      mesh: source.mesh,
      modifiers: [],
      smooth: source.smooth,
      groupId: (source.group !== null && groupIds.get(source.group)) || null,
      materialId: (source.material !== null && materialIds[source.material]) || null,
    };
    objectNames.push(object.name);
    objects[object.id] = object;
    return object;
  });
  if (newObjects.length === 0) throw new Error('The file contains no meshes, so there is nothing to import');

  const ids = newObjects.map((o) => o.id);
  const next: DocState = {
    ...state,
    objects,
    order: [...state.order, ...ids],
    groups,
    groupOrder: [...state.groupOrder, ...newGroups.map((g) => g.id)],
    materials,
    textures,
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
      materials: brief(materialIds.map((id) => materials[id])),
      textures: brief(textureIds.filter((id) => id !== null).map((id) => textures[id])),
      warnings,
    },
  };
}

const formatNotes =
  'glb = binary glTF 2.0 in one file (usually what you want); gltf = glTF JSON text with everything embedded as base64 (about a third larger); obj = Wavefront OBJ with polygons kept as polygons, in world space, plus mtl (material library text), mtlName and files (the texture images as { name, base64 }) that belong next to the .obj; stl = binary STL, triangles in world space, no materials or UVs; ply = binary PLY, triangles in world space with normals and UVs, no materials; usdz = USD archive for AR viewers, textures re-encoded and limited to 4096 px';

export const fileCommands = [
  defineCommand({
    id: 'export.file',
    title: 'Exportieren',
    description: `Export the active document in a 3D file format and return the file data: base64 for the binary formats (glb, stl, ply, usdz), text for gltf and obj. Usually you want the file_export tool instead, which writes the file to disk; this command returns the whole file, which is large (every texture is included in glb, gltf and usdz, so expect at least the sum of the texture sizes) and will flood your context. Exported are the visible objects (or the visible selected ones with selectionOnly) as they look after their modifiers, with transforms, flat or smooth normals, UVs, materials and textures as far as the format has them; objects without a material get a default grey one. Groups become parent nodes in glb, gltf and usdz. Formats: ${formatNotes}. name is the file name without extension that obj uses for its side files (default: the document name).`,
    params: z.object({
      format: z.enum(exportFormats),
      selectionOnly: z.boolean().default(false),
      name: z.string().min(1).optional().describe('File name without extension, used by obj to name its .mtl and image files.'),
    }),
    run(ctx, p) {
      return exportFile(ctx, p.format, p.selectionOnly, p.name);
    },
  }),

  defineCommand({
    id: 'export.gltf',
    title: 'Als glTF exportieren',
    description:
      'Export the active document as glTF and return the data (GLB as base64, or glTF JSON text). Same as export.file with format glb or gltf; usually you want the file_export tool instead, which writes the file to disk.',
    params: z.object({
      binary: z.boolean().default(true).describe('true = GLB, false = glTF JSON'),
      selectionOnly: z.boolean().default(false),
    }),
    run(ctx, p) {
      return exportFile(ctx, p.binary ? 'glb' : 'gltf', p.selectionOnly);
    },
  }),

  defineCommand({
    id: 'import.file',
    title: 'Importieren',
    description: `Import a 3D file into the active document: its meshes become new objects (with materials, textures and groups where the format has them), added as ONE undo step and selected. Usually you want the file_import tool instead, which reads the file from disk. Pass the file as base64 (any format) or as text (gltf, obj, and the ASCII variants of stl, ply and fbx), at most ${MAX_IMPORT_BASE64 / (1024 * 1024)} MB of base64; name is the file name and names objects that have none. Formats: glb / gltf (hierarchy, PBR materials, embedded textures; a .gltf must be self-contained), obj (polygons and UVs kept; materials by name only because the .mtl is a separate file), stl and ply (one object, no materials), fbx (meshes, hierarchy, basic materials, embedded textures; converted to Y up and meters). Triangle formats come in as triangle meshes with vertices at the same position welded. Parent nodes become groups; world transforms are kept as object transforms where possible and baked into the vertices otherwise (shear, mirroring). Returns the new objects, groups, materials and textures as { id, name } and warnings about anything that was skipped (e.g. textures in separate files).`,
    params: z.object({
      format: z.enum(importFormats),
      name: z.string().min(1).describe('File name, e.g. "chair.glb".'),
      base64: z.string().optional().describe('The file as base64 (no data: prefix).'),
      text: z.string().optional().describe('The file as text, for text formats.'),
    }),
    async run(ctx, p) {
      if (!ctx.services.importer) throw new Error('The importer is not ready yet');
      if ((p.base64 === undefined) === (p.text === undefined)) throw new Error('Pass the file either as base64 or as text');
      const size = (p.base64 ?? p.text ?? '').length;
      if (size === 0) throw new Error('The file is empty');
      if (size > MAX_IMPORT_BASE64) {
        throw new Error(
          `The file is too large to import: ${(size / (1024 * 1024)).toFixed(0)} MB of data, the limit is ${MAX_IMPORT_BASE64 / (1024 * 1024)} MB of base64 (${(MAX_IMPORT_BASE64 * 3) / 4 / (1024 * 1024)} MB on disk).`,
        );
      }
      const fallbackName = stem(p.name) || 'Import';
      const scene = await ctx.services.importer.import(p);
      // Built against the state as it is now, after the (asynchronous) parsing.
      const { state, result } = addImported(docState(ctx), scene, fallbackName);
      updateDocState(ctx, () => state);
      return result;
    },
  }),
];
