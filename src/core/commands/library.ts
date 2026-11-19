import { z } from 'zod';
import { base64ImageSize } from '../imageInfo';
import { defaultMaterial, textureDataProblem } from '../materials';
import { withJavaRefs } from '../minecraft/cuboid';
import { MISSING_TEXTURE_PNG } from '../minecraft/javaImport';
import { textureLocation } from '../minecraft/javaExport';
import { resolveMaterialId, resolveObjectIds } from '../refs';
import { newId, own, uniqueName, withDoc } from '../state';
import {
  filterEntries,
  linkLocation,
  linkName,
  parseTextureLocation,
  pendingWrites,
  relinkedFields,
  sameLink,
  syncDecision,
  textureLink,
  validFolder,
  validNamespace,
  type LibraryEntry,
  type TextureLibraryService,
  type TextureLink,
} from '../textureLibrary';
import { cuboidFaces, textureSlots } from '../types';
import type { AppState, CuboidFaceName, Doc, DocState, Texture } from '../types';
import { resolveTextureId } from './cuboid';
import { defineCommand, docState, updateDocState, type CommandContext } from './registry';

// The texture library (core/textureLibrary.ts): browsing, importing and moving library files, and
// documents' textures linked to them. All file access goes through `services.textureLibrary`.

function library(ctx: CommandContext): TextureLibraryService {
  const service = ctx.services.textureLibrary;
  if (!service) throw new Error('The texture library is only available in the desktop app');
  return service;
}

const locationParam = z
  .string()
  .min(1)
  .describe('Resource location "namespace:folder/name" (e.g. "surf_textures:block/rock"); without a namespace the project\'s default namespace, else minecraft, is used.');

/** Parses a location with the project's default namespace. */
async function parseLocation(ctx: CommandContext, text: string): Promise<TextureLink> {
  const hasNamespace = text.includes(':') || /(^|\/)assets\//.test(text);
  const namespace = hasNamespace ? undefined : ((await library(ctx).config().catch(() => null))?.config.textures.defaultNamespace ?? undefined);
  return parseTextureLocation(text, namespace ?? 'minecraft');
}

function entrySummary(entry: LibraryEntry) {
  return {
    location: entry.location,
    source: entry.source,
    sourceKind: entry.sourceKind,
    file: entry.file,
    width: entry.width,
    height: entry.height,
    bytes: entry.size,
    modified: entry.modified,
    readOnly: entry.readOnly,
    ...(entry.animation ? { animation: entry.animation } : {}),
  };
}

/** Size of a PNG from its header, checked against the data. */
function pngSize(data: string): { width: number; height: number } {
  const problem = textureDataProblem('image/png', data);
  if (problem) throw new Error(problem === 'signature' ? 'The image is not a PNG file' : `The image data is ${problem === 'tooLarge' ? 'too large' : problem === 'empty' ? 'empty' : 'not valid base64'}`);
  const size = base64ImageSize(data);
  if (!size) throw new Error('The PNG has no readable size (damaged file?)');
  return size;
}

/**
 * Replaces a texture's image in a document's current state AND in its undo history wherever the
 * texture still had `oldData`, so undo does not bring back pixels the file no longer has. Not an undo
 * step of its own and does not make the document dirty.
 */
function replaceImage(app: AppState, docId: string, textureId: string, oldData: string, image: { data: string; width: number; height: number }): AppState {
  const doc = app.docs[docId];
  const swap = (state: DocState): DocState => {
    const texture = own(state.textures, textureId);
    if (!texture || texture.data !== oldData) return state;
    const { layers: _dropped, ...rest } = texture;
    return { ...state, textures: { ...state.textures, [textureId]: { ...rest, ...image } } };
  };
  return withDoc(app, { ...doc, state: swap(doc.state), past: doc.past.map(swap), future: doc.future.map(swap) });
}

