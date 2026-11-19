// Which models an item definition renders for a given item and situation ("test inputs"), the way the
// client picks them: conditions, selects and range dispatches are followed, composites render all parts.
import { normalizeId } from './registry';
import { childrenOf, joinPath } from './tree';
import type { ItemDefinition, ItemModelNode, Json, TintSource } from './types';

/** The situation to test with. Everything is optional; missing values count as Minecraft's defaults. */
export interface ItemTestInputs {
  /** One of DISPLAY_CONTEXTS; default 'gui'. */
  readonly displayContext?: string;
  /** The custom_model_data component's lists. */
  readonly customModelData?: {
    readonly floats?: readonly number[];
    readonly flags?: readonly boolean[];
    readonly strings?: readonly string[];
    readonly colors?: readonly number[];
  };
  readonly damage?: number;
  readonly maxDamage?: number;
  readonly count?: number;
  readonly maxStackSize?: number;
  /** Other boolean properties by id ("minecraft:using_item": true); keybind_down by "minecraft:keybind_down/<key>". */
  readonly conditions?: Readonly<Record<string, boolean>>;
  /** Other select properties by id ("minecraft:main_hand": "left", "minecraft:trim_material": "minecraft:gold"). */
  readonly selects?: Readonly<Record<string, Json>>;
  /** Other numeric properties by id ("minecraft:use_duration": 12). */
  readonly numbers?: Readonly<Record<string, number>>;
}

/** A model that gets rendered. */
export interface RenderedModel {
  /** Node path of the leaf. */
  readonly path: string;
  readonly kind: ItemModelNode['kind'];
  /** Model reference of a model node, base of a special node; '' for others. */
  readonly model: string;
  readonly tints: readonly TintSource[];
  /** Special model type of a special node. */
  readonly special?: string;
  /** Transformations from the root down to the leaf (only nodes that have one). */
  readonly transformations: readonly Json[];
}

export interface EvaluationResult {
  readonly rendered: readonly RenderedModel[];
  /** Paths of every node on the way (for highlighting the active branch). */
  readonly visited: readonly string[];
  /** For each select / range / condition on the way: the value it saw and what it picked. */
  readonly decisions: readonly { path: string; property: string; value: Json; picked: string | null }[];
}

const RESOURCE_PROPERTIES = new Set(['minecraft:trim_material', 'minecraft:context_dimension', 'minecraft:context_entity_type']);

function jsonEqual(a: Json, b: Json): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function conditionValue(node: ItemModelNode & { kind: 'condition' }, inputs: ItemTestInputs): boolean {
  const id = normalizeId(node.property);
  const index = typeof node.fields.index === 'number' ? node.fields.index : 0;
  const damage = inputs.damage ?? 0;
  switch (id) {
    case 'minecraft:custom_model_data':
      return inputs.customModelData?.flags?.[index] ?? false;
    case 'minecraft:damaged':
      return damage > 0;
    case 'minecraft:broken':
      return inputs.maxDamage !== undefined && inputs.maxDamage > 0 && damage >= inputs.maxDamage - 1;
    case 'minecraft:keybind_down':
      return inputs.conditions?.[`${id}/${String(node.fields.keybind ?? '')}`] ?? inputs.conditions?.[id] ?? false;
    default:
      return inputs.conditions?.[id] ?? false;
  }
}

function selectValue(node: ItemModelNode & { kind: 'select' }, inputs: ItemTestInputs): Json | undefined {
  const id = normalizeId(node.property);
  const index = typeof node.fields.index === 'number' ? node.fields.index : 0;
  if (id === 'minecraft:display_context') return inputs.displayContext ?? 'gui';
  if (id === 'minecraft:custom_model_data') return inputs.customModelData?.strings?.[index];
  return inputs.selects?.[id];
}

