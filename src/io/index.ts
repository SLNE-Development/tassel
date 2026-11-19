// The file format services: registered in main.tsx, called by the export.file / import.file commands.
import type { ExportService, ImportService, ImportedScene } from '../core/types';
import { FileError, fromBase64, toBase64 } from './bytes';
import { readGltf } from './gltfRead';
import { writeGlb, writeGltf } from './gltfWrite';
import { browserImageOps, type ImageOps } from './imageOps';
import { fileStem } from './names';
import { parseObj, writeObj } from './obj';
import { collectItems } from './scene';
import { writePly, writeStl } from './stlPly';
import { readFbx, readPly, readStl } from './threeLoaders';
import { writeUsdz } from './usdz';
import { exportJavaModel } from '../core/minecraft/javaExport';

export function createExporter(ops: ImageOps = browserImageOps): ExportService {
  return {
    async export(state, { format, ids, name = 'model' }) {
      const items = collectItems(state, ids);
      switch (format) {
        case 'glb':
          return { base64: toBase64(await writeGlb(state, items, ops)) };
        case 'gltf':
          return { text: await writeGltf(state, items, ops) };
        case 'obj':
          return writeObj(state, items, name);
        case 'stl':
          return { base64: toBase64(writeStl(items)) };
        case 'ply':
          return { base64: toBase64(writePly(items)) };
        case 'usdz':
          return { base64: toBase64(await writeUsdz(state, items)) };
        case 'json':
          return { text: exportJavaModel(state, ids ? { ids } : {}) };
      }
    },
  };
}

export function createImporter(ops: ImageOps = browserImageOps): ImportService {
  return {
    async import({ format, name, base64, text }) {
      const stem = fileStem(name) || 'Import';
      // Loaders throw all kinds of things on malformed files; callers get one clear sentence.
      const guarded = async (read: () => ImportedScene | Promise<ImportedScene>): Promise<ImportedScene> => {
        try {
          return await read();
        } catch (error) {
          if (error instanceof FileError) throw error;
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`The ${format.toUpperCase()} file could not be read (it may be damaged or not a ${format.toUpperCase()} file): ${message}`);
        }
      };
      if (format === 'obj') return guarded(() => parseObj(text ?? new TextDecoder().decode(fromBase64(base64 ?? '')), stem));
      const bytes = base64 !== undefined ? fromBase64(base64) : new TextEncoder().encode(text ?? '');
      if (bytes.length === 0) throw new FileError('The file is empty');
      switch (format) {
        case 'glb':
        case 'gltf':
          return guarded(() => readGltf(bytes, stem, ops));
        case 'stl':
          return guarded(() => readStl(bytes, stem));
        case 'ply':
          return guarded(() => readPly(bytes, stem));
        case 'fbx':
          return guarded(() => readFbx(bytes, stem));
      }
    },
  };
}
