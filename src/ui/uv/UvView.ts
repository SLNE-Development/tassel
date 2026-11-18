// The 2D view of the UV editor: draws the UVs of one object on a canvas and handles the mouse.
// Imperative on purpose: it redraws from the store without going through React.
import { onAppearanceChange } from '../../app/preferences';
import { execute, selectDocState, useApp } from '../../app/store';
import { selectedFaces } from '../../core/mesh/selection';
import type { EditState, PolyMesh, Texture } from '../../core/types';
import { LiveEdit } from '../live';
import { notifyError } from '../toast';
import { facesInRect, pickFace, uvGeometry, type UvGeometry } from './geometry';
import { useUvUi, uvObject, type UvBackground } from './uvStore';

/** Device pixels per UV unit and the position of UV (0,0); v points up. */
interface View {
  scale: number;
  x: number;
  y: number;
}

type Gesture =
  | { kind: 'pan'; lastX: number; lastY: number }
  | { kind: 'box'; startX: number; startY: number; x: number; y: number; shift: boolean; moved: boolean }
  | { kind: 'face'; face: number; startX: number; startY: number; wasSelected: boolean; shift: boolean }
  | { kind: 'move'; startX: number; startY: number; du: number; dv: number; edit: LiveEdit; busy: boolean; stale: boolean; timer: number };

/** Number of chart tints; neighbouring charts usually differ. */
const TINTS = 5;
/**
 * Up to this many faces everything is redrawn on every pan / zoom frame. Above, the frames in between
 * move the bitmaps of the last full redraw, which follows when the view rests. (Timing the drawing
 * calls cannot decide this: the browser rasterises them later.)
 */
const REDRAW_EACH_FRAME_FACES = 3000;
/** Browsers build a path ever more slowly the longer it gets, so the faces are spread over many short ones. */
const PATH_FACES = 512;
const DRAG_THRESHOLD = 4;

/** Timings of the last redraws in ms, for profiling (`window.__uvPerf` in dev). */
export const uvPerf = { base: 0, selection: 0, paint: 0, geometry: 0, paths: 0 };
if (import.meta.env.DEV) (window as unknown as { __uvPerf: typeof uvPerf }).__uvPerf = uvPerf;

const images = new WeakMap<Texture, HTMLImageElement>();

function mixHex(a: string, b: string, t: number): string {
  const [ca, cb] = [a, b].map((hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)));
  return `rgb(${ca.map((c, i) => Math.round(c + (cb[i] - c) * t)).join(' ')})`;
}

function readColors() {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string) => style.getPropertyValue(name).trim();
  const [blue, green, red, dim] = [token('--axis-z'), token('--ok'), token('--axis-x'), token('--dim')];
  return {
    ink: token('--ink'),
    panel: token('--panel'),
    raised: token('--raised'),
    line: token('--line'),
    lineStrong: token('--line-strong'),
    accent: token('--accent'),
    // Cool, quiet tints from the existing tokens, so the brass selection stays the only warm colour.
    tints: [blue, mixHex(blue, green, 0.5), green, mixHex(blue, red, 0.5), dim],
  };
}

/** The outlines of the faces in UV space. */
function facePaths(uvs: readonly (readonly number[])[], faces: readonly number[]): Path2D[] {
  const started = performance.now();
  const paths: Path2D[] = [];
  for (let from = 0; from < faces.length; from += PATH_FACES) {
    const path = new Path2D();
    const to = Math.min(faces.length, from + PATH_FACES);
    for (let n = from; n < to; n++) {
      const uv = uvs[faces[n]];
      if (!uv || uv.length < 6) continue;
      path.moveTo(uv[0], uv[1]);
      for (let i = 2; i < uv.length; i += 2) path.lineTo(uv[i], uv[i + 1]);
      path.closePath();
    }
    paths.push(path);
  }
  uvPerf.paths = performance.now() - started;
  return paths;
}

const tintPaths = new WeakMap<UvGeometry, Path2D[][]>();

