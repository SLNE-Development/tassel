import { z } from 'zod';
import {
  allPresets,
  applyPreset,
  clampTransform,
  displayPreferenceFields,
  displayParts,
  displayRules,
  displaySlots,
  effectiveSlot,
  exportDisplay,
  findPreset,
  IDENTITY,
  MAX_DISPLAY_PRESETS,
  presetFrom,
  readSlot,
  withSlot,
  type DisplaySlot,
  type DisplayTransform,
} from '../minecraft/display';
import { guiLights } from '../types';
import type { DocState, JavaModelSettings, Vec3 } from '../types';
import { defineCommand, docState, updateDocState, type CommandContext } from './registry';

// The Display workspace of Minecraft Java models: per-slot display transforms, presets and the preview's
// view options. Values are stored in `JavaModelSettings.display` (undoable, part of the document); view
// options and user presets are preferences (app-wide, not undoable).

const MC = ['minecraft_java'] as const;
const slotEnum = z.enum(displaySlots);
const finite = z.number().finite();
const partial3 = z.tuple([finite.nullable(), finite.nullable(), finite.nullable()]);

function requireJava(state: DocState): JavaModelSettings {
  if (!state.java) throw new Error('The document is not a Minecraft Java model');
  return state.java;
}

function updateDisplay(ctx: CommandContext, update: (java: JavaModelSettings) => JavaModelSettings['display']) {
  updateDocState(ctx, (s) => {
    const java = requireJava(s);
    const display = update(java);
    const { display: _old, ...rest } = java;
    return { ...s, java: display ? { ...rest, display } : rest };
  });
}

function slotResult(java: JavaModelSettings, slot: DisplaySlot) {
  const { transform, source } = effectiveSlot(java.display, slot);
  return { slot, ...transform, source };
}

function displayResult(state: DocState) {
  const java = requireJava(state);
  const rules = displayRules(java.version);
  return {
    slots: Object.fromEntries(rules.slots.map((slot) => [slot, slotResult(java, slot)])),
    guiLight: java.guiLight,
    ranges: { rotation: rules.rotation, translation: rules.translation, scale: rules.scale },
    exported: exportDisplay(java) ?? null,
  };
}

/** `base` with the non-null numbers of `change`. */
const merge = (base: Readonly<Vec3>, change: readonly (number | null)[] | undefined): Vec3 =>
  base.map((v, i) => (change && change[i] !== null && change[i] !== undefined ? change[i]! : v)) as Vec3;

const viewKeys = Object.keys(displayPreferenceFields).filter((k) => k !== 'displayPresets') as (keyof typeof displayPreferenceFields)[];
const viewParams = Object.fromEntries(viewKeys.map((key) => [key.replace(/^display/, '').replace(/^./, (c) => c.toLowerCase()), displayPreferenceFields[key].unwrap().optional()]));

