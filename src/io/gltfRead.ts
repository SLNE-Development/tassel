// glTF 2.0 / GLB reader. Geometry and hierarchy go through three's GLTFLoader; materials and images are
// read straight from the JSON, so images keep their original bytes and no DOM is needed to load them.
import type { Object3D, Material as ThreeMaterial } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { defaultMaterial } from '../core/materials';
import type { ImportedScene, Texture, TextureSlot } from '../core/types';
import { FileError, dataUriBytes, toBase64 } from './bytes';
import { packGlb } from './gltfWrite';
import { imageSize, sniffImage } from './imageInfo';
import type { ImageOps } from './imageOps';
import { linearToSrgb, rgbToHex } from './scene';
import { convertTree } from './threeImport';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = Record<string, any>;

const clamp = (x: unknown, min: number, max: number, fallback: number) =>
  typeof x === 'number' && Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : fallback;

const UNSUPPORTED: Record<string, string> = {
  KHR_draco_mesh_compression: 'Draco mesh compression',
  EXT_meshopt_compression: 'Meshopt compression',
  KHR_meshopt_compression: 'Meshopt compression',
};

/** Splits a GLB container into its JSON and binary chunk, or reads plain glTF JSON. */
function readContainer(bytes: Uint8Array<ArrayBuffer>): { json: Json; bin: Uint8Array<ArrayBuffer> | null } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let jsonText: string;
  let bin: Uint8Array<ArrayBuffer> | null = null;
  if (bytes.length >= 12 && view.getUint32(0, true) === 0x46546c67) {
    if (view.getUint32(4, true) !== 2) throw new FileError('Unsupported GLB version: only glTF 2.0 can be imported');
    let at = 12;
    let jsonChunk: Uint8Array | null = null;
    while (at + 8 <= bytes.length) {
      const length = view.getUint32(at, true);
      const type = view.getUint32(at + 4, true);
      if (at + 8 + length > bytes.length) throw new FileError('Invalid GLB file: it is cut off (a chunk is longer than the file)');
      const chunk = bytes.subarray(at + 8, at + 8 + length);
      if (type === 0x4e4f534a && !jsonChunk) jsonChunk = chunk;
      else if (type === 0x004e4942 && !bin) bin = chunk;
      at += 8 + length + ((4 - (length % 4)) % 4);
    }
    if (!jsonChunk) throw new FileError('Invalid GLB file: it has no JSON chunk');
    jsonText = new TextDecoder().decode(jsonChunk);
  } else {
    jsonText = new TextDecoder().decode(bytes);
  }
  let json: unknown;
  try {
    json = JSON.parse(jsonText);
  } catch {
    throw new FileError('Invalid glTF file: it is neither a GLB container nor valid JSON');
  }
  if (typeof json !== 'object' || json === null || typeof (json as Json).asset !== 'object') {
    throw new FileError('Invalid glTF file: the "asset" entry is missing');
  }
  const version = String((json as Json).asset?.version ?? '');
  if (!version.startsWith('2')) throw new FileError(`Unsupported glTF version "${version}": only glTF 2.0 can be imported`);
  return { json: json as Json, bin };
}

const list = (value: unknown): Json[] => (Array.isArray(value) ? value : []);

/**
 * Reads a .glb or a self-contained .gltf. Conventions: glTF's v axis points down, ours up, so v becomes
 * 1 - v and images stay as they are. The metallicRoughness image (G = roughness, B = metallic) is split
 * into two greyscale images, because the document keeps scalar maps as separate images read by luminance;
 * an occlusion map that shares that image is split from R the same way.
 */
