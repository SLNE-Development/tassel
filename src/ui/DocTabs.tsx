import { Plus, X } from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';
import { agentActivityLeft, useAgentActivity } from '../app/agentActivity';
import { useApp } from '../app/store';
import { documentName, useT } from '../i18n';
import { dispatch, requestCloseDoc, runAction, shortcutLabel } from './actions';
import { Tip } from './Tip';

/** True from an AI client's tool call against this document until a few seconds after its last one. */
function useAgentWorking(id: string): boolean {
  const last = useAgentActivity((s) => s.lastCall[id]);
  const [working, setWorking] = useState(false);
  useEffect(() => {
    const left = agentActivityLeft(last);
    setWorking(left > 0);
    if (left <= 0) return;
    const timer = setTimeout(() => setWorking(false), left);
    return () => clearTimeout(timer);
  }, [last]);
  return working;
}

/**
 * Shows that an AI client is working in this document: a small ring around a breathing core, in the
 * colour of the tab's text so that it stays apart from the accent-coloured "unsaved" dot. It takes its
 * place only while it shows, and comes and goes softly.
 */
function AgentIndicator({ id }: { id: string }) {
  const t = useT();
  const working = useAgentWorking(id);
  return (
    <Tip label={t.mcp.agentWorking}>
      <span
        role="status"
        data-agent-working={working || undefined}
        className={`flex h-full shrink-0 items-center justify-center overflow-hidden transition-[width,opacity] duration-500 ease-out ${
          working ? 'w-4 opacity-100' : 'pointer-events-none w-0 opacity-0'
        }`}
      >
        <span aria-hidden className="flex size-2.5 items-center justify-center rounded-full border border-current opacity-80">
          <span className={`size-1 rounded-full bg-current ${working ? 'anim-agent' : ''}`} />
        </span>
        {working && <span className="sr-only">{t.mcp.agentWorking}</span>}
      </span>
    </Tip>
  );
}

const DocTab = memo(function DocTab({ id }: { id: string }) {
  const t = useT();
  const name = useApp((s) => (s.docs[id] ? documentName(s.docs[id], t) : ''));
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
        {dirty && <span className="sr-only">{t.topBar.unsaved}</span>}
      </button>
      <AgentIndicator id={id} />
      <button
        aria-label={t.topBar.closeDocument(name)}
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
  const t = useT();
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <div role="tablist" aria-label={t.topBar.documents} className="no-scrollbar flex min-w-0 items-center gap-1 overflow-x-auto py-1">
        {docOrder.map((id) => (
          <DocTab key={id} id={id} />
        ))}
      </div>
      <Tip label={t.topBar.newModel} shortcut={shortcutLabel('file.new')}>
        <button
          aria-label={t.topBar.newModel}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-faint hover:bg-raised hover:text-text"
          onClick={() => void runAction('file.new')}
        >
          <Plus size={15} />
        </button>
      </Tip>
    </div>
  );
}