/** Per tint: the faces of all charts drawn in it. */
function chartPaths(geometry: UvGeometry): Path2D[][] {
  let paths = tintPaths.get(geometry);
  if (!paths) {
    const groups: number[][] = Array.from({ length: TINTS }, () => []);
    geometry.charts.forEach((chart, i) => {
      const group = groups[i % TINTS];
      for (const f of chart) group.push(f);
    });
    paths = groups.map((faces) => facePaths(geometry.uvs, faces));
    tintPaths.set(geometry, paths);
  }
  return paths;
}

const sameView = (a: View, b: View) => a.scale === b.scale && a.x === b.x && a.y === b.y;

export class UvView {
  private readonly ctx: CanvasRenderingContext2D;
  // Two bitmaps of the size of the canvas, both drawn for `layerView`: everything but the selection, and the selection.
  private readonly base = document.createElement('canvas');
  private readonly baseCtx = this.base.getContext('2d')!;
  private readonly overlay = document.createElement('canvas');
  private readonly overlayCtx = this.overlay.getContext('2d')!;
  private readonly disposers: (() => void)[] = [];

  private view: View = { scale: 1, x: 0, y: 0 };
  /** The view the bitmaps were drawn for; null when both have to be redrawn. */
  private layerView: View | null = null;
  private baseValid = false;
  private overlayValid = false;
  /** Until the user pans or zooms, the view keeps framing the 0..1 square. */
  private fitted = true;
  private frame = 0;
  private settle = 0;

  private colors = readColors();
  private objectId: string | null = null;
  private mesh: PolyMesh | null = null;
  private edit: EditState | null = null;
  private geometry: UvGeometry | null = null;
  private selection: readonly number[] = [];
  private selected = new Uint8Array(0);
  private selectionPaths: Path2D[] = [];
  private background: UvBackground = useUvUi.getState().background;
  private texture: Texture | null = null;
  private fitRequests = useUvUi.getState().fitRequests;

