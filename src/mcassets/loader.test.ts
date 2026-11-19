import { describe, expect, it } from 'vitest';
import { assetPath, formatResourceLocation, parseResourceLocation } from '../core/minecraftAssets';
import { encodePng } from '../imaging/png';
import { MinecraftAssets, resolveTextureVariable, type AssetSource } from './loader';

/** An in-memory pack that counts reads per path. */
function memorySource(files: Record<string, string | Uint8Array>) {
  const reads = new Map<string, number>();
  const source: AssetSource = {
    async read(path) {
      reads.set(path, (reads.get(path) ?? 0) + 1);
      const file = files[path];
      if (file === undefined) return null;
      return typeof file === 'string' ? new TextEncoder().encode(file) : file;
    },
    async list(prefix) {
      return Object.keys(files).filter((path) => path.startsWith(prefix)).sort();
    },
  };
  return { source, reads };
}

async function png(width: number, height: number, rgba: [number, number, number, number]) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels.set(rgba, i);
  return encodePng(pixels, width, height);
}

describe('resource locations', () => {
  it('default to the minecraft namespace', () => {
    expect(parseResourceLocation('block/stone')).toEqual({ namespace: 'minecraft', path: 'block/stone' });
    expect(parseResourceLocation('create:item/wrench')).toEqual({ namespace: 'create', path: 'item/wrench' });
    expect(parseResourceLocation(':block/stone')).toEqual({ namespace: 'minecraft', path: 'block/stone' });
    expect(parseResourceLocation('Block/Stone')).toEqual({ namespace: 'minecraft', path: 'block/stone' });
    expect(formatResourceLocation(parseResourceLocation('block/dirt'))).toBe('minecraft:block/dirt');
  });

  it('reject what Minecraft rejects, and paths that leave the pack', () => {
    for (const bad of ['', '#all', 'mine craft:block/x', 'minecraft:', 'a:b:c', 'block/../x', '/block/x', 'block/x/', 'block//x', 'block\\x']) {
      expect(() => parseResourceLocation(bad), bad).toThrow(/not a valid resource location/);
    }
  });

  it('map ids to files in the pack', () => {
    expect(assetPath('texture', 'block/stone')).toBe('assets/minecraft/textures/block/stone.png');
    expect(assetPath('texture', 'minecraft:block/stone.png')).toBe('assets/minecraft/textures/block/stone.png');
    expect(assetPath('textureMeta', 'block/water_still')).toBe('assets/minecraft/textures/block/water_still.png.mcmeta');
    expect(assetPath('model', 'mymod:item/gear')).toBe('assets/mymod/models/item/gear.json');
    expect(assetPath('itemDefinition', 'diamond_sword')).toBe('assets/minecraft/items/diamond_sword.json');
    expect(assetPath('blockstate', 'oak_log')).toBe('assets/minecraft/blockstates/oak_log.json');
  });
});

