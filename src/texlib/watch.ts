import { execute, useApp } from '../app/store';
import type { SyncReport } from '../core/commands/library';
import { linkLocation } from '../core/textureLibrary';
import type { AppState } from '../core/types';
import { getT } from '../i18n';
import { notifyError, notifyInfo } from '../ui/toast';
import { resolveCached, statFiles } from './service';

// Keeps linked textures in step with their files: a document that opens is synced right away, the
// window getting focus rescans, and while it is focused the linked files are polled for changes.

const POLL_MS = 2500;

function linkedLocations(app: AppState): Map<string, { namespace: string; path: string }> {
  const links = new Map<string, { namespace: string; path: string }>();
  for (const doc of Object.values(app.docs)) {
    for (const texture of Object.values(doc.state.textures)) if (texture.link) links.set(linkLocation(texture.link), texture.link);
  }
  return links;
}

let syncing = 0;
let queue: Promise<void> = Promise.resolve();

/** Runs `library.refresh` after any refresh already running, and tells the user what changed. */
function sync(params: { documentIds?: string[]; locations?: string[] }): Promise<void> {
  syncing++;
  queue = queue.then(async () => {
    try {
      const report = (await execute('library.refresh', params)) as SyncReport;
      const t = getT().library;
      if (report.conflicts.length > 0) notifyInfo(t.conflictTitle, t.conflict(report.conflicts.map((c) => c.location).join(', ')));
      else if (report.updated.length > 0) notifyInfo(t.updated(report.updated.length));
    } catch (error) {
      notifyError(error);
    } finally {
      syncing--;
    }
  });
  return queue;
}

/** The modification time of each linked file the last time it was polled. */
const seen = new Map<string, number | null>();

async function poll(): Promise<void> {
  if (document.hidden || !document.hasFocus() || syncing > 0) return;
  const links = linkedLocations(useApp.getState());
  if (links.size === 0) return;
  const bySource = new Map<string, { location: string; file: string }[]>();
  for (const [location, link] of links) {
    const entry = resolveCached(link);
    if (!entry || entry.sourceKind === 'vanilla') continue;
    bySource.set(entry.source, [...(bySource.get(entry.source) ?? []), { location, file: entry.file }]);
  }
  const changed: string[] = [];
  for (const [source, items] of bySource) {
    const times = await statFiles(
      source,
      items.map((i) => i.file),
    ).catch(() => null);
    if (!times) continue;
    items.forEach((item, i) => {
      const before = seen.get(item.location);
      seen.set(item.location, times[i]);
      if (before !== undefined && before !== times[i]) changed.push(item.location);
    });
  }
  if (changed.length > 0) await sync({ locations: changed });
}

/** Starts watching (desktop app only; call once). */
export function startLibraryWatch(): void {
  const synced = new Set<string>();
  const syncNewDocs = (app: AppState) => {
    const fresh = Object.values(app.docs).filter((doc) => !synced.has(doc.id));
    for (const doc of fresh) synced.add(doc.id);
    const withLinks = fresh.filter((doc) => Object.values(doc.state.textures).some((t) => t.link)).map((doc) => doc.id);
    if (withLinks.length > 0) void sync({ documentIds: withLinks });
  };
  syncNewDocs(useApp.getState());
  useApp.subscribe((app, previous) => {
    if (app.docs !== previous.docs) syncNewDocs(app);
  });
  window.addEventListener('focus', () => {
    if (linkedLocations(useApp.getState()).size > 0) void sync({});
  });
  window.setInterval(() => void poll(), POLL_MS);
}
