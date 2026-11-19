import { z } from 'zod';
import { parseProject, serializeProject } from '../project';
import { writeLinkedTextures } from './library';
import { docFormat } from '../formats';
import { currentHistoryIndex, englishHistoryLabel, gotoHistory, historyEntries } from '../history';
import { defaultJavaSettings, textureSizeSchema } from '../minecraft/schema';
import { applyFactoryTemplate, factoryTemplates } from '../minecraft/factory/templates';
import { isJavaVersion, javaVersions } from '../minecraft/versions';
import { itemDocState, newItemSettings } from '../minecraft/items/document';
import { singleModelDefinition } from '../minecraft/items/templates';
import { DEFAULT_DOC_NAME, activeDoc, addDoc, createDoc, emptyDocState, own, uniqueName, withDoc } from '../state';
import { docFormats } from '../types';
import type { AppState, Doc, DocState } from '../types';
import { defineCommand, type CommandContext } from './registry';
import { DOCUMENT_ID_HINT } from './targeting';

function requireDoc(app: AppState, id: string | undefined): Doc {
  const doc = own(app.docs, id ?? app.activeDocId);
  if (!doc) throw new Error(`Document "${id}" does not exist`);
  return doc;
}

function docNames(app: AppState): string[] {
  return Object.values(app.docs).map((d) => d.name);
}

function docSummary(app: AppState, doc: Doc) {
  return {
    id: doc.id,
    name: doc.name,
    filePath: doc.filePath,
    dirty: doc.dirty,
    active: doc.id === app.activeDocId,
    format: docFormat(doc.state),
    objectCount: doc.state.order.length,
  };
}

/** Adds the document as a new tab; `activate: false` leaves the visible tab as it is. */
function open(ctx: CommandContext, doc: Doc, activate: boolean) {
  ctx.set((app) => {
    const next = addDoc(app, doc);
    return activate ? next : { ...next, activeDocId: app.activeDocId };
  });
  return { id: doc.id, name: doc.name, active: activate };
}

const activateParam = z
  .boolean()
  .default(true)
  .describe(
    'true: switch the visible tab to the new document. false: add it as a tab in the background and leave the user where they are - then pass the returned id as "documentId" to every tool that should work in it.',
  );

const docIdParam = z.string().optional().describe('Document id. Defaults to the active document.');

/** A Minecraft resource name from a document name: lower case, [a-z0-9._-], spaces as underscores. */
export function modelFileName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9._-]/g, '');
  return cleaned || 'model';
}

