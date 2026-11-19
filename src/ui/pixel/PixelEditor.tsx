import { Maximize2, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useReducer, useRef, useState } from 'react';
import { selectDocState, useApp } from '../../app/store';
import { faceRegions, frameHeight } from '../../core/minecraft/paintRegions';
import { brushFootprint, rgbToHex } from '../../imaging/pixelArt';
import { useT } from '../../i18n';
import { centeredView, clampZoom, fitZoom, screenToTexture, selectionEdges, stepZoom, wrap, wrapFloat, zoomAt, type Edge, type View } from './editorMath';
import { pixelSession } from './pixelSession';
import { frameRect, pixelTools, type PixelPointer } from './pixelTools';
import { shownFrame, usePixel } from './pixelStore';

const GRID_MIN_ZOOM = 6;
const TILE_ALPHA = 0.45;

interface Palette {
  accent: string;
  faint: string;
  lineStrong: string;
  panel: string;
  raised: string;
}

interface Api {
  zoomBy(direction: 1 | -1): void;
  fit(): void;
}

type Drag =
  | { kind: 'pan'; x: number; y: number; panX: number; panY: number }
  | { kind: 'paint'; button: number; offX: number; offY: number };

const brushTools = new Set(['brush', 'eraser', 'copy']);

/** The outline of the brush footprint (relative to the stamp pixel), cached per brush. */
const footprintCache = new Map<string, Edge[]>();
function footprintEdges(size: number, shape: 'square' | 'round'): Edge[] {
  const key = `${size}:${shape}`;
  let edges = footprintCache.get(key);
  if (!edges) {
    const cells = brushFootprint({ size, shape });
    const minX = Math.min(...cells.map((c) => c[0]));
    const minY = Math.min(...cells.map((c) => c[1]));
    const w = Math.max(...cells.map((c) => c[0])) - minX + 1;
    const h = Math.max(...cells.map((c) => c[1])) - minY + 1;
    const mask = new Uint8Array(w * h);
    for (const [x, y] of cells) mask[(y - minY) * w + (x - minX)] = 1;
    edges = selectionEdges(mask, w, h).map(([a, b, c, d]) => [a + minX, b + minY, c + minX, d + minY] as const);
    if (footprintCache.size > 200) footprintCache.clear();
    footprintCache.set(key, edges);
  }
  return edges;
}

function readPalette(el: Element): Palette {
  const css = getComputedStyle(el);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return { accent: v('--accent', '#e9b949'), faint: v('--faint', '#7c8886'), lineStrong: v('--line-strong', '#3b464c'), panel: v('--panel', '#1a1f22'), raised: v('--raised', '#232a2e') };
}

let checkerCache: { key: string; pattern: CanvasPattern } | null = null;
function checkerPattern(ctx: CanvasRenderingContext2D, panel: string, raised: string): CanvasPattern | null {
  const key = `${panel}|${raised}`;
  if (checkerCache?.key === key) return checkerCache.pattern;
  const tile = document.createElement('canvas');
  tile.width = tile.height = 16;
  const c = tile.getContext('2d');
  if (!c) return null;
  c.fillStyle = panel;
  c.fillRect(0, 0, 16, 16);
  c.fillStyle = raised;
  c.fillRect(0, 0, 8, 8);
  c.fillRect(8, 8, 8, 8);
  const pattern = ctx.createPattern(tile, 'repeat');
  if (pattern) checkerCache = { key, pattern };
  return pattern;
}

