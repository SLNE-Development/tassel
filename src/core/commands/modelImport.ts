// Opening Blockbench projects and converting whole folders of model files.
import { z } from 'zod';
import { importBbmodel } from '../bbmodel';
import { exportJavaModel } from '../minecraft/javaExport';
import { openJavaModelWithParents, parentModes, type ParentMode } from '../minecraft/openModel';
import { joinPath, modelFileKind, relativePath, splitPath, type ModelFileService } from '../modelFiles';
import { serializeProject } from '../project';
import { addDoc, createDoc, uniqueName } from '../state';
import type { DocState, JavaImage } from '../types';
import { defineCommand, type CommandContext } from './registry';

const imageSchema = z.object({ data: z.string().min(1), width: z.number().int().min(1).max(8192), height: z.number().int().min(1).max(8192) });

/** Most files one conversion handles. */
export const MAX_BATCH_FILES = 5000;

function openDoc(ctx: CommandContext, name: string, state: DocState, activate: boolean) {
  const names = Object.values(ctx.get().docs).map((d) => d.name);
  const doc = createDoc(uniqueName(names, name), state);
  ctx.set((app) => {
    const next = addDoc(app, doc);
    return activate ? next : { ...next, activeDocId: app.activeDocId };
  });
  return doc;
}

/** One line per thing a Blockbench import left out, for warnings lists. */
export function bbmodelNotes(report: ReturnType<typeof importBbmodel>['report']): string[] {
  return [...report.dropped.map((d) => `Not imported: ${d.kind} "${d.name}" (${d.reason})`), ...report.warnings];
}

/**
 * Whether parsed JSON looks like a block/item model (and not a blockstate, item definition, language file,
 * sounds.json ...): an object with model keys and none of the other files' keys.
 */
export function looksLikeJavaModel(json: string): boolean {
  try {
    const raw = JSON.parse(json.replace(/^﻿/, '')) as unknown;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
    const keys = Object.keys(raw);
    if (keys.some((k) => k === 'variants' || k === 'multipart' || k === 'model' || k === 'pack')) return false;
    return keys.some((k) => ['parent', 'elements', 'textures', 'display', 'texture_size', 'ambientocclusion', 'gui_light'].includes(k));
  } catch {
    return false;
  }
}

interface Converted {
  state: DocState;
  warnings: string[];
}

async function readModel(service: ModelFileService, path: string, parent: ParentMode): Promise<Converted | { skipped: string }> {
  const { stem } = splitPath(path);
  if (modelFileKind(path) === 'bbmodel') {
    const read = await service.readBbmodel(path);
    const { state, report } = importBbmodel(read.text, { name: stem, images: read.images });
    return { state, warnings: bbmodelNotes(report) };
  }
  const read = await service.readJava(path);
  if (!looksLikeJavaModel(read.json)) return { skipped: 'not a block or item model' };
  const opened = await openJavaModelWithParents(read.json, { fileName: stem, images: read.images, sourcePath: path, parent }, service.source(path));
  return { state: opened.state, warnings: opened.warnings };
}

