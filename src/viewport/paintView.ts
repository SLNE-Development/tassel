import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  LinearSRGBColorSpace,
  RepeatWrapping,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
  Vector2,
  Vector3,
  type Mesh,
  type PerspectiveCamera,
  type Raycaster,
  type Texture as GpuTexture,
} from 'three/webgpu';
import { getAppearance } from '../app/preferences';
import { selectDocState, useApp } from '../app/store';
import type { PolyMesh, StrokePoint, Texture } from '../core/types';
import { getT } from '../i18n';
import { brushColor, currentTarget, isScalarSlot, rememberColor, usePaint } from '../ui/paint/paintStore';
import { paintSession } from '../ui/paint/session';
import { notifyInfo } from '../ui/toast';
import { uvGeometry } from '../ui/uv/geometry';

/** What the paint view needs from the viewport engine. */
export interface PaintHost {
  readonly canvas: HTMLCanvasElement;
  readonly container: HTMLElement;
  readonly camera: PerspectiveCamera;
  readonly raycaster: Raycaster;
  /** Brings the three scene up to date with the document. */
  sync(): void;
  /** The mesh an object is drawn with (its evaluated geometry, with a `uv` attribute if unwrapped), or null. */
  target(objectId: string): { solid: Mesh; mesh: PolyMesh } | null;
  /** Every visible object's mesh: what can be in front of the painted one. */
  solids(): Mesh[];
  /** Asks for a sync and a redraw. */
  refresh(): void;
}

/** A point on the painted object under the pointer. */
interface Hit {
  u: number;
  v: number;
  /** UV island of the hit triangle. */
  chart: number;
  /** How far one screen pixel reaches in UV space at this point, seen head-on (0 if unknown). */
  uvPerPixel: number;
  /** The same along the slope of the surface: more where it is seen at a slant. */
  uvReach: number;
  /** Position in the canvas, in CSS pixels as laid out. */
  x: number;
  y: number;
  clientX: number;
  clientY: number;
}

/** Stamp distance of the brush as a fraction of its diameter. */
const SPACING = 0.15;
/** A sample this many times further away in UV space than its screen distance explains starts a new stroke segment. */
const JUMP = 4;
const ANISOTROPY = 4;

/** UV island per triangle of the triangulated mesh (triangles follow the faces in order, n - 2 per face). */
const triangleCharts = new WeakMap<PolyMesh, Int32Array>();

function chartsOf(mesh: PolyMesh): Int32Array | null {
  let charts = triangleCharts.get(mesh);
  if (!charts) {
    const geometry = uvGeometry(mesh);
    if (!geometry) return null;
    let count = 0;
    for (const face of mesh.faces) count += face.length - 2;
    charts = new Int32Array(count);
    let t = 0;
    mesh.faces.forEach((face, f) => {
      for (let i = 2; i < face.length; i++) charts![t++] = geometry.chartOf[f];
    });
    triangleCharts.set(mesh, charts);
  }
  return charts;
}

/**
 * Painting in the viewport: turns pointer input on the active object into UV strokes for the paint
 * session, draws the brush cursor, and lends the session's pixels to the surface materials as a GPU
 * texture, so that a stroke shows while it is painted and stays put when it is committed.
 */
export class PaintView {
  private readonly ring = document.createElement('div');
  /** One GPU texture per colour space over the session's pixel buffer; made when a material asks for it. */
  private gpu: { srgb: DataTexture | null; linear: DataTexture | null } = { srgb: null, linear: null };
  private gpuPixels: Uint8ClampedArray | null = null;
  private readonly unsubscribe: (() => void)[];
  private painting = false;
  private last: Hit | null = null;
  private pointer: { x: number; y: number } | null = null;
  private notified = 0;
  /** Upload statistics for measurements in development. */
  readonly stats = { uploads: 0 };

