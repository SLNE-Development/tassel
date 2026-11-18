import { useRef, useState, type PointerEvent } from 'react';

function format(value: number): string {
  // Three decimals, or six for tiny values such as a merge distance of 0.0001.
  const scale = value !== 0 && Math.abs(value) < 0.001 ? 1e6 : 1e3;
  // Avoid "-0" and float noise like 0.30000000000000004.
  return (Math.round(value * scale) / scale + 0).toLocaleString('de-DE', { maximumFractionDigits: 6, useGrouping: false });
}

/** Accepts both "1,5" and "1.5". Returns null for anything that is not a finite number. */
function parse(text: string): number | null {
  const trimmed = text.trim().replace(',', '.');
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/**
 * Numeric field. Typing commits on Enter or blur, Escape reverts. Dragging the label scrubs the
 * value (Shift = fine). With `onScrub` every change is reported while dragging, and the owner is
 * responsible for collapsing them into one undo step; without it the scrub commits once on release.
 */
export function ScrubField({
  label,
  ariaLabel,
  color,
  value,
  step,
  min = -Infinity,
  max = Infinity,
  integer = false,
  wide = false,
  onCommit,
  onScrub,
  onScrubEnd,
}: {
  label: string;
  ariaLabel: string;
  /** CSS colour of the label. */
  color: string;
  value: number;
  /** Value change per pixel while scrubbing; an arrow-key press changes it by ten steps. */
  step: number;
  min?: number;
  max?: number;
  integer?: boolean;
  /** The label is a word (a parameter name) instead of a single axis letter. */
  wide?: boolean;
  onCommit(value: number): void;
  /** Live value while scrubbing. */
  onScrub?(value: number): void;
  onScrubEnd?(): void;
}) {
  // `draft` is the text while editing or scrubbing; null shows the committed value.
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const reverting = useRef(false);
  const scrub = useRef<{ x: number; start: number; current: number; moved: boolean } | null>(null);

  // A scrub ends with a click on the label, which would focus the field and swallow the next shortcut (undo!).
  const scrubbed = useRef(false);

  const fit = (v: number) => Math.min(max, Math.max(min, integer ? Math.round(v) : v));

  const commit = (text: string | null) => {
    setDraft(null);
    if (text === null) return;
    const parsed = parse(text);
    if (parsed === null) return;
    const next = fit(parsed);
    if (next !== value) onCommit(next);
  };

  const onPointerDown = (e: PointerEvent<HTMLSpanElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    scrub.current = { x: e.clientX, start: value, current: value, moved: false };
  };

  const onPointerMove = (e: PointerEvent<HTMLSpanElement>) => {
    const s = scrub.current;
    if (!s) return;
    const dx = e.clientX - s.x;
    if (!s.moved && Math.abs(dx) < 3) return;
    s.moved = true;
    const next = fit(s.start + dx * step * (e.shiftKey ? 0.1 : 1));
    if (next === s.current) return;
    s.current = next;
    setDraft(format(next));
    onScrub?.(next);
  };

  const onPointerUp = () => {
    const s = scrub.current;
    scrub.current = null;
    if (!s) return;
    scrubbed.current = s.moved;
    if (!s.moved) inputRef.current?.select();
    else if (onScrub) {
      setDraft(null);
      onScrubEnd?.();
    } else commit(format(s.current));
  };

  return (
    <label className="flex h-7 min-w-0 items-center rounded-md bg-ink ring-1 ring-line ring-inset focus-within:ring-accent hover:ring-line-strong focus-within:hover:ring-accent">
      <span
        className={`flex h-full shrink-0 cursor-ew-resize touch-none items-center ${
          wide ? 'pr-1 pl-2 text-[12px]' : 'w-6 justify-center text-[11.5px] font-semibold'
        }`}
        style={{ color }}
        title="Ziehen, um den Wert zu ändern"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onClick={(e) => {
          if (scrubbed.current) e.preventDefault();
        }}
        onPointerCancel={() => {
          const moved = scrub.current?.moved;
          scrub.current = null;
          setDraft(null);
          if (moved) onScrubEnd?.();
        }}
      >
        {label}
      </span>
      <input
        ref={inputRef}
        aria-label={ariaLabel}
        inputMode="decimal"
        spellCheck={false}
        autoComplete="off"
        className="tnum h-full w-full min-w-0 bg-transparent pr-1.5 text-right text-[12.5px] text-text outline-none"
        value={draft ?? format(value)}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={() => {
          commit(reverting.current ? null : draft);
          reverting.current = false;
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit(draft);
            e.currentTarget.select();
          } else if (e.key === 'Escape') {
            // Blur fires before the state update lands, so tell it to discard the draft.
            reverting.current = true;
            setDraft(null);
            e.currentTarget.blur();
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const base = parse(draft ?? '') ?? value;
            const delta = (integer ? 1 : step * 10 * (e.shiftKey ? 0.1 : 1)) * (e.key === 'ArrowUp' ? 1 : -1);
            commit(format(base + delta));
          }
        }}
      />
    </label>
  );
}
