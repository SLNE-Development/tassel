import { create } from 'zustand';

/** Transient UI state (open overlays). Editor state lives in `useApp` and changes only through commands. */
export interface UiState {
  paletteOpen: boolean;
  addMenuOpen: boolean;
  /** The merge menu of the tool rail (edit mode). */
  mergeMenuOpen: boolean;
  /** Document waiting for the "unsaved changes" confirmation. */
  closeDocId: string | null;
  quitOpen: boolean;
  preferencesOpen: boolean;
  /** The "New model" dialog (format and settings of the new document). */
  newDocOpen: boolean;
  /** Object being renamed inline in the outliner. */
  renamingId: string | null;
}

export const useUi = create<UiState>(() => ({
  paletteOpen: false,
  addMenuOpen: false,
  mergeMenuOpen: false,
  closeDocId: null,
  quitOpen: false,
  preferencesOpen: false,
  newDocOpen: false,
  renamingId: null,
}));
