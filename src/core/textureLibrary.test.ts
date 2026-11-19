import { describe, expect, it } from 'vitest';
import {
  fileTextureLink,
  filterEntries,
  joinLink,
  libraryTree,
  linkLocation,
  parseMcmeta,
  parseProjectConfig,
  parseTextureLocation,
  relinkedFields,
  resolveLink,
  rewriteModelTextures,
  rewriteProjectLinks,
  serializeProjectConfig,
  shortLinkLocation,
  syncDecision,
  textureFilePath,
  textureLink,
  type LibraryEntry,
} from './textureLibrary';

function entry(location: string, sourceKind: LibraryEntry['sourceKind'], source = sourceKind === 'vanilla' ? 'vanilla' : `${sourceKind}:1`): LibraryEntry {
  const link = parseTextureLocation(location);
  return {
    location: linkLocation(link),
    ...link,
    source,
    sourceKind,
    file: textureFilePath(link),
    width: 16,
    height: 16,
    size: 100,
    modified: 1,
    animation: null,
    readOnly: sourceKind === 'vanilla',
  };
}

describe('resource locations', () => {
  it('parses what people type', () => {
    expect(parseTextureLocation('surf_textures:block/rock')).toEqual({ namespace: 'surf_textures', path: 'block/rock' });
    expect(parseTextureLocation('block/stone')).toEqual({ namespace: 'minecraft', path: 'block/stone' });
    expect(parseTextureLocation('block/rock', 'surf')).toEqual({ namespace: 'surf', path: 'block/rock' });
    expect(parseTextureLocation('surf:textures/block/rock.png')).toEqual({ namespace: 'surf', path: 'block/rock' });
    expect(parseTextureLocation('assets/surf/textures/item/a/b.png')).toEqual({ namespace: 'surf', path: 'item/a/b' });
    expect(parseTextureLocation('C:\\packs\\x\\assets\\surf\\textures\\block\\rock.png')).toEqual({ namespace: 'surf', path: 'block/rock' });
    expect(parseTextureLocation('Surf:Block/Rock')).toEqual({ namespace: 'surf', path: 'block/rock' });
  });

  it('rejects locations Minecraft would reject', () => {
    expect(() => parseTextureLocation('bad space:block/x')).toThrow(/namespace/);
    expect(() => parseTextureLocation('surf:../x')).toThrow(/path/);
    expect(() => parseTextureLocation('surf:')).toThrow();
    expect(() => parseTextureLocation('#side')).toThrow();
  });

  it('maps locations to files and back', () => {
    const link = { namespace: 'surf', path: 'block/rock' };
    expect(textureFilePath(link)).toBe('assets/surf/textures/block/rock.png');
    expect(textureFilePath(link, '')).toBe('surf/textures/block/rock.png');
    expect(fileTextureLink('assets/surf/textures/block/rock.png')).toEqual(link);
    expect(fileTextureLink('surf/textures/block/rock.png')).toEqual(link);
    expect(fileTextureLink('assets/surf/models/block/rock.json')).toBeNull();
    expect(shortLinkLocation({ namespace: 'minecraft', path: 'block/stone' })).toBe('block/stone');
    expect(shortLinkLocation(link)).toBe('surf:block/rock');
    expect(joinLink('surf', '/block/', 'rock')).toEqual(link);
    expect(joinLink('surf', '', 'rock')).toEqual({ namespace: 'surf', path: 'rock' });
  });

  it('gives Minecraft textures their location from the Java reference', () => {
    expect(textureLink({ name: 'rock', java: { namespace: 'surf', folder: 'block', key: '0' } })).toEqual({ namespace: 'surf', path: 'block/rock' });
    expect(textureLink({ name: 'x', java: { namespace: 'a', folder: 'b', key: '0' }, link: { namespace: 'c', path: 'd/e' } })).toEqual({ namespace: 'c', path: 'd/e' });
    expect(textureLink({ name: 'x' })).toBeNull();
  });

  it('relinking a Minecraft texture moves its name, namespace and folder along', () => {
    const java = { namespace: 'minecraft', folder: 'block', key: '3' };
    expect(relinkedFields({ name: 'old', java }, { namespace: 'surf', path: 'item/tools/saw' })).toEqual({
      name: 'saw',
      java: { namespace: 'surf', folder: 'item/tools', key: '3' },
      link: { namespace: 'surf', path: 'item/tools/saw' },
    });
    // Free documents keep their texture name.
    expect(relinkedFields({ name: 'Wood' }, { namespace: 'surf', path: 'block/oak' })).toEqual({ name: 'Wood', link: { namespace: 'surf', path: 'block/oak' } });
  });
});

