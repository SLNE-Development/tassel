// A plain three.js scene (standard materials, textures, one mesh per object) built from a document.
// What the USDZ exporter writes and what the renderer (src/render) path-traces. Needs the browser:
// texture images are decoded with createImageBitmap.
import { BufferAttribute, BufferGeometry, Color, DoubleSide, FrontSide, Group, Mesh, MeshStandardMaterial, NoColorSpace, RepeatWrapping, SRGBColorSpace, Scene, Texture as ThreeTexture } from 'three';
import type { DocState, Material, PolyMesh, TextureSlot } from '../core/types';
import { fromBase64 } from './bytes';
import { indexedTriangles, type ExportItem } from './scene';

const SLOTS: Record<TextureSlot, 'map' | 'normalMap' | 'roughnessMap' | 'metalnessMap' | 'emissiveMap' | 'aoMap'> = {
  baseColor: 'map',
  normal: 'normalMap',
  roughness: 'roughnessMap',
  metallic: 'metalnessMap',
  emissive: 'emissiveMap',
  occlusion: 'aoMap',
};

export interface ThreeSceneOptions {
  /**
   * Document UVs have v pointing up (v = 0 is the bottom row of the image).
   * - `up`: UVs stay as they are and the images are flipped vertically while decoding (textures have
   *   `flipY = false`), the convention of the viewport: right for rendering with three.js.
   * - `down`: UVs become (u, 1 - v) and the images stay as stored, which is what USDZExporter expects.
   */
  v: 'up' | 'down';
  /** `baked`: the emissive strength is multiplied into the emissive colour instead of set as `emissiveIntensity`. */
  emissive: 'intensity' | 'baked';
  /** Surfaces are visible from both sides, as in the viewport. */
  doubleSided: boolean;
  /** Objects are parented to three.js groups that mirror the document's groups; otherwise they are all children of the scene. */
  groups: boolean;
  /** Awaited between objects, so that building a large scene can give the event loop a turn. */
  pause?: () => Promise<void> | void;
}

export interface ThreeScene {
  scene: Scene;
  /** Mesh per object id. */
  meshes: Map<string, Mesh<BufferGeometry, MeshStandardMaterial>>;
  /** Every texture the materials use. */
  textures: ThreeTexture[];
  /** Frees geometries, materials, textures and the decoded images. */
  dispose(): void;
}

/** Builds the scene for `items` (see `collectItems`): objects keep their transforms, meshes are the evaluated ones. */
export async function buildThreeScene(state: DocState, items: readonly ExportItem[], options: ThreeSceneOptions): Promise<ThreeScene> {
  const disposables: { dispose(): void }[] = [];
  const bitmaps: ImageBitmap[] = [];
  const dispose = () => {
    for (const d of disposables) d.dispose();
    for (const bitmap of bitmaps) bitmap.close();
    disposables.length = 0;
    bitmaps.length = 0;
  };
  try {
    const textures = new Map<string, Promise<ThreeTexture | null>>();
    const loaded: ThreeTexture[] = [];
    const texture = (id: string | undefined, srgb: boolean) => {
      const source = id !== undefined ? state.textures[id] : undefined;
      if (!source) return Promise.resolve(null);
      const key = `${source.id}:${srgb}`;
      let result = textures.get(key);
      if (!result) {
        const blob = new Blob([fromBase64(source.data)], { type: source.mimeType });
        const decoding = options.v === 'up' ? createImageBitmap(blob, { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' }) : createImageBitmap(blob);
        result = decoding.then((bitmap) => {
          bitmaps.push(bitmap);
          const t = new ThreeTexture(bitmap);
          t.flipY = false;
          t.wrapS = t.wrapT = RepeatWrapping;
          t.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
          t.userData.mimeType = source.mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png';
          t.name = source.name;
          t.needsUpdate = true;
          disposables.push(t);
          loaded.push(t);
          return t;
        });
        textures.set(key, result);
      }
      return result;
    };

    const materials = new Map<Material, MeshStandardMaterial>();
    const materialOf = async (material: Material) => {
      let m = materials.get(material);
      if (!m) {
        m = new MeshStandardMaterial({
          name: material.name,
          color: new Color(material.baseColor),
          metalness: material.metallic,
          roughness: material.roughness,
          emissive: new Color(material.emissive),
          side: options.doubleSided ? DoubleSide : FrontSide,
        });
        // USDZExporter drops emissiveIntensity when there is no emissive map, hence `baked`.
        if (options.emissive === 'baked') m.emissive.multiplyScalar(material.emissiveStrength);
        else m.emissiveIntensity = material.emissiveStrength;
        m.normalScale.set(material.normalScale, material.normalScale);
        for (const slot of Object.keys(SLOTS) as TextureSlot[]) {
          m[SLOTS[slot]] = await texture(material.maps[slot], slot === 'baseColor' || slot === 'emissive');
        }
        materials.set(material, m);
        disposables.push(m);
      }
      return m;
    };

    const geometries = [new Map<PolyMesh, BufferGeometry>(), new Map<PolyMesh, BufferGeometry>()];
    const geometryOf = (item: ExportItem) => {
      const cache = geometries[item.smooth ? 1 : 0];
      let geometry = cache.get(item.mesh);
      if (!geometry) {
        const tris = indexedTriangles(item.mesh, item.smooth);
        geometry = new BufferGeometry();
        geometry.setAttribute('position', new BufferAttribute(tris.positions, 3));
        geometry.setAttribute('normal', new BufferAttribute(tris.normals, 3));
        if (tris.uvs) {
          const uvs = new Float32Array(tris.uvs);
          if (options.v === 'down') for (let i = 1; i < uvs.length; i += 2) uvs[i] = 1 - uvs[i];
          geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
        }
        geometry.setIndex(new BufferAttribute(tris.indices, 1));
        cache.set(item.mesh, geometry);
        disposables.push(geometry);
      }
      return geometry;
    };

    const scene = new Scene();
    const groups = new Map<string, Group>();
    const parentOf = (id: string | null): Scene | Group => {
      if (!options.groups || id === null || !state.groups[id]) return scene;
      let group = groups.get(id);
      if (!group) {
        group = new Group();
        group.name = state.groups[id].name;
        groups.set(id, group);
        parentOf(state.groups[id].parentId).add(group);
      }
      return group;
    };
    const meshes = new Map<string, Mesh<BufferGeometry, MeshStandardMaterial>>();
    for (const item of items) {
      const mesh = new Mesh(geometryOf(item), await materialOf(item.material));
      mesh.name = item.name;
      const { position, rotation, scale } = item.transform;
      mesh.position.set(...position);
      mesh.rotation.set((rotation[0] * Math.PI) / 180, (rotation[1] * Math.PI) / 180, (rotation[2] * Math.PI) / 180, 'XYZ');
      mesh.scale.set(...scale);
      parentOf(item.groupId).add(mesh);
      meshes.set(item.id, mesh);
      await options.pause?.();
    }
    scene.updateMatrixWorld(true);
    return { scene, meshes, textures: loaded, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
