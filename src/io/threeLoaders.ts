// STL, PLY and FBX import through three's loaders.
import { Group, LoadingManager, Mesh } from 'three';
import type { BufferGeometry, Color, Material as ThreeMaterial, Texture as ThreeTexture } from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { defaultMaterial } from '../core/materials';
import type { ImportedScene, Texture, TextureSlot } from '../core/types';
import { FileError, toBase64 } from './bytes';
import { imageSize, sniffImage } from './imageInfo';
import { convertTree } from './threeImport';

function single(geometry: BufferGeometry, name: string, format: string): ImportedScene {
  if (!geometry.attributes.position || geometry.attributes.position.count === 0) throw new FileError(`The ${format} file contains no geometry`);
  const tree = convertTree(new Mesh(geometry), { flipV: false, fallbackName: name, material: () => null });
  if (tree.objects.length === 0) {
    throw new FileError(`The ${format} file contains no usable triangles (it may be a point cloud, or all its triangles are degenerate)`);
  }
  return { ...tree, materials: [], textures: [], warnings: tree.dropped > 0 ? [`Dropped ${tree.dropped} degenerate triangle(s)`] : [] };
}

/** STL (binary or ASCII): one object in the file's coordinates, flat shaded. STL has no units or up axis; none are assumed. */
export function readStl(bytes: Uint8Array<ArrayBuffer>, name: string): ImportedScene {
  const scene = single(new STLLoader().parse(bytes.buffer), name, 'STL');
  for (const object of scene.objects) object.smooth = false;
  return scene;
}

/** PLY (binary or ASCII): one object, with UVs (s/t or u/v, v up) if the file has them. */
export function readPly(bytes: Uint8Array<ArrayBuffer>, name: string): ImportedScene {
  const head = new TextDecoder().decode(bytes.subarray(0, 4));
  if (!head.startsWith('ply')) throw new FileError('Invalid PLY file: it does not start with "ply"');
  const geometry = new PLYLoader().parse(bytes.buffer);
  if (!geometry.index) throw new FileError('The PLY file contains no faces (it is a point cloud), so there is nothing to import');
  return single(geometry, name, 'PLY');
}

type FbxMaterial = ThreeMaterial & {
  color?: Color;
  emissive?: Color;
  emissiveIntensity?: number;
  shininess?: number;
  roughness?: number;
  metalness?: number;
  map?: ThreeTexture | null;
  normalMap?: ThreeTexture | null;
  emissiveMap?: ThreeTexture | null;
  aoMap?: ThreeTexture | null;
};

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/**
 * FBX (binary or ASCII) through FBXLoader: meshes, hierarchy, materials converted from Phong/Lambert
 * (colour, emissive, roughness estimated from shininess) and textures embedded in the file. Textures that
 * are separate files are skipped. The loader rotates Z-up files to Y up; the file's unit (UnitScaleFactor,
 * centimetres per unit) is converted to meters here.
 */
