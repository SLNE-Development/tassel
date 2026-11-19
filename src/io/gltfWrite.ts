// glTF 2.0 writer. Hand-written rather than three's GLTFExporter so that textures keep their original
// encoded bytes (no canvas round trip) and the result does not depend on a DOM.
import type { DocState, Material, Texture } from '../core/types';
import { fromBase64, toBase64 } from './bytes';
import type { ImageOps, PackedImage } from './imageOps';
import { polygonExtra } from './polygons';
import { fallbackMaterial, hexToRgb, indexedTriangles, srgbToLinear, transformQuaternion, type ExportItem } from './scene';

type Json = Record<string, unknown>;

const FLOAT = 5126;
const USHORT = 5123;
const UINT = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

/** Collects the binary buffer and the bufferViews / accessors that point into it. */
class Buffer {
  private parts: Uint8Array[] = [];
  length = 0;
  views: Json[] = [];
  accessors: Json[] = [];

  view(bytes: Uint8Array, target?: number): number {
    this.parts.push(bytes);
    const view: Json = { buffer: 0, byteOffset: this.length, byteLength: bytes.byteLength };
    if (target) view.target = target;
    this.length += bytes.byteLength;
    // Every view starts on a 4-byte boundary.
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) {
      this.parts.push(new Uint8Array(pad));
      this.length += pad;
    }
    return this.views.push(view) - 1;
  }

  accessor(data: Float32Array | Uint16Array | Uint32Array, type: 'SCALAR' | 'VEC2' | 'VEC3', target: number, bounds = false): number {
    const size = type === 'SCALAR' ? 1 : type === 'VEC2' ? 2 : 3;
    const accessor: Json = {
      bufferView: this.view(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), target),
      componentType: data instanceof Float32Array ? FLOAT : data instanceof Uint16Array ? USHORT : UINT,
      count: data.length / size,
      type,
    };
    if (bounds) {
      const min = new Array<number>(size).fill(Infinity);
      const max = new Array<number>(size).fill(-Infinity);
      for (let i = 0; i < data.length; i++) {
        min[i % size] = Math.min(min[i % size], data[i]);
        max[i % size] = Math.max(max[i % size], data[i]);
      }
      accessor.min = min;
      accessor.max = max;
    }
    return this.accessors.push(accessor) - 1;
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const part of this.parts) {
      out.set(part, offset);
      offset += part.byteLength;
    }
    return out;
  }
}

/**
 * Builds the glTF document. Conventions: our UVs have v up, glTF has v down, so v is written as 1 - v and
 * images stay as they are. Metallic and roughness maps are packed into one image (G = roughness,
 * B = metallic) because glTF has a single slot for both; all other textures keep their original file bytes.
 */
