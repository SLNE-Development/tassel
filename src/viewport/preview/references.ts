import { BoxGeometry, Group, Mesh, MeshStandardMaterial, type Texture } from 'three/webgpu';
import type { DecodedImage, MinecraftAssets } from '../../mcassets/loader';
import { BlockKit } from './terrain';
import { pixelTexture } from './textures';

// Reference models for judging scale: a Minecraft player and a crafting table. Built here from the
// well-known vanilla dimensions (a player is 32 skin pixels tall, drawn at 15/16 scale = 1.875 blocks;
// a crafting table is one block), with the skin and block textures read from the user's own assets.

/** A box of a player model: size and position in skin pixels (feet at y = 0, facing +Z), and where its net starts on the skin. */
export interface SkinBox {
  name: string;
  size: [number, number, number];
  /** Centre of the box's bottom face. */
  at: [number, number, number];
  uv: [number, number];
  /** Overlay layers are a little larger and cut out. */
  inflate?: number;
}

/** Classic (4 px arms) player boxes. "Right" is the player's own right, which is -X when facing +Z. */
export const PLAYER_BOXES: SkinBox[] = [
  { name: 'head', size: [8, 8, 8], at: [0, 24, 0], uv: [0, 0] },
  { name: 'body', size: [8, 12, 4], at: [0, 12, 0], uv: [16, 16] },
  { name: 'right_arm', size: [4, 12, 4], at: [-6, 12, 0], uv: [40, 16] },
  { name: 'left_arm', size: [4, 12, 4], at: [6, 12, 0], uv: [32, 48] },
  { name: 'right_leg', size: [4, 12, 4], at: [-2, 0, 0], uv: [0, 16] },
  { name: 'left_leg', size: [4, 12, 4], at: [2, 0, 0], uv: [16, 48] },
  { name: 'hat', size: [8, 8, 8], at: [0, 24, 0], uv: [32, 0], inflate: 0.5 },
  { name: 'jacket', size: [8, 12, 4], at: [0, 12, 0], uv: [16, 32], inflate: 0.25 },
  { name: 'right_sleeve', size: [4, 12, 4], at: [-6, 12, 0], uv: [40, 32], inflate: 0.25 },
  { name: 'left_sleeve', size: [4, 12, 4], at: [6, 12, 0], uv: [48, 48], inflate: 0.25 },
  { name: 'right_pants', size: [4, 12, 4], at: [-2, 0, 0], uv: [0, 32], inflate: 0.25 },
  { name: 'left_pants', size: [4, 12, 4], at: [2, 0, 0], uv: [0, 48], inflate: 0.25 },
];

/** World units per skin pixel: 1/16 block at the game's 15/16 player scale. */
export const PLAYER_SCALE = (1 / 16) * 0.9375;

type Rect = [number, number, number, number];

/**
 * The skin rectangles of a box's faces in BoxGeometry's order (+X, -X, +Y, -Y, +Z, -Z), each as
 * [x, y, width, height] in skin pixels from the top left. This is the standard Minecraft box net:
 * top and bottom above, then right side, front, left side and back in a row.
 */
export function boxNet(u: number, v: number, [w, h, d]: [number, number, number]): Rect[] {
  return [
    [u + d + w, v + d, d, h], // +X: the player's left side
    [u, v + d, d, h], // -X: the player's right side
    [u + d, v, w, d], // top
    [u + d + w, v, w, d], // bottom
    [u + d, v + d, w, h], // front (+Z)
    [u + 2 * d + w, v + d, w, h], // back
  ];
}

/** A box geometry whose faces show the given skin rectangles. */
function skinnedBox(box: SkinBox, textureSize: [number, number], legacy: boolean): BoxGeometry {
  const grow = (box.inflate ?? 0) * 2;
  const [w, h, d] = box.size;
  const geometry = new BoxGeometry((w + grow) * PLAYER_SCALE, (h + grow) * PLAYER_SCALE, (d + grow) * PLAYER_SCALE);
  geometry.translate(box.at[0] * PLAYER_SCALE, (box.at[1] + h / 2) * PLAYER_SCALE, box.at[2] * PLAYER_SCALE);
  // Old 64x32 skins have no left limbs: the game mirrors the right ones; the unmirrored net is close enough here.
  let [u, v] = box.uv;
  if (legacy && box.name === 'left_arm') [u, v] = [40, 16];
  if (legacy && box.name === 'left_leg') [u, v] = [0, 16];
  const rects = boxNet(u, v, box.size);
  const uv = geometry.getAttribute('uv');
  const [tw, th] = textureSize;
  for (let face = 0; face < 6; face++) {
    const [x, y, rw, rh] = rects[face];
    for (let k = 0; k < 4; k++) {
      const i = face * 4 + k;
      // BoxGeometry's own uv (0..1, v up) says which corner this vertex is.
      uv.setXY(i, (x + uv.getX(i) * rw) / tw, 1 - (y + (1 - uv.getY(i)) * rh) / th);
    }
  }
  uv.needsUpdate = true;
  return geometry;
}

