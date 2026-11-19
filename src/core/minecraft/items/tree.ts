// Addressing and editing nodes of an item definition tree. All functions are pure.
//
// A node path is a "/"-separated list of steps from the root model: "" is the root model, "fallback",
// "on_true", "on_false" step into those, "cases/2", "entries/0" and "models/1" into the model of a case, an
// entry or a composite part. Example: "cases/0/on_true".
import { findProperty, findSelectProperty, findSpecialModel, findTintSource, initialFields, normalizeId, propertiesOf, typeIdOf, type PropertyKind } from './registry';
import type { Fields, ItemDefinition, ItemModelNode, ItemNodeKind, Json, ModelRefNode, SelectCase, TintSource } from './types';

export type ListKey = 'cases' | 'entries' | 'models';
export type Step = { readonly key: 'fallback' | 'on_true' | 'on_false' } | { readonly key: ListKey; readonly index: number };

export function parsePath(path: string): Step[] {
  const parts = path.split('/').filter((p) => p !== '');
  const steps: Step[] = [];
  for (let i = 0; i < parts.length; i++) {
    const key = parts[i];
    if (key === 'fallback' || key === 'on_true' || key === 'on_false') steps.push({ key });
    else if (key === 'cases' || key === 'entries' || key === 'models') {
      const index = Number(parts[++i]);
      if (!Number.isInteger(index) || index < 0) throw new Error(`Invalid node path "${path}": "${key}" must be followed by an index`);
      steps.push({ key, index });
    } else throw new Error(`Invalid node path "${path}": unknown step "${key}" (use fallback, on_true, on_false, cases/N, entries/N or models/N)`);
  }
  return steps;
}

export const joinPath = (parent: string, ...steps: (string | number)[]): string => [parent, ...steps.map(String)].filter((p) => p !== '').join('/');

function describe(path: string): string {
  return path === '' ? 'the root model' : `"${path}"`;
}

function child(node: ItemModelNode, step: Step, path: string): ItemModelNode {
  const fail = () => new Error(`${describe(path)} does not exist: a ${node.type} node has no "${step.key}${'index' in step ? `/${step.index}` : ''}"`);
  switch (step.key) {
    case 'fallback':
      if ((node.kind === 'select' || node.kind === 'range_dispatch') && node.fallback) return node.fallback;
      throw fail();
    case 'on_true':
      if (node.kind === 'condition') return node.onTrue;
      throw fail();
    case 'on_false':
      if (node.kind === 'condition') return node.onFalse;
      throw fail();
    case 'cases':
      if (node.kind === 'select' && node.cases[step.index]) return node.cases[step.index].model;
      throw fail();
    case 'entries':
      if (node.kind === 'range_dispatch' && node.entries[step.index]) return node.entries[step.index].model;
      throw fail();
    case 'models':
      if (node.kind === 'composite' && node.models[step.index]) return node.models[step.index];
      throw fail();
  }
}

function withChild(node: ItemModelNode, step: Step, next: ItemModelNode): ItemModelNode {
  switch (step.key) {
    case 'fallback':
      return node.kind === 'select' || node.kind === 'range_dispatch' ? { ...node, fallback: next } : node;
    case 'on_true':
      return node.kind === 'condition' ? { ...node, onTrue: next } : node;
    case 'on_false':
      return node.kind === 'condition' ? { ...node, onFalse: next } : node;
    case 'cases':
      return node.kind === 'select' ? { ...node, cases: node.cases.map((c, i) => (i === step.index ? { ...c, model: next } : c)) } : node;
    case 'entries':
      return node.kind === 'range_dispatch' ? { ...node, entries: node.entries.map((e, i) => (i === step.index ? { ...e, model: next } : e)) } : node;
    case 'models':
      return node.kind === 'composite' ? { ...node, models: node.models.map((m, i) => (i === step.index ? next : m)) } : node;
  }
}

/** The node at `path`; throws a clear error if there is none. */
export function getNode(def: ItemDefinition, path: string): ItemModelNode {
  const steps = parsePath(path);
  let node = def.model;
  for (let i = 0; i < steps.length; i++) node = child(node, steps[i], steps.slice(0, i + 1).map(stepText).join('/'));
  return node;
}

const stepText = (s: Step) => ('index' in s ? `${s.key}/${s.index}` : s.key);