export interface SyncReport {
  updated: { documentId: string; textureId: string; location: string }[];
  missing: { documentId: string; textureId: string; location: string }[];
  conflicts: { documentId: string; textureId: string; location: string }[];
  /** Linked textures with pixel changes not yet written to their file. */
  unsaved: { documentId: string; textureId: string; location: string }[];
}

/** Brings linked textures of open documents up to date with their library files. */
export async function syncLinkedTextures(ctx: CommandContext, opts: { documentIds?: readonly string[]; locations?: readonly string[]; rescan?: boolean } = {}): Promise<SyncReport> {
  const lib = library(ctx);
  if (opts.rescan !== false) await lib.entries({ refresh: true });
  const report: SyncReport = { updated: [], missing: [], conflicts: [], unsaved: [] };
  const wanted = opts.locations ? new Set(opts.locations) : null;
  const files = new Map<string, Promise<{ data: string; width: number; height: number; readOnly: boolean } | null>>();
  const baselines = new Map<string, string | undefined>();
  const docs = Object.values(ctx.get().docs).filter((d) => !opts.documentIds || opts.documentIds.includes(d.id));
  for (const doc of docs) {
    for (const texture of Object.values(doc.state.textures)) {
      if (!texture.link) continue;
      const location = linkLocation(texture.link);
      if (wanted && !wanted.has(location)) continue;
      if (!files.has(location)) {
        baselines.set(location, lib.baseline(location));
        const link = texture.link;
        files.set(
          location,
          lib.read(link).then((file) => {
            if (!file) return null;
            const size = base64ImageSize(file.data) ?? { width: file.entry.width, height: file.entry.height };
            return { data: file.data, ...size, readOnly: file.entry.readOnly };
          }),
        );
      }
      const file = await files.get(location)!;
      const item = { documentId: doc.id, textureId: texture.id, location };
      if (!file) {
        report.missing.push(item);
        continue;
      }
      // Re-read: an earlier await may have let another change in.
      const current = own(ctx.get().docs[doc.id]?.state.textures ?? {}, texture.id);
      if (!current || !sameLink(current.link, texture.link)) continue;
      let decision = syncDecision(current.data, file.data, baselines.get(location));
      // Pixels painted onto a read-only (vanilla) texture cannot be saved there: never replace them silently.
      if (decision === 'update' && file.readOnly && baselines.get(location) === undefined) decision = 'local';
      if (decision === 'update') {
        const image = { data: file.data, width: file.width, height: file.height };
        ctx.set((app) => replaceImage(app, doc.id, texture.id, current.data, image));
        report.updated.push(item);
      } else if (decision === 'conflict') report.conflicts.push(item);
      else if (decision === 'local') report.unsaved.push(item);
    }
  }
  return report;
}

