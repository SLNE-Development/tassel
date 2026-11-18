import { execute, selectDocState, useApp } from '../../app/store';
import type { PaintBrush, StrokePoint, Texture } from '../../core/types';
import { beginStrokePreview, compositeTexture, type StrokePreview } from '../../imaging';
import { notifyError } from '../toast';
import { activeLayerOf, currentTarget, usePaint } from './paintStore';

/** A break in a stroke, queued between its points. */
const BREAK = null;

/** A stroke between pointer down and pointer up: one preview, one `paint.stroke`, however often it breaks at UV seams. */
interface Stroke {
  textureId: string;
  /** The layer it paints on, known once the preview has started. */
  layerId: string | null;
  brush: PaintBrush;
  /** Points (and breaks between them) that arrived before the preview was ready. */
  waiting: (StrokePoint | typeof BREAK)[];
  preview: StrokePreview | null;
  failed: boolean;
}

/**
 * The pixels of the texture being painted, as the viewport shows them: the document texture's
 * composite, or the live preview of the stroke in progress (the same code `paint.stroke` runs, so the
 * committed texture looks exactly like its preview). Everything that changes the document is a
 * command; this only keeps the picture in step with it.
 */
class PaintSession {
  /** The texture the paint workspace shows, or null outside it and while there is nothing to paint on. */
  textureId: string | null = null;
  /** Its pixels: RGBA, not premultiplied, row 0 = top. Null until they are decoded. Never write to them. */
  pixels: Uint8ClampedArray | null = null;
  width = 0;
  height = 0;
  /** The document texture `pixels` shows (while a stroke runs: the one it started from). */
  shown: Texture | null = null;

  private stroke: Stroke | null = null;
  /** Previews and commits run strictly one after the other: a preview needs the texture its predecessor committed. */
  private chain: Promise<void> = Promise.resolve();
  private busy = 0;
  private loading: Texture | null = null;
  /** Development only: bytes in which the last committed stroke differed from its preview. */
  previewMismatch = 0;
  private readonly listeners = new Set<() => void>();

  constructor() {
    useApp.subscribe(() => this.sync());
    usePaint.subscribe(() => this.sync());
  }

  /** Calls `listener` whenever `pixels` (the buffer or its contents) changed. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  private show(texture: Texture, pixels: Uint8ClampedArray, width: number, height: number): void {
    this.shown = texture;
    this.pixels = pixels;
    this.width = width;
    this.height = height;
    this.changed();
  }

  /** Follows the document and the paint target, unless a stroke of our own is under way. */
  private sync(): void {
    if (this.busy > 0) return;
    const app = useApp.getState();
    const target = app.workspace === 'paint' ? currentTarget() : null;
    const texture = target && !target.problem ? target.texture : undefined;
    if (!texture) {
      if (this.textureId === null) return;
      // `pixels` and `shown` stay: the viewport shows them until the texture's own image is decoded.
      this.textureId = null;
      this.loading = null;
      this.changed();
      return;
    }
    if (texture.id !== this.textureId) {
      this.textureId = texture.id;
      if (this.shown !== texture) this.pixels = null;
      this.changed();
    }
    if (texture === this.shown && this.pixels) return;
    if (texture === this.loading) return;
    this.loading = texture;
    compositeTexture(texture).then(
      ({ width, height, pixels }) => {
        if (this.loading !== texture) return;
        this.loading = null;
        if (this.busy === 0) this.show(texture, pixels, width, height);
      },
      (error) => {
        if (this.loading === texture) this.loading = null;
        notifyError(error);
      },
    );
  }

  /** Queues a step of a stroke behind everything queued before; the document is not followed meanwhile. */
  private enqueue(step: () => Promise<void>): void {
    this.busy++;
    this.chain = this.chain.then(step).then(
      () => this.settle(),
      (error) => {
        notifyError(error);
        this.settle();
      },
    );
  }

  private settle(): void {
    if (--this.busy === 0) this.sync();
  }

  /** True while a stroke is being painted or committed. */
  get painting(): boolean {
    return this.busy > 0;
  }

