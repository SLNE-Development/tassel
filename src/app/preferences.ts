import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { parsePreferences, type Preferences } from '../core/preferences';
import { useApp } from './store';

const STORAGE_KEY = 'tessel.preferences';

/** What the preferences resolve to on screen; the viewport draws with the same colours as the UI. */
export interface Appearance {
  /** `system` is resolved to what the operating system asks for. */
  theme: 'dark' | 'light';
  /** The accent colour, adjusted so that it is legible in this theme (#rrggbb). */
  accent: string;
  /** Text colour on top of the accent. */
  accentInk: string;
  /** Stronger variant of the accent, for the active object in the viewport. */
  accentActive: string;
}

// The raised surface of each theme (--raised in index.css): accent-coloured text and icons sit on it.
const SURFACE = { dark: '#232a2e', light: '#f6f5f0' } as const;
const INK = { dark: '#1b1604', light: '#ffffff' } as const;
/** Minimum contrast of the accent against the surface (WCAG ratio). */
const ACCENT_CONTRAST = 4;

type Rgb = [number, number, number];

const toRgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
const toHex = (rgb: Rgb) => `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
const mix = (a: Rgb, b: Rgb, t: number): Rgb => a.map((c, i) => c + (b[i] - c) * t) as Rgb;

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The colours a preference set resolves to. The chosen accent is darkened on the light theme (and
 * lightened on the dark one) just as far as needed to stay readable as text, an icon or an outline.
 */
export function resolveAppearance(preferences: Preferences, systemDark: boolean): Appearance {
  const theme = preferences.theme === 'system' ? (systemDark ? 'dark' : 'light') : preferences.theme;
  const surface = toRgb(SURFACE[theme]);
  const towards: Rgb = theme === 'dark' ? [255, 255, 255] : [0, 0, 0];
  const chosen = toRgb(preferences.accentColor);
  let accent = chosen;
  for (let t = 0.04; contrast(accent, surface) < ACCENT_CONTRAST && t <= 1; t += 0.04) accent = mix(chosen, towards, t);
  const dark = toRgb(INK.dark);
  const light = toRgb(INK.light);
  return {
    theme,
    accent: toHex(accent),
    accentInk: contrast(accent, dark) >= contrast(accent, light) ? INK.dark : INK.light,
    accentActive: toHex(mix(accent, towards, theme === 'dark' ? 0.6 : 0.45)),
  };
}

const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
let appearance = resolveAppearance(useApp.getState().preferences, systemDark.matches);
const appearanceListeners = new Set<() => void>();

export const getAppearance = (): Appearance => appearance;

/** Calls `listener` whenever the theme or the accent colour changes. Returns the unsubscribe function. */
export function onAppearanceChange(listener: () => void): () => void {
  appearanceListeners.add(listener);
  return () => appearanceListeners.delete(listener);
}

let appliedScale = 1;

/** Zooms the whole interface: the webview zoom in the desktop app, CSS zoom in a plain browser. */
function applyUiScale(scale: number): void {
  if (scale === appliedScale) return;
  appliedScale = scale;
  if (isTauri()) getCurrentWebview().setZoom(scale).catch(console.error);
  else document.documentElement.style.zoom = scale === 1 ? '' : String(scale);
}

function apply(preferences: Preferences): void {
  const root = document.documentElement;
  const next = resolveAppearance(preferences, systemDark.matches);
  const changed = next.theme !== appearance.theme || next.accent !== appearance.accent;
  appearance = next;
  root.dataset.theme = next.theme;
  root.lang = preferences.language;
  root.style.setProperty('--font-scale', String(preferences.fontScale));
  root.style.setProperty('--accent', next.accent);
  root.style.setProperty('--accent-ink', next.accentInk);
  applyUiScale(preferences.uiScale);
  if (changed) for (const listener of appearanceListeners) listener();
}

/**
 * Loads the saved preferences into the store, applies them to the page (before the first paint,
 * so there is no flash of the wrong theme) and from then on applies and saves every change.
 */
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
  apply(useApp.getState().preferences);
  // The `system` theme follows the operating system while the app is running.
  systemDark.addEventListener('change', () => apply(useApp.getState().preferences));
  useApp.subscribe((app, previous) => {
    if (app.preferences === previous.preferences) return;
    apply(app.preferences);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(app.preferences));
    } catch {
      // Storage full or unavailable: the preferences still apply for this session.
    }
  });
}
