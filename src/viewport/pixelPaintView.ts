import { isMinecraft } from '../core/formats';
import { DataTexture, RGBAFormat, UnsignedByteType, Vector2, type Mesh, type Texture as GpuTexture } from 'three/webgpu';
import { selectDocState, useApp } from '../app/store';
import { frameCount, frameHeight } from '../core/minecraft/paintRegions';
import { cuboidFaces, type Texture } from '../core/types';
import { pixelSession } from '../ui/pixel/pixelSession';
import { shownFrame, usePixel } from '../ui/pixel/pixelStore';
import { pixelTools, type PixelPointer } from '../ui/pixel/pixelTools';
import type { PaintHost } from './paintView';

/** What the pixel paint view needs from the engine beyond the smooth paint view's host. */
export interface PixelPaintHost extends PaintHost {
  /** The document object a viewport mesh draws, or null. */
  objectIdOf(solid: Mesh): string | null;
}

/** Live pixels and animation frames for the textures of Minecraft faces (surfaces.ts asks). */
export interface PixelTextures {
  /** The session's live pixels for this texture (nearest filtered), or null to show its own image. */
  livePixels(texture: Texture): GpuTexture | null;
  /** Which frame of an animated texture to show. */
  frameOf(texture: Texture): number;
}

/**
 * Pixel painting on the elements of a Minecraft model in the 3D view: turns the pointer on a face into
 * texture pixels for the shared tool controller (the same one the 2D editor uses), and lends the session's
 * pixels to the face materials so a stroke shows while it is drawn.
 */
export class PixelPaintView implements PixelTextures {
  private gpu: DataTexture | null = null;
  private gpuPixels: Uint8ClampedArray | null = null;
  private dragging = false;
  private readonly unsubscribe: (() => void)[];

  constructor(private readonly host: PixelPaintHost) {
    const canvas = host.canvas;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerCancel);
    this.unsubscribe = [
      pixelSession.onChange(this.onPixels),
      usePixel.subscribe((s, p) => {
        if (s.frame !== p.frame || s.playing !== p.playing) host.refresh();
      }),
      useApp.subscribe((app, previous) => {
        if (app.workspace !== previous.workspace) this.updateCursor();
      }),
    ];
  }

  dispose(): void {
    const canvas = this.host.canvas;
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointermove', this.onPointerMove);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('pointercancel', this.onPointerCancel);
    this.unsubscribe.forEach((off) => off());
    this.gpu?.dispose();
  }

  // ---------------------------------------------------------------- textures

  private readonly onPixels = (): void => {
    const pixels = pixelSession.pixels;
    if (this.gpu && (pixels !== this.gpuPixels || !pixels)) {
      const image = this.gpu.image as { width: number; height: number };
      if (!pixels || image.width !== pixelSession.width || image.height !== pixelSession.height) {
        this.gpu.dispose();
        this.gpu = null;
      } else {
        this.gpu.image = { data: new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), width: pixelSession.width, height: pixelSession.height };
      }
    }
    this.gpuPixels = pixels;
    if (this.gpu) this.gpu.needsUpdate = true;
    this.host.refresh();
  };

  livePixels(texture: Texture): GpuTexture | null {
    const pixels = pixelSession.pixels;
    if (!pixels || pixelSession.texture?.id !== texture.id || useApp.getState().workspace !== 'paint') return null;
    if (!this.gpu) {
      const texture3 = new DataTexture(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), pixelSession.width, pixelSession.height, RGBAFormat, UnsignedByteType);
      // The buffer has row 0 at the top; UVs have v = 0 at the bottom.
      texture3.flipY = true;
      texture3.needsUpdate = true;
      this.gpu = texture3;
      this.gpuPixels = pixels;
    }
    return this.gpu;
  }

  frameOf(texture: Texture): number {
    if (!texture.animation) return 0;
    const ui = usePixel.getState();
    const painting = useApp.getState().workspace === 'paint' && pixelSession.texture?.id === texture.id;
    return painting || ui.playing ? Math.min(shownFrame(texture, ui.frame), frameCount(texture) - 1) : 0;
  }

  // ---------------------------------------------------------------- pointer

  private active(): boolean {
    const app = useApp.getState();
    return app.workspace === 'paint' && isMinecraft(selectDocState(app));
  }

  /** The texture pixel under the pointer on an enabled element face, or null. */
  private hit(event: PointerEvent): (PixelPointer & { textureId: string }) | null {
    const { canvas, camera, raycaster } = this.host;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    const state = selectDocState(useApp.getState());
    raycaster.setFromCamera(new Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1), camera);
    camera.updateMatrixWorld();
    for (const hit of raycaster.intersectObjects(this.host.solids(), false)) {
      const id = this.host.objectIdOf(hit.object as Mesh);
      const obj = id ? state.objects[id] : undefined;
      if (!obj?.cuboid || !hit.uv || !hit.face) continue;
      const name = cuboidFaces[hit.face.materialIndex];
      const face = name && obj.cuboid.faces[name];
      // Faces that are switched off are not drawn: the pointer reaches what is behind them.
      if (!face?.enabled) continue;
      if (!face.texture || !Object.hasOwn(state.textures, face.texture)) return null;
      const texture = state.textures[face.texture];
      const h = frameHeight(texture);
      const frame = pixelSession.texture?.id === texture.id ? shownFrame(texture) : 0;
      const clamp = (v: number, max: number) => Math.min(max - 1e-6, Math.max(0, v));
      return {
        textureId: texture.id,
        x: clamp(hit.uv.x * texture.width, texture.width),
        y: clamp((1 - hit.uv.y) * h, h) + frame * h,
        button: event.button,
        shift: event.shiftKey,
        ctrl: event.ctrlKey || event.metaKey,
        alt: event.altKey,
        face: { elementId: obj.id, face: name },
      };
    }
    return null;
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    // The right button orbits the camera; the left one paints (Alt+click picks a colour).
    if (!this.active() || event.pointerType === 'touch' || event.button !== 0) return;
    this.host.sync();
    const hit = this.hit(event);
    if (!hit) return;
    // A face showing another texture makes that texture the one being painted (it loads; then paint).
    if (hit.textureId !== pixelSession.texture?.id) {
      usePixel.setState({ textureId: hit.textureId });
      return;
    }
    pixelTools.down(hit);
    if (pixelTools.active) {
      this.dragging = true;
      this.host.canvas.setPointerCapture(event.pointerId);
    }
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.active()) return;
    if (!this.dragging) {
      this.updateCursor();
      return;
    }
    const events = event.getCoalescedEvents?.() ?? [];
    for (const e of events.length > 0 ? events : [event]) {
      const hit = this.hit(e);
      // Off the textured faces (or onto another texture) the stroke pauses.
      if (hit && hit.textureId === pixelSession.texture?.id) pixelTools.move(hit);
    }
  };

  private readonly onPointerUp = (): void => {
    if (!this.dragging) return;
    this.dragging = false;
    pixelTools.up();
  };

  private readonly onPointerCancel = (): void => {
    if (!this.dragging) return;
    this.dragging = false;
    pixelTools.cancel();
  };

  private updateCursor(): void {
    this.host.canvas.style.cursor = this.active() ? 'crosshair' : '';
  }
}
