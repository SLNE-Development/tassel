import { Menu } from '@base-ui/react/menu';
import { ArrowLeftRight, FolderOpen, Plus, RotateCcw, Save } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { hexToRgb, hsvToRgb, rgbToHex, rgbToHsv } from '../../imaging/pixelArt';
import { useT } from '../../i18n';
import { formatCombo } from '../actions';
import { itemClass, popupClass } from '../menu';
import { ScrubField } from '../ScrubField';
import { Tip } from '../Tip';
import { notifyError, notifySuccess } from '../toast';
import { paletteExtension, paletteFormats, parsePalette, serializePalette, type PaletteFormat } from './palette';
import { defaultPalette, setPalette, setPrimary, swapColors, usePixel } from './pixelStore';

const iconButton = 'flex size-6 shrink-0 items-center justify-center rounded text-dim hover:bg-raised hover:text-text disabled:pointer-events-none disabled:text-faint/50';
const sectionTitle = 'text-[calc(12px*var(--font-scale))] font-semibold text-dim';

type Hsv = readonly [h: number, s: number, v: number];
type Which = 'primary' | 'secondary';

const hsvOf = (hex: string): Hsv => rgbToHsv(...hexToRgb(hex));
const hexOf = ([h, s, v]: Hsv): string => rgbToHex(...hsvToRgb(h, s, v));
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** "#abc", "abc", "#aabbcc" or "aabbcc" as lower-case #rrggbb; null for anything else. */
function parseHex(text: string): string | null {
  const hex = text.trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{6}$/.test(hex)) return `#${hex}`;
  if (/^[0-9a-f]{3}$/.test(hex)) return `#${[...hex].map((c) => c + c).join('')}`;
  return null;
}

/** Pointer position inside an element as 0..1 on both axes; the pointer stays captured while dragging. */
function useDrag(onMove: (x: number, y: number) => void) {
  const move = (e: PointerEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    onMove(clamp01((e.clientX - rect.left) / rect.width), clamp01((e.clientY - rect.top) / rect.height));
  };
  return {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      move(e);
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) move(e);
    },
  };
}

function Picker({ hsv, onChange }: { hsv: Hsv; onChange(hsv: Hsv): void }) {
  const t = useT().pixel.panel;
  const [h, s, v] = hsv;
  const plane = useDrag((x, y) => onChange([h, x, 1 - y]));
  const strip = useDrag((x) => onChange([x * 360, s, v]));
  const step = (e: KeyboardEvent, change: (d: number) => void) => {
    const d = e.shiftKey ? 0.1 : 0.01;
    const delta = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, d], ArrowDown: [0, -d] }[e.key];
    if (!delta) return;
    e.preventDefault();
    change(delta[0] || delta[1]);
  };
  return (
    <div className="flex flex-col gap-2">
      <div
        role="application"
        aria-label={t.colorPlane}
        tabIndex={0}
        className="relative h-28 w-full cursor-crosshair touch-none overflow-hidden rounded-md ring-1 ring-line-strong ring-inset focus-visible:ring-accent"
        style={{
          backgroundColor: hexOf([h, 1, 1]),
          backgroundImage: 'linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent)',
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') step(e, (d) => onChange([h, clamp01(s + d), v]));
          else step(e, (d) => onChange([h, s, clamp01(v + d)]));
        }}
        {...plane}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-white drop-shadow-[0_0_1px_rgb(0_0_0/0.8)]"
          style={{ left: `${s * 100}%`, top: `${(1 - v) * 100}%` }}
        />
      </div>
      <div
        role="slider"
        aria-label={t.hue}
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(h)}
        tabIndex={0}
        className="relative h-3.5 w-full cursor-ew-resize touch-none rounded-md ring-1 ring-line-strong ring-inset focus-visible:ring-accent"
        style={{ backgroundImage: 'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)' }}
        onKeyDown={(e) => step(e, (d) => onChange([Math.min(360, Math.max(0, h + d * 100)), s, v]))}
        {...strip}
      >
        <span aria-hidden className="pointer-events-none absolute top-0 h-full w-1 -translate-x-1/2 rounded-sm bg-white ring-1 ring-black/70" style={{ left: `${(h / 360) * 100}%` }} />
      </div>
    </div>
  );
}

