// What a Minecraft model inherits from its parent chain, drawn read-only next to the document's own objects:
// the parent's elements (core/minecraft/parents.ts `inheritedElementsState`) or, for generated items, the flat
// extruded layer textures (`generatedItemState`). Not pickable: it lives in its own DocScene, outside the
// viewport's entries.
import { generatedItemState, generatedLayers, inheritedElementsState, type LayerPixels } from '../core/minecraft/parents';
import { emptyDocState } from '../core/state';
import type { AppState, DocState, Texture } from '../core/types';
import { fromBase64 } from '../io/bytes';
import { defaultDecoder, type DecodedImage } from '../mcassets/loader';
import { DocScene, type SceneLooks } from './docScene';

const EMPTY: DocState = { ...emptyDocState, format: 'minecraft_java' };

export class InheritedView {
  private readonly scene: DocScene;
  /** Decoded layer images by texture (undefined while decoding, null if unreadable). */
  private readonly pixels = new WeakMap<Texture, DecodedImage | null>();
  private readonly pending = new WeakSet<Texture>();
  private generated: { key: readonly Texture[]; state: DocState } | null = null;

  /** `onDecoded` is called when an image finished decoding, so that the viewport syncs again. */
  constructor(
    looks: SceneLooks,
    private readonly onDecoded: () => void,
  ) {
    this.scene = new DocScene(looks);
    looks.surfaces.keepTextures = () => Object.values(this.shown.textures);
  }

  /** The preview drawn last. */
  private shown: DocState = EMPTY;

  get content() {
    return this.scene.content;
  }

  sync(app: AppState, state: DocState): void {
    this.shown = this.preview(state) ?? EMPTY;
    this.scene.sync(app, this.shown);
  }

  dispose(): void {
    this.scene.dispose();
  }

  private preview(state: DocState): DocState | null {
    if (state.format !== 'minecraft_java' || !state.java?.inherited) return null;
    const elements = inheritedElementsState(state);
    if (elements) return elements;
    const layers = generatedLayers(state).map((l) => l.texture);
    if (layers.length === 0) return null;
    const cached = this.generated;
    if (cached && cached.key.length === layers.length && cached.key.every((t, i) => t === layers[i])) return cached.state;
    const decoded: LayerPixels[] = [];
    for (const texture of layers) {
      const image = this.decode(texture);
      if (image === undefined) return cached?.state ?? null; // still decoding
      if (image) decoded.push({ texture, width: image.width, height: image.height, pixels: image.pixels });
    }
    this.generated = { key: layers, state: generatedItemState(decoded) };
    return this.generated.state;
  }

  private decode(texture: Texture): DecodedImage | null | undefined {
    if (this.pixels.has(texture)) return this.pixels.get(texture);
    if (!this.pending.has(texture)) {
      this.pending.add(texture);
      defaultDecoder(fromBase64(texture.data))
        .catch(() => null)
        .then((image) => {
          this.pixels.set(texture, image);
          this.onDecoded();
        });
    }
    return undefined;
  }
}
