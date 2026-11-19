import { Brush, FilePlus, FolderOpen, Move, Plus, Trash2 } from 'lucide-react';
import { afterEach, describe, expect, it } from 'vitest';
import { useApp } from '../../app/store';
import { de } from '../../i18n/de';
import { en } from '../../i18n/en';
import { historyEntryIcon, historyEntryLabel } from './historyUi';

const setLanguage = (language: 'de' | 'en') => useApp.setState((s) => ({ preferences: { ...s.preferences, language } }));

afterEach(() => setLanguage('de'));

describe('history panel helpers', () => {
  it('labels entries in the UI language', () => {
    setLanguage('de');
    expect(historyEntryLabel({ command: 'document.new', time: 1, origin: true }, de)).toBe('Neues Dokument');
    expect(historyEntryLabel({ command: 'document.load', time: 1, origin: true }, de)).toBe('Geöffnet');
    expect(historyEntryLabel({ command: 'scene.add_primitive', detail: 'Würfel', time: 1 }, de)).toBe('Grundkörper hinzufügen: Würfel');
    expect(historyEntryLabel({ command: '', time: 0 }, de)).toBe('Änderung');
    setLanguage('en');
    expect(historyEntryLabel({ command: 'scene.add_primitive', detail: 'Cube', time: 1 }, en)).toBe('Add Primitive: Cube');
    expect(historyEntryLabel({ command: 'scene.set_transform', time: 1 }, en)).toBe('Set Transform');
  });

  it('picks an icon by the kind of command', () => {
    expect(historyEntryIcon({ command: 'document.new', time: 1, origin: true })).toBe(FilePlus);
    expect(historyEntryIcon({ command: 'document.import_java', time: 1, origin: true })).toBe(FolderOpen);
    expect(historyEntryIcon({ command: 'scene.add_primitive', time: 1 })).toBe(Plus);
    expect(historyEntryIcon({ command: 'scene.delete_objects', time: 1 })).toBe(Trash2);
    expect(historyEntryIcon({ command: 'scene.set_transform', time: 1 })).toBe(Move);
    expect(historyEntryIcon({ command: 'paint.stroke', time: 1 })).toBe(Brush);
  });
});
