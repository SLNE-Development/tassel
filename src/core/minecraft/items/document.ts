// Item definition documents: the DocState of a 'minecraft_item' document and how it is stored in .tessel files.
import { z } from 'zod';
import { emptyDocState } from '../../state';
import type { DocState } from '../../types';
import { DEFAULT_VERSION, isJavaVersion, javaVersions } from '../versions';
import { itemDefinitionToJson, parseItemDefinition } from './codec';
import type { ItemDefinition, ItemDocSettings } from './types';

const NAME = /^[a-z0-9_.-]+$/;
const PATH = /^[a-z0-9_.\-/]+$/;

/** Checks a namespace and an item id (path below items/, without .json); returns an English problem or null. */
export function itemIdProblem(namespace: string, id: string): string | null {
  if (!NAME.test(namespace)) return `"${namespace}" is not a valid namespace (lower case a-z, 0-9, _ . -)`;
  if (!PATH.test(id) || id.startsWith('/') || id.endsWith('/') || id.includes('//')) return `"${id}" is not a valid item id (lower case a-z, 0-9, _ . - /)`;
  return null;
}

/** The file's place in a resource pack: assets/<namespace>/items/<id>.json */
export const itemFilePath = (item: Pick<ItemDocSettings, 'namespace' | 'id'>): string => `assets/${item.namespace}/items/${item.id}.json`;

/** Namespace and id from a path that contains assets/<namespace>/items/<id>.json, else null. */
export function itemLocationFromPath(path: string): { namespace: string; id: string } | null {
  const match = /(?:^|[\\/])assets[\\/]([^\\/]+)[\\/]items[\\/](.+)\.json$/i.exec(path);
  if (!match) return null;
  const location = { namespace: match[1], id: match[2].replace(/\\/g, '/') };
  return itemIdProblem(location.namespace, location.id) ? null : location;
}

/** A model reference from a path that contains assets/<namespace>/models/<path>.json, else null. */
export function modelLocationFromPath(path: string): string | null {
  const match = /(?:^|[\\/])assets[\\/]([^\\/]+)[\\/]models[\\/](.+)\.json$/i.exec(path);
  return match ? `${match[1]}:${match[2].replace(/\\/g, '/')}` : null;
}

export function itemDocState(item: ItemDocSettings): DocState {
  if (!isJavaVersion(item.version)) throw new Error(`Unknown Minecraft Java version "${item.version}". Known: ${javaVersions.map((v) => v.id).join(', ')}`);
  return { ...emptyDocState, format: 'minecraft_item', item };
}

export function newItemSettings(definition: ItemDefinition, opts: { namespace?: string; id?: string; version?: string } = {}): ItemDocSettings {
  return { version: opts.version ?? DEFAULT_VERSION, namespace: opts.namespace ?? 'minecraft', id: opts.id ?? 'item', definition };
}

/** How the item settings are stored in a .tessel file: the definition as the JSON it is written as. */
export const itemSettingsSchema = z.object({
  version: z.string().default(DEFAULT_VERSION),
  namespace: z.string().default('minecraft'),
  id: z.string().default('item'),
  definition: z.unknown(),
});

export function itemSettingsToJson(item: ItemDocSettings) {
  return { version: item.version, namespace: item.namespace, id: item.id, definition: itemDefinitionToJson(item.definition) };
}

export function itemSettingsFromJson(raw: z.infer<typeof itemSettingsSchema>): ItemDocSettings {
  return {
    version: isJavaVersion(raw.version) ? raw.version : DEFAULT_VERSION,
    namespace: raw.namespace,
    id: raw.id,
    definition: parseItemDefinition(raw.definition),
  };
}
