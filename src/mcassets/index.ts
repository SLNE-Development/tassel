import { invoke, isTauri } from '@tauri-apps/api/core';
import { services, useApp } from '../app/store';
import type { MinecraftAssetsInfo, MinecraftAssetsService, MinecraftAssetsStatus, MinecraftInstall } from '../core/minecraftAssets';
import { MinecraftAssets, type AssetSource } from './loader';

// The app's Minecraft assets source: follows the `minecraftAssets` preference, opens it on the Rust
// side (which reads the jar or folder, read-only and only below `assets/`) and hands out a cached
// `MinecraftAssets` loader for it. See `getMinecraftAssets` and `onMinecraftAssetsChange`.

export { MinecraftAssets, resolveTextureVariable } from './loader';
export type { AssetSource, DecodedImage, McDisplay, McElement, McFace, McModelJson, McTexture, ResolvedModel, TextureAnimation } from './loader';

/** Reads from the source currently opened on the Rust side (`mc_assets_open`). */
export const tauriAssetSource: AssetSource = {
  async read(path) {
    try {
      return new Uint8Array(await invoke<ArrayBuffer>('mc_assets_read', { path }));
    } catch (error) {
      if (error === 'not-found') return null;
      throw new Error(String(error));
    }
  },
  list: (prefix) => invoke<string[]>('mc_assets_list', { prefix }),
};

let status: MinecraftAssetsStatus = { state: 'none', path: '', info: null, error: null };
let loader: MinecraftAssets | null = null;
/** Bumped by every open, so that a slow open that was overtaken does not win. */
let generation = 0;
let opening: Promise<MinecraftAssetsStatus> | null = null;
const listeners = new Set<() => void>();

function publish(next: MinecraftAssetsStatus, nextLoader: MinecraftAssets | null): void {
  status = next;
  loader = nextLoader;
  for (const listener of listeners) listener();
}

/** The loader for the configured assets, or null while none is configured, opening or usable. */
export function getMinecraftAssets(): MinecraftAssets | null {
  return loader;
}

export function minecraftAssetsStatus(): MinecraftAssetsStatus {
  return status;
}

/** Calls `listener` whenever the status (and with it `getMinecraftAssets()`) changes. Returns the unsubscribe function. */
export function onMinecraftAssetsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Opens `path` ("" closes) and resolves with the resulting status. */
function open(path: string): Promise<MinecraftAssetsStatus> {
  const run = ++generation;
  if (!isTauri()) {
    publish({ state: path ? 'unavailable' : 'none', path, info: null, error: path ? 'Minecraft assets are only available in the desktop app' : null }, null);
    return Promise.resolve(status);
  }
  if (!path) {
    publish({ state: 'none', path, info: null, error: null }, null);
    opening = invoke('mc_assets_close').then(() => status, () => status);
    return opening;
  }
  publish({ state: 'loading', path, info: null, error: null }, null);
  opening = invoke<MinecraftAssetsInfo>('mc_assets_open', { path }).then(
    (info) => {
      if (run === generation) publish({ state: 'ready', path, info, error: null }, new MinecraftAssets(tauriAssetSource));
      return status;
    },
    (error) => {
      if (run === generation) publish({ state: 'error', path, info: null, error: String(error) }, null);
      return status;
    },
  );
  return opening;
}

/** Minecraft clients in the standard launcher folder, newest first. */
export async function detectMinecraftInstalls(): Promise<MinecraftInstall[]> {
  if (!isTauri()) return [];
  return invoke<MinecraftInstall[]>('mc_assets_detect');
}

/** Reads a skin PNG the user picked (any folder; .png only, at most 4 MB). */
export async function readSkinFile(path: string): Promise<Uint8Array> {
  if (!isTauri()) throw new Error('Skins can only be read in the desktop app');
  return new Uint8Array(await invoke<ArrayBuffer>('mc_assets_read_skin', { path }));
}

export const minecraftAssetsService: MinecraftAssetsService = {
  status: () => status,
  async reload() {
    const path = useApp.getState().preferences.minecraftAssets;
    // The preference subscription opens it; wait for that (or open now if it already ran for this path).
    if (status.path === path && opening && status.state === 'loading') return opening;
    return open(path);
  },
  detect: detectMinecraftInstalls,
  async list(prefix) {
    return loader ? loader.list(prefix) : [];
  },
};

/** Opens the configured assets and follows the preference from then on. Call once at start-up. */
export function initMinecraftAssets(): void {
  services.minecraftAssets = minecraftAssetsService;
  void open(useApp.getState().preferences.minecraftAssets);
  useApp.subscribe((app, previous) => {
    const path = app.preferences.minecraftAssets;
    if (path !== previous.preferences.minecraftAssets && path !== status.path) void open(path);
  });
}