async function build(state: DocState, items: readonly ExportItem[], ops: ImageOps, embedImages: boolean) {
  const buffer = new Buffer();
  const nodes: Json[] = [];
  const meshes: Json[] = [];
  const materials: Json[] = [];
  const textures: Json[] = [];
  const images: Json[] = [];
  const extensionsUsed = new Set<string>();
  const extensionsRequired = new Set<string>();

  // --- Images and textures ---------------------------------------------------------------------
  const textureIndex = new Map<string, number>();
  function addImage(key: string, name: string, mimeType: string, base64: string): number {
    const known = textureIndex.get(key);
    if (known !== undefined) return known;
    const image: Json = { name, mimeType };
    if (embedImages) image.uri = `data:${mimeType};base64,${base64}`;
    else image.bufferView = buffer.view(fromBase64(base64));
    const source = images.push(image) - 1;
    const texture: Json = { sampler: 0, name };
    if (mimeType === 'image/webp') {
      // Core glTF only knows PNG and JPEG.
      texture.extensions = { EXT_texture_webp: { source } };
      extensionsUsed.add('EXT_texture_webp');
      extensionsRequired.add('EXT_texture_webp');
    } else {
      texture.source = source;
    }
    const index = textures.push(texture) - 1;
    textureIndex.set(key, index);
    return index;
  }
  const plain = (texture: Texture) => addImage(texture.id, texture.name, texture.mimeType, texture.data);
  const packed = new Map<string, Promise<PackedImage>>();

  // --- Materials -------------------------------------------------------------------------------
  const materialIndex = new Map<Material, number>();
  async function addMaterial(material: Material): Promise<number> {
    const known = materialIndex.get(material);
    if (known !== undefined) return known;
    const map = (slot: keyof Material['maps']) => {
      const id = material.maps[slot];
      return (id !== undefined && state.textures[id]) || null;
    };
    const pbr: Json = {
      baseColorFactor: [...hexToRgb(material.baseColor).map(srgbToLinear), 1],
      metallicFactor: material.metallic,
      roughnessFactor: material.roughness,
    };
    const out: Json = { name: material.name, pbrMetallicRoughness: pbr };
    // The stand-in for "no material" (other applications show the clay look); the importer takes it as none.
    if (material === fallbackMaterial) out.extras = { tessel: { noMaterial: true } };
    const baseColor = map('baseColor');
    if (baseColor) pbr.baseColorTexture = { index: plain(baseColor) };
    const roughness = map('roughness');
    const metallic = map('metallic');
    if (roughness || metallic) {
      const key = `mr:${roughness?.id ?? ''}:${metallic?.id ?? ''}`;
      if (!packed.has(key)) packed.set(key, ops.packMetallicRoughness(roughness, metallic));
      const image = await packed.get(key)!;
      pbr.metallicRoughnessTexture = { index: addImage(key, `${material.name}_metallicRoughness`, image.mimeType, image.data) };
    }
    const normal = map('normal');
    if (normal) out.normalTexture = { index: plain(normal), scale: material.normalScale };
    const occlusion = map('occlusion');
    if (occlusion) out.occlusionTexture = { index: plain(occlusion) };
    const emissive = map('emissive');
    if (emissive) out.emissiveTexture = { index: plain(emissive) };
    if (material.emissive !== '#000000' || emissive) {
      out.emissiveFactor = hexToRgb(material.emissive).map(srgbToLinear);
      if (material.emissiveStrength !== 1) {
        out.extensions = { KHR_materials_emissive_strength: { emissiveStrength: material.emissiveStrength } };
        extensionsUsed.add('KHR_materials_emissive_strength');
      }
    }
    const index = materials.push(out) - 1;
    materialIndex.set(material, index);
    return index;
  }

  // --- Meshes ----------------------------------------------------------------------------------
  // Objects that share a mesh, shading and material (duplicates) share one glTF mesh.
  const meshIndex = new Map<string, number>();
  const meshIds = new Map<object, number>();
  const idOf = (key: object) => meshIds.get(key) ?? (meshIds.set(key, meshIds.size), meshIds.size - 1);
  async function addMesh(item: ExportItem): Promise<number> {
    const material = await addMaterial(item.material);
    const key = `${idOf(item.mesh)}:${item.smooth ? 1 : 0}:${material}`;
    const known = meshIndex.get(key);
    if (known !== undefined) return known;
    const tris = indexedTriangles(item.mesh, item.smooth);
    const attributes: Json = {
      POSITION: buffer.accessor(tris.positions, 'VEC3', ARRAY_BUFFER, true),
      NORMAL: buffer.accessor(tris.normals, 'VEC3', ARRAY_BUFFER),
    };
    if (tris.uvs) {
      const uvs = new Float32Array(tris.uvs);
      for (let i = 1; i < uvs.length; i += 2) uvs[i] = 1 - uvs[i];
      attributes.TEXCOORD_0 = buffer.accessor(uvs, 'VEC2', ARRAY_BUFFER);
    }
    const small = tris.positions.length / 3 <= 65535;
    const indices = buffer.accessor(small ? new Uint16Array(tris.indices) : tris.indices, 'SCALAR', ELEMENT_ARRAY_BUFFER);
    const primitive: Json = { attributes, indices, material, mode: 4 };
    // glTF has only triangles; this note lets the importer restore the polygons (see polygons.ts).
    const polygons = polygonExtra(item.mesh, tris.indices);
    if (polygons) primitive.extras = { tessel: { polygons } };
    const index = meshes.push({ name: item.name, primitives: [primitive] }) - 1;
    meshIndex.set(key, index);
    return index;
  }

  // --- Nodes: groups become parent nodes without a transform ------------------------------------
  const roots: number[] = [];
  const groupNode = new Map<string, number>();
  function childrenOfGroup(id: string | null): number[] {
    if (id === null || !state.groups[id]) return roots;
    let index = groupNode.get(id);
    if (index === undefined) {
      index = nodes.push({ name: state.groups[id].name, children: [] }) - 1;
      groupNode.set(id, index);
      childrenOfGroup(state.groups[id].parentId).push(index);
    }
    return nodes[index].children as number[];
  }
  // Groups in outliner order first, then the objects.
  const used = new Set<string>();
  for (const item of items) {
    for (let id = item.groupId; id !== null && state.groups[id] && !used.has(id); id = state.groups[id].parentId) used.add(id);
  }
  for (const id of state.groupOrder) if (used.has(id)) childrenOfGroup(id);

  for (const item of items) {
    const node: Json = { name: item.name, mesh: await addMesh(item) };
    const { position, scale } = item.transform;
    const q = transformQuaternion(item.transform);
    if (position.some((v) => v !== 0)) node.translation = [...position];
    if (q.x !== 0 || q.y !== 0 || q.z !== 0) node.rotation = [q.x, q.y, q.z, q.w];
    if (scale.some((v) => v !== 1)) node.scale = [...scale];
    childrenOfGroup(item.groupId).push(nodes.push(node) - 1);
  }

  const json: Json = {
    asset: { version: '2.0', generator: 'Tessel' },
    scene: 0,
    scenes: [{ name: 'Scene', nodes: roots }],
    nodes,
    meshes,
    materials,
    accessors: buffer.accessors,
    bufferViews: buffer.views,
  };
  if (textures.length > 0) {
    json.textures = textures;
    json.images = images;
    // Linear filtering with mipmaps, repeating.
    json.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
  }
  if (extensionsUsed.size > 0) json.extensionsUsed = [...extensionsUsed];
  if (extensionsRequired.size > 0) json.extensionsRequired = [...extensionsRequired];
  return { json, bin: buffer.bytes() };
}