function rangeValue(node: ItemModelNode & { kind: 'range_dispatch' }, inputs: ItemTestInputs): number {
  const id = normalizeId(node.property);
  const index = typeof node.fields.index === 'number' ? node.fields.index : 0;
  const normalize = node.fields.normalize !== false;
  switch (id) {
    case 'minecraft:custom_model_data':
      return inputs.customModelData?.floats?.[index] ?? 0;
    case 'minecraft:damage': {
      const damage = inputs.damage ?? 0;
      const max = inputs.maxDamage ?? 0;
      return normalize ? (max > 0 ? Math.min(1, Math.max(0, damage / max)) : 0) : Math.max(0, Math.min(damage, max || damage));
    }
    case 'minecraft:count': {
      const count = inputs.count ?? 1;
      const max = inputs.maxStackSize ?? 64;
      return normalize ? Math.min(1, Math.max(0, count / max)) : Math.max(0, Math.min(count, max));
    }
    default:
      return inputs.numbers?.[id] ?? 0;
  }
}

/** Whether a case value matches what the property reports (resource ids compare without "minecraft:"). */
function matches(when: Json, value: Json | undefined, property: string): boolean {
  if (value === undefined) return false;
  const values = Array.isArray(when) ? (when as Json[]) : [when];
  const resource = RESOURCE_PROPERTIES.has(normalizeId(property));
  return values.some((v) => (resource && typeof v === 'string' && typeof value === 'string' ? normalizeId(v) === normalizeId(value) : jsonEqual(v, value)));
}

/** Index of the entry a range dispatch picks: the highest threshold <= value, or -1. */
export function pickEntry(thresholds: readonly number[], value: number): number {
  let best = -1;
  for (let i = 0; i < thresholds.length; i++) if (thresholds[i] <= value && (best < 0 || thresholds[i] >= thresholds[best])) best = i;
  return best;
}

export function evaluateItem(def: ItemDefinition, inputs: ItemTestInputs = {}): EvaluationResult {
  const rendered: RenderedModel[] = [];
  const visited: string[] = [];
  const decisions: { path: string; property: string; value: Json; picked: string | null }[] = [];

  const visit = (node: ItemModelNode, path: string, transforms: readonly Json[], depth: number) => {
    if (depth > 64) return;
    visited.push(path);
    const chain = node.transformation !== undefined ? [...transforms, node.transformation] : transforms;
    switch (node.kind) {
      case 'composite':
        for (const c of childrenOf(node)) visit(c.node, joinPath(path, c.step), chain, depth + 1);
        return;
      case 'condition': {
        const value = conditionValue(node, inputs);
        const step = value ? 'on_true' : 'on_false';
        decisions.push({ path, property: normalizeId(node.property), value, picked: step });
        visit(value ? node.onTrue : node.onFalse, joinPath(path, step), chain, depth + 1);
        return;
      }
      case 'select': {
        const value = selectValue(node, inputs);
        const index = node.cases.findIndex((c) => matches(c.when, value, node.property));
        const step = index >= 0 ? `cases/${index}` : node.fallback ? 'fallback' : null;
        decisions.push({ path, property: normalizeId(node.property), value: value ?? null, picked: step });
        if (index >= 0) visit(node.cases[index].model, joinPath(path, step!), chain, depth + 1);
        else if (node.fallback) visit(node.fallback, joinPath(path, 'fallback'), chain, depth + 1);
        else rendered.push({ path, kind: 'unknown', model: '', tints: [], transformations: chain });
        return;
      }
      case 'range_dispatch': {
        const value = rangeValue(node, inputs) * (node.scale ?? 1);
        const index = pickEntry(
          node.entries.map((e) => e.threshold),
          value,
        );
        const step = index >= 0 ? `entries/${index}` : node.fallback ? 'fallback' : null;
        decisions.push({ path, property: normalizeId(node.property), value, picked: step });
        if (index >= 0) visit(node.entries[index].model, joinPath(path, step!), chain, depth + 1);
        else if (node.fallback) visit(node.fallback, joinPath(path, 'fallback'), chain, depth + 1);
        else rendered.push({ path, kind: 'unknown', model: '', tints: [], transformations: chain });
        return;
      }
      case 'model':
        rendered.push({ path, kind: node.kind, model: node.model, tints: node.tints ?? [], transformations: chain });
        return;
      case 'special':
        rendered.push({ path, kind: node.kind, model: node.base, tints: [], special: normalizeId(node.special.type), transformations: chain });
        return;
      default:
        rendered.push({ path, kind: node.kind, model: '', tints: [], transformations: chain });
    }
  };
  visit(def.model, '', [], 0);
  return { rendered, visited, decisions };
}
