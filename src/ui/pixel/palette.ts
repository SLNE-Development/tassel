// Palette files: reading and writing the formats pixel artists swap palettes in. Pure; no DOM.

export const paletteFormats = ['gpl', 'txt', 'hex'] as const;
export type PaletteFormat = (typeof paletteFormats)[number];

export interface ParsedPalette {
  /** The palette's own name, when the file has one. */
  readonly name?: string;
  /** Lower-case #rrggbb, in file order, without duplicates. */
  readonly colors: string[];
}

export const MAX_PALETTE_COLORS = 1024;

const hex2 = (n: number) => n.toString(16).padStart(2, '0');

function unique(colors: readonly string[]): string[] {
  return [...new Set(colors)].slice(0, MAX_PALETTE_COLORS);
}

/** One line of a plain colour list: RRGGBB, #RRGGBB, #RGB or Paint.NET's AARRGGBB (the alpha is dropped). */
function plainColor(line: string): string | null {
  const text = line.trim();
  const hash = text.startsWith('#');
  const digits = (hash ? text.slice(1) : text).toLowerCase();
  if (/^[0-9a-f]{6}$/.test(digits)) return `#${digits}`;
  if (/^[0-9a-f]{8}$/.test(digits)) return `#${digits.slice(2)}`;
  if (hash && /^[0-9a-f]{3}$/.test(digits)) return `#${[...digits].map((c) => c + c).join('')}`;
  return null;
}

/** A line of a GIMP palette: "R G B  optional name", each channel 0..255. */
function gplColor(line: string): string | null {
  const match = /^\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})(?:\s|$)/.exec(line);
  if (!match) return null;
  const [r, g, b] = [match[1], match[2], match[3]].map(Number);
  if (r > 255 || g > 255 || b > 255) return null;
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

/**
 * Reads a palette from the text of a GIMP .gpl, a Paint.NET .txt (AARRGGBB lines, ';' comments) or a plain
 * list of hex colours (.hex and the like). Throws when no colour can be read.
 */
export function parsePalette(text: string): ParsedPalette {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const gimp = /^GIMP Palette/i.test(lines[0]?.trim() ?? '');
  const colors: string[] = [];
  let name: string | undefined;
  for (const raw of lines.slice(gimp ? 1 : 0)) {
    const line = raw.trim();
    if (!line) continue;
    if (gimp) {
      const header = /^Name:\s*(.+)$/i.exec(line);
      if (header) name = header[1].trim();
      if (line.startsWith('#') || /^(Name|Columns):/i.test(line)) continue;
      const color = gplColor(line);
      if (color) colors.push(color);
    } else {
      if (line.startsWith(';') || line.startsWith('//')) continue;
      // "FF00AA33 name" and "#ff00aa" alike: the first word is the colour.
      const color = plainColor(line.split(/\s+/)[0]);
      if (color) colors.push(color);
    }
  }
  if (colors.length === 0) throw new Error('No colours found in the palette file');
  return { ...(name ? { name } : {}), colors: unique(colors) };
}

/** The palette as the text of a file of that format. */
export function serializePalette(colors: readonly string[], format: PaletteFormat, name = 'Palette'): string {
  const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  switch (format) {
    case 'gpl':
      return [
        'GIMP Palette',
        `Name: ${name.replace(/[\r\n]+/g, ' ')}`,
        'Columns: 8',
        '#',
        ...colors.map((c) => {
          const [r, g, b] = rgb(c);
          return `${String(r).padStart(3)} ${String(g).padStart(3)} ${String(b).padStart(3)} ${c.toUpperCase()}`;
        }),
        '',
      ].join('\n');
    case 'txt':
      return [`; ${name.replace(/[\r\n]+/g, ' ')}`, ...colors.map((c) => `FF${c.slice(1).toUpperCase()}`), ''].join('\n');
    case 'hex':
      return colors.map((c) => c.slice(1).toLowerCase()).join('\n') + '\n';
  }
}

export const paletteExtension: Record<PaletteFormat, string> = { gpl: 'gpl', txt: 'txt', hex: 'hex' };
