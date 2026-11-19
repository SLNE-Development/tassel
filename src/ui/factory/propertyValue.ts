import type { FactoryValue } from '../../core/types';

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/** What a property field's text means: true/false are booleans, a number is a number, "quoted" text stays a string, anything else is a string. */
export function parsePropertyValue(text: string): FactoryValue {
  const trimmed = text.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (NUMBER.test(trimmed) && Number.isFinite(Number(trimmed))) return Number(trimmed);
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1);
  return trimmed;
}

/** The text a value is shown as; a string that would read back as another type is put in quotes. */
export function formatPropertyValue(value: FactoryValue): string {
  if (typeof value !== 'string') return String(value);
  return typeof parsePropertyValue(value) === 'string' && !(value.startsWith('"') && value.endsWith('"') && value.length >= 2) && value === value.trim() ? value : `"${value}"`;
}

/** `base`, `base_2`, ... whichever key is not used yet. */
export function freeKey(keys: Iterable<string>, base: string): string {
  const taken = new Set(keys);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
}

/** A comma-separated list as an array (blanks dropped, duplicates kept out). */
export function parseTags(text: string): string[] {
  return [...new Set(text.split(',').map((tag) => tag.trim()).filter(Boolean))];
}

/** An optional number field: empty = null; anything that is not a number is undefined (rejected). */
export function parseOptionalNumber(text: string): number | null | undefined {
  const trimmed = text.trim().replace(',', '.');
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}