export const modelImportCommands = [
  defineCommand({
    id: 'document.import_bbmodel',
    title: 'Blockbench-Projekt öffnen',
    description:
      'Open a Blockbench project (.bbmodel JSON text) as a NEW document tab. Usually you want the file_open tool instead, which reads the file from disk. "Java Block/Item" projects become Minecraft Java documents (cubes with per-face UV, rotation, tint and cullface, box UV converted to per-face UV, inflate, shade, light emission, groups with origins, textures with namespace and folder, display, model settings); every other project kind becomes a free document (cubes and meshes as polygon meshes, groups, textures as materials). Animations, locators, null objects and other unsupported elements are left out and listed in "dropped". images: PNGs for textures that are not embedded, by texture index. Returns { id, name, active, format, elements, dropped, warnings }.',
    params: z.object({
      text: z.string().min(1),
      name: z.string().min(1).default('model'),
      images: z.record(z.string(), imageSchema).optional(),
      activate: z.boolean().default(true),
    }),
    run(ctx, p) {
      const images: Record<number, JavaImage> = {};
      for (const [key, image] of Object.entries(p.images ?? {})) if (/^\d+$/.test(key)) images[Number(key)] = image;
      const { state, report } = importBbmodel(p.text, { name: p.name, images });
      const doc = openDoc(ctx, p.name, state, p.activate);
      return {
        id: doc.id,
        name: doc.name,
        active: p.activate,
        format: report.format,
        modelFormat: report.modelFormat,
        formatVersion: report.formatVersion,
        elements: report.elements,
        dropped: report.dropped,
        warnings: report.warnings,
      };
    },
  }),

  defineCommand({
    id: 'document.open_model_file',
    title: 'Modelldatei öffnen',
    description:
      'Open a Minecraft Java model (.json) or Blockbench project (.bbmodel) from disk as a new document tab (the same as file_open for those files). parent: for .json models, what to do with the parent chain ("show" read-only, "merge", or "reference" only). Returns what document_import_java / document_import_bbmodel return.',
    params: z.object({ path: z.string().min(1), parent: z.enum(parentModes).default('show'), activate: z.boolean().default(true) }),
    async run(ctx, p) {
      const service = ctx.services.modelFiles;
      if (!service) throw new Error('Files cannot be read here');
      const kind = modelFileKind(p.path);
      if (!kind) throw new Error(`"${p.path}" is not a .json or .bbmodel file`);
      const { stem } = splitPath(p.path);
      if (kind === 'bbmodel') {
        const read = await service.readBbmodel(p.path);
        const { state, report } = importBbmodel(read.text, { name: stem, images: read.images });
        const doc = openDoc(ctx, stem, state, p.activate);
        return { id: doc.id, name: doc.name, active: p.activate, format: report.format, elements: report.elements, dropped: report.dropped, warnings: report.warnings };
      }
      const read = await service.readJava(p.path);
      const opened = await openJavaModelWithParents(read.json, { fileName: stem, images: read.images, sourcePath: p.path, parent: p.parent }, service.source(p.path));
      const doc = openDoc(ctx, stem, opened.state, p.activate);
      return { id: doc.id, name: doc.name, active: p.activate, format: 'minecraft_java', elements: opened.state.order.length, warnings: opened.warnings, parent: opened.parent };
    },
  }),

  defineCommand({
    id: 'document.convert_models',
    title: 'Modellordner konvertieren',
    description:
      'Convert every Minecraft Java model (.json) and Blockbench project (.bbmodel) in a folder (with subfolders when recursive) without opening them: target "tessel" writes Tessel projects, target "json" writes Minecraft Java model JSON (Blockbench projects that are not Java Block/Item models are skipped). Files go to output (default: next to the source) with the same subfolder structure; existing files are skipped unless overwrite; a source file is never replaced. .json files that are not models (blockstates, item definitions, lang files) are skipped. parent: what Java models do with their parent chain (default "reference"; "merge" makes inherited elements their own). Returns { converted: [{ source, output, warnings }], skipped: [{ source, reason }], failed: [{ source, error }] }.',
    params: z.object({
      folder: z.string().min(1),
      output: z.string().min(1).optional(),
      target: z.enum(['tessel', 'json']).default('tessel'),
      recursive: z.boolean().default(true),
      overwrite: z.boolean().default(false),
      parent: z.enum(parentModes).default('reference'),
    }),
    history: false,
    async run(ctx, p) {
      const service = ctx.services.modelFiles;
      if (!service) throw new Error('Files cannot be read here');
      const files = (await service.list(p.folder, p.recursive)).filter((f) => modelFileKind(f));
      if (files.length > MAX_BATCH_FILES) throw new Error(`The folder has ${files.length} model files; at most ${MAX_BATCH_FILES} are converted at once`);
      const output = p.output ?? p.folder;
      const converted: { source: string; output: string; warnings: string[] }[] = [];
      const skipped: { source: string; reason: string }[] = [];
      const failed: { source: string; error: string }[] = [];
      const sources = new Set(files.map((f) => f.replace(/\\/g, '/').toLowerCase()));
      for (const source of files) {
        try {
          const rel = relativePath(p.folder, source) ?? splitPath(source).stem;
          const relDir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : '';
          const { stem } = splitPath(source);
          const target = joinPath(output, `${relDir}${stem}.${p.target}`);
          if (sources.has(target.replace(/\\/g, '/').toLowerCase())) {
            skipped.push({ source, reason: 'the output would replace a source file; choose another output folder' });
            continue;
          }
          const result = await readModel(service, source, p.parent);
          if ('skipped' in result) {
            skipped.push({ source, reason: result.skipped });
            continue;
          }
          let text: string;
          if (p.target === 'json') {
            if (result.state.format !== 'minecraft_java') {
              skipped.push({ source, reason: 'not a Java Block/Item model, so it cannot be written as Java model JSON' });
              continue;
            }
            text = exportJavaModel(result.state);
          } else {
            text = serializeProject(createDoc(stem, result.state));
          }
          try {
            await service.write(target, text, p.overwrite);
          } catch (error) {
            const message = (error as Error).message ?? String(error);
            if (/exists/i.test(message)) skipped.push({ source, reason: `${target} already exists` });
            else throw error;
            continue;
          }
          converted.push({ source, output: target, warnings: result.warnings });
        } catch (error) {
          failed.push({ source, error: (error as Error).message ?? String(error) });
        }
      }
      return { converted, skipped, failed };
    },
  }),
];
