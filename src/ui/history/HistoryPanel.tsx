import { PanelRightClose } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { selectActiveDoc, useApp } from '../../app/store';
import { historyEntries } from '../../core/history';
import { useT } from '../../i18n';
import { Tip } from '../Tip';
import { gotoHistoryEntry, historyEntryIcon, historyEntryLabel, historyTime, setHistoryPanelOpen } from './historyUi';

const iconButton = 'flex size-6.5 shrink-0 items-center justify-center rounded-md text-dim hover:bg-raised hover:text-text';

/**
 * The History panel: every undo step of the active document, the document as created or opened at the top,
 * the newest change at the bottom. Clicking an entry (or ↑/↓/Home/End) jumps there in one go; undone entries
 * are dimmed until the next change drops them. Self-contained: the app shell decides where it is docked.
 */
export function HistoryPanel() {
  const t = useT();
  const doc = useApp(selectActiveDoc);
  // Language changes re-render through `t`; the entries only change with the document.
  const entries = useMemo(() => historyEntries(doc), [doc]);
  const current = doc.past.length;
  const list = useRef<HTMLDivElement>(null);

  // Keep the current step in view (after a jump, a new change or switching documents).
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [current, doc.id, entries.length]);

  const jump = (index: number) => {
    if (index === current || index < 0 || index >= entries.length) return;
    void gotoHistoryEntry(index);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const target = { ArrowUp: current - 1, ArrowDown: current + 1, Home: 0, End: entries.length - 1, PageUp: current - 10, PageDown: current + 10 }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    jump(Math.max(0, Math.min(entries.length - 1, target)));
  };

  const undone = entries.length - 1 - current;
  return (
    <aside aria-label={t.history.title} className="flex min-h-0 min-w-0 flex-col border-l border-line bg-panel">
      <header className="flex h-8 shrink-0 items-center justify-between pr-1.5 pl-3">
        <h2 className="text-[calc(12px*var(--font-scale))] font-semibold text-dim">{t.history.title}</h2>
        <Tip label={t.history.close}>
          <button aria-label={t.history.close} className={iconButton} onClick={() => setHistoryPanelOpen(false)}>
            <PanelRightClose size={14} strokeWidth={1.75} />
          </button>
        </Tip>
      </header>
      <div
        ref={list}
        role="listbox"
        tabIndex={0}
        aria-label={t.history.title}
        aria-activedescendant={`history-entry-${current}`}
        title={t.history.jumpHint}
        className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5 outline-none focus-visible:ring-1 focus-visible:ring-accent focus-visible:ring-inset"
        onKeyDown={onKeyDown}
      >
        {entries.map((entry) => {
          const Icon = historyEntryIcon(entry.step);
          const label = historyEntryLabel(entry.step, t);
          return (
            <div
              key={entry.index}
              id={`history-entry-${entry.index}`}
              role="option"
              aria-selected={entry.current}
              onClick={() => jump(entry.index)}
              className={`relative flex h-7 cursor-default items-center gap-2 rounded-md px-2 text-[calc(12.5px*var(--font-scale))] select-none ${
                entry.current ? 'bg-accent/16 text-text' : entry.undone ? 'text-faint/70 hover:bg-raised hover:text-dim' : 'text-dim hover:bg-raised hover:text-text'
              } ${entry.step.origin ? 'mb-0.5 border-b border-line' : ''}`}
            >
              {entry.current && <span aria-hidden className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-accent" />}
              <Icon size={14} strokeWidth={1.75} className={`shrink-0 ${entry.current ? 'text-accent' : 'text-faint'} ${entry.undone ? 'opacity-50' : ''}`} />
              <span className={`min-w-0 flex-1 truncate ${entry.undone ? 'italic' : ''}`} title={label}>
                {label}
              </span>
              <span className="shrink-0 text-[calc(11px*var(--font-scale))] text-faint tabular-nums">{historyTime(entry.step, t)}</span>
            </div>
          );
        })}
      </div>
      <footer className="flex h-6 shrink-0 items-center justify-between border-t border-line px-3 text-[calc(11px*var(--font-scale))] text-faint">
        <span>{t.history.steps(entries.length - 1)}</span>
        {undone > 0 && <span>{t.history.undone(undone)}</span>}
      </footer>
    </aside>
  );
}