function padded(bytes: Uint8Array, fill: number): Uint8Array {
  const pad = (4 - (bytes.byteLength % 4)) % 4;
  if (pad === 0) return bytes;
  const out = new Uint8Array(bytes.byteLength + pad).fill(fill);
  out.set(bytes);
  return out;
}

/** Wraps a glTF JSON document and its binary buffer into a GLB container. */
export function packGlb(json: unknown, bin: Uint8Array): Uint8Array<ArrayBuffer> {
  const jsonChunk = padded(new TextEncoder().encode(JSON.stringify(json)), 0x20);
  const binChunk = padded(bin, 0);
  const total = 12 + 8 + jsonChunk.byteLength + (binChunk.byteLength > 0 ? 8 + binChunk.byteLength : 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); // "glTF"
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonChunk.byteLength, true);
  view.setUint32(16, 0x4e4f534a, true); // "JSON"
  out.set(jsonChunk, 20);
  if (binChunk.byteLength > 0) {
    const at = 20 + jsonChunk.byteLength;
    view.setUint32(at, binChunk.byteLength, true);
    view.setUint32(at + 4, 0x004e4942, true); // "BIN\0"
    out.set(binChunk, at + 8);
  }
  return out;
}

/** GLB: one self-contained binary file, images stored as they are. */
export async function writeGlb(state: DocState, items: readonly ExportItem[], ops: ImageOps): Promise<Uint8Array<ArrayBuffer>> {
  const { json, bin } = await build(state, items, ops, false);
  json.buffers = [{ byteLength: bin.byteLength }];
  return packGlb(json, bin);
}

/** glTF JSON text, self-contained: the geometry buffer and the images are embedded as data URIs. */
export async function writeGltf(state: DocState, items: readonly ExportItem[], ops: ImageOps): Promise<string> {
  const { json, bin } = await build(state, items, ops, true);
  json.buffers = [{ byteLength: bin.byteLength, uri: `data:application/octet-stream;base64,${toBase64(bin)}` }];
  return JSON.stringify(json);
}
