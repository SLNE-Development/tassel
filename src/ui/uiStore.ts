import { create } from 'zustand';

/** Transient UI state (open overlays). Editor state lives in `useApp` and changes only through commands. */
export interface UiState {
  paletteOpen: boolean;
  addMenuOpen: boolean;
  /** Document waiting for the "unsaved changes" confirmation. */
  closeDocId: string | null;
  quitOpen: boolean;
  /** Object being renamed inline in the outliner. */
  renamingId: string | null;
}

export const useUi = create<UiState>(() => ({
  paletteOpen: false,
  addMenuOpen: false,
  closeDocId: null,
  quitOpen: false,
  renamingId: null,
}));