  constructor(private readonly host: PaintHost) {
    Object.assign(this.ring.style, {
      display: 'none',
      position: 'absolute',
      left: '0',
      top: '0',
      pointerEvents: 'none',
      boxSizing: 'border-box',
      borderRadius: '50%',
      border: '1px solid rgb(255 255 255 / 0.9)',
      boxShadow: '0 0 0 1px rgb(0 0 0 / 0.55), inset 0 0 0 1px rgb(0 0 0 / 0.55)',
    });
    host.container.appendChild(this.ring);
    const canvas = host.canvas;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    this.unsubscribe = [
      paintSession.onChange(this.onPixels),
      usePaint.subscribe(() => this.updateCursor()),
      useApp.subscribe((app, previous) => {
        if (app.workspace !== previous.workspace) this.updateCursor();
      }),
    ];
    if (import.meta.env.DEV) (window as unknown as { __tesselPaint: unknown }).__tesselPaint = { view: this, session: paintSession };
  }

  dispose(): void {
    const canvas = this.host.canvas;
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointermove', this.onPointerMove);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('pointercancel', this.onPointerUp);
    canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.unsubscribe.forEach((off) => off());
    this.gpu.srgb?.dispose();
    this.gpu.linear?.dispose();
    this.ring.remove();
  }

  // ---------------------------------------------------------------- textures for the surface materials

