import { useRef, type ReactNode } from 'react';

const inputClass =
  'h-7 w-full min-w-0 rounded-md bg-ink px-2 text-[calc(12.5px*var(--font-scale))] text-text ring-1 ring-line outline-none ring-inset hover:ring-line-strong focus:ring-accent';

/** Text field that commits on Enter or blur and reverts on Escape; it shows `value` again whenever that changes from outside. */
export function TextField({
  label,
  value,
  placeholder,
  mono,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder?: string;
  mono?: boolean;
  onCommit(value: string): void;
}) {
  const reverting = useRef(false);
  return (
    <input
      key={value}
      aria-label={label}
      defaultValue={value}
      placeholder={placeholder}
      spellCheck={false}
      autoComplete="off"
      className={`${inputClass} ${mono ? 'font-mono' : ''}`}
      onBlur={(e) => {
        const next = e.currentTarget.value.trim();
        if (reverting.current) e.currentTarget.value = value;
        else if (next !== value) onCommit(next);
        reverting.current = false;
      }}
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

/** A labelled row of a form: label on the left, control on the right. */
export function FieldRow({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-2">
      <span className="truncate text-[calc(12px*var(--font-scale))] text-dim" title={title}>
        {title}
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Heading of a panel section. */
export function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="mb-1.5 border-t border-line pt-3 text-[calc(12px*var(--font-scale))] font-semibold text-dim">{children}</h3>;
}

export const smallButton =
  'flex h-7 min-w-0 items-center justify-center gap-1.5 rounded-md border border-line-strong px-2 text-[calc(12px*var(--font-scale))] text-text hover:border-accent hover:text-accent disabled:pointer-events-none disabled:text-faint/60';
