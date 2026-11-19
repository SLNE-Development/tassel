import { execute, selectDocState, useApp } from '../../app/store';
import type { PixelOp } from '../../core/pixelOps';
import type { Texture } from '../../core/types';
import { imaging } from '../../imaging';
import { compositeLayers, type LayerPixels } from '../../imaging/pixels';
import { applyPixelOp } from '../../imaging/pixelArt';
import { notifyError } from '../toast';
import { currentPixelTexture, pixelLayer, usePixel } from './pixelStore';

/** Decoded pixels of one PNG through the imaging service's cache (shared: read only). */
async function decodePng(data: string, width: number, height: number): Promise<Uint8ClampedArray> {
  const probe = { id: '', name: '', mimeType: 'image/png', data, width, height } as Texture;
  return (await imaging.pixels(probe)).pixels;
}

interface Loaded {
  texture: Texture;
  /** Layer edits go to; null = the texture's own image. */
  layerId: string | null;
  stack: LayerPixels[];
  /** Index of the edited layer in stack. */
  index: number;
}

/**
 * The pixels of the texture being pixel-painted, as the 2D editor and the 3D view show them: the document
 * texture's composite, or a live preview of the tool in use (computed with the same pure code the paint
 * commands run, so the committed texture looks exactly like its preview). Changes go through commands.
 */
class PixelSession {
  /** The texture shown, or null while there is none. */
  texture: Texture | null = null;
  /** The composite: RGBA, not premultiplied, row 0 = top. Never write to it. */
  pixels: Uint8ClampedArray | null = null;
  width = 0;
  height = 0;
  /** Increments with every change of `pixels` (buffer or contents). */
  version = 0;
  private loaded: Loaded | null = null;
  private loading: Texture | null = null;
  private committing = 0;
  private preview: PixelOp | null = null;
  private readonly listeners = new Set<() => void>();

  constructor() {
    useApp.subscribe(() => this.sync());
    usePixel.subscribe((s, p) => {
      if (s.textureId !== p.textureId || s.activeLayer !== p.activeLayer) this.sync();
    });
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  /** The layer's own pixels (or the image of a texture without layers), for tools that read them. */
  get layerPixels(): Uint8ClampedArray | null {
    return this.loaded ? this.loaded.stack[this.loaded.index].pixels : null;
  }

  get layerId(): string | null {
    return this.loaded?.layerId ?? null;
  }

  /** True while a preview is shown or a commit is under way. */
  get busy(): boolean {
    return this.preview !== null || this.committing > 0;
  }

  /** Follows the document: loads the target texture when it (or its layers) changed. */
  sync(): void {
    if (this.committing > 0) return;
    const app = useApp.getState();
    const minecraft = selectDocState(app).format === 'minecraft_java';
    const texture = app.workspace === 'paint' && minecraft ? currentPixelTexture() : undefined;
    if (!texture) {
      if (this.texture) {
        this.texture = null;
        this.loaded = null;
        this.changed();
      }
      return;
    }
    const layerId = pixelLayer(texture)?.id ?? null;
    if (this.loaded?.texture === texture && this.loaded.layerId === layerId) return;
    if (this.loading === texture) return;
    this.loading = texture;
    this.load(texture, layerId).then(
      (loaded) => {
        if (this.loading !== texture) return;
        this.loading = null;
        if (this.committing > 0) return;
        this.loaded = loaded;
        this.texture = texture;
        this.width = texture.width;
        this.height = texture.height;
        this.preview = null;
        this.pixels = compositeLayers(texture.width, texture.height, loaded.stack);
        this.changed();
      },
      (error) => {
        if (this.loading === texture) this.loading = null;
        notifyError(error);
      },
    );
  }

  private async load(texture: Texture, layerId: string | null): Promise<Loaded> {
    const { width, height } = texture;
    if (!texture.layers?.length) {
      const pixels = (await imaging.pixels(texture)).pixels;
      return { texture, layerId: null, stack: [{ pixels, visible: true, opacity: 1, blend: 'normal' }], index: 0 };
    }
    const stack = await Promise.all(
      texture.layers.map(async (layer) => ({
        pixels: layer.visible || layer.id === layerId ? await decodePng(layer.data, width, height) : new Uint8ClampedArray(0),
        visible: layer.visible,
        opacity: layer.opacity,
        blend: layer.blend,
      })),
    );
    return { texture, layerId, stack, index: texture.layers.findIndex((l) => l.id === layerId) };
  }

  /** The composite colour at a pixel: [r, g, b, a], or null outside / before loading. */
  sample(x: number, y: number): [number, number, number, number] | null {
    const { pixels, width, height } = this;
    if (!pixels || x < 0 || y < 0 || x >= width || y >= height) return null;
    const i = (Math.floor(y) * width + Math.floor(x)) * 4;
    return [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]];
  }

  /** Shows what `op` would do (null: back to the document's pixels). */
  show(op: PixelOp | null): void {
    const loaded = this.loaded;
    if (!loaded) return;
    this.preview = op;
    const { width, height } = loaded.texture;
    if (!op) {
      this.pixels = compositeLayers(width, height, loaded.stack);
      this.changed();
      return;
    }
    let edited: Uint8ClampedArray;
    try {
      edited = applyPixelOp(loaded.stack[loaded.index].pixels, width, height, op).pixels;
    } catch (error) {
      notifyError(error);
      return;
    }
    const stack = loaded.stack.map((entry, i) => (i === loaded.index ? { ...entry, pixels: edited } : entry));
    this.pixels = compositeLayers(width, height, stack);
    this.changed();
  }

  /**
   * Runs the command that makes the preview real. The preview stays on screen until the document holds
   * the result (or the command failed); then the session follows the document again.
   */
  async commit(id: string, params: Record<string, unknown>): Promise<void> {
    const loaded = this.loaded;
    if (!loaded) return;
    this.committing++;
    try {
      await execute(id, { textureId: loaded.texture.id, ...(loaded.layerId ? { layerId: loaded.layerId } : {}), ...params });
    } catch (error) {
      notifyError(error);
    } finally {
      this.committing--;
      this.preview = null;
      if (this.committing === 0) {
        // The edited texture is a new object: sync loads it (the service has its pixels cached).
        this.sync();
        if (this.loaded?.texture === loaded.texture) this.show(null);
      }
    }
  }
}

export const pixelSession = new PixelSession();
