// Display transforms of a Minecraft Java model: how the item is posed in each place the game shows it
// (hands, head, ground, GUI slot, item frame, shelf).
//
// The values live in `JavaModelSettings.display`, keyed by slot, exactly in the model JSON's shape
// ({ rotation, translation, scale }); an imported "display" stays there verbatim, so unknown slots or fields
// go back out unchanged. Like the exporter, what a version allows is a ranged entry (`displayRuleEntries`):
// a later version that adds a slot or changes a range adds an entry with `since` and ends the old one with
// `until`.
import { z } from 'zod';
import type { JavaModelSettings, Vec3 } from '../types';
import { tidy } from './space';
import { inRange, type Ranged } from './versions';

/** Every display slot Tessel knows, in the order Minecraft's own models write them. */
export const displaySlots = [
  'thirdperson_righthand',
  'thirdperson_lefthand',
  'firstperson_righthand',
  'firstperson_lefthand',
  'head',
  'ground',
  'gui',
  'fixed',
  'on_shelf',
] as const;
export type DisplaySlot = (typeof displaySlots)[number];

export const isDisplaySlot = (key: string): key is DisplaySlot => (displaySlots as readonly string[]).includes(key);

export const displayParts = ['rotation', 'translation', 'scale'] as const;
export type DisplayPart = (typeof displayParts)[number];

export interface DisplayTransform {
  /** Degrees around X, Y, Z (applied X first: Rx * Ry * Rz). */
  readonly rotation: Vec3;
  /** Pixels (1/16 block). */
  readonly translation: Vec3;
  /** Factor per axis; negative = mirrored on that axis. */
  readonly scale: Vec3;
}

export const IDENTITY: DisplayTransform = { rotation: [0, 0, 0], translation: [0, 0, 0], scale: [1, 1, 1] };

const PART_DEFAULT: Record<DisplayPart, Vec3> = { rotation: [0, 0, 0], translation: [0, 0, 0], scale: [1, 1, 1] };

/** What a version's models can say in "display". */
export interface DisplayRules {
  readonly slots: readonly DisplaySlot[];
  readonly rotation: readonly [number, number];
  readonly translation: readonly [number, number];
  readonly scale: readonly [number, number];
}

/** Display rules, oldest first; a version's rules are all entries in range merged in order. */
export const displayRuleEntries: readonly (Ranged & Partial<DisplayRules>)[] = [
  {
    since: '26.3',
    slots: displaySlots,
    rotation: [-180, 180],
    // The game clamps translation to +-80 px and scale to +-4.
    translation: [-80, 80],
    scale: [-4, 4],
  },
];

export function displayRules(version: string): DisplayRules {
  let merged: Partial<DisplayRules> = {};
  for (const entry of displayRuleEntries) {
    if (!inRange(entry, version)) continue;
    const { since: _since, until: _until, ...rules } = entry;
    merged = { ...merged, ...rules };
  }
  return merged as DisplayRules;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
const sameVec = (a: Readonly<Vec3>, b: Readonly<Vec3>) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/** The slot as written in the document, or null when the model does not set it. Malformed parts read as their default. */
export function readSlot(display: JavaModelSettings['display'], slot: DisplaySlot): DisplayTransform | null {
  const raw = display && Object.hasOwn(display, slot) ? display[slot] : undefined;
  if (!isObject(raw)) return null;
  return {
    rotation: isVec3(raw.rotation) ? [...raw.rotation] : [0, 0, 0],
    translation: isVec3(raw.translation) ? [...raw.translation] : [0, 0, 0],
    scale: isVec3(raw.scale) ? [...raw.scale] : [1, 1, 1],
  };
}

/** The right-hand slot a left-hand slot falls back to. */
export function rightHandOf(slot: DisplaySlot): DisplaySlot | null {
  if (slot === 'thirdperson_lefthand') return 'thirdperson_righthand';
  if (slot === 'firstperson_lefthand') return 'firstperson_righthand';
  return null;
}

export const isLeftHand = (slot: DisplaySlot): boolean => rightHandOf(slot) !== null;

/**
 * The transform the game uses for a slot: its own value, for a left hand without one the right hand's
 * (the game copies it), else no transform. `source` says where it came from.
 */
export function effectiveSlot(
  display: JavaModelSettings['display'],
  slot: DisplaySlot,
): { transform: DisplayTransform; source: 'own' | 'right_hand' | 'default' } {
  const own = readSlot(display, slot);
  if (own) return { transform: own, source: 'own' };
  const right = rightHandOf(slot);
  const fallback = right ? readSlot(display, right) : null;
  if (fallback) return { transform: fallback, source: 'right_hand' };
  return { transform: IDENTITY, source: 'default' };
}

/**
 * The transform as the game applies it: in a left hand the translation's X and the rotation's Y and Z are
 * negated, so a left-hand slot shows the mirror image of the same values in the right hand.
 */
export function appliedTransform(transform: DisplayTransform, leftHand: boolean): DisplayTransform {
  if (!leftHand) return transform;
  const [rx, ry, rz] = transform.rotation;
  const [tx, ty, tz] = transform.translation;
  return { rotation: [rx, -ry || 0, -rz || 0], translation: [-tx || 0, ty, tz], scale: transform.scale };
}

const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));

