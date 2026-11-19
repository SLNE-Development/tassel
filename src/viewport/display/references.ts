import { BoxGeometry, CanvasTexture, Color, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, NearestFilter, PlaneGeometry, SRGBColorSpace, Matrix4, type Material, type Texture } from 'three/webgpu';
import type { DecodedImage, MinecraftAssets } from '../../mcassets/loader';
import { BlockKit, lightBlocks } from '../preview/terrain';
import type { BlockName } from '../preview/blocks';
import { firstFrame, pixelTexture } from '../preview/textures';
import { armPose, BABY_BODY, BABY_HEAD, entityRoot, headPivot, mul, partMatrix, type FrameKind, type Holder } from './slotMath';

// The reference scenes of the Display workspace, built from vanilla dimensions: entity models as boxes in
// the game's model space (px, y down, front -Z, posed by slotMath's matrices), item frame, shelf, blocks and
// GUI screens. Textures come from the user's Minecraft assets; without them every part has a flat colour.

export interface Built {
  group: Group;
  dispose(): void;
}

/** Collects what a build creates, so that one call frees it all. */
class Owned {
  private readonly items: { dispose(): void }[] = [];
  add<T extends { dispose(): void }>(item: T): T {
    this.items.push(item);
    return item;
  }
  dispose = (): void => {
    for (const item of this.items) item.dispose();
    this.items.length = 0;
  };
}

async function loadTexture(assets: MinecraftAssets | null, id: string): Promise<DecodedImage | null> {
  if (!assets) return null;
  try {
    const texture = await assets.texture(id);
    return texture ? firstFrame(texture) : null;
  } catch (error) {
    console.warn(`Display reference: could not load ${id}`, error);
    return null;
  }
}

// ---- Box models (entity model space) --------------------------------------------------------------------

interface Cube {
  /** Corner relative to the part's pivot, px. */
  from: [number, number, number];
  size: [number, number, number];
  /** Where the box net starts on the texture. */
  uv?: [number, number];
  mirror?: boolean;
  inflate?: number;
  /** Flat colour when there is no texture. */
  color: string;
  /** Overlay layers are cut out. */
  overlay?: boolean;
}

interface Part {
  pivot: [number, number, number];
  rotation?: [number, number, number];
  cubes: Cube[];
}

type Rect = [number, number, number, number];

/**
 * The texture rectangles of a box's faces in BoxGeometry's order (+X, -X, +Y, -Y, +Z, -Z), in entity
 * model space: +X is the model's left side, -Y its top, -Z its front. The standard box net.
 */
function netRects(u: number, v: number, [w, h, d]: [number, number, number], mirror: boolean): Rect[] {
  const left: Rect = [u + d + w, v + d, d, h];
  const right: Rect = [u, v + d, d, h];
  return [mirror ? right : left, mirror ? left : right, [u + d + w, v, w, d], [u + d, v, w, d], [u + 2 * d + w, v + d, w, h], [u + d, v + d, w, h]];
}

/**
 * A box in model space with its net's texture coordinates, worked out per vertex from where the vertex
 * lies on its face (seen from outside, top of the texture = top of the model).
 */
function cubeGeometry(cube: Cube, textureSize: [number, number] | null): BoxGeometry {
  const [w, h, d] = cube.size;
  const grow = cube.inflate ?? 0;
  const geometry = new BoxGeometry(w + grow * 2, h + grow * 2, d + grow * 2);
  geometry.translate(cube.from[0] + w / 2, cube.from[1] + h / 2, cube.from[2] + d / 2);
  if (textureSize && cube.uv) {
    const rects = netRects(cube.uv[0], cube.uv[1], cube.size, cube.mirror ?? false);
    const position = geometry.getAttribute('position');
    const uv = geometry.getAttribute('uv');
    const [x0, y0, z0] = cube.from;
    const [tw, th] = textureSize;
    for (let face = 0; face < 6; face++) {
      const [ru, rv, rw, rh] = rects[face];
      for (let k = 0; k < 4; k++) {
        const i = face * 4 + k;
        // Position on the box from 0 to 1 along each axis (inflation does not move the texture).
        const fx = Math.min(1, Math.max(0, (position.getX(i) - x0) / w));
        const fy = Math.min(1, Math.max(0, (position.getY(i) - y0) / h));
        const fz = Math.min(1, Math.max(0, (position.getZ(i) - z0) / d));
        // [across, down] on the face as seen from outside, upright.
        const across = [fz, 1 - fz, fx, fx, 1 - fx, fx][face];
        const down = [fy, fy, fz, 1 - fz, fy, fy][face];
        const a = cube.mirror ? 1 - across : across;
        uv.setXY(i, (ru + a * rw) / tw, 1 - (rv + down * rh) / th);
      }
    }
    uv.needsUpdate = true;
  }
  geometry.scale(1 / 16, 1 / 16, 1 / 16);
  return geometry;
}