export async function readFbx(bytes: Uint8Array<ArrayBuffer>, name: string): Promise<ImportedScene> {
  const warnings: string[] = [];
  const external = new Set<string>();
  const manager = new LoadingManager();
  // Embedded images arrive as blob: URLs. Anything else would be a file next to the FBX, which is out of reach.
  manager.setURLModifier((url) => {
    if (url.startsWith('blob:') || url.startsWith('data:')) return url;
    external.add(url.split(/[\\/]/).pop() ?? url);
    return 'data:,';
  });
  let pending = 0;
  let idle: (() => void) | null = null;
  manager.itemStart = ((start) => (url: string) => {
    pending++;
    start(url);
  })(manager.itemStart);
  manager.itemEnd = ((end) => (url: string) => {
    end(url);
    if (--pending === 0) idle?.();
  })(manager.itemEnd);

  const root = new FBXLoader(manager).parse(bytes.buffer, '');
  // Wait for the embedded images, but not forever.
  if (pending > 0) {
    await new Promise<void>((resolve) => {
      idle = resolve;
      setTimeout(resolve, 15000);
    });
  }

  // The unit goes on a parent of its own: the loader may hand back the file's single top node as the
  // root, and that node has to stay a node (and group) like any other.
  const scene = new Group();
  scene.add(root);
  const unit = Number(root.userData.unitScaleFactor);
  if (Number.isFinite(unit) && unit > 0 && unit !== 100) {
    scene.scale.setScalar(unit / 100);
    warnings.push(`FBX unit: ${unit} cm per unit, scaled by ${unit / 100} to meters`);
  }

  const textures: Omit<Texture, 'id'>[] = [];
  const textureIndex = new Map<ThreeTexture, Promise<number | undefined>>();
  const loadTexture = (texture: ThreeTexture | null | undefined): Promise<number | undefined> => {
    if (!texture) return Promise.resolve(undefined);
    let index = textureIndex.get(texture);
    if (!index) {
      index = (async () => {
        const src = (texture.image as { src?: string } | null)?.src;
        if (!src || !(src.startsWith('blob:') || src.startsWith('data:image'))) return undefined;
        try {
          const data = new Uint8Array(await (await fetch(src)).arrayBuffer());
          const mimeType = sniffImage(data);
          const size = imageSize(data);
          if (!mimeType || !size) {
            warnings.push(`Skipped the embedded texture "${texture.name}": only PNG, JPEG and WebP images can be imported`);
            return undefined;
          }
          return textures.push({ name: texture.name || `${name}_texture${textures.length}`, mimeType, data: toBase64(data), ...size }) - 1;
        } catch {
          return undefined;
        } finally {
          // FBXLoader creates the blob URLs and never frees them.
          if (src.startsWith('blob:')) URL.revokeObjectURL(src);
        }
      })();
      textureIndex.set(texture, index);
    }
    return index;
  };

  const materials: ImportedScene['materials'] = [];
  const materialIndex = new Map<ThreeMaterial, number>();
  const used: FbxMaterial[] = [];
  root.traverse((node) => {
    const material = (node as Mesh).material;
    for (const m of Array.isArray(material) ? material : material ? [material] : []) if (!used.includes(m)) used.push(m);
  });
  for (const m of used) {
    const maps: Partial<Record<TextureSlot, number>> = {};
    const slots: [TextureSlot, ThreeTexture | null | undefined][] = [
      ['baseColor', m.map],
      ['normal', m.normalMap],
      ['emissive', m.emissiveMap],
      ['occlusion', m.aoMap],
    ];
    for (const [slot, texture] of slots) {
      const index = await loadTexture(texture);
      if (index !== undefined) maps[slot] = index;
    }
    materialIndex.set(m, materials.length);
    materials.push({
      name: m.name || `${name}_material${materials.length}`,
      baseColor: m.color ? `#${m.color.getHexString()}` : defaultMaterial.baseColor,
      metallic: typeof m.metalness === 'number' ? clamp01(m.metalness) : 0,
      // Phong shininess → roughness, the usual approximation.
      roughness: typeof m.roughness === 'number' ? clamp01(m.roughness) : typeof m.shininess === 'number' ? clamp01(Math.sqrt(2 / (m.shininess + 2))) : defaultMaterial.roughness,
      emissive: m.emissive ? `#${m.emissive.getHexString()}` : '#000000',
      emissiveStrength: Math.min(100, Math.max(0, m.emissiveIntensity ?? 1)),
      normalScale: 1,
      maps,
    });
  }
  if (external.size > 0) {
    warnings.push(`Skipped ${external.size} texture(s) that are separate files, which a single-file import cannot read: ${[...external].slice(0, 5).join(', ')}`);
  }

  const tree = convertTree(scene, { flipV: false, fallbackName: name, material: (m) => materialIndex.get(m) ?? null });
  if (tree.dropped > 0) warnings.push(`Dropped ${tree.dropped} degenerate triangle(s)`);
  return { objects: tree.objects, groups: tree.groups, materials, textures, warnings };
}
