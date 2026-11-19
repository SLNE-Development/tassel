import { z } from 'zod';
import { parseProject, serializeProject } from '../project';
import { DEFAULT_DOC_NAME, activeDoc, addDoc, createDoc, own, uniqueName, withDoc } from '../state';
import type { AppState, Doc } from '../types';
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

export const documentCommands = [
  defineCommand({
    id: 'document.new',
    title: 'Neues Modell',
    description:
      'Create a new empty document (model) in a new tab. Returns { id, name, active }: id is the document id, to be used as "documentId" of other tools. By default the visible tab switches to it; with activate: false it is created in the background, so that you do not pull the user away from what they are looking at - you can still build in it and take screenshots of it by passing its id as documentId on every call.',
    params: z.object({ name: z.string().min(1).default(DEFAULT_DOC_NAME), activate: activateParam }),
    run(ctx, p) {
      return open(ctx, createDoc(uniqueName(docNames(ctx.get()), p.name)), p.activate);
    },
  }),

  defineCommand({
    id: 'document.list',
    title: 'Dokumente auflisten',
    description: `List all open documents (tabs) in tab order: id, name, filePath (null if never saved), dirty (has unsaved changes), active (the visible tab) and objectCount (the number of scene objects in the document; groups, materials and textures are not counted). Use an id from here as "documentId" of other tools. ${DOCUMENT_ID_HINT}`,
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
    description: 'Mark a document as saved and remember its file path. Called after the project file was written.',
    params: z.object({ id: docIdParam, filePath: z.string().optional(), name: z.string().min(1).optional() }),
    run(ctx, p) {
      const doc = requireDoc(ctx.get(), p.id);
      ctx.set((app) => {
        const current = app.docs[doc.id];
        return withDoc(app, {
          ...current,
          dirty: false,
          filePath: p.filePath ?? current.filePath,
          name: p.name ?? current.name,
        });
      });
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
      const previous = doc.past.at(-1);
      if (!previous) return { undone: false };
      ctx.set((app) =>
        withDoc(app, {
          ...doc,
          state: previous,
          past: doc.past.slice(0, -1),
          future: [doc.state, ...doc.future],
          dirty: true,
        }),
      );
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
      const next = doc.future[0];
      if (!next) return { redone: false };
      ctx.set((app) =>
        withDoc(app, {
          ...doc,
          state: next,
          past: [...doc.past, doc.state],
          future: doc.future.slice(1),
          dirty: true,
        }),
      );
      return { redone: true };
    },
  }),
];
