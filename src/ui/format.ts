import { selectDocState, useApp } from '../app/store';
import { docFormat, isMinecraftFormat } from '../core/formats';
import type { DocFormat } from '../core/types';

/** The format of the active document ('free', 'minecraft_java' or 'minecraft_factory'). Re-renders when the active document changes format. */
export const useDocFormat = (): DocFormat => useApp((s) => docFormat(selectDocState(s)));

export const useIsMinecraft = (): boolean => isMinecraftFormat(useDocFormat());
export const useIsFactory = (): boolean => useDocFormat() === 'minecraft_factory';

/** Format of the active document, for code outside React. */
export const activeFormat = (): DocFormat => docFormat(selectDocState(useApp.getState()));