const SKIN_COLOURS = { skin: '#c8a27c', hair: '#4a3222', shirt: '#2e9aa0', pants: '#3b3f9c', shoes: '#4a4a4a', eyes: '#3d4fa8' };

/** A plain made-up skin (flat colours per body part) for when no skin and no assets are available. */
export function fallbackSkin(): DecodedImage {
  const width = 64;
  const height = 64;
  const pixels = new Uint8ClampedArray(width * height * 4);
  const fill = (x: number, y: number, w: number, h: number, hex: string) => {
    const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) pixels.set([...rgb, 255], (j * width + i) * 4);
  };
  for (const box of PLAYER_BOXES.filter((b) => !b.inflate)) {
    const rects = boxNet(box.uv[0], box.uv[1], box.size);
    const colour = box.name === 'head' ? SKIN_COLOURS.skin : box.name === 'body' ? SKIN_COLOURS.shirt : box.name.endsWith('arm') ? SKIN_COLOURS.skin : SKIN_COLOURS.pants;
    for (const [x, y, w, h] of rects) fill(x, y, w, h, colour);
    if (box.name.endsWith('arm')) for (const [x, y, w] of rects.filter((r) => r[3] === 12)) fill(x, y, w, 4, SKIN_COLOURS.shirt);
    if (box.name.endsWith('leg')) for (const [x, y, w] of rects.filter((r) => r[3] === 12)) fill(x, y + 10, w, 2, SKIN_COLOURS.shoes);
  }
  // Hair on top and around the head, eyes on the face (front rect starts at 8, 8).
  fill(8, 0, 8, 8, SKIN_COLOURS.hair);
  for (const [x, y, w] of boxNet(0, 0, [8, 8, 8]).filter((_, i) => i !== 2 && i !== 3)) fill(x, y, w, 2, SKIN_COLOURS.hair);
  fill(24, 8, 8, 8, SKIN_COLOURS.hair);
  fill(9, 12, 2, 1, SKIN_COLOURS.eyes);
  fill(13, 12, 2, 1, SKIN_COLOURS.eyes);
  return { width, height, pixels };
}

/** The vanilla default skin from the assets: the wide Steve of current versions, or the older location. */
export async function defaultSkin(assets: MinecraftAssets | null): Promise<DecodedImage | null> {
  if (!assets) return null;
  for (const id of ['entity/player/wide/steve', 'entity/steve']) {
    const texture = await assets.texture(id).catch(() => null);
    if (texture) return texture;
  }
  return null;
}

/** A player model with the given skin, feet on the ground at the origin, facing +Z. */
export function buildPlayer(skin: DecodedImage): { group: Group; dispose(): void } {
  const legacy = skin.height === skin.width / 2;
  const texture: Texture = pixelTexture(skin);
  const base = new MeshStandardMaterial({ map: texture, roughness: 1, metalness: 0 });
  const overlay = new MeshStandardMaterial({ map: texture, roughness: 1, metalness: 0, alphaTest: 0.5 });
  const group = new Group();
  group.name = 'preview-player';
  const geometries: BoxGeometry[] = [];
  for (const box of PLAYER_BOXES) {
    // Legacy skins only have the hat as an overlay.
    if (legacy && box.inflate && box.name !== 'hat') continue;
    const geometry = skinnedBox(box, [skin.width, skin.height], legacy);
    geometries.push(geometry);
    group.add(new Mesh(geometry, box.inflate ? overlay : base));
  }
  return {
    group,
    dispose: () => {
      geometries.forEach((g) => g.dispose());
      base.dispose();
      overlay.dispose();
      texture.dispose();
    },
  };
}

/** A crafting table, one block, standing on the ground with its bottom centre at the origin. */
export async function buildCraftingTable(kit: BlockKit, assets: MinecraftAssets | null): Promise<{ group: Group; dispose(): void }> {
  const set = await kit.materials('crafting_table');
  // The front texture (saw and tools) on two sides, as in the game.
  const front = assets ? await assets.texture('block/crafting_table_front').catch(() => null) : null;
  const owned: { dispose(): void }[] = [];
  const lit = set.faces.map((face) => {
    const material = new MeshStandardMaterial({ map: face.map, color: face.map ? 0xffffff : face.color.clone(), roughness: 1, metalness: 0 });
    owned.push(material);
    return material;
  });
  if (front) {
    const texture = pixelTexture(front);
    owned.push(texture);
    for (const i of [0, 4]) lit[i].map = texture;
  }
  const geometry = new BoxGeometry(1, 1, 1);
  geometry.translate(0, 0.5, 0);
  owned.push(geometry);
  const group = new Group();
  group.name = 'preview-crafting-table';
  group.add(new Mesh(geometry, lit));
  return { group, dispose: () => owned.forEach((o) => o.dispose()) };
}
