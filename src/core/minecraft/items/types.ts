// Data model of a Minecraft Java item model definition (`assets/<namespace>/items/<id>.json`, 1.21.4+).
//
// The tree mirrors the file: every node keeps the `type` exactly as written ("model" or "minecraft:model"),
// every key Tessel has no structural use for in `fields` (property options such as "index", tint options, and
// keys Tessel does not know at all), and the key order it was read in (`keyOrder`), so that reading and
// writing a file changes nothing but what was edited. See docs/research/item-definitions-26.3.md.

/** Any JSON value. */
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type JsonObject = { readonly [key: string]: Json };

/** Keys of a node that are not structural: property options, tint options, unknown keys. Written back unchanged. */
export type Fields = Readonly<Record<string, Json>>;

interface NodeBase {
  /** The type id as written in the file, e.g. "minecraft:select" or "select". */
  readonly type: string;
  /** Non-structural keys. */
  readonly fields: Fields;
  /** Optional `transformation` (matrix or decomposed), kept verbatim; absent = not written. */
  readonly transformation?: Json;
  /** Key order of the file this node was read from; absent for nodes made in Tessel. */
  readonly keyOrder?: readonly string[];
}

/** A tint source of a `minecraft:model` node: `type` plus its options in `fields`. */
export interface TintSource {
  readonly type: string;
  readonly fields: Fields;
  readonly keyOrder?: readonly string[];
}

/** `minecraft:model`: renders a block/item model. */
export interface ModelRefNode extends NodeBase {
  readonly kind: 'model';
  /** Model resource location, e.g. "minecraft:item/stick" or "mymod:item/gear". */
  readonly model: string;
  /** Absent = no "tints" key. */
  readonly tints?: readonly TintSource[];
}

/** `minecraft:composite`: renders all its models. */
export interface CompositeNode extends NodeBase {
  readonly kind: 'composite';
  readonly models: readonly ItemModelNode[];
}

/** `minecraft:condition`: a boolean property picks `onTrue` or `onFalse`. Property options are in `fields`. */
export interface ConditionNode extends NodeBase {
  readonly kind: 'condition';
  readonly property: string;
  readonly onTrue: ItemModelNode;
  readonly onFalse: ItemModelNode;
}

export interface SelectCase {
  /** A value or a list of values, in the property's value format (usually strings). */
  readonly when: Json;
  readonly model: ItemModelNode;
  /** Unknown keys of the case object. */
  readonly fields: Fields;
  readonly keyOrder?: readonly string[];
}

/** `minecraft:select`: the first case whose `when` matches the property value, else `fallback`. */
export interface SelectNode extends NodeBase {
  readonly kind: 'select';
  readonly property: string;
  readonly cases: readonly SelectCase[];
  readonly fallback?: ItemModelNode;
}

export interface RangeEntry {
  readonly threshold: number;
  readonly model: ItemModelNode;
  readonly fields: Fields;
  readonly keyOrder?: readonly string[];
}

/** `minecraft:range_dispatch`: the entry with the highest threshold <= value * scale, else `fallback`. */
export interface RangeDispatchNode extends NodeBase {
  readonly kind: 'range_dispatch';
  readonly property: string;
  /** Absent = not written (Minecraft's default 1). */
  readonly scale?: number;
  readonly entries: readonly RangeEntry[];
  readonly fallback?: ItemModelNode;
}

/** The `model` object of a special node: a hard-coded renderer and its options. */
export interface SpecialModel {
  readonly type: string;
  readonly fields: Fields;
  readonly keyOrder?: readonly string[];
}

/** `minecraft:special`: a hard-coded renderer (chest, banner, head, ...); `base` gives particles and display transforms. */
export interface SpecialNode extends NodeBase {
  readonly kind: 'special';
  readonly base: string;
  readonly special: SpecialModel;
}

/** `minecraft:empty` renders nothing; `minecraft:bundle/selected_item` renders the item selected in a bundle. */
export interface LeafNode extends NodeBase {
  readonly kind: 'empty' | 'bundle_selected_item';
}

/** A node of a type Tessel does not know (or whose structure did not match): everything but `type` in `fields`. */
export interface UnknownNode extends NodeBase {
  readonly kind: 'unknown';
}

export type ItemModelNode = ModelRefNode | CompositeNode | ConditionNode | SelectNode | RangeDispatchNode | SpecialNode | LeafNode | UnknownNode;
export type ItemNodeKind = ItemModelNode['kind'];

/** A whole item definition file. Root options (hand_animation_on_swap, ...) and unknown root keys are in `fields`. */
export interface ItemDefinition {
  readonly model: ItemModelNode;
  readonly fields: Fields;
  readonly keyOrder?: readonly string[];
}

/** The document of a Minecraft Java item definition ('minecraft_item' format). */
export interface ItemDocSettings {
  /** Target version id (core/minecraft/versions.ts). */
  readonly version: string;
  /** Namespace of the item, e.g. "minecraft" or "mymod". */
  readonly namespace: string;
  /** Item id without namespace and .json, e.g. "diamond_sword"; the file is assets/<namespace>/items/<id>.json. */
  readonly id: string;
  readonly definition: ItemDefinition;
}
