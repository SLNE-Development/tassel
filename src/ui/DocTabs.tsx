import { Plus, X } from 'lucide-react';
import { memo, useEffect, useRef } from 'react';
import { useApp } from '../app/store';
import { dispatch, requestCloseDoc, runAction, shortcutLabel } from './actions';
import { Tip } from './Tip';

const DocTab = memo(function DocTab({ id }: { id: string }) {
  const name = useApp((s) => s.docs[id]?.name ?? '');
  const dirty = useApp((s) => s.docs[id]?.dirty ?? false);
  const active = useApp((s) => s.activeDocId === id);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);

  return (
    <div
      ref={ref}
      className={`group relative flex h-7 max-w-44 min-w-24 shrink-0 items-center rounded-md ${
        active ? 'bg-raised text-text' : 'text-dim hover:bg-raised/60 hover:text-text'
      }`}
      onAuxClick={(e) => {
        if (e.button === 1) void requestCloseDoc(id);
      }}
    >
      <button
        role="tab"
        aria-selected={active}
        title={name}
        className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md pr-1 pl-2.5 text-left"
        onClick={() => void dispatch('document.switch', { id })}
      >
        {/* The dot keeps its slot when clean, so the name never shifts. */}
        <span
          aria-hidden
          className={`size-1.5 shrink-0 rounded-full ${dirty ? 'bg-accent' : 'bg-transparent'}`}
        />
        <span className="truncate">{name}</span>
        {dirty && <span className="sr-only">, ungespeichert</span>}
      </button>
      <button
        aria-label={`${name} schließen`}
        className={`mr-1 flex size-5 shrink-0 items-center justify-center rounded text-faint hover:bg-line-strong hover:text-text focus-visible:opacity-100 ${
          active ? '' : 'opacity-0 group-hover:opacity-100'
        }`}
        onClick={() => void requestCloseDoc(id)}
      >
        <X size={13} />
      </button>
    </div>
  );
});

export function DocTabs() {
  const docOrder = useApp((s) => s.docOrder);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <div role="tablist" aria-label="Dokumente" className="no-scrollbar flex min-w-0 items-center gap-1 overflow-x-auto py-1">
        {docOrder.map((id) => (
          <DocTab key={id} id={id} />
        ))}
      </div>
      <Tip label="Neues Modell" shortcut={shortcutLabel('file.new')}>
        <button
          aria-label="Neues Modell"
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-faint hover:bg-raised hover:text-text"
          onClick={() => void runAction('file.new')}
        >
          <Plus size={15} />
        </button>
      </Tip>
    </div>
  );
}