  private gesture: Gesture | null = null;
  /** Selection commands run one after the other. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;

    const observer = new ResizeObserver(([entry]) => {
      // The exact size in device pixels, so lines stay crisp at any zoom and UI scale.
      const box = entry.devicePixelContentBoxSize?.[0];
      const width = Math.max(1, Math.round(box ? box.inlineSize : entry.contentRect.width * devicePixelRatio));
      const height = Math.max(1, Math.round(box ? box.blockSize : entry.contentRect.height * devicePixelRatio));
      if (width === canvas.width && height === canvas.height) return;
      const [dx, dy] = [(width - canvas.width) / 2, (height - canvas.height) / 2];
      canvas.width = this.base.width = this.overlay.width = width;
      canvas.height = this.base.height = this.overlay.height = height;
      if (this.fitted) this.fit();
      else this.view = { ...this.view, x: this.view.x + dx, y: this.view.y + dy };
      this.layerView = null;
      // Resizing clears the canvas: draw now, not a frame later, so it never flashes empty.
      this.paint();
    });
    try {
      observer.observe(canvas, { box: 'device-pixel-content-box' });
    } catch {
      observer.observe(canvas);
    }

    const listen = <K extends keyof HTMLElementEventMap>(type: K, handler: (event: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions) => {
      canvas.addEventListener(type, handler, options);
      this.disposers.push(() => canvas.removeEventListener(type, handler, options));
    };
    listen('pointerdown', this.onPointerDown);
    listen('pointermove', this.onPointerMove);
    listen('pointerup', this.onPointerUp);
    listen('pointercancel', this.onPointerUp);
    listen('dblclick', this.onDoubleClick);
    listen('wheel', this.onWheel, { passive: false });
    listen('contextmenu', (event) => event.preventDefault());

    this.disposers.push(
      () => observer.disconnect(),
      useApp.subscribe(() => this.sync()),
      useUvUi.subscribe(() => this.sync()),
      onAppearanceChange(() => {
        this.colors = readColors();
        this.redraw();
      }),
    );
    this.sync();
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    clearTimeout(this.settle);
    for (const dispose of this.disposers) dispose();
  }

  // ---- State -----------------------------------------------------------------------------------

  /** Takes over what changed in the stores. Everything is compared by identity, so this is cheap. */
  private sync(): void {
    const ui = useUvUi.getState();
    if (ui.fitRequests !== this.fitRequests) {
      this.fitRequests = ui.fitRequests;
      this.fit();
      this.invalidate();
    }
    // While UVs are dragged the view shows its own preview; the document catches up on release.
    if (this.gesture?.kind === 'move') return;

    const state = selectDocState(useApp.getState());
    const object = uvObject(state);
    const mesh = object?.mesh ?? null;
    const edit = state.edit && state.edit.objectId === object?.id ? state.edit : null;
    const textureId = object?.materialId ? state.materials[object.materialId]?.maps.baseColor : undefined;
    const texture = (textureId && state.textures[textureId]) || null;

    let stale = false;
    if (mesh?.uvs !== this.mesh?.uvs) {
      const started = performance.now();
      this.geometry = mesh ? uvGeometry(mesh) : null;
      uvPerf.geometry = performance.now() - started;
      stale = true;
    }
    if (ui.background !== this.background || texture !== this.texture) {
      this.background = ui.background;
      this.texture = texture;
      stale = true;
    }
    const reselect = stale || edit !== this.edit || mesh !== this.mesh;
    this.objectId = object?.id ?? null;
    this.mesh = mesh;
    this.edit = edit;
    if (reselect) {
      this.selection = mesh && edit && this.geometry ? selectedFaces(mesh, edit) : [];
      this.selected = new Uint8Array(mesh?.faces.length ?? 0);
      for (const f of this.selection) this.selected[f] = 1;
      this.selectionPaths = this.geometry ? facePaths(this.geometry.uvs, this.selection) : [];
      this.overlayValid = false;
    }
    if (stale) this.redraw();
    else if (reselect) this.invalidate();
  }

  private image(): HTMLImageElement | null {
    if (this.background !== 'texture' || !this.texture) return null;
    let image = images.get(this.texture);
    if (!image) {
      image = new Image();
      image.onload = () => this.redraw();
      image.src = `data:${this.texture.mimeType};base64,${this.texture.data}`;
      images.set(this.texture, image);
    }
    return image.complete && image.naturalWidth > 0 ? image : null;
  }

  // ---- Drawing ---------------------------------------------------------------------------------

  /** Frames the 0..1 square. */
  private fit(): void {
    const { width, height } = this.canvas;
    const scale = Math.max(16, Math.min(width, height) - 56 * this.pixelRatio());
    this.view = { scale, x: Math.round((width - scale) / 2), y: Math.round((height + scale) / 2) };
    this.fitted = true;
  }

  /** Device pixels per CSS pixel of the canvas, including the UI scale. */
  private pixelRatio(): number {
    const width = this.canvas.getBoundingClientRect().width;
    return width > 0 ? this.canvas.width / width : devicePixelRatio;
  }

  /** The content changed: redraw everything on the next frame. */
  private redraw(): void {
    this.layerView = null;
    this.invalidate();
  }

  private invalidate(): void {
    this.frame ||= requestAnimationFrame(() => {
      this.frame = 0;
      this.paint();
    });
  }

