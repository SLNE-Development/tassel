// What item model definitions can contain, per Minecraft Java version.
//
// Every entry is ranged (`since` / `until`, see ../versions.ts) like the block model rules: to support a new
// version, add entries with `since: '<new>'` and close the ones it replaces with `until: '<new>'`. The facts
// come from the 26.3 client's codecs; docs/research/item-definitions-26.3.md lists the sources.
import { DEFAULT_NAMESPACE } from '../../minecraftAssets';
import { inRange, type Ranged } from '../versions';
import type { ItemNodeKind, Json } from './types';

/** How a field's value is edited and checked. */
export type FieldKind = 'boolean' | 'int' | 'float' | 'string' | 'enum' | 'resource' | 'color' | 'json';

/** Lists of known values the editor offers as suggestions (the field still accepts other values). */
export type SuggestionList = 'keybinds' | 'components' | 'componentPredicates' | 'trimMaterials' | 'dimensions' | 'entityTypes' | 'dyeColors' | 'chestTextures' | 'shulkerTextures' | 'blockStateProperties' | 'locales';

export interface FieldSpec extends Ranged {
  readonly key: string;
  readonly kind: FieldKind;
  /** Missing required fields are reported by the validator; the editor fills in `example` when adding. */
  readonly required?: boolean;
  /** Minecraft's value when the key is absent. */
  readonly default?: Json;
  /** A value to start with when the field is required. */
  readonly example?: Json;
  /** The only valid values (enum fields). */
  readonly options?: readonly string[];
  readonly suggestions?: SuggestionList;
  readonly min?: number;
  /** min is exclusive (e.g. use_cycle period > 0). */
  readonly minExclusive?: boolean;
}

/** The format of a select property's `when` values. */
export interface SelectValueSpec {
  readonly kind: 'enum' | 'string' | 'resource' | 'json';
  readonly options?: readonly string[];
  readonly suggestions?: SuggestionList;
}

export interface PropertySpec extends Ranged {
  /** Full id, e.g. "minecraft:custom_model_data". */
  readonly id: string;
  readonly fields: readonly FieldSpec[];
}

export interface SelectPropertySpec extends PropertySpec {
  readonly values: SelectValueSpec;
}

export interface TypeSpec extends Ranged {
  readonly id: string;
  readonly fields: readonly FieldSpec[];
}

export interface ModelTypeSpec extends Ranged {
  readonly id: string;
  readonly kind: Exclude<ItemNodeKind, 'unknown'>;
}

const since = '26.3';

export const DISPLAY_CONTEXTS = [
  'none',
  'thirdperson_lefthand',
  'thirdperson_righthand',
  'firstperson_lefthand',
  'firstperson_righthand',
  'head',
  'gui',
  'ground',
  'fixed',
  'on_shelf',
] as const;

export const DYE_COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'] as const;

