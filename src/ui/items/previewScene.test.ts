import { describe, expect, it } from 'vitest';
import { parseItemDefinitionText } from '../../core/minecraft/items/codec';
import { evaluateItem } from '../../core/minecraft/items/evaluate';
import { colorToHex, hexToColor } from '../../core/minecraft/items/colors';
import { encodePng } from '../../imaging/png';
import { MinecraftAssets } from '../../mcassets/loader';
import { buildPreviewScene, previewOffset } from './previewScene';

async function png(rgba: [number, number, number, number]) {
  const pixels = new Uint8ClampedArray(16 * 16 * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels.set(rgba, i);
  return encodePng(pixels, 16, 16);
}

async function pack() {
  const files: Record<string, string | Uint8Array> = {
    'assets/minecraft/models/item/generated.json': JSON.stringify({ parent: 'builtin/generated' }),
    'assets/mymod/models/item/gem.json': JSON.stringify({ parent: 'minecraft:item/generated', textures: { layer0: 'mymod:item/gem', layer1: 'mymod:item/gem_overlay' } }),
    'assets/mymod/models/block/cube.json': JSON.stringify({
      textures: { all: 'mymod:block/cube' },
      elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: { north: { texture: '#all', tintindex: 0 }, up: { texture: '#all' } } }],
    }),
    'assets/mymod/textures/item/gem.png': await png([200, 200, 200, 255]),
    'assets/mymod/textures/item/gem_overlay.png': await png([255, 255, 255, 128]),
    'assets/mymod/textures/block/cube.png': await png([255, 255, 255, 255]),
  };
  return new MinecraftAssets({ read: async (path) => (typeof files[path] === 'string' ? new TextEncoder().encode(files[path] as string) : ((files[path] as Uint8Array) ?? null)) });
}

describe('item preview scene', () => {
  it('draws the chosen models as cuboid elements, layers of generated items included', async () => {
    const def = parseItemDefinitionText(
      JSON.stringify({
        model: {
          type: 'minecraft:composite',
          models: [
            { type: 'minecraft:model', model: 'mymod:item/gem', tints: [{ type: 'minecraft:constant', value: -65536 }] },
            { type: 'minecraft:model', model: 'mymod:block/cube', tints: [{ type: 'minecraft:dye', default: -16776961 }], transformation: { translation: [1, 0, 0], left_rotation: [0, 0, 0, 1], scale: [1, 1, 1], right_rotation: [0, 0, 0, 1] } },
            { type: 'minecraft:model', model: 'mymod:block/cube' },
            { type: 'minecraft:model', model: 'mymod:item/nope' },
            { type: 'minecraft:special', base: 'minecraft:item/chest', model: { type: 'minecraft:chest', texture: 'minecraft:normal' } },
          ],
        },
      }),
    );
    const { rendered } = evaluateItem(def);
    const { state, notes } = await buildPreviewScene(rendered, await pack(), {});
    expect(notes.map((n) => [n.path, n.problem])).toEqual([
      ['models/3', 'missing'],
      ['models/4', 'special'],
    ]);
    expect(state?.format).toBe('minecraft_java');
    // Two layers of the gem, the cube twice (with its own ids the second time).
    expect(state!.order).toHaveLength(4);
    expect(new Set(state!.order).size).toBe(4);
    const cubes = state!.order.slice(2).map((id) => state!.objects[id]);
    expect(cubes[0].transform.position[0] - cubes[1].transform.position[0]).toBeCloseTo(1);
    // The tinted north face of the first cube uses a tinted copy of the texture.
    const names = Object.values(state!.textures).map((t) => t.name);
    expect(names.some((n) => n.includes('_tint_0000ff'))).toBe(true);
    expect(names.some((n) => n.includes('gem_tint_ff0000'))).toBe(true);
  });

  it('shows nothing (and says why) without a pack', async () => {
    const def = parseItemDefinitionText('{"model":{"type":"minecraft:model","model":"item/stick"}}');
    expect(await buildPreviewScene(evaluateItem(def).rendered, null, {})).toEqual({ state: null, notes: [{ path: '', model: 'item/stick', problem: 'missing' }] });
  });

  it('adds up translations and converts colours both ways', () => {
    expect(previewOffset([{ translation: [0.5, 0, 0.5] }, [1, 0, 0, 0], { translation: [0, 1, 0] }])).toEqual([0.5, 1, 0.5]);
    expect(colorToHex(-6265536)).toBe('#a06540');
    expect(colorToHex([1, 0.5, 0])).toBe('#ff8000');
    expect(hexToColor('#a06540')).toBe(-6265536);
    expect(hexToColor('#ff8000', [0, 0, 0])).toEqual([1, 0.502, 0]);
  });
});
