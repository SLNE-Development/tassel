import { describe, expect, it } from 'vitest';
import { minecraftScenes, previewScenes } from '../../core/preview';
import { blocks } from './blocks';
import { boxNet, fallbackSkin, PLAYER_BOXES, PLAYER_SCALE } from './references';
import { generateTerrain, sceneLooks, TERRAIN_RADIUS, type TerrainKind } from './scenes';
import { composite, firstFrame, tinted } from './textures';

describe('preview scenes', () => {
  it('have a look for every scene but "none", and terrain for every Minecraft scene', () => {
    for (const scene of previewScenes) if (scene !== 'none') expect(sceneLooks[scene], scene).toBeDefined();
    for (const scene of minecraftScenes) expect(sceneLooks[scene].terrain, scene).not.toBeNull();
    expect(sceneLooks.studio.terrain).toBeNull();
  });

  const kinds = [...new Set(minecraftScenes.map((scene) => sceneLooks[scene].terrain!))] as TerrainKind[];

  it.each(kinds)('%s: leaves a flat, free floor for the model and stays in its radius', (kind) => {
    const terrain = generateTerrain(kind);
    expect(terrain.blocks.length).toBeGreaterThan(500);
    for (const block of terrain.blocks) {
      expect(blocks[block.block], block.block).toBeDefined();
      expect(Math.hypot(block.x, block.z)).toBeLessThanOrEqual(TERRAIN_RADIUS + 0.5);
      // Around the model: nothing sticks out above the floor, except a cave ceiling well overhead.
      if (Math.hypot(block.x, block.z) <= 4) expect(block.y <= 0 || block.y >= 8, `${kind} ${block.block} at ${block.x},${block.y},${block.z}`).toBe(true);
    }
    const floor = terrain.blocks.find((b) => b.x === 0 && b.z === 0 && b.y === 0);
    expect(floor, `${kind} has a block under the model`).toBeDefined();
  });

  it('is the same every time', () => {
    expect(generateTerrain('plains')).toEqual(generateTerrain('plains'));
  });

  it('puts water over the ocean and above the underwater floor', () => {
    expect(generateTerrain('ocean').water).toEqual({ y: -0.125, radius: TERRAIN_RADIUS });
    expect(generateTerrain('underwater').water?.y).toBeGreaterThan(5);
    expect(generateTerrain('plains').water).toBeNull();
  });
});

describe('reference player', () => {
  it('is 1.875 blocks tall', () => {
    const top = Math.max(...PLAYER_BOXES.filter((b) => !b.inflate).map((b) => b.at[1] + b.size[1]));
    expect(top * PLAYER_SCALE).toBeCloseTo(1.875, 6);
  });

  it('uses the standard box net of the skin', () => {
    // The head: right side, front, left side and back in a row under top and bottom.
    expect(boxNet(0, 0, [8, 8, 8])).toEqual([
      [16, 8, 8, 8],
      [0, 8, 8, 8],
      [8, 0, 8, 8],
      [16, 0, 8, 8],
      [8, 8, 8, 8],
      [24, 8, 8, 8],
    ]);
    // Every box fits on a 64 x 64 skin.
    for (const box of PLAYER_BOXES) for (const [x, y, w, h] of boxNet(box.uv[0], box.uv[1], box.size)) expect(x + w <= 64 && y + h <= 64, box.name).toBe(true);
  });

  it('has a made-up fallback skin that covers every base box', () => {
    const skin = fallbackSkin();
    expect([skin.width, skin.height]).toEqual([64, 64]);
    const alpha = (x: number, y: number) => skin.pixels[(y * 64 + x) * 4 + 3];
    for (const box of PLAYER_BOXES.filter((b) => !b.inflate)) {
      for (const [x, y] of boxNet(box.uv[0], box.uv[1], box.size)) expect(alpha(x, y), box.name).toBe(255);
    }
    // Overlay areas stay transparent.
    expect(alpha(40, 8)).toBe(0);
  });
});

describe('texture helpers', () => {
  const image = (rgba: number[], width = 1, height = rgba.length / 4 / width) => ({ width, height, pixels: new Uint8ClampedArray(rgba) });

  it('tints greyscale textures', () => {
    expect([...tinted(image([255, 128, 0, 200]), '#80ff40').pixels]).toEqual([128, 128, 0, 200]);
  });

  it('lays a translucent overlay over a base', () => {
    expect([...composite(image([0, 0, 0, 255, 10, 20, 30, 255], 2), image([255, 255, 255, 0, 200, 100, 0, 255], 2)).pixels]).toEqual([0, 0, 0, 255, 200, 100, 0, 255]);
  });

  it('takes the first frame of an animation strip', () => {
    const strip = { ...image([1, 1, 1, 1, 2, 2, 2, 2]), id: 'x', path: 'x', bytes: new Uint8Array(), frameHeight: 1, frames: 2, animation: {} };
    expect(firstFrame(strip)).toEqual({ width: 1, height: 1, pixels: new Uint8ClampedArray([1, 1, 1, 1]) });
  });
});
