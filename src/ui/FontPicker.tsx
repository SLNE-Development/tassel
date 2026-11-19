import { Popover } from '@base-ui/react/popover';
import { Check, ChevronsUpDown, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { services } from '../app/store';
import type { FontFamily } from '../core/types';
import { useT } from '../i18n';
import { popupClass } from './menu';
import { notifyError } from './toast';

/** The value of the built-in font, as `scene.add_text` names it. */
export const BUILTIN_FONT = 'default';

/** Rows shown at once. A few hundred families are installed; the search narrows them down. */
const VISIBLE = 60;

/**
 * Chooses a font family: the built-in font first, then the installed families, narrowed down by a
 * search field. Only as many rows as fit a glance are rendered, however many fonts are installed.
 */
export function FontPicker({ label, value, onChange }: { label: string; value: string; onChange(family: string): void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [families, setFamilies] = useState<FontFamily[] | null>(null);
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const fonts = services.fonts ?? null;

  useEffect(() => {
    if (!open || families || !fonts) return;
    let current = true;
    fonts.list().then((all) => current && setFamilies(all), notifyError);
    return () => {
      current = false;
    };
  }, [open, families, fonts]);

  const builtin = value.trim().toLowerCase() === BUILTIN_FONT;
  const { rows, hidden } = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const all = [
      { value: BUILTIN_FONT, title: t.fonts.builtin },
      ...(families ?? []).map((f) => ({ value: f.family, title: f.family })),
    ].filter((row) => row.title.toLowerCase().includes(needle));
    // Names that start with what was typed come first.
    if (needle) all.sort((a, b) => Number(b.title.toLowerCase().startsWith(needle)) - Number(a.title.toLowerCase().startsWith(needle)));
    return { rows: all.slice(0, VISIBLE), hidden: Math.max(0, all.length - VISIBLE) };
  }, [families, query, t]);

  const isCurrent = (row: { value: string }) => (builtin ? row.value === BUILTIN_FONT : row.value.toLowerCase() === value.trim().toLowerCase());
  const choose = (family: string) => {
    setOpen(false);
    if (family !== value) onChange(family);
  };
  const move = (to: number) => {
    const index = Math.max(0, Math.min(rows.length - 1, to));
    setActive(index);
    list.current?.children[index]?.scrollIntoView({ block: 'nearest' });
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setQuery('');
          setActive(0);
        }
      }}
    >
      <Popover.Trigger
        aria-label={`${label}: ${builtin ? t.fonts.builtin : value}`}
        className="flex h-7 w-full min-w-0 items-center gap-1 rounded-md bg-ink pr-1.5 pl-2 text-left text-[calc(12.5px*var(--font-scale))] ring-1 ring-line ring-inset hover:ring-line-strong data-[popup-open]:ring-accent"
      >
        <span className="min-w-0 flex-1 truncate text-text">{builtin ? t.fonts.builtin : value}</span>
        <ChevronsUpDown size={12} className="shrink-0 text-faint" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="start" sideOffset={4} className="z-50 outline-none">
          <Popover.Popup aria-label={label} className={`${popupClass} flex w-64 flex-col`}>
            <label className="mb-1 flex h-7 shrink-0 items-center gap-2 rounded-md bg-ink px-2 ring-1 ring-line ring-inset focus-within:ring-accent">
              <Search size={13} className="shrink-0 text-faint" />
              <input
                autoFocus
                type="text"
                role="combobox"
                aria-expanded
                aria-controls="font-picker-list"
                aria-activedescendant={rows[active] ? `font-picker-${active}` : undefined}
                aria-label={t.fonts.search}
                placeholder={t.fonts.search}
                spellCheck={false}
                value={query}
                className="min-w-0 flex-1 bg-transparent text-[calc(12.5px*var(--font-scale))] text-text outline-none placeholder:text-faint"
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                  list.current?.scrollTo({ top: 0 });
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') move(active + 1);
                  else if (e.key === 'ArrowUp') move(active - 1);
                  else if (e.key === 'Home') move(0);
                  else if (e.key === 'End') move(rows.length - 1);
                  else if (e.key === 'Enter' && rows[active]) choose(rows[active].value);
                  else return;
                  e.preventDefault();
                }}
              />
            </label>
            <div ref={list} id="font-picker-list" role="listbox" aria-label={label} className="max-h-56 overflow-y-auto">
              {rows.map((row, index) => (
                <div
                  key={row.value}
                  id={`font-picker-${index}`}
                  role="option"
                  aria-selected={isCurrent(row)}
                  className={`flex h-7 cursor-default items-center gap-2 rounded-[5px] pr-2 pl-1.5 text-[calc(12.5px*var(--font-scale))] ${
                    index === active ? 'bg-accent text-accent-ink' : 'text-text'
                  }`}
                  onPointerMove={() => index !== active && setActive(index)}
                  onClick={() => choose(row.value)}
                >
                  <span className="flex w-4 shrink-0 justify-center">{isCurrent(row) && <Check size={14} strokeWidth={2.25} />}</span>
                  <span className="truncate">{row.title}</span>
                </div>
              ))}
            </div>
            {rows.length === 0 && <p className="px-2 py-1.5 text-[calc(12.5px*var(--font-scale))] text-faint">{t.fonts.none}</p>}
            {hidden > 0 && <p className="shrink-0 px-2 pt-1.5 pb-1 text-[calc(11.5px*var(--font-scale))] text-faint">{t.fonts.more(hidden)}</p>}
            {!fonts && <p className="shrink-0 px-2 pt-1.5 pb-1 text-[calc(11.5px*var(--font-scale))] text-faint">{t.fonts.desktopOnly}</p>}
            {fonts && !families && <p className="shrink-0 px-2 pt-1.5 pb-1 text-[calc(11.5px*var(--font-scale))] text-faint">{t.fonts.loading}</p>}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
