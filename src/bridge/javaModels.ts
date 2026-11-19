// The app's ModelFileService (core/modelFiles.ts): model files on disk through the Rust commands of
// src-tauri/src/model_files.rs, and parent models / textures looked up in this order: the resource pack the
// model was opened from, the active project, the vanilla Minecraft assets.
import { invoke, isTauri } from '@tauri-apps/api/core';
import { assetPath } from '../core/minecraftAssets';
import type { JavaModelSource } from '../core/minecraft/parents';
import type { ModelFileService } from '../core/modelFiles';
import type { JavaImage } from '../core/types';
import { toBase64 } from '../io/bytes';
import { getMinecraftAssets } from '../mcassets';
import { activeProject } from '../ui/projects/projectsStore';
import { projectsApi } from './projects';

function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function imageFromBase64(data: string): JavaImage | null {
  const raw = atob(data.slice(0, 64));
  const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  const size = pngSize(bytes);
  return size ? { data, ...size } : null;
}

const parseJson = (text: string | null): unknown => {
  if (text === null) return null;
  return JSON.parse(text.replace(/^﻿/, ''));
};

/** One source per anchor: pack (Rust), active project, vanilla assets. Every lookup falls through on a miss. */
function sourceFor(anchor: string | null): JavaModelSource {
  const fromPack = async (kind: 'model' | 'texture', location: string) =>
    anchor && isTauri() ? await invoke<unknown>('read_java_asset_file', { anchor, kind, location }).catch(() => null) : null;
  const project = () => (isTauri() ? activeProject() : null);
  return {
    async model(id) {
      const text = (await fromPack('model', id)) as string | null;
      if (typeof text === 'string') return parseJson(text);
      const p = project();
      if (p) {
        const fromProject = await projectsApi.readText(p.id, assetPath('model', id)).catch(() => null);
        if (fromProject !== null) return parseJson(fromProject);
      }
      return (await getMinecraftAssets()?.model(id)) ?? null;
    },
    async texture(id) {
      const image = (await fromPack('texture', id)) as JavaImage | null;
      if (image && typeof image === 'object') return image;
      const p = project();
      if (p) {
        const base64 = await projectsApi.readBinary(p.id, assetPath('texture', id)).catch(() => null);
        const fromProject = base64 ? imageFromBase64(base64) : null;
        if (fromProject) return fromProject;
      }
      const vanilla = await getMinecraftAssets()?.textureBytes(id).catch(() => null);
      if (!vanilla) return null;
      const size = pngSize(vanilla);
      return size ? { data: toBase64(vanilla), ...size } : null;
    },
  };
}

export function createModelFileService(): ModelFileService {
  return {
    source: sourceFor,
    list: (folder, recursive) => invoke<string[]>('list_model_files_in', { folder, recursive }),
    readJava: (path) => invoke<{ json: string; images: Record<string, JavaImage> }>('read_java_model_file', { path }),
    async readBbmodel(path) {
      const read = await invoke<{ text: string; images: Record<string, JavaImage> }>('read_bbmodel_file', { path });
      return { text: read.text, images: Object.fromEntries(Object.entries(read.images).map(([k, v]) => [Number(k), v])) };
    },
    write: (path, contents, overwrite) => invoke<void>('write_converted_model', { path, contents, overwrite }),
  };
}
