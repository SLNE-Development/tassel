// Drawing of the timeline: the ruler and the key rows, on canvases. Only what is in view is looked at -
// per row and channel a binary search for the visible frames, and at most one mark per pixel column - so
// a document with 200,000 keys draws as fast as one with twenty.
import { lowerBound } from '../../core/playhead';

type Frames = readonly { readonly frame: number }[];

export interface Row {
  id: string;
  label: string;
  /** The key lists of the row (the channels of an object, or the camera keys). */
  lists: readonly Frames[];
}

export const ROW_HEIGHT = 22;
export const RULER_HEIGHT = 24;
/** Room left and right of the first and last frame, so that their keys are not cut off. */
export const PAD = 14;

export interface Scale {
  /** First and last frame in view (fractional). */
  start: number;
  end: number;
  /** CSS pixels. */
  width: number;
}

export const frameX = (scale: Scale, frame: number) => PAD + ((frame - scale.start) / (scale.end - scale.start)) * (scale.width - 2 * PAD);
export const xFrame = (scale: Scale, x: number) => scale.start + ((x - PAD) / (scale.width - 2 * PAD)) * (scale.end - scale.start);

export interface Palette {
  ink: string;
  panel: string;
  raised: string;
  line: string;
  lineStrong: string;
  text: string;
  dim: string;
  faint: string;
  accent: string;
  accentInk: string;
  font: string;
}

/** The colours of the current theme, from the design tokens. */
export function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string) => css.getPropertyValue(name).trim();
  return {
    ink: token('--ink'),
    panel: token('--panel'),
    raised: token('--raised'),
    line: token('--line'),
    lineStrong: token('--line-strong'),
    text: token('--text'),
    dim: token('--dim'),
    faint: token('--faint'),
    accent: token('--accent'),
    accentInk: token('--accent-ink'),
    font: getComputedStyle(document.body).fontFamily,
  };
}

/** Sizes the canvas for the display's pixel density and returns a context that draws in CSS pixels. */
export function prepare(canvas: HTMLCanvasElement, width: number, height: number): CanvasRenderingContext2D | null {
  const ratio = Math.min(window.devicePixelRatio || 1, 3);
  const w = Math.max(1, Math.round(width * ratio));
  const h = Math.max(1, Math.round(height * ratio));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  return context;
}

/** Distance in frames between labelled ticks so that labels are at least `minPixels` apart. */
export function tickStep(framesPerPixel: number, minPixels: number): number {
  const wanted = framesPerPixel * minPixels;
  let step = 1;
  for (;;) {
    for (const factor of [1, 2, 5]) {
      if (step * factor >= wanted) return step * factor;
    }
    step *= 10;
  }
}

/** Shades what lies before frame 0 and after the last frame of the animation. */
function shadeOutside(context: CanvasRenderingContext2D, scale: Scale, height: number, frameCount: number, palette: Palette): void {
  context.fillStyle = palette.ink;
  context.globalAlpha = 0.55;
  const from = frameX(scale, 0) - PAD / 2;
  const to = frameX(scale, frameCount - 1) + PAD / 2;
  if (from > 0) context.fillRect(0, 0, from, height);
  if (to < scale.width) context.fillRect(to, 0, scale.width - to, height);
  context.globalAlpha = 1;
}

export function drawRuler(canvas: HTMLCanvasElement, scale: Scale, frameCount: number, playhead: number, fontScale: number, palette: Palette): void {
  const context = prepare(canvas, scale.width, RULER_HEIGHT);
  if (!context) return;
  const height = RULER_HEIGHT;
  const perPixel = (scale.end - scale.start) / (scale.width - 2 * PAD);
  const step = tickStep(perPixel, 58 * fontScale);
  const minor = step % 5 === 0 ? step / 5 : step % 2 === 0 ? step / 2 : 0;
  const first = Math.max(0, Math.floor(xFrame(scale, 0)));
  const last = Math.ceil(xFrame(scale, scale.width));

  context.lineWidth = 1;
  if (minor > 0 && minor / perPixel >= 4) {
    context.strokeStyle = palette.lineStrong;
    context.beginPath();
    for (let f = Math.ceil(first / minor) * minor; f <= last; f += minor) {
      const x = Math.round(frameX(scale, f)) + 0.5;
      context.moveTo(x, height - 5);
      context.lineTo(x, height);
    }
    context.stroke();
  }
  context.strokeStyle = palette.faint;
  context.fillStyle = palette.dim;
  context.font = `${11.5 * fontScale}px ${palette.font}`;
  context.textBaseline = 'middle';
  context.beginPath();
  for (let f = Math.ceil(first / step) * step; f <= last; f += step) {
    const x = Math.round(frameX(scale, f)) + 0.5;
    context.moveTo(x, height - 9);
    context.lineTo(x, height);
    context.fillText(String(f), x + 4, height / 2 - 1);
  }
  context.stroke();
  shadeOutside(context, scale, height, frameCount, palette);

  // The playhead: a brass flag with the frame number.
  const x = Math.round(frameX(scale, playhead)) + 0.5;
  const text = String(playhead);
  context.font = `600 ${11.5 * fontScale}px ${palette.font}`;
  const flag = Math.ceil(context.measureText(text).width) + 10;
  const left = Math.min(Math.max(x - flag / 2, 0), scale.width - flag);
  context.fillStyle = palette.accent;
  context.beginPath();
  context.roundRect(left, 2, flag, height - 7, 3);
  context.fill();
  context.fillRect(x - 0.5, height - 6, 1, 6);
  context.fillStyle = palette.accentInk;
  context.textAlign = 'center';
  context.fillText(text, left + flag / 2, (height - 5) / 2 + 0.5);
  context.textAlign = 'left';
}

