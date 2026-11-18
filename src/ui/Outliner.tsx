import { Box, Eye, EyeOff } from 'lucide-react';
import { memo, useRef, type KeyboardEvent, type MouseEvent } from 'react';
import { selectDocState, useApp } from '../app/store';
import { useT } from '../i18n';
import { dispatch, shortcutLabel } from './actions';
import { useUi } from './uiStore';

function RenameInput({ id, name }: { id: string; name: string }) {
  const done = useRef(false);
  const t = useT();
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    useUi.setState({ renamingId: null });
    const next = value?.trim();
    if (next && next !== name) void dispatch('scene.rename_object', { id, name: next });
  };
  return (
    <input
      autoFocus
      defaultValue={name}
      aria-label={t.common.name}
      className="h-5.5 min-w-0 flex-1 rounded-[4px] bg-ink px-1.5 text-text outline-1 outline-accent"
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => finish(e.currentTarget.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(e.currentTarget.value);
        if (e.key === 'Escape') finish(null);
      }}
    />
  );
}

const Row = memo(function Row({ id }: { id: string }) {
  const name = useApp((s) => selectDocState(s).objects[id]?.name ?? '');
  const visible = useApp((s) => selectDocState(s).objects[id]?.visible ?? true);
  const selected = useApp((s) => selectDocState(s).selection.includes(id));
  const active = useApp((s) => selectDocState(s).activeId === id);
  // Roving tab stop: the active object, or the first row if nothing is active.
  const tabStop = useApp((s) => (selectDocState(s).activeId ?? selectDocState(s).order[0]) === id);
  const renaming = useUi((s) => s.renamingId === id);
  const t = useT();

  const select = (e: MouseEvent | KeyboardEvent) =>
    void dispatch('scene.select', { ids: [id], mode: e.ctrlKey || e.metaKey || e.shiftKey ? 'toggle' : 'replace' });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      select(e);
    } else if (e.key === 'F2') {
      e.preventDefault();
      useUi.setState({ renamingId: id });
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const sibling = e.key === 'ArrowDown' ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling;
      (sibling as HTMLElement | null)?.focus();
    }
  };

  return (
    <div
      role="option"
      aria-label={name}
      aria-selected={selected}
      tabIndex={tabStop ? 0 : -1}
      className={`group relative flex h-7 items-center gap-2 rounded-md pr-1 pl-2.5 outline-offset-[-2px] ${
        active ? 'bg-accent/16 text-text' : selected ? 'bg-accent/8 text-text' : 'text-dim hover:bg-raised hover:text-text'
      }`}
      onClick={select}
      onDoubleClick={() => useUi.setState({ renamingId: id })}
      onKeyDown={onKeyDown}
    >
      {active && <span aria-hidden className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-accent" />}
      <Box size={14} strokeWidth={1.75} className={`shrink-0 ${selected ? 'text-accent' : 'text-faint'} ${visible ? '' : 'opacity-40'}`} />
      {renaming ? (
        <RenameInput id={id} name={name} />
      ) : (
        <span className={`min-w-0 flex-1 truncate ${visible ? '' : 'text-faint'}`}>{name}</span>
      )}
      <button
        aria-label={visible ? t.outliner.hide(name) : t.outliner.show(name)}
        aria-pressed={!visible}
        className={`flex size-6 shrink-0 items-center justify-center rounded hover:bg-line-strong hover:text-text focus-visible:opacity-100 ${
          visible ? 'text-faint opacity-0 group-hover:opacity-100' : 'text-dim'
        }`}
        onClick={(e) => {
          e.stopPropagation();
          void dispatch('scene.set_visible', { ids: [id], visible: !visible });
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {visible ? <Eye size={14} /> : <EyeOff size={14} />}
      </button>
    </div>
  );
});

export function Outliner() {
  const order = useApp((s) => selectDocState(s).order);
  const t = useT();
  return (
    <section aria-label={t.outliner.title} className="flex min-h-0 min-w-0 flex-col">
      <header className="flex h-8 shrink-0 items-center justify-between pr-3 pl-3">
        <h2 className="text-[calc(12px*var(--font-scale))] font-semibold text-dim">{t.outliner.title}</h2>
        <span className="tnum text-[calc(12px*var(--font-scale))] text-faint">{order.length || ''}</span>
      </header>
      {order.length === 0 ? (
        <p className="px-3 pt-1 pb-4 text-[calc(12.5px*var(--font-scale))] leading-relaxed text-faint">
          {t.outliner.empty.before}
          <kbd className="font-sans text-dim">{shortcutLabel('add.menu')}</kbd>
          {t.outliner.empty.after}
        </p>
      ) : (
        <div
          role="listbox"
          aria-label={t.outliner.objects}
          aria-multiselectable
          className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-1.5 pb-2"
        >
          {order.map((id) => (
            <Row key={id} id={id} />
          ))}
        </div>
      )}
    </section>
  );
}