export const documentCommands = [
  defineCommand({
    id: 'document.new',
    title: 'Neues Modell',
    description:
      'Create a new empty document (model) in a new tab, as a free 3D model or (format) a Minecraft Java block/item model or a factory model (a Minecraft Java model plus ports and machine data for a server plugin; template starts it from a common machine). Returns { id, name, active, format }: id is the document id, to be used as "documentId" of other tools. By default the visible tab switches to it; with activate: false it is created in the background, so that you do not pull the user away from what they are looking at - you can still build in it and take screenshots of it by passing its id as documentId on every call.',
    params: z.object({
      name: z.string().min(1).default(DEFAULT_DOC_NAME),
      activate: activateParam,
      format: z
        .enum(docFormats)
        .default('free')
        .describe(
          'Kind of document. "free": a general 3D model (meshes, modifiers, materials, animation) - the default. "minecraft_java": a Minecraft Java block/item model made of cuboid elements (cuboid_* and minecraft_* tools; exported as model .json). "minecraft_item": a Minecraft item model definition (items/<id>.json; item_* tools; document_new_item sets its id and model directly). "minecraft_factory": a Minecraft Java model plus a machine definition with ports for a server plugin (also factory_* tools; exported as model .json plus <fileName>.factory.json). The format cannot be changed later.',
        ),
      fileName: z.string().min(1).optional().describe('minecraft_java only: model file name without .json. Default: the document name in lower case.'),
      parent: z.string().default('').describe('minecraft_java only: parent model, e.g. "block/block" or "item/generated". Default: none.'),
      ambientOcclusion: z.boolean().default(true).describe('minecraft_java only.'),
      textureSize: textureSizeSchema.default([16, 16]).describe('minecraft_java only: UV size [width, height] in pixels (texture_size).'),
      version: z
        .string()
        .default(javaVersions[javaVersions.length - 1].id)
        .describe(`minecraft_java only: target Minecraft Java version, one of ${javaVersions.map((v) => v.id).join(', ')}.`),
      template: z
        .enum(factoryTemplates)
        .default('empty')
        .describe('minecraft_factory only: "empty", "machine" (one block, item input west and output east), "conveyor" (belt segment carrying items north) or "pipe_junction" (six-way fluid junction).'),
      machineId: z.string().min(1).optional().describe('minecraft_factory only: namespaced machine id. Default: "factory:<fileName>".'),
    }),
    run(ctx, p) {
      const name = uniqueName(docNames(ctx.get()), p.name);
      if (p.format === 'free') return { ...open(ctx, createDoc(name), p.activate), format: p.format };
      if (p.format === 'minecraft_item') {
        // An item definition that shows no model yet; document.new_item takes the item's id and model directly.
        const item = newItemSettings(singleModelDefinition(''), { id: modelFileName(name), version: p.version });
        return { ...open(ctx, createDoc(name, itemDocState(item)), p.activate), format: p.format };
      }
      if (!isJavaVersion(p.version)) throw new Error(`Unknown Minecraft Java version "${p.version}". Known: ${javaVersions.map((v) => v.id).join(', ')}`);
      const java = defaultJavaSettings({
        version: p.version,
        fileName: p.fileName ?? modelFileName(name),
        parent: p.parent,
        ambientOcclusion: p.ambientOcclusion,
        textureSize: p.textureSize,
      });
      let state: DocState = { ...emptyDocState, format: p.format, java };
      if (p.format === 'minecraft_factory') {
        state = applyFactoryTemplate(state, p.template, { fileName: java.fileName, displayName: name });
        if (p.machineId) state = { ...state, factory: { ...state.factory!, id: p.machineId } };
      }
      return { ...open(ctx, createDoc(name, state), p.activate), format: p.format };
    },
  }),

  defineCommand({
    id: 'document.list',
    title: 'Dokumente auflisten',
    description: `List all open documents (tabs) in tab order: id, name, filePath (null if never saved), dirty (has unsaved changes), active (the visible tab), format ("free", "minecraft_java", "minecraft_item" or "minecraft_factory": which tools work in it, see the tool descriptions) and objectCount (the number of scene objects in the document; groups, materials and textures are not counted). Use an id from here as "documentId" of other tools. ${DOCUMENT_ID_HINT}`,
    params: z.object({}),
    run(ctx) {
      const app = ctx.get();
      return { documents: app.docOrder.map((id) => docSummary(app, app.docs[id])) };
    },
  }),

  defineCommand({
    id: 'document.switch',
    title: 'Dokument wechseln',
    description:
      'Switch the visible tab to another open document. This changes what the user is looking at; to work in a document without that, leave the tab alone and pass its id as "documentId" to the other tools.',
    params: z.object({ id: z.string() }),
    run(ctx, p) {
      const doc = requireDoc(ctx.get(), p.id);
      ctx.set((app) => ({ ...app, activeDocId: doc.id }));
      return { id: doc.id, name: doc.name };
    },
  }),

  defineCommand({
    id: 'document.close',
    title: 'Dokument schließen',
    description:
      'Close a document tab. Unsaved changes are discarded, so save first if they matter. Closing the last tab opens a new empty document.',
    params: z.object({ id: docIdParam }),
    run(ctx, p) {
      const doc = requireDoc(ctx.get(), p.id);
      ctx.set((app) => {
        const docs = { ...app.docs };
        delete docs[doc.id];
        const index = app.docOrder.indexOf(doc.id);
        const docOrder = app.docOrder.filter((id) => id !== doc.id);
        if (docOrder.length === 0) return addDoc({ ...app, docs, docOrder }, createDoc(DEFAULT_DOC_NAME));
        const activeDocId =
          app.activeDocId === doc.id ? docOrder[Math.min(index, docOrder.length - 1)] : app.activeDocId;
        return { ...app, docs, docOrder, activeDocId };
      });
      return { closed: doc.id, activeDocId: ctx.get().activeDocId };
    },
  }),

  defineCommand({
    id: 'document.rename',
    title: 'Dokument umbenennen',
    description: 'Rename a document.',
    params: z.object({ id: docIdParam, name: z.string().min(1) }),
    run(ctx, p) {
      const doc = requireDoc(ctx.get(), p.id);
      ctx.set((app) => withDoc(app, { ...app.docs[doc.id], name: p.name, dirty: true }));
      return { id: doc.id, name: p.name };
    },
  }),

  defineCommand({
    id: 'document.serialize',
    title: 'Dokument serialisieren',
    description:
      'Return a document as Tessel project JSON text. Usually you want the file_save tool instead, which writes it to disk.',
    params: z.object({ id: docIdParam }),
    run(ctx, p) {
      const doc = requireDoc(ctx.get(), p.id);
      return { id: doc.id, name: doc.name, filePath: doc.filePath, json: serializeProject(doc) };
    },
  }),

  defineCommand({
    id: 'document.load',
    title: 'Dokument laden',
    description:
      'Open Tessel project JSON text as a new document tab. Usually you want the file_open tool instead, which reads a file from disk. Returns { id, name, active }; with activate: false the tab opens in the background and the visible tab stays (use the id as "documentId").',
    params: z.object({ json: z.string(), name: z.string().min(1).optional(), filePath: z.string().optional(), activate: activateParam }),
    run(ctx, p) {
      const project = parseProject(p.json);
      return open(ctx, createDoc(p.name ?? project.name, project.state, p.filePath ?? null), p.activate);
    },
  }),

  defineCommand({
    id: 'document.mark_saved',
    title: 'Als gespeichert markieren',
    description:
      'Mark a document as saved and remember its file path. Called after the project file was written. Linked textures whose pixels changed are written back into their texture library files; the result lists them under library { written, failed }.',
    params: z.object({ id: docIdParam, filePath: z.string().optional(), name: z.string().min(1).optional() }),
    async run(ctx, p) {
      const doc = requireDoc(ctx.get(), p.id);
      // Saving a document also saves the library files of its linked textures (e.g. after painting).
      const library = ctx.services.textureLibrary ? await writeLinkedTextures(ctx, doc) : null;
      ctx.set((app) => {
        const current = app.docs[doc.id];
        return withDoc(app, {
          ...current,
          dirty: false,
          filePath: p.filePath ?? current.filePath,
          name: p.name ?? current.name,
        });
      });
      return library && (library.written.length > 0 || library.failed.length > 0) ? { ok: true, library } : { ok: true };
    },
  }),

  defineCommand({
    id: 'history.undo',
    title: 'Rückgängig',
    description: 'Undo the last change of the active document.',
    params: z.object({}),
    history: false,
    run(ctx) {
      const doc = activeDoc(ctx.get());
      if (doc.past.length === 0) return { undone: false };
      ctx.set((app) => withDoc(app, gotoHistory(doc, doc.past.length - 1)));
      return { undone: true };
    },
  }),

  defineCommand({
    id: 'history.redo',
    title: 'Wiederholen',
    description: 'Redo the last undone change of the active document.',
    params: z.object({}),
    history: false,
    run(ctx) {
      const doc = activeDoc(ctx.get());
      if (doc.future.length === 0) return { redone: false };
      ctx.set((app) => withDoc(app, gotoHistory(doc, doc.past.length + 1)));
      return { redone: true };
    },
  }),

  defineCommand({
    id: 'history.list',
    title: 'Verlauf auflisten',
    description:
      'List the undo history of the active document, oldest first: index 0 is the document as it was created or opened (or the oldest step still kept), then one entry per change. ' +
      'Each entry has its index, a label (the command and, where there is one, the object it changed), the command id, the time and whether it is the current state; entries after the current one are undone and are dropped by the next change. Use history_goto to jump to an entry.',
    params: z.object({}),
    history: false,
    run(ctx) {
      const doc = activeDoc(ctx.get());
      return {
        documentId: doc.id,
        current: currentHistoryIndex(doc),
        entries: historyEntries(doc).map((entry) => ({
          index: entry.index,
          label: englishHistoryLabel(entry.step),
          command: entry.step.command,
          ...(entry.step.detail === undefined ? {} : { detail: entry.step.detail }),
          time: new Date(entry.step.time).toISOString(),
          current: entry.current,
          undone: entry.undone,
        })),
      };
    },
  }),

  defineCommand({
    id: 'history.goto',
    title: 'Zu Verlaufsschritt springen',
    description:
      "Jump to an entry of the active document's undo history (index from history_list): undoes or redoes as many steps as needed in one go. The entries after it stay redoable until the next change.",
    params: z.object({ index: z.number().int().min(0).describe('Index of the history entry (history_list).') }),
    history: false,
    run(ctx, p) {
      const doc = activeDoc(ctx.get());
      const from = currentHistoryIndex(doc);
      const moved = gotoHistory(doc, p.index);
      if (moved !== doc) ctx.set((app) => withDoc(app, moved));
      return { index: p.index, previous: from, undone: Math.max(0, from - p.index), redone: Math.max(0, p.index - from) };
    },
  }),
];