export const displayCommands = [
  defineCommand({
    id: 'display.get',
    title: 'Display-Einstellungen abfragen',
    description:
      'Get the display transforms of a Minecraft Java model: for every slot (thirdperson_righthand, thirdperson_lefthand, firstperson_righthand, firstperson_lefthand, head, ground, gui, fixed = item frame, on_shelf) its rotation (degrees, X then Y then Z), translation (pixels) and scale, and where it comes from: "own" (set in the model), "right_hand" (a left hand without its own value uses the right hand\'s, mirrored, like the game) or "default" (no transform). Also gui_light, the allowed ranges and the "display" object as it will be exported (only non-default values).',
    params: z.object({}),
    history: false,
    formats: MC,
    run(ctx) {
      return displayResult(docState(ctx));
    },
  }),

  defineCommand({
    id: 'display.set_slot',
    title: 'Display-Slot ändern',
    description:
      'Set the display transform of one slot of a Minecraft Java model. Give whole vectors or per-axis values with null for "keep", e.g. rotation [null, 45, null]. rotation in degrees (-180..180, applied X then Y then Z), translation in pixels (-80..80), scale per axis (-4..4; negative mirrors that axis). Values outside the ranges are clamped. A slot that was not set starts from its current effective value (for a left hand: the right hand\'s).',
    params: z.object({
      slot: slotEnum,
      rotation: partial3.optional(),
      translation: partial3.optional(),
      scale: partial3.optional(),
    }),
    formats: MC,
    run(ctx, p) {
      const java = requireJava(docState(ctx));
      const base = effectiveSlot(java.display, p.slot).transform;
      const next = clampTransform(
        { rotation: merge(base.rotation, p.rotation), translation: merge(base.translation, p.translation), scale: merge(base.scale, p.scale) },
        displayRules(java.version),
      );
      updateDisplay(ctx, (j) => withSlot(j.display, p.slot, next));
      return slotResult(requireJava(docState(ctx)), p.slot);
    },
  }),

  defineCommand({
    id: 'display.reset_slot',
    title: 'Display-Slot zurücksetzen',
    description:
      'Reset display transforms of a Minecraft Java model. Without "part" the slot is removed (it then uses the default, or for a left hand the right hand\'s mirrored values, or the parent model\'s). With "part" only rotation, translation or scale goes back to its default (0, 0, 1). Without "slots" every slot is reset.',
    params: z.object({ slots: z.array(slotEnum).optional(), part: z.enum(displayParts).optional() }),
    formats: MC,
    run(ctx, p) {
      const slots = p.slots ?? displaySlots;
      updateDisplay(ctx, (java) => {
        let display = java.display;
        for (const slot of slots) {
          if (!p.part) {
            display = withSlot(display, slot, null);
            continue;
          }
          const current = readSlot(display, slot);
          if (current) display = withSlot(display, slot, { ...current, [p.part]: IDENTITY[p.part] });
        }
        return display;
      });
      return displayResult(docState(ctx));
    },
  }),

  defineCommand({
    id: 'display.copy_slot',
    title: 'Display-Slot kopieren',
    description: 'Copy the effective display transform of one slot of a Minecraft Java model onto other slots (like copy and paste in the Display workspace).',
    params: z.object({ from: slotEnum, to: z.array(slotEnum).min(1) }),
    formats: MC,
    run(ctx, p) {
      const java = requireJava(docState(ctx));
      const value = effectiveSlot(java.display, p.from).transform;
      updateDisplay(ctx, (j) => p.to.reduce((display, slot) => withSlot(display, slot, value), j.display));
      return displayResult(docState(ctx));
    },
  }),

  defineCommand({
    id: 'display.paste',
    title: 'Display-Werte einfügen',
    description:
      'Set one or more slots of a Minecraft Java model to a given transform { rotation, translation, scale } (all three parts, e.g. one copied from display_get). Values are clamped to the allowed ranges.',
    params: z.object({
      slots: z.array(slotEnum).min(1),
      transform: z.object({ rotation: z.tuple([finite, finite, finite]), translation: z.tuple([finite, finite, finite]), scale: z.tuple([finite, finite, finite]) }),
    }),
    formats: MC,
    run(ctx, p) {
      const java = requireJava(docState(ctx));
      const value: DisplayTransform = clampTransform(p.transform, displayRules(java.version));
      updateDisplay(ctx, (j) => p.slots.reduce((display, slot) => withSlot(display, slot, value), j.display));
      return displayResult(docState(ctx));
    },
  }),

  defineCommand({
    id: 'display.set_gui_light',
    title: 'GUI-Licht setzen',
    description: 'Set how a Minecraft Java model is lit in the GUI ("gui_light"): "side" (lit from the side like blocks; the game\'s default) or "front" (lit flat from the front like items).',
    params: z.object({ light: z.enum(guiLights) }),
    formats: MC,
    run(ctx, p) {
      // "side" is the game's default and is left out, unless a parent model could have set something else.
      updateDocState(ctx, (s) => {
        const java = requireJava(s);
        return { ...s, java: { ...java, guiLight: p.light === 'side' && java.parent === '' ? null : p.light } };
      });
      return { guiLight: requireJava(docState(ctx)).guiLight ?? 'side' };
    },
  }),

  defineCommand({
    id: 'display.list_presets',
    title: 'Display-Vorlagen auflisten',
    description:
      'List the display presets: the built-in ones (default_item, default_block, default_handheld, default_rod: the transforms of the game\'s item/generated, block/block, item/handheld and item/handheld_rod; armor_stand_ground: worn on an armor stand\'s head the model stands on the ground at full size) and the ones the user saved, each with the slots it sets.',
    params: z.object({}),
    history: false,
    run(ctx) {
      return allPresets(ctx.get().preferences.displayPresets);
    },
  }),

  defineCommand({
    id: 'display.apply_preset',
    title: 'Display-Vorlage anwenden',
    description: 'Apply a display preset (id or name, see display_list_presets) to a Minecraft Java model: the slots it sets replace the model\'s. "slots" limits it to some of them.',
    params: z.object({ preset: z.string().min(1), slots: z.array(slotEnum).optional() }),
    formats: MC,
    run(ctx, p) {
      const preset = findPreset(ctx.get().preferences.displayPresets, p.preset);
      if (!preset) throw new Error(`Unknown display preset "${p.preset}". Known: ${allPresets(ctx.get().preferences.displayPresets).map((x) => x.id).join(', ')}`);
      updateDisplay(ctx, (java) => applyPreset(java.display, preset, p.slots));
      return displayResult(docState(ctx));
    },
  }),

  defineCommand({
    id: 'display.save_preset',
    title: 'Display-Vorlage speichern',
    description:
      'Save the given slots of the Minecraft Java model\'s display as a user preset (stored with the preferences, available in every document). A preset with the same name is replaced. Slots the model does not set are left out.',
    params: z.object({ name: z.string().trim().min(1).max(60), slots: z.array(slotEnum).min(1) }),
    history: false,
    formats: MC,
    run(ctx, p) {
      const preset = presetFrom(requireJava(docState(ctx)).display, p.name, p.slots);
      if (Object.keys(preset.slots).length === 0) throw new Error('None of the chosen slots is set in this model, so the preset would be empty');
      const others = ctx.get().preferences.displayPresets.filter((x) => x.name.toLowerCase() !== preset.name.toLowerCase());
      if (others.length >= MAX_DISPLAY_PRESETS) throw new Error(`At most ${MAX_DISPLAY_PRESETS} display presets can be saved`);
      ctx.set((app) => ({ ...app, preferences: { ...app.preferences, displayPresets: [...others, preset] } }));
      return { id: `user:${preset.name}`, ...preset };
    },
  }),

  defineCommand({
    id: 'display.delete_preset',
    title: 'Display-Vorlage löschen',
    description: 'Delete a display preset the user saved (by name). Built-in presets cannot be deleted.',
    params: z.object({ name: z.string().min(1) }),
    history: false,
    run(ctx, p) {
      const name = p.name.replace(/^user:/, '').trim().toLowerCase();
      const presets = ctx.get().preferences.displayPresets;
      if (!presets.some((x) => x.name.toLowerCase() === name)) throw new Error(`There is no saved display preset "${p.name}"`);
      ctx.set((app) => ({ ...app, preferences: { ...app.preferences, displayPresets: presets.filter((x) => x.name.toLowerCase() !== name) } }));
      return { deleted: p.name };
    },
  }),

  defineCommand({
    id: 'display.get_view',
    title: 'Display-Vorschau abfragen',
    description: 'Get the view options of the Display workspace (the slot shown and the reference scene for each kind of slot). They are preview settings, not part of the model.',
    params: z.object({}),
    history: false,
    run(ctx) {
      const prefs = ctx.get().preferences;
      return Object.fromEntries(viewKeys.map((key) => [key.replace(/^display/, '').replace(/^./, (c) => c.toLowerCase()), prefs[key]]));
    },
  }),

  defineCommand({
    id: 'display.set_view',
    title: 'Display-Vorschau ändern',
    description:
      'Change the view of the Display workspace; only the given fields change. slot: the slot shown. thirdPerson: player, zombie, baby_zombie, armor_stand or armor_stand_small (hands and head). handAngle: how far the arm is raised, headAngle: head pitch (preview only). firstPerson: normal, bow (charged), crossbow (charged), horn (tooting) or eating. ground: block or fox; groundAnimation: bob and spin. frame: frame, invisible, top or top_invisible. shelf: all, left, center or right; shelfAlign: top or bottom. gui: slot, crafting (3x3), inventory or hotbar. Use app_set_workspace with "display" to show it.',
    params: z.object(viewParams) as z.ZodObject<Record<string, z.ZodOptional<z.ZodType>>>,
    history: false,
    run(ctx, p) {
      const changes = Object.fromEntries(
        Object.entries(p)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [`display${k[0].toUpperCase()}${k.slice(1)}`, v]),
      );
      ctx.set((app) => ({ ...app, preferences: { ...app.preferences, ...changes } }));
      const prefs = ctx.get().preferences;
      return Object.fromEntries(viewKeys.map((key) => [key.replace(/^display/, '').replace(/^./, (c) => c.toLowerCase()), prefs[key]]));
    },
  }),
];