/** The 2D texture editor of the paint workspace: the texture being painted, with zoom, pan, grid, UV and selection overlays. */
export function PixelEditor() {
  const t = useT().pixel.editor;
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const api = useRef<Api>({ zoomBy: () => {}, fit: () => {} });
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [zoom, setZoom] = useState(1);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const texture = pixelSession.texture;

  useEffect(() => {
    const el = canvas.current;
    const box = host.current;
    if (!el || !box) return;
    const ctx = el.getContext('2d');
    if (!ctx) return;

    let view: View = { zoom: 1, panX: 0, panY: 0 };
    let auto = true;
    let fitKey = '';
    let fitSize = '';
    let size = { w: 0, h: 0 };
    let raf = 0;
    let drag: Drag | null = null;
    let space = false;
    let over = false;
    let hov: { x: number; y: number } | null = null;
    let wheelAcc = 0;
    let uploaded = -1;
    let uploadedId: unknown = null;
    const off = document.createElement('canvas');
    const offCtx = off.getContext('2d');
    let imageData: ImageData | null = null;
    let edgeCache: { mask: Uint8Array; y0: number; edges: Edge[] } | null = null;

    const frameInfo = () => {
      const tex = pixelSession.texture;
      const fr = frameRect();
      return tex && fr ? { tex, fr } : null;
    };

    const setView = (next: View, manual: boolean) => {
      if (manual) auto = false;
      const changed = next.zoom !== view.zoom;
      view = next;
      if (changed) setZoom(next.zoom);
      schedule();
    };

    const fitNow = () => {
      const info = frameInfo();
      if (!info || size.w === 0) return;
      const z = fitZoom(info.fr.width, info.fr.height, size.w, size.h);
      auto = true;
      setView(centeredView(info.fr.width, info.fr.height, size.w, size.h, z), false);
    };

    function schedule() {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        draw();
      });
    }

    const updateCursorStyle = () => {
      el.style.cursor = drag?.kind === 'pan' ? 'grabbing' : space ? 'grab' : 'crosshair';
    };

    // ------------------------------------------------------------------ drawing

    function draw() {
      const dpr = window.devicePixelRatio || 1;
      const cw = Math.max(1, Math.round(size.w * dpr));
      const ch = Math.max(1, Math.round(size.h * dpr));
      if (el!.width !== cw || el!.height !== ch) {
        el!.width = cw;
        el!.height = ch;
      }
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx!.clearRect(0, 0, size.w, size.h);
      const info = frameInfo();
      if (!info || !offCtx || !pixelSession.pixels || size.w === 0) return;
      const { tex, fr } = info;

      // Refit when the texture or the viewport changed and the user has not taken over the view.
      const key = `${tex.id}|${fr.width}x${fr.height}`;
      const sizeKey = `${size.w}x${size.h}`;
      if (key !== fitKey || (auto && sizeKey !== fitSize)) {
        fitKey = key;
        fitSize = sizeKey;
        fitNow();
        return;
      }

      ctx!.imageSmoothingEnabled = false;
      const pal = readPalette(box!);
      const z = view.zoom;
      const fx = view.panX;
      const fy = view.panY;
      const w = fr.width;
      const h = fr.height;
      const state = usePixel.getState();

      // Upload the composite when it changed.
      if (uploaded !== pixelSession.version || uploadedId !== pixelSession.pixels) {
        if (off.width !== pixelSession.width || off.height !== pixelSession.height) {
          off.width = pixelSession.width;
          off.height = pixelSession.height;
          imageData = null;
        }
        imageData ??= offCtx.createImageData(off.width, off.height);
        imageData.data.set(pixelSession.pixels);
        offCtx.putImageData(imageData, 0, 0);
        uploaded = pixelSession.version;
        uploadedId = pixelSession.pixels;
      }

      // Checkerboard under the shown copies.
      const tiled = state.tiled;
      const rx = tiled ? fx - w * z : fx;
      const ry = tiled ? fy - h * z : fy;
      const rw = tiled ? w * z * 3 : w * z;
      const rh = tiled ? h * z * 3 : h * z;
      ctx!.save();
      ctx!.beginPath();
      ctx!.rect(rx, ry, rw, rh);
      ctx!.clip();
      const checker = checkerPattern(ctx!, pal.panel, pal.raised);
      ctx!.fillStyle = checker ?? pal.panel;
      ctx!.fillRect(rx, ry, rw, rh);
      ctx!.restore();

      // The frame, and the dimmed copies around it.
      const span = tiled ? 1 : 0;
      for (let oy = -span; oy <= span; oy++) {
        for (let ox = -span; ox <= span; ox++) {
          ctx!.globalAlpha = ox === 0 && oy === 0 ? 1 : TILE_ALPHA;
          ctx!.drawImage(off, 0, fr.y, w, h, fx + ox * w * z, fy + oy * h * z, w * z, h * z);
        }
      }
      ctx!.globalAlpha = 1;

      // Pixel grid.
      if (state.grid && z >= GRID_MIN_ZOOM) {
        const x0 = Math.max(0, Math.floor(-fx / z));
        const x1 = Math.min(w, Math.ceil((size.w - fx) / z));
        const y0 = Math.max(0, Math.floor(-fy / z));
        const y1 = Math.min(h, Math.ceil((size.h - fy) / z));
        ctx!.beginPath();
        for (let i = x0; i <= x1; i++) {
          const sx = Math.round(fx + i * z) + 0.5;
          ctx!.moveTo(sx, Math.max(fy, 0));
          ctx!.lineTo(sx, Math.min(fy + h * z, size.h));
        }
        for (let j = y0; j <= y1; j++) {
          const sy = Math.round(fy + j * z) + 0.5;
          ctx!.moveTo(Math.max(fx, 0), sy);
          ctx!.lineTo(Math.min(fx + w * z, size.w), sy);
        }
        ctx!.lineWidth = 1;
        ctx!.strokeStyle = 'rgba(128, 128, 128, 0.35)';
        ctx!.stroke();
      }

      // Texture border.
      ctx!.lineWidth = 1;
      ctx!.strokeStyle = pal.lineStrong;
      ctx!.strokeRect(Math.round(fx) - 0.5, Math.round(fy) - 0.5, Math.round(w * z) + 1, Math.round(h * z) + 1);

      drawUv(tex.id, fr.y, shownFrame(tex), pal, z, fx, fy);
      drawSelection(tex.id, fr.y, h, pal, z, fx, fy);
      drawCursor(fr.y, state, pal, z, fx, fy);
    }

    function drawUv(textureId: string, frameY: number, frame: number, pal: Palette, z: number, fx: number, fy: number) {
      const doc = selectDocState(useApp.getState());
      const regions = faceRegions(doc, textureId, { frame }).filter((r) => r.rect.width > 0 && r.rect.height > 0);
      if (regions.length === 0) return;
      const rectOf = (r: (typeof regions)[number]) => [fx + r.rect.x * z, fy + (r.rect.y - frameY) * z, r.rect.width * z, r.rect.height * z] as const;
      ctx!.lineWidth = 1;
      ctx!.setLineDash([4, 3]);
      ctx!.strokeStyle = pal.faint;
      for (const r of regions) {
        if (r.elementId === doc.activeId) continue;
        const [x, y, rw, rh] = rectOf(r);
        ctx!.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(rw) - 1, Math.round(rh) - 1);
      }
      ctx!.setLineDash([]);
      ctx!.font = '10px ui-monospace, monospace';
      ctx!.textBaseline = 'top';
      for (const r of regions) {
        const active = r.elementId === doc.activeId;
        const [x, y, rw, rh] = rectOf(r);
        if (active) {
          ctx!.lineWidth = 2;
          ctx!.strokeStyle = pal.accent;
          ctx!.strokeRect(Math.round(x) + 1, Math.round(y) + 1, Math.round(rw) - 2, Math.round(rh) - 2);
        }
        if (rw >= 40 && rh >= 16) {
          ctx!.fillStyle = 'rgba(0, 0, 0, 0.55)';
          ctx!.fillText(r.face, x + 4, y + 4);
          ctx!.fillStyle = active ? pal.accent : pal.faint;
          ctx!.fillText(r.face, x + 3, y + 3);
        }
      }
    }

    function drawSelection(textureId: string, frameY: number, frameH: number, pal: Palette, z: number, fx: number, fy: number) {
      const sel = usePixel.getState().selection;
      if (!sel || sel.textureId !== textureId || sel.width !== pixelSession.width || sel.height !== pixelSession.height) return;
      ctx!.fillStyle = pal.accent;
      ctx!.globalAlpha = 0.18;
      for (let y = frameY; y < frameY + frameH; y++) {
        let x = 0;
        while (x < sel.width) {
          if (!sel.mask[y * sel.width + x]) {
            x++;
            continue;
          }
          const start = x;
          while (x < sel.width && sel.mask[y * sel.width + x]) x++;
          ctx!.fillRect(fx + start * z, fy + (y - frameY) * z, (x - start) * z, z);
        }
      }
      ctx!.globalAlpha = 1;
      if (!edgeCache || edgeCache.mask !== sel.mask || edgeCache.y0 !== frameY) {
        edgeCache = { mask: sel.mask, y0: frameY, edges: selectionEdges(sel.mask, sel.width, sel.height, frameY, frameH) };
      }
      ctx!.beginPath();
      for (const [a, b, c, d] of edgeCache.edges) {
        ctx!.moveTo(Math.round(fx + a * z) + 0.5, Math.round(fy + b * z) + 0.5);
        ctx!.lineTo(Math.round(fx + c * z) + 0.5, Math.round(fy + d * z) + 0.5);
      }
      ctx!.lineWidth = 1;
      ctx!.setLineDash([]);
      ctx!.strokeStyle = 'rgba(0, 0, 0, 0.9)';
      ctx!.stroke();
      ctx!.setLineDash([3, 3]);
      ctx!.strokeStyle = 'rgba(255, 255, 255, 0.95)';
      ctx!.stroke();
      ctx!.setLineDash([]);
    }

    function outline(edges: readonly Edge[], px: number, py: number, z: number, fx: number, fy: number) {
      ctx!.beginPath();
      for (const [a, b, c, d] of edges) {
        ctx!.moveTo(Math.round(fx + (px + a) * z) + 0.5, Math.round(fy + (py + b) * z) + 0.5);
        ctx!.lineTo(Math.round(fx + (px + c) * z) + 0.5, Math.round(fy + (py + d) * z) + 0.5);
      }
      ctx!.lineWidth = 3;
      ctx!.strokeStyle = 'rgba(0, 0, 0, 0.55)';
      ctx!.stroke();
      ctx!.lineWidth = 1;
      ctx!.strokeStyle = 'rgba(255, 255, 255, 0.95)';
      ctx!.stroke();
    }

    function drawCursor(frameY: number, state: ReturnType<typeof usePixel.getState>, pal: Palette, z: number, fx: number, fy: number) {
      const src = state.copySource;
      if (src && state.tool === 'copy') {
        const sy = src.at[1] - frameY;
        outline([[0, 0, 1, 0], [1, 0, 1, 1], [1, 1, 0, 1], [0, 1, 0, 0]], src.at[0], sy, z, fx, fy);
        const cx = fx + (src.at[0] + 0.5) * z;
        const cy = fy + (sy + 0.5) * z;
        const r = Math.max(3, z * 0.35);
        ctx!.beginPath();
        ctx!.moveTo(cx - r, cy);
        ctx!.lineTo(cx + r, cy);
        ctx!.moveTo(cx, cy - r);
        ctx!.lineTo(cx, cy + r);
        ctx!.lineWidth = 1.5;
        ctx!.strokeStyle = pal.accent;
        ctx!.stroke();
      }
      if (!hov || (drag?.kind === 'pan')) return;
      const edges = brushTools.has(state.tool) ? footprintEdges(state.size, state.shape) : ([[0, 0, 1, 0], [1, 0, 1, 1], [1, 1, 0, 1], [0, 1, 0, 0]] as Edge[]);
      outline(edges, hov.x, hov.y, z, fx, fy);
    }

    // ------------------------------------------------------------------ input

    const local = (e: { clientX: number; clientY: number }): [number, number] => {
      const r = el.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };

    const setHovered = (tx: number | null, ty: number) => {
      const next = tx === null ? null : { x: Math.floor(tx), y: Math.floor(ty) };
      if (next?.x === hov?.x && next?.y === hov?.y) return;
      hov = next;
      setHover(next);
      schedule();
    };

    const toPointer = (e: PointerEvent, button: number, offX: number, offY: number): PixelPointer | null => {
      const fr = frameRect();
      if (!fr) return null;
      const [sx, sy] = local(e);
      const [tx, ty] = screenToTexture(view, sx, sy);
      return { x: tx - offX, y: ty - offY + fr.y, button, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey };
    };

    const onDown = (e: PointerEvent) => {
      const tool = usePixel.getState().tool;
      const panning = e.button === 1 || (e.button === 0 && space) || (e.button === 2 && tool !== 'picker');
      if (panning) {
        e.preventDefault();
        drag = { kind: 'pan', x: e.clientX, y: e.clientY, panX: view.panX, panY: view.panY };
        el.setPointerCapture(e.pointerId);
        updateCursorStyle();
        return;
      }
      if (e.button !== 0 && e.button !== 2) return;
      const fr = frameRect();
      if (!fr) return;
      e.preventDefault();
      const [sx, sy] = local(e);
      const [tx, ty] = screenToTexture(view, sx, sy);
      // Painting on a tiled copy maps to the same pixels of the frame.
      const tiled = usePixel.getState().tiled;
      const offX = tiled ? Math.floor(tx / fr.width) * fr.width : 0;
      const offY = tiled ? Math.floor(ty / fr.height) * fr.height : 0;
      drag = { kind: 'paint', button: e.button, offX, offY };
      el.setPointerCapture(e.pointerId);
      const p = toPointer(e, e.button, offX, offY);
      if (p) pixelTools.down(p);
    };

    const onMove = (e: PointerEvent) => {
      const fr = frameRect();
      if (drag?.kind === 'pan') {
        setView({ ...view, panX: Math.round(drag.panX + e.clientX - drag.x), panY: Math.round(drag.panY + e.clientY - drag.y) }, true);
        return;
      }
      if (fr) {
        const [sx, sy] = local(e);
        const [tx, ty] = screenToTexture(view, sx, sy);
        setHovered(tx, ty);
      }
      if (drag?.kind === 'paint') {
        const events = e.getCoalescedEvents?.() ?? [];
        for (const ev of events.length ? events : [e]) {
          const p = toPointer(ev, drag.button, drag.offX, drag.offY);
          if (p) pixelTools.move(p);
        }
      }
    };

    const onUp = (e: PointerEvent) => {
      if (!drag) return;
      const was = drag;
      drag = null;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      if (was.kind === 'paint') {
        // The last position, so a quick click without movement still lands where it was released.
        const p = toPointer(e, was.button, was.offX, was.offY);
        if (p) pixelTools.move(p);
        pixelTools.up();
      }
      updateCursorStyle();
    };

    const onCancel = () => {
      if (drag?.kind === 'paint') pixelTools.cancel();
      drag = null;
      updateCursorStyle();
    };

    const onLeave = () => {
      if (!drag) setHovered(null, 0);
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      wheelAcc += e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      if (Math.abs(wheelAcc) < 40) return;
      const direction: 1 | -1 = wheelAcc < 0 ? 1 : -1;
      wheelAcc = 0;
      const [sx, sy] = local(e);
      setView(zoomAt(view, stepZoom(view.zoom, direction), sx, sy), true);
    };

    const typing = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && drag?.kind === 'paint') {
        pixelTools.cancel();
        drag = null;
        updateCursorStyle();
        return;
      }
      if (e.code === 'Space' && over && !typing(e.target)) {
        e.preventDefault();
        if (!space) {
          space = true;
          updateCursorStyle();
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space' && space) {
        space = false;
        updateCursorStyle();
      }
    };
    const onEnter = () => {
      over = true;
    };
    const onExit = () => {
      over = false;
    };

    api.current = {
      zoomBy(direction) {
        setView(zoomAt(view, stepZoom(view.zoom, direction), size.w / 2, size.h / 2), true);
      },
      fit: fitNow,
    };

    const observer = new ResizeObserver(() => {
      size = { w: box.clientWidth, h: box.clientHeight };
      schedule();
    });
    observer.observe(box);
    size = { w: box.clientWidth, h: box.clientHeight };

    const stopSession = pixelSession.onChange(() => {
      schedule();
      bump();
    });
    const stopPixel = usePixel.subscribe(schedule);
    const stopApp = useApp.subscribe(schedule);

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onCancel);
    el.addEventListener('pointerleave', onLeave);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    box.addEventListener('pointerenter', onEnter);
    box.addEventListener('pointerleave', onExit);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    updateCursorStyle();
    schedule();

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      stopSession();
      stopPixel();
      stopApp();
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('wheel', onWheel);
      box.removeEventListener('pointerenter', onEnter);
      box.removeEventListener('pointerleave', onExit);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      if (drag?.kind === 'paint') pixelTools.cancel();
    };
  }, []);

  // ---------------------------------------------------------------- status line

  const fr = frameRect();
  const fh = texture ? frameHeight(texture) : 0;
  let status: { x: number; y: number; hex: string; alpha: number } | null = null;
  if (texture && fr && hover) {
    const tiled = usePixel.getState().tiled;
    const x = tiled ? wrap(hover.x, fr.width) : hover.x;
    const y = tiled ? wrap(hover.y, fh) : hover.y;
    const rgba = pixelSession.sample(x, y + fr.y);
    if (rgba && x >= 0 && y >= 0 && x < fr.width && y < fh) status = { x, y, hex: rgbToHex(rgba[0], rgba[1], rgba[2]), alpha: rgba[3] };
  }

  const button =
    'grid h-7 w-7 place-items-center rounded border border-[var(--line-strong)] bg-[var(--raised)] text-[var(--dim)] hover:text-[var(--text)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]';

  return (
    <div ref={host} className="absolute inset-0 select-none overflow-hidden bg-[var(--ink)]">
      <canvas ref={canvas} role="img" aria-label={t.canvas(texture?.name ?? '')} className="absolute inset-0 h-full w-full touch-none" />
      {!texture && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center p-8 text-center text-[13px] text-[var(--faint)]">
          <p className="max-w-xs">{t.empty}</p>
        </div>
      )}
      {texture && (
        <>
          <div className="absolute right-2 top-2 flex gap-1">
            <button type="button" className={button} title={t.zoomOut} aria-label={t.zoomOut} onClick={() => api.current.zoomBy(-1)}>
              <ZoomOut size={15} aria-hidden />
            </button>
            <button type="button" className={button} title={t.zoomIn} aria-label={t.zoomIn} onClick={() => api.current.zoomBy(1)}>
              <ZoomIn size={15} aria-hidden />
            </button>
            <button type="button" className={button} title={t.fit} aria-label={t.fit} onClick={() => api.current.fit()}>
              <Maximize2 size={15} aria-hidden />
            </button>
          </div>
          <div className="pointer-events-none absolute bottom-2 left-2 flex max-w-[calc(100%-1rem)] flex-wrap items-center gap-x-3 gap-y-0.5 rounded bg-[var(--panel)]/85 px-2 py-1 font-mono text-[11px] text-[var(--dim)]">
            <span className="text-[var(--text)]">{texture.name}</span>
            <span>{t.size(texture.width, fh)}</span>
            <span>{t.zoom(Math.round(clampZoom(zoom) * 100))}</span>
            {status && (
              <>
                <span>{t.position(status.x, status.y)}</span>
                <span className="inline-flex items-center gap-1.5">
                  {status.alpha > 0 && <span className="inline-block h-2.5 w-2.5 border border-[var(--line-strong)]" style={{ background: status.hex, opacity: status.alpha / 255 }} aria-hidden />}
                  {status.alpha > 0 ? `${status.hex} ${Math.round((status.alpha / 255) * 100)}%` : t.transparent}
                </span>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