  /** Background, grid and all faces for the layer view, into the base bitmap. */
  private drawBase(): void {
    const started = performance.now();
    const ctx = this.baseCtx;
    const { scale, x, y } = this.layerView!;
    const { colors, geometry } = this;
    const px = Math.max(1, Math.round(this.pixelRatio()));
    const top = y - scale;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = colors.ink;
    ctx.fillRect(0, 0, this.base.width, this.base.height);
    ctx.fillStyle = colors.panel;
    ctx.fillRect(x, top, scale, scale);

    const image = this.image();
    if (image) {
      ctx.imageSmoothingEnabled = scale < image.naturalWidth * 4;
      ctx.drawImage(image, x, top, scale, scale);
    } else if (this.background === 'checker') {
      ctx.fillStyle = colors.raised;
      for (let i = 0; i < 64; i++) {
        const [cx, cy] = [i % 8, i >> 3];
        if ((cx + cy) % 2 === 0) continue;
        const [x0, x1] = [Math.round(x + (cx * scale) / 8), Math.round(x + ((cx + 1) * scale) / 8)];
        const [y0, y1] = [Math.round(top + (cy * scale) / 8), Math.round(top + ((cy + 1) * scale) / 8)];
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      }
    } else {
      ctx.fillStyle = colors.line;
      for (let i = 1; i < 8; i++) {
        ctx.globalAlpha = i === 4 ? 1 : 0.55;
        ctx.fillRect(Math.round(x + (i * scale) / 8), top, px, scale);
        ctx.fillRect(x, Math.round(top + (i * scale) / 8), scale, px);
      }
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = colors.lineStrong;
    ctx.lineWidth = px;
    ctx.strokeRect(x - px / 2, top - px / 2, scale + px, scale + px);

    if (geometry) {
      const paths = chartPaths(geometry);
      ctx.setTransform(scale, 0, 0, -scale, x, y);
      ctx.lineWidth = px / scale;
      ctx.lineJoin = 'round';
      paths.forEach((tint, i) => {
        ctx.fillStyle = ctx.strokeStyle = colors.tints[i];
        ctx.globalAlpha = image ? 0.22 : 0.14;
        for (const path of tint) ctx.fill(path);
        ctx.globalAlpha = 0.85;
        for (const path of tint) ctx.stroke(path);
      });
    }
    this.baseValid = true;
    uvPerf.base = performance.now() - started;
  }

  /** The selected faces for the layer view, into the overlay bitmap. */
  private drawOverlay(): void {
    const started = performance.now();
    const ctx = this.overlayCtx;
    const { scale, x, y } = this.layerView!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    ctx.setTransform(scale, 0, 0, -scale, x, y);
    ctx.fillStyle = ctx.strokeStyle = this.colors.accent;
    ctx.lineWidth = (1.5 * this.pixelRatio()) / scale;
    ctx.lineJoin = 'round';
    ctx.globalAlpha = 0.3;
    for (const path of this.selectionPaths) ctx.fill(path);
    ctx.globalAlpha = 1;
    for (const path of this.selectionPaths) ctx.stroke(path);
    this.overlayValid = true;
    uvPerf.selection = performance.now() - started;
  }

  private paint(): void {
    const started = performance.now();
    const { ctx, view } = this;
    clearTimeout(this.settle);
    if (!this.layerView || (!sameView(this.layerView, view) && (this.mesh?.faces.length ?? 0) <= REDRAW_EACH_FRAME_FACES)) {
      this.layerView = { ...view };
      this.baseValid = this.overlayValid = false;
    } else if (!sameView(this.layerView, view)) {
      this.settle = window.setTimeout(() => this.redraw(), 120);
    }
    if (!this.baseValid) this.drawBase();
    if (!this.overlayValid) this.drawOverlay();

    // The bitmaps, moved and scaled from the view they were drawn for to the current one.
    const from = this.layerView;
    const k = view.scale / from.scale;
    const [x, y] = [view.x - from.x * k, view.y - from.y * k];
    const gesture = this.gesture;
    const [dx, dy] = gesture?.kind === 'move' ? [gesture.du * view.scale, -gesture.dv * view.scale] : [0, 0];
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = k !== 1;
    if (k === 1 && x === 0 && y === 0) {
      ctx.drawImage(this.base, 0, 0);
    } else {
      ctx.fillStyle = this.colors.ink;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.drawImage(this.base, x, y, this.base.width * k, this.base.height * k);
    }
    if (this.selectionPaths.length > 0) ctx.drawImage(this.overlay, x + dx, y + dy, this.overlay.width * k, this.overlay.height * k);

    const px = this.pixelRatio();
    if (gesture?.kind === 'box' && gesture.moved) {
      const [x, y] = [Math.min(gesture.startX, gesture.x), Math.min(gesture.startY, gesture.y)];
      const [w, h] = [Math.abs(gesture.x - gesture.startX), Math.abs(gesture.y - gesture.startY)];
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = ctx.strokeStyle = this.colors.accent;
      ctx.globalAlpha = 0.12;
      ctx.fillRect(x, y, w, h);
      ctx.globalAlpha = 1;
      ctx.lineWidth = Math.max(1, Math.round(px));
      ctx.setLineDash([4 * px, 3 * px]);
      ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
      ctx.setLineDash([]);
    }
    uvPerf.paint = performance.now() - started;
  }

  // ---- Mouse -----------------------------------------------------------------------------------

  /** Pointer position in device pixels of the canvas. */
  private position(event: MouseEvent): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    const k = this.canvas.width / rect.width;
    return [(event.clientX - rect.left) * k, (event.clientY - rect.top) * k];
  }

