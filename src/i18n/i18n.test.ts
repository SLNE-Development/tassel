import { describe, expect, it } from 'vitest';
import { commands } from '../core/commands';
import { de } from './de';
import { commandTitles, en } from './en';

/** All texts of a dictionary by dotted path. */
function texts(node: unknown, path = ''): [string, unknown][] {
  if (typeof node !== 'object' || node === null) return [[path, node]];
  return Object.entries(node).flatMap(([key, value]) => texts(value, path ? `${path}.${key}` : key));
}

describe('i18n', () => {
  it('has an English title for every command in the registry', () => {
    const missing = commands.map((c) => c.id).filter((id) => !commandTitles[id]);
    expect(missing, `Add English titles to commandTitles in src/i18n/en.ts for: ${missing.join(', ')}`).toEqual([]);
  });

  it('has no English titles for commands that do not exist', () => {
    const ids = new Set(commands.map((c) => c.id));
    const stale = Object.keys(commandTitles).filter((id) => !ids.has(id));
    expect(stale, `Remove from commandTitles in src/i18n/en.ts: ${stale.join(', ')}`).toEqual([]);
  });

  it('has the same texts in both languages, none of them empty', () => {
    const shape = (dictionary: unknown) => texts(dictionary).map(([path, text]) => `${path}: ${typeof text}`);
    expect(shape(en)).toEqual(shape(de));
    for (const [path, text] of [...texts(de), ...texts(en)]) expect(text, path).not.toBe('');
  });

  it('forms plurals and formats numbers per language', () => {
    expect(de.status.objects(1)).toBe('1 Objekt');
    expect(de.status.objects(1234)).toBe('1.234 Objekte');
    expect(en.status.objects(1)).toBe('1 object');
    expect(en.status.objects(1234)).toBe('1,234 objects');
    expect(de.status.elementsSelected(1, 1, 'vertex')).toBe('1 von 1 Eckpunkt ausgewählt');
    expect(de.status.elementsSelected(3, 8, 'vertex')).toBe('3 von 8 Eckpunkten ausgewählt');
    expect(en.status.elementsSelected(3, 8, 'vertex')).toBe('3 of 8 vertices selected');
    expect(de.status.andMore(1)).toBe(' und 1 weiteres');
    expect(en.status.andMore(2)).toBe(' and 2 more');
    expect(de.dialogs.quitText(['A'])).toBe('„A“ hat ungespeicherte Änderungen. Beim Beenden gehen sie verloren.');
    expect(en.dialogs.quitText(['A', 'B'])).toBe('2 documents have unsaved changes: A, B. They will be lost if you quit.');
  });
});
