import { Menu } from '@base-ui/react/menu';
import { Check, ChevronsUpDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { itemClass, popupClass } from './menu';

/** Small on/off switch. */
export function Switch({ checked, label, onChange }: { checked: boolean; label: string; onChange(checked: boolean): void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`relative h-4 w-7 shrink-0 rounded-full ring-1 ring-inset ${checked ? 'bg-accent ring-accent' : 'bg-ink ring-line-strong hover:ring-faint'}`}
      onClick={() => onChange(!checked)}
    >
      <span aria-hidden className={`absolute top-0.5 size-3 rounded-full transition-[left] duration-100 ${checked ? 'left-3.5 bg-accent-ink' : 'left-0.5 bg-dim'}`} />
    </button>
  );
}

/** A row of mutually exclusive choices that fills its width. */
export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; title: ReactNode; ariaLabel?: string }[];
  onChange(value: T): void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex h-7 min-w-0 rounded-md bg-ink p-0.5 ring-1 ring-line ring-inset">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            role="radio"
            aria-checked={active}
            aria-label={option.ariaLabel}
            className={`tnum min-w-0 flex-1 truncate rounded-[4px] px-1 text-[12px] ${
              active ? 'bg-raised text-text shadow-[0_0_0_1px_var(--line-strong)]' : 'text-dim hover:text-text'
            }`}
            onClick={() => !active && onChange(option.value)}
          >
            {option.title}
          </button>
        );
      })}
    </div>
  );
}

/** Drop-down choice in the look of the other menus. */
export function PickMenu<T extends string>({
  label,
  value,
  options,
  placeholder,
  onChange,
}: {
  label: string;
  value: T | null;
  options: readonly { value: T; title: string }[];
  /** Shown when `value` is null or not among the options. */
  placeholder: string;
  onChange(value: T): void;
}) {
  const current = options.find((o) => o.value === value);
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={`${label}: ${current?.title ?? placeholder}`}
        className="flex h-7 w-full min-w-0 items-center gap-1 rounded-md bg-ink pr-1.5 pl-2 text-left text-[12.5px] ring-1 ring-line ring-inset hover:ring-line-strong data-[popup-open]:ring-accent"
      >
        <span className={`min-w-0 flex-1 truncate ${current ? 'text-text' : 'text-faint'}`}>{current?.title ?? placeholder}</span>
        <ChevronsUpDown size={12} className="shrink-0 text-faint" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="start" sideOffset={4} className="z-50 outline-none">
          <Menu.Popup className={`${popupClass} max-h-64 overflow-y-auto`}>
            {options.length === 0 && <p className="px-2 py-1.5 text-[12.5px] text-faint">Keine Auswahl möglich</p>}
            <Menu.RadioGroup value={current?.value ?? ''}>
              {options.map((option) => (
                <Menu.RadioItem key={option.value} className={itemClass} value={option.value} closeOnClick onClick={() => onChange(option.value)}>
                  <span className="flex w-4 shrink-0 justify-center">
                    <Menu.RadioItemIndicator>
                      <Check size={14} strokeWidth={2.25} />
                    </Menu.RadioItemIndicator>
                  </span>
                  <span className="truncate">{option.title}</span>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
