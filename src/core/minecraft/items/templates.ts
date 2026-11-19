// Ready-made item definitions: a single model, and the common "one base item, several custom_model_data
// variants" layout.
import { modelRef } from './tree';
import type { ItemDefinition, ItemModelNode } from './types';

export const variantModes = ['range', 'select', 'flags'] as const;
/**
 * How the variants are told apart, through the item's custom_model_data component:
 * - range: by a number in "floats" (like the old integer CustomModelData; `/give ... [custom_model_data={floats:[2]}]`),
 * - select: by a string in "strings",
 * - flags: by a boolean in "flags" (the variant with flags[index] true; the first true one wins).
 */
export type VariantMode = (typeof variantModes)[number];

export interface Variant {
  /** Model reference of the variant. */
  readonly model: string;
  /** range: the number; select: the string; flags: ignored (the flag index is the variant's position + `index`). */
  readonly value?: number | string;
}

/** A definition that always renders one model. */
export function singleModelDefinition(model: string): ItemDefinition {
  return { model: modelRef(model), fields: {} };
}

/** The tree for a base model with custom_model_data variants; `index` is the list position used (floats[index] ...). */
export function variantsNode(base: string, variants: readonly Variant[], mode: VariantMode, index = 0): ItemModelNode {
  const fallback = modelRef(base);
  const indexFields: Record<string, number> = index > 0 ? { index } : {};
  switch (mode) {
    case 'range':
      return {
        kind: 'range_dispatch',
        type: 'minecraft:range_dispatch',
        property: 'minecraft:custom_model_data',
        fields: indexFields,
        entries: variants.map((v, i) => ({ threshold: typeof v.value === 'number' ? v.value : Number(v.value ?? i + 1) || i + 1, model: modelRef(v.model), fields: {} })),
        fallback,
      };
    case 'select':
      return {
        kind: 'select',
        type: 'minecraft:select',
        property: 'minecraft:custom_model_data',
        fields: indexFields,
        cases: variants.map((v, i) => ({ when: String(v.value ?? `variant_${i + 1}`), model: modelRef(v.model), fields: {} })),
        fallback,
      };
    case 'flags': {
      let node: ItemModelNode = fallback;
      for (let i = variants.length - 1; i >= 0; i--) {
        const flag = index + i;
        node = {
          kind: 'condition',
          type: 'minecraft:condition',
          property: 'minecraft:custom_model_data',
          fields: flag > 0 ? { index: flag } : {},
          onTrue: modelRef(variants[i].model),
          onFalse: node,
        };
      }
      return node;
    }
  }
}

export function variantsDefinition(base: string, variants: readonly Variant[], mode: VariantMode, index = 0): ItemDefinition {
  return { model: variantsNode(base, variants, mode, index), fields: {} };
}
