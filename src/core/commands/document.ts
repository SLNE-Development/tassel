import { z } from 'zod';
import { parseProject, serializeProject } from '../project';
import { DEFAULT_DOC_NAME, activeDoc, addDoc, createDoc, own, uniqueName, withDoc } from '../state';
import type { AppState, Doc } from '../types';
import { defineCommand, type CommandContext } from './registry';

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

function open(ctx: CommandContext, doc: Doc) {
  ctx.set((app) => addDoc(app, doc));
  return { id: doc.id, name: doc.name };
}

const docIdParam = z.string().optional().describe('Document id. Defaults to the active document.');

export const documentCommands = [
  defineCommand({
    id: 'document.new',
    title: 'Neues Modell',
    description: 'Create a new empty document (model) in a new tab and switch to it. Returns the document id.',
    params: z.object({ name: z.string().min(1).default(DEFAULT_DOC_NAME) }),
    run(ctx, p) {
      return open(ctx, createDoc(uniqueName(docNames(ctx.get()), p.name)));
    },
  }),

  defineCommand({
    id: 'document.list',
    title: 'Dokumente auflisten',
    description: 'List all open documents (tabs) and which one is active.',
    params: z.object({}),
    run(ctx) {
      const app = ctx.get();
      return { documents: app.docOrder.map((id) => docSummary(app, app.docs[id])) };
    },
  }),

  defineCommand({
    id: 'document.switch',
    title: 'Dokument wechseln',
    description: 'Switch to another open document tab.',
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
      'Open Tessel project JSON text as a new document tab. Usually you want the file_open tool instead, which reads a file from disk.',
    params: z.object({ json: z.string(), name: z.string().min(1).optional(), filePath: z.string().optional() }),
    run(ctx, p) {
      const project = parseProject(p.json);
      return open(ctx, createDoc(p.name ?? project.name, project.state, p.filePath ?? null));
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
