// Item definition JSON <-> ItemDefinition, without losing anything.
//
// Reading keeps every key: structural keys become typed fields, everything else goes into `fields`, and the
// original key order is remembered. A node whose structure does not match its type (e.g. "cases" is not a list)
// is kept whole as an `unknown` node, so even broken parts of a file survive a round trip untouched.
// Writing puts keys back in the order they were read; keys of new nodes follow Mojang's convention ("type"
// first, then alphabetical), which is how the vanilla files are written.
import { findModelType } from './registry';
import type { Fields, ItemDefinition, ItemModelNode, Json, JsonObject, RangeEntry, SelectCase, SpecialModel, TintSource } from './types';

type Raw = Record<string, Json>;

export const isJsonObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Kinds by normalized type id; the structure does not depend on the version, only what is valid does. */
function kindOf(type: string): ItemModelNode['kind'] {
  // Any version that knows the type will do: the structure of a type never changed.
  return findModelType(type, '26.3')?.kind ?? 'unknown';
}

function pick(raw: Raw, structural: readonly string[]): Fields {
  const out: Record<string, Json> = {};
  for (const [key, value] of Object.entries(raw)) if (!structural.includes(key)) out[key] = value;
  return out;
}

const STRUCTURAL: Record<Exclude<ItemModelNode['kind'], 'unknown'>, readonly string[]> = {
  model: ['type', 'model', 'tints', 'transformation'],
  composite: ['type', 'models', 'transformation'],
  condition: ['type', 'property', 'on_true', 'on_false', 'transformation'],
  select: ['type', 'property', 'cases', 'fallback', 'transformation'],
  range_dispatch: ['type', 'property', 'entries', 'scale', 'fallback', 'transformation'],
  special: ['type', 'base', 'model', 'transformation'],
  empty: ['type', 'transformation'],
  bundle_selected_item: ['type', 'transformation'],
};

function unknownNode(raw: Raw, type: string): ItemModelNode {
  return { kind: 'unknown', type, fields: pick(raw, ['type']), keyOrder: Object.keys(raw) };
}

function parseTint(raw: Json): TintSource | null {
  if (!isJsonObject(raw) || typeof raw.type !== 'string') return null;
  return { type: raw.type, fields: pick(raw as Raw, ['type']), keyOrder: Object.keys(raw) };
}

/** Parses one item model; null when the value cannot be a node at all (not an object with a string "type"). */
export function parseNode(raw: Json | undefined): ItemModelNode | null {
  if (!isJsonObject(raw) || typeof raw.type !== 'string') return null;
  const obj = raw as Raw;
  const type = raw.type;
  const kind = kindOf(type);
  if (kind === 'unknown') return unknownNode(obj, type);
  const base = {
    type,
    fields: pick(obj, STRUCTURAL[kind]),
    keyOrder: Object.keys(obj),
    ...(Object.hasOwn(obj, 'transformation') ? { transformation: obj.transformation } : {}),
  };
  switch (kind) {
    case 'model': {
      if (typeof obj.model !== 'string') return unknownNode(obj, type);
      let tints: TintSource[] | undefined;
      if (Object.hasOwn(obj, 'tints')) {
        if (!Array.isArray(obj.tints)) return unknownNode(obj, type);
        tints = [];
        for (const t of obj.tints as Json[]) {
          const tint = parseTint(t);
          if (!tint) return unknownNode(obj, type);
          tints.push(tint);
        }
      }
      return { ...base, kind, model: obj.model, ...(tints ? { tints } : {}) };
    }
    case 'composite': {
      if (!Array.isArray(obj.models)) return unknownNode(obj, type);
      const models: ItemModelNode[] = [];
      for (const m of obj.models as Json[]) {
        const node = parseNode(m);
        if (!node) return unknownNode(obj, type);
        models.push(node);
      }
      return { ...base, kind, models };
    }
    case 'condition': {
      const onTrue = parseNode(obj.on_true);
      const onFalse = parseNode(obj.on_false);
      if (typeof obj.property !== 'string' || !onTrue || !onFalse) return unknownNode(obj, type);
      return { ...base, kind, property: obj.property, onTrue, onFalse };
    }
    case 'select': {
      if (typeof obj.property !== 'string' || !Array.isArray(obj.cases)) return unknownNode(obj, type);
      const cases: SelectCase[] = [];
      for (const c of obj.cases as Json[]) {
        const model = isJsonObject(c) ? parseNode(c.model) : null;
        if (!model || !isJsonObject(c) || !Object.hasOwn(c, 'when')) return unknownNode(obj, type);
        cases.push({ when: c.when, model, fields: pick(c as Raw, ['when', 'model']), keyOrder: Object.keys(c) });
      }
      const fallback = Object.hasOwn(obj, 'fallback') ? parseNode(obj.fallback) : undefined;
      if (fallback === null) return unknownNode(obj, type);
      return { ...base, kind, property: obj.property, cases, ...(fallback ? { fallback } : {}) };
    }
    case 'range_dispatch': {
      if (typeof obj.property !== 'string' || !Array.isArray(obj.entries)) return unknownNode(obj, type);
      if (Object.hasOwn(obj, 'scale') && !isNumber(obj.scale)) return unknownNode(obj, type);
      const entries: RangeEntry[] = [];
      for (const e of obj.entries as Json[]) {
        const model = isJsonObject(e) ? parseNode(e.model) : null;
        if (!model || !isJsonObject(e) || !isNumber(e.threshold)) return unknownNode(obj, type);
        entries.push({ threshold: e.threshold, model, fields: pick(e as Raw, ['threshold', 'model']), keyOrder: Object.keys(e) });
      }
      const fallback = Object.hasOwn(obj, 'fallback') ? parseNode(obj.fallback) : undefined;
      if (fallback === null) return unknownNode(obj, type);
      return {
        ...base,
        kind,
        property: obj.property,
        entries,
        ...(isNumber(obj.scale) ? { scale: obj.scale } : {}),
        ...(fallback ? { fallback } : {}),
      };
    }
    case 'special': {
      const model = obj.model;
      if (typeof obj.base !== 'string' || !isJsonObject(model) || typeof model.type !== 'string') return unknownNode(obj, type);
      const special: SpecialModel = { type: model.type, fields: pick(model as Raw, ['type']), keyOrder: Object.keys(model) };
      return { ...base, kind, base: obj.base, special };
    }
    case 'empty':
    case 'bundle_selected_item':
      return { ...base, kind };
  }
}

