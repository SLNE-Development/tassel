import { BufferAttribute, BufferGeometry, MathUtils, Mesh, MeshStandardMaterial, Scene } from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { triangulate } from '../core/mesh/polymesh';
import { evaluateObject } from '../core/modifiers/evaluate';
import type { DocState, ExportService, PolyMesh } from '../core/types';

/**
 * Builds a throw-away three scene: one mesh node per visible object (its mesh after
 * modifiers, with flat or smooth normals), one default material.
 */
function buildScene(state: DocState, ids?: readonly string[]): { scene: Scene; dispose(): void } {
  const only = ids ? new Set(ids) : null;
  const scene = new Scene();
  scene.name = 'Scene';
  const material = new MeshStandardMaterial({ name: 'Default', color: 0xcccccc, roughness: 0.8, metalness: 0 });
  // Objects sharing a mesh and shading (duplicates) share one geometry, so the file stores the data once.
  const geometries = [new Map<PolyMesh, BufferGeometry>(), new Map<PolyMesh, BufferGeometry>()];

  for (const id of state.order) {
    const obj = state.objects[id];
    if (!obj || !obj.visible || (only && !only.has(id))) continue;
    const mesh = evaluateObject(state, id).mesh;
    const cache = geometries[obj.smooth ? 1 : 0];
    let geometry = cache.get(mesh);
    if (!geometry) {
      const soup = triangulate(mesh, obj.smooth);
      geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(soup.positions, 3));
      geometry.setAttribute('normal', new BufferAttribute(soup.normals, 3));
      cache.set(mesh, geometry);
    }
    const node = new Mesh(geometry, material);
    node.name = obj.name;
    const { position, rotation, scale } = obj.transform;
    node.position.set(...position);
    node.rotation.set(
      MathUtils.degToRad(rotation[0]),
      MathUtils.degToRad(rotation[1]),
      MathUtils.degToRad(rotation[2]),
      'XYZ',
    );
    node.scale.set(...scale);
    scene.add(node);
  }

  return {
    scene,
    dispose() {
      for (const cache of geometries) cache.forEach((g) => g.dispose());
      material.dispose();
    },
  };
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export const gltfExporter: ExportService = {
  async gltf(state, opts) {
    const { scene, dispose } = buildScene(state, opts.ids);
    try {
      const result = await new GLTFExporter().parseAsync(scene, { binary: opts.binary, trs: true });
      return result instanceof ArrayBuffer ? toBase64(result) : JSON.stringify(result);
    } finally {
      dispose();
    }
  },
};