function HexInput({ value, onCommit }: { value: string; onCommit(hex: string): void }) {
  const t = useT().pixel.panel;
  const [text, setText] = useState<string | null>(null);
  const reverting = useRef(false);
  const commit = () => {
    const next = reverting.current || text === null ? null : parseHex(text);
    reverting.current = false;
    setText(null);
    if (next && next !== value) onCommit(next);
  };
  return (
    <input
      aria-label={t.hex}
      spellCheck={false}
      autoComplete="off"
      maxLength={7}
      className="tnum h-7 w-full min-w-0 rounded-md bg-ink px-2 text-[calc(12.5px*var(--font-scale))] text-text ring-1 ring-line outline-none ring-inset hover:ring-line-strong focus:ring-accent"
      value={text ?? value}
      onChange={(e) => setText(e.currentTarget.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          reverting.current = true;
          e.currentTarget.blur();
        }
      }}
    />
  );
}

function Swatches({ which, onSelect }: { which: Which; onSelect(which: Which): void }) {
  const primary = usePixel((s) => s.primary);
  const secondary = usePixel((s) => s.secondary);
  const t = useT().pixel.panel;
  const swatch = (id: Which, color: string, label: string, className: string) => (
    <Tip label={`${label} ${color}`}>
      <button
        aria-label={`${label} ${color}`}
        aria-pressed={which === id}
        className={`absolute size-8 rounded-md ring-1 ring-line-strong ring-inset aria-pressed:ring-2 aria-pressed:ring-accent ${className}`}
        style={{ background: color }}
        onClick={() => onSelect(id)}
      />
    </Tip>
  );
  return (
    <div className="flex items-center gap-1">
      <div className="relative size-12 shrink-0">
        {swatch('secondary', secondary, t.secondary, 'right-0 bottom-0')}
        {swatch('primary', primary, t.primary, 'top-0 left-0 z-10')}
      </div>
      <Tip label={t.swapColors} shortcut={formatCombo('X')}>
        <button aria-label={t.swapColors} className={iconButton} onClick={swapColors}>
          <ArrowLeftRight size={14} strokeWidth={1.75} />
        </button>
      </Tip>
    </div>
  );
}

