import { selectDocState, useApp } from '../../app/store';
import { pixelMirror } from '../../core/commands/pixelPaint';
import { frameHeight } from '../../core/minecraft/paintRegions';
import type { PixelOp, PixelPaint, PixelRect, Px, SelectionShape, SelectMode } from '../../core/pixelOps';
import type { CuboidFaceName } from '../../core/types';
import { maskToShape, rgbToHex, selectionMask } from '../../imaging/pixelArt';
import { pixelSession } from './pixelSession';
import { shownFrame, usePixel, type PixelSelection, type PixelUiState } from './pixelStore';

// The pixel tools, shared by the 2D texture editor and the 3D view: both translate the pointer into texture
// pixels and hand it to the one controller, which previews in the pixel session and commits one command
// (one undo step) per drag or click.

/** The pointer in texture pixels (fractional; the pixel is the floor), with what the view knows about it. */
export interface PixelPointer {
  readonly x: number;
  readonly y: number;
  /** 0 left, 2 right. */
  readonly button: number;
  readonly shift: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
  /** The 3D view: the element face under the pointer. */
  readonly face?: { readonly elementId: string; readonly face: CuboidFaceName };
}

type Drag =
  | { kind: 'stroke'; tool: 'brush' | 'eraser' | 'copy'; points: Px[]; breaks: number[]; face: string | null; offset?: Px }
  | { kind: 'span'; tool: 'shape' | 'gradient'; from: Px; to: Px; shift: boolean }
  | { kind: 'select'; from: Px; to: Px; points: Px[]; mode: SelectMode; base: PixelSelection | null }
  | { kind: 'move'; from: Px; dx: number; dy: number; copy: boolean; selection: SelectionShape[] };

const pixelOf = (p: PixelPointer): Px => [Math.floor(p.x), Math.floor(p.y)];

function paintOf(ui: PixelUiState, erase: boolean, color = ui.primary): PixelPaint {
  return { color, opacity: ui.opacity, blend: ui.blend, lockAlpha: ui.lockAlpha, erase };
}

/** The selection as the commands take it (undefined: nothing selected = everywhere). */
export function selectionParam(ui: Pick<PixelUiState, 'selection'> = usePixel.getState()): SelectionShape[] | undefined {
  const sel = ui.selection;
  if (!sel || sel.textureId !== pixelSession.texture?.id || sel.width !== pixelSession.width || sel.height !== pixelSession.height) return undefined;
  const shape = maskToShape(sel.mask, sel.width, sel.height);
  return shape ? [shape] : undefined;
}

/** The mirror parameter of the commands, from the store (undefined when off). */
function mirrorParam(ui: PixelUiState): { axes: ('x' | 'z')[]; mode: 'global' | 'local'; image: boolean } | undefined {
  if (!ui.mirror.enabled) return undefined;
  const minecraft = selectDocState(useApp.getState()).format === 'minecraft_java';
  const axes = minecraft ? [...ui.mirror.axes] : [];
  if (axes.length === 0 && !ui.mirror.image) return undefined;
  return { axes, mode: ui.mirror.mode, image: ui.mirror.image };
}

/** Constrains a span to a square (Shift), keeping the start where it is. */
function square(from: Px, to: Px): Px {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const d = Math.max(Math.abs(dx), Math.abs(dy));
  return [from[0] + Math.sign(dx || 1) * d, from[1] + Math.sign(dy || 1) * d];
}

const rectBetween = (a: Px, b: Px): PixelRect => ({
  x: Math.min(a[0], b[0]),
  y: Math.min(a[1], b[1]),
  width: Math.abs(a[0] - b[0]) + 1,
  height: Math.abs(a[1] - b[1]) + 1,
});

class PixelToolController {
  private drag: Drag | null = null;
  /** Where the last stroke ended: Shift+click draws a straight line from there. */
  private lastPoint: Px | null = null;

  get active(): boolean {
    return this.drag !== null;
  }

  private frame(): number {
    return shownFrame(pixelSession.texture ?? undefined);
  }

  /** Alt+click (or the picker tool): takes the colour under the pointer. Right button: the secondary colour. */
  private pick(p: PixelPointer): void {
    const rgba = pixelSession.sample(p.x, p.y);
    if (!rgba || rgba[3] === 0) return;
    const color = rgbToHex(rgba[0], rgba[1], rgba[2]);
    usePixel.setState(p.button === 2 ? { secondary: color } : { primary: color });
  }

