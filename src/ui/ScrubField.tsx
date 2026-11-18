import { useRef, useState, type PointerEvent } from 'react';

const format = (value: number) =>
  // Avoid "-0" and float noise like 0.30000000000000004.
  (Math.round(value * 1000) / 1000 + 0).toLocaleString('de-DE', { maximumFractionDigits: 3, useGrouping: false });

/** Accepts both "1,5" and "1.5". Returns null for anything that is not a finite number. */
function parse(text: string): number | null {
  const trimmed = text.trim().replace(',', '.');
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/**
 * Numeric field. Typing commits on Enter or blur, Escape reverts. Dragging the axis label
 * scrubs the value (Shift = fine) and commits once on release, so a scrub is a single undo step.
 */
export function ScrubField({
  label,
  ariaLabel,
  color,
  value,
  step,
  onCommit,
}: {
  label: string;
  ariaLabel: string;
  /** CSS colour of the axis label. */
  color: string;
  value: number;
  /** Value change per pixel while scrubbing and per arrow-key press. */
  step: number;
  onCommit(value: number): void;
}) {
  // `draft` is the text while editing or scrubbing; null shows the committed value.
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const reverting = useRef(false);
  const scrub = useRef<{ x: number; start: number; current: number; moved: boolean } | null>(null);

  const commit = (text: string | null) => {
    setDraft(null);
    if (text === null) return;
    const next = parse(text);
    if (next !== null && next !== value) onCommit(next);
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
    s.current = s.start + dx * step * (e.shiftKey ? 0.1 : 1);
    setDraft(format(s.current));
  };

  const onPointerUp = () => {
    const s = scrub.current;
    scrub.current = null;
    if (!s) return;
    if (s.moved) commit(format(s.current));
    else inputRef.current?.select();
  };

  return (
    <label className="flex h-7 min-w-0 items-center rounded-md bg-ink ring-1 ring-line ring-inset focus-within:ring-accent hover:ring-line-strong focus-within:hover:ring-accent">
      <span
        className="flex h-full w-6 shrink-0 cursor-ew-resize touch-none items-center justify-center text-[11.5px] font-semibold"
        style={{ color }}
        title="Ziehen, um den Wert zu ändern"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          scrub.current = null;
          setDraft(null);
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
            const delta = step * 10 * (e.shiftKey ? 0.1 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
            commit(format(base + delta));
          }
        }}
      />
    </label>
  );
}
