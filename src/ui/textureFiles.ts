import { useEffect, useState } from 'react';
import { execute, selectDocState, useApp } from '../app/store';
import { MAX_TEXTURE_BASE64, MAX_TEXTURE_SIZE } from '../core/materials';
import { textureMimeTypes, type Texture, type TextureSlot } from '../core/types';
import { getT } from '../i18n';
import { textureBlob } from '../viewport/textureImage';

type MimeType = Texture['mimeType'];

export const textureAccept = textureMimeTypes.join(',');

const byExtension: Record<string, MimeType> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

function mimeType(file: File): MimeType | null {
  const known = (textureMimeTypes as readonly string[]).includes(file.type) ? (file.type as MimeType) : null;
  // Some sources (a drop from certain file managers) give no type.
  return known ?? (file.type === '' ? (byExtension[file.name.split('.').pop()!.toLowerCase()] ?? null) : null);
}

/** The file as base64. The browser encodes it natively, so large files cost no call stack or string juggling. */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const url = reader.result as string;
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Embeds an image file in the active document as a texture and returns its id.
 * Rejects with a message for the user if the file is not a usable image.
 */
export async function addTextureFromFile(file: File): Promise<string> {
  const t = getT().materials;
  const type = mimeType(file);
  if (!type) throw new Error(t.unsupported(file.name));
  // Base64 has four characters for every three bytes.
  const maxBytes = (MAX_TEXTURE_BASE64 / 4) * 3;
  if (file.size > maxBytes) throw new Error(t.tooLarge(file.name, Math.floor(maxBytes / (1024 * 1024))));
  let width: number;
  let height: number;
  try {
    const bitmap = await createImageBitmap(file);
    ({ width, height } = bitmap);
    bitmap.close();
  } catch {
    throw new Error(t.unreadable(file.name));
  }
  if (width > MAX_TEXTURE_SIZE || height > MAX_TEXTURE_SIZE) throw new Error(t.tooManyPixels(file.name, MAX_TEXTURE_SIZE));
  const data = await readBase64(file);
  const name = file.name.replace(/\.[^.]+$/, '') || file.name;
  const { id } = (await execute('texture.add', { name, mimeType: type, data, width, height })) as { id: string };
  return id;
}

/**
 * Embeds an image file as a texture and puts it into a map slot of the material. Two commands,
 * so two undo steps: the first undo empties the slot again, the second removes the texture.
 * Rejects with a message for the user if the file is not a usable image.
 */
export async function loadImageIntoSlot(file: File, materialId: string, slot: TextureSlot): Promise<void> {
  await setSlot(materialId, slot, await addTextureFromFile(file));
}

/**
 * Puts a texture of the document into a slot, or empties the slot with null. The emission map is
 * multiplied with the emission colour: on black it would stay invisible, so black turns white with
 * the map, and white turns black again without it (or the whole surface would glow).
 */
export function setSlot(materialId: string, slot: TextureSlot, textureId: string | null): Promise<unknown> {
  const material = selectDocState(useApp.getState()).materials[materialId];
  const emissive = slot !== 'emissive' ? undefined : textureId && material?.emissive === '#000000' ? '#ffffff' : !textureId && material?.emissive === '#ffffff' ? '#000000' : undefined;
  return execute('material.update', { id: materialId, maps: { [slot]: textureId }, ...(emissive ? { emissive } : {}) });
}

// --- Thumbnails ------------------------------------------------------------------------------

const THUMBNAIL_SIZE = 64;

/**
 * Small previews as data URLs, made once per `Texture` object. The cache holds them weakly: when
 * a texture is gone from the document and its history, its preview goes with it, so there is
 * nothing to revoke.
 */
const thumbnails = new WeakMap<Texture, string | Promise<string>>();

async function makeThumbnail(texture: Texture): Promise<string> {
  const scale = THUMBNAIL_SIZE / Math.max(texture.width, texture.height);
  const width = Math.max(1, Math.round(texture.width * scale));
  const height = Math.max(1, Math.round(texture.height * scale));
  // The browser scales while decoding; the full-size image is never kept.
  const bitmap = await createImageBitmap(textureBlob(texture), { resizeWidth: width, resizeHeight: height, resizeQuality: 'medium' });
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas.toDataURL('image/png');
}

/** The preview image of a texture, or null while it is being made (or if the image cannot be decoded). */
export function useThumbnail(texture: Texture | undefined): string | null {
  const cached = texture ? thumbnails.get(texture) : undefined;
  const [, setReady] = useState<Texture | null>(null);
  useEffect(() => {
    if (!texture || typeof thumbnails.get(texture) === 'string') return;
    let pending = thumbnails.get(texture) as Promise<string> | undefined;
    if (!pending) {
      pending = makeThumbnail(texture);
      thumbnails.set(texture, pending);
      pending.then(
        (url) => thumbnails.set(texture, url),
        () => thumbnails.delete(texture),
      );
    }
    let mounted = true;
    pending.then(
      () => mounted && setReady(texture),
      () => undefined,
    );
    return () => {
      mounted = false;
    };
  }, [texture]);
  return typeof cached === 'string' ? cached : null;
}