  down(p: PixelPointer): void {
    if (!pixelSession.texture || pixelSession.busy) return;
    const ui = usePixel.getState();
    const at = pixelOf(p);
    if (ui.tool === 'picker' || (p.alt && ui.tool !== 'select' && ui.tool !== 'move')) {
      this.pick(p);
      return;
    }
    if (p.button !== 0) return;
    switch (ui.tool) {
      case 'brush':
      case 'eraser': {
        const points: Px[] = p.shift && this.lastPoint ? [this.lastPoint, at] : [at];
        this.drag = { kind: 'stroke', tool: ui.tool, points, breaks: [], face: p.face ? `${p.face.elementId}/${p.face.face}` : null };
        break;
      }
      case 'copy': {
        if (p.ctrl) {
          this.setCopySource(at);
          return;
        }
        const source = ui.copySource;
        if (!source) return;
        const offset: Px | undefined = ui.copyMode === 'copy' ? [source.at[0] - at[0], source.at[1] - at[1]] : undefined;
        this.drag = { kind: 'stroke', tool: 'copy', points: [at], breaks: [], face: p.face ? `${p.face.elementId}/${p.face.face}` : null, offset };
        break;
      }
      case 'fill':
        void this.fill(p, at);
        return;
      case 'shape':
      case 'gradient':
        this.drag = { kind: 'span', tool: ui.tool, from: at, to: at, shift: p.shift };
        break;
      case 'select': {
        const mode: SelectMode = p.shift ? 'add' : p.ctrl || p.alt ? 'subtract' : ui.selectMode;
        if (ui.selectKind === 'wand' || ui.selectKind === 'color') {
          this.applySelection({ shape: ui.selectKind, x: at[0], y: at[1], tolerance: ui.tolerance }, mode, ui.selection);
          return;
        }
        this.drag = { kind: 'select', from: at, to: at, points: [at], mode, base: ui.selection };
        this.updateSelection();
        return;
      }
      case 'move': {
        const selection = selectionParam(ui) ?? [{ shape: 'rect', x: 0, y: 0, width: pixelSession.width, height: pixelSession.height }];
        this.drag = { kind: 'move', from: at, dx: 0, dy: 0, copy: p.ctrl || p.alt, selection };
        break;
      }
    }
    this.preview();
  }

  move(p: PixelPointer): void {
    const drag = this.drag;
    if (!drag) return;
    const at = pixelOf(p);
    if (drag.kind === 'stroke') {
      const last = drag.points[drag.points.length - 1];
      const face = p.face ? `${p.face.elementId}/${p.face.face}` : null;
      // In the 3D view a stroke does not connect across faces: their pixels are not neighbours in the texture.
      if (face !== drag.face) {
        drag.face = face;
        drag.breaks.push(drag.points.length);
        drag.points.push(at);
      } else if (last[0] !== at[0] || last[1] !== at[1]) {
        drag.points.push(at);
      } else return;
    } else if (drag.kind === 'span') {
      drag.to = p.shift ? square(drag.from, at) : at;
      drag.shift = p.shift;
    } else if (drag.kind === 'select') {
      const last = drag.points[drag.points.length - 1];
      if (last[0] === at[0] && last[1] === at[1]) return;
      drag.to = p.shift && usePixel.getState().selectKind !== 'lasso' ? square(drag.from, at) : at;
      drag.points.push(at);
      this.updateSelection();
      return;
    } else {
      drag.dx = at[0] - drag.from[0];
      drag.dy = at[1] - drag.from[1];
    }
    this.preview();
  }

