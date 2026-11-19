import { selectDocState, useApp } from '../app/store';
import { docFormat } from '../core/formats';
import type { DocFormat } from '../core/types';

/** The format of the active document ('free' or 'minecraft_java'). Re-renders when the active document changes format. */
export const useDocFormat = (): DocFormat => useApp((s) => docFormat(selectDocState(s)));

export const useIsMinecraft = (): boolean => useDocFormat() === 'minecraft_java';

/** Format of the active document, for code outside React. */
export const activeFormat = (): DocFormat => docFormat(selectDocState(useApp.getState()));