  private toUv(x: number, y: number): [number, number] {
    return [(x - this.view.x) / this.view.scale, (this.view.y - y) / this.view.scale];
  }

  private faceAt(x: number, y: number): number {
    return this.geometry ? pickFace(this.geometry, ...this.toUv(x, y)) : -1;
  }

  /**
   * Selects faces in the UV editor's object. Selecting needs edit mode in face mode, so the first
   * click switches to it: the faces of the UV editor are the faces of the 3D view.
   */
  private select(indices: readonly number[], action: 'replace' | 'add' | 'toggle'): Promise<unknown> {
    const id = this.objectId;
    return (this.queue = this.queue
      .then(async () => {
        if (!id) return;
        let edit = selectDocState(useApp.getState()).edit;
        if (edit?.objectId !== id) {
          await execute('edit.enter', { id });
          edit = selectDocState(useApp.getState()).edit;
        }
        if (edit?.elementMode !== 'face') await execute('edit.set_element_mode', { mode: 'face' });
        await execute('mesh.select', { indices, action });
      })
      .catch(notifyError));
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (this.gesture) return;
    const [x, y] = this.position(event);
    this.canvas.setPointerCapture(event.pointerId);
    if (event.button === 1 || event.button === 2) {
      event.preventDefault();
      this.gesture = { kind: 'pan', lastX: x, lastY: y };
      this.canvas.style.cursor = 'grabbing';
      return;
    }
    if (event.button !== 0 || !this.geometry) return;
    const face = this.faceAt(x, y);
    if (face < 0) {
      this.gesture = { kind: 'box', startX: x, startY: y, x, y, shift: event.shiftKey, moved: false };
      return;
    }
    const wasSelected = this.edit?.elementMode === 'face' && this.selected[face] === 1;
    this.gesture = { kind: 'face', face, startX: x, startY: y, wasSelected, shift: event.shiftKey };
    if (event.shiftKey) void this.select([face], 'toggle');
    else if (!wasSelected) void this.select([face], 'replace');
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const [x, y] = this.position(event);
    let gesture = this.gesture;
    if (!gesture) {
      const face = this.edit ? this.faceAt(x, y) : -1;
      this.canvas.style.cursor = face >= 0 && this.selected[face] ? 'move' : '';
      return;
    }
    if (gesture.kind === 'pan') {
      this.view = { ...this.view, x: this.view.x + x - gesture.lastX, y: this.view.y + y - gesture.lastY };
      this.fitted = false;
      gesture.lastX = x;
      gesture.lastY = y;
      this.invalidate();
      return;
    }
    const far = Math.hypot(x - gesture.startX, y - gesture.startY) > DRAG_THRESHOLD * this.pixelRatio();
    if (gesture.kind === 'box') {
      gesture.x = x;
      gesture.y = y;
      gesture.moved ||= far;
      this.invalidate();
      return;
    }
    // A drag that starts on a selected face moves the selection (once the click's own selection has arrived).
    if (gesture.kind === 'face' && far && this.selected[gesture.face]) {
      gesture = this.gesture = { kind: 'move', startX: gesture.startX, startY: gesture.startY, du: 0, dv: 0, edit: new LiveEdit(), busy: false, stale: false, timer: 0 };
    }
    if (gesture.kind === 'move') {
      const round = (n: number) => Math.round(n * 1e6) / 1e6;
      gesture.du = round((x - gesture.startX) / this.view.scale);
      gesture.dv = round((gesture.startY - y) / this.view.scale);
      this.follow(gesture);
      this.invalidate();
    }
  };