function download(text: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function Palette({ current }: { current: string }) {
  const palette = usePixel((s) => s.palette);
  const primary = usePixel((s) => s.primary);
  const t = useT().pixel.panel;
  const input = useRef<HTMLInputElement>(null);

  const load = async (file: File) => {
    try {
      const { colors } = parsePalette(await file.text());
      setPalette(colors);
      notifySuccess(t.paletteLoaded(colors.length));
    } catch {
      notifyError(new Error(t.paletteUnreadable(file.name)));
    }
  };
  const saveAs = (format: PaletteFormat) => download(serializePalette(palette, format), `palette.${paletteExtension[format]}`);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-0.5">
        <h3 className={`${sectionTitle} flex-1`}>{t.palette}</h3>
        <Tip label={t.addColor}>
          <button aria-label={t.addColor} className={iconButton} disabled={palette.includes(current)} onClick={() => setPalette([...palette, current])}>
            <Plus size={14} strokeWidth={1.75} />
          </button>
        </Tip>
        <Tip label={t.loadPalette}>
          <button aria-label={t.loadPalette} className={iconButton} onClick={() => input.current?.click()}>
            <FolderOpen size={14} strokeWidth={1.75} />
          </button>
        </Tip>
        <Menu.Root>
          <Tip label={t.savePalette}>
            <Menu.Trigger aria-label={t.savePalette} className={iconButton}>
              <Save size={14} strokeWidth={1.75} />
            </Menu.Trigger>
          </Tip>
          <Menu.Portal>
            <Menu.Positioner side="bottom" align="end" sideOffset={4} className="z-50 outline-none">
              <Menu.Popup className={popupClass}>
                {paletteFormats.map((format) => (
                  <Menu.Item key={format} className={itemClass} onClick={() => saveAs(format)}>
                    {t.paletteFormats[format]}
                  </Menu.Item>
                ))}
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
        <Tip label={t.resetPalette}>
          <button aria-label={t.resetPalette} className={iconButton} onClick={() => setPalette(defaultPalette)}>
            <RotateCcw size={14} strokeWidth={1.75} />
          </button>
        </Tip>
        <input
          ref={input}
          type="file"
          hidden
          accept=".gpl,.txt,.hex,.pal,text/plain"
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = '';
            if (file) void load(file);
          }}
        />
      </div>
      <div role="group" aria-label={t.palette} className="flex flex-wrap gap-1">
        {palette.map((color) => (
          <Tip key={color} label={`${color} - ${t.paletteHint}`}>
            <button
              aria-label={t.useColor(color)}
              aria-pressed={color === primary}
              className="size-4.5 rounded-[4px] ring-1 ring-line-strong ring-inset hover:ring-faint aria-pressed:ring-2 aria-pressed:ring-accent"
              style={{ background: color }}
              onClick={(e) => {
                if (e.altKey) setPalette(palette.filter((c) => c !== color));
                else setPrimary(color);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                usePixel.setState({ secondary: color });
              }}
              onKeyDown={(e) => {
                if (e.key === 'Delete') setPalette(palette.filter((c) => c !== color));
              }}
            />
          </Tip>
        ))}
      </div>
    </div>
  );
}

/** Primary and secondary colour, an HSV picker with hex and number fields, and the palette. */
export function ColorPanel() {
  const t = useT().pixel.panel;
  const [which, setWhich] = useState<Which>('primary');
  const color = usePixel((s) => (which === 'primary' ? s.primary : s.secondary));
  // Grey and black have no hue of their own: the picker keeps the one it had, so dragging does not jump.
  const [hsv, setHsv] = useState<Hsv>(() => hsvOf(color));
  useEffect(() => {
    setHsv((prev) => {
      if (hexOf(prev) === color) return prev;
      const next = hsvOf(color);
      return [next[1] === 0 || next[2] === 0 ? prev[0] : next[0], next[1], next[2]];
    });
  }, [color]);

  const apply = (next: Hsv) => {
    setHsv(next);
    const hex = hexOf(next);
    if (which === 'primary') setPrimary(hex);
    else usePixel.setState({ secondary: hex });
  };
  const [h, s, v] = hsv;
  const field = (label: string, name: string, value: number, max: number, change: (n: number) => void) => (
    <ScrubField label={label} ariaLabel={name} color="var(--dim)" value={Math.round(value)} step={max > 100 ? 1 : 0.5} min={0} max={max} integer onCommit={change} onScrub={change} />
  );
  return (
    <section aria-label={t.colors} className="flex flex-col gap-2.5 border-t border-line pt-2.5">
      <div className="flex items-start gap-3">
        <Swatches which={which} onSelect={setWhich} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <HexInput value={color} onCommit={(hex) => apply(hsvOf(hex))} />
          <div className="grid grid-cols-3 gap-1">
            {field('H', t.hue, h, 360, (n) => apply([n, s, v]))}
            {field('S', t.saturation, s * 100, 100, (n) => apply([h, n / 100, v]))}
            {field('V', t.value, v * 100, 100, (n) => apply([h, s, n / 100]))}
          </div>
        </div>
      </div>
      <Picker hsv={hsv} onChange={apply} />
      <Palette current={color} />
    </section>
  );
}