/** Suggested values; `since`/`until` per list are not needed yet (the lists are hints, not rules). */
export const suggestionLists: Readonly<Record<SuggestionList, readonly string[]>> = {
  keybinds: [
    'key.attack',
    'key.use',
    'key.pickItem',
    'key.forward',
    'key.back',
    'key.left',
    'key.right',
    'key.jump',
    'key.sneak',
    'key.sprint',
    'key.drop',
    'key.swapOffhand',
    'key.inventory',
    'key.chat',
    'key.command',
    'key.playerlist',
    'key.togglePerspective',
    'key.smoothCamera',
    'key.screenshot',
    'key.spectatorOutlines',
    'key.advancements',
    'key.socialInteractions',
    'key.saveToolbarActivator',
    'key.loadToolbarActivator',
    ...Array.from({ length: 9 }, (_, i) => `key.hotbar.${i + 1}`),
  ],
  components: [
    'minecraft:custom_name',
    'minecraft:item_name',
    'minecraft:custom_model_data',
    'minecraft:damage',
    'minecraft:unbreakable',
    'minecraft:enchantments',
    'minecraft:stored_enchantments',
    'minecraft:enchantment_glint_override',
    'minecraft:dyed_color',
    'minecraft:potion_contents',
    'minecraft:trim',
    'minecraft:lodestone_tracker',
    'minecraft:bundle_contents',
    'minecraft:charged_projectiles',
    'minecraft:profile',
    'minecraft:base_color',
    'minecraft:banner_patterns',
    'minecraft:firework_explosion',
    'minecraft:fireworks',
    'minecraft:map_id',
    'minecraft:writable_book_content',
    'minecraft:written_book_content',
    'minecraft:rarity',
    'minecraft:tooltip_style',
    'minecraft:item_model',
    'minecraft:equippable',
    'minecraft:glider',
    'minecraft:food',
    'minecraft:consumable',
    'minecraft:tool',
    'minecraft:weapon',
    'minecraft:max_damage',
    'minecraft:max_stack_size',
    'minecraft:repair_cost',
    'minecraft:lore',
  ],
  componentPredicates: [
    'minecraft:damage',
    'minecraft:enchantments',
    'minecraft:stored_enchantments',
    'minecraft:potion_contents',
    'minecraft:custom_data',
    'minecraft:container',
    'minecraft:bundle_contents',
    'minecraft:firework_explosion',
    'minecraft:fireworks',
    'minecraft:writable_book_content',
    'minecraft:written_book_content',
    'minecraft:attribute_modifiers',
    'minecraft:trim',
    'minecraft:jukebox_playable',
  ],
  trimMaterials: ['minecraft:amethyst', 'minecraft:copper', 'minecraft:diamond', 'minecraft:emerald', 'minecraft:gold', 'minecraft:iron', 'minecraft:lapis', 'minecraft:netherite', 'minecraft:quartz', 'minecraft:redstone', 'minecraft:resin'],
  dimensions: ['minecraft:overworld', 'minecraft:the_nether', 'minecraft:the_end'],
  entityTypes: [
    'minecraft:player',
    'minecraft:armor_stand',
    'minecraft:item_frame',
    'minecraft:glow_item_frame',
    'minecraft:item_display',
    'minecraft:zombie',
    'minecraft:husk',
    'minecraft:drowned',
    'minecraft:skeleton',
    'minecraft:stray',
    'minecraft:wither_skeleton',
    'minecraft:piglin',
    'minecraft:piglin_brute',
    'minecraft:zombified_piglin',
    'minecraft:vindicator',
    'minecraft:pillager',
    'minecraft:villager',
    'minecraft:wandering_trader',
    'minecraft:fox',
    'minecraft:allay',
    'minecraft:copper_golem',
    'minecraft:horse',
    'minecraft:llama',
    'minecraft:wolf',
  ],
  dyeColors: DYE_COLORS,
  chestTextures: ['minecraft:normal', 'minecraft:trapped', 'minecraft:christmas', 'minecraft:ender', 'minecraft:copper', 'minecraft:copper_exposed', 'minecraft:copper_weathered', 'minecraft:copper_oxidized'],
  shulkerTextures: ['minecraft:shulker', ...DYE_COLORS.map((c) => `minecraft:shulker_${c}`)],
  blockStateProperties: ['level', 'honey_level', 'mode', 'copper_golem_pose', 'facing', 'age', 'lit', 'powered', 'waterlogged'],
  locales: ['', 'en_US', 'de_DE', 'fr_FR', 'es_ES', 'ja_JP', 'root'],
};

// ---- item model types ----------------------------------------------------------------------------

export const modelTypes: readonly ModelTypeSpec[] = [
  { id: 'minecraft:model', kind: 'model', since },
  { id: 'minecraft:composite', kind: 'composite', since },
  { id: 'minecraft:condition', kind: 'condition', since },
  { id: 'minecraft:select', kind: 'select', since },
  { id: 'minecraft:range_dispatch', kind: 'range_dispatch', since },
  { id: 'minecraft:special', kind: 'special', since },
  { id: 'minecraft:empty', kind: 'empty', since },
  { id: 'minecraft:bundle/selected_item', kind: 'bundle_selected_item', since },
];

