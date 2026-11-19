import { describe, expect, it } from 'vitest';
import { exportJavaModel, javaModelObject } from './javaExport';
import { importJavaModel } from './javaImport';
import {
  appliedTransform,
  applyPreset,
  builtInPresets,
  clampTransform,
  displayIssues,
  displayRules,
  displaySlots,
  effectiveSlot,
  exportDisplay,
  findPreset,
  presetFrom,
  withSlot,
  type DisplayTransform,
} from './display';
import { minecraftApp } from './testing';

const model = (display: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ...extra, display });

describe('display rules (26.3)', () => {
  it('lists every slot with the game\'s ranges', () => {
    const rules = displayRules('26.3');
    expect(rules.slots).toEqual(displaySlots);
    expect(rules.slots).toContain('on_shelf');
    expect(rules.rotation).toEqual([-180, 180]);
    expect(rules.translation).toEqual([-80, 80]);
    expect(rules.scale).toEqual([-4, 4]);
  });

  it('wraps rotations and clamps translation and scale', () => {
    const t = clampTransform({ rotation: [190, -540, 180], translation: [100, -100, 3.33333333], scale: [5, -9, 0.5] }, displayRules('26.3'));
    expect(t).toEqual({ rotation: [-170, -180, 180], translation: [80, -80, 3.3333], scale: [4, -4, 0.5] });
  });
});

describe('display export', () => {
  it('writes only non-default parts, known slots in the game\'s order, unknown keys after', () => {
    const display = {
      custom_slot: { rotation: [1, 2, 3] },
      gui: { rotation: [30, 225, 0], translation: [0, 0, 0], scale: [0.625, 0.625, 0.625] },
      head: { rotation: [0, 0, 0], translation: [0, 0, 0], scale: [1, 1, 1] },
      thirdperson_righthand: { translation: [0, 3, 1], extra_field: true },
    };
    expect(exportDisplay({ display, parent: '', version: '26.3' })).toEqual({
      thirdperson_righthand: { translation: [0, 3, 1], extra_field: true },
      gui: { rotation: [30, 225, 0], scale: [0.625, 0.625, 0.625] },
      custom_slot: { rotation: [1, 2, 3] },
    });
  });

  it('keeps a slot that sets nothing when there is a parent, since it overrides the parent\'s', () => {
    const display = { head: { rotation: [0, 0, 0] } };
    expect(exportDisplay({ display, parent: '', version: '26.3' })).toBeUndefined();
    expect(exportDisplay({ display, parent: 'item/generated', version: '26.3' })).toEqual({ head: {} });
  });

  it('leaves malformed values as they came in', () => {
    const display = { gui: { rotation: 'sideways', scale: [2, 2, 2] }, ground: 5 };
    expect(exportDisplay({ display, parent: '', version: '26.3' })).toEqual({ ground: 5, gui: { rotation: 'sideways', scale: [2, 2, 2] } });
  });

  it('round-trips through import and export', () => {
    const display = {
      thirdperson_righthand: { rotation: [75, 45, 0], translation: [0, 2.5, 0], scale: [0.375, 0.375, 0.375] },
      firstperson_lefthand: { rotation: [0, 225, 0], scale: [0.4, 0.4, 0.4] },
      on_shelf: { translation: [0, -4, 2] },
      fixed: { scale: [-0.5, 0.5, 0.5] },
    };
    const { state, warnings } = importJavaModel(model(display));
    expect(warnings).toEqual([]);
    expect(state.java!.display).toEqual(display);
    const again = importJavaModel(exportJavaModel(state));
    expect(javaModelObject(again.state).display).toEqual({
      thirdperson_righthand: display.thirdperson_righthand,
      firstperson_lefthand: display.firstperson_lefthand,
      fixed: display.fixed,
      on_shelf: display.on_shelf,
    });
  });

  it('warns about unknown slots and out-of-range values on import, and keeps them', () => {
    const display = { embedded: { scale: [1, 1, 1] }, gui: { translation: [0, 100, 0], scale: 'big' } };
    const { state, warnings } = importJavaModel(model(display));
    expect(warnings).toEqual([
      'Display slot "embedded" is not known to Minecraft 26.3; it is kept as it is',
      '"translation" of display slot "gui" is outside -80..80; the game clamps it',
      '"scale" of display slot "gui" is not a list of three numbers',
    ]);
    expect(javaModelObject(state).display).toEqual({ gui: { translation: [0, 100, 0], scale: 'big' }, embedded: { scale: [1, 1, 1] } });
    expect(displayIssues('nope', '26.3')).toEqual(['"display" is not an object']);
  });
});

