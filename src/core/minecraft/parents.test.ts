import { describe, expect, it } from 'vitest';
import type { ModelFileService } from '../modelFiles';
import type { JavaImage } from '../types';
import { exportJavaModel } from './javaExport';
import { MISSING_TEXTURE_PNG } from './javaImport';
import { openJavaModelWithParents } from './openModel';
import {
  effectiveTextures,
  generatedItemState,
  generatedLayers,
  inheritedElementsState,
  mergeInherited,
  resolveParentChain,
  type JavaModelSource,
} from './parents';
import { testApp } from './testing';

// Hand-written parent chain in the style of a resource pack (no Mojang files).
const MODELS: Record<string, unknown> = {
  'minecraft:block/block': { display: { gui: { rotation: [30, 225, 0], translation: [0, 0, 0], scale: [0.625, 0.625, 0.625] } } },
  'minecraft:block/cube': {
    parent: 'block/block',
    textures: { particle: '#north' },
    elements: [
      {
        from: [0, 0, 0],
        to: [16, 16, 16],
        faces: Object.fromEntries(['north', 'east', 'south', 'west', 'up', 'down'].map((f) => [f, { texture: `#${f}`, cullface: f }])),
      },
    ],
  },
  'minecraft:block/cube_all': {
    parent: 'block/cube',
    textures: { north: '#all', east: '#all', south: '#all', west: '#all', up: '#all', down: '#all', particle: '#all' },
  },
  'minecraft:item/generated': { parent: 'builtin/generated', display: { ground: { scale: [0.5, 0.5, 0.5] } } },
  'minecraft:item/handheld': { parent: 'item/generated', display: { thirdperson_righthand: { rotation: [0, -90, 55] } } },
  'mymod:block/loop_a': { parent: 'mymod:block/loop_b' },
  'mymod:block/loop_b': { parent: 'mymod:block/loop_a' },
};
const TEXTURES = new Set(['minecraft:block/stone', 'mymod:block/gear', 'mymod:item/gear_layer']);
const image = (): JavaImage => ({ data: MISSING_TEXTURE_PNG, width: 16, height: 16 });

function fakeSource(log: string[] = []): JavaModelSource {
  return {
    async model(id) {
      log.push(`model ${id}`);
      return MODELS[id] ?? null;
    },
    async texture(id) {
      log.push(`texture ${id}`);
      return TEXTURES.has(id) ? image() : null;
    },
  };
}

function fakeService(): ModelFileService {
  return {
    source: () => fakeSource(),
    list: async () => [],
    readJava: async () => ({ json: '{}', images: {} }),
    readBbmodel: async () => ({ text: '{}', images: {} }),
    write: async () => {},
  };
}

describe('parent chain', () => {
  it('merges textures, display and the nearest elements', async () => {
    const { inherited, warnings } = await resolveParentChain('block/cube_all', fakeSource(), { all: 'mymod:block/gear' });
    expect(warnings).toEqual([]);
    expect(inherited!.chain).toEqual(['minecraft:block/cube_all', 'minecraft:block/cube', 'minecraft:block/block']);
    expect(inherited!.builtin).toBeNull();
    expect(inherited!.elements).toHaveLength(1);
    expect(inherited!.textures.north).toBe('#all');
    expect(Object.keys(inherited!.display)).toEqual(['gui']);
    expect(Object.keys(inherited!.images)).toEqual(['mymod:block/gear']);
  });

  it('stops at built-in parents, cycles and missing models', async () => {
    const generated = await resolveParentChain('item/handheld', fakeSource());
    expect(generated.inherited!.builtin).toBe('generated');
    expect(generated.inherited!.chain).toEqual(['minecraft:item/handheld', 'minecraft:item/generated', 'minecraft:builtin/generated']);
    expect(Object.keys(generated.inherited!.display).sort()).toEqual(['ground', 'thirdperson_righthand']);

    const loop = await resolveParentChain('mymod:block/loop_a', fakeSource());
    expect(loop.warnings[0]).toMatch(/cycle/);
    expect(loop.inherited!.chain).toHaveLength(2);

    const missing = await resolveParentChain('mymod:block/nothing', fakeSource());
    expect(missing.inherited).toBeNull();
    expect(missing.warnings[0]).toMatch(/not found/);
  });
});