export async function readGltf(bytes: Uint8Array<ArrayBuffer>, fallbackName: string, ops: ImageOps): Promise<ImportedScene> {
  const { json, bin } = readContainer(bytes);
  const warnings: string[] = [];
  for (const extension of list(json.extensionsRequired) as unknown as string[]) {
    if (UNSUPPORTED[extension]) throw new FileError(`This glTF file uses ${UNSUPPORTED[extension]} (${extension}), which is not supported. Re-export it without compression.`);
  }

  // --- Buffers: the GLB chunk and data URIs. External files cannot be reached from a single-file import. ---
  const missingBuffers: string[] = [];
  const buffers = list(json.buffers).map((buffer, i): Uint8Array<ArrayBuffer> | null => {
    if (typeof buffer.uri !== 'string') return i === 0 ? bin : null;
    const data = dataUriBytes(buffer.uri);
    if (!data) missingBuffers.push(buffer.uri);
    return data?.bytes ?? null;
  });
  if (missingBuffers.length > 0) {
    throw new FileError(
      `This .gltf keeps its geometry in separate files (${missingBuffers.slice(0, 3).join(', ')}), which a single-file import cannot read. Use a .glb or a .gltf with embedded buffers.`,
    );
  }
  const viewBytes = (index: unknown): Uint8Array<ArrayBuffer> | null => {
    const view = list(json.bufferViews)[index as number];
    const buffer = view && buffers[view.buffer];
    if (!buffer) return null;
    const offset = view.byteOffset ?? 0;
    if (offset + view.byteLength > buffer.length) return null;
    return buffer.subarray(offset, offset + view.byteLength);
  };

  // --- Images ------------------------------------------------------------------------------------
  const skippedImages: string[] = [];
  const images = list(json.images).map((image, i) => {
    const name = typeof image.name === 'string' && image.name ? image.name : `${fallbackName}_image${i}`;
    let data: Uint8Array<ArrayBuffer> | null = null;
    if (typeof image.uri === 'string') {
      data = dataUriBytes(image.uri)?.bytes ?? null;
      if (!data) skippedImages.push(image.uri);
    } else {
      data = viewBytes(image.bufferView);
    }
    const mimeType = data && sniffImage(data);
    const size = data && imageSize(data);
    if (data && (!mimeType || !size)) skippedImages.push(`${name} (not a PNG, JPEG or WebP image)`);
    return data && mimeType && size ? { name, bytes: data, mimeType, ...size } : null;
  });
  if (skippedImages.length > 0) {
    warnings.push(`Skipped ${skippedImages.length} image(s) that are external files or in an unsupported format: ${skippedImages.slice(0, 5).join(', ')}`);
  }
  const imageOfTexture = (info: unknown): number | null => {
    const texture = list(json.textures)[(info as Json | undefined)?.index];
    if (!texture) return null;
    const source = texture.source ?? texture.extensions?.EXT_texture_webp?.source;
    return typeof source === 'number' && images[source] ? source : null;
  };

  const textures: Omit<Texture, 'id'>[] = [];
  const plainTexture = new Map<number, number>();
  const whole = (image: number | null): number | undefined => {
    if (image === null) return undefined;
    let index = plainTexture.get(image);
    if (index === undefined) {
      const { name, bytes: data, mimeType, width, height } = images[image]!;
      index = textures.push({ name, mimeType, data: toBase64(data), width, height }) - 1;
      plainTexture.set(image, index);
    }
    return index;
  };
  /** Greyscale textures split from the channels of a packed image: [occlusion (R), roughness (G), metallic (B)]. */
  const splitCache = new Map<number, Promise<(number | undefined)[]>>();
  const split = (image: number): Promise<(number | undefined)[]> => {
    let result = splitCache.get(image);
    if (!result) {
      const source = images[image]!;
      result = ops.splitChannels({ mimeType: source.mimeType, bytes: source.bytes }, ['r', 'g', 'b']).then((parts) =>
        parts.map((part, i) => (part ? textures.push({ name: `${source.name}_${['occlusion', 'roughness', 'metallic'][i]}`, ...part }) - 1 : undefined)),
      );
      splitCache.set(image, result);
    }
    return result;
  };

  // --- Materials ---------------------------------------------------------------------------------
  const materials: ImportedScene['materials'] = [];
  /** glTF material index -> index in `materials`; null for the stand-in the exporter writes for "no material". */
  const materialOf: (number | null)[] = [];
  for (const [i, material] of list(json.materials).entries()) {
    if (material.extras?.tessel?.noMaterial === true) {
      materialOf.push(null);
      continue;
    }
    const pbr: Json = typeof material.pbrMetallicRoughness === 'object' && material.pbrMetallicRoughness ? material.pbrMetallicRoughness : {};
    const color = (value: unknown, fallback: number[]) => rgbToHex((Array.isArray(value) && value.length >= 3 ? value : fallback).map(linearToSrgb));
    const maps: Partial<Record<TextureSlot, number>> = {};
    const set = (slot: TextureSlot, texture: number | undefined) => {
      if (texture !== undefined) maps[slot] = texture;
    };
    set('baseColor', whole(imageOfTexture(pbr.baseColorTexture)));
    set('normal', whole(imageOfTexture(material.normalTexture)));
    set('emissive', whole(imageOfTexture(material.emissiveTexture)));
    const packed = imageOfTexture(pbr.metallicRoughnessTexture);
    const occlusion = imageOfTexture(material.occlusionTexture);
    if (packed !== null) {
      try {
        const [r, g, b] = await split(packed);
        set('roughness', g);
        set('metallic', b);
        if (occlusion === packed) set('occlusion', r);
      } catch {
        warnings.push(`The metallic-roughness image of material "${material.name ?? i}" could not be decoded and was skipped`);
      }
    }
    if (occlusion !== null && occlusion !== packed) set('occlusion', whole(occlusion));
    materialOf.push(materials.length);
    materials.push({
      name: typeof material.name === 'string' && material.name ? material.name : `${fallbackName}_material${i}`,
      baseColor: color(pbr.baseColorFactor, [1, 1, 1]),
      metallic: clamp(pbr.metallicFactor, 0, 1, 1),
      roughness: clamp(pbr.roughnessFactor, 0, 1, 1),
      emissive: color(material.emissiveFactor, [0, 0, 0]),
      emissiveStrength: clamp(material.extensions?.KHR_materials_emissive_strength?.emissiveStrength, 0, 100, defaultMaterial.emissiveStrength),
      normalScale: clamp(material.normalTexture?.scale, 0, 10, defaultMaterial.normalScale),
      maps,
    });
  }

  // --- Geometry and hierarchy through GLTFLoader ---------------------------------------------------
  // The loader gets a copy without images, textures and material details (it would try to decode the
  // images), with all buffers merged into the one binary chunk of a GLB.
  const offsets: number[] = [];
  let length = 0;
  for (const buffer of buffers) {
    offsets.push(length);
    length += (buffer?.length ?? 0) + ((4 - ((buffer?.length ?? 0) % 4)) % 4);
  }
  const merged = new Uint8Array(length);
  buffers.forEach((buffer, i) => buffer && merged.set(buffer, offsets[i]));
  const stripped: Json = {
    ...json,
    buffers: [{ byteLength: merged.length }],
    bufferViews: list(json.bufferViews).map((view) => ({ ...view, buffer: 0, byteOffset: (view.byteOffset ?? 0) + (offsets[view.buffer] ?? 0) })),
    materials: list(json.materials).map((material) => ({ name: material.name })),
    meshes: list(json.meshes).map((mesh) => ({
      ...mesh,
      // Without extras: the loader would copy them onto every geometry.
      primitives: list(mesh.primitives).map(({ extras: _extras, ...primitive }) => primitive),
    })),
  };
  for (const key of ['images', 'textures', 'samplers', 'animations', 'skins', 'cameras', 'extensionsUsed', 'extensionsRequired', 'extensions']) delete stripped[key];
  if (stripped.materials.length === 0) delete stripped.materials;
  if (stripped.meshes.length === 0) delete stripped.meshes;
  if (list(json.bufferViews).length === 0) delete stripped.bufferViews;
  if (merged.length === 0) delete stripped.buffers;
  stripped.nodes = list(json.nodes).map(({ skin: _skin, camera: _camera, extensions: _extensions, ...node }) => node);
  if (stripped.nodes.length === 0) delete stripped.nodes;

  const glb = packGlb(stripped, merged);
  const gltf = await new Promise<any>((resolve, reject) => {
    new GLTFLoader().parse(glb.buffer, '', resolve, (error: unknown) => {
      const message = error instanceof Error ? error.message : (error as { message?: string })?.message;
      reject(new FileError(`The glTF file could not be read: ${message ?? 'unknown error'}`));
    });
  });
  const root = gltf.scene ?? gltf.scenes?.[0];
  if (!root) throw new FileError('The glTF file contains no scene');
  // GLTFLoader rewrites names for its animation system ("Rib -1.2 +1" becomes "Rib_-12_+1") and numbers
  // duplicates, so names are taken from the JSON: the node's, else its mesh's, else (for the parts of a
  // mesh with several materials) the name of the node above.
  const nodes = list(json.nodes);
  const meshes = list(json.meshes);
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  const jsonName = (node: Object3D | null): string => {
    const found = node && gltf.parser.associations.get(node);
    return (found && (text(nodes[found.nodes]?.name) || text(meshes[found.meshes]?.name))) || '';
  };
  const tree = convertTree(root, {
    flipV: true,
    fallbackName,
    material: (material: ThreeMaterial) => {
      const index = gltf.parser.associations.get(material)?.materials;
      return typeof index === 'number' ? (materialOf[index] ?? null) : null;
    },
    name: (node) => jsonName(node) || (gltf.parser.associations.get(node)?.nodes === undefined ? jsonName(node.parent) : ''),
    polygons: (node) => {
      const found = gltf.parser.associations.get(node);
      return found && meshes[found.meshes]?.primitives?.[found.primitives]?.extras?.tessel?.polygons;
    },
  });
  warnings.push(...tree.warnings);
  if (tree.dropped > 0) warnings.push(`Dropped ${tree.dropped} degenerate triangle(s)`);
  return { objects: tree.objects, groups: tree.groups, materials, textures, warnings };
}
