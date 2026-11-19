import { Dialog } from '@base-ui/react/dialog';
import { Menu } from '@base-ui/react/menu';
import { ChevronDown, ImageIcon } from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { create } from 'zustand';
import { selectDocState, useApp } from '../../app/store';
import type { Adjustment, SelectionShape } from '../../core/pixelOps';
import { curveLut } from '../../imaging/pixelArt';
import { useT } from '../../i18n';
import { Segmented } from '../controls';
import { itemClass, popupClass } from '../menu';
import { clearSelectedPixels, clearUnusedSpace, cropToSelection, runPixel, transformTexture } from './pixelActions';
import { pixelSession } from './pixelSession';
import { usePixel, usePixelTexture } from './pixelStore';
import { selectionParam } from './pixelTools';

// The Image menu of pixel painting, and the dialogs of the adjustments that take parameters. Their sliders
// preview in the pixel session (nothing changes in the document); OK commits the one command.

export const imageDialogs = ['brightness_contrast', 'hue_saturation', 'opacity', 'curves', 'resize'] as const;
export type ImageDialog = (typeof imageDialogs)[number];

const useImageDialog = create<{ open: ImageDialog | null }>(() => ({ open: null }));

/** Opens the dialog of an Image menu entry (rendered by ImageMenu). */
export function openImageDialog(dialog: ImageDialog): void {
  useImageDialog.setState({ open: dialog });
}

const closeImageDialog = () => useImageDialog.setState({ open: null });

const buttonBase = 'h-8 rounded-md px-3.5 text-[calc(13px*var(--font-scale))] font-medium';
const quietButton = `${buttonBase} text-dim hover:bg-raised hover:text-text`;
const primaryButton = `${buttonBase} bg-accent text-accent-ink hover:brightness-110 disabled:pointer-events-none disabled:opacity-50`;

// ------------------------------------------------------------------ dialog frame

/** A dialog that leaves the views usable (no backdrop) so the preview can be judged. */
function Frame({ title, children, onOk, onCancel, ok = true }: { title: string; children: ReactNode; onOk(): void; onCancel(): void; ok?: boolean }) {
  const t = useT().pixel.panel;
  return (
    <Dialog.Root open modal={false} onOpenChange={(open) => !open && onCancel()}>
      <Dialog.Portal>
        <Dialog.Popup
          className="anim-pop fixed top-20 right-[22rem] z-50 flex w-[min(21rem,calc(100vw-2rem))] flex-col gap-3 rounded-xl border border-line-strong bg-overlay p-4 shadow-pop outline-none"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.target instanceof HTMLElement && e.target.tagName !== 'BUTTON') onOk();
          }}
        >
          <Dialog.Title className="font-display text-[calc(14px*var(--font-scale))] font-semibold text-text">{title}</Dialog.Title>
          {children}
          <div className="mt-1 flex justify-end gap-2">
            <button className={quietButton} onClick={onCancel}>
              {t.cancel}
            </button>
            <button className={primaryButton} disabled={!ok} onClick={onOk}>
              {t.ok}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function RangeRow({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange(value: number): void }) {
  const t = useT();
  return (
    <label className="grid grid-cols-[5.5rem_minmax(0,1fr)_3rem] items-center gap-2 text-[calc(12.5px*var(--font-scale))] text-dim">
      <span className="truncate">{label}</span>
      <input type="range" aria-label={label} className="min-w-0 accent-[var(--accent)]" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.currentTarget.value))} />
      <span className="tnum text-right text-text">{value.toLocaleString(t.locale, { maximumFractionDigits: 2 })}</span>
    </label>
  );
}

// ------------------------------------------------------------------ adjustments with a preview

/**
 * Shows `adjust` on the painted layer while the dialog is open. OK commits it as one `paint.adjust`; closing
 * any other way takes the preview away again.
 */
function AdjustFrame({ title, adjust, children }: { title: string; adjust: Adjustment; children: ReactNode }) {
  const t = useT().pixel.panel;
  // The selection when the dialog opened: what the preview and the command both work on.
  const [selection] = useState<SelectionShape[] | undefined>(() => selectionParam());
  const committed = useRef(false);
  const [busy, setBusy] = useState(false);

  // `adjust` is a new object on every render; its content decides when the preview is made again.
  const content = JSON.stringify(adjust);
  useEffect(() => {
    pixelSession.show({ op: 'adjust', adjust: JSON.parse(content) as Adjustment, selection });
  }, [content, selection]);
  useEffect(
    () => () => {
      if (!committed.current) pixelSession.show(null);
    },
    [],
  );

  const ok = async () => {
    if (busy) return;
    setBusy(true);
    committed.current = true;
    try {
      await pixelSession.commit('paint.adjust', { adjust, selection });
    } finally {
      closeImageDialog();
    }
  };
  return (
    <Frame title={title} ok={!busy} onOk={() => void ok()} onCancel={closeImageDialog}>
      {selection && <p className="text-[calc(12px*var(--font-scale))] text-faint">{t.onSelection}</p>}
      {children}
    </Frame>
  );
}