/** Replaces the node at `path` with `update(node)`. */
export function updateNode(def: ItemDefinition, path: string, update: (node: ItemModelNode) => ItemModelNode): ItemDefinition {
  const steps = parsePath(path);
  const rec = (node: ItemModelNode, depth: number, sofar: string): ItemModelNode => {
    if (depth === steps.length) return update(node);
    const step = steps[depth];
    const here = joinPath(sofar, stepText(step));
    return withChild(node, step, rec(child(node, step, here), depth + 1, here));
  };
  return { ...def, model: rec(def.model, 0, '') };
}

/** The direct children of a node with their path step and, for cases and entries, their index. */
export function childrenOf(node: ItemModelNode): { step: string; node: ItemModelNode }[] {
  switch (node.kind) {
    case 'composite':
      return node.models.map((m, i) => ({ step: `models/${i}`, node: m }));
    case 'condition':
      return [
        { step: 'on_true', node: node.onTrue },
        { step: 'on_false', node: node.onFalse },
      ];
    case 'select':
      return [...node.cases.map((c, i) => ({ step: `cases/${i}`, node: c.model })), ...(node.fallback ? [{ step: 'fallback', node: node.fallback }] : [])];
    case 'range_dispatch':
      return [...node.entries.map((e, i) => ({ step: `entries/${i}`, node: e.model })), ...(node.fallback ? [{ step: 'fallback', node: node.fallback }] : [])];
    default:
      return [];
  }
}

/** Every node, depth first, with its path. */
export function walk(def: ItemDefinition): { path: string; node: ItemModelNode; depth: number }[] {
  const out: { path: string; node: ItemModelNode; depth: number }[] = [];
  const rec = (node: ItemModelNode, path: string, depth: number) => {
    out.push({ path, node, depth });
    for (const c of childrenOf(node)) rec(c.node, joinPath(path, c.step), depth + 1);
  };
  rec(def.model, '', 0);
  return out;
}

/** The first model reference in a subtree (depth first), or ''. */
export function firstModelRef(node: ItemModelNode): string {
  if (node.kind === 'model') return node.model;
  if (node.kind === 'special') return node.base;
  for (const c of childrenOf(node)) {
    const found = firstModelRef(c.node);
    if (found) return found;
  }
  return '';
}

/** All model references in the definition (for "which models does this item use"). */
export function modelRefs(def: ItemDefinition): string[] {
  const refs = new Set<string>();
  for (const { node } of walk(def)) {
    if (node.kind === 'model' && node.model) refs.add(node.model);
    if (node.kind === 'special' && node.base) refs.add(node.base);
  }
  return [...refs];
}

// ---- creating and changing nodes -----------------------------------------------------------------

export const modelRef = (model: string, tints?: readonly TintSource[]): ModelRefNode => ({
  kind: 'model',
  type: 'minecraft:model',
  model,
  fields: {},
  ...(tints && tints.length > 0 ? { tints } : {}),
});

/** The property a new condition / select / range dispatch starts with. */
const DEFAULT_PROPERTY: Record<PropertyKind, string> = {
  condition: 'minecraft:custom_model_data',
  select: 'minecraft:custom_model_data',
  range_dispatch: 'minecraft:custom_model_data',
};

/**
 * A new node of the given type. `from` is the node it replaces: containers keep it as a part (as fallback of a
 * select / range dispatch, both branches of a condition, the first part of a composite), leaves take over its
 * first model reference.
 */
export function createNode(type: string, version: string, from?: ItemModelNode): ItemModelNode {
  const kind = kindForType(type);
  const ref = from ? firstModelRef(from) : '';
  const keep = from ?? modelRef(ref);
  const typeId = normalizeId(type);
  switch (kind) {
    case 'model':
      return { ...modelRef(ref), type: typeId, ...(from?.kind === 'model' && from.tints ? { tints: from.tints } : {}) };
    case 'composite':
      return { kind, type: typeId, fields: {}, models: [keep] };
    case 'condition': {
      const property = DEFAULT_PROPERTY.condition;
      return { kind, type: typeId, property, fields: initialFields(findProperty('condition', property, version)!.fields, version), onTrue: keep, onFalse: keep };
    }
    case 'select': {
      const property = DEFAULT_PROPERTY.select;
      return { kind, type: typeId, property, fields: initialFields(findProperty('select', property, version)!.fields, version), cases: [], fallback: keep };
    }
    case 'range_dispatch': {
      const property = DEFAULT_PROPERTY.range_dispatch;
      return { kind, type: typeId, property, fields: initialFields(findProperty('range_dispatch', property, version)!.fields, version), entries: [], fallback: keep };
    }
    case 'special': {
      const special = 'minecraft:chest';
      return { kind, type: typeId, base: ref || 'minecraft:item/chest', special: { type: special, fields: initialFields(findSpecialModel(special, version)!.fields, version) }, fields: {} };
    }
    case 'empty':
    case 'bundle_selected_item':
      return { kind, type: typeId, fields: {} };
    case 'unknown':
      return { kind, type: type.trim(), fields: {} };
  }
}