  up(): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    if (drag.kind === 'select') return;
    const ui = usePixel.getState();
    const commit = this.command(drag, ui);
    if (!commit) {
      pixelSession.show(null);
      return;
    }
    if (drag.kind === 'stroke') this.lastPoint = drag.points[drag.points.length - 1];
    if (drag.kind === 'move' && ui.selection) this.shiftSelection(drag.dx, drag.dy);
    void pixelSession.commit(commit.id, commit.params);
  }

  cancel(): void {
    if (!this.drag) return;
    this.drag = null;
    pixelSession.show(null);
  }

  // ---------------------------------------------------------------- ops

  /** The command a drag ends with, and its parameters. */
  private command(drag: Drag, ui: PixelUiState): { id: string; params: Record<string, unknown> } | null {
    const selection = selectionParam(ui);
    const frame = this.frame();
    const common = { ...(selection ? { selection } : {}) };
    switch (drag.kind) {
      case 'stroke': {
        const lines = { points: drag.points, ...(drag.breaks.length ? { breaks: drag.breaks } : {}), size: ui.size, shape: ui.shape };
        if (drag.tool === 'copy') {
          const source = ui.copySource!;
          return {
            id: 'paint.copy_brush',
            params: { mode: ui.copyMode, ...lines, ...(drag.offset ? { offset: drag.offset } : { source: source.rect }), opacity: ui.opacity, blend: ui.blend, lockAlpha: ui.lockAlpha, ...common },
          };
        }
        const mirror = mirrorParam(ui);
        return {
          id: 'paint.pixel_stroke',
          params: { ...lines, pixelPerfect: ui.pixelPerfect, ...paintOf(ui, drag.tool === 'eraser' || ui.eraseMode), ...(mirror ? { mirror, frame } : {}), ...common },
        };
      }
      case 'span': {
        if (drag.tool === 'gradient') {
          return { id: 'paint.gradient', params: { from: drag.from, to: drag.to, colors: [ui.primary, ui.secondary], opacity: ui.opacity, blend: ui.blend, lockAlpha: ui.lockAlpha, ...common } };
        }
        const mirror = mirrorParam(ui);
        return {
          id: 'paint.shape',
          params: { shape: ui.shapeKind, from: drag.from, to: drag.to, filled: ui.shapeFilled, lineWidth: ui.lineWidth, ...paintOf(ui, ui.eraseMode), ...(mirror ? { mirror, frame } : {}), ...common },
        };
      }
      case 'move':
        if (drag.dx === 0 && drag.dy === 0) return null;
        return { id: 'paint.move_pixels', params: { selection: drag.selection, dx: drag.dx, dy: drag.dy, copy: drag.copy } };
      default:
        return null;
    }
  }

  /** The op the preview shows: the same the command will build. */
  private preview(): void {
    const drag = this.drag;
    const texture = pixelSession.texture;
    if (!drag || !texture) return;
    const ui = usePixel.getState();
    const cmd = this.command(drag, ui);
    if (!cmd) {
      pixelSession.show(null);
      return;
    }
    const p = cmd.params as Record<string, never>;
    const state = selectDocState(useApp.getState());
    const selection = p.selection as SelectionShape[] | undefined;
    const mirror = p.mirror ? pixelMirror(state, texture, p.mirror, p.frame) : undefined;
    const paint = { color: p.color, opacity: p.opacity, blend: p.blend, lockAlpha: p.lockAlpha, erase: p.erase } as PixelPaint;
    let op: PixelOp;
    switch (cmd.id) {
      case 'paint.pixel_stroke':
        op = { op: 'stroke', points: p.points, breaks: p.breaks, brush: { size: p.size, shape: p.shape }, pixelPerfect: p.pixelPerfect, paint, mirror, selection };
        break;
      case 'paint.copy_brush':
        op = { op: 'copy_brush', mode: p.mode, points: p.points, breaks: p.breaks, brush: { size: p.size, shape: p.shape }, offset: p.offset, source: p.source, paint, selection };
        break;
      case 'paint.shape':
        op = { op: 'shape', shape: p.shape, from: p.from, to: p.to, filled: p.filled, lineWidth: p.lineWidth, paint, mirror, selection };
        break;
      case 'paint.gradient':
        op = { op: 'gradient', from: p.from, to: p.to, colors: p.colors, paint, selection };
        break;
      case 'paint.move_pixels':
        op = { op: 'move', selection: p.selection, dx: p.dx, dy: p.dy, copy: p.copy };
        break;
      default:
        return;
    }
    pixelSession.show(op);
  }

  private async fill(p: PixelPointer, at: Px): Promise<void> {
    const ui = usePixel.getState();
    const selection = selectionParam(ui);
    const mirror = mirrorParam(ui);
    const texture = pixelSession.texture;
    if (!texture) return;
    const frame = this.frame();
    const located =
      p.face && (ui.fillMode === 'face' || ui.fillMode === 'element')
        ? { elementId: p.face.elementId, ...(ui.fillMode === 'face' ? { face: p.face.face } : {}) }
        : { x: at[0], y: at[1] };
    await pixelSession.commit('paint.pixel_fill', {
      mode: ui.fillMode,
      ...located,
      tolerance: ui.tolerance,
      ...paintOf(ui, ui.eraseMode),
      ...(mirror ? { mirror } : {}),
      ...(texture.animation ? { frame } : {}),
      ...(selection ? { selection } : {}),
    });
  }

  // ---------------------------------------------------------------- selection

  private applySelection(shape: SelectionShape, mode: SelectMode, base: PixelSelection | null): void {
    const layer = pixelSession.layerPixels;
    const texture = pixelSession.texture;
    if (!layer || !texture) return;
    const { width, height } = texture;
    const shapes: SelectionShape[] = [];
    const prior = base && base.textureId === texture.id && base.width === width && base.height === height ? maskToShape(base.mask, width, height) : null;
    if (mode !== 'replace' && prior) shapes.push(prior);
    shapes.push({ ...shape, mode: mode === 'replace' || !prior ? 'replace' : mode } as SelectionShape);
    const mask = selectionMask(layer, width, height, shapes);
    const any = mask.some((v) => v !== 0);
    usePixel.setState({ selection: any ? { textureId: texture.id, width, height, mask } : null });
  }

  private updateSelection(): void {
    const drag = this.drag;
    if (drag?.kind !== 'select') return;
    const kind = usePixel.getState().selectKind;
    const rect = rectBetween(drag.from, drag.to);
    const shape: SelectionShape =
      kind === 'lasso'
        ? drag.points.length >= 3
          ? { shape: 'lasso', points: drag.points.map(([x, y]) => [x + 0.5, y + 0.5] as const) }
          : { shape: 'rect', ...rect }
        : { shape: kind === 'ellipse' ? 'ellipse' : 'rect', ...rect };
    this.applySelection(shape, drag.mode, drag.base);
  }

  /** After a move the selection follows the pixels. */
  private shiftSelection(dx: number, dy: number): void {
    const sel = usePixel.getState().selection;
    if (!sel) return;
    const mask = new Uint8Array(sel.mask.length);
    for (let y = 0; y < sel.height; y++) {
      const ty = y + dy;
      if (ty < 0 || ty >= sel.height) continue;
      for (let x = 0; x < sel.width; x++) {
        const tx = x + dx;
        if (tx >= 0 && tx < sel.width && sel.mask[y * sel.width + x]) mask[ty * sel.width + tx] = 1;
      }
    }
    usePixel.setState({ selection: mask.some((v) => v) ? { ...sel, mask } : null });
  }

  /** Ctrl+click with the copy brush: where it copies from. */
  private setCopySource(at: Px): void {
    const ui = usePixel.getState();
    const sel = selectionParam(ui)?.[0];
    const half = Math.floor((ui.size - 1) / 2);
    const rect: PixelRect =
      sel && sel.shape === 'mask' ? { x: sel.x, y: sel.y, width: sel.width, height: sel.height } : { x: at[0] - half, y: at[1] - half, width: ui.size, height: ui.size };
    usePixel.setState({ copySource: { at, rect } });
  }
}

export const pixelTools = new PixelToolController();

/** Selects everything / nothing (Ctrl+A, Ctrl+D). */
export function selectAll(): void {
  const texture = pixelSession.texture;
  if (!texture) return;
  usePixel.setState({ selection: { textureId: texture.id, width: texture.width, height: texture.height, mask: new Uint8Array(texture.width * texture.height).fill(1) } });
}

export function selectNone(): void {
  usePixel.setState({ selection: null });
}

/** The pixel rectangle of the shown frame of the texture (the whole texture when it is not animated). */
export function frameRect(): PixelRect | null {
  const texture = pixelSession.texture;
  if (!texture) return null;
  const h = frameHeight(texture);
  return { x: 0, y: shownFrame(texture) * h, width: texture.width, height: h };
}