function BrightnessContrast() {
  const t = useT().pixel.panel;
  const [v, setV] = useState({ brightness: 0, contrast: 0 });
  return (
    <AdjustFrame title={t.brightnessContrast.replace('…', '')} adjust={{ type: 'brightness_contrast', ...v }}>
      <RangeRow label={t.brightness} value={v.brightness} min={-1} max={1} step={0.01} onChange={(brightness) => setV({ ...v, brightness })} />
      <RangeRow label={t.contrast} value={v.contrast} min={-1} max={1} step={0.01} onChange={(contrast) => setV({ ...v, contrast })} />
    </AdjustFrame>
  );
}

function HueSaturation() {
  const t = useT().pixel.panel;
  const [v, setV] = useState({ hue: 0, saturation: 0, lightness: 0 });
  return (
    <AdjustFrame title={t.hueSaturation.replace('…', '')} adjust={{ type: 'hue_saturation', ...v }}>
      <RangeRow label={t.hueShift} value={v.hue} min={-180} max={180} step={1} onChange={(hue) => setV({ ...v, hue })} />
      <RangeRow label={t.saturation} value={v.saturation} min={-1} max={1} step={0.01} onChange={(saturation) => setV({ ...v, saturation })} />
      <RangeRow label={t.lightness} value={v.lightness} min={-1} max={1} step={0.01} onChange={(lightness) => setV({ ...v, lightness })} />
    </AdjustFrame>
  );
}

function OpacityAdjust() {
  const t = useT().pixel.panel;
  const [factor, setFactor] = useState(1);
  return (
    <AdjustFrame title={t.opacityAdjust.replace('…', '')} adjust={{ type: 'opacity', factor }}>
      <RangeRow label={t.opacityFactor} value={factor} min={0} max={4} step={0.05} onChange={setFactor} />
    </AdjustFrame>
  );
}

// ------------------------------------------------------------------ curves

type Point = [number, number];
const curveChannels = ['rgb', 'r', 'g', 'b', 'a'] as const;
type CurveChannel = (typeof curveChannels)[number];
type Curves = Record<CurveChannel, Point[]>;

const identity = (): Point[] => [
  [0, 0],
  [1, 1],
];
const isIdentity = (points: Point[]) => points.length === 2 && points[0][0] === 0 && points[0][1] === 0 && points[1][0] === 1 && points[1][1] === 1;

const MIN_GAP = 0.02;
const MAX_POINTS = 32;
const SIZE = 220;
const PAD = 8;
const channelColor: Record<CurveChannel, string> = { rgb: 'var(--text)', r: '#e5484d', g: '#46a758', b: '#3e63dd', a: 'var(--dim)' };

