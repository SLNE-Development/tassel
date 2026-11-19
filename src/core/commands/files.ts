import { z } from 'zod';
import { isFactory, isItemDefinition, isMinecraft } from '../formats';
import { exportFactorySidecar, sidecarFileName } from '../minecraft/factory/sidecar';
import { serializeItemDefinition } from '../minecraft/items/codec';
import { exportJavaModel } from '../minecraft/javaExport';
import { parseProject } from '../project';
import { resolveGroupId } from '../refs';
import { activeDoc } from '../state';
import { exportFormats, importFormats } from '../types';
import type { ExportFormat, ImportedScene } from '../types';
import { addImported, addMaterials, projectToScene } from './importScene';
import { defineCommand, docState, updateDocState, type CommandContext } from './registry';

export { addImported } from './importScene';

/** Upper limit for an imported file: 256 MB of base64 (192 MB on disk). */
export const MAX_IMPORT_BASE64 = 256 * 1024 * 1024;

async function exportFile(ctx: CommandContext, format: ExportFormat, selectionOnly: boolean, name?: string) {
  const state = docState(ctx);
  if (format === 'json' && isItemDefinition(state)) {
    // A Minecraft item definition is written as it is: its file is the document.
    const item = state.item!;
    return { format, text: serializeItemDefinition(item.definition), fileName: `${item.id.split('/').pop()}.json` };
  }
  if (isItemDefinition(state)) throw new Error('An item definition document can only be exported as json (its items/<id>.json file)');
  if (format === 'json') {
    // Minecraft Java model: written by core itself; the export flag of elements decides, not visibility.
    if (!isMinecraft(state)) throw new Error('json (Minecraft Java model) can only be exported from a Minecraft Java document; this document is a Free model');
    if (selectionOnly && state.selection.length === 0) throw new Error('Nothing is selected');
    const fileName = state.java!.fileName;
    // A factory model also writes its sidecar for the server plugin, next to the model as <fileName>.factory.json.
    const sidecar = isFactory(state) ? { sidecar: { fileName: sidecarFileName(fileName), text: exportFactorySidecar(state) } } : {};
    return { format, text: exportJavaModel(state, selectionOnly ? { ids: state.selection } : {}), fileName: `${fileName}.json`, ...sidecar };
  }
  if (!ctx.services.exporter) throw new Error('The exporter is not ready yet');
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

const finiteVec3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);