  /**
   * Lets the document (and with it the 3D view) follow a drag. Replacing the mesh costs time that
   * grows with its size, so it happens only as often as leaves most of the time to the drag itself,
   * whose preview in the UV editor never waits for it.
   */
  private follow(gesture: Extract<Gesture, { kind: 'move' }>): void {
    gesture.stale = true;
    if (gesture.busy) return;
    gesture.busy = true;
    gesture.stale = false;
    const started = performance.now();
    void gesture.edit.apply('uv.transform', { translate: [gesture.du, gesture.dv] }).finally(() => {
      gesture.timer = window.setTimeout(
        () => {
          gesture.busy = false;
          if (gesture.stale && this.gesture === gesture) this.follow(gesture);
        },
        Math.max(50, (performance.now() - started) * 4),
      );
    });
  }

  private readonly onPointerUp = (event: PointerEvent): void => {
    const gesture = this.gesture;
    if (!gesture) return;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    this.canvas.style.cursor = '';
    if (gesture.kind === 'move') {
      // The last position, as the one undo step of the whole drag.
      const { du, dv, edit } = gesture;
      clearTimeout(gesture.timer);
      const back = du === 0 && dv === 0;
      const done = (back && !edit.applied && !edit.busy ? Promise.resolve() : edit.apply('uv.transform', { translate: [du, dv] }))
        // Dragged back to where it started: nothing happened, so no undo step either.
        .then(() => (back && edit.applied && edit.intact() ? execute('history.undo') : undefined))
        .catch(notifyError);
      void done.finally(() => {
        this.gesture = null;
        this.sync();
        this.invalidate();
      });
      return;
    }
    this.gesture = null;
    if (gesture.kind === 'face') {
      // A plain click on one of several selected faces leaves just that one.
      if (!gesture.shift && gesture.wasSelected && this.selection.length > 1) void this.select([gesture.face], 'replace');
    } else if (gesture.kind === 'box' && this.geometry) {
      if (gesture.moved) {
        const [u0, v0] = this.toUv(gesture.startX, gesture.startY);
        const [u1, v1] = this.toUv(gesture.x, gesture.y);
        const faces = facesInRect(this.geometry, u0, v0, u1, v1);
        if (faces.length > 0 || (this.edit && !gesture.shift)) void this.select(faces, gesture.shift ? 'add' : 'replace');
      } else if (this.edit && !gesture.shift && this.selection.length > 0) {
        void this.select([], 'replace');
      }
    }
    this.invalidate();
  };

  private readonly onDoubleClick = (event: MouseEvent): void => {
    if (!this.geometry) return;
    const face = this.faceAt(...this.position(event));
    if (face >= 0) void this.select(this.geometry.charts[this.geometry.chartOf[face]], event.shiftKey ? 'add' : 'replace');
  };

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const [x, y] = this.position(event);
    const delta = event.deltaMode === 1 ? event.deltaY * 32 : event.deltaY;
    const scale = Math.min(4e5, Math.max(24, this.view.scale * Math.exp(-delta * 0.0015)));
    const k = scale / this.view.scale;
    // The UV point under the cursor stays under the cursor.
    this.view = { scale, x: x - (x - this.view.x) * k, y: y - (y - this.view.y) * k };
    this.fitted = false;
    this.invalidate();
  };
}
