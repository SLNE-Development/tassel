import { invoke, isTauri } from '@tauri-apps/api/core';
import type { FontFamily, FontOutline, FontService } from '../core/types';

/** A command of `src-tauri/src/fonts.rs`; its error strings become Errors. */
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/** The fonts installed on this computer, read by the native side; null outside the desktop app. */
export function createFontService(): FontService | null {
  if (!isTauri()) return null;
  // Fonts are not installed while the app runs often enough to rescan; the native side keeps its scan too.
  let families: Promise<FontFamily[]> | null = null;
  return {
    list() {
      families ??= call<FontFamily[]>('fonts_list').catch((error) => {
        families = null;
        throw error;
      });
      return families;
    },
    outline({ family, bold = false, italic = false, text }) {
      return call<FontOutline>('fonts_outline', { family, bold, italic, text });
    },
  };
}
