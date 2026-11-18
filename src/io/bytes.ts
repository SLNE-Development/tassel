/** An import problem that is already explained in plain English; loader exceptions are wrapped instead. */
export class FileError extends Error {}

/** Bytes → base64 (no data: prefix). */
export function toBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

/** Base64 → bytes. Throws a readable error if the text is not base64. */
export function fromBase64(base64: string): Uint8Array<ArrayBuffer> {
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new FileError('The file data is not valid base64');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The bytes of a `data:` URI, or null if `uri` is not one. */
export function dataUriBytes(uri: string): { mimeType: string; bytes: Uint8Array<ArrayBuffer> } | null {
  const match = /^data:([^;,]*)((?:;[^;,]*)*),/i.exec(uri);
  if (!match) return null;
  const body = uri.slice(match[0].length);
  if (/;base64$/i.test(match[2])) return { mimeType: match[1], bytes: fromBase64(body) };
  return { mimeType: match[1], bytes: new TextEncoder().encode(decodeURIComponent(body)) };
}

/**
 * A number read from 32-bit float data as the shortest decimal that still names the same float
 * (0.1 instead of 0.10000000149011612). Lossless for float32 values; other numbers keep nine digits.
 */
export function tidyFloat(x: number): number {
  for (let digits = 6; digits < 9; digits++) {
    const short = Number(x.toPrecision(digits));
    if (Math.fround(short) === x) return short;
  }
  return Number(x.toPrecision(9));
}