function CurveEditor({ points, channel, onChange }: { points: Point[]; channel: CurveChannel; onChange(points: Point[]): void }) {
  const t = useT().pixel.panel;
  const drag = useRef<number | null>(null);
  const inner = SIZE - PAD * 2;
  const toPx = ([x, y]: Point): Point => [PAD + x * inner, PAD + (1 - y) * inner];
  const at = (e: PointerEvent<SVGSVGElement>): Point => {
    const rect = e.currentTarget.getBoundingClientRect();
    const scale = SIZE / rect.width;
    const clamp = (n: number) => Math.min(1, Math.max(0, n));
    return [clamp(((e.clientX - rect.left) * scale - PAD) / inner), clamp(1 - ((e.clientY - rect.top) * scale - PAD) / inner)];
  };
  const nearest = (p: Point): number => {
    const [px, py] = toPx(p);
    let best = -1;
    let bestDistance = 12 ** 2;
    points.forEach((q, i) => {
      const [qx, qy] = toPx(q);
      const d = (qx - px) ** 2 + (qy - py) ** 2;
      if (d <= bestDistance) {
        best = i;
        bestDistance = d;
      }
    });
    return best;
  };
  const move = (index: number, [x, y]: Point) => {
    const next = points.map((p) => [...p] as Point);
    const last = next.length - 1;
    // The ends keep their place along the axis; the points in between stay between their neighbours.
    next[index] = [index === 0 || index === last ? points[index][0] : Math.min(next[index + 1][0] - MIN_GAP, Math.max(next[index - 1][0] + MIN_GAP, x)), y];
    onChange(next);
  };
  const lut = curveLut(points);
  const line = Array.from(lut, (v, i) => toPx([i / 255, v / 255]).map((n) => n.toFixed(1)).join(',')).join(' ');
  return (
    <svg
      role="application"
      aria-label={t.curveEditor}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      className="aspect-square w-full touch-none rounded-md bg-ink ring-1 ring-line-strong ring-inset"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const p = at(e);
        let index = nearest(p);
        if (index < 0) {
          if (points.length >= MAX_POINTS) return;
          // A new point goes between its neighbours, at least a gap away from each.
          const after = points.findIndex((q) => q[0] > p[0]);
          if (after <= 0 || p[0] - points[after - 1][0] < MIN_GAP || points[after][0] - p[0] < MIN_GAP) return;
          onChange([...points.slice(0, after), p, ...points.slice(after)]);
          index = after;
        }
        drag.current = index;
        e.currentTarget.setPointerCapture(e.pointerId);
        if (index >= 0) move(index, p);
      }}
      onPointerMove={(e) => {
        if (drag.current !== null && e.currentTarget.hasPointerCapture(e.pointerId)) move(drag.current, at(e));
      }}
      onPointerUp={() => (drag.current = null)}
      onDoubleClick={(e) => {
        const index = nearest(at(e as unknown as PointerEvent<SVGSVGElement>));
        if (index > 0 && index < points.length - 1) onChange(points.filter((_, i) => i !== index));
      }}
    >
      {[0.25, 0.5, 0.75].map((g) => (
        <g key={g} stroke="var(--line)" strokeWidth={1}>
          <line x1={PAD + g * inner} y1={PAD} x2={PAD + g * inner} y2={SIZE - PAD} />
          <line x1={PAD} y1={PAD + g * inner} x2={SIZE - PAD} y2={PAD + g * inner} />
        </g>
      ))}
      <line x1={PAD} y1={SIZE - PAD} x2={SIZE - PAD} y2={PAD} stroke="var(--line-strong)" strokeDasharray="3 3" />
      <polyline points={line} fill="none" stroke={channelColor[channel]} strokeWidth={1.75} />
      {points.map((p, i) => {
        const [cx, cy] = toPx(p);
        return <circle key={i} cx={cx} cy={cy} r={4.5} fill="var(--overlay)" stroke={channelColor[channel]} strokeWidth={1.75} />;
      })}
    </svg>
  );
}

function CurvesDialog() {
  const t = useT().pixel.panel;
  const [channel, setChannel] = useState<CurveChannel>('rgb');
  const [curves, setCurves] = useState<Curves>(() => ({ rgb: identity(), r: identity(), g: identity(), b: identity(), a: identity() }));
  const adjust: Adjustment = { type: 'curves', ...Object.fromEntries(curveChannels.filter((c) => !isIdentity(curves[c])).map((c) => [c, curves[c]])) };
  return (
    <AdjustFrame title={t.curves.replace('…', '')} adjust={adjust}>
      <Segmented<CurveChannel> label={t.channel} value={channel} options={curveChannels.map((value) => ({ value, title: t.channels[value] }))} onChange={setChannel} />
      <CurveEditor points={curves[channel]} channel={channel} onChange={(points) => setCurves({ ...curves, [channel]: points })} />
      <div className="flex items-center justify-between gap-2">
        <p className="text-[calc(12px*var(--font-scale))] leading-snug text-faint">{t.curveHint}</p>
        <button className={`${quietButton} h-7 shrink-0 px-2 text-[calc(12.5px*var(--font-scale))]`} onClick={() => setCurves({ ...curves, [channel]: identity() })}>
          {t.resetCurve}
        </button>
      </div>
    </AdjustFrame>
  );
}

// ------------------------------------------------------------------ resize

function NumberBox({ label, value, onChange }: { label: string; value: number; onChange(value: number): void }) {
  return (
    <label className="flex flex-col gap-1 text-[calc(12px*var(--font-scale))] text-dim">
      {label}
      <input
        type="number"
        min={1}
        max={8192}
        className="tnum h-8 w-full min-w-0 rounded-md bg-ink px-2 text-[calc(13px*var(--font-scale))] text-text ring-1 ring-line outline-none ring-inset focus:ring-accent"
        value={value}
        onChange={(e) => onChange(Math.round(Number(e.currentTarget.value)))}
      />
    </label>
  );
}

