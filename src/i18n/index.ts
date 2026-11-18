import { useApp } from '../app/store';
import type { Language } from '../core/preferences';
import { DEFAULT_DOC_NAME } from '../core/state';
import { de, type Dictionary } from './de';
import { commandTitles, en } from './en';

export type { Dictionary };

const dictionaries: Record<Language, Dictionary> = { de, en };

/** The texts of the current UI language. The component re-renders when the language changes. */
export function useT(): Dictionary {
  return dictionaries[useApp((s) => s.preferences.language)];
}

/** The texts of the current UI language, for code outside React (actions, toasts, shortcut labels). */
export function getT(): Dictionary {
  return dictionaries[useApp.getState().preferences.language];
}

/** A registry command's title in the current UI language. Commands carry their German title themselves. */
export function commandTitle(def: { id: string; title: string }): string {
  return useApp.getState().preferences.language === 'en' ? (commandTitles[def.id] ?? def.title) : def.title;
}

const defaultDocName = new RegExp(`^${DEFAULT_DOC_NAME}(\\.\\d{3})?$`);

/**
 * A document's name as the UI shows it. Core names new documents with a language-neutral default
 * ("Untitled", "Untitled.001", ...); until such a document is renamed or saved it appears under the
 * translated label instead, and follows the UI language.
 */
export function documentName(doc: { name: string; filePath: string | null }, t: Dictionary = getT()): string {
  if (doc.filePath !== null || !defaultDocName.test(doc.name)) return doc.name;
  return t.documents.untitled + doc.name.slice(DEFAULT_DOC_NAME.length);
}

/** Keeps `<html lang>` in step with the UI language (screen readers, hyphenation). */
export function syncDocumentLanguage(): void {
  const apply = () => {
    document.documentElement.lang = useApp.getState().preferences.language;
  };
  apply();
  useApp.subscribe((app, previous) => {
    if (app.preferences.language !== previous.preferences.language) apply();
  });
}
