// Pure helpers for materials and textures (see `Material` / `Texture` in types.ts).
import { z } from 'zod';
import { textureSlots } from './types';
import type { Material, SceneObject, Texture, TextureSlot } from './types';

export const defaultMaterial: Omit<Material, 'id' | 'name'> = {
  baseColor: '#b9b5ae',
  metallic: 0,
  roughness: 0.6,
  emissive: '#000000',
  emissiveStrength: 1,
  normalScale: 1,
  maps: {},
};

/** Validation of the material fields, shared by the commands and the project file format. */
export const materialFields = {
  baseColor: colorSchema('Base colour'),
  metallic: z.number().min(0).max(1),
  roughness: z.number().min(0).max(1),
  emissive: colorSchema('Emissive colour'),
  emissiveStrength: z.number().min(0).max(100),
  normalScale: z.number().min(0).max(10).describe('Strength of the normal map'),
};

function colorSchema(label: string) {
  return z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Colour must be #rrggbb')
    .transform((c) => c.toLowerCase())
    .describe(`${label} as #rrggbb (sRGB)`);
}

export const MAX_TEXTURE_SIZE = 16384;
/** Upper limit for the base64 text of one texture (64 MB). */
export const MAX_TEXTURE_BASE64 = 64 * 1024 * 1024;

export type TextureDataProblem = 'empty' | 'tooLarge' | 'notBase64' | 'signature';

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** The first bytes of base64 text (only as many as the text has). */
function leadingBytes(data: string, count: number): number[] {
  const bytes: number[] = [];
  for (let i = 0; i + 3 < data.length && bytes.length < count; i += 4) {
    const n =
      (BASE64.indexOf(data[i]) << 18) |
      (BASE64.indexOf(data[i + 1]) << 12) |
      ((BASE64.indexOf(data[i + 2]) & 63) << 6) |
      (BASE64.indexOf(data[i + 3]) & 63);
    bytes.push((n >> 16) & 255);
    if (data[i + 2] !== '=') bytes.push((n >> 8) & 255);
    if (data[i + 3] !== '=') bytes.push(n & 255);
  }
  return bytes.slice(0, count);
}

function hasSignature(mimeType: Texture['mimeType'], b: readonly number[]): boolean {
  const starts = (...sig: number[]) => sig.every((v, i) => b[i] === v);
  if (mimeType === 'image/png') return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  if (mimeType === 'image/jpeg') return starts(0xff, 0xd8, 0xff);
  // RIFF....WEBP
  return starts(0x52, 0x49, 0x46, 0x46) && [0x57, 0x45, 0x42, 0x50].every((v, i) => b[8 + i] === v);
}

/**
 * Checks that `data` is padded standard base64 within the size limit whose bytes start with the
 * file signature of `mimeType`. Returns what is wrong, or null. Never copies the string.
 */
export function textureDataProblem(mimeType: Texture['mimeType'], data: string): TextureDataProblem | null {
  if (data.length === 0) return 'empty';
  if (data.length > MAX_TEXTURE_BASE64) return 'tooLarge';
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return 'notBase64';
  return hasSignature(mimeType, leadingBytes(data, 12)) ? null : 'signature';
}

/** Size of the encoded image file in bytes. */
export function textureBytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

/** Every material slot that uses the texture. */
export function textureUsers(
  materials: Readonly<Record<string, Material>>,
  textureId: string,
): { materialId: string; slot: TextureSlot }[] {
  const users: { materialId: string; slot: TextureSlot }[] = [];
  for (const material of Object.values(materials)) {
    for (const slot of textureSlots) if (material.maps[slot] === textureId) users.push({ materialId: material.id, slot });
  }
  return users;
}

/**
 * Makes the material references of untrusted data valid: an object's `materialId` that points at
 * nothing becomes null, and map slots that point at a missing texture are removed.
 */
export function repairMaterials(
  objects: Readonly<Record<string, SceneObject>>,
  materials: Readonly<Record<string, Material>>,
  textures: Readonly<Record<string, Texture>>,
): { objects: Record<string, SceneObject>; materials: Record<string, Material> } {
  const fixedMaterials: Record<string, Material> = {};
  for (const material of Object.values(materials)) {
    const maps: Partial<Record<TextureSlot, string>> = {};
    for (const slot of textureSlots) {
      const textureId = material.maps[slot];
      if (textureId !== undefined && textureId in textures) maps[slot] = textureId;
    }
    const intact = Object.keys(maps).length === Object.keys(material.maps).length;
    fixedMaterials[material.id] = intact ? material : { ...material, maps };
  }
  const fixedObjects: Record<string, SceneObject> = {};
  for (const obj of Object.values(objects)) {
    const dangling = obj.materialId !== null && !(obj.materialId in fixedMaterials);
    fixedObjects[obj.id] = dangling ? { ...obj, materialId: null } : obj;
  }
  return { objects: fixedObjects, materials: fixedMaterials };
}
