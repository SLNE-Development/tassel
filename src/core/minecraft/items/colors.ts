// Tint colours in item definitions: an int (vanilla writes opaque ARGB, e.g. -6265536) or [r, g, b] floats 0..1.
import type { Json } from './types';
import type { ItemTestInputs } from './evaluate';
import { normalizeId } from './registry';
import type { TintSource } from './types';

const hex2 = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');

/** "#rrggbb" of a colour value, or null if it is not one. */
export function colorToHex(value: Json | undefined): string | null {
  if (typeof value === 'number' && Number.isInteger(value)) {
    const rgb = value & 0xffffff;
    return `#${rgb.toString(16).padStart(6, '0')}`;
  }
  if (Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === 'number')) {
    return `#${(value as number[]).map((n) => hex2(n * 255)).join('')}`;
  }
  return null;
}

/**
 * A colour value for "#rrggbb", in the form `like` has: [r, g, b] floats when `like` is a list, else an
 * opaque ARGB int as vanilla writes it.
 */
export function hexToColor(hex: string, like?: Json): Json {
  const rgb = parseInt(hex.replace('#', ''), 16) & 0xffffff;
  if (Array.isArray(like)) return [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255].map((n) => Math.round((n / 255) * 1000) / 1000);
  return (0xff000000 | rgb) | 0;
}

/** Grass colour at temperature 0.5 / downfall 1 (plains-like), for previews without a world. */
const GRASS_PREVIEW = '#91bd59';

/** The colour a tint source gives in a preview: its value or default (custom_model_data reads the test inputs' colors). */
export function tintPreviewColor(tint: TintSource, inputs: ItemTestInputs = {}): string | null {
  const type = normalizeId(tint.type);
  if (type === 'minecraft:constant') return colorToHex(tint.fields.value);
  if (type === 'minecraft:grass') return GRASS_PREVIEW;
  if (type === 'minecraft:custom_model_data') {
    const index = typeof tint.fields.index === 'number' ? tint.fields.index : 0;
    const color = inputs.customModelData?.colors?.[index];
    return color !== undefined ? colorToHex(color) : (colorToHex(tint.fields.default) ?? '#ffffff');
  }
  return colorToHex(tint.fields.default);
}
