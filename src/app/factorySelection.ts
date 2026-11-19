import { create } from 'zustand';
import { useApp } from './store';

/**
 * The port selected in a factory document (by uid). Transient UI state like the outliner's renaming: it is not part of
 * the document, so it is not undoable. A uid that no longer exists simply selects nothing; consumers look the port up.
 */
export const useFactorySelection = create<{ portUid: string | null }>(() => ({ portUid: null }));

export const selectPort = (portUid: string | null): void => {
  if (useFactorySelection.getState().portUid !== portUid) useFactorySelection.setState({ portUid });
};

// Another document, or a document without the port any more (undo, remove, a project reload): nothing is selected.
let lastDoc = useApp.getState().activeDocId;
useApp.subscribe((app) => {
  const { portUid } = useFactorySelection.getState();
  if (app.activeDocId !== lastDoc) {
    lastDoc = app.activeDocId;
    selectPort(null);
  } else if (portUid && !app.docs[app.activeDocId]?.state.factory?.ports.some((p) => p.uid === portUid)) selectPort(null);
});
