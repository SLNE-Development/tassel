import {
  Box,
  Brush,
  Camera,
  Copy,
  Factory,
  FilePlus,
  Film,
  Folder,
  FolderOpen,
  Grid2x2,
  History,
  Image,
  Monitor,
  Move,
  Package,
  Palette,
  PencilLine,
  Plus,
  RotateCw,
  Scaling,
  Shapes,
  SlidersHorizontal,
  Trash2,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { create } from 'zustand';
import { execute } from '../../app/store';
import { commandsById } from '../../core/commands';
import { historyLabel, isNewDocumentOrigin } from '../../core/history';
import type { HistoryStep } from '../../core/types';
import { commandTitle, type Dictionary } from '../../i18n';
import { notifyError } from '../toast';

// UI state and helpers of the History panel (HistoryPanel.tsx).

const PANEL_KEY = 'tessel.history.open';

function stored(): boolean {
  try {
    return globalThis.localStorage?.getItem(PANEL_KEY) === '1';
  } catch {
    return false;
  }
}

export const useHistoryUi = create<{ panelOpen: boolean }>(() => ({ panelOpen: stored() }));

export function setHistoryPanelOpen(open: boolean): void {
  useHistoryUi.setState({ panelOpen: open });
  try {
    globalThis.localStorage?.setItem(PANEL_KEY, open ? '1' : '0');
  } catch {
    // Remembering the panel state is a convenience only.
  }
}

export function toggleHistoryPanel(): void {
  setHistoryPanelOpen(!useHistoryUi.getState().panelOpen);
}

/** Jumps the active document to history entry `index` (one command: as many undos or redos as needed). */
export function gotoHistoryEntry(index: number): Promise<void> {
  return execute('history.goto', { index }).then(() => undefined, notifyError);
}

/** An entry's label in the UI language: "New document", "Opened" or the command's title with its detail. */
export function historyEntryLabel(step: HistoryStep, t: Dictionary): string {
  if (!step.command) return t.history.unknown;
  return historyLabel(
    step,
    (id) => {
      const def = commandsById.get(id);
      return def ? commandTitle(def) : undefined;
    },
    { newDocument: t.history.newDocument, opened: t.history.opened },
  );
}

/** Icons by command id prefix, checked after the verbs below. */
const prefixIcons: [string, LucideIcon][] = [
  ['paint.', Brush],
  ['texture.', Image],
  ['library.', Image],
  ['material.', Palette],
  ['uv.', Grid2x2],
  ['mc.uv', Grid2x2],
  ['mesh.', Shapes],
  ['edit.', Shapes],
  ['group.', Folder],
  ['modifier.', Wrench],
  ['anim.', Film],
  ['display.', Monitor],
  ['item.', Package],
  ['render.', Camera],
  ['factory.', Factory],
  ['cuboid.', Box],
  ['mc.', Box],
];

/** An icon for the kind of change an entry is. */
export function historyEntryIcon(step: HistoryStep): LucideIcon {
  if (step.origin) return isNewDocumentOrigin(step) ? FilePlus : FolderOpen;
  const id = step.command;
  const verb = id.slice(id.indexOf('.') + 1);
  if (/delete|remove|clear/.test(verb)) return Trash2;
  if (/duplicate|copy|paste/.test(verb)) return Copy;
  if (/rename/.test(verb)) return PencilLine;
  if (/rotate/.test(verb)) return RotateCw;
  if (/scale|resize/.test(verb)) return Scaling;
  if (/transform|move|translate|align|snap/.test(verb)) return Move;
  if (/^(add|create|new)/.test(verb)) return Plus;
  for (const [prefix, icon] of prefixIcons) if (id.startsWith(prefix)) return icon;
  if (/set|update|change/.test(verb)) return SlidersHorizontal;
  return History;
}

/** "14:03:12" in the UI language; empty for steps without a time. */
export function historyTime(step: HistoryStep, t: Dictionary): string {
  if (!step.time) return '';
  return new Date(step.time).toLocaleTimeString(t.locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