describe('link resolution', () => {
  const entries = [entry('minecraft:block/stone', 'vanilla'), entry('minecraft:block/stone', 'project'), entry('surf:block/rock', 'folder'), entry('surf:block/rock', 'folder', 'folder:2')];

  it('prefers the project, then library folders, then vanilla', () => {
    expect(resolveLink(entries, { namespace: 'minecraft', path: 'block/stone' })?.sourceKind).toBe('project');
    expect(resolveLink(entries, { namespace: 'surf', path: 'block/rock' })?.source).toBe('folder:1');
    expect(resolveLink(entries, { namespace: 'surf', path: 'block/rock' }, 'folder:2')?.source).toBe('folder:2');
    expect(resolveLink(entries, { namespace: 'surf', path: 'block/none' })).toBeNull();
  });

  it('filters and builds the namespace tree', () => {
    const list = [entry('surf:block/rock', 'project'), entry('surf:block/ore/gold', 'project'), entry('surf:item/saw', 'project'), entry('minecraft:block/stone', 'vanilla')];
    expect(filterEntries(list, { namespace: 'surf', folder: 'block' }).map((e) => e.path)).toEqual(['block/ore/gold', 'block/rock']);
    expect(filterEntries(list, { search: 'SAW' }).map((e) => e.location)).toEqual(['surf:item/saw']);
    expect(filterEntries(list, { source: 'vanilla' })).toHaveLength(1);
    expect(libraryTree(list)).toEqual([
      { namespace: 'surf', folders: ['block', 'block/ore', 'item'], count: 3 },
      { namespace: 'minecraft', folders: ['block'], count: 1 },
    ]);
  });
});

describe('project config', () => {
  it('reads leniently and falls back', () => {
    expect(parseProjectConfig(null)).toEqual({ textures: { defaultNamespace: null, defaultFolder: 'block' } });
    expect(parseProjectConfig('{"textures":{"defaultNamespace":"surf_textures","defaultFolder":"item"}}')).toEqual({ textures: { defaultNamespace: 'surf_textures', defaultFolder: 'item' } });
    expect(parseProjectConfig('{"textures":{"defaultNamespace":"Bad NS","defaultFolder":"../x"}}')).toEqual({ textures: { defaultNamespace: null, defaultFolder: 'block' } });
    expect(() => parseProjectConfig('{nope')).toThrow(/tessel.project.json/);
  });

  it('round-trips and keeps unknown keys', () => {
    const previous = '{"other":1,"textures":{"future":true,"defaultNamespace":"x"}}';
    const text = serializeProjectConfig({ textures: { defaultNamespace: 'surf_textures', defaultFolder: 'block' } }, previous);
    expect(JSON.parse(text)).toEqual({ other: 1, textures: { future: true, defaultNamespace: 'surf_textures', defaultFolder: 'block' } });
    expect(parseProjectConfig(text).textures.defaultNamespace).toBe('surf_textures');
    expect(text.endsWith('\n')).toBe(true);
  });
});

describe('mcmeta', () => {
  it('counts frames and reads the timing', () => {
    expect(parseMcmeta('{"animation":{"frametime":2}}', 16, 64)).toEqual({ frames: 4, frametime: 2, interpolate: false, frameWidth: 16, frameHeight: 16 });
    expect(parseMcmeta('{"animation":{"frames":[0,1,0,2],"interpolate":true}}', 16, 48)?.frames).toBe(4);
    expect(parseMcmeta('{"animation":{"height":8}}', 16, 32)).toMatchObject({ frames: 4, frameWidth: 16, frameHeight: 8 });
    expect(parseMcmeta('{"texture":{"blur":true}}', 16, 16)).toBeNull();
    expect(parseMcmeta('broken', 16, 16)).toBeNull();
  });
});

describe('sync decisions', () => {
  it('takes the file unless the document has its own changes', () => {
    expect(syncDecision('a', 'a', undefined)).toBe('same');
    expect(syncDecision('cached', 'file', undefined)).toBe('update');
    expect(syncDecision('base', 'new', 'base')).toBe('update');
    expect(syncDecision('painted', 'base', 'base')).toBe('local');
    expect(syncDecision('painted', 'new', 'base')).toBe('conflict');
  });
});

describe('rewriting references', () => {
  const from = { namespace: 'surf', path: 'block/rock' };
  const to = { namespace: 'surf', path: 'block/stone/rock' };

  it('changes texture values of models in place', () => {
    const model = '{\n  "parent": "block/cube_all",\n  "textures": {\n    "all": "surf:block/rock",\n    "particle": "#all"\n  }\n}\n';
    expect(rewriteModelTextures(model, from, to)).toBe(model.replace('surf:block/rock', 'surf:block/stone/rock'));
    expect(rewriteModelTextures('{"textures":{"all":"surf:block/other"}}', from, to)).toBeNull();
    expect(rewriteModelTextures('not json', from, to)).toBeNull();
  });

  it('leaves a model path that happens to look like the texture alone', () => {
    const vanilla = { namespace: 'minecraft', path: 'block/stone' };
    const model = '{"parent":"block/stone","textures":{"all":"block/stone"}}';
    const out = rewriteModelTextures(model, vanilla, { namespace: 'surf', path: 'block/rock' })!;
    expect(JSON.parse(out)).toEqual({ parent: 'block/stone', textures: { all: 'surf:block/rock' } });
  });

  it('relinks .tessel files', () => {
    const project = JSON.stringify({ format: 'tessel', textures: [{ id: 't', name: 'rock', link: from, java: { namespace: 'surf', folder: 'block', key: '0' } }, { id: 'u', name: 'x' }] });
    const out = JSON.parse(rewriteProjectLinks(project, from, to)!);
    expect(out.textures[0]).toMatchObject({ name: 'rock', link: to, java: { namespace: 'surf', folder: 'block/stone', key: '0' } });
    expect(out.textures[1]).toEqual({ id: 'u', name: 'x' });
    expect(rewriteProjectLinks(project, to, from)).toBeNull();
  });
});
