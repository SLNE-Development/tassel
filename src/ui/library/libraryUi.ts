import { isMinecraft } from '../../core/formats';
import { isTauri } from '@tauri-apps/api/core';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { execute, selectDocState, useApp } from '../../app/store';
import { linkLocation, type LibraryEntry, type TextureLink } from '../../core/textureLibrary';
import type { CuboidFaceName, Texture, TextureSlot } from '../../core/types';
import { librarySnapshot, onLibraryChange, readLibraryImage, resolveCached, textureLibrary } from '../../texlib';
import { notifyError } from '../toast';

// UI state of the Textures library panel, thumbnails, link status and drag and drop of library textures.

/** The drag data type of a library texture: `location\nsource`. */
export const TEXTURE_DRAG_TYPE = 'application/x-tessel-texture';

export interface DraggedTexture {
  location: string;
  source: string;
}

export function startTextureDrag(event: React.DragEvent, entry: LibraryEntry): void {
  event.dataTransfer.setData(TEXTURE_DRAG_TYPE, `${entry.location}\n${entry.source}`);
  event.dataTransfer.setData('text/plain', entry.location);
  event.dataTransfer.effectAllowed = 'copyLink';
}

/** True while a library texture is dragged over (the data itself is only readable on drop). */
export function isTextureDrag(event: { dataTransfer: DataTransfer | null }): boolean {
  return !!event.dataTransfer?.types.includes(TEXTURE_DRAG_TYPE);
}

export function droppedTexture(event: { dataTransfer: DataTransfer | null }): DraggedTexture | null {
  const raw = event.dataTransfer?.getData(TEXTURE_DRAG_TYPE);
  if (!raw) return null;
  const [location, source] = raw.split('\n');
  return location ? { location, source: source ?? '' } : null;
}

const PANEL_KEY = 'tessel.library.open';

function stored(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export interface LibraryUiState {
  panelOpen: boolean;
  /** 'all' or a source id. */
  source: string;
  namespace: string | null;
  folder: string | null;
  search: string;
  /** Picking a library texture for an existing document texture ("locate" / "relink"). */
  relink: { docId: string; textureId: string; name: string } | null;
  /** The texture whose location is being changed in the move dialog. */
  moving: LibraryEntry | null;
  /** Files dropped onto the panel or chosen to import, waiting for a namespace and folder. */
  importing: File[] | null;
  /** Library folder waiting for a "forget" confirmation. */
  busy: boolean;
}

export const useLibraryUi = create<LibraryUiState>(() => ({
  panelOpen: stored(PANEL_KEY) === '1',
  source: 'all',
  namespace: null,
  folder: null,
  search: '',
  relink: null,
  moving: null,
  importing: null,
  busy: false,
}));

export function setLibraryPanelOpen(open: boolean): void {
  useLibraryUi.setState({ panelOpen: open });
  try {
    globalThis.localStorage?.setItem(PANEL_KEY, open ? '1' : '0');
  } catch {
    // Remembering the panel state is a convenience only.
  }
  if (open) void refreshLibrary(false);
}

export function toggleLibraryPanel(): void {
  setLibraryPanelOpen(!useLibraryUi.getState().panelOpen);
}

/** Opens the panel to pick a new file for a document texture. */
export function startRelink(texture: Texture): void {
  const docId = useApp.getState().activeDocId;
  const search = texture.link ? texture.link.path.split('/').pop()! : texture.name;
  useLibraryUi.setState({ relink: { docId, textureId: texture.id, name: texture.name }, search, namespace: null, folder: null });
  setLibraryPanelOpen(true);
}

export async function refreshLibrary(rescan = true): Promise<void> {
  if (!isTauri()) return;
  useLibraryUi.setState({ busy: true });
  try {
    await textureLibrary.entries({ refresh: rescan });
  } catch (error) {
    notifyError(error);
  } finally {
    useLibraryUi.setState({ busy: false });
  }
}

/** The library as last scanned; re-renders when it changes. */
export function useLibraryScans() {
  return useSyncExternalStore(onLibraryChange, librarySnapshot);
}

/** Bumps whenever the library changes (for values derived from the cache). */
function useLibraryVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => onLibraryChange(() => setVersion((v) => v + 1)), []);
  return version;
}

export type LinkStatus = 'embedded' | 'linked' | 'missing' | 'vanilla';

/** How a document texture stands with the library. */
export function useLinkStatus(texture: Pick<Texture, 'link'>): { status: LinkStatus; entry: LibraryEntry | null } {
  useLibraryVersion();
  if (!texture.link) return { status: 'embedded', entry: null };
  const entry = resolveCached(texture.link);
  if (!entry) return { status: librarySnapshot().length === 0 ? 'linked' : 'missing', entry: null };
  return { status: entry.readOnly ? 'vanilla' : 'linked', entry };
}

// ---- thumbnails ---------------------------------------------------------------------------------

const thumbnails = new Map<string, Promise<string | null>>();
let running = 0;
const waiting: (() => void)[] = [];

/** At most a few reads at once, so a full grid does not flood the backend. */
async function limited<T>(work: () => Promise<T>): Promise<T> {
  if (running >= 6) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await work();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

function thumbnailKey(entry: LibraryEntry): string {
  return `${entry.source}|${entry.file}|${entry.modified}`;
}

/** An object URL of the entry's PNG once `visible` (null until loaded or if unreadable). */
export function useLibraryThumbnail(entry: LibraryEntry, visible: boolean): string | null {
  const key = thumbnailKey(entry);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!visible) return;
    let live = true;
    let promise = thumbnails.get(key);
    if (!promise) {
      promise = limited(async () => {
        const data = await readLibraryImage(entry).catch(() => null);
        if (!data) return null;
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        return URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
      });
      thumbnails.set(key, promise);
    }
    void promise.then((value) => live && setUrl(value));
    return () => {
      live = false;
    };
  }, [key, visible]);
  return url;
}

// ---- actions ------------------------------------------------------------------------------------

/** Adds a library texture to the active document (linked) and assigns it where given. */
export async function addLibraryTexture(
  dragged: DraggedTexture,
  target: { objects?: string[]; faces?: CuboidFaceName[]; materialId?: string; slot?: TextureSlot } = {},
): Promise<string | null> {
  try {
    const result = (await execute('texture.add_from_library', { location: dragged.location, ...(dragged.source ? { source: dragged.source } : {}), ...target })) as { id: string };
    return result.id;
  } catch (error) {
    notifyError(error);
    return null;
  }
}

/** Double-click on a library tile: relink the texture being located, else add it (to the selected elements in Minecraft documents). */
export async function applyLibraryEntry(entry: LibraryEntry): Promise<void> {
  const { relink } = useLibraryUi.getState();
  if (relink) {
    useLibraryUi.setState({ relink: null });
    try {
      await execute('texture.link', { id: relink.textureId, location: entry.location, source: entry.source }, { documentId: relink.docId });
    } catch (error) {
      notifyError(error);
    }
    return;
  }
  const state = selectDocState(useApp.getState());
  const elements = isMinecraft(state) ? state.selection.filter((id) => state.objects[id]?.cuboid) : [];
  await addLibraryTexture({ location: entry.location, source: entry.source }, elements.length > 0 ? { objects: elements } : {});
}

export function locationOf(link: TextureLink): string {
  return linkLocation(link);
}