/** Whether parsed JSON is an item definition rather than a block/item model: a "model" object with a "type" and no model keys. */
export function looksLikeItemDefinition(raw: unknown): boolean {
  if (!isJsonObject(raw) || !isJsonObject(raw.model) || typeof raw.model.type !== 'string') return false;
  return !['elements', 'parent', 'textures', 'display', 'texture_size'].some((key) => Object.hasOwn(raw, key));
}

/** Parses a whole item definition object. Throws when it has no "model" object. */
export function parseItemDefinition(raw: unknown): ItemDefinition {
  if (!isJsonObject(raw)) throw new Error('The item definition is not a JSON object');
  const model = parseNode(raw.model);
  if (!model) throw new Error('The item definition has no "model" object with a "type"');
  return { model, fields: pick(raw as Raw, ['model']), keyOrder: Object.keys(raw) };
}

/** Parses item definition text (a BOM is ignored). Throws on invalid JSON. */
export function parseItemDefinitionText(text: string): ItemDefinition {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new Error('The item definition is not valid JSON');
  }
  return parseItemDefinition(raw);
}

// ---- writing -------------------------------------------------------------------------------------

/** Mojang's order: "type" first, then alphabetical. */
function canonicalCompare(a: string, b: string): number {
  if (a === b) return 0;
  if (a === 'type') return -1;
  if (b === 'type') return 1;
  return a < b ? -1 : 1;
}

/** Builds an object whose keys follow `keyOrder` (keys it lists, in its order), then the others canonically. */
export function ordered(entries: Record<string, Json | undefined>, keyOrder?: readonly string[]): JsonObject {
  const keys = Object.keys(entries).filter((k) => entries[k] !== undefined);
  const position = new Map((keyOrder ?? []).map((k, i) => [k, i]));
  keys.sort((a, b) => {
    const pa = position.get(a);
    const pb = position.get(b);
    if (pa !== undefined && pb !== undefined) return pa - pb;
    if (pa !== undefined) return -1;
    if (pb !== undefined) return 1;
    return canonicalCompare(a, b);
  });
  const out: Record<string, Json> = {};
  for (const k of keys) out[k] = entries[k] as Json;
  return out;
}

function tintToJson(tint: TintSource): JsonObject {
  return ordered({ ...tint.fields, type: tint.type }, tint.keyOrder);
}

/** One item model as JSON. */
export function nodeToJson(node: ItemModelNode): JsonObject {
  const common: Record<string, Json | undefined> = { ...node.fields, type: node.type, transformation: node.transformation };
  switch (node.kind) {
    case 'model':
      return ordered({ ...common, model: node.model, tints: node.tints?.map(tintToJson) }, node.keyOrder);
    case 'composite':
      return ordered({ ...common, models: node.models.map(nodeToJson) }, node.keyOrder);
    case 'condition':
      return ordered({ ...common, property: node.property, on_true: nodeToJson(node.onTrue), on_false: nodeToJson(node.onFalse) }, node.keyOrder);
    case 'select':
      return ordered(
        {
          ...common,
          property: node.property,
          cases: node.cases.map((c) => ordered({ ...c.fields, when: c.when, model: nodeToJson(c.model) }, c.keyOrder)),
          fallback: node.fallback && nodeToJson(node.fallback),
        },
        node.keyOrder,
      );
    case 'range_dispatch':
      return ordered(
        {
          ...common,
          property: node.property,
          scale: node.scale,
          entries: node.entries.map((e) => ordered({ ...e.fields, threshold: e.threshold, model: nodeToJson(e.model) }, e.keyOrder)),
          fallback: node.fallback && nodeToJson(node.fallback),
        },
        node.keyOrder,
      );
    case 'special':
      return ordered({ ...common, base: node.base, model: ordered({ ...node.special.fields, type: node.special.type }, node.special.keyOrder) }, node.keyOrder);
    case 'empty':
    case 'bundle_selected_item':
    case 'unknown':
      return ordered(common, node.keyOrder);
  }
}

/** The whole file as JSON: "model" first for new files (as vanilla writes it), else in the order read. */
export function itemDefinitionToJson(def: ItemDefinition): JsonObject {
  return ordered({ ...def.fields, model: nodeToJson(def.model) }, def.keyOrder ?? ['model']);
}

/** The file text: two-space indentation and a final newline, like the vanilla files. */
export function serializeItemDefinition(def: ItemDefinition): string {
  return `${JSON.stringify(itemDefinitionToJson(def), null, 2)}\n`;
}
