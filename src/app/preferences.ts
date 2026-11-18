import { parsePreferences } from '../core/preferences';
import { useApp } from './store';

const STORAGE_KEY = 'tessel.preferences';

/** Loads the saved preferences into the store and saves them again whenever they change. */
export function initPreferences(): void {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const preferences = parsePreferences(JSON.parse(stored));
      useApp.setState((app) => ({ ...app, preferences }));
    }
  } catch {
    // Unreadable or corrupt storage: start with the defaults.
  }
  useApp.subscribe((app, previous) => {
    if (app.preferences === previous.preferences) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(app.preferences));
    } catch {
      // Storage full or unavailable: the preferences still apply for this session.
    }
  });
}