function kindForType(type: string): ItemNodeKind {
  const id = normalizeId(type);
  const kinds: Exclude<ItemNodeKind, 'unknown'>[] = ['model', 'composite', 'condition', 'select', 'range_dispatch', 'special', 'empty', 'bundle_selected_item'];
  return kinds.find((k) => typeIdOf(k) === id) ?? 'unknown';
}

/**
 * Changes a node's type. The transformation stays; a container's new parts are made from the old node (see
 * `createNode`).
 */
export function changeType(node: ItemModelNode, type: string, version: string): ItemModelNode {
  if (normalizeId(type) === normalizeId(node.type)) return node;
  const next = createNode(type, version, node);
  return node.transformation !== undefined && next.kind !== 'unknown' ? { ...next, transformation: node.transformation } : next;
}

/**
 * Switches the property of a condition, select or range dispatch: options of the old property are dropped,
 * the new property's required options start with example values, keys unknown to both stay.
 */
export function setProperty(node: ItemModelNode, property: string, version: string): ItemModelNode {
  if (node.kind !== 'condition' && node.kind !== 'select' && node.kind !== 'range_dispatch') throw new Error(`A ${node.type} node has no property`);
  const kind = node.kind;
  const id = normalizeId(property);
  if (id === normalizeId(node.property)) return node;
  const oldKeys = new Set((findProperty(kind, node.property, version)?.fields ?? []).map((f) => f.key));
  const spec = findProperty(kind, id, version);
  const fields: Record<string, Json> = {};
  for (const [k, v] of Object.entries(node.fields)) if (!oldKeys.has(k)) fields[k] = v;
  Object.assign(fields, spec ? initialFields(spec.fields, version) : {});
  return { ...node, property: id, fields };
}

/** Sets (or with null removes) keys of `fields`. */
export function patchFields(fields: Fields, patch: Readonly<Record<string, Json | undefined>>): Fields {
  const out: Record<string, Json> = { ...fields };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
}

/** A sensible "when" for a new select case: the first allowed value no case uses yet. */
export function nextCaseValue(node: ItemModelNode & { kind: 'select' }, version: string): Json {
  const used = new Set(node.cases.flatMap((c) => (Array.isArray(c.when) ? c.when : [c.when])).map((v) => JSON.stringify(v)));
  const spec = findSelectProperty(node.property, version);
  const candidates: Json[] = spec?.values.options ? [...spec.values.options] : [];
  for (const c of candidates) if (!used.has(JSON.stringify(c))) return c;
  for (let i = 1; ; i++) {
    const value = `variant_${i}`;
    if (!used.has(JSON.stringify(value))) return value;
  }
}

/** A threshold for a new range entry: one more than the largest so far (0 for the first). */
export function nextThreshold(node: ItemModelNode & { kind: 'range_dispatch' }): number {
  return node.entries.length === 0 ? 0 : Math.max(...node.entries.map((e) => e.threshold)) + 1;
}

/** Inserts into a list (at the end when `index` is undefined or too large). */
export function insertAt<T>(list: readonly T[], item: T, index?: number): T[] {
  const at = index === undefined ? list.length : Math.max(0, Math.min(index, list.length));
  return [...list.slice(0, at), item, ...list.slice(at)];
}

export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length) throw new Error(`There is no item ${from} (the list has ${list.length})`);
  const target = Math.max(0, Math.min(to, list.length - 1));
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item);
  return next;
}

export function removeAt<T>(list: readonly T[], index: number): T[] {
  if (index < 0 || index >= list.length) throw new Error(`There is no item ${index} (the list has ${list.length})`);
  return list.filter((_, i) => i !== index);
}

/** A new tint source of a type with its required options. */
export function createTint(type: string, version: string): TintSource {
  const id = normalizeId(type);
  return { type: id, fields: initialFields(findTintSource(id, version)?.fields ?? [], version) };
}

/** Changes a special model's type, starting its options afresh. */
export function createSpecial(type: string, version: string) {
  const id = normalizeId(type);
  return { type: id, fields: initialFields(findSpecialModel(id, version)?.fields ?? [], version) };
}

/** Case `when` as a list of values. */
export const whenValues = (c: SelectCase): Json[] => (Array.isArray(c.when) ? [...(c.when as Json[])] : [c.when]);

export { propertiesOf };
