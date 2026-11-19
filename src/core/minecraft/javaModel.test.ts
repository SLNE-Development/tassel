import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { activeDoc } from '../state';
import { exportJavaModel, textureLocation } from './javaExport';
import { MISSING_TEXTURE_PNG, defaultFaceUv, importJavaModel, parseLocation } from './javaImport';
import { addTexture, minecraftApp, testApp } from './testing';
import { validateJavaModel } from './validate';
import { capabilities, inRange, javaVersions } from './versions';

const golden = (name: string) => new URL(`./golden/26.3/${name}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** A model that uses every feature of the 26.3 exporter, built through the commands. */
async function fullModel() {
  const t = await minecraftApp({ name: 'Gear Box', fileName: 'gear_box', parent: 'block/block', textureSize: [32, 16] });
  const side = await addTexture(t, 'gear_side');
  const top = await addTexture(t, 'gear_top');
  await t.run('minecraft.set_texture', { texture: side, namespace: 'mymod', folder: 'block/gears', key: 'side' });
  await t.run('minecraft.set_texture', { texture: top, key: 'top' });
  await t.run('minecraft.set_settings', { particle: side, guiLight: 'side', credit: 'Tessel test', ambientOcclusion: false });
  const base = await t.run('cuboid.add', { name: 'base', from: [0, 0, 0], to: [16, 4, 16], texture: side });
  await t.run('cuboid.set_face', { ids: [base.id], faces: ['up'], texture: top, uv: [0, 0, 32, 16], rotation: 90 });
  await t.run('cuboid.set_face', { ids: [base.id], faces: ['north'], tintIndex: 1 });
  await t.run('cuboid.set_face', { ids: [base.id], faces: ['down'], enabled: false });
  await t.run('cuboid.auto_cullface', { ids: [base.id] });
  const axle = await t.run('cuboid.add', { from: [7, 4, 7], to: [9, 14, 9], origin: [8, 4, 8], rotation: [30, 45, 0], texture: side });
  await t.run('cuboid.update', { ids: [axle.id], inflate: 0.25, rescale: true, lightEmission: 12, shadeDirectionOverride: 'up', shade: false });
  await t.run('cuboid.set_face', { ids: [axle.id], faces: ['east'], texture: null });
  const hidden = await t.run('cuboid.add', { name: 'helper', from: [0, 0, 0], to: [1, 1, 1] });
  await t.run('cuboid.update', { ids: [hidden.id], export: false });
  await t.run('scene.select', { ids: [axle.id] });
  await t.run('group.create', { name: 'shaft' });
  const group = Object.values(t.state().groups)[0];
  await t.run('minecraft.set_group_pivot', { group: group.id, pivot: [8, 4, 8] });
  return t;
}

describe('version registry', () => {
  it('starts with exactly 26.3', () => {
    expect(javaVersions.map((v) => v.id)).toEqual(['26.3']);
    expect(capabilities('26.3')).toEqual({
      freeRotation: true,
      rotationLimit: 180,
      rotationStep: 0,
      lightEmission: true,
      shadeDirectionOverride: true,
      coordinateRange: [-16, 32],
      guiLight: true,
      groups: true,
    });
    expect(inRange({ since: '26.3' }, '26.3')).toBe(true);
    expect(inRange({ since: '26.3', until: '26.3' }, '26.3')).toBe(false);
    expect(() => inRange({ since: '1.0' }, '26.3')).toThrow(/Unknown Minecraft Java version/);
  });
});

describe('Java model export (26.3)', () => {
  it('matches the golden file for a model using every feature', async () => {
    const t = await fullModel();
    await expect(exportJavaModel(t.state())).toMatchFileSnapshot(golden('full-export.json'));
  });

  it('writes the minimal model of a new document', async () => {
    const t = await minecraftApp();
    await t.run('cuboid.add');
    await expect(exportJavaModel(t.state())).toMatchFileSnapshot(golden('minimal-export.json'));
  });

  it('exports through export.file with the model file name', async () => {
    const t = await fullModel();
    const result = await t.run('export.file', { format: 'json' });
    expect(result).toMatchObject({ format: 'json', fileName: 'gear_box.json', text: exportJavaModel(t.state()) });
    const free = testApp();
    await expect(free.run('export.file', { format: 'json' })).rejects.toThrow(/only be exported from a Minecraft Java document/);
  });

  it('writes namespaced texture locations', () => {
    const texture = { id: 't', name: 'x', mimeType: 'image/png', data: '', width: 1, height: 1 } as const;
    expect(textureLocation({ ...texture, java: { namespace: 'minecraft', folder: 'block', key: '0' } })).toBe('block/x');
    expect(textureLocation({ ...texture, java: { namespace: 'mymod', folder: 'item/tools/', key: '0' } })).toBe('mymod:item/tools/x');
    expect(textureLocation({ ...texture, java: { namespace: 'mymod', folder: '', key: '0' } })).toBe('mymod:x');
    expect(parseLocation('mymod:item/tools/x')).toEqual({ namespace: 'mymod', folder: 'item/tools', name: 'x' });
    expect(parseLocation('x')).toEqual({ namespace: 'minecraft', folder: '', name: 'x' });
  });
});

describe('Java model import', () => {
  const input = readFileSync(golden('vanilla-input.json'), 'utf8');

  it('reads a model into a new Minecraft document and writes it back (golden file)', async () => {
    const { state, warnings } = importJavaModel(input, { fileName: 'machine' });
    expect(state.format).toBe('minecraft_java');
    expect(state.java).toMatchObject({
      fileName: 'machine',
      parent: 'block/block',
      ambientOcclusion: false,
      textureSize: [32, 32],
      guiLight: 'front',
      credit: 'Made by hand',
      extra: { render_type: 'minecraft:cutout' },
      display: { gui: { rotation: [30, 225, 0], scale: [0.625, 0.625, 0.625] } },
    });
    expect(state.order).toHaveLength(2);
    expect(Object.values(state.groups).map((g) => [g.name, g.pivot])).toEqual([
      ['machine', [8, 0, 8]],
      ['lid', [8, 8, 8]],
    ]);
    expect(warnings.some((w) => w.includes('mymod:block/machine/side') && w.includes('placeholder'))).toBe(true);
    expect(warnings.some((w) => w.includes('"edge"') && w.includes('alias'))).toBe(true);
    await expect(exportJavaModel(state)).toMatchFileSnapshot(golden('vanilla-roundtrip.json'));
  });

  it('round-trips its own export exactly', async () => {
    const t = await fullModel();
    const text = exportJavaModel(t.state());
    const images = Object.fromEntries(Object.values(t.state().textures).map((tex) => [textureLocation(tex), { data: tex.data, width: 16, height: 16 }]));
    const { state, warnings } = importJavaModel(text, { fileName: 'gear_box', images });
    expect(warnings).toEqual([]);
    expect(exportJavaModel(state)).toBe(text);
  });

  it('uses the resource pack images it is given and placeholders for the rest', () => {
    const { state } = importJavaModel(JSON.stringify({ textures: { a: 'block/a', b: 'block/b' } }), {
      images: { 'block/a': { data: 'AAAA', width: 32, height: 32 } },
    });
    const byKey = Object.fromEntries(Object.values(state.textures).map((tex) => [tex.java!.key, tex]));
    expect(byKey.a).toMatchObject({ name: 'a', data: 'AAAA', width: 32, java: { namespace: 'minecraft', folder: 'block' } });
    expect(byKey.b).toMatchObject({ data: MISSING_TEXTURE_PNG, width: 16 });
  });

  it('gives faces without uv the UV Minecraft derives from the element', () => {
    expect(defaultFaceUv('north', [2, 3, 4], [6, 7, 8])).toEqual([10, 9, 14, 13]);
    expect(defaultFaceUv('up', [2, 3, 4], [6, 7, 8])).toEqual([2, 4, 6, 8]);
  });

  it('refuses text that is not a JSON object', () => {
    expect(() => importJavaModel('nope')).toThrow('not valid JSON');
    expect(() => importJavaModel('[]')).toThrow('not a JSON object');
  });

  it('opens as a new tab through document.import_java, from any document', async () => {
    const t = testApp();
    const before = t.app().activeDocId;
    const result = await t.run('document.import_java', { json: input, name: 'machine' });
    expect(result).toMatchObject({ name: 'machine', active: true, format: 'minecraft_java', elements: 2 });
    expect(t.app().activeDocId).not.toBe(before);
    expect(activeDoc(t.app()).state.format).toBe('minecraft_java');
  });
});

describe('Java model validation', () => {
  it('reports bad texture names, zero UVs, coordinates out of range and generated parents', async () => {
    const t = await minecraftApp({ parent: 'item/generated' });
    const tex = await addTexture(t, 'Bad Name');
    await t.run('minecraft.set_texture', { texture: tex, namespace: 'My Mod' });
    await t.run('cuboid.add', { from: [-20, 0, 0], to: [4, 4, 4], texture: tex });
    await t.run('cuboid.set_face', { faces: ['north'], uv: [2, 2, 2, 8] });
    const codes = validateJavaModel(t.state()).map((i) => `${i.severity}:${i.code}`);
    expect(codes).toEqual(['error:texture_name', 'error:texture_namespace', 'error:out_of_range', 'warning:zero_uv', 'warning:generated_with_elements']);
    const result = await t.run('minecraft.validate');
    expect(result.valid).toBe(false);
  });

  it('accepts a clean model', async () => {
    const t = await fullModel();
    // The axle has a face without texture; everything else is valid.
    expect(validateJavaModel(t.state()).filter((i) => i.severity === 'error')).toEqual([]);
    expect(activeDoc(t.app()).state.java!.version).toBe('26.3');
  });
});
