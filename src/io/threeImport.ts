// A three.js object tree (as its loaders return it) → the plain data `import.file` adds to the document.
import { Euler, MathUtils, Matrix4, Quaternion, Vector3 } from 'three';
import type { BufferAttribute, BufferGeometry, InterleavedBufferAttribute, Material as ThreeMaterial, Mesh, Object3D } from 'three';
import type { ImportedScene, PolyMesh, Transform } from '../core/types';
import { looksSmooth, soupToPolyMesh } from './soup';

type Attribute = BufferAttribute | InterleavedBufferAttribute;

/** The attribute as a plain array of floats (interleaved and normalised integer data is unpacked). */
function plain(attribute: Attribute | undefined, size: number): ArrayLike<number> | null {
  if (!attribute) return null;
  const direct = attribute as BufferAttribute;
  if (!('isInterleavedBufferAttribute' in attribute) && !attribute.normalized && attribute.itemSize === size) return direct.array;
  const out = new Float32Array(attribute.count * size);
  for (let i = 0; i < attribute.count; i++) {
    out[i * size] = attribute.getX(i);
    out[i * size + 1] = attribute.getY(i);
    if (size > 2) out[i * size + 2] = attribute.getZ(i);
  }
  return out;
}

const IDENTITY: Transform = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };

/**
 * The matrix as position / rotation / scale, or null if it has no such form with a positive scale
 * (shear from non-uniformly scaled parents, mirroring, zero scale). Those are baked into the vertices instead.
 */
export function decomposeMatrix(matrix: Matrix4): Transform | null {
  if (!(matrix.determinant() > 0)) return null;
  const position = new Vector3();
  const quaternion = new Quaternion();
  const scale = new Vector3();
  matrix.decompose(position, quaternion, scale);
  const back = new Matrix4().compose(position, quaternion, scale);
  const size = Math.max(...matrix.elements.map(Math.abs));
  if (!Number.isFinite(size)) return null;
  for (let i = 0; i < 16; i++) if (Math.abs(back.elements[i] - matrix.elements[i]) > 1e-6 * size) return null;
  const euler = new Euler().setFromQuaternion(quaternion, 'XYZ');
  const round = (x: number, digits: number) => Number(x.toFixed(digits)) || 0;
  return {
    position: [round(position.x, 9), round(position.y, 9), round(position.z, 9)],
    rotation: [round(MathUtils.radToDeg(euler.x), 6), round(MathUtils.radToDeg(euler.y), 6), round(MathUtils.radToDeg(euler.z), 6)],
    scale: [round(scale.x, 9), round(scale.y, 9), round(scale.z, 9)],
  };
}

export interface TreeOptions {
  /** True for sources whose v axis points down (glTF). */
  flipV: boolean;
  /** Index of a three material in the imported materials, or null for none. */
  material(material: ThreeMaterial): number | null;
  /** Name for nodes without one. */
  fallbackName: string;
}

/**
 * Walks the tree. Every mesh becomes an object (one per material if it has several) carrying its world
 * transform; every node above meshes, except the root, becomes a group so the hierarchy survives.
 */
export function convertTree(root: Object3D, options: TreeOptions): Pick<ImportedScene, 'objects' | 'groups'> & { dropped: number } {
  root.updateMatrixWorld(true);
  const objects: ImportedScene['objects'] = [];
  const groups: ImportedScene['groups'] = [];
  let dropped = 0;

  const isMesh = (node: Object3D): node is Mesh => (node as Mesh).isMesh === true && !!(node as Mesh).geometry?.attributes?.position;
  const meshCount = new Map<Object3D, number>();
  const count = (node: Object3D): number => {
    let n = isMesh(node) ? 1 : 0;
    for (const child of node.children) n += count(child);
    meshCount.set(node, n);
    return n;
  };
  count(root);

  // Meshes that share a geometry and need no baking share the converted mesh.
  const shared = new Map<BufferGeometry, { mesh: PolyMesh; smooth: boolean }>();

  function addMesh(node: Mesh, group: number | null) {
    const geometry = node.geometry;
    const transform = decomposeMatrix(node.matrixWorld);
    const positions = plain(geometry.attributes.position, 3)!;
    const indices = geometry.index ? geometry.index.array : null;
    const uvs = plain(geometry.attributes.uv, 2);
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    // Several materials: one object per material, from the geometry's groups.
    const byMaterial = new Map<number, { start: number; count: number }[]>();
    if (Array.isArray(node.material) && geometry.groups.length > 0) {
      for (const g of geometry.groups) {
        const list = byMaterial.get(g.materialIndex ?? 0) ?? [];
        list.push({ start: g.start, count: g.count });
        byMaterial.set(g.materialIndex ?? 0, list);
      }
    }
    const name = node.name || options.fallbackName;
    const smooth = () => looksSmooth(plain(geometry.attributes.normal, 3), indices, positions.length / 3);
    const push = (mesh: PolyMesh, isSmooth: boolean, material: ThreeMaterial | undefined) => {
      if (mesh.faces.length === 0) return;
      objects.push({ name, mesh, transform: transform ?? IDENTITY, smooth: isSmooth, material: material ? options.material(material) : null, group });
    };

    if (byMaterial.size <= 1) {
      let converted = transform ? shared.get(geometry) : undefined;
      if (!converted) {
        const result = soupToPolyMesh({ positions, indices, uvs, flipV: options.flipV, matrix: transform ? null : node.matrixWorld.elements });
        dropped += result.dropped;
        converted = { mesh: result.mesh, smooth: smooth() };
        if (transform) shared.set(geometry, converted);
      }
      push(converted.mesh, converted.smooth, materials[byMaterial.size === 1 ? [...byMaterial.keys()][0] : 0]);
      return;
    }
    const isSmooth = smooth();
    for (const [materialIndex, ranges] of byMaterial) {
      // The ranges of one material, joined into one index list.
      const joined: number[] = [];
      for (const { start, count: length } of ranges) {
        for (let i = start; i < start + length; i++) joined.push(indices ? indices[i] : i);
      }
      const result = soupToPolyMesh({ positions, indices: joined, uvs, flipV: options.flipV, matrix: transform ? null : node.matrixWorld.elements });
      dropped += result.dropped;
      push(result.mesh, isSmooth, materials[materialIndex]);
    }
  }

  function visit(node: Object3D, parentGroup: number | null) {
    let group = parentGroup;
    const below = (meshCount.get(node) ?? 0) - (isMesh(node) ? 1 : 0);
    if (node !== root && below > 0) group = groups.push({ name: node.name || options.fallbackName, parent: parentGroup }) - 1;
    if (isMesh(node)) addMesh(node, group);
    for (const child of node.children) if ((meshCount.get(child) ?? 0) > 0) visit(child, group);
  }
  visit(root, null);
  return { objects, groups, dropped };
}