/** Root keys of the file besides "model". */
export const rootFields: readonly FieldSpec[] = [
  { key: 'hand_animation_on_swap', kind: 'boolean', default: true, since },
  { key: 'oversized_in_gui', kind: 'boolean', default: false, since },
  { key: 'swap_animation_scale', kind: 'float', default: 1, since },
];

// ---- properties ----------------------------------------------------------------------------------

const index: FieldSpec = { key: 'index', kind: 'int', default: 0, min: 0, since };

export const conditionProperties: readonly PropertySpec[] = [
  { id: 'minecraft:broken', fields: [], since },
  { id: 'minecraft:bundle/has_selected_item', fields: [], since },
  { id: 'minecraft:carried', fields: [], since },
  {
    id: 'minecraft:component',
    fields: [
      { key: 'predicate', kind: 'resource', required: true, example: 'minecraft:damage', suggestions: 'componentPredicates', since },
      { key: 'value', kind: 'json', required: true, example: {}, since },
    ],
    since,
  },
  { id: 'minecraft:custom_model_data', fields: [index], since },
  { id: 'minecraft:damaged', fields: [], since },
  { id: 'minecraft:extended_view', fields: [], since },
  { id: 'minecraft:fishing_rod/cast', fields: [], since },
  {
    id: 'minecraft:has_component',
    fields: [
      { key: 'component', kind: 'resource', required: true, example: 'minecraft:custom_name', suggestions: 'components', since },
      { key: 'ignore_default', kind: 'boolean', default: false, since },
    ],
    since,
  },
  { id: 'minecraft:keybind_down', fields: [{ key: 'keybind', kind: 'string', required: true, example: 'key.use', suggestions: 'keybinds', since }], since },
  { id: 'minecraft:selected', fields: [], since },
  { id: 'minecraft:using_item', fields: [], since },
  { id: 'minecraft:view_entity', fields: [], since },
];

export const selectProperties: readonly SelectPropertySpec[] = [
  {
    id: 'minecraft:block_state',
    fields: [{ key: 'block_state_property', kind: 'string', required: true, example: 'level', suggestions: 'blockStateProperties', since }],
    values: { kind: 'string' },
    since,
  },
  { id: 'minecraft:charge_type', fields: [], values: { kind: 'enum', options: ['none', 'rocket', 'arrow'] }, since },
  {
    id: 'minecraft:component',
    fields: [{ key: 'component', kind: 'resource', required: true, example: 'minecraft:dyed_color', suggestions: 'components', since }],
    values: { kind: 'json' },
    since,
  },
  { id: 'minecraft:context_dimension', fields: [], values: { kind: 'resource', suggestions: 'dimensions' }, since },
  { id: 'minecraft:context_entity_type', fields: [], values: { kind: 'resource', suggestions: 'entityTypes' }, since },
  { id: 'minecraft:custom_model_data', fields: [index], values: { kind: 'string' }, since },
  { id: 'minecraft:display_context', fields: [], values: { kind: 'enum', options: DISPLAY_CONTEXTS }, since },
  {
    id: 'minecraft:local_time',
    fields: [
      { key: 'pattern', kind: 'string', required: true, example: 'MM-dd', since },
      { key: 'locale', kind: 'string', default: '', suggestions: 'locales', since },
      { key: 'time_zone', kind: 'string', since },
    ],
    values: { kind: 'string' },
    since,
  },
  { id: 'minecraft:main_hand', fields: [], values: { kind: 'enum', options: ['left', 'right'] }, since },
  { id: 'minecraft:trim_material', fields: [], values: { kind: 'resource', suggestions: 'trimMaterials' }, since },
];