/** Rotation is wrapped into -180..180, translation and scale clamped to the version's ranges. */
export function clampTransform(transform: DisplayTransform, rules: DisplayRules): DisplayTransform {
  const wrap = (a: number) => {
    const w = ((((a + 180) % 360) + 360) % 360) - 180;
    return a === 180 ? 180 : tidy(w);
  };
  return {
    rotation: transform.rotation.map((a) => clamp(wrap(a), rules.rotation)) as Vec3,
    translation: transform.translation.map((v) => tidy(clamp(v, rules.translation))) as Vec3,
    scale: transform.scale.map((v) => tidy(clamp(v, rules.scale))) as Vec3,
  };
}

export const isIdentity = (t: DisplayTransform): boolean => displayParts.every((part) => sameVec(t[part], PART_DEFAULT[part]));

/**
 * A slot as JSON: only the parts that differ from the default, in the order rotation, translation, scale,
 * followed by whatever else the slot had (kept from an import). Returns undefined for a slot that would be
 * empty, unless `keepEmpty` (a model with a parent: an empty slot there still replaces the parent's).
 */
function slotJson(raw: Json, keepEmpty: boolean): Json | undefined {
  const out: Json = {};
  for (const part of displayParts) {
    const value = raw[part];
    if (value === undefined) continue;
    // Malformed values are not ours to fix: they go back out as they came in.
    if (!isVec3(value)) out[part] = value;
    else if (!sameVec(value, PART_DEFAULT[part])) out[part] = value.map(tidy);
  }
  for (const [key, value] of Object.entries(raw)) if (!(displayParts as readonly string[]).includes(key)) out[key] = value;
  if (Object.keys(out).length === 0 && !keepEmpty) return undefined;
  return out;
}

/**
 * The "display" object to export, or undefined if there is nothing to write. Known slots come first in the
 * game's order and only with their non-default parts; slots that set nothing are left out, except when the
 * model has a parent (there they override the parent's slot). Unknown keys are written back as they came.
 */
