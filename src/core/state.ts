import { defaultPreferences } from './preferences';
import type { AppState, Doc, DocState } from './types';

export function newId(): string {
  return crypto.randomUUID().slice(0, 8);
}

export const emptyDocState: DocState = { objects: {}, order: [], selection: [], activeId: null, edit: null };

export function createDoc(name: string, state: DocState = emptyDocState, filePath: string | null = null): Doc {
  return { id: newId(), name, filePath, dirty: false, state, past: [], future: [] };
}

export function createAppState(): AppState {
  const doc = createDoc('Unbenannt');
  return {
    preferences: defaultPreferences,
    docs: { [doc.id]: doc },
    docOrder: [doc.id],
    activeDocId: doc.id,
    workspace: 'modeling',
    shading: 'solid',
    tool: 'select',
  };
}

export function activeDoc(app: AppState): Doc {
  return app.docs[app.activeDocId];
}

/** Returns `base` or, if taken, `base.001`, `base.002`, ... */
export function uniqueName(taken: Iterable<string>, base: string): string {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  const stem = base.replace(/\.\d{3}$/, '');
  for (let i = 1; ; i++) {
    const candidate = `${stem}.${String(i).padStart(3, '0')}`;
    if (!set.has(candidate)) return candidate;
  }
}

export function withDoc(app: AppState, doc: Doc): AppState {
  return { ...app, docs: { ...app.docs, [doc.id]: doc } };
}

export function addDoc(app: AppState, doc: Doc): AppState {
  return { ...withDoc(app, doc), docOrder: [...app.docOrder, doc.id], activeDocId: doc.id };
}
