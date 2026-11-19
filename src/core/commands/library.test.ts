import { beforeEach, describe, expect, it } from 'vitest';
import { MISSING_TEXTURE_PNG } from '../minecraft/javaImport';
import { minecraftApp, testApp, type TestApp } from '../minecraft/testing';
import { parseProject } from '../project';
import {
  defaultProjectConfig,
  linkLocation,
  parseTextureLocation,
  textureFilePath,
  type LibraryEntry,
  type ProjectConfig,
  type TextureLibraryService,
  type TextureLink,
} from '../textureLibrary';

/** A PNG header (signature + IHDR) of the given size; `tag` makes images of the same size differ. */
function png(width: number, height: number, tag = 0): string {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0, tag & 255, 0, 0, 0], 24);
  return Buffer.from(bytes).toString('base64');
}

/** An in-memory library with one project source and the vanilla textures. */
class FakeLibrary implements TextureLibraryService {
  files = new Map<string, { data: string; source: string }>();
  baselines = new Map<string, string>();
  config_: ProjectConfig = { textures: { defaultNamespace: 'surf_textures', defaultFolder: 'block' } };
  moved: [string, string][] = [];

  put(location: string, data: string, source = 'project:p') {
    this.files.set(linkLocation(parseTextureLocation(location)), { data, source });
  }
  private entry(location: string): LibraryEntry {
    const link = parseTextureLocation(location);
    const file = this.files.get(location)!;
    const vanilla = file.source === 'vanilla';
    return { location, ...link, source: file.source, sourceKind: vanilla ? 'vanilla' : 'project', file: textureFilePath(link), width: 16, height: 16, size: 1, modified: 1, animation: null, readOnly: vanilla };
  }
  async sources() {
    return [
      { id: 'project:p', kind: 'project' as const, name: 'P', readOnly: false, available: true },
      { id: 'vanilla', kind: 'vanilla' as const, name: 'Minecraft', readOnly: true, available: true },
    ];
  }
  async entries() {
    return [...this.files.keys()].map((l) => this.entry(l));
  }
  async read(link: TextureLink) {
    const location = linkLocation(link);
    const file = this.files.get(location);
    if (!file) return null;
    this.baselines.set(location, file.data);
    return { entry: this.entry(location), data: file.data };
  }
  async write(link: TextureLink, data: string, opts?: { source?: string }) {
    const location = linkLocation(link);
    if (this.files.get(location)?.source === 'vanilla') throw new Error(`${location} is a read-only vanilla texture`);
    this.files.set(location, { data, source: opts?.source ?? 'project:p' });
    this.baselines.set(location, data);
    return this.entry(location);
  }
  async move(from: TextureLink, to: TextureLink) {
    const file = this.files.get(linkLocation(from))!;
    this.files.delete(linkLocation(from));
    this.files.set(linkLocation(to), file);
    this.moved.push([linkLocation(from), linkLocation(to)]);
    return { entry: this.entry(linkLocation(to)), rewritten: ['assets/surf_textures/models/block/x.json'] };
  }
  async reveal() {}
  async config() {
    return { project: 'project:p', config: this.config_ };
  }
  async setConfig(config: ProjectConfig) {
    this.config_ = config;
  }
  async addFolder(): Promise<never> {
    throw new Error('not used');
  }
  async removeFolder() {}
  baseline(location: string) {
    return this.baselines.get(location);
  }
}

let lib: FakeLibrary;
const ROCK = png(16, 16, 1);
const ROCK_V2 = png(16, 16, 2);
const PAINTED = png(16, 16, 3);

beforeEach(() => {
  lib = new FakeLibrary();
  lib.put('surf_textures:block/rock', ROCK);
  lib.put('minecraft:block/stone', png(16, 16, 9), 'vanilla');
});

async function mcApp(): Promise<TestApp> {
  return minecraftApp({}, { textureLibrary: lib });
}

