// Where an item definition's models and textures come from: the resource pack in the open project first
// (the document's own pack), then the vanilla assets of the user's Minecraft install (src/mcassets).
import { isTauri } from '@tauri-apps/api/core';
import { projectsApi, type ProjectInfo } from '../../bridge/projects';
import { fromBase64 } from '../../io/bytes';
import { getMinecraftAssets, MinecraftAssets } from '../../mcassets';
import { activeProject } from '../projects/projectsStore';
import { relativeTo } from '../projects/projectModel';

export interface PackContext {
  project: ProjectInfo | null;
  /** Folder of the pack inside the project ('' = the project root, else ending in '/'). */
  prefix: string;
}

/** The pack a document belongs to: the active project, with the folder above `assets/` of the document's file. */
export function packContext(filePath: string | null): PackContext {
  const project = activeProject();
  if (!project) return { project: null, prefix: '' };
  const relative = filePath ? relativeTo(project.path, filePath) : null;
  const at = relative ? relative.indexOf('/assets/') : -1;
  return { project, prefix: relative && at >= 0 ? relative.slice(0, at + 1) : '' };
}

const cache = new Map<string, { vanilla: MinecraftAssets | null; assets: MinecraftAssets }>();

/** A loader that reads the pack first and vanilla second; null when there is neither. */
export function packAssets(context: PackContext): MinecraftAssets | null {
  const vanilla = getMinecraftAssets();
  const { project, prefix } = context;
  if (!project && !vanilla) return null;
  if (!project) return vanilla;
  const key = `${project.id}|${prefix}`;
  const cached = cache.get(key);
  if (cached && cached.vanilla === vanilla) return cached.assets;
  const assets = new MinecraftAssets({
    async read(path) {
      if (isTauri()) {
        try {
          return fromBase64(await projectsApi.readBinary(project.id, prefix + path));
        } catch {
          // Not in the pack (or unreadable there): fall through to vanilla.
        }
      }
      return vanilla ? vanilla.file(path) : null;
    },
  });
  cache.set(key, { vanilla, assets });
  return assets;
}

/** Forgets everything read, so that files changed on disk are read again. */
export function reloadPackAssets(): void {
  cache.clear();
  catalogs.clear();
}

// ---- model ids for autocompletion ----------------------------------------------------------------

const catalogs = new Map<string, Promise<string[]>>();
const MAX_MODELS = 6000;

async function projectModelIds(project: ProjectInfo, prefix: string): Promise<string[]> {
  const out: string[] = [];
  const list = async (dir: string) => {
    try {
      return await projectsApi.listDir(project.id, dir);
    } catch {
      return [];
    }
  };
  for (const ns of await list(`${prefix}assets`)) {
    if (ns.kind !== 'dir') continue;
    const root = `${ns.path}/models`;
    const stack = [root];
    while (stack.length > 0 && out.length < MAX_MODELS) {
      for (const entry of await list(stack.pop()!)) {
        if (entry.kind === 'dir') stack.push(entry.path);
        else if (entry.name.endsWith('.json')) out.push(`${ns.name}:${entry.path.slice(root.length + 1, -'.json'.length)}`);
      }
    }
  }
  return out;
}

async function vanillaModelIds(): Promise<string[]> {
  const vanilla = getMinecraftAssets();
  if (!vanilla) return [];
  const files = await vanilla.list('assets/minecraft/models/').catch(() => [] as string[]);
  return files.filter((f) => f.endsWith('.json')).map((f) => `minecraft:${f.slice('assets/minecraft/models/'.length, -'.json'.length)}`);
}

/** Model ids of the pack and of vanilla, sorted, pack models first. */
export function modelCatalog(context: PackContext): Promise<string[]> {
  const key = `${context.project?.id ?? ''}|${context.prefix}|${getMinecraftAssets() ? 'v' : ''}`;
  let pending = catalogs.get(key);
  if (!pending) {
    pending = Promise.all([context.project && isTauri() ? projectModelIds(context.project, context.prefix) : [], vanillaModelIds()]).then(([own, vanilla]) => {
      const ownSet = new Set(own);
      return [...own.sort(), ...vanilla.filter((id) => !ownSet.has(id)).sort()];
    });
    catalogs.set(key, pending);
  }
  return pending;
}
