// USDZ through three's USDZExporter. Needs the browser: the exporter draws every texture to a 2D canvas
// and re-encodes it (PNG, or JPEG for JPEG sources), limited to 4096 px.
import { USDZExporter } from 'three/addons/exporters/USDZExporter.js';
import type { DocState } from '../core/types';
import type { ExportItem } from './scene';
import { buildThreeScene } from './threeScene';

/**
 * Writes a .usdz. Groups become Xform prims, objects keep their transforms. The exporter writes
 * st = (u, 1 - v) for textures that are not flipped, so it is handed v-down UVs and unflipped images:
 * the file then has our v-up coordinates with the images as they are, which is USD's convention.
 */
export async function writeUsdz(state: DocState, items: readonly ExportItem[]): Promise<Uint8Array<ArrayBuffer>> {
  const built = await buildThreeScene(state, items, { v: 'down', emissive: 'baked', doubleSided: false, groups: true });
  try {
    const result = await new USDZExporter().parseAsync(built.scene, { maxTextureSize: 4096, includeAnchoringProperties: false });
    return new Uint8Array(result);
  } finally {
    built.dispose();
  }
}