/** Parts as three.js groups under one root carrying `root`; `extra` wraps some parts (baby proportions). */
function buildBoxModel(parts: Record<string, Part>, image: DecodedImage | null, root: Matrix4, wrap: (name: string) => Matrix4 | null = () => null): Built {
  const owned = new Owned();
  const texture = image ? owned.add(pixelTexture(image)) : null;
  const size: [number, number] | null = image ? [image.width, image.height] : null;
  const materials = new Map<string, Material>();
  const material = (cube: Cube) => {
    const key = texture ? (cube.overlay ? 'overlay' : 'base') : cube.color;
    let m = materials.get(key);
    if (!m) {
      m = owned.add(
        texture
          ? new MeshStandardMaterial({ map: texture, roughness: 1, metalness: 0, alphaTest: cube.overlay ? 0.5 : 0.1 })
          : new MeshStandardMaterial({ color: new Color(cube.color), roughness: 1, metalness: 0 }),
      );
      materials.set(key, m);
    }
    return m;
  };
  const group = new Group();
  group.matrixAutoUpdate = false;
  group.matrix.copy(root);
  for (const [name, part] of Object.entries(parts)) {
    const node = new Group();
    node.matrixAutoUpdate = false;
    const outer = wrap(name);
    node.matrix.copy(outer ? mul(outer, partMatrix(part.pivot, part.rotation)) : partMatrix(part.pivot, part.rotation));
    for (const cube of part.cubes) {
      // Without the skin's overlay pixels a flat overlay would only hide the base.
      if (cube.overlay && !texture) continue;
      node.add(new Mesh(owned.add(cubeGeometry(cube, size)), material(cube)));
    }
    group.add(node);
  }
  return { group, dispose: owned.dispose };
}

const SKIN = '#c8a27c';
const SHIRT = '#2e9aa0';
const PANTS = '#3b3f9c';
const ZOMBIE = '#4f8a3c';
const ZOMBIE_SHIRT = '#2f8d8f';
const WOOD = '#9c7a4a';

interface HumanoidLook {
  /** The 64x64 player layout with its own left limbs and overlays; else limbs mirrored like mobs. */
  playerLayout: boolean;
  skin: string;
  shirt: string;
  pants: string;
}

function humanoidParts(look: HumanoidLook, raise: { right: number; left: number }, headPitch: number, holder: Holder): Record<string, Part> {
  const { playerLayout: p } = look;
  const right = armPose(holder, false, raise.right);
  const left = armPose(holder, true, raise.left);
  const limb = (uv: [number, number], overlayUv: [number, number] | null, mirror: boolean, x: number, colorTop: string): Cube[] => [
    { from: [x, -2, -2], size: [4, 12, 4], uv, mirror, color: colorTop },
    ...(overlayUv ? [{ from: [x, -2, -2] as [number, number, number], size: [4, 12, 4] as [number, number, number], uv: overlayUv, inflate: 0.25, overlay: true, color: colorTop }] : []),
  ];
  const leg = (uv: [number, number], overlayUv: [number, number] | null, mirror: boolean): Cube[] => [
    { from: [-2, 0, -2], size: [4, 12, 4], uv, mirror, color: look.pants },
    ...(overlayUv ? [{ from: [-2, 0, -2] as [number, number, number], size: [4, 12, 4] as [number, number, number], uv: overlayUv, inflate: 0.25, overlay: true, color: look.pants }] : []),
  ];
  return {
    head: {
      pivot: headPivot(holder),
      rotation: [headPitch, 0, 0],
      cubes: [
        { from: [-4, -8, -4], size: [8, 8, 8], uv: [0, 0], color: look.skin },
        { from: [-4, -8, -4], size: [8, 8, 8], uv: [32, 0], inflate: 0.5, overlay: true, color: look.skin },
      ],
    },
    body: {
      pivot: [0, 0, 0],
      cubes: [
        { from: [-4, 0, -2], size: [8, 12, 4], uv: [16, 16], color: look.shirt },
        ...(p ? [{ from: [-4, 0, -2] as [number, number, number], size: [8, 12, 4] as [number, number, number], uv: [16, 32] as [number, number], inflate: 0.25, overlay: true, color: look.shirt }] : []),
      ],
    },
    right_arm: { pivot: right.pivot, rotation: right.rotation, cubes: limb([40, 16], p ? [40, 32] : null, false, -3, look.skin) },
    left_arm: { pivot: left.pivot, rotation: left.rotation, cubes: limb(p ? [32, 48] : [40, 16], p ? [48, 48] : null, !p, -1, look.skin) },
    right_leg: { pivot: [-1.9, 12, 0], cubes: leg([0, 16], p ? [0, 32] : null, false) },
    left_leg: { pivot: [1.9, 12, 0], cubes: leg(p ? [16, 48] : [0, 16], p ? [0, 48] : null, !p) },
  };
}