describe('linking Minecraft textures', () => {
  it('adds a library texture as a link, assigns it and exports its location', async () => {
    const t = await mcApp();
    const element = (await t.run('cuboid.add', { from: [0, 0, 0], to: [16, 16, 16] })).id;
    // Without a namespace the project's default namespace is used.
    const added = await t.run('texture.add_from_library', { location: 'block/rock', objects: [element] });
    expect(added).toMatchObject({ name: 'rock', location: 'surf_textures:block/rock', reused: false });
    const texture = t.state().textures[added.id];
    expect(texture).toMatchObject({ data: ROCK, link: { namespace: 'surf_textures', path: 'block/rock' }, java: { namespace: 'surf_textures', folder: 'block' } });
    expect(t.state().objects[element].cuboid!.faces.north.texture).toBe(added.id);
    const json = JSON.parse((await t.run('minecraft.export_json', {})).text);
    expect(json.textures[texture.java!.key]).toBe('surf_textures:block/rock');
    expect(json.textures.particle).toBe('surf_textures:block/rock');
    // Adding it again reuses the texture.
    expect(await t.run('texture.add_from_library', { location: 'surf_textures:block/rock' })).toMatchObject({ id: added.id, reused: true });
  });

  it('refuses locations the library does not have', async () => {
    const t = await mcApp();
    await expect(t.run('texture.add_from_library', { location: 'surf_textures:block/none' })).rejects.toThrow(/has no surf_textures:block\/none/);
  });

  it('relinks, unlinks and follows location edits', async () => {
    const t = await mcApp();
    const id = (await t.run('texture.add', { name: 'old', mimeType: 'image/png', data: MISSING_TEXTURE_PNG, width: 16, height: 16 })).id;
    await t.run('texture.link', { id, location: 'surf_textures:block/rock' });
    expect(t.state().textures[id]).toMatchObject({ name: 'rock', data: ROCK, link: { path: 'block/rock' } });
    await t.run('minecraft.set_texture', { texture: id, folder: 'ore' });
    expect(t.state().textures[id].link).toEqual({ namespace: 'surf_textures', path: 'ore/rock' });
    await t.run('texture.unlink', { id });
    expect(t.state().textures[id].link).toBeUndefined();
    expect(t.state().textures[id].java?.namespace).toBe('surf_textures');
  });

  it('links imported textures that the library has, and placeholders as missing', async () => {
    const t = await mcApp();
    const a = (await t.run('texture.add', { name: 'rock', mimeType: 'image/png', data: png(16, 16, 7), width: 16, height: 16 })).id;
    await t.run('minecraft.set_texture', { texture: a, namespace: 'surf_textures', folder: 'block' });
    const b = (await t.run('texture.add', { name: 'gone', mimeType: 'image/png', data: MISSING_TEXTURE_PNG, width: 16, height: 16 })).id;
    const c = (await t.run('texture.add', { name: 'embedded', mimeType: 'image/png', data: png(16, 16, 8), width: 16, height: 16 })).id;
    const result = await t.run('library.link_all', {});
    expect(result).toEqual({ linked: [a], missing: [b] });
    expect(t.state().textures[a].data).toBe(ROCK);
    expect(t.state().textures[b].link).toEqual({ namespace: 'minecraft', path: 'block/gone' });
    expect(t.state().textures[c].link).toBeUndefined();
    const report = await t.run('library.refresh', {});
    expect(report.missing.map((m: { textureId: string }) => m.textureId)).toEqual([b]);
  });
});