  private readonly onPixels = (): void => {
    const pixels = paintSession.pixels;
    if (pixels !== this.gpuPixels) {
      this.gpuPixels = pixels;
      for (const texture of [this.gpu.srgb, this.gpu.linear]) {
        if (!texture) continue;
        const image = texture.image as { width: number; height: number };
        if (!pixels || image.width !== paintSession.width || image.height !== paintSession.height) {
          // Another size is another GPU texture.
          texture.dispose();
          if (texture === this.gpu.srgb) this.gpu.srgb = null;
          else this.gpu.linear = null;
        } else {
          texture.image = { data: new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), width: paintSession.width, height: paintSession.height };
        }
      }
    }
    for (const texture of [this.gpu.srgb, this.gpu.linear]) {
      if (texture) {
        texture.needsUpdate = true;
        this.stats.uploads++;
      }
    }
    this.host.refresh();
  };

  private dataTexture(color: boolean): GpuTexture | null {
    const pixels = paintSession.pixels;
    if (!pixels) return null;
    const key = color ? 'srgb' : 'linear';
    let texture = this.gpu[key];
    if (!texture) {
      // The buffer has row 0 at the top; UVs have v = 0 at the bottom, hence flipY.
      texture = new DataTexture(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), paintSession.width, paintSession.height, RGBAFormat, UnsignedByteType);
      texture.flipY = true;
      texture.colorSpace = color ? SRGBColorSpace : LinearSRGBColorSpace;
      texture.wrapS = RepeatWrapping;
      texture.wrapT = RepeatWrapping;
      texture.magFilter = LinearFilter;
      texture.minFilter = LinearMipmapLinearFilter;
      texture.generateMipmaps = true;
      texture.anisotropy = ANISOTROPY;
      texture.needsUpdate = true;
      this.gpu[key] = texture;
      this.gpuPixels = pixels;
    }
    return texture;
  }

  /** The live texture for a document texture that is being painted, or null to show its own image. */
  liveTexture(texture: Texture, color: boolean): GpuTexture | null {
    return paintSession.textureId === texture.id ? this.dataTexture(color) : null;
  }

  /** Stands in for a document texture whose own image is still being decoded, if we hold exactly its pixels. */
  standIn(texture: Texture, color: boolean): GpuTexture | null {
    return paintSession.shown === texture ? this.dataTexture(color) : null;
  }

  /** While the height texture of this material is painted, it is shown as the base colour: the greys it holds. */
  heightPreview(materialId: string): GpuTexture | null {
    const ui = usePaint.getState();
    if (ui.slot !== 'height' || paintSession.textureId === null || ui.heightTexture[materialId] !== paintSession.textureId) return null;
    return this.dataTexture(true);
  }

  // ---------------------------------------------------------------- picking

  private active(): boolean {
    const app = useApp.getState();
    // Minecraft documents paint pixel art instead (pixelPaintView.ts).
    return app.workspace === 'paint' && selectDocState(app).format !== 'minecraft_java';
  }

  /** The point of the paint target under the given client position; null if something else (or nothing) is there. */
  private hit(clientX: number, clientY: number): Hit | null {
    const { canvas, camera, raycaster } = this.host;
    const state = selectDocState(useApp.getState());
    const target = state.activeId && !state.edit ? this.host.target(state.activeId) : null;
    const rect = canvas.getBoundingClientRect();
    if (!target || rect.width < 1 || rect.height < 1) return null;
    const uvs = target.solid.geometry.getAttribute('uv');
    const charts = chartsOf(target.mesh);
    if (!uvs || !charts) return null;
    // A CSS zoom of the interface scales what is on screen, not the layout the cursor is placed in.
    const zoom = rect.width / (canvas.clientWidth || rect.width);
    const x = (clientX - rect.left) / zoom;
    const y = (clientY - rect.top) / zoom;
    target.solid.updateWorldMatrix(true, false);
    camera.updateMatrixWorld();
    raycaster.setFromCamera(new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1), camera);
    const first = raycaster.intersectObjects(this.host.solids(), false)[0];
    if (!first || first.object !== target.solid || !first.uv || first.faceIndex == null) return null;

    // Local scale: how much surface one UV unit covers, against how much surface one pixel sees.
    const positions = target.solid.geometry.getAttribute('position');
    const i = first.faceIndex * 3;
    const [a, b, c] = [0, 1, 2].map((k) => new Vector3().fromBufferAttribute(positions, i + k).applyMatrix4(target.solid.matrixWorld));
    const normal = new Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a));
    const worldArea = normal.length() / 2;
    const [u0, v0, u1, v1, u2, v2] = [uvs.getX(i), uvs.getY(i), uvs.getX(i + 1), uvs.getY(i + 1), uvs.getX(i + 2), uvs.getY(i + 2)];
    const uvArea = Math.abs((u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0)) / 2;
    let uvPerPixel = 0;
    let uvReach = 0;
    if (worldArea > 0 && uvArea > 0) {
      const worldPerUv = Math.sqrt(worldArea / uvArea);
      const depth = first.point.clone().sub(camera.position).dot(camera.getWorldDirection(new Vector3()));
      const worldPerPixel = (2 * depth * Math.tan((camera.fov * Math.PI) / 360)) / (rect.height / zoom);
      uvPerPixel = worldPerPixel / worldPerUv;
      // Capped: at a grazing angle a pixel reaches arbitrarily far.
      uvReach = uvPerPixel / Math.max(Math.abs(normal.normalize().dot(raycaster.ray.direction)), 0.15);
    }
    return { u: first.uv.x, v: first.uv.y, chart: charts[first.faceIndex] ?? -1, uvPerPixel, uvReach, x, y, clientX, clientY };
  }

  // ---------------------------------------------------------------- pointer

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || event.pointerType === 'touch' || !this.active()) return;
    this.host.sync();
    const ui = usePaint.getState();
    const target = currentTarget();
    if (target.problem) {
      // Not on every click of an impatient hand.
      if (performance.now() - this.notified > 4000) {
        this.notified = performance.now();
        const t = getT().paint;
        notifyInfo(t.notReady, t.notReadyHint);
      }
      return;
    }
    const hit = this.hit(event.clientX, event.clientY);
    if (ui.tool === 'picker' || event.altKey) {
      const color = hit && paintSession.sample(hit.u, hit.v);
      if (color) {
        // A scalar slot takes the grey's level; the textures painted there are greys anyway.
        if (isScalarSlot(ui.slot)) usePaint.setState({ value: Math.round((parseInt(color.slice(1, 3), 16) / 255) * 100) / 100 });
        else usePaint.setState({ color });
      }
      return;
    }
    const brush = { color: brushColor(ui), size: ui.size, opacity: ui.opacity, hardness: ui.hardness, spacing: SPACING, erase: ui.tool === 'eraser' };
    if (!paintSession.begin(brush)) return;
    this.painting = true;
    this.last = null;
    this.host.canvas.setPointerCapture(event.pointerId);
    if (!brush.erase && !isScalarSlot(ui.slot)) rememberColor(brush.color);
    this.sample(event, hit);
  };

  /** Adds the pointer position to the stroke, starting a new segment where the surface or the UVs jump. */
  private sample(event: PointerEvent, hit: Hit | null = this.hit(event.clientX, event.clientY)): void {
    const last = this.last;
    this.last = hit;
    if (!hit) return;
    if (last) {
      if (!this.connected(last, hit)) {
        // Paint up to the seam on this side and from the seam on the other, so the gap stays invisible.
        const [before, after] = this.seam(last, hit);
        if (before) paintSession.add([this.point(event, before)]);
        paintSession.split();
        if (after) paintSession.add([this.point(event, after)]);
      }
    } else if (this.strokeHasPoints) {
      // Back on the object after leaving it: do not connect across the gap.
      paintSession.split();
    }
    this.strokeHasPoints = true;
    paintSession.add([this.point(event, hit)]);
  }

  /** Pens report how hard they press; a mouse always paints at full size. */
  private point(event: PointerEvent, hit: Hit): StrokePoint {
    return event.pointerType === 'pen' ? [hit.u, hit.v, event.pressure] : [hit.u, hit.v];
  }

  /** Whether a straight line in the texture from `a` to `b` is the path the pointer took on the surface. */
  private connected(a: Hit, b: Hit): boolean {
    const uvDistance = Math.hypot(b.u - a.u, b.v - a.v);
    const expected = Math.hypot(b.x - a.x, b.y - a.y) * Math.max(a.uvReach, b.uvReach);
    const texel = 1 / Math.max(1, Math.min(paintSession.width, paintSession.height));
    return a.chart === b.chart && uvDistance <= JUMP * expected + 2 * texel;
  }

  /**
   * Between two samples that are not connected: the last point still connected to `from` and, right
   * behind it, the first one on the chart of `to` (null where there is none), found by bisecting the
   * pointer's path on screen.
   */
  private seam(from: Hit, to: Hit): [Hit | null, Hit | null] {
    let before: Hit | null = null;
    let after: Hit | null = null;
    let [lo, hi] = [0, 1];
    for (let i = 0; i < 7; i++) {
      const t = (lo + hi) / 2;
      const hit = this.hit(from.clientX + (to.clientX - from.clientX) * t, from.clientY + (to.clientY - from.clientY) * t);
      if (hit && this.connected(before ?? from, hit)) {
        lo = t;
        before = hit;
      } else {
        hi = t;
        after = hit && hit.chart === to.chart && this.connected(hit, to) ? hit : null;
      }
    }
    return [before, after];
  }

  private strokeHasPoints = false;

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.active()) return;
    this.pointer = { x: event.clientX, y: event.clientY };
    if (this.painting) {
      this.host.sync();
      // The browser may bundle several positions into one event; a stroke wants them all.
      const events = event.getCoalescedEvents?.() ?? [];
      for (const e of events.length > 0 ? events : [event]) this.sample(e);
    }
    this.updateCursor();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (!this.painting || (event.type === 'pointerup' && event.button !== 0)) return;
    this.painting = false;
    this.strokeHasPoints = false;
    this.last = null;
    paintSession.end();
  };

  private readonly onPointerLeave = (): void => {
    this.pointer = null;
    this.updateCursor();
  };

  // ---------------------------------------------------------------- brush cursor

  /** A circle under the pointer, as large as the brush lands on the surface there. */
  private updateCursor(): void {
    const ui = usePaint.getState();
    const ready = this.active() && !currentTarget().problem;
    this.host.canvas.style.cursor = ready ? 'crosshair' : '';
    const pointer = this.pointer;
    const hit = ready && pointer && ui.tool !== 'picker' ? this.hit(pointer.x, pointer.y) : null;
    if (!hit || !pointer || hit.uvPerPixel <= 0 || paintSession.width === 0) {
      this.ring.style.display = 'none';
      return;
    }
    const diameter = Math.max(4, ui.size / paintSession.width / hit.uvPerPixel);
    Object.assign(this.ring.style, {
      display: 'block',
      width: `${diameter}px`,
      height: `${diameter}px`,
      transform: `translate(${hit.x - diameter / 2}px, ${hit.y - diameter / 2}px)`,
      borderColor: ui.tool === 'eraser' ? 'rgb(255 255 255 / 0.9)' : getAppearance().accent,
    });
  }
}