/** Base64 of a UTF-8 text file -> the text. */
function utf8FromBase64(base64: string): string {
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new Error('The file data is not valid base64');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** File name without folder and extension. */
function stem(name: string): string {
  const fileName = name.split(/[\\/]/).pop() ?? name;
  const dot = fileName.lastIndexOf('.');
  return (dot > 0 ? fileName.slice(0, dot) : fileName).trim();
}

const formatNotes =
  'glb = binary glTF 2.0 in one file (usually what you want); gltf = glTF JSON text with everything embedded as base64 (about a third larger); obj = Wavefront OBJ with polygons kept as polygons, in world space, plus mtl (material library text), mtlName and files (the texture images as { name, base64 }) that belong next to the .obj; stl = binary STL, triangles in world space, no materials or UVs; ply = binary PLY, triangles in world space with normals and UVs, no materials; usdz = USD archive for AR viewers, textures re-encoded and limited to 4096 px; json = Minecraft Java block/item model (Minecraft Java and factory documents only): the model JSON as text, written for the target version of the document, with every cuboid element whose export flag is on (visibility does not matter), textures as resource locations, and fileName (the model file name); a factory document also returns sidecar { fileName, text }, the <fileName>.factory.json for the server plugin; in a Minecraft item definition document, json (the only format there) is the items/<id>.json file';

export const fileCommands = [
  defineCommand({
    id: 'export.file',
    title: 'Exportieren',
    description: `Export the active document in a 3D file format and return the file data: base64 for the binary formats (glb, stl, ply, usdz), text for gltf and obj. Usually you want the file_export tool instead, which writes the file to disk; this command returns the whole file, which is large (every texture is included in glb, gltf and usdz, so expect at least the sum of the texture sizes) and will flood your context. Exported are the visible objects (or the visible selected ones with selectionOnly) as they look after their modifiers, with transforms, flat or smooth normals, UVs, materials and textures as far as the format has them; objects without a material get a default grey one. Groups become parent nodes in glb, gltf and usdz. glb and gltf keep all names exactly and, besides the triangles every glTF has, note each mesh's polygons in the primitive's extras, so that importing the file into Tessel again (import.file, scene_place_model) gives the same quads and n-gons with their UVs back and objects without a material stay without one; other applications ignore the note. Formats: ${formatNotes}. name is the file name without extension that obj uses for its side files (default: the document name).`,
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
    description: `Import a 3D file into the active document: its meshes become new objects (with materials, textures and groups where the format has them), added as ONE undo step and selected. Usually you want the file_import or scene_place_model tool instead, which read the file from disk. Pass the file as base64 (any format) or as text (tessel, gltf, obj, and the ASCII variants of stl, ply and fbx), at most ${MAX_IMPORT_BASE64 / (1024 * 1024)} MB of base64; name is the file name and names objects that have none.

Placement: the imported model is treated as one unit with its own origin (the origin of the file's coordinates). scale (one factor, or [x, y, z] along the model's own axes) and then rotation (Euler XYZ in degrees) are applied about that origin, then the origin is put at position (world space, meters). Each object's transform is composed with this exactly, so the parts keep their arrangement; the default places the model as it is in the file. groupName wraps everything that was imported, the file's own group hierarchy included, in ONE new group of that name (returned as groupId), so the model can be selected as a whole with group.select; groupId (a group id or name, null = top level) is the existing group that gets the new group, or without groupName the imported top-level objects and groups.

Materials: with reuseMaterials (default true) an imported material is not added when the document already has the same one, i.e. same name (a ".001" style suffix is ignored), same colours and values, and byte-identical texture images in the same slots; the existing material is assigned instead. Identical textures (same image file bytes, same size) are reused the same way. So importing ten machines that share "Steel" leaves one "Steel". A material that differs in any value is added under a unique name. reuseMaterials false always adds copies. OBJ files name their materials without values (the .mtl is a separate file), so an OBJ material reuses an existing material of the same name.

Formats: glb / gltf (hierarchy, PBR materials, embedded textures; a .gltf must be self-contained; names are kept exactly; files written by Tessel come back with their polygons (quads, n-gons) and corner UVs, other glTF files as triangles), obj (polygons and UVs kept; materials by name only), stl and ply (one object, no materials), fbx (meshes, hierarchy, basic materials, embedded textures; converted to Y up and meters), tessel (a Tessel project file: ALL its objects with their modifiers, visibility, groups, materials and textures are merged into this document under new ids; boolean modifiers keep pointing at the merged copies of their targets). Triangle formats come in as triangle meshes with vertices at the same position welded. Parent nodes become groups; world transforms are kept as object transforms where possible and baked into the vertices otherwise (shear, mirroring; this also happens for a non-uniform or negative placement scale on rotated objects).

Returns objects, groups, materials and textures as { id, name } (materials and textures with reused: true when an existing one was used), reused: { materials, textures } (counts), groupId (only with groupName), bounds: { min, max } (world-space box around everything added, after the placement) and warnings about anything that was skipped (e.g. textures in separate files). Names are made unique in the document, so compare the returned names if you rely on them.`,
    params: z.object({
      format: z.enum(importFormats),
      name: z.string().min(1).describe('File name, e.g. "chair.glb".'),
      base64: z.string().optional().describe('The file as base64 (no data: prefix).'),
      text: z.string().optional().describe('The file as text, for text formats.'),
      position: finiteVec3.optional().describe('Where the origin of the imported model is put, in world space (meters). Default [0, 0, 0].'),
      rotation: finiteVec3.optional().describe('Rotation of the whole model about its origin, Euler XYZ in degrees. Default [0, 0, 0].'),
      scale: z
        .union([z.number().finite(), finiteVec3])
        .optional()
        .refine((s) => s === undefined || (typeof s === 'number' ? s !== 0 : s.every((v) => v !== 0)), 'scale must not be 0')
        .describe("Scale of the whole model about its origin: one factor, or [x, y, z] along the model's own axes. Default 1."),
      groupId: z.string().nullable().optional().describe('Existing group (id or name) to put the imported model into. Default: top level.'),
      groupName: z.string().min(1).optional().describe('Wrap everything imported in one new group with this name; its id is returned as groupId.'),
      reuseMaterials: z.boolean().default(true).describe('Use identical existing materials and textures instead of adding copies.'),
    }),
    async run(ctx, p) {
      if ((p.base64 === undefined) === (p.text === undefined)) throw new Error('Pass the file either as base64 or as text');
      const size = (p.base64 ?? p.text ?? '').length;
      if (size === 0) throw new Error('The file is empty');
      if (size > MAX_IMPORT_BASE64) {
        throw new Error(
          `The file is too large to import: ${(size / (1024 * 1024)).toFixed(0)} MB of data, the limit is ${MAX_IMPORT_BASE64 / (1024 * 1024)} MB of base64 (${(MAX_IMPORT_BASE64 * 3) / 4 / (1024 * 1024)} MB on disk).`,
        );
      }
      const fallbackName = stem(p.name) || 'Import';
      let scene: ImportedScene;
      if (p.format === 'tessel') {
        const project = parseProject(p.text ?? utf8FromBase64(p.base64 ?? '')).state;
        if (project.order.length === 0) throw new Error('The project contains no objects, so there is nothing to import (for its materials alone use material.import)');
        scene = projectToScene(project);
      } else {
        if (!ctx.services.importer) throw new Error('The importer is not ready yet');
        scene = await ctx.services.importer.import({ format: p.format, name: p.name, base64: p.base64, text: p.text });
      }
      // Built against the state as it is now, after the (asynchronous) parsing.
      const current = docState(ctx);
      const { state, result } = addImported(current, scene, fallbackName, {
        position: p.position,
        rotation: p.rotation,
        scale: p.scale,
        groupId: p.groupId == null ? null : resolveGroupId(current, p.groupId),
        groupName: p.groupName,
        reuseMaterials: p.reuseMaterials,
      });
      updateDocState(ctx, () => state);
      return result;
    },
  }),

  defineCommand({
    id: 'material.import',
    title: 'Materialien aus Projekt importieren',
    description: `Copy materials from another Tessel project into the active document, together with the textures they use, as ONE undo step. Usually you want the material_import tool instead, which reads the .tessel file from disk. json is the text of a .tessel project file (at most ${MAX_IMPORT_BASE64 / (1024 * 1024)} MB). names limits the copy to the materials with those names: each entry is an exact material name of that project or a glob with * and ? (case-sensitive); an entry that matches nothing is an error that lists the project's material names. Without names all materials of the project are copied. A material the document already has, i.e. same name (a ".001" style suffix is ignored), same colours and values and byte-identical texture images in the same slots, is not copied: the existing one is returned with reused: true. Identical textures are reused the same way. A new material whose name is taken gets a unique name (".001"), so use the returned names and ids. Nothing is assigned to objects; use material.assign. Returns materials and textures as { id, name, reused } and reused: { materials, textures } (counts).`,
    params: z.object({
      json: z.string().min(1).describe('The content of a .tessel project file.'),
      names: z.array(z.string().min(1)).max(1000).optional().describe('Material names of that project to copy (exact, or globs such as "Steel*"). Default: all.'),
    }),
    run(ctx, p) {
      if (p.json.length > MAX_IMPORT_BASE64) throw new Error(`The project text is too large: the limit is ${MAX_IMPORT_BASE64 / (1024 * 1024)} MB`);
      const project = parseProject(p.json).state;
      const { state, result } = addMaterials(docState(ctx), project, p.names);
      updateDocState(ctx, () => state);
      return result;
    },
  }),
];
