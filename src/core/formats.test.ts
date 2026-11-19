import { describe, expect, it } from 'vitest';
import { buildManifest } from '../bridge/mcp';
import { commands } from './commands';
import { commandAllowedIn, commandFormats, docFormat } from './formats';
import { minecraftApp, testApp } from './minecraft/testing';
import { parseProject, serializeProject } from './project';
import { activeDoc } from './state';

const allowed = (id: string, format: 'free' | 'minecraft_java') => commandAllowedIn(id, commands.find((c) => c.id === id)?.formats, format);

/** Free-form modeling tools that must never be offered in a Minecraft document. */
const FREE_ONLY = [
  'edit.toggle',
  'edit.enter',
  'mesh.bevel',
  'mesh.loop_cut',
  'mesh.subdivide',
  'mesh.extrude',
  'mesh.inset',
  'mesh.merge',
  'uv.unwrap',
  'modifier.add',
  'scene.boolean',
  'scene.add_primitive',
  'scene.add_text',
  'scene.add_tube',
  'scene.add_mesh',
  'scene.set_smooth',
  'material.create',
  'material.assign',
  'bake.ao',
  'anim.set_key',
  'render.video',
];

/** Minecraft cuboid tools that must never be offered in a free document. */
const MINECRAFT_ONLY = [
  'cuboid.add',
  'cuboid.update',
  'cuboid.move',
  'cuboid.resize',
  'cuboid.flip',
  'cuboid.rotate90',
  'cuboid.set_face',
  'cuboid.uv',
  'minecraft.set_settings',
  'minecraft.validate',
  'minecraft.export_json',
];

/** Work in both kinds of document. */
const BOTH = [
  'document.new',
  'document.import_java',
  'document.list',
  'history.undo',
  'scene.select',
  'scene.set_transform',
  'scene.duplicate_objects',
  'scene.delete_objects',
  'scene.rename_object',
  'scene.set_visible',
  'group.create',
  'group.ungroup',
  'texture.add',
  'texture.remove',
  'paint.stroke',
  'paint.add_layer',
  'paint.pixel_stroke',
  'paint.pixel_fill',
  'paint.frames',
  'texture.set_animation',
  'texture.export',
  'export.file',
  'view.screenshot',
  'render.image',
];

describe('document formats', () => {
  it('pins which commands work in which format', () => {
    for (const id of FREE_ONLY) {
      expect(allowed(id, 'free'), id).toBe(true);
      expect(allowed(id, 'minecraft_java'), id).toBe(false);
    }
    for (const id of MINECRAFT_ONLY) {
      expect(allowed(id, 'free'), id).toBe(false);
      expect(allowed(id, 'minecraft_java'), id).toBe(true);
    }
    for (const id of BOTH) {
      expect(allowed(id, 'free'), id).toBe(true);
      expect(allowed(id, 'minecraft_java'), id).toBe(true);
    }
  });

  it('lists only commands that exist', () => {
    const ids = new Set(commands.map((c) => c.id));
    for (const id of [...FREE_ONLY, ...MINECRAFT_ONLY, ...BOTH]) expect(ids.has(id), id).toBe(true);
  });

  it('gates every command of the free-only and Minecraft-only families', () => {
    for (const { id, formats } of commands) {
      if (/^(edit|mesh|uv|modifier|material|bake|anim)\./.test(id)) expect(commandFormats(id, formats), id).toEqual(['free']);
      if (/^(cuboid|minecraft)\./.test(id)) expect(commandFormats(id, formats), id).toEqual(['minecraft_java']);
    }
  });

  it('refuses a free-only command in a Minecraft document with a clear error', async () => {
    const t = await minecraftApp();
    await expect(t.run('scene.add_primitive', { type: 'cube' })).rejects.toThrow(
      /scene\.add_primitive is not available in Minecraft Java Block\/Item documents: it only works in Free model documents/,
    );
    await expect(t.run('mesh.bevel')).rejects.toThrow(/not available in Minecraft Java/);
    expect(t.state().order).toEqual([]);
  });

  it('refuses cuboid commands in a free document', async () => {
    const t = testApp();
    await expect(t.run('cuboid.add')).rejects.toThrow(/cuboid\.add is not available in Free model documents: it only works in Minecraft Java Block\/Item documents/);
    expect(t.state().order).toEqual([]);
  });

  it('tells MCP clients up front which tools are format-specific', () => {
    const manifest = new Map(buildManifest().map((entry) => [entry.id, entry.description]));
    expect(manifest.get('mesh.bevel')).toMatch(/^Only in Free model documents/);
    expect(manifest.get('cuboid.add')).toMatch(/^Only in Minecraft Java Block\/Item documents/);
    expect(manifest.get('scene.select')).not.toMatch(/^Only in/);
  });
});

describe('format persistence', () => {
  it('creates free documents by default, exactly as before', async () => {
    const t = testApp();
    const created = await t.run('document.new', { name: 'Plain' });
    expect(created.format).toBe('free');
    const state = t.state();
    expect(state.format).toBeUndefined();
    expect(state.java).toBeUndefined();
    expect(docFormat(state)).toBe('free');
    // Free projects are written without format keys, as before formats existed.
    const json = JSON.parse(serializeProject(activeDoc(t.app())));
    expect(json).not.toHaveProperty('documentFormat');
    expect(json).not.toHaveProperty('java');
  });

  it('loads files written before formats existed as free documents', () => {
    const old = JSON.stringify({ format: 'tessel', version: 1, name: 'Old', objects: [] });
    const { state } = parseProject(old);
    expect(docFormat(state)).toBe('free');
    expect(state.java).toBeUndefined();
  });

  it('keeps the format and the model settings of a Minecraft document through save and load', async () => {
    const t = await minecraftApp({ parent: 'block/block', ambientOcclusion: false, textureSize: [32, 64], fileName: 'gear' });
    await t.run('cuboid.add', { from: [2, 0, 2], to: [14, 4, 14], origin: [8, 0, 8], rotation: [0, 22.5, 0] });
    await t.run('group.create', { name: 'base' });
    const json = serializeProject(activeDoc(t.app()));
    const { state } = parseProject(json);
    expect(state.format).toBe('minecraft_java');
    expect(state.java).toMatchObject({ version: '26.3', fileName: 'gear', parent: 'block/block', ambientOcclusion: false, textureSize: [32, 64] });
    const before = t.state().objects[t.state().order[0]];
    const after = state.objects[state.order[0]];
    expect(after.cuboid).toEqual(before.cuboid);
    expect(after.mesh).toEqual(before.mesh);
    expect(after.transform).toEqual(before.transform);
  });

  it('drops cuboid data from documents that are not Minecraft documents', async () => {
    const t = await minecraftApp();
    await t.run('cuboid.add');
    const json = JSON.parse(serializeProject(activeDoc(t.app())));
    delete json.documentFormat;
    const { state } = parseProject(JSON.stringify(json));
    expect(state.objects[state.order[0]].cuboid).toBeUndefined();
  });
});