describe('opening a model with a parent', () => {
  const child = JSON.stringify({ parent: 'block/cube_all', textures: { all: 'mymod:block/gear' } });

  it('shows the parent elements read-only with the child textures', async () => {
    const { state, parent } = await openJavaModelWithParents(child, { fileName: 'gear', sourcePath: '/p/assets/mymod/models/block/gear.json' }, fakeSource());
    expect(state.order).toHaveLength(0);
    expect(state.java!.inherited!.elements).toHaveLength(1);
    expect(state.java!.sourcePath).toBe('/p/assets/mymod/models/block/gear.json');
    expect(parent!.textures.north).toBe('mymod:block/gear');
    const preview = inheritedElementsState(state)!;
    expect(preview.order).toHaveLength(1);
    const faces = preview.objects[preview.order[0]].cuboid!.faces;
    expect(preview.textures[faces.north.texture!].name).toBe('gear');
    expect(faces.up.cullface).toBe('up');
    // Exported unchanged: the parent's elements are not part of the model.
    expect(JSON.parse(exportJavaModel(state))).toEqual({ parent: 'block/cube_all', textures: { all: 'mymod:block/gear' } });
  });

  it('keeps references to parent variables on export', async () => {
    const json = JSON.stringify({ parent: 'block/cube_all', textures: { all: 'block/stone', particle: '#north' } });
    const { state, warnings } = await openJavaModelWithParents(json, {}, fakeSource());
    expect(warnings).toEqual([]);
    expect(state.java!.textureRefs).toEqual({ particle: '#north' });
    expect(JSON.parse(exportJavaModel(state)).textures).toEqual({ all: 'block/stone', particle: '#north' });
  });

  it('gives faces that use parent variables the parent texture', async () => {
    const json = JSON.stringify({
      parent: 'mymod:block/base',
      elements: [{ from: [0, 0, 0], to: [16, 8, 16], faces: { up: { texture: '#top' } } }],
    });
    const source = fakeSource();
    MODELS['mymod:block/base'] = { textures: { top: 'mymod:block/gear' } };
    const { state, warnings } = await openJavaModelWithParents(json, {}, source);
    expect(warnings).toEqual([]);
    const up = state.objects[state.order[0]].cuboid!.faces.up;
    expect(state.textures[up.texture!].java!.key).toBe('top');
    // The model's own elements replace the parent's, so there is nothing to preview.
    expect(inheritedElementsState(state)).toBeNull();
  });

  it('merges the parent in on request', async () => {
    const { state, merged } = await openJavaModelWithParents(child, { parent: 'merge' }, fakeSource());
    expect(merged).toEqual({ elements: 1, textures: 0 });
    expect(state.java!.inherited).toBeUndefined();
    expect(state.order).toHaveLength(1);
    expect(state.java!.parent).toBe('block/cube_all');
    expect(Object.keys(state.java!.display!)).toEqual(['gui']);
    const out = JSON.parse(exportJavaModel(state));
    expect(out.elements[0].faces.north.texture).toBe('#all');
  });

  it('keeps only the reference when asked', async () => {
    const log: string[] = [];
    const { state, parent } = await openJavaModelWithParents(child, { parent: 'reference' }, fakeSource(log));
    expect(state.java!.inherited).toBeUndefined();
    expect(parent).toBeNull();
    expect(log.some((l) => l.startsWith('model'))).toBe(false);
  });

  it('finds its own missing textures in the other sources', async () => {
    const { state, warnings } = await openJavaModelWithParents(JSON.stringify({ textures: { 0: 'block/stone' } }), {}, fakeSource());
    expect(warnings).toEqual([]);
    expect(Object.values(state.textures)[0].data).toBe(MISSING_TEXTURE_PNG);
  });
});

describe('generated items', () => {
  it('lists the layer textures and extrudes opaque pixels', async () => {
    const json = JSON.stringify({ parent: 'item/handheld', textures: { layer0: 'mymod:item/gear_layer' } });
    const { state } = await openJavaModelWithParents(json, {}, fakeSource());
    const layers = generatedLayers(state);
    expect(layers.map((l) => l.key)).toEqual(['layer0']);
    expect(() => mergeInherited(state)).toThrow(/generated item/);

    // A 2 x 2 texture with one transparent pixel (top right).
    const pixels = [255, 0, 0, 255, 0, 0, 0, 0, 0, 255, 0, 255, 0, 0, 255, 255];
    const preview = generatedItemState([{ texture: layers[0].texture, width: 2, height: 2, pixels }]);
    // The slab plus three opaque pixels that all touch transparency or the border.
    expect(preview.order).toHaveLength(4);
    const slab = preview.objects[preview.order[0]].cuboid!;
    expect(slab.faces.south.enabled && slab.faces.north.enabled && !slab.faces.up.enabled).toBe(true);
    const topLeft = preview.objects[preview.order[1]].cuboid!;
    expect(topLeft.faces.east.enabled).toBe(true); // borders the transparent pixel
    expect(topLeft.faces.down.enabled).toBe(false); // the pixel below is opaque
    expect(topLeft.faces.west.uv).toEqual([0, 0, 8, 8]);
  });
});

describe('parent commands', () => {
  it('show, hide, merge and get go through the model file service', async () => {
    const t = testApp({ modelFiles: fakeService() });
    await t.run('document.import_java', { json: JSON.stringify({ parent: 'block/cube_all', textures: { all: 'block/stone' } }), parent: 'reference' });
    expect((await t.run('minecraft.get_parent')).shown).toBe(false);
    const shown = await t.run('minecraft.show_parent');
    expect(shown.inherited.chain[0]).toBe('minecraft:block/cube_all');
    expect(effectiveTextures(t.state()).get('up')!.name).toBe('stone');
    expect((await t.run('minecraft.get_settings')).inherited.elements).toBe(1);
    await t.run('minecraft.hide_parent');
    expect(t.state().java!.inherited).toBeUndefined();
    const merged = await t.run('minecraft.merge_parent');
    expect(merged.elements).toBe(1);
    expect(t.state().order).toHaveLength(1);
    await t.run('history.undo');
    expect(t.state().order).toHaveLength(0);
  });

  it('re-reads the parent when it changes while shown', async () => {
    const t = testApp({ modelFiles: fakeService() });
    await t.run('document.import_java', { json: JSON.stringify({ parent: 'block/cube_all', textures: { all: 'block/stone' } }) });
    await t.run('minecraft.set_settings', { parent: 'item/generated' });
    expect(t.state().java!.inherited!.builtin).toBe('generated');
  });

  it('cannot read parents without file access', async () => {
    const t = testApp();
    const opened = await t.run('document.import_java', { json: JSON.stringify({ parent: 'block/cube_all' }) });
    expect(opened.warnings.join(' ')).toMatch(/cannot be read here/);
    await expect(t.run('minecraft.show_parent')).rejects.toThrow(/cannot be read/);
  });
});