describe('left hands', () => {
  it('fall back to the right hand and show its mirror image', () => {
    const right: DisplayTransform = { rotation: [10, 20, 30], translation: [1, 2, 3], scale: [0.5, 0.5, 0.5] };
    const display = withSlot(undefined, 'thirdperson_righthand', right);
    expect(effectiveSlot(display, 'thirdperson_lefthand')).toEqual({ transform: right, source: 'right_hand' });
    expect(effectiveSlot(display, 'firstperson_lefthand').source).toBe('default');
    expect(effectiveSlot(display, 'gui')).toEqual({ transform: { rotation: [0, 0, 0], translation: [0, 0, 0], scale: [1, 1, 1] }, source: 'default' });
    expect(appliedTransform(right, true)).toEqual({ rotation: [10, -20, -30], translation: [-1, 2, 3], scale: [0.5, 0.5, 0.5] });
    expect(appliedTransform(right, false)).toBe(right);
  });
});

describe('display presets', () => {
  it('has the built-in presets', () => {
    expect(builtInPresets.map((p) => p.id)).toEqual(['default_item', 'default_block', 'default_handheld', 'default_rod', 'armor_stand_ground']);
    expect(builtInPresets[1].slots.gui).toEqual({ rotation: [30, 225, 0], translation: [0, 0, 0], scale: [0.625, 0.625, 0.625] });
  });

  it('applies all or only some slots of a preset', () => {
    const block = findPreset([], 'Default Block')!;
    const all = applyPreset(undefined, block);
    expect(Object.keys(all!)).toEqual(['thirdperson_righthand', 'firstperson_righthand', 'firstperson_lefthand', 'ground', 'gui', 'fixed']);
    const some = applyPreset({ head: { scale: [2, 2, 2] } }, block, ['gui', 'head']);
    expect(some).toEqual({ head: { scale: [2, 2, 2] }, gui: { rotation: [30, 225, 0], translation: [0, 0, 0], scale: [0.625, 0.625, 0.625] } });
  });

  it('makes user presets from the slots a model sets', () => {
    const display = { gui: { rotation: [1, 2, 3] } };
    expect(presetFrom(display, ' Mine ', ['gui', 'head'])).toEqual({ name: 'Mine', slots: { gui: { rotation: [1, 2, 3], translation: [0, 0, 0], scale: [1, 1, 1] } } });
    expect(findPreset([{ name: 'Mine', slots: {} }], 'mine')?.id).toBe('user:Mine');
  });
});

