import {
  BoxGeometry,
  CircleGeometry,
  Color,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  RepeatWrapping,
  type Texture,
} from 'three/webgpu';
import type { MinecraftAssets } from '../../mcassets/loader';
import { blocks, type BlockLook, type BlockName } from './blocks';
import type { Terrain } from './scenes';
import { composite, firstFrame, pixelTexture, tinted } from './textures';

// Turns a generated landscape into three.js meshes: one instanced box mesh per block type, faces
// shaded the way Minecraft shades them (top brightest, east/west darkest), unlit by the scene's lights
// so the landscape reads as a backdrop. Textures come from the user's Minecraft assets; without them
// every face gets the block's flat colour.

/** Minecraft's directional face shading, in BoxGeometry's group order: +X, -X, +Y, -Y, +Z, -Z. */
const FACE_SHADE = [0.6, 0.6, 1, 0.5, 0.8, 0.8];
/** Which texture of a block each box face shows, in the same order. */
const FACE_SLOT = ['side', 'side', 'top', 'bottom', 'side', 'side'] as const;

/** The six face materials of one block type and the base colour of each (before the light level). */
export interface BlockMaterials {
  faces: MeshBasicMaterial[];
  base: Color[];
  glow: boolean;
}

/**
 * Loads and caches block materials for one asset source (or none). `light` darkens everything but
 * glowing blocks; it can change without reloading anything.
 */
export class BlockKit {
  private readonly cache = new Map<BlockName, Promise<BlockMaterials>>();
  private readonly textures = new Set<Texture>();
  private disposed = false;

  constructor(private readonly assets: MinecraftAssets | null) {}

  /** Whether the materials come from vanilla textures. */
  get textured(): boolean {
    return this.assets !== null;
  }

  materials(name: BlockName): Promise<BlockMaterials> {
    let pending = this.cache.get(name);
    if (!pending) {
      pending = this.load(blocks[name]);
      this.cache.set(name, pending);
    }
    return pending;
  }

  private async image(id: string, tint?: string) {
    if (!this.assets) return null;
    try {
      const texture = await this.assets.texture(id);
      if (!texture) return null;
      const frame = firstFrame(texture);
      return tint ? tinted(frame, tint) : frame;
    } catch (error) {
      console.warn(`Preview scene: could not load ${id}`, error);
      return null;
    }
  }

  private async load(look: BlockLook): Promise<BlockMaterials> {
    // Grass blocks tint only the top and the overlay; everything else tints the whole texture.
    const grassLike = look.sideOverlay !== undefined;
    const [top, side, bottom, overlay] = await Promise.all([
      this.image(look.top, look.tint),
      this.image(look.side, grassLike ? undefined : look.tint),
      this.image(look.bottom, grassLike ? undefined : look.tint),
      look.sideOverlay ? this.image(look.sideOverlay, look.tint) : Promise.resolve(null),
    ]);
    const images = { top, side: side && overlay ? composite(side, overlay) : side, bottom };
    const maps = new Map<string, Texture>();
    const map = (slot: 'top' | 'side' | 'bottom') => {
      const image = images[slot];
      if (!image || this.disposed) return null;
      let texture = maps.get(slot);
      if (!texture) {
        texture = pixelTexture(image);
        maps.set(slot, texture);
        this.textures.add(texture);
      }
      return texture;
    };
    const base: Color[] = [];
    const faces = FACE_SLOT.map((slot, i) => {
      const texture = map(slot);
      const flat = new Color(look.fallback[slot === 'top' ? 0 : 1]);
      const material = new MeshBasicMaterial({
        map: texture,
        // A white base lets the texture show; without one the face is the flat colour.
        color: texture ? 0xffffff : flat,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
      if (look.alpha === 'blend') {
        material.transparent = true;
        material.depthWrite = false;
        if (!texture) material.opacity = 0.65;
        material.side = DoubleSide;
      } else if (look.alpha === 'cutout') {
        material.alphaTest = 0.5;
      }
      base.push(material.color.clone().multiplyScalar(FACE_SHADE[i]));
      return material;
    });
    return { faces, base, glow: look.glow ?? false };
  }

  dispose(): void {
    this.disposed = true;
    for (const texture of this.textures) texture.dispose();
    this.textures.clear();
    for (const pending of this.cache.values()) void pending.then((set) => set.faces.forEach((m) => m.dispose()));
    this.cache.clear();
  }
}

/** Sets the light level (0..1) of block materials. */
export function lightBlocks(sets: Iterable<BlockMaterials>, level: number): void {
  for (const set of sets) set.faces.forEach((material, i) => material.color.copy(set.base[i]).multiplyScalar(set.glow ? 1 : level));
}

const box = new BoxGeometry(1, 1, 1);

/** The meshes of a landscape. Shared geometry; the materials belong to the kit. */
export async function buildTerrain(terrain: Terrain, kit: BlockKit): Promise<{ group: Group; materials: BlockMaterials[]; dispose(): void }> {
  const byBlock = new Map<BlockName, Terrain['blocks']>();
  for (const placement of terrain.blocks) {
    const list = byBlock.get(placement.block);
    if (list) list.push(placement);
    else byBlock.set(placement.block, [placement]);
  }
  const group = new Group();
  group.name = 'preview-terrain';
  const materials: BlockMaterials[] = [];
  const owned: { dispose(): void }[] = [];
  const matrix = new Matrix4();
  for (const [name, list] of byBlock) {
    const set = await kit.materials(name);
    materials.push(set);
    const mesh = new InstancedMesh(box, set.faces, list.length);
    list.forEach((p, i) => mesh.setMatrixAt(i, matrix.makeTranslation(p.x, p.y - 0.5, p.z)));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    // Drawn before the editor's grid, so the grid lines stay visible on the ground.
    mesh.renderOrder = -3;
    group.add(mesh);
    owned.push({ dispose: () => mesh.dispose() });
  }
  if (terrain.water) {
    const set = await kit.materials('water');
    materials.push(set);
    // One sheet of water instead of thousands of see-through blocks; it shows the top face's look.
    const water = new Mesh(new CircleGeometry(terrain.water.radius + 0.5, 48), set.faces[2]);
    water.rotation.x = -Math.PI / 2;
    water.position.y = terrain.water.y;
    const map = set.faces[2].map;
    if (map) {
      // A repeating copy of the texture, one tile per block.
      const tiled = map.clone();
      tiled.wrapS = tiled.wrapT = RepeatWrapping;
      tiled.repeat.set((terrain.water.radius + 0.5) * 2, (terrain.water.radius + 0.5) * 2);
      tiled.needsUpdate = true;
      const material = set.faces[2].clone();
      material.map = tiled;
      water.material = material;
      materials.push({ faces: [material], base: [set.base[2]], glow: false });
      owned.push(tiled, material);
    }
    group.add(water);
    owned.push(water.geometry);
  }
  return { group, materials, dispose: () => owned.forEach((o) => o.dispose()) };
}