describe('keeping linked textures in step', () => {
  it('takes changed files without an undo step and keeps undo free of old pixels', async () => {
    const t = await mcApp();
    const id = (await t.run('texture.add_from_library', { location: 'surf_textures:block/rock' })).id;
    await t.run('document.mark_saved', {});
    lib.put('surf_textures:block/rock', ROCK_V2);
    const report = await t.run('library.refresh', {});
    expect(report.updated).toEqual([{ documentId: t.app().activeDocId, textureId: id, location: 'surf_textures:block/rock' }]);
    expect(t.state().textures[id].data).toBe(ROCK_V2);
    const doc = t.app().docs[t.app().activeDocId];
    expect(doc.dirty).toBe(false);
    expect(doc.past.every((s) => !s.textures[id] || s.textures[id].data === ROCK_V2)).toBe(true);
  });

  it('keeps unsaved pixel changes and reports conflicts', async () => {
    const t = await mcApp();
    const id = (await t.run('texture.add_from_library', { location: 'surf_textures:block/rock' })).id;
    t.ctx.set((app) => {
      const doc = app.docs[app.activeDocId];
      return { ...app, docs: { ...app.docs, [doc.id]: { ...doc, state: { ...doc.state, textures: { ...doc.state.textures, [id]: { ...doc.state.textures[id], data: PAINTED } } } } } };
    });
    expect((await t.run('library.refresh', {})).unsaved).toHaveLength(1);
    lib.put('surf_textures:block/rock', ROCK_V2);
    expect((await t.run('library.refresh', {})).conflicts).toHaveLength(1);
    expect(t.state().textures[id].data).toBe(PAINTED);
  });

  it('writes painted linked textures back when the document is saved', async () => {
    const t = await mcApp();
    const id = (await t.run('texture.add_from_library', { location: 'surf_textures:block/rock' })).id;
    const stone = (await t.run('texture.add_from_library', { location: 'minecraft:block/stone' })).id;
    t.ctx.set((app) => {
      const doc = app.docs[app.activeDocId];
      const textures = { ...doc.state.textures, [id]: { ...doc.state.textures[id], data: PAINTED }, [stone]: { ...doc.state.textures[stone], data: PAINTED } };
      return { ...app, docs: { ...app.docs, [doc.id]: { ...doc, state: { ...doc.state, textures } } } };
    });
    const saved = await t.run('document.mark_saved', { filePath: 'C:/x.tessel' });
    expect(saved.library.written).toEqual([{ textureId: id, location: 'surf_textures:block/rock', file: 'assets/surf_textures/textures/block/rock.png' }]);
    expect(saved.library.failed[0]).toMatchObject({ textureId: stone, error: expect.stringMatching(/read-only/) });
    expect(lib.files.get('surf_textures:block/rock')!.data).toBe(PAINTED);
    // Nothing left to write.
    expect((await t.run('library.save_textures', {})).written).toEqual([]);
  });

  it('a save updates other open documents linked to the same file', async () => {
    const t = await mcApp();
    const first = t.app().activeDocId;
    const a = (await t.run('texture.add_from_library', { location: 'surf_textures:block/rock' })).id;
    await t.run('document.new', { name: 'Second', format: 'minecraft_java' });
    const b = (await t.run('texture.add_from_library', { location: 'surf_textures:block/rock' })).id;
    t.ctx.set((app) => {
      const doc = app.docs[app.activeDocId];
      return { ...app, docs: { ...app.docs, [doc.id]: { ...doc, state: { ...doc.state, textures: { ...doc.state.textures, [b]: { ...doc.state.textures[b], data: PAINTED } } } } } };
    });
    await t.run('document.mark_saved', {});
    expect(t.app().docs[first].state.textures[a].data).toBe(PAINTED);
    // So saving the first document does not write the old pixels back.
    await t.run('document.switch', { id: first });
    expect((await t.run('library.save_textures', {})).written).toEqual([]);
  });

  it('never replaces pixels painted onto a read-only vanilla texture on first sync', async () => {
    const t = await mcApp();
    const id = (await t.run('texture.add', { name: 'stone', mimeType: 'image/png', data: PAINTED, width: 16, height: 16 })).id;
    t.ctx.set((app) => {
      const doc = app.docs[app.activeDocId];
      return { ...app, docs: { ...app.docs, [doc.id]: { ...doc, state: { ...doc.state, textures: { ...doc.state.textures, [id]: { ...doc.state.textures[id], link: { namespace: 'minecraft', path: 'block/stone' } } } } } } };
    });
    expect((await t.run('library.refresh', {})).unsaved).toHaveLength(1);
    expect(t.state().textures[id].data).toBe(PAINTED);
  });

  it('save_texture writes one texture (the paint session API)', async () => {
    const t = await mcApp();
    const id = (await t.run('texture.add_from_library', { location: 'surf_textures:block/rock' })).id;
    expect(await t.run('library.save_texture', { id })).toMatchObject({ location: 'surf_textures:block/rock' });
    const plain = (await t.run('texture.add', { name: 'plain', mimeType: 'image/png', data: MISSING_TEXTURE_PNG, width: 16, height: 16 })).id;
    await expect(t.run('library.save_texture', { id: plain })).rejects.toThrow(/not linked/);
  });
});

