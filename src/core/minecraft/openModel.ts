// Opening a Minecraft Java model with its parent chain: the model JSON is imported (javaImport.ts), its
// textures that the file's resource pack did not have are looked up in the project and the vanilla assets,
// and its parent chain is resolved (parents.ts) and then shown read-only, merged in, or left as a reference.
import type { DocState, JavaImage } from '../types';
import { importJavaModel } from './javaImport';
import { inheritedSummary, mergeInherited, normaliseId, resolveParentChain, resolveVariables, type JavaModelSource } from './parents';

export const parentModes = ['show', 'merge', 'reference'] as const;
/** show: the parent's elements and textures appear read-only; merge: they become the model's own; reference: only the "parent" text is kept. */
export type ParentMode = (typeof parentModes)[number];

export interface OpenJavaOptions {
  fileName?: string;
  version?: string;
  /** Images of the model's own textures by location as written (what the file's resource pack had). */
  images?: Readonly<Record<string, JavaImage>>;
  /** The file the model came from (parents and textures are looked up in its resource pack first). */
  sourcePath?: string;
  parent?: ParentMode;
}

export interface OpenJavaResult {
  state: DocState;
  warnings: string[];
  parent: ReturnType<typeof inheritedSummary>;
  merged?: { elements: number; textures: number };
}

type Json = Record<string, unknown>;

/** Reads the model's own texture variables (as written) from its JSON text; {} for anything unreadable. */
function rawTextures(json: string): { parent: string; textures: Record<string, string> } {
  try {
    const raw = JSON.parse(json.replace(/^﻿/, '')) as Json;
    const textures: Record<string, string> = {};
    if (raw && typeof raw.textures === 'object' && raw.textures !== null) {
      for (const [k, v] of Object.entries(raw.textures as Json)) if (typeof v === 'string') textures[k] = v;
    }
    return { parent: typeof raw?.parent === 'string' ? raw.parent : '', textures };
  } catch {
    return { parent: '', textures: {} };
  }
}

export async function openJavaModelWithParents(json: string, opts: OpenJavaOptions, source: JavaModelSource | null): Promise<OpenJavaResult> {
  const mode = opts.parent ?? 'show';
  const { parent, textures: own } = rawTextures(json);
  const images: Record<string, JavaImage> = { ...(opts.images ?? {}) };
  const warnings: string[] = [];

  // The model's own textures that its resource pack did not have: from the project or the vanilla assets.
  if (source) {
    for (const value of new Set(Object.values(own))) {
      if (value.startsWith('#') || images[value]) continue;
      const id = normaliseId(value);
      const image = id ? await source.texture(id).catch(() => null) : null;
      if (image) images[value] = image;
    }
  }

  let resolution: Awaited<ReturnType<typeof resolveParentChain>> | null = null;
  if (parent && mode !== 'reference') {
    if (!source) warnings.push('Parent models cannot be read here; the parent is kept as a reference');
    else {
      const have = new Set(Object.keys(images).flatMap((k) => normaliseId(k) ?? []));
      resolution = await resolveParentChain(parent, source, own, have);
      warnings.push(...resolution.warnings);
    }
  }
  const inherited = resolution?.inherited ?? null;
  const inheritedImages: Record<string, JavaImage> = { ...images };
  for (const [id, image] of Object.entries(inherited?.images ?? {})) inheritedImages[id] = image;
  const imported = importJavaModel(json, {
    version: opts.version,
    fileName: opts.fileName,
    images: inheritedImages,
    ...(inherited
      ? { inheritedVariables: new Set(Object.keys(inherited.textures)), inheritedTextures: resolveVariables({ ...inherited.textures, ...own }) }
      : {}),
  });
  warnings.unshift(...imported.warnings);
  let state: DocState = {
    ...imported.state,
    java: { ...imported.state.java!, ...(opts.sourcePath ? { sourcePath: opts.sourcePath } : {}), ...(inherited ? { inherited } : {}) },
  };
  let merged: OpenJavaResult['merged'];
  if (mode === 'merge' && inherited) {
    try {
      const result = mergeInherited(state);
      state = result.state;
      merged = { elements: result.elements, textures: result.textures };
    } catch (error) {
      warnings.push((error as Error).message);
    }
  }
  return { state, warnings, parent: inheritedSummary(state), ...(merged ? { merged } : {}) };
}
