import { Slider } from '@base-ui/react/slider';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../i18n';
import { LiveEdit } from './live';

type Params = Record<string, unknown>;

/**
 * Like `useLiveEdit`, but `scrub` returns a promise that resolves when the document shows the
 * value, so a control can hold on to its own value until then instead of flickering.
 */
export function useLive(): { scrub(id: string, params: Params): Promise<void>; end(): void } {
  const edit = useRef<LiveEdit | null>(null);
  return useMemo(
    () => ({
      scrub: (id, params) => (edit.current ??= new LiveEdit()).apply(id, params),
      end: () => {
        edit.current = null;
      },
    }),
    [],
  );
}

/**
 * The value a control shows while the user drags it: the document trails behind (every live step
 * is an undo plus a re-run), so the control shows its own value from the first change until the
 * last one has landed.
 */
function useDraft<T>() {
  const [draft, setDraft] = useState<T | null>(null);
  const pending = useRef<Promise<void> | null>(null);
  const drag = useRef(0);
  return {
    draft,
    change(value: T, applied: Promise<void>) {
      setDraft(value);
      pending.current = applied;
    },
    /** The drag is over: let go of the draft once its last value is in the document. */
    release() {
      const token = ++drag.current;
      const done = () => {
        if (drag.current === token) setDraft(null);
      };
      (pending.current ?? Promise.resolve()).then(done, done);
      pending.current = null;
    },
  };
}

/** A 0..1 value as a filled field: drag anywhere in it, or use the arrow keys. */
export function UnitSlider({
  label,
  value,
  onScrub,
  onScrubEnd,
}: {
  label: string;
  value: number;
  /** Live value while dragging; resolves when the document shows it. */
  onScrub(value: number): Promise<void>;
  onScrubEnd(): void;
}) {
  const t = useT();
  const { draft, change, release } = useDraft<number>();
  const shown = draft ?? value;
  const control = useRef<HTMLDivElement>(null);
  return (
    <Slider.Root
      value={shown}
      min={0}
      max={1}
      step={0.01}
      largeStep={0.1}
      thumbAlignment="edge"
      onValueChange={(next) => next !== shown && change(next, onScrub(next))}
      onValueCommitted={(_, details) => {
        release();
        onScrubEnd();
        // A drag leaves the focus in the slider's input, which would swallow the next shortcut (undo!).
        const active = document.activeElement;
        if (details.event.type.startsWith('pointer') && active instanceof HTMLElement && control.current?.contains(active)) active.blur();
      }}
    >
      <Slider.Control ref={control} className="relative flex h-7 cursor-ew-resize touch-none items-center overflow-hidden rounded-md bg-ink ring-1 ring-line ring-inset hover:ring-line-strong has-[:focus-visible]:ring-accent">
        <Slider.Track className="h-full w-full">
          <Slider.Indicator className="h-full bg-raised" />
          <Slider.Thumb getAriaLabel={() => label} className="h-full w-0.5 bg-accent" />
        </Slider.Track>
        <span className="pointer-events-none absolute inset-0 flex items-center justify-between pr-1.5 pl-2">
          <span className="truncate text-[calc(12px*var(--font-scale))] text-dim">{label}</span>
          <span className="tnum text-[calc(12.5px*var(--font-scale))] text-text">
            {shown.toLocaleString(t.locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        </span>
      </Slider.Control>
    </Slider.Root>
  );
}

/** "#abc", "abc", "#aabbcc" or "aabbcc" as lower-case #rrggbb; null for anything else. */
function parseHex(text: string): string | null {
  const hex = text.trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{6}$/.test(hex)) return `#${hex}`;
  if (/^[0-9a-f]{3}$/.test(hex)) return `#${[...hex].map((c) => c + c).join('')}`;
  return null;
}

/** A colour: the swatch opens the system colour picker (live while dragging in it), the field takes a hex value. */
export function ColorField({
  label,
  value,
  onCommit,
  onScrub,
  onScrubEnd,
}: {
  label: string;
  /** #rrggbb */
  value: string;
  onCommit(value: string): void;
  onScrub(value: string): Promise<void>;
  onScrubEnd(): void;
}) {
  const t = useT().materials;
  const { draft, change, release } = useDraft<string>();
  const [text, setText] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const reverting = useRef(false);
  const shown = draft ?? value;

  // React's onChange fires for every step in the colour picker; the native `change` event marks its end.
  const end = useRef(() => {});
  end.current = () => {
    release();
    onScrubEnd();
    // The picker's input would swallow the next shortcut (undo!).
    picker.current?.blur();
  };
  useEffect(() => {
    const input = picker.current;
    if (!input) return;
    const onChange = () => end.current();
    input.addEventListener('change', onChange);
    return () => input.removeEventListener('change', onChange);
  }, []);

  const commit = (typed: string | null) => {
    setText(null);
    const next = typed === null ? null : parseHex(typed);
    if (next && next !== value) onCommit(next);
  };

  return (
    <div className="flex min-w-0 gap-1">
      <label className="relative size-7 shrink-0 overflow-hidden rounded-md ring-1 ring-line-strong ring-inset hover:ring-faint has-[:focus-visible]:ring-accent" style={{ background: shown }}>
        <input
          ref={picker}
          type="color"
          aria-label={t.pickColor(label)}
          className="absolute inset-0 size-full cursor-pointer opacity-0"
          value={shown}
          onChange={(e) => {
            const next = e.currentTarget.value.toLowerCase();
            if (next !== shown) change(next, onScrub(next));
          }}
        />
      </label>
      <input
        aria-label={t.hex(label)}
        spellCheck={false}
        autoComplete="off"
        maxLength={7}
        className="tnum h-7 w-full min-w-0 rounded-md bg-ink px-2 text-[calc(12.5px*var(--font-scale))] text-text ring-1 ring-line outline-none ring-inset hover:ring-line-strong focus:ring-accent"
        value={text ?? shown}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setText(e.currentTarget.value)}
        onBlur={() => {
          commit(reverting.current ? null : text);
          reverting.current = false;
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit(text);
            e.currentTarget.select();
          } else if (e.key === 'Escape') {
            reverting.current = true;
            setText(null);
            e.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}
