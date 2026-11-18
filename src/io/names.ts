// File names that come from the document (object, material and texture names) are untrusted.

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Turns any text into a plain file name part: no path separators, no characters Windows forbids,
 * no whitespace (OBJ/MTL separate tokens by spaces), no leading or trailing dots, never empty.
 */
export function sanitizeFileName(name: string, fallback = 'file'): string {
  const safe = name
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^[._]+|[._]+$/g, '')
    .slice(0, 80);
  if (safe === '' || RESERVED.test(safe)) return fallback;
  return safe;
}

/** `name`, or `name_2`, `name_3`, ... if taken (case-insensitive, like Windows file names). Adds the result to `taken`. */
export function uniqueFileName(taken: Set<string>, stem: string, extension = ''): string {
  let candidate = stem + extension;
  for (let i = 2; taken.has(candidate.toLowerCase()); i++) candidate = `${stem}_${i}${extension}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

/** File name without folder and extension. */
export function fileStem(name: string): string {
  const fileName = name.split(/[\\/]/).pop() ?? name;
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}