describe('MinecraftAssets', () => {
  it('reads each file once, also when asked concurrently', async () => {
    const { source, reads } = memorySource({ 'assets/minecraft/models/block/cube.json': '{"elements":[]}' });
    const assets = new MinecraftAssets(source);
    const [a, b] = await Promise.all([assets.model('block/cube'), assets.model('minecraft:block/cube')]);
    expect(a).toEqual({ elements: [] });
    expect(b).toBe(a);
    expect(reads.get('assets/minecraft/models/block/cube.json')).toBe(1);
    expect(await assets.model('block/missing')).toBeNull();
    assets.clear();
    await assets.model('block/cube');
    expect(reads.get('assets/minecraft/models/block/cube.json')).toBe(2);
  });

  it('does not cache failed reads', async () => {
    let fail = true;
    const assets = new MinecraftAssets({
      read: async () => {
        if (fail) throw new Error('disk on fire');
        return new TextEncoder().encode('{}');
      },
    });
    await expect(assets.blockstate('stone')).rejects.toThrow('disk on fire');
    fail = false;
    expect(await assets.blockstate('stone')).toEqual({});
  });

  it('rejects broken JSON with the path', async () => {
    const { source } = memorySource({ 'assets/minecraft/items/stick.json': '{nope' });
    await expect(new MinecraftAssets(source).itemDefinition('stick')).rejects.toThrow(/assets\/minecraft\/items\/stick.json is not valid JSON/);
  });

  it('decodes textures and describes animation strips', async () => {
    const { source } = memorySource({
      'assets/minecraft/textures/block/stone.png': await png(16, 16, [120, 120, 120, 255]),
      'assets/minecraft/textures/block/water_still.png': await png(16, 64, [40, 80, 200, 180]),
      'assets/minecraft/textures/block/water_still.png.mcmeta': '{"animation":{"frametime":2}}',
    });
    const assets = new MinecraftAssets(source);
    const stone = await assets.texture('block/stone');
    expect(stone).toMatchObject({ id: 'minecraft:block/stone', width: 16, height: 16, frames: 1, frameHeight: 16, animation: null });
    expect([...stone!.pixels.slice(0, 4)]).toEqual([120, 120, 120, 255]);
    const water = await assets.texture('minecraft:block/water_still');
    expect(water).toMatchObject({ width: 16, height: 64, frames: 4, frameHeight: 16, animation: { frametime: 2 } });
    expect(await assets.texture('block/nothing')).toBeNull();
    expect(await assets.texture('block/stone')).toBe(stone);
  });

  it('lists files', async () => {
    const { source } = memorySource({ 'assets/minecraft/textures/block/a.png': '', 'assets/minecraft/textures/item/b.png': '' });
    expect(await new MinecraftAssets(source).list('assets/minecraft/textures/block/')).toEqual(['assets/minecraft/textures/block/a.png']);
  });

  it('resolves parent chains like the game', async () => {
    const { source } = memorySource({
      'assets/minecraft/models/block/block.json': JSON.stringify({
        gui_light: 'side',
        display: { gui: { rotation: [30, 225, 0], scale: [0.625, 0.625, 0.625] }, head: { scale: [1, 1, 1] } },
      }),
      'assets/minecraft/models/block/cube.json': JSON.stringify({
        parent: 'block/block',
        elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: { down: { texture: '#down' }, up: { texture: '#up' } } }],
      }),
      'assets/minecraft/models/block/cube_all.json': JSON.stringify({ parent: 'minecraft:block/cube', textures: { particle: '#all', down: '#all', up: '#all' } }),
      'assets/minecraft/models/block/stone.json': JSON.stringify({ parent: 'block/cube_all', textures: { all: 'block/stone' }, display: { gui: { rotation: [0, 0, 0] } } }),
    });
    const model = await new MinecraftAssets(source).resolveModel('stone'.replace(/^/, 'block/'));
    expect(model).not.toBeNull();
    expect(model!.chain).toEqual(['minecraft:block/stone', 'minecraft:block/cube_all', 'minecraft:block/cube', 'minecraft:block/block']);
    expect(model!.textures).toEqual({ particle: 'minecraft:block/stone', down: 'minecraft:block/stone', up: 'minecraft:block/stone', all: 'minecraft:block/stone' });
    expect(model!.elements).toHaveLength(1);
    // Children override display contexts as a whole.
    expect(model!.display.gui).toEqual({ rotation: [0, 0, 0] });
    expect(model!.display.head).toEqual({ scale: [1, 1, 1] });
    expect(model!).toMatchObject({ ambientocclusion: true, guiLight: 'side', builtin: null, textureSize: null });
  });

  it('marks generated item models and reports broken chains', async () => {
    const { source } = memorySource({
      'assets/minecraft/models/item/generated.json': JSON.stringify({ parent: 'builtin/generated', gui_light: 'front' }),
      'assets/minecraft/models/item/stick.json': JSON.stringify({ parent: 'item/generated', textures: { layer0: 'item/stick' } }),
      'assets/minecraft/models/item/orphan.json': JSON.stringify({ parent: 'item/gone' }),
      'assets/minecraft/models/item/a.json': JSON.stringify({ parent: 'item/b' }),
      'assets/minecraft/models/item/b.json': JSON.stringify({ parent: 'item/a' }),
    });
    const assets = new MinecraftAssets(source);
    expect(await assets.resolveModel('item/stick')).toMatchObject({
      chain: ['minecraft:item/stick', 'minecraft:item/generated', 'minecraft:builtin/generated'],
      builtin: 'generated',
      elements: null,
      guiLight: 'front',
      textures: { layer0: 'minecraft:item/stick' },
    });
    expect(await assets.resolveModel('item/none')).toBeNull();
    await expect(assets.resolveModel('item/orphan')).rejects.toThrow(/Missing parent model minecraft:item\/gone/);
    await expect(assets.resolveModel('item/a')).rejects.toThrow(/cycle/);
  });
});

describe('resolveTextureVariable', () => {
  it('follows references and keeps the last one that leads nowhere', () => {
    const textures = { all: 'block/stone', side: '#all', top: '#missing', a: '#b', b: '#a' };
    expect(resolveTextureVariable(textures, '#side')).toBe('minecraft:block/stone');
    expect(resolveTextureVariable(textures, '#top')).toBe('#missing');
    expect(resolveTextureVariable(textures, '#a')).toBe('#a');
    expect(resolveTextureVariable(textures, 'create:block/x')).toBe('create:block/x');
  });
});
