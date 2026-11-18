import { useT } from '../../i18n';
import { formatCombo, getAction } from '../actions';
import { ColorField, UnitSlider } from '../materialControls';
import { ScrubField } from '../ScrubField';
import { Tip } from '../Tip';
import { dismissHint, greyHex, isScalarSlot, MAX_BRUSH, MIN_BRUSH, setBrushSize, usePaint, usePaintTarget, type PaintUiState } from './paintStore';

// The brush lives in the paint store, not in the document: a change is there at once.
const done = Promise.resolve();
const set = (change: Partial<PaintUiState>) => {
  usePaint.setState(change);
  return done;
};
const noop = () => {};

function Color() {
  const color = usePaint((s) => s.color);
  const recent = usePaint((s) => s.recent);
  const t = useT().paint;
  return (
    <>
      <div className="w-27 shrink-0">
        <ColorField label={t.color} value={color} onCommit={(next) => void set({ color: next })} onScrub={(next) => set({ color: next })} onScrubEnd={noop} />
      </div>
      {recent.length > 0 && (
        <div role="group" aria-label={t.recent} className="hidden shrink-0 items-center gap-1 @[40rem]:flex">
          {recent.map((c) => (
            <Tip key={c} label={c}>
              <button
                aria-label={t.useColor(c)}
                aria-pressed={c === color}
                className="size-4.5 rounded-[5px] ring-1 ring-line-strong ring-inset hover:ring-faint aria-pressed:ring-2 aria-pressed:ring-accent"
                style={{ background: c }}
                onClick={() => void set({ color: c })}
              />
            </Tip>
          ))}
        </div>
      )}
    </>
  );
}

/** Scalar maps hold one value per pixel, so the "colour" is a grey. */
function Value() {
  const value = usePaint((s) => s.value);
  const t = useT().paint;
  return (
    <>
      <span aria-hidden className="size-7 shrink-0 rounded-md ring-1 ring-line-strong ring-inset" style={{ background: greyHex(value) }} />
      <div className="w-28 shrink-0">
        <UnitSlider label={t.value} value={value} onScrub={(next) => set({ value: next })} onScrubEnd={noop} />
      </div>
    </>
  );
}

const Divider = () => <div aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-line-strong" />;

/** The brush options over the viewport: colour (a grey value on scalar maps), size, opacity and hardness. */
export function PaintOptions() {
  const scalar = usePaint((s) => isScalarSlot(s.slot));
  const erasing = usePaint((s) => s.tool === 'eraser');
  const size = usePaint((s) => s.size);
  const opacity = usePaint((s) => s.opacity);
  const hardness = usePaint((s) => s.hardness);
  const t = useT().paint;
  const keys = [getAction('paint.size_down'), getAction('paint.size_up')].map((a) => formatCombo(a.keys![0])).join(' ');
  return (
    <div className="@container pointer-events-none absolute inset-x-2 top-2 flex justify-center">
      <div
        role="toolbar"
        aria-label={t.options}
        className="pointer-events-auto flex max-w-full min-w-0 flex-wrap items-center gap-1.5 rounded-lg border border-line-strong bg-overlay/95 p-1.5 shadow-pop backdrop-blur-sm"
      >
        {/* The eraser takes paint away; its colour does not matter. */}
        <div className={`flex items-center gap-1.5 ${erasing ? 'opacity-40' : ''}`}>{scalar ? <Value /> : <Color />}</div>
        <Divider />
        <Tip label={t.size} shortcut={keys}>
          <div className="w-25 shrink-0">
            <ScrubField
              wide
              label={t.size}
              ariaLabel={t.size}
              color="var(--dim)"
              value={size}
              step={0.5}
              min={MIN_BRUSH}
              max={MAX_BRUSH}
              integer
              onCommit={setBrushSize}
              onScrub={setBrushSize}
            />
          </div>
        </Tip>
        <div className="w-30 shrink-0">
          <UnitSlider label={t.opacity} value={opacity} onScrub={(next) => set({ opacity: next })} onScrubEnd={noop} />
        </div>
        <div className="w-26 shrink-0">
          <UnitSlider label={t.hardness} value={hardness} onScrub={(next) => set({ hardness: next })} onScrubEnd={noop} />
        </div>
      </div>
    </div>
  );
}

/** Shown once: what painting in texture space means for the brush. */
export function PaintHint() {
  const seen = usePaint((s) => s.hintSeen);
  const ready = usePaintTarget().problem === null;
  const t = useT().paint;
  if (seen || !ready) return null;
  return (
    <div className="pointer-events-none absolute inset-x-3 bottom-3 flex justify-center">
      <div role="note" className="anim-pop pointer-events-auto flex max-w-[34rem] items-center gap-3 rounded-lg border border-line-strong bg-overlay/95 py-2 pr-2 pl-3 shadow-pop backdrop-blur-sm">
        <p className="text-[calc(12.5px*var(--font-scale))] leading-snug text-dim">{t.hint}</p>
        <button className="h-7 shrink-0 rounded-md px-2.5 text-[calc(12.5px*var(--font-scale))] text-text ring-1 ring-line-strong ring-inset hover:bg-raised hover:ring-faint" onClick={dismissHint}>
          {t.hintDismiss}
        </button>
      </div>
    </div>
  );
}