  /** Starts a stroke on the paint target. Points may follow at once; they wait until the preview is ready. */
  begin(brush: PaintBrush): boolean {
    const target = currentTarget();
    if (target.problem || !target.texture) return false;
    const stroke: Stroke = { textureId: target.texture.id, layerId: null, brush, waiting: [], preview: null, failed: false };
    this.stroke = stroke;
    this.enqueue(async () => {
      try {
        let texture = selectDocState(useApp.getState()).textures[stroke.textureId];
        if (!texture) throw new Error('The texture no longer exists');
        // An image without layers (imported, generated) gets them on the first stroke.
        if (!texture.layers?.length) {
          const { layerId } = (await execute('paint.add_layer', { textureId: texture.id })) as { layerId: string };
          usePaint.setState((s) => ({ activeLayer: { ...s.activeLayer, [stroke.textureId]: layerId } }));
          texture = selectDocState(useApp.getState()).textures[stroke.textureId];
        }
        const layer = activeLayerOf(texture);
        if (!layer) throw new Error('The texture has no layer to paint on');
        const preview = await beginStrokePreview(texture, layer.id, brush);
        stroke.preview = preview;
        stroke.layerId = layer.id;
        this.loading = null;
        this.textureId = texture.id;
        this.show(texture, preview.pixels, preview.width, preview.height);
        this.flush(stroke);
      } catch (error) {
        stroke.failed = true;
        throw error;
      }
    });
    return true;
  }

  private flush(stroke: Stroke): void {
    const preview = stroke.preview;
    if (!preview || stroke.waiting.length === 0) return;
    const waiting = stroke.waiting;
    stroke.waiting = [];
    let changed = false;
    let run: StrokePoint[] = [];
    const paint = () => {
      if (run.length > 0 && preview.extend(run)) changed = true;
      run = [];
    };
    for (const entry of waiting) {
      if (entry !== BREAK) {
        run.push(entry);
      } else {
        paint();
        preview.breakStroke();
      }
    }
    paint();
    if (changed) this.changed();
  }

  /** Continues the stroke with more UV points. */
  add(points: readonly StrokePoint[]): void {
    const stroke = this.stroke;
    if (!stroke || stroke.failed) return;
    stroke.waiting.push(...points);
    this.flush(stroke);
  }

  /**
   * Breaks the stroke at a UV seam: the points that follow are not connected to what was painted so far.
   * It stays one stroke — one preview, and one `paint.stroke` (one undo step) when it ends.
   */
  split(): void {
    const stroke = this.stroke;
    if (!stroke || stroke.failed) return;
    stroke.waiting.push(BREAK);
    this.flush(stroke);
  }

  /** Ends the stroke and commits it as ONE `paint.stroke`: one undo step for the whole drag, breaks at seams included. */
  end(): void {
    const stroke = this.stroke;
    if (!stroke) return;
    this.stroke = null;
    this.enqueue(async () => {
      const preview = stroke.preview;
      if (stroke.failed || !preview) return;
      this.flush(stroke);
      if (preview.points.length === 0) return;
      await execute('paint.stroke', {
        textureId: stroke.textureId,
        layerId: stroke.layerId,
        points: preview.points,
        ...(preview.breaks.length > 0 ? { breaks: preview.breaks } : {}),
        ...stroke.brush,
      });
      // From here on the picture is the committed texture itself (the service has it at hand: no decoding).
      const texture = selectDocState(useApp.getState()).textures[stroke.textureId];
      if (!texture) return;
      const { width, height, pixels } = await compositeTexture(texture);
      if (import.meta.env.DEV) {
        // The preview promised exactly these pixels.
        let differing = 0;
        for (let i = 0; i < pixels.length; i++) if (pixels[i] !== preview.pixels[i]) differing++;
        this.previewMismatch = differing;
        if (differing > 0) console.warn(`Paint: the committed stroke differs from its preview in ${differing} bytes`);
      }
      this.show(texture, pixels, width, height);
    });
  }

  /** The colour of the shown texture at a UV position, as #rrggbb, or null if there are no pixels yet. */
  sample(u: number, v: number): string | null {
    const { pixels, width, height } = this;
    if (!pixels) return null;
    const wrap = (t: number) => t - Math.floor(t);
    const x = Math.min(width - 1, Math.floor(wrap(u) * width));
    const y = Math.min(height - 1, Math.floor((1 - wrap(v)) * height));
    const i = (y * width + x) * 4;
    return `#${[pixels[i], pixels[i + 1], pixels[i + 2]].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
  }
}

export const paintSession = new PaintSession();