export const rangeProperties: readonly PropertySpec[] = [
  { id: 'minecraft:bundle/fullness', fields: [], since },
  {
    id: 'minecraft:compass',
    fields: [
      { key: 'target', kind: 'enum', required: true, example: 'spawn', options: ['none', 'spawn', 'lodestone', 'recovery'], since },
      { key: 'wobble', kind: 'boolean', default: true, since },
    ],
    since,
  },
  { id: 'minecraft:cooldown', fields: [], since },
  { id: 'minecraft:count', fields: [{ key: 'normalize', kind: 'boolean', default: true, since }], since },
  { id: 'minecraft:crossbow/pull', fields: [], since },
  { id: 'minecraft:custom_model_data', fields: [index], since },
  { id: 'minecraft:damage', fields: [{ key: 'normalize', kind: 'boolean', default: true, since }], since },
  {
    id: 'minecraft:time',
    fields: [
      { key: 'source', kind: 'enum', required: true, example: 'daytime', options: ['daytime', 'moon_phase', 'random'], since },
      { key: 'wobble', kind: 'boolean', default: true, since },
    ],
    since,
  },
  { id: 'minecraft:use_cycle', fields: [{ key: 'period', kind: 'float', default: 1, min: 0, minExclusive: true, since }], since },
  { id: 'minecraft:use_duration', fields: [{ key: 'remaining', kind: 'boolean', default: false, since }], since },
];

// ---- tint sources and special models -------------------------------------------------------------

export const tintSources: readonly TypeSpec[] = [
  { id: 'minecraft:constant', fields: [{ key: 'value', kind: 'color', required: true, example: -1, since }], since },
  { id: 'minecraft:custom_model_data', fields: [index, { key: 'default', kind: 'color', default: -1, since }], since },
  { id: 'minecraft:dye', fields: [{ key: 'default', kind: 'color', required: true, example: -6265536, since }], since },
  { id: 'minecraft:firework', fields: [{ key: 'default', kind: 'color', required: true, example: -7697782, since }], since },
  {
    id: 'minecraft:grass',
    fields: [
      { key: 'temperature', kind: 'float', required: true, example: 0.5, min: 0, since },
      { key: 'downfall', kind: 'float', required: true, example: 1, min: 0, since },
    ],
    since,
  },
  { id: 'minecraft:potion', fields: [{ key: 'default', kind: 'color', required: true, example: -13083194, since }], since },
  { id: 'minecraft:team', fields: [{ key: 'default', kind: 'color', required: true, example: -1, since }], since },
  // minecraft:map_color existed until 26.2 and is gone in 26.3, Tessel's oldest target; files that still use it
  // keep it verbatim and the validator reports it as unknown.
];

export const specialModels: readonly TypeSpec[] = [
  {
    id: 'minecraft:banner',
    fields: [
      { key: 'color', kind: 'enum', required: true, example: 'white', options: DYE_COLORS, since },
      { key: 'attachment', kind: 'enum', default: 'ground', options: ['ground', 'wall'], since },
    ],
    since,
  },
  { id: 'minecraft:bell', fields: [], since },
  {
    id: 'minecraft:book',
    fields: [
      { key: 'open_angle', kind: 'float', required: true, example: 0, since },
      { key: 'page1', kind: 'float', required: true, example: 0, since },
      { key: 'page2', kind: 'float', required: true, example: 0, since },
    ],
    since,
  },
  {
    id: 'minecraft:chest',
    fields: [
      { key: 'texture', kind: 'resource', required: true, example: 'minecraft:normal', suggestions: 'chestTextures', since },
      { key: 'openness', kind: 'float', default: 0, min: 0, since },
      { key: 'chest_type', kind: 'enum', default: 'single', options: ['single', 'left', 'right'], since },
    ],
    since,
  },
  { id: 'minecraft:conduit', fields: [], since },
  {
    id: 'minecraft:copper_golem_statue',
    fields: [
      { key: 'texture', kind: 'resource', required: true, example: 'minecraft:textures/entity/copper_golem/copper_golem.png', since },
      { key: 'pose', kind: 'enum', required: true, example: 'standing', options: ['standing', 'running', 'sitting', 'star'], since },
    ],
    since,
  },
  { id: 'minecraft:decorated_pot', fields: [], since },
  { id: 'minecraft:end_cube', fields: [{ key: 'effect', kind: 'enum', required: true, example: 'portal', options: ['portal', 'gateway'], since }], since },
  {
    id: 'minecraft:head',
    fields: [
      { key: 'kind', kind: 'enum', required: true, example: 'skeleton', options: ['skeleton', 'wither_skeleton', 'player', 'zombie', 'creeper', 'piglin', 'dragon'], since },
      { key: 'texture', kind: 'resource', since },
      { key: 'animation', kind: 'float', default: 0, since },
    ],
    since,
  },
  { id: 'minecraft:player_head', fields: [], since },
  { id: 'minecraft:shield', fields: [], since },
  {
    id: 'minecraft:shulker_box',
    fields: [
      { key: 'texture', kind: 'resource', default: 'minecraft:shulker', suggestions: 'shulkerTextures', since },
      { key: 'openness', kind: 'float', default: 0, min: 0, since },
    ],
    since,
  },
  { id: 'minecraft:trident', fields: [], since },
];