function ResizeDialog() {
  const t = useT().pixel.panel;
  const texture = usePixelTexture();
  const [size, setSize] = useState({ width: texture?.width ?? 16, height: texture?.height ?? 16 });
  const [mode, setMode] = useState<'canvas' | 'scale'>('scale');
  const valid = Number.isInteger(size.width) && Number.isInteger(size.height) && size.width >= 1 && size.height >= 1 && size.width <= 8192 && size.height <= 8192;
  return (
    <Frame
      title={t.resizeTexture.replace('…', '')}
      ok={valid}
      onCancel={closeImageDialog}
      onOk={() => {
        closeImageDialog();
        void transformTexture({ op: 'resize', ...size, mode });
      }}
    >
      <div className="grid grid-cols-2 gap-2">
        <NumberBox label={t.width} value={size.width} onChange={(width) => setSize({ ...size, width })} />
        <NumberBox label={t.height} value={size.height} onChange={(height) => setSize({ ...size, height })} />
      </div>
      <Segmented<'canvas' | 'scale'> label={t.resizeMode} value={mode} options={(['scale', 'canvas'] as const).map((value) => ({ value, title: t.resizeModes[value] }))} onChange={setMode} />
    </Frame>
  );
}

/** Renders the open Image menu dialog (ImageMenu includes it). */
export function ImageDialogHost() {
  const open = useImageDialog((s) => s.open);
  // A dialog belongs to the texture it was opened on, and to the paint workspace.
  const paint = useApp((s) => s.workspace === 'paint' && selectDocState(s).format === 'minecraft_java');
  const textureId = usePixelTexture()?.id;
  useEffect(() => {
    if (open && (!paint || !textureId)) closeImageDialog();
  }, [open, paint, textureId]);
  if (!open || !paint) return null;
  switch (open) {
    case 'brightness_contrast':
      return <BrightnessContrast key={textureId} />;
    case 'hue_saturation':
      return <HueSaturation key={textureId} />;
    case 'opacity':
      return <OpacityAdjust key={textureId} />;
    case 'curves':
      return <CurvesDialog key={textureId} />;
    case 'resize':
      return <ResizeDialog key={textureId} />;
  }
}

// ------------------------------------------------------------------ the menu

/** Commits an adjustment without a dialog (it has no parameters). */
const commitAdjust = (adjust: Adjustment) => runPixel(() => pixelSession.commit('paint.adjust', { adjust, selection: selectionParam() }));

/** The Image menu button: adjustments, flips and rotations, resizing, cropping, clearing. */
export function ImageMenu() {
  const t = useT().pixel.panel;
  const palette = usePixel((s) => s.palette);
  const hasTexture = usePixelTexture() !== undefined;
  const item = (label: string, run: () => unknown, extra?: { disabled?: boolean }) => (
    <Menu.Item key={label} className={itemClass} disabled={!hasTexture || extra?.disabled} onClick={() => void run()}>
      {label}
    </Menu.Item>
  );
  const separator = (key: string) => <Menu.Separator key={key} className="my-1 h-px bg-line" />;
  return (
    <>
      <Menu.Root>
        <Menu.Trigger
          aria-label={t.imageMenu}
          className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[calc(12.5px*var(--font-scale))] text-text ring-1 ring-line-strong ring-inset hover:bg-raised hover:ring-faint data-[popup-open]:ring-accent"
        >
          <ImageIcon size={14} strokeWidth={1.75} />
          {t.image}
          <ChevronDown size={12} className="text-faint" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="end" sideOffset={4} className="z-50 outline-none">
            <Menu.Popup className={`${popupClass} min-w-64`}>
              {item(t.brightnessContrast, () => openImageDialog('brightness_contrast'))}
              {item(t.hueSaturation, () => openImageDialog('hue_saturation'))}
              {item(t.opacityAdjust, () => openImageDialog('opacity'))}
              {item(t.curves, () => openImageDialog('curves'))}
              {item(t.invert, () => commitAdjust({ type: 'invert' }))}
              {item(t.limitPalette, () => commitAdjust({ type: 'limit_palette', colors: palette }), { disabled: palette.length === 0 })}
              {separator('a')}
              {item(t.flipH, () => transformTexture({ op: 'flip', axis: 'x' }))}
              {item(t.flipV, () => transformTexture({ op: 'flip', axis: 'y' }))}
              {item(t.rotateCw, () => transformTexture({ op: 'rotate', direction: 'cw' }))}
              {item(t.rotateCcw, () => transformTexture({ op: 'rotate', direction: 'ccw' }))}
              {separator('b')}
              {item(t.resizeTexture, () => openImageDialog('resize'))}
              {item(t.cropToSelection, cropToSelection)}
              {separator('c')}
              {item(t.clearUnused, clearUnusedSpace)}
              {item(t.clearSelection, clearSelectedPixels)}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <ImageDialogHost />
    </>
  );
}