/** Writes the linked textures of a document whose pixels changed back into their library files. */
export async function writeLinkedTextures(
  ctx: CommandContext,
  doc: Doc,
  only?: string,
): Promise<{ written: { textureId: string; location: string; file: string }[]; failed: { textureId: string; location: string; error: string }[] }> {
  const lib = library(ctx);
  const written: { textureId: string; location: string; file: string }[] = [];
  const failed: { textureId: string; location: string; error: string }[] = [];
  const candidates = only ? [doc.state.textures[only]].filter(Boolean) : pendingWrites(doc.state.textures, (l) => lib.baseline(l));
  for (const texture of candidates) {
    if (!texture.link) continue;
    const location = linkLocation(texture.link);
    try {
      if (texture.mimeType !== 'image/png') throw new Error('Only PNG textures can be written to the library');
      const before = lib.baseline(location);
      const entry = await lib.write(texture.link, texture.data);
      written.push({ textureId: texture.id, location, file: entry.file });
      // Other open textures linked to the same file that showed it unchanged now show the new pixels,
      // so that saving them later does not write the old image back.
      if (before !== undefined) {
        const image = { data: texture.data, width: texture.width, height: texture.height };
        ctx.set((app) => {
          let next = app;
          for (const other of Object.values(app.docs)) {
            for (const t of Object.values(other.state.textures)) {
              if (sameLink(t.link, texture.link) && t.data === before && !(other.id === doc.id && t.id === texture.id)) next = replaceImage(next, other.id, t.id, before, image);
            }
          }
          return next;
        });
      }
    } catch (error) {
      failed.push({ textureId: texture.id, location, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { written, failed };
}

/** A new texture linked to a library file (with a Java location in Minecraft documents). */
function addLinkedTexture(state: DocState, link: TextureLink, image: { data: string; width: number; height: number }): { state: DocState; id: string } {
  const id = newId();
  const minecraft = state.format === 'minecraft_java';
  const names = Object.values(state.textures).map((t) => t.name);
  const texture: Texture = {
    id,
    name: minecraft ? linkName(link) : uniqueName(names, linkName(link)),
    mimeType: 'image/png',
    ...image,
    link,
  };
  let textures: DocState['textures'] = { ...state.textures, [id]: texture };
  if (minecraft) {
    textures = withJavaRefs(textures);
    textures = { ...textures, [id]: relinkedFields(textures[id], link) };
  }
  return { state: { ...state, textures }, id };
}

const facesParam = z.array(z.enum(cuboidFaces)).optional().describe('Cuboid faces to assign (default: every enabled face).');

export const libraryCommands = [
  defineCommand({
    id: 'library.sources',
    title: 'Texturbibliotheken',
    description:
      'The texture library sources in search order: the open project\'s resource pack (assets/<namespace>/textures/**), extra library folders, and the read-only vanilla textures; plus the project\'s texture config (defaultNamespace, defaultFolder from tessel.project.json). A linked texture resolves to the first source that has its file.',
    params: z.object({}),
    history: false,
    async run(ctx) {
      const lib = library(ctx);
      const [sources, config] = await Promise.all([lib.sources(), lib.config()]);
      return { sources, project: config.project, config: config.config };
    },
  }),

  defineCommand({
    id: 'library.list',
    title: 'Bibliothekstexturen auflisten',
    description:
      'List texture library files: location ("namespace:folder/name"), source, file, width, height, bytes, animation (frames, frametime from the .png.mcmeta) and readOnly. Filter by source id, namespace, folder (and below) and search (words that must all appear in the location). refresh: rescan the folders first. Paged with offset/limit; total is the number of matches.',
    params: z.object({
      source: z.string().optional(),
      namespace: z.string().optional(),
      folder: z.string().optional(),
      search: z.string().optional(),
      refresh: z.boolean().default(false),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(1000).default(200),
    }),
    history: false,
    async run(ctx, p) {
      const all = await library(ctx).entries({ refresh: p.refresh });
      const matches = filterEntries(all, p);
      return { total: matches.length, entries: matches.slice(p.offset, p.offset + p.limit).map(entrySummary) };
    },
  }),

  defineCommand({
    id: 'library.get_config',
    title: 'Projekt-Texturkonfiguration',
    description: `The open project's texture config (tessel.project.json at the project root, shared through git): defaultNamespace (e.g. "surf_textures") and defaultFolder (e.g. "block") for new library textures. project is null without an open project.`,
    params: z.object({}),
    history: false,
    async run(ctx) {
      return library(ctx).config();
    },
  }),

  defineCommand({
    id: 'library.set_config',
    title: 'Standard-Namespace setzen',
    description:
      'Change the open project\'s texture config in tessel.project.json (other keys of the file are kept): defaultNamespace ([a-z0-9_.-], null = none) and defaultFolder (e.g. "block", "" = directly under textures/). Locations given without a namespace then use defaultNamespace.',
    params: z.object({ defaultNamespace: z.string().nullable().optional(), defaultFolder: z.string().optional() }),
    history: false,
    async run(ctx, p) {
      const lib = library(ctx);
      const { project, config } = await lib.config();
      if (!project) throw new Error('No project is open: open or add a project in the Projects panel first');
      if (p.defaultNamespace && !validNamespace(p.defaultNamespace)) throw new Error(`"${p.defaultNamespace}" is not a valid namespace (only a-z, 0-9, _ . -)`);
      const folder = p.defaultFolder?.replace(/^\/+|\/+$/g, '');
      if (folder !== undefined && !validFolder(folder)) throw new Error(`"${p.defaultFolder}" is not a valid folder (only a-z, 0-9, _ . - /)`);
      const next = {
        textures: {
          defaultNamespace: p.defaultNamespace === undefined ? config.textures.defaultNamespace : p.defaultNamespace || null,
          defaultFolder: folder ?? config.textures.defaultFolder,
        },
      };
      await lib.setConfig(next);
      return { project, config: next };
    },
  }),

  defineCommand({
    id: 'library.add_folder',
    title: 'Bibliotheksordner hinzufügen',
    description: 'Add an extra texture library folder (an absolute path to a resource pack folder that has assets/<namespace>/textures, or to an assets folder). It is searched after the project and before vanilla.',
    params: z.object({ path: z.string().min(1), name: z.string().optional() }),
    history: false,
    async run(ctx, p) {
      const source = await library(ctx).addFolder(p.path, p.name);
      return { source };
    },
  }),

  defineCommand({
    id: 'library.remove_folder',
    title: 'Bibliotheksordner entfernen',
    description: 'Forget an extra texture library folder (by source id "folder:<id>"); its files stay on disk.',
    params: z.object({ id: z.string().min(1) }),
    history: false,
    async run(ctx, p) {
      await library(ctx).removeFolder(p.id);
      return { removed: p.id };
    },
  }),

  defineCommand({
    id: 'library.import',
    title: 'In Bibliothek importieren',
    description:
      'Write a PNG into the texture library as assets/<namespace>/textures/<folder>/<name>.png (default: the open project, its default namespace and folder). data: the PNG as base64 without a data: prefix; mcmeta: optional .png.mcmeta text for an animation. Refuses to overwrite an existing file unless overwrite is true. With link: a texture id of the active document, that texture is linked to the new file. Returns the entry.',
    params: z.object({
      name: z.string().min(1).describe('File name without .png, e.g. "rock" (lower-cased).'),
      data: z.string().min(1),
      namespace: z.string().optional(),
      folder: z.string().optional(),
      mcmeta: z.string().optional(),
      source: z.string().optional().describe('Writable source id (default: the project).'),
      overwrite: z.boolean().default(false),
      link: z.string().optional(),
    }),
    history: false,
    async run(ctx, p) {
      const lib = library(ctx);
      pngSize(p.data);
      const { config } = await lib.config();
      const namespace = p.namespace ?? config.textures.defaultNamespace ?? 'minecraft';
      const folder = p.folder ?? config.textures.defaultFolder;
      const name = p.name.replace(/\.png$/i, '').trim().toLowerCase().replace(/\s+/g, '_');
      const link = parseTextureLocation(`${namespace}:${folder ? `${folder.replace(/^\/+|\/+$/g, '')}/` : ''}${name}`);
      if (!p.overwrite) {
        const existing = (await lib.entries()).find((e) => e.location === linkLocation(link) && (!p.source || e.source === p.source) && !e.readOnly);
        if (existing) throw new Error(`The library already has ${linkLocation(link)} (${existing.file}); pass overwrite: true to replace it`);
      }
      const entry = await lib.write(link, p.data, { source: p.source, mcmeta: p.mcmeta });
      if (p.link) {
        const id = resolveTextureId(docState(ctx), p.link);
        await linkTexture(ctx, id, link, entry.source, true);
      }
      return { entry: entrySummary(entry) };
    },
  }),

  defineCommand({
    id: 'library.move',
    title: 'Bibliothekstextur verschieben',
    description:
      'Rename or move a texture file inside its library source (its .png.mcmeta moves along). Open documents that link to it are relinked (an undo step in each), and with rewrite (default true) the project\'s model JSON files (assets/*/models/**) and .tessel files that refer to it are updated on disk too. Returns the new entry and the rewritten files.',
    params: z.object({ from: locationParam, to: locationParam, rewrite: z.boolean().default(true) }),
    async run(ctx, p) {
      const lib = library(ctx);
      const from = await parseLocation(ctx, p.from);
      const to = await parseLocation(ctx, p.to);
      if (sameLink(from, to)) throw new Error('The new location is the same as the old one');
      const result = await lib.move(from, to, { rewrite: p.rewrite });
      let relinked = 0;
      ctx.set((app) => {
        let next = app;
        for (const doc of Object.values(app.docs)) {
          const moved = Object.values(doc.state.textures).filter((t) => sameLink(t.link, from));
          if (moved.length === 0) continue;
          const textures = { ...doc.state.textures };
          for (const t of moved) textures[t.id] = relinkedFields(t, to);
          relinked += moved.length;
          next = withDoc(next, { ...doc, state: { ...doc.state, textures } });
        }
        return next;
      });
      return { entry: entrySummary(result.entry), relinkedTextures: relinked, rewrittenFiles: result.rewritten };
    },
  }),

  defineCommand({
    id: 'library.reveal',
    title: 'Im Explorer zeigen',
    description: 'Show a library texture file in the system file manager.',
    params: z.object({ location: locationParam, source: z.string().optional() }),
    history: false,
    async run(ctx, p) {
      await library(ctx).reveal(await parseLocation(ctx, p.location), { source: p.source });
      return { ok: true };
    },
  }),

  defineCommand({
    id: 'library.refresh',
    title: 'Bibliothek aktualisieren',
    description:
      'Rescan the texture library and bring linked textures of all open documents up to date with their files (not an undo step). A texture whose pixels were changed in Tessel and not yet saved keeps them (unsaved); if its file changed too it is reported as a conflict (saving overwrites the file). Returns { updated, missing, conflicts, unsaved }.',
    params: z.object({ locations: z.array(z.string()).optional(), documentIds: z.array(z.string()).optional() }),
    history: false,
    async run(ctx, p) {
      return syncLinkedTextures(ctx, { locations: p.locations, documentIds: p.documentIds });
    },
  }),

  defineCommand({
    id: 'library.save_texture',
    title: 'Textur in Bibliothek speichern',
    description:
      'Write a linked texture of the active document (as it is now, e.g. after painting) back into its library PNG. Saving the document does this automatically for every linked texture with changed pixels. Vanilla textures are read-only: import a copy into the project instead (library_import with link).',
    params: z.object({ id: z.string().describe('Texture id or name') }),
    history: false,
    async run(ctx, p) {
      const doc = ctx.get().docs[ctx.get().activeDocId];
      const id = resolveTextureId(doc.state, p.id);
      if (!doc.state.textures[id].link) throw new Error(`Texture "${doc.state.textures[id].name}" is not linked to the library`);
      const result = await writeLinkedTextures(ctx, doc, id);
      if (result.failed.length > 0) throw new Error(result.failed[0].error);
      return result.written[0];
    },
  }),

  defineCommand({
    id: 'library.save_textures',
    title: 'Geänderte Bibliothekstexturen speichern',
    description: 'Write every linked texture of the active document whose pixels changed back into its library PNG. Returns { written, failed }.',
    params: z.object({}),
    history: false,
    async run(ctx) {
      return writeLinkedTextures(ctx, ctx.get().docs[ctx.get().activeDocId]);
    },
  }),

  defineCommand({
    id: 'library.link_all',
    title: 'Texturen mit Bibliothek verknüpfen',
    description:
      'Link every texture of the active Minecraft document that has a resource location but no link to the library file at that location, loading its image from there. Textures whose file is not in the library are linked too when they only hold the missing-texture placeholder (they then show as missing with a locate action). Returns { linked, missing }.',
    params: z.object({}),
    formats: ['minecraft_java'],
    async run(ctx) {
      const lib = library(ctx);
      const entries = await lib.entries();
      const linked: string[] = [];
      const missing: string[] = [];
      for (const texture of Object.values(docState(ctx).textures)) {
        if (texture.link) continue;
        const link = textureLink(texture);
        if (!link) continue;
        const found = entries.some((e) => e.location === linkLocation(link));
        if (found) {
          await linkTexture(ctx, texture.id, link, undefined, false);
          linked.push(texture.id);
        } else if (texture.data === MISSING_TEXTURE_PNG) {
          updateDocState(ctx, (s) => ({ ...s, textures: { ...s.textures, [texture.id]: { ...s.textures[texture.id], link } } }));
          missing.push(texture.id);
        }
      }
      return { linked, missing };
    },
  }),

  defineCommand({
    id: 'texture.link',
    title: 'Textur verknüpfen',
    description:
      'Link a texture of the active document to a texture library file by resource location (also "relink" / "locate" for a missing one): its image is loaded from the file, it updates when the file changes, saving writes painted changes back, and a Minecraft model exports it by that location (name, namespace and folder follow). Paint layers are dropped.',
    params: z.object({ id: z.string().describe('Texture id or name'), location: locationParam, source: z.string().optional() }),
    async run(ctx, p) {
      const id = resolveTextureId(docState(ctx), p.id);
      const link = await parseLocation(ctx, p.location);
      await linkTexture(ctx, id, link, p.source, true);
      const texture = docState(ctx).textures[id];
      return { id, name: texture.name, location: linkLocation(link), width: texture.width, height: texture.height };
    },
  }),

  defineCommand({
    id: 'texture.unlink',
    title: 'Verknüpfung lösen',
    description: 'Unlink a texture from its library file: the image as it is now stays embedded in the document and no longer follows the file. In Minecraft documents its resource location stays as it is.',
    params: z.object({ id: z.string().describe('Texture id or name') }),
    run(ctx, p) {
      const id = resolveTextureId(docState(ctx), p.id);
      const texture = docState(ctx).textures[id];
      if (!texture.link) throw new Error(`Texture "${texture.name}" is not linked`);
      updateDocState(ctx, (s) => {
        const { link: _link, ...rest } = s.textures[id];
        return { ...s, textures: { ...s.textures, [id]: rest } };
      });
      return { id, embedded: true, location: textureLocation(docState(ctx).textures[id]) };
    },
  }),

  defineCommand({
    id: 'texture.add_from_library',
    title: 'Bibliothekstextur hinzufügen',
    description:
      'Add a texture library file to the active document as a LINKED texture (an existing texture linked to the same location is reused) and optionally assign it. Minecraft documents: objects = cuboid elements whose faces get it (faces, default every enabled face). Free documents: objects get it in their material\'s slot (default baseColor; objects without a material get a new one), or give materialId. Returns { id, name, location, reused }.',
    params: z.object({
      location: locationParam,
      source: z.string().optional(),
      objects: z.array(z.string()).optional().describe('Object ids or names to assign the texture to.'),
      faces: facesParam,
      materialId: z.string().optional().describe('Free documents: material id or name whose slot gets the texture.'),
      slot: z.enum(textureSlots).default('baseColor'),
    }),
    async run(ctx, p) {
      const lib = library(ctx);
      const link = await parseLocation(ctx, p.location);
      let id = Object.values(docState(ctx).textures).find((t) => sameLink(t.link, link))?.id;
      const reused = !!id;
      if (!id) {
        const file = await lib.read(link, { source: p.source });
        if (!file) throw new Error(`The texture library has no ${linkLocation(link)} (see library_list)`);
        const size = pngSize(file.data);
        let added = '';
        updateDocState(ctx, (s) => {
          const result = addLinkedTexture(s, link, { data: file.data, ...size });
          added = result.id;
          return result.state;
        });
        id = added;
      }
      const textureId = id;
      if (p.objects || p.materialId) assignTexture(ctx, textureId, p.objects, p.faces, p.materialId, p.slot);
      const texture = docState(ctx).textures[textureId];
      return { id: textureId, name: texture.name, location: linkLocation(link), reused };
    },
  }),
];

/** Links a texture to a library file and loads its image. */
async function linkTexture(ctx: CommandContext, id: string, link: TextureLink, source: string | undefined, required: boolean): Promise<void> {
  const file = await library(ctx).read(link, { source });
  if (!file) {
    if (required) throw new Error(`The texture library has no ${linkLocation(link)} (see library_list)`);
    return;
  }
  const size = pngSize(file.data);
  updateDocState(ctx, (s) => {
    const texture = own(s.textures, id);
    if (!texture) return s;
    const { layers: _layers, ...rest } = texture;
    return { ...s, textures: { ...s.textures, [id]: relinkedFields({ ...rest, mimeType: 'image/png', data: file.data, ...size }, link) } };
  });
}

function assignTexture(ctx: CommandContext, textureId: string, objects: readonly string[] | undefined, faces: readonly CuboidFaceName[] | undefined, materialId: string | undefined, slot: (typeof textureSlots)[number]): void {
  const state = docState(ctx);
  if (state.format === 'minecraft_java') {
    if (!objects) return;
    const ids = resolveObjectIds(state, objects);
    updateDocState(ctx, (s) => {
      const nextObjects = { ...s.objects };
      for (const objectId of ids) {
        const cuboid = s.objects[objectId]?.cuboid;
        if (!cuboid) continue;
        const nextFaces = { ...cuboid.faces };
        for (const face of faces ?? cuboidFaces.filter((f) => cuboid.faces[f].enabled)) nextFaces[face] = { ...nextFaces[face], texture: textureId };
        nextObjects[objectId] = { ...s.objects[objectId], cuboid: { ...cuboid, faces: nextFaces } };
      }
      if (!s.java || s.java.particle !== null) return { ...s, objects: nextObjects };
      // The first texture of a model is also its particle, as Minecraft needs one.
      return { ...s, objects: nextObjects, java: { ...s.java, particle: textureId } };
    });
    return;
  }
  if (materialId !== undefined) {
    const mid = resolveMaterialId(state, materialId);
    updateDocState(ctx, (s) => ({ ...s, materials: { ...s.materials, [mid]: { ...s.materials[mid], maps: { ...s.materials[mid].maps, [slot]: textureId } } } }));
  }
  if (!objects) return;
  const ids = resolveObjectIds(state, objects);
  updateDocState(ctx, (s) => {
    const materials = { ...s.materials };
    const nextObjects = { ...s.objects };
    const created = new Map<string, string>();
    for (const objectId of ids) {
      const obj = s.objects[objectId];
      const existing = obj.materialId && own(materials, obj.materialId);
      if (existing) {
        materials[existing.id] = { ...existing, maps: { ...existing.maps, [slot]: textureId } };
        continue;
      }
      // Objects without a material share one new material per texture.
      let mid = created.get(textureId);
      if (!mid) {
        mid = newId();
        const name = uniqueName(Object.values(materials).map((m) => m.name), s.textures[textureId].name);
        materials[mid] = { ...defaultMaterial, id: mid, name, maps: { [slot]: textureId } };
        created.set(textureId, mid);
      }
      nextObjects[objectId] = { ...obj, materialId: mid };
    }
    return { ...s, materials, objects: nextObjects };
  });
}