describe('library files', () => {
  it('imports into the default namespace and folder, refusing to overwrite', async () => {
    const t = await mcApp();
    const id = (await t.run('texture.add', { name: 'Fresh', mimeType: 'image/png', data: PAINTED, width: 16, height: 16 })).id;
    const result = await t.run('library.import', { name: 'Fresh Grass', data: PAINTED, link: id });
    expect(result.entry.location).toBe('surf_textures:block/fresh_grass');
    expect(t.state().textures[id].link).toEqual({ namespace: 'surf_textures', path: 'block/fresh_grass' });
    await expect(t.run('library.import', { name: 'fresh_grass', data: PAINTED })).rejects.toThrow(/already has/);
    await expect(t.run('library.import', { name: 'bad', data: 'aGVsbG8=' })).rejects.toThrow(/not a PNG/);
  });

  it('moving a file relinks open documents', async () => {
    const t = await mcApp();
    const id = (await t.run('texture.add_from_library', { location: 'surf_textures:block/rock' })).id;
    const result = await t.run('library.move', { from: 'surf_textures:block/rock', to: 'surf_textures:block/stone/rock' });
    expect(result).toMatchObject({ relinkedTextures: 1, rewrittenFiles: ['assets/surf_textures/models/block/x.json'] });
    expect(t.state().textures[id]).toMatchObject({ link: { path: 'block/stone/rock' }, java: { folder: 'block/stone' } });
    await t.run('history.undo', {});
    expect(t.state().textures[id].link).toEqual({ namespace: 'surf_textures', path: 'block/rock' });
  });

  it('sets the project config', async () => {
    const t = await mcApp();
    await t.run('library.set_config', { defaultNamespace: 'mymod', defaultFolder: '/item/' });
    expect(lib.config_).toEqual({ textures: { defaultNamespace: 'mymod', defaultFolder: 'item' } });
    await expect(t.run('library.set_config', { defaultNamespace: 'Bad NS' })).rejects.toThrow(/not a valid namespace/);
    expect((await t.run('library.list', { namespace: 'minecraft' })).entries.map((e: { location: string }) => e.location)).toEqual(['minecraft:block/stone']);
  });
});

describe('free documents and the project file', () => {
  it('uses library textures as material maps', async () => {
    const t = testApp({ textureLibrary: lib });
    const cube = (await t.run('scene.add_primitive', { type: 'cube' })).id;
    const added = await t.run('texture.add_from_library', { location: 'surf_textures:block/rock', objects: [cube], slot: 'normal' });
    const material = t.state().materials[t.state().objects[cube].materialId!];
    expect(material.maps.normal).toBe(added.id);
    expect(t.state().textures[added.id].java).toBeUndefined();
  });

  it('keeps links through .tessel save and load; old files still load', async () => {
    const t = await mcApp();
    const id = (await t.run('texture.add_from_library', { location: 'surf_textures:block/rock' })).id;
    const { json } = await t.run('document.serialize', {});
    const loaded = parseProject(json).state;
    expect(loaded.textures[id]).toMatchObject({ link: { namespace: 'surf_textures', path: 'block/rock' }, data: ROCK, java: { namespace: 'surf_textures' } });
    const free = testApp({ textureLibrary: lib });
    const cube = (await free.run('scene.add_primitive', { type: 'cube' })).id;
    const fid = (await free.run('texture.add_from_library', { location: 'surf_textures:block/rock', objects: [cube] })).id;
    expect(parseProject((await free.run('document.serialize', {})).json).state.textures[fid].link).toEqual({ namespace: 'surf_textures', path: 'block/rock' });
    const old = JSON.parse(json);
    for (const texture of old.textures) delete texture.link;
    expect(parseProject(JSON.stringify(old)).state.textures[id].link).toBeUndefined();
    const broken = JSON.parse(json);
    broken.textures[0].link = { namespace: 'Bad NS', path: 'x' };
    expect(() => parseProject(JSON.stringify(broken))).toThrow(/not a valid texture location/);
  });

  it('commands explain that the library needs the desktop app', async () => {
    const t = testApp();
    await expect(t.run('library.list', {})).rejects.toThrow(/desktop app/);
    expect(defaultProjectConfig.textures.defaultFolder).toBe('block');
  });
});