function diamond(context: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  context.moveTo(x, y - r);
  context.lineTo(x + r, y);
  context.lineTo(x, y + r);
  context.lineTo(x - r, y);
  context.closePath();
}

// Scratch: which pixel columns of the row being drawn hold a key.
let marks = new Uint8Array(0);

/** Marks the pixel columns that hold a key of the list (within the frames in view). */
function mark(keys: Frames, scale: Scale): void {
  const width = marks.length;
  const from = Math.floor(xFrame(scale, -6));
  const to = Math.ceil(xFrame(scale, scale.width + 6));
  const i0 = lowerBound(keys, from);
  const i1 = lowerBound(keys, to + 1);
  if (i1 - i0 <= width * 2) {
    for (let i = i0; i < i1; i++) {
      const x = Math.round(frameX(scale, keys[i].frame));
      if (x >= 0 && x < width) marks[x] = 1;
    }
    return;
  }
  // More keys than pixels: ask per pixel column whether a key falls into it.
  for (let x = 0; x < width; x++) {
    const i = lowerBound(keys, Math.ceil(xFrame(scale, x - 0.5)));
    if (i < i1 && keys[i].frame < xFrame(scale, x + 0.5)) marks[x] = 1;
  }
}

export interface RowsView {
  rows: readonly Row[];
  /** Vertical scroll offset and height of the visible part, CSS pixels. */
  scrollTop: number;
  height: number;
  frameCount: number;
  playhead: number;
  selected: { row: string; frame: number } | null;
  /** A key being dragged: drawn at `to` instead of `from`. */
  drag: { row: string; from: number; to: number } | null;
}

export function drawRows(canvas: HTMLCanvasElement, scale: Scale, view: RowsView, palette: Palette): void {
  const context = prepare(canvas, scale.width, view.height);
  if (!context) return;
  const width = Math.max(1, Math.round(scale.width));
  if (marks.length !== width) marks = new Uint8Array(width);
  const first = Math.max(0, Math.floor(view.scrollTop / ROW_HEIGHT));
  const last = Math.min(view.rows.length - 1, Math.floor((view.scrollTop + view.height) / ROW_HEIGHT));
  const radius = 4;

  for (let r = first; r <= last; r++) {
    const row = view.rows[r];
    const top = r * ROW_HEIGHT - view.scrollTop;
    const y = top + ROW_HEIGHT / 2;
    context.fillStyle = palette.line;
    context.fillRect(0, Math.round(top + ROW_HEIGHT) - 1, scale.width, 1);

    marks.fill(0);
    for (const keys of row.lists) mark(keys, scale);
    // Keys closer than a marker's width run together into a bar; a key on its own is a diamond.
    context.fillStyle = palette.dim;
    context.beginPath();
    let runStart = -1;
    let runEnd = -1;
    const flush = () => {
      if (runStart < 0) return;
      if (runEnd - runStart < 2) diamond(context, (runStart + runEnd) / 2 + 0.5, y, radius);
      else {
        context.rect(runStart + 0.5, y - 1.5, runEnd - runStart, 3);
        diamond(context, runStart + 0.5, y, radius);
        diamond(context, runEnd + 0.5, y, radius);
      }
      runStart = -1;
    };
    for (let x = 0; x < width; x++) {
      if (!marks[x]) continue;
      if (runStart >= 0 && x - runEnd > radius + 2) flush();
      if (runStart < 0) runStart = x;
      runEnd = x;
    }
    flush();
    context.fill();

    // The picked key, and a key on its way to another frame.
    const drag = view.drag?.row === row.id ? view.drag : null;
    const picked = drag ? drag.to : view.selected?.row === row.id ? view.selected.frame : null;
    if (drag) {
      context.fillStyle = palette.panel;
      context.beginPath();
      diamond(context, Math.round(frameX(scale, drag.from)) + 0.5, y, radius + 0.5);
      context.fill();
      context.strokeStyle = palette.faint;
      context.lineWidth = 1;
      context.stroke();
    }
    if (picked !== null) {
      const x = Math.round(frameX(scale, picked)) + 0.5;
      context.fillStyle = palette.accent;
      context.beginPath();
      diamond(context, x, y, radius + 1.5);
      context.fill();
      context.strokeStyle = palette.panel;
      context.lineWidth = 1;
      context.stroke();
    }
  }

  shadeOutside(context, scale, view.height, view.frameCount, palette);
  context.fillStyle = palette.accent;
  context.fillRect(Math.round(frameX(scale, view.playhead)), 0, 1, view.height);
}

/** The key of a row nearest to `x`, if one is within `tolerance` pixels. */
export function keyNear(row: Row, scale: Scale, x: number, tolerance: number): number | null {
  const frame = xFrame(scale, x);
  let best: number | null = null;
  let distance = tolerance;
  for (const keys of row.lists) {
    const i = lowerBound(keys, Math.round(frame));
    for (const j of [i - 1, i, i + 1]) {
      const key = keys[j];
      if (!key) continue;
      const d = Math.abs(frameX(scale, key.frame) - x);
      if (d <= distance) {
        distance = d;
        best = key.frame;
      }
    }
  }
  return best;
}