describe('display commands', () => {
  it('set, read, copy and reset slots', async () => {
    const t = await minecraftApp();
    await t.run('display.set_slot', { slot: 'gui', rotation: [30, 225, 0], scale: [0.625, 0.625, 0.625] });
    await t.run('display.set_slot', { slot: 'gui', rotation: [null, 200, null], translation: [0, 100, 0] });
    let got = await t.run('display.get');
    expect(got.slots.gui).toEqual({ slot: 'gui', rotation: [30, -160, 0], translation: [0, 80, 0], scale: [0.625, 0.625, 0.625], source: 'own' });
    expect(got.exported).toEqual({ gui: { rotation: [30, -160, 0], translation: [0, 80, 0], scale: [0.625, 0.625, 0.625] } });

    await t.run('display.copy_slot', { from: 'gui', to: ['fixed', 'ground'] });
    expect(t.state().java!.display!.fixed).toEqual(t.state().java!.display!.gui);

    await t.run('display.reset_slot', { slots: ['gui'], part: 'translation' });
    got = await t.run('display.get');
    expect(got.slots.gui.translation).toEqual([0, 0, 0]);
    await t.run('display.reset_slot', { slots: ['gui'] });
    expect((await t.run('display.get')).slots.gui.source).toBe('default');
    await t.run('display.reset_slot', {});
    expect(t.state().java!.display).toBeUndefined();
    expect(JSON.parse(exportJavaModel(t.state())).display).toBeUndefined();
  });

  it('left-hand slots start from the right hand\'s value', async () => {
    const t = await minecraftApp();
    await t.run('display.set_slot', { slot: 'thirdperson_righthand', rotation: [0, -90, 55], translation: [0, 4, 0.5] });
    expect((await t.run('display.get')).slots.thirdperson_lefthand.source).toBe('right_hand');
    await t.run('display.set_slot', { slot: 'thirdperson_lefthand', scale: [0.85, 0.85, 0.85] });
    expect(t.state().java!.display!.thirdperson_lefthand).toEqual({ rotation: [0, -90, 55], translation: [0, 4, 0.5], scale: [0.85, 0.85, 0.85] });
  });

  it('applies, saves and deletes presets, and is one undo step each', async () => {
    const t = await minecraftApp();
    await t.run('display.apply_preset', { preset: 'default_handheld', slots: ['thirdperson_righthand'] });
    expect(Object.keys(t.state().java!.display!)).toEqual(['thirdperson_righthand']);
    await t.run('history.undo');
    expect(t.state().java!.display).toBeUndefined();
    await t.run('history.redo');

    await t.run('display.save_preset', { name: 'Sword', slots: ['thirdperson_righthand', 'gui'] });
    const list = await t.run('display.list_presets');
    expect(list.at(-1)).toEqual({ id: 'user:Sword', name: 'Sword', builtIn: false, slots: { thirdperson_righthand: builtInPresets[2].slots.thirdperson_righthand } });
    await expect(t.run('display.save_preset', { name: 'Empty', slots: ['head'] })).rejects.toThrow(/empty/);

    await t.run('display.reset_slot', {});
    await t.run('display.apply_preset', { preset: 'sword' });
    expect(t.state().java!.display).toEqual({ thirdperson_righthand: builtInPresets[2].slots.thirdperson_righthand });
    await t.run('display.delete_preset', { name: 'Sword' });
    expect(t.app().preferences.displayPresets).toEqual([]);
    await expect(t.run('display.apply_preset', { preset: 'Sword' })).rejects.toThrow(/Unknown display preset/);
  });

  it('switches the GUI light and the view options', async () => {
    const t = await minecraftApp();
    await t.run('display.set_gui_light', { light: 'front' });
    expect(JSON.parse(exportJavaModel(t.state())).gui_light).toBe('front');
    await t.run('display.set_gui_light', { light: 'side' });
    expect(t.state().java!.guiLight).toBeNull();
    const view = await t.run('display.set_view', { slot: 'on_shelf', shelf: 'left', shelfAlign: 'top', handAngle: 45 });
    expect(view).toMatchObject({ slot: 'on_shelf', shelf: 'left', shelfAlign: 'top', handAngle: 45, thirdPerson: 'player' });
    await t.run('app.set_workspace', { workspace: 'display' });
    expect(t.app().workspace).toBe('display');
  });

  it('is refused in free documents', async () => {
    const t = await minecraftApp();
    await t.run('document.new', { name: 'Free' });
    await expect(t.run('display.set_slot', { slot: 'gui', scale: [2, 2, 2] })).rejects.toThrow(/only works in Minecraft Java/);
    await expect(t.run('app.set_workspace', { workspace: 'display' })).rejects.toThrow(/only available in Minecraft Java/);
  });
});
