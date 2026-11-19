import { describe, expect, it } from 'vitest';
import { MISSING_TEXTURE_PNG } from '../minecraft/javaImport';
import { testApp } from '../minecraft/testing';
import { joinPath, relativePath, splitPath, type ModelFileService } from '../modelFiles';
import { parseProject } from '../project';
import { looksLikeJavaModel } from './modelImport';

const png = `data:image/png;base64,${MISSING_TEXTURE_PNG}`;

const javaBlock = JSON.stringify({
  meta: { format_version: '4.10', model_format: 'java_block', box_uv: false },
  name: 'lamp',
  resolution: { width: 16, height: 16 },
  elements: [
    { name: 'base', type: 'cube', uuid: 'a', from: [0, 0, 0], to: [16, 4, 16], origin: [8, 8, 8], rotation: [0, 0, 0], faces: { up: { uv: [0, 0, 16, 16], texture: 0 } } },
    { name: 'hand', type: 'locator', uuid: 'b', position: [0, 0, 0] },
  ],
  outliner: ['a', 'b'],
  textures: [{ name: 'lamp.png', id: '0', namespace: 'mymod', folder: 'block', source: png, width: 16, height: 16 }],
  animations: [{ name: 'glow', uuid: 'c' }],
});

const entity = JSON.stringify({
  meta: { format_version: '4.10', model_format: 'modded_entity', box_uv: true },
  name: 'critter',
  resolution: { width: 64, height: 32 },
  elements: [{ name: 'body', type: 'cube', uuid: 'a', from: [-4, 0, -4], to: [4, 8, 4], origin: [0, 0, 0], uv_offset: [0, 0], faces: Object.fromEntries(['north', 'east', 'south', 'west', 'up', 'down'].map((f) => [f, { texture: 0 }])) }],
  outliner: ['a'],
  textures: [{ name: 'critter.png', source: png, width: 64, height: 32 }],
});

/** An in-memory folder of model files. */
function folderService(files: Record<string, string>) {
  const written: Record<string, string> = {};
  const service: ModelFileService = {
    source: () => ({ model: async () => null, texture: async () => null }),
    list: async (folder, recursive) =>
      Object.keys(files).filter((p) => {
        const rel = relativePath(folder, p);
        return rel !== null && (recursive || !rel.includes('/'));
      }),
    readJava: async (path) => ({ json: files[path], images: {} }),
    readBbmodel: async (path) => ({ text: files[path], images: {} }),
    write: async (path, text, overwrite) => {
      if (!overwrite && (written[path] !== undefined || files[path] !== undefined)) throw new Error(`"${path}" already exists`);
      written[path] = text;
    },
  };
  return { service, written };
}

describe('opening Blockbench projects', () => {
  it('opens a java_block project as a Minecraft document and reports what was dropped', async () => {
    const t = testApp();
    const result = await t.run('document.import_bbmodel', { text: javaBlock, name: 'lamp' });
    expect(result.format).toBe('minecraft_java');
    expect(result.elements).toBe(1);
    expect(result.dropped.map((d: { kind: string }) => d.kind).sort()).toEqual(['animation', 'locator']);
    expect(t.state().format).toBe('minecraft_java');
    expect(Object.values(t.state().textures)[0].java).toEqual({ namespace: 'mymod', folder: 'block', key: '0' });
  });

  it('opens other projects as free documents', async () => {
    const t = testApp();
    const result = await t.run('document.import_bbmodel', { text: entity, name: 'critter' });
    expect(result.format).toBe('free');
    expect(t.state().format ?? 'free').toBe('free');
    expect(Object.keys(t.state().materials)).toHaveLength(1);
  });

  it('opens files by path through the model file service', async () => {
    const { service } = folderService({ '/m/lamp.bbmodel': javaBlock });
    const t = testApp({ modelFiles: service });
    const result = await t.run('document.open_model_file', { path: '/m/lamp.bbmodel' });
    expect(result.name).toBe('lamp');
    await expect(t.run('document.open_model_file', { path: '/m/x.obj' })).rejects.toThrow(/not a .json or .bbmodel/);
  });
});

describe('converting folders', () => {
  const files = {
    'C:\\pack\\lamp.bbmodel': javaBlock,
    'C:\\pack\\critter.bbmodel': entity,
    'C:\\pack\\models\\block\\stone.json': JSON.stringify({ parent: 'block/cube_all', textures: { all: 'block/stone' } }),
    'C:\\pack\\blockstates\\stone.json': JSON.stringify({ variants: { '': { model: 'block/stone' } } }),
    'C:\\pack\\broken.json': '{ not json',
  };

  it('writes .tessel projects with the folder structure and a summary', async () => {
    const { service, written } = folderService(files);
    const t = testApp({ modelFiles: service });
    const result = await t.run('document.convert_models', { folder: 'C:\\pack', output: 'C:\\out' });
    expect(result.converted.map((c: { output: string }) => c.output).sort()).toEqual(['C:\\out\\critter.tessel', 'C:\\out\\lamp.tessel', 'C:\\out\\models\\block\\stone.tessel']);
    expect(result.skipped.map((s: { source: string }) => s.source).sort()).toEqual(['C:\\pack\\blockstates\\stone.json', 'C:\\pack\\broken.json']);
    expect(result.failed).toEqual([]);
    expect(parseProject(written['C:\\out\\lamp.tessel']).state.format).toBe('minecraft_java');
    expect(result.converted.find((c: { source: string }) => c.source.endsWith('lamp.bbmodel')).warnings.join(' ')).toMatch(/locator/);
    // A second run does not replace what is there.
    const again = await t.run('document.convert_models', { folder: 'C:\\pack', output: 'C:\\out' });
    expect(again.converted).toEqual([]);
    expect(again.skipped.some((s: { reason: string }) => /already exists/.test(s.reason))).toBe(true);
  });

  it('re-exports Java JSON, skipping free projects and never replacing sources', async () => {
    const { service, written } = folderService(files);
    const t = testApp({ modelFiles: service });
    const into = await t.run('document.convert_models', { folder: 'C:\\pack', target: 'json', recursive: false });
    expect(into.skipped.find((s: { source: string }) => s.source.endsWith('critter.bbmodel')).reason).toMatch(/not a Java/);
    expect(JSON.parse(written['C:\\pack\\lamp.json']).textures).toEqual({ 0: 'mymod:block/lamp' });
    const sameFolder = await t.run('document.convert_models', { folder: 'C:\\pack\\models\\block', target: 'json' });
    expect(sameFolder.skipped[0].reason).toMatch(/replace a source file/);
  });
});

describe('helpers', () => {
  it('splits and joins paths of both styles', () => {
    expect(splitPath('C:\\a\\b.bbmodel')).toMatchObject({ dir: 'C:\\a', stem: 'b', ext: 'bbmodel' });
    expect(relativePath('C:\\A', 'c:\\a\\x\\y.json')).toBe('x/y.json');
    expect(relativePath('/a', '/ab/c.json')).toBeNull();
    expect(joinPath('/out/', 'x/y.tessel')).toBe('/out/x/y.tessel');
  });

  it('tells models from other pack JSON', () => {
    expect(looksLikeJavaModel('{"parent":"item/generated"}')).toBe(true);
    expect(looksLikeJavaModel('{"variants":{}}')).toBe(false);
    expect(looksLikeJavaModel('{"model":{"type":"minecraft:model"}}')).toBe(false);
    expect(looksLikeJavaModel('{"item.x":"X"}')).toBe(false);
  });
});
