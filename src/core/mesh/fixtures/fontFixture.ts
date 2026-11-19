// A font service for tests and browser checks, serving recorded outlines instead of installed fonts.
// `arial.json` is what the native side returns for a handful of Arial glyphs (regular); it is written by
// the ignored Rust test `write_frontend_fixture` in src-tauri/src/fonts_tests.rs.

import type { FontFamily, FontOutline, FontService } from '../../types';
import recorded from './arial.json';

export const arial = recorded as FontOutline;

/** The characters `arial` has glyphs for. */
export const arialChars = arial.glyphs.map((glyph) => glyph.char).join('');

export const fixtureFamilies: FontFamily[] = [
  {
    family: 'Arial',
    styles: [
      { style: 'regular', weight: 400, italic: false },
      { style: 'italic', weight: 400, italic: true },
      { style: 'bold', weight: 700, italic: false },
      { style: 'bold-italic', weight: 700, italic: true },
    ],
    monospaced: false,
  },
  { family: 'Consolas', styles: [{ style: 'regular', weight: 400, italic: false }], monospaced: true },
  { family: 'Segoe UI', styles: [{ style: 'regular', weight: 400, italic: false }], monospaced: false },
];

/**
 * Behaves like the native service with only Arial installed: every family of `families` is served
 * with the recorded Arial outlines (under its own name, in the style asked for if the family lists
 * it), anything else is unknown. `calls` records the requests.
 */
export function createFixtureFonts(families: FontFamily[] = fixtureFamilies): FontService & { calls: Parameters<FontService['outline']>[0][] } {
  const calls: Parameters<FontService['outline']>[0][] = [];
  return {
    calls,
    list: async () => families,
    async outline(request) {
      calls.push(request);
      const family = families.find((f) => f.family.toLowerCase() === request.family.trim().toLowerCase());
      if (!family) throw new Error(`No installed font family is called "${request.family}". List the installed families with font_list.`);
      const wanted = `${request.bold ? 'bold' : ''}${request.bold && request.italic ? '-' : ''}${request.italic ? 'italic' : ''}` || 'regular';
      const chars = [...new Set(request.text.replace(/[\r\n]/g, ''))];
      return {
        ...arial,
        family: family.family,
        style: family.styles.find((s) => s.style === wanted) ?? family.styles[0],
        glyphs: arial.glyphs.filter((glyph) => chars.includes(glyph.char)),
        missing: chars.filter((char) => !arialChars.includes(char)),
        kerning: arial.kerning.filter((pair) => request.text.includes(pair.left + pair.right)),
      };
    },
  };
}