function armorStandParts(raise: { right: number; left: number }, headPitch: number, holder: Holder): Record<string, Part> {
  const right = armPose(holder, false, raise.right);
  const left = armPose(holder, true, raise.left);
  return {
    head: { pivot: headPivot(holder), rotation: [headPitch, 0, 0], cubes: [{ from: [-1, -7, -1], size: [2, 7, 2], uv: [0, 0], color: WOOD }] },
    body: {
      pivot: [0, 0, 0],
      cubes: [
        { from: [-6, 0, -1.5], size: [12, 3, 3], uv: [0, 26], color: WOOD },
        { from: [-3, 3, -1], size: [2, 7, 2], uv: [16, 0], color: WOOD },
        { from: [1, 3, -1], size: [2, 7, 2], uv: [48, 16], color: WOOD },
        { from: [-4, 10, -1], size: [8, 2, 2], uv: [0, 48], color: WOOD },
      ],
    },
    right_arm: { pivot: right.pivot, rotation: right.rotation, cubes: [{ from: [-2, -2, -1], size: [2, 12, 2], uv: [24, 0], color: WOOD }] },
    left_arm: { pivot: left.pivot, rotation: left.rotation, cubes: [{ from: [0, -2, -1], size: [2, 12, 2], uv: [32, 16], mirror: true, color: WOOD }] },
    right_leg: { pivot: [-1.9, 12, 0], rotation: [0, 0, 1], cubes: [{ from: [-1, 0, -1], size: [2, 11, 2], uv: [8, 0], color: WOOD }] },
    left_leg: { pivot: [1.9, 12, 0], rotation: [0, 0, -1], cubes: [{ from: [-1, 0, -1], size: [2, 11, 2], uv: [40, 16], mirror: true, color: WOOD }] },
    base_plate: { pivot: [0, 12, 0], cubes: [{ from: [-6, 11, -6], size: [12, 1, 12], uv: [0, 32], color: '#8a8a8a' }] },
  };
}

export interface HolderOptions {
  holder: Holder;
  /** Raise of the right and left arm in degrees. */
  raise: { right: number; left: number };
  headPitch: number;
  /** The player's skin (already loaded). */
  skin: DecodedImage | null;
}

/** A player, zombie, baby zombie or (small) armor stand standing at the origin, facing +Z. */
export async function buildHolder(opts: HolderOptions, assets: MinecraftAssets | null): Promise<Built> {
  const { holder } = opts;
  const root = entityRoot(holder);
  if (holder === 'armor_stand' || holder === 'armor_stand_small') {
    const image = await loadTexture(assets, 'entity/armorstand/wood');
    return buildBoxModel(armorStandParts(opts.raise, opts.headPitch, holder), image, root);
  }
  if (holder === 'player') {
    const skin = opts.skin;
    const legacy = skin !== null && skin.height === skin.width / 2;
    return buildBoxModel(humanoidParts({ playerLayout: !legacy, skin: SKIN, shirt: SHIRT, pants: PANTS }, opts.raise, opts.headPitch, holder), skin, root);
  }
  const image = await loadTexture(assets, 'entity/zombie/zombie');
  const parts = humanoidParts({ playerLayout: false, skin: ZOMBIE, shirt: ZOMBIE_SHIRT, pants: PANTS }, opts.raise, opts.headPitch, holder);
  // The zombie texture has a hat layer only.
  parts.body.cubes = parts.body.cubes.filter((c) => !c.overlay);
  for (const name of ['right_arm', 'left_arm', 'right_leg', 'left_leg']) parts[name].cubes = parts[name].cubes.filter((c) => !c.overlay);
  const baby = holder === 'baby_zombie';
  return buildBoxModel(parts, image, root, (name) => (!baby ? null : name === 'head' ? BABY_HEAD : BABY_BODY));
}


