import type { Texture } from '../core/types';

/** Base64 characters decoded per step; a multiple of 4, so every slice decodes on its own. */
const CHUNK = 1 << 20;

/** The encoded image file of a texture. Decodes the base64 in slices, so large images never need one huge binary string. */
export function textureBlob(texture: Texture): Blob {
  const { data } = texture;
  const parts: Uint8Array<ArrayBuffer>[] = [];
  for (let start = 0; start < data.length; start += CHUNK) {
    const binary = atob(data.slice(start, start + CHUNK));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    parts.push(bytes);
  }
  return new Blob(parts, { type: texture.mimeType });
}
