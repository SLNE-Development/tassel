// USDZ through three's USDZExporter. Needs the browser: the exporter draws every texture to a 2D canvas
// and re-encodes it (PNG, or JPEG for JPEG sources), limited to 4096 px.
import { BufferAttribute, BufferGeometry, Color, Group, Mesh, MeshStandardMaterial, NoColorSpace, RepeatWrapping, SRGBColorSpace, Scene, Texture as ThreeTexture } from 'three';
import { USDZExporter } from 'three/addons/exporters/USDZExporter.js';
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

/**
 * Writes a .usdz. Groups become Xform prims, objects keep their transforms. The exporter writes
 * st = (u, 1 - v) for textures that are not flipped, so it is handed v-down UVs and unflipped images:
 * the file then has our v-up coordinates with the images as they are, which is USD's convention.
 */
export async function writeUsdz(state: DocState, items: readonly ExportItem[]): Promise<Uint8Array<ArrayBuffer>> {
  const disposables: { dispose(): void }[] = [];
  const bitmaps: ImageBitmap[] = [];
  try {
    const textures = new Map<string, Promise<ThreeTexture | null>>();
    const texture = (id: string | undefined, srgb: boolean) => {
      const source = id !== undefined ? state.textures[id] : undefined;
      if (!source) return Promise.resolve(null);
      const key = `${source.id}:${srgb}`;
      let result = textures.get(key);
      if (!result) {
        result = createImageBitmap(new Blob([fromBase64(source.data)], { type: source.mimeType })).then((bitmap) => {
          bitmaps.push(bitmap);
          const t = new ThreeTexture(bitmap);
          t.flipY = false;
          t.wrapS = t.wrapT = RepeatWrapping;
          t.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
          t.userData.mimeType = source.mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png';
          t.name = source.name;
          disposables.push(t);
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
          // Strength multiplied in: the exporter drops emissiveIntensity when there is no emissive map.
          emissive: new Color(material.emissive).multiplyScalar(material.emissiveStrength),
        });
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
          for (let i = 1; i < uvs.length; i += 2) uvs[i] = 1 - uvs[i];
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
      if (id === null || !state.groups[id]) return scene;
      let group = groups.get(id);
      if (!group) {
        group = new Group();
        group.name = state.groups[id].name;
        groups.set(id, group);
        parentOf(state.groups[id].parentId).add(group);
      }
      return group;
    };
    for (const item of items) {
      const mesh = new Mesh(geometryOf(item), await materialOf(item.material));
      mesh.name = item.name;
      const { position, rotation, scale } = item.transform;
      mesh.position.set(...position);
      mesh.rotation.set((rotation[0] * Math.PI) / 180, (rotation[1] * Math.PI) / 180, (rotation[2] * Math.PI) / 180, 'XYZ');
      mesh.scale.set(...scale);
      parentOf(item.groupId).add(mesh);
    }
    scene.updateMatrixWorld(true);
    const result = await new USDZExporter().parseAsync(scene, { maxTextureSize: 4096, includeAnchoringProperties: false });
    return new Uint8Array(result);
  } finally {
    for (const d of disposables) d.dispose();
    for (const bitmap of bitmaps) bitmap.close();
  }
}
