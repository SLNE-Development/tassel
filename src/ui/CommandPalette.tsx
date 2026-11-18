import { Dialog } from '@base-ui/react/dialog';
import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { execute } from '../app/store';
import { commands } from '../core/commands';
import { commandTitle, getT, useT } from '../i18n';
import { actions, comboLabel, inEditMode, isAvailable } from './actions';
import { notifyError, notifyInfo } from './toast';
import { useUi } from './uiStore';

interface Entry {
  id: string;
  title: string;
  group: string;
  shortcut?: string;
  /** Lower-cased text the query is matched against. */
  haystack: string;
  run(): unknown;
}

function buildEntries(): Entry[] {
  const edit = inEditMode();
  const fromActions = actions
    .filter((a) => !a.hidden && isAvailable(a))
    .map((a): Entry => ({
      id: a.id,
      title: a.title,
      group: a.group,
      shortcut: comboLabel(a, edit),
      haystack: `${a.title} ${a.group}`.toLowerCase(),
      run: a.run,
    }));
  // Registry commands that need no parameters and are not already offered as a UI action.
  const covered = new Set(actions.map((a) => a.command).filter(Boolean));
  const fromRegistry = commands
    .filter((c) => !covered.has(c.id) && c.params.safeParse({}).success)
    .map((c): Entry => {
      const title = commandTitle(c);
      return {
        id: c.id,
        title,
        group: getT().groups.command,
        haystack: `${title} ${c.id}`.toLowerCase(),
        run: async () => {
          await execute(c.id);
          notifyInfo(getT().palette.executed, commandTitle(c));
        },
      };
    });
  return [...fromActions, ...fromRegistry];
}

/** Subsequence match. Higher is better; null means no match. Rewards word starts and runs. */
function fuzzyScore(query: string, text: string): number | null {
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const char of query) {
    if (char === ' ') continue;
    const index = text.indexOf(char, from);
    if (index === -1) return null;
    score += 1;
    if (index === previous + 1) score += 3;
    if (index === 0 || ' .:_'.includes(text[index - 1])) score += 2;
    previous = index;
    from = index + 1;
  }
  return score - text.length * 0.01;
}

function PaletteBody({ close }: { close(): void }) {
  const t = useT();
  // Built once per opening and language: titles and groups are in the UI language.
  const entries = useMemo(buildEntries, [t]);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries
      .map((entry) => {
        // A match in the title alone beats one that needs the group name or command id.
        const inTitle = fuzzyScore(q, entry.title.toLowerCase());
        return { entry, score: inTitle !== null ? inTitle + 100 : fuzzyScore(q, entry.haystack) };
      })
      .filter((r): r is { entry: Entry; score: number } => r.score !== null)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.entry);
  }, [entries, query]);

  const index = Math.min(cursor, Math.max(results.length - 1, 0));

  const run = (entry: Entry | undefined) => {
    if (!entry) return;
    close();
    // Let the dialog close and hand focus back first, so actions that open something else can take it.
    setTimeout(() => void Promise.resolve().then(entry.run).catch(notifyError), 0);
  };

  const move = (delta: number) => {
    if (results.length === 0) return;
    const next = (index + delta + results.length) % results.length;
    setCursor(next);
    document.getElementById(`palette-${next}`)?.scrollIntoView({ block: 'nearest' });
  };

  return (
    <>
      <div className="flex h-11 items-center gap-2.5 border-b border-line-strong px-3.5">
        <Search size={15} className="shrink-0 text-faint" />
        <input
          autoFocus
          role="combobox"
          aria-expanded
          aria-controls="palette-list"
          aria-activedescendant={results.length ? `palette-${index}` : undefined}
          aria-label={t.palette.search}
          placeholder={t.palette.search}
          spellCheck={false}
          className="h-full min-w-0 flex-1 bg-transparent text-[calc(14px*var(--font-scale))] text-text outline-none placeholder:text-faint"
          value={query}
          onChange={(e) => {
            setQuery(e.currentTarget.value);
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              move(1);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              move(-1);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              run(results[index]);
            }
          }}
        />
      </div>
      <div id="palette-list" role="listbox" aria-label={t.palette.commands} className="max-h-[min(22rem,55vh)] overflow-y-auto p-1">
        {results.length === 0 && <p className="px-3 py-5 text-center text-[calc(13px*var(--font-scale))] text-faint">{t.palette.noMatch(query.trim())}</p>}
        {results.map((entry, i) => (
          <div
            key={entry.id}
            id={`palette-${i}`}
            role="option"
            aria-selected={i === index}
            className={`flex h-8 items-center gap-3 rounded-md px-2.5 text-[calc(13px*var(--font-scale))] ${
              i === index ? 'bg-accent text-accent-ink' : 'text-text'
            }`}
            onPointerMove={() => i !== index && setCursor(i)}
            onClick={() => run(entry)}
          >
            <span className="min-w-0 flex-1 truncate">{entry.title}</span>
            {entry.shortcut && <span className="tnum shrink-0 text-[calc(12px*var(--font-scale))] opacity-70">{entry.shortcut}</span>}
            <span className="w-24 shrink-0 text-right text-[calc(12px*var(--font-scale))] opacity-60">{entry.group}</span>
          </div>
        ))}
      </div>
    </>
  );
}

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const setOpen = (paletteOpen: boolean) => useUi.setState({ paletteOpen });
  const t = useT();
  // Every opening starts with an empty query, even one that interrupts the closing animation.
  const [session, setSession] = useState(0);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setSession(session + 1);
  }
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/35" />
        <Dialog.Popup
          aria-label={t.palette.title}
          className="anim-pop fixed top-[16vh] left-1/2 z-50 w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-xl border border-line-strong bg-overlay shadow-pop outline-none"
        >
          <Dialog.Title className="sr-only">{t.palette.title}</Dialog.Title>
          <PaletteBody key={session} close={() => setOpen(false)} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