export function exportDisplay(java: Pick<JavaModelSettings, 'display' | 'parent' | 'version'>): Json | undefined {
  const display = java.display;
  if (!display) return undefined;
  const rules = displayRules(java.version);
  const hasParent = java.parent !== '';
  const out: Json = {};
  for (const slot of displaySlots) {
    if (!Object.hasOwn(display, slot) || !rules.slots.includes(slot)) continue;
    const raw = display[slot];
    const value = isObject(raw) ? slotJson(raw, hasParent) : raw;
    if (value !== undefined) out[slot] = value;
  }
  for (const [key, value] of Object.entries(display)) {
    if (!Object.hasOwn(out, key) && !(isDisplaySlot(key) && rules.slots.includes(key))) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** What is wrong with an imported "display", in English (for import warnings and the validator). */
export function displayIssues(display: unknown, version: string): string[] {
  if (display === undefined) return [];
  if (!isObject(display)) return ['"display" is not an object'];
  const rules = displayRules(version);
  const issues: string[] = [];
  for (const [key, raw] of Object.entries(display)) {
    if (!isDisplaySlot(key) || !rules.slots.includes(key)) {
      issues.push(`Display slot "${key}" is not known to Minecraft ${version}; it is kept as it is`);
      continue;
    }
    if (!isObject(raw)) {
      issues.push(`Display slot "${key}" is not an object`);
      continue;
    }
    for (const part of displayParts) {
      const value = raw[part];
      if (value === undefined) continue;
      if (!isVec3(value)) {
        issues.push(`"${part}" of display slot "${key}" is not a list of three numbers`);
        continue;
      }
      if (part === 'rotation') continue;
      const range = rules[part];
      if (value.some((v) => v < range[0] || v > range[1])) issues.push(`"${part}" of display slot "${key}" is outside ${range[0]}..${range[1]}; the game clamps it`);
    }
  }
  return issues;
}

/** A slot as stored by the commands: all three parts, so the editor shows what is set. */
export function slotValue(transform: DisplayTransform): Json {
  return { rotation: [...transform.rotation], translation: [...transform.translation], scale: [...transform.scale] };
}

/**
 * `display` with one slot replaced (null removes it, so it inherits again). Other keys of an imported slot
 * (unknown fields) are kept. Returns undefined when nothing is left.
 */
export function withSlot(display: JavaModelSettings['display'], slot: DisplaySlot, transform: DisplayTransform | null): JavaModelSettings['display'] {
  const next: Json = { ...(display ?? {}) };
  if (transform === null) delete next[slot];
  else {
    const previous = isObject(next[slot]) ? (next[slot] as Json) : {};
    next[slot] = { ...previous, ...slotValue(transform) };
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

// ---- Presets ----------------------------------------------------------------------------------------

export type DisplayValues = Partial<Record<DisplaySlot, DisplayTransform>>;

export interface DisplayPreset {
  /** Built-in presets have an id and a translated name; user presets are known by their name. */
  readonly id: string;
  readonly name: string;
  readonly builtIn: boolean;
  readonly slots: DisplayValues;
}

const t = (rotation: Vec3, translation: Vec3, s: number): DisplayTransform => ({ rotation, translation, scale: [s, s, s] });

/**
 * The display transforms of the game's own parent models (item/generated, block/block, item/handheld,
 * item/handheld_rod), so that a model without such a parent can look the same, plus one of Tessel's own.
 */
export const builtInPresets: readonly DisplayPreset[] = [
  {
    id: 'default_item',
    name: 'Default Item',
    builtIn: true,
    slots: {
      thirdperson_righthand: t([0, 0, 0], [0, 3, 1], 0.55),
      firstperson_righthand: t([0, -90, 25], [1.13, 3.2, 1.13], 0.68),
      head: t([0, 180, 0], [0, 13, 7], 1),
      ground: t([0, 0, 0], [0, 2, 0], 0.5),
      fixed: t([0, 180, 0], [0, 0, 0], 1),
    },
  },
  {
    id: 'default_block',
    name: 'Default Block',
    builtIn: true,
    slots: {
      thirdperson_righthand: t([75, 45, 0], [0, 2.5, 0], 0.375),
      firstperson_righthand: t([0, 45, 0], [0, 0, 0], 0.4),
      firstperson_lefthand: t([0, 225, 0], [0, 0, 0], 0.4),
      gui: t([30, 225, 0], [0, 0, 0], 0.625),
      ground: t([0, 0, 0], [0, 3, 0], 0.25),
      fixed: t([0, 0, 0], [0, 0, 0], 0.5),
    },
  },
  {
    id: 'default_handheld',
    name: 'Default Handheld / Weapon',
    builtIn: true,
    slots: {
      thirdperson_righthand: t([0, -90, 55], [0, 4, 0.5], 0.85),
      thirdperson_lefthand: t([0, 90, -55], [0, 4, 0.5], 0.85),
      firstperson_righthand: t([0, -90, 25], [1.13, 3.2, 1.13], 0.68),
      firstperson_lefthand: t([0, 90, -25], [1.13, 3.2, 1.13], 0.68),
    },
  },
  {
    id: 'default_rod',
    name: 'Default Rod',
    builtIn: true,
    slots: {
      thirdperson_righthand: t([0, 90, 55], [0, 4, 2.5], 0.85),
      thirdperson_lefthand: t([0, -90, -55], [0, 4, 2.5], 0.85),
      firstperson_righthand: t([0, 90, 25], [0, 1.6, 0.8], 0.68),
      firstperson_lefthand: t([0, -90, -25], [0, 1.6, 0.8], 0.68),
    },
  },
  {
    // Worn on the head of an (invisible) armor stand, the model stands on the ground where the armor stand
    // stands, at its true size and facing the way the armor stand faces: a common way to place decoration.
    id: 'armor_stand_ground',
    name: 'Armor Stand (Ground)',
    builtIn: true,
    slots: { head: t([0, 180, 0], [0, -30.4, 0], 1.6) },
  },
];

const finite = z.number().finite();
const vec3Schema = z.tuple([finite, finite, finite]);
export const displayTransformSchema = z.object({ rotation: vec3Schema, translation: vec3Schema, scale: vec3Schema });

export const MAX_DISPLAY_PRESETS = 100;

export const userPresetSchema = z.object({
  name: z.string().trim().min(1).max(60),
  slots: z.object(Object.fromEntries(displaySlots.map((s) => [s, displayTransformSchema.optional()])) as Record<DisplaySlot, z.ZodOptional<typeof displayTransformSchema>>),
});
export type UserDisplayPreset = z.infer<typeof userPresetSchema>;

/** Built-in presets first, then the user's. */
export function allPresets(user: readonly UserDisplayPreset[]): DisplayPreset[] {
  return [...builtInPresets, ...user.map((p) => ({ id: `user:${p.name}`, name: p.name, builtIn: false, slots: p.slots as DisplayValues }))];
}

/** A preset by id ("default_block", "user:My preset") or name, case-insensitively. */
export function findPreset(user: readonly UserDisplayPreset[], key: string): DisplayPreset | undefined {
  const all = allPresets(user);
  const lower = key.trim().toLowerCase();
  return all.find((p) => p.id === key) ?? all.find((p) => p.name.toLowerCase() === lower || p.id.toLowerCase() === lower);
}

/** `display` with the preset applied: its slots (only `only`, when given) replace the document's. */
export function applyPreset(display: JavaModelSettings['display'], preset: DisplayPreset, only?: readonly DisplaySlot[]): JavaModelSettings['display'] {
  let next = display;
  for (const slot of displaySlots) {
    const value = preset.slots[slot];
    if (!value || (only && !only.includes(slot))) continue;
    next = withSlot(next, slot, value);
  }
  return next;
}

/** The given slots of a document's display as a user preset (slots the model does not set are left out). */
export function presetFrom(display: JavaModelSettings['display'], name: string, slots: readonly DisplaySlot[]): UserDisplayPreset {
  const values: DisplayValues = {};
  for (const slot of slots) {
    const value = readSlot(display, slot);
    if (value) values[slot] = value;
  }
  return { name: name.trim(), slots: values };
}

// ---- Preview options (preferences) ------------------------------------------------------------------

export const thirdPersonReferences = ['player', 'zombie', 'baby_zombie', 'armor_stand', 'armor_stand_small'] as const;
export const firstPersonPoses = ['normal', 'bow', 'crossbow', 'horn', 'eating'] as const;
export const groundReferences = ['block', 'fox'] as const;
export const frameReferences = ['frame', 'invisible', 'top', 'top_invisible'] as const;
export const shelfReferences = ['all', 'left', 'center', 'right'] as const;
export const shelfAlignments = ['top', 'bottom'] as const;
export const guiReferences = ['slot', 'crafting', 'inventory', 'hotbar'] as const;

/** Fields of the preferences schema (src/core/preferences.ts): the Display workspace's view options and the user's presets. */
export const displayPreferenceFields = {
  displaySlot: z.enum(displaySlots).default('thirdperson_righthand').describe('Display workspace: the slot being edited and previewed.'),
  displayThirdPerson: z
    .enum(thirdPersonReferences)
    .default('player')
    .describe('Display workspace: who holds or wears the item in the third-person and head slots.'),
  displayHandAngle: z.number().min(-90).max(180).default(22.5).describe('Display workspace: how far the holding arm is raised, in degrees (preview only).'),
  displayHeadAngle: z.number().min(-90).max(90).default(0).describe('Display workspace: head pitch in the head slot, in degrees (preview only).'),
  displayFirstPerson: z.enum(firstPersonPoses).default('normal').describe('Display workspace: first-person pose (normal, charged bow or crossbow, horn tooting, eating).'),
  displayGround: z.enum(groundReferences).default('block').describe('Display workspace: what the dropped item lies next to (a block or a fox).'),
  displayGroundAnimation: z.boolean().default(false).describe('Display workspace: let the dropped item bob and spin like in the game.'),
  displayFrame: z.enum(frameReferences).default('frame').describe('Display workspace: item frame on a wall or on the floor (top), visible or invisible.'),
  displayShelf: z.enum(shelfReferences).default('all').describe('Display workspace: which shelf slots show the item.'),
  displayShelfAlign: z.enum(shelfAlignments).default('bottom').describe('Display workspace: items on the shelf aligned to its top or bottom.'),
  displayGui: z.enum(guiReferences).default('slot').describe('Display workspace: GUI preview as a single slot, the 3x3 crafting grid, the inventory or the hotbar.'),
  displayPresets: z.array(userPresetSchema).max(MAX_DISPLAY_PRESETS).default([]).describe('Display presets saved by the user.'),
};