// ---- World-space props ------------------------------------------------------------------------------------

/** A box from `from` to `to` in px of a block at the origin (0..16), its faces textured by their position like the game's default UVs. */
function propBox(from: [number, number, number], to: [number, number, number], material: Material): Mesh {
  const size = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const geometry = new BoxGeometry(size[0], size[1], size[2]);
  geometry.translate((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2);
  const position = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');
  for (let i = 0; i < position.count; i++) {
    const face = Math.floor(i / 4);
    const [x, y, z] = [position.getX(i), position.getY(i), position.getZ(i)];
    // Horizontal faces use x/z, sides the horizontal axis along them and y.
    const u = face < 2 ? z : x;
    const v = face === 2 || face === 3 ? z : y;
    uv.setXY(i, u / 16, face === 2 || face === 3 ? 1 - v / 16 : v / 16);
  }
  uv.needsUpdate = true;
  geometry.translate(-8, 0, -8);
  geometry.scale(1 / 16, 1 / 16, 1 / 16);
  return new Mesh(geometry, material);
}

async function propMaterial(owned: Owned, assets: MinecraftAssets | null, id: string, flat: string): Promise<MeshStandardMaterial> {
  const image = await loadTexture(assets, id);
  const map = image ? owned.add(pixelTexture(image, true)) : null;
  return owned.add(new MeshStandardMaterial({ map, color: map ? 0xffffff : new Color(flat), roughness: 1, metalness: 0, alphaTest: 0.1 }));
}

/** Blocks at integer positions (block centres at x + 0.5 etc. are the caller's; given here as min corners). */
export async function buildBlocks(kit: BlockKit, blocks: { name: BlockName; at: [number, number, number] }[]): Promise<Built> {
  const owned = new Owned();
  const geometry = owned.add(new BoxGeometry(1, 1, 1));
  const group = new Group();
  for (const block of blocks) {
    const set = await kit.materials(block.name);
    lightBlocks([set], 1);
    const mesh = new Mesh(geometry, set.faces);
    mesh.position.set(block.at[0] + 0.5, block.at[1] + 0.5, block.at[2] + 0.5);
    group.add(mesh);
  }
  return { group, dispose: owned.dispose };
}

/** The item frame model (border of birch planks, leather back) as the frame entity draws it, under `entity`. */
export async function buildFrame(kind: FrameKind, entity: Matrix4, assets: MinecraftAssets | null): Promise<Built> {
  const owned = new Owned();
  const group = new Group();
  if (kind === 'frame' || kind === 'top') {
    const wood = await propMaterial(owned, assets, 'block/birch_planks', '#c9b77b');
    const back = await propMaterial(owned, assets, 'block/item_frame', '#8a5a3a');
    const frame = new Group();
    frame.matrixAutoUpdate = false;
    // The frame model is drawn centred on the entity, so its block box is moved by -8 px on every axis.
    frame.matrix.copy(entity).multiply(new Matrix4().makeTranslation(0, -0.5, 0));
    frame.add(propBox([3, 3, 15.5], [13, 13, 16], back));
    frame.add(propBox([2, 2, 15], [14, 3, 16], wood));
    frame.add(propBox([2, 13, 15], [14, 14, 16], wood));
    frame.add(propBox([2, 3, 15], [3, 13, 16], wood));
    frame.add(propBox([13, 3, 15], [14, 13, 16], wood));
    group.add(frame);
  }
  return { group, dispose: owned.dispose };
}

/** A wooden shelf block standing on the ground at the origin, open to +Z: back board, floor and ceiling. */
export async function buildShelf(assets: MinecraftAssets | null): Promise<Built> {
  const owned = new Owned();
  const wood = await propMaterial(owned, assets, 'block/oak_planks', '#a2834f');
  const group = new Group();
  group.add(propBox([0, 0, 0], [16, 16, 2], wood));
  group.add(propBox([0, 0, 2], [16, 4, 16], wood));
  group.add(propBox([0, 12, 2], [16, 16, 16], wood));
  group.add(propBox([0, 4, 2], [1, 12, 16], wood));
  group.add(propBox([15, 4, 2], [16, 12, 16], wood));
  return { group, dispose: owned.dispose };
}

/** A fox (flat colours) standing at `x` on the ground, facing +Z. */
export function buildFox(x: number): Built {
  const owned = new Owned();
  const orange = owned.add(new MeshStandardMaterial({ color: '#e07b2e', roughness: 1 }));
  const white = owned.add(new MeshStandardMaterial({ color: '#f1ece4', roughness: 1 }));
  const dark = owned.add(new MeshStandardMaterial({ color: '#3a2a22', roughness: 1 }));
  const group = new Group();
  const box = (from: [number, number, number], to: [number, number, number], m: Material) => group.add(propBox([from[0] + 8, from[1], from[2] + 8], [to[0] + 8, to[1], to[2] + 8], m));
  box([-3, 5, -5.5], [3, 11, 5.5], orange); // body
  for (const [lx, lz] of [[-3, -5], [1, -5], [-3, 3], [1, 3]]) box([lx, 0, lz], [lx + 2, 6, lz + 2], dark);
  box([-4, 8, 4], [4, 14, 10], orange); // head
  box([-2, 8, 10], [2, 10, 13], white); // snout
  box([-4, 14, 6], [-2, 16, 7], dark); // ears
  box([2, 14, 6], [4, 16, 7], dark);
  box([-2, 5, -14.5], [2, 9, -5.5], orange); // tail
  box([-2, 5, -16.5], [2, 9, -14.5], white);
  group.position.x = x;
  return { group, dispose: owned.dispose };
}

// ---- GUI ------------------------------------------------------------------------------------------------

export type GuiKind = 'slot' | 'crafting' | 'inventory' | 'hotbar';

export interface GuiLayout {
  /** Width and height of the screen in GUI px. */
  size: [number, number];
  /** Top-left corners of the slots the item is shown in (GUI px, y down); the first one is the main slot. */
  slots: [number, number][];
}

const grid = (x: number, y: number, cols: number, rows: number): [number, number][] =>
  Array.from({ length: cols * rows }, (_, i) => [x + (i % cols) * 18, y + Math.floor(i / cols) * 18]);

/** Where the item shows in each GUI reference (the game's slot positions, 1 px inside each slot's frame). */
export const guiLayouts: Record<GuiKind, GuiLayout> = {
  slot: { size: [18, 18], slots: [[1, 1]] },
  crafting: { size: [176, 166], slots: [[48, 35], [124, 35], [8, 142]] },
  inventory: { size: [176, 166], slots: [[77, 62], [8, 142], [26, 84], [134, 102]] },
  hotbar: { size: [182, 32], slots: [[3, 13], [43, 13]] },
};

/** The slot frames drawn when the GUI textures are not available. */
const guiFrames: Record<GuiKind, [number, number][]> = {
  slot: [[1, 1]],
  crafting: [...grid(30, 17, 3, 3), [124, 35], ...grid(8, 84, 9, 3), ...grid(8, 142, 9, 1)],
  inventory: [...grid(8, 8, 1, 4), [77, 62], ...grid(98, 18, 2, 2), [154, 28], ...grid(8, 84, 9, 3), ...grid(8, 142, 9, 1)],
  hotbar: [],
};

function slotCanvas(kind: GuiKind): HTMLCanvasElement {
  const [w, h] = guiLayouts[kind].size;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d')!;
  const slot = (x: number, y: number) => {
    g.fillStyle = '#373737';
    g.fillRect(x - 1, y - 1, 17, 1);
    g.fillRect(x - 1, y - 1, 1, 17);
    g.fillStyle = '#ffffff';
    g.fillRect(x, y + 16, 17, 1);
    g.fillRect(x + 16, y, 1, 17);
    g.fillStyle = '#8b8b8b';
    g.fillRect(x, y, 16, 16);
  };
  if (kind === 'hotbar') {
    g.fillStyle = 'rgba(0,0,0,0.55)';
    g.fillRect(0, 10, 182, 22);
    g.strokeStyle = '#9a9a9a';
    g.strokeRect(0.5, 10.5, 181, 21);
    for (let i = 0; i < 9; i++) {
      g.strokeStyle = i === 0 ? '#ffffff' : '#6a6a6a';
      g.strokeRect(1.5 + i * 20, 11.5, 19, 19);
    }
    // Hearts and food.
    for (let i = 0; i < 10; i++) {
      g.fillStyle = '#d4202a';
      g.fillRect(1 + i * 8, 1, 7, 7);
      g.fillStyle = '#a5672f';
      g.fillRect(174 - i * 8, 1, 7, 7);
    }
    return canvas;
  }
  if (kind !== 'slot') {
    g.fillStyle = '#c6c6c6';
    g.fillRect(0, 0, w, h);
  }
  for (const [x, y] of guiFrames[kind]) slot(x, y);
  return canvas;
}

/** A crop of a decoded image as a canvas. */
function crop(image: DecodedImage, x: number, y: number, w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const data = new ImageData(new Uint8ClampedArray(image.pixels), image.width, image.height);
  const full = document.createElement('canvas');
  full.width = image.width;
  full.height = image.height;
  full.getContext('2d')!.putImageData(data, 0, 0);
  canvas.getContext('2d')!.drawImage(full, x, y, w, h, 0, 0, w, h);
  return canvas;
}

async function guiCanvas(kind: GuiKind, assets: MinecraftAssets | null): Promise<HTMLCanvasElement> {
  if (kind === 'crafting' || kind === 'inventory') {
    const image = await loadTexture(assets, kind === 'crafting' ? 'gui/container/crafting_table' : 'gui/container/inventory');
    // Screens are 176 x 166 in the top left of a 256 x 256 sheet (larger sheets are scaled resource packs).
    if (image && image.width >= 176) {
      const k = image.width / 256;
      const scaled = crop(image, 0, 0, Math.round(176 * k), Math.round(166 * k));
      const canvas = document.createElement('canvas');
      canvas.width = 176;
      canvas.height = 166;
      const g = canvas.getContext('2d')!;
      g.imageSmoothingEnabled = false;
      g.drawImage(scaled, 0, 0, 176, 166);
      return canvas;
    }
  }
  if (kind === 'hotbar') {
    const [bar, heart, food] = await Promise.all([
      loadTexture(assets, 'gui/sprites/hud/hotbar'),
      loadTexture(assets, 'gui/sprites/hud/heart/full'),
      loadTexture(assets, 'gui/sprites/hud/food_full'),
    ]);
    if (bar) {
      const selection = await loadTexture(assets, 'gui/sprites/hud/hotbar_selection');
      const canvas = document.createElement('canvas');
      canvas.width = 182;
      canvas.height = 32;
      const g = canvas.getContext('2d')!;
      g.imageSmoothingEnabled = false;
      g.drawImage(crop(bar, 0, 0, bar.width, bar.height), 0, 10, 182, 22);
      if (selection) g.drawImage(crop(selection, 0, 0, selection.width, selection.height), -1, 9, 24, 23);
      for (let i = 0; i < 10; i++) {
        if (heart) g.drawImage(crop(heart, 0, 0, heart.width, heart.height), i * 8, 0, 9, 9);
        if (food) g.drawImage(crop(food, 0, 0, food.width, food.height), 173 - i * 8, 0, 9, 9);
      }
      return canvas;
    }
  }
  return slotCanvas(kind);
}

/** The GUI screen as a plane in GUI px (top-left corner at the origin, y up, so GUI y is -y), facing +Z. */
export async function buildGui(kind: GuiKind, assets: MinecraftAssets | null): Promise<Built> {
  const owned = new Owned();
  const canvas = await guiCanvas(kind, assets);
  const texture: Texture = owned.add(new CanvasTexture(canvas));
  texture.colorSpace = SRGBColorSpace;
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;
  const [w, h] = guiLayouts[kind].size;
  const plane = new Mesh(owned.add(new PlaneGeometry(w, h)), owned.add(new MeshBasicMaterial({ map: texture, transparent: true })));
  plane.position.set(w / 2, -h / 2, -64);
  plane.renderOrder = -1;
  const group = new Group();
  group.add(plane);
  return { group, dispose: owned.dispose };
}
