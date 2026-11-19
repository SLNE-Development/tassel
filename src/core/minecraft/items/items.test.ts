import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseProject, serializeProject } from '../../project';
import { activeDoc } from '../../state';
import { testApp } from '../testing';
import { nodeToJson, parseItemDefinitionText, serializeItemDefinition } from './codec';
import { itemLocationFromPath, modelLocationFromPath } from './document';
import { evaluateItem, pickEntry } from './evaluate';
import { conditionProperties, findProperty, itemSpecs, rangeProperties, selectProperties, specialModels, tintSources } from './registry';
import { variantsDefinition } from './templates';
import { changeType, getNode, setProperty, updateNode, walk } from './tree';
import type { ItemDefinition } from './types';
import { validateItemDefinition } from './validate';

const golden = (name: string) => new URL(`../golden/26.3/items/${name}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const read = (name: string) => readFileSync(golden(name), 'utf8');

describe('item definition registry (26.3)', () => {
  it('knows exactly the ids of the 26.3 client', () => {
    const specs = itemSpecs('26.3');
    expect(specs.modelTypes.map((t) => t.id)).toEqual([
      'minecraft:model',
      'minecraft:composite',
      'minecraft:condition',
      'minecraft:select',
      'minecraft:range_dispatch',
      'minecraft:special',
      'minecraft:empty',
      'minecraft:bundle/selected_item',
    ]);
    expect(conditionProperties.map((p) => p.id.slice(10))).toEqual([
      'broken',
      'bundle/has_selected_item',
      'carried',
      'component',
      'custom_model_data',
      'damaged',
      'extended_view',
      'fishing_rod/cast',
      'has_component',
      'keybind_down',
      'selected',
      'using_item',
      'view_entity',
    ]);
    expect(selectProperties.map((p) => p.id.slice(10))).toEqual([
      'block_state',
      'charge_type',
      'component',
      'context_dimension',
      'context_entity_type',
      'custom_model_data',
      'display_context',
      'local_time',
      'main_hand',
      'trim_material',
    ]);
    expect(rangeProperties.map((p) => p.id.slice(10))).toEqual(['bundle/fullness', 'compass', 'cooldown', 'count', 'crossbow/pull', 'custom_model_data', 'damage', 'time', 'use_cycle', 'use_duration']);
    // map_color was removed in 26.3.
    expect(tintSources.map((p) => p.id.slice(10))).toEqual(['constant', 'custom_model_data', 'dye', 'firework', 'grass', 'potion', 'team']);
    expect(specialModels.map((p) => p.id.slice(10))).toEqual([
      'banner',
      'bell',
      'book',
      'chest',
      'conduit',
      'copper_golem_statue',
      'decorated_pot',
      'end_cube',
      'head',
      'player_head',
      'shield',
      'shulker_box',
      'trident',
    ]);
    expect(findProperty('select', 'display_context', '26.3')?.id).toBe('minecraft:display_context');
  });
});

describe('item definition codec', () => {
  it('reads and writes a file using every feature without changing a byte (golden file)', () => {
    const text = read('roundtrip-input.json');
    const def = parseItemDefinitionText(text);
    expect(serializeItemDefinition(def)).toBe(text);
  });

  it('types the known parts and keeps the rest', () => {
    const def = parseItemDefinitionText(read('roundtrip-input.json'));
    expect(def.fields).toEqual({ hand_animation_on_swap: false, oversized_in_gui: true, swap_animation_scale: 1.95, 'mymod:extra': { kept: true } });
    const range = getNode(def, 'cases/0');
    expect(range).toMatchObject({ kind: 'range_dispatch', property: 'minecraft:custom_model_data', scale: 2.5, fields: { index: 1 } });
    expect(getNode(def, 'cases/0/entries/1')).toMatchObject({ kind: 'model', model: 'mymod:item/ruby_sword_1' });
    expect(getNode(def, 'cases/1')).toMatchObject({ kind: 'special', base: 'minecraft:item/template_skull', special: { type: 'minecraft:head', fields: { kind: 'creeper', animation: 0.5 } } });
    expect(getNode(def, 'cases/2')).toMatchObject({ kind: 'composite', type: 'composite' });
    expect(getNode(def, 'cases/2/models/0/on_true').kind).toBe('bundle_selected_item');
    expect(getNode(def, 'cases/2/models/1/on_true').fields).toEqual({ tessel_note: 'kept' });
    expect(getNode(def, 'fallback/fallback')).toMatchObject({ kind: 'unknown', type: 'mymod:future_type' });
    expect(walk(def).map((n) => n.path)).toContain('fallback/cases/0');
  });

  it('keeps a node whose structure is broken as it is', () => {
    const text = read('broken-input.json');
    const def = parseItemDefinitionText(text);
    expect(def.model.kind).toBe('unknown');
    expect(serializeItemDefinition(def)).toBe(text);
    expect(validateItemDefinition(def, '26.3').map((i) => i.code)).toEqual(['unknownType']);
  });

  it('rejects text that is not an item definition', () => {
    expect(() => parseItemDefinitionText('nope')).toThrow(/not valid JSON/);
    expect(() => parseItemDefinitionText('[]')).toThrow(/not a JSON object/);
    expect(() => parseItemDefinitionText('{"model": "item/stick"}')).toThrow(/no "model" object/);
  });

  it('writes new nodes with "type" first and the other keys alphabetically, like vanilla', () => {
    const def = parseItemDefinitionText('{"model":{"type":"minecraft:model","model":"item/stick"}}');
    const changed = updateNode(def, '', (n) => changeType(n, 'minecraft:select', '26.3'));
    expect(Object.keys(nodeToJson(changed.model))).toEqual(['type', 'cases', 'fallback', 'property']);
  });

  it('reads the BOM some editors write', () => {
    expect(parseItemDefinitionText('\uFEFF{"model":{"type":"minecraft:empty"}}').model.kind).toBe('empty');
  });
});

describe('item definition evaluation', () => {
  const def = parseItemDefinitionText(read('roundtrip-input.json'));

  it('follows display context, custom model data and range thresholds', () => {
    const gui = evaluateItem(def, { displayContext: 'gui', customModelData: { floats: [0, 0.7] } });
    // 0.7 * scale 2.5 = 1.75 >= 1.5
    expect(gui.rendered.map((r) => r.model)).toEqual(['mymod:item/ruby_sword_1']);
    expect(gui.rendered[0].tints).toHaveLength(5);
    expect(gui.visited).toEqual(['', 'cases/0', 'cases/0/entries/1']);
    const low = evaluateItem(def, { displayContext: 'ground', customModelData: { floats: [0, 0.1] } });
    expect(low.rendered.map((r) => r.model)).toEqual(['mymod:item/ruby_sword_0']);
    const negative = evaluateItem(def, { displayContext: 'ground', customModelData: { floats: [0, -1] } });
    expect(negative.rendered.map((r) => r.path)).toEqual(['cases/0/fallback']);
  });

  it('renders every part of a composite and records transformations', () => {
    const fp = evaluateItem(def, { displayContext: 'firstperson_righthand', conditions: { 'minecraft:using_item': true, 'minecraft:keybind_down/key.use': true } });
    expect(fp.rendered.map((r) => [r.path, r.kind, r.model])).toEqual([
      ['cases/2/models/0/on_true', 'bundle_selected_item', ''],
      ['cases/2/models/1/on_true', 'model', 'item/blaze_rod'],
      ['cases/2/models/2/on_false', 'model', 'item/stick'],
    ]);
    const head = evaluateItem(def, { displayContext: 'head' });
    expect(head.rendered[0]).toMatchObject({ kind: 'special', special: 'minecraft:head', model: 'minecraft:item/template_skull' });
    expect(head.rendered[0].transformations).toHaveLength(1);
  });

  it('falls back when nothing matches and reports the decision', () => {
    const result = evaluateItem(def, { displayContext: 'thirdperson_lefthand', selects: { 'minecraft:local_time': '12-25' } });
    expect(result.rendered[0]).toMatchObject({ kind: 'special', special: 'minecraft:chest' });
    expect(result.decisions.map((d) => d.picked)).toEqual(['fallback', 'cases/0']);
  });

  it('derives damage, broken and count values', () => {
    const tool = parseItemDefinitionText(
      JSON.stringify({
        model: {
          type: 'minecraft:condition',
          property: 'minecraft:broken',
          on_true: { type: 'minecraft:model', model: 'item/broken' },
          on_false: {
            type: 'minecraft:range_dispatch',
            property: 'minecraft:damage',
            entries: [
              { threshold: 0.5, model: { type: 'minecraft:model', model: 'item/worn' } },
              { threshold: 0, model: { type: 'minecraft:model', model: 'item/new' } },
            ],
          },
        },
      }),
    );
    const pick = (damage: number) => evaluateItem(tool, { damage, maxDamage: 100 }).rendered[0].model;
    expect(pick(0)).toBe('item/new');
    expect(pick(60)).toBe('item/worn');
    expect(pick(99)).toBe('item/broken');
    // Like the game (entries sorted, last one <= value), the later of two equal thresholds wins.
    expect(pickEntry([0, 1, 1, 0.5], 1)).toBe(2);
    expect(pickEntry([1, 2], 0.5)).toBe(-1);
  });
});

describe('item definition validation', () => {
  it('reports what 26.3 would not accept', () => {
    const def = parseItemDefinitionText(read('roundtrip-input.json'));
    const issues = validateItemDefinition(def, '26.3');
    expect(issues.map((i) => [i.code, i.path, i.subject ?? null])).toEqual([
      ['unknownField', null, 'mymod:extra'],
      ['unknownTint', 'cases/0/entries/1', '4'],
      ['unknownField', 'cases/2/models/1/on_true', 'tessel_note'],
      ['unknownType', 'fallback/fallback', 'mymod:future_type'],
    ]);
    expect(issues.every((i) => i.severity === 'warning')).toBe(true);
  });

  it('checks required fields, values and model references', () => {
    const def: ItemDefinition = parseItemDefinitionText(
      JSON.stringify({
        model: {
          type: 'minecraft:select',
          property: 'minecraft:main_hand',
          cases: [
            { when: 'middle', model: { type: 'minecraft:model', model: '' } },
            { when: 'left', model: { type: 'minecraft:model', model: 'Bad Name' } },
            { when: 'left', model: { type: 'minecraft:special', base: 'item/chest', model: { type: 'minecraft:chest', openness: 'wide' } } },
          ],
        },
      }),
    );
    expect(validateItemDefinition(def, '26.3').map((i) => `${i.severity}:${i.code}:${i.path}`)).toEqual([
      'error:invalidWhen:cases/0',
      'warning:duplicateWhen:cases/2',
      'warning:noFallback:',
      'error:missingModel:cases/0',
      'error:invalidResource:cases/1',
      'error:missingField:cases/2',
      'error:invalidField:cases/2',
    ]);
    const empty = parseItemDefinitionText('{"model":{"type":"minecraft:select","property":"minecraft:charge_type","cases":[],"fallback":{"type":"minecraft:empty"}}}');
    expect(validateItemDefinition(empty, '26.3').map((i) => i.code)).toEqual(['noCases']);
  });
});

describe('item definition editing', () => {
  it('wraps a node when its type changes and resets property options', () => {
    const def = parseItemDefinitionText('{"model":{"type":"minecraft:model","model":"mymod:item/gear","transformation":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}}');
    const condition = changeType(def.model, 'condition', '26.3');
    expect(nodeToJson(condition)).toEqual({
      type: 'minecraft:condition',
      on_false: { type: 'minecraft:model', model: 'mymod:item/gear', transformation: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
      on_true: { type: 'minecraft:model', model: 'mymod:item/gear', transformation: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
      property: 'minecraft:custom_model_data',
      transformation: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    });
    const keybind = setProperty({ ...condition, fields: { index: 2, custom: 1 } }, 'keybind_down', '26.3');
    expect(keybind.fields).toEqual({ custom: 1, keybind: 'key.use' });
    expect(changeType(condition, 'minecraft:model', '26.3')).toMatchObject({ kind: 'model', model: 'mymod:item/gear' });
  });

  it('builds the custom_model_data variants of the wizard (golden file)', async () => {
    const variants = [{ model: 'mymod:item/ruby_sword_flame', value: 1 }, { model: 'mymod:item/ruby_sword_frost', value: 2 }];
    const text = ['range', 'select', 'flags']
      .map((mode) =>
        serializeItemDefinition(
          variantsDefinition('mymod:item/ruby_sword', mode === 'select' ? variants.map((v, i) => ({ ...v, value: ['flame', 'frost'][i] })) : variants, mode as 'range', mode === 'flags' ? 1 : 0),
        ),
      )
      .join('');
    await expect(text).toMatchFileSnapshot(golden('variants-export.json'));
    const range = variantsDefinition('b', variants, 'range');
    expect(evaluateItem(range, { customModelData: { floats: [2] } }).rendered[0].model).toBe('mymod:item/ruby_sword_frost');
    expect(evaluateItem(range, {}).rendered[0].model).toBe('b');
    const flags = variantsDefinition('b', variants, 'flags', 1);
    expect(evaluateItem(flags, { customModelData: { flags: [false, false, true] } }).rendered[0].model).toBe('mymod:item/ruby_sword_frost');
  });

  it('finds item and model locations in resource pack paths', () => {
    expect(itemLocationFromPath('C:\\packs\\x\\assets\\mymod\\items\\tools\\ruby.json')).toEqual({ namespace: 'mymod', id: 'tools/ruby' });
    expect(itemLocationFromPath('assets/minecraft/items/stick.json')).toEqual({ namespace: 'minecraft', id: 'stick' });
    expect(itemLocationFromPath('assets/minecraft/models/item/stick.json')).toBeNull();
    expect(modelLocationFromPath('/r/assets/mymod/models/item/ruby.json')).toBe('mymod:item/ruby');
  });
});

describe('item definition commands', () => {
  it('builds a definition through the commands and exports it (golden file)', async () => {
    const t = testApp();
    const created = await t.run('document.new_item', { namespace: 'mymod', itemId: 'ruby_sword', model: 'mymod:item/ruby_sword' });
    expect(created).toMatchObject({ format: 'minecraft_item', file: 'assets/mymod/items/ruby_sword.json' });
    await t.run('item.set_type', { path: '', type: 'minecraft:select' });
    await t.run('item.update_node', { path: '', property: 'minecraft:display_context' });
    const added = await t.run('item.add_child', { path: '', when: ['gui', 'fixed'] });
    expect(added.path).toBe('cases/0');
    await t.run('item.update_node', { path: 'cases/0', model: 'mymod:item/ruby_sword_gui' });
    await t.run('item.add_tint', { path: 'cases/0', type: 'dye' });
    await t.run('item.add_tint', { path: 'cases/0', type: 'minecraft:constant', fields: { value: -65536 } });
    await t.run('item.move_tint', { path: 'cases/0', from: 1, to: 0 });
    await t.run('item.add_child', { path: '' });
    await t.run('item.set_type', { path: 'cases/1', type: 'minecraft:special' });
    await t.run('item.update_node', { path: 'cases/1', specialType: 'minecraft:shulker_box', specialFields: { openness: 0.5 }, base: 'minecraft:item/shulker_box' });
    await t.run('item.update_child', { path: '', index: 1, when: 'head' });
    await t.run('item.set_type', { path: 'fallback', type: 'minecraft:range_dispatch' });
    await t.run('item.update_node', { path: 'fallback', property: 'minecraft:damage', fields: { normalize: false }, scale: 0.5 });
    await t.run('item.add_child', { path: 'fallback', threshold: 10, json: { type: 'minecraft:model', model: 'mymod:item/ruby_sword_worn' } });
    await t.run('item.set_settings', { swapAnimationScale: 1.5, handAnimationOnSwap: false });
    const exported = await t.run('item.export_json');
    expect(exported.fileName).toBe('ruby_sword.json');
    expect(exported.path).toBe('assets/mymod/items/ruby_sword.json');
    await expect(exported.text).toMatchFileSnapshot(golden('built-export.json'));
    expect((await t.run('item.validate')).valid).toBe(true);
    const outline = await t.run('item.get');
    expect(outline.nodes.map((n: { path: string }) => n.path)).toEqual(['', 'cases/0', 'cases/1', 'fallback', 'fallback/entries/0', 'fallback/fallback']);
    const evaluated = await t.run('item.evaluate', { displayContext: 'gui' });
    expect(evaluated.rendered[0].model).toBe('mymod:item/ruby_sword_gui');

    // Undo goes back step by step; the history belongs to the document like any other.
    await t.run('history.undo');
    expect((await t.run('item.get')).json.swap_animation_scale).toBeUndefined();
  });

  it('opens a file, keeps it exactly and stores it in a .tessel project', async () => {
    const t = testApp();
    const text = read('roundtrip-input.json');
    const opened = await t.run('document.import_item', { json: text, filePath: 'C:/pack/assets/mymod/items/ruby_sword.json' });
    expect(opened).toMatchObject({ name: 'ruby_sword', file: 'assets/mymod/items/ruby_sword.json' });
    expect((await t.run('item.export_json')).text).toBe(text);
    const doc = activeDoc(t.app());
    expect(doc.filePath).toBe('C:/pack/assets/mymod/items/ruby_sword.json');
    const restored = parseProject(serializeProject(doc));
    expect(restored.state.format).toBe('minecraft_item');
    expect(serializeItemDefinition(restored.state.item!.definition)).toBe(text);
  });

  it('only allows item and document level commands in an item definition', async () => {
    const t = testApp();
    await t.run('document.new_item', { itemId: 'stick', model: 'minecraft:item/stick' });
    await expect(t.run('scene.add_primitive', { type: 'cube' })).rejects.toThrow(/not available in Minecraft Item Definition documents/);
    await expect(t.run('cuboid.add', {})).rejects.toThrow(/not available/);
    await expect(t.run('item.set_node', { path: 'cases/0', json: { type: 'minecraft:empty' } })).rejects.toThrow(/does not exist/);
    await expect(t.run('item.set_node', { path: '', json: { model: 'x' } })).rejects.toThrow(/must be an item model object/);
    await expect(t.run('item.set_settings', { itemId: 'Bad Id' })).rejects.toThrow(/not a valid item id/);
    expect((await t.run('document.list')).documents[1].format).toBe('minecraft_item');
    await t.run('document.new', { name: 'Free' });
    await expect(t.run('item.get')).rejects.toThrow(/only works in Minecraft Item Definition documents/);
  });

  it('creates an item definition for a Minecraft Java model', async () => {
    const t = testApp();
    await t.run('document.new', { name: 'Ruby Gem', format: 'minecraft_java', fileName: 'ruby_gem' });
    const created = await t.run('minecraft.create_item_definition', { namespace: 'mymod' });
    expect(created).toMatchObject({ name: 'ruby_gem', file: 'assets/mymod/items/ruby_gem.json' });
    expect((await t.run('item.get')).json).toEqual({ model: { type: 'minecraft:model', model: 'minecraft:item/ruby_gem' } });
    await t.run('document.switch', { id: t.app().docOrder[1] });
    await t.run('minecraft.create_item_definition', { model: 'mymod:item/ruby_gem', variants: { mode: 'select', variants: [{ model: 'mymod:item/ruby_gem_cut', value: 'cut' }] } });
    expect((await t.run('item.get')).json.model).toMatchObject({ type: 'minecraft:select', fallback: { model: 'mymod:item/ruby_gem' } });
  });
});