// ---- lookups -------------------------------------------------------------------------------------

/** "select" -> "minecraft:select"; ids with a namespace stay as they are. Lower-cased and trimmed. */
export function normalizeId(id: string): string {
  const trimmed = id.trim();
  return trimmed.includes(':') ? trimmed : `${DEFAULT_NAMESPACE}:${trimmed}`;
}

/** "minecraft:select" -> "select"; other namespaces stay. For compact display. */
export function shortId(id: string): string {
  return id.startsWith(`${DEFAULT_NAMESPACE}:`) ? id.slice(DEFAULT_NAMESPACE.length + 1) : id;
}

const inVersion = <T extends Ranged>(list: readonly T[], version: string): T[] => list.filter((e) => inRange(e, version));

function find<T extends Ranged & { id: string }>(list: readonly T[], id: string, version: string): T | undefined {
  const full = normalizeId(id);
  return list.find((e) => e.id === full && inRange(e, version));
}

export type PropertyKind = 'condition' | 'select' | 'range_dispatch';

const propertyTables: Record<PropertyKind, readonly PropertySpec[]> = {
  condition: conditionProperties,
  select: selectProperties,
  range_dispatch: rangeProperties,
};

/** Everything a version knows, for the editor's dropdowns. */
export function itemSpecs(version: string) {
  return {
    modelTypes: inVersion(modelTypes, version),
    rootFields: inVersion(rootFields, version),
    conditionProperties: inVersion(conditionProperties, version),
    selectProperties: inVersion(selectProperties, version),
    rangeProperties: inVersion(rangeProperties, version),
    tintSources: inVersion(tintSources, version),
    specialModels: inVersion(specialModels, version),
  };
}

export const findModelType = (id: string, version: string): ModelTypeSpec | undefined => find(modelTypes, id, version);
export const findProperty = (kind: PropertyKind, id: string, version: string): PropertySpec | undefined => find(propertyTables[kind], id, version);
export const findSelectProperty = (id: string, version: string): SelectPropertySpec | undefined => find(selectProperties, id, version);
export const findTintSource = (id: string, version: string): TypeSpec | undefined => find(tintSources, id, version);
export const findSpecialModel = (id: string, version: string): TypeSpec | undefined => find(specialModels, id, version);
export const propertiesOf = (kind: PropertyKind, version: string): PropertySpec[] => inVersion(propertyTables[kind], version);

/** The fields of a spec that apply in the version. */
export const fieldsIn = (fields: readonly FieldSpec[], version: string): FieldSpec[] => inVersion(fields, version);

/** The id of a node kind's type, e.g. 'bundle_selected_item' -> "minecraft:bundle/selected_item". */
export function typeIdOf(kind: Exclude<ItemNodeKind, 'unknown'>): string {
  return modelTypes.find((t) => t.kind === kind)!.id;
}

/** Required fields filled with their example values: what a newly chosen property/tint/special starts with. */
export function initialFields(fields: readonly FieldSpec[], version: string): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const field of fieldsIn(fields, version)) if (field.required && field.example !== undefined) out[field.key] = field.example;
  return out;
}
