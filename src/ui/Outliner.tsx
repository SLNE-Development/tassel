import { Box, ChevronRight, Eye, EyeOff, Folder, FolderOpen } from 'lucide-react';
import { memo, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { selectDocState, useApp } from '../app/store';
import { getT, useT } from '../i18n';
import { dispatch, shortcutLabel } from './actions';
import { PortOutliner } from './factory/PortOutliner';
import { DeleteGroupDialog, OutlinerContextMenu } from './OutlinerMenu';
import { setCollapsed, useOutliner } from './outlinerState';
import { buildRows, dragPayload, groupSummary, parseRowKey, resolveDrop, rowKey, type DropPosition, type RowKind, type RowRef } from './outlinerTree';
import { useUi } from './uiStore';

/** Indentation per nesting level and the left padding of top-level rows, in pixels. */
const INDENT = 16;
const PAD = 10;
const DRAG_THRESHOLD_PX = 5;

function RenameInput({ kind, id, name }: { kind: RowKind; id: string; name: string }) {
  const done = useRef(false);
  const t = useT();
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    useUi.setState({ renamingId: null });
    const next = value?.trim();
    if (next && next !== name) void dispatch(kind === 'group' ? 'group.rename' : 'scene.rename_object', { id, name: next });
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
        if (e.key !== 'Enter' && e.key !== 'Escape') return;
        // The keyboard focus goes back to the row, so that the arrow keys carry on from there.
        const row = e.currentTarget.closest<HTMLElement>('[data-row]');
        finish(e.key === 'Enter' ? e.currentTarget.value : null);
        row?.focus();
      }}
    />
  );
}

const isRow = (el: Element | null): el is HTMLElement => el instanceof HTMLElement && el.dataset.row !== undefined;
const depthOf = (el: HTMLElement) => Number(el.dataset.depth);

/**
 * Keys every row shares: Enter / Space select, F2 renames, Up / Down move the focus, Left / Right
 * collapse and expand a group or step to the parent / first child.
 */
function onRowKeyDown(e: KeyboardEvent<HTMLDivElement>, row: RowRef, select: (e: KeyboardEvent) => void, expanded?: boolean) {
  if (e.target !== e.currentTarget) return;
  const el = e.currentTarget;
  const focus = (target: Element | null) => {
    if (isRow(target)) target.focus();
  };
  switch (e.key) {
    case 'Enter':
    case ' ':
      select(e);
      break;
    case 'F2':
      useUi.setState({ renamingId: row.id });
      break;
    case 'ArrowDown':
      focus(el.nextElementSibling);
      break;
    case 'ArrowUp':
      focus(el.previousElementSibling);
      break;
    case 'ArrowLeft': {
      if (expanded) {
        setCollapsed(row.id, true);
        break;
      }
      let parent = el.previousElementSibling;
      while (isRow(parent) && depthOf(parent) >= depthOf(el)) parent = parent.previousElementSibling;
      focus(parent);
      break;
    }
    case 'ArrowRight': {
      if (expanded === false) setCollapsed(row.id, false);
      else if (expanded && isRow(el.nextElementSibling) && depthOf(el.nextElementSibling) > depthOf(el)) focus(el.nextElementSibling);
      break;
    }
    default:
      return;
  }
  e.preventDefault();
}

const rowClass = 'group relative flex h-7 shrink-0 cursor-pointer items-center gap-2 rounded-md pr-1 outline-offset-[-2px]';
const eyeClass = 'flex size-6 shrink-0 items-center justify-center rounded hover:bg-line-strong hover:text-text focus-visible:opacity-100';

interface RowProps {
  id: string;
  depth: number;
  /** Roving tab stop of the tree. */
  tabStop: boolean;
}

const ObjectRow = memo(function ObjectRow({ id, depth, tabStop }: RowProps) {
  const name = useApp((s) => selectDocState(s).objects[id]?.name ?? '');
  const visible = useApp((s) => selectDocState(s).objects[id]?.visible ?? true);
  const selected = useApp((s) => selectDocState(s).selection.includes(id));
  const active = useApp((s) => selectDocState(s).activeId === id);
  const renaming = useUi((s) => s.renamingId === id);
  const dragged = useOutliner((s) => s.drag?.dragged.has(id) ?? false);
  const t = useT();

  const select = (e: MouseEvent | KeyboardEvent) =>
    void dispatch('scene.select', { ids: [id], mode: e.ctrlKey || e.metaKey || e.shiftKey ? 'toggle' : 'replace' });

  return (
    <div
      role="treeitem"
      data-row=""
      data-kind="object"
      data-id={id}
      data-depth={depth}
      aria-label={name}
      aria-level={depth + 1}
      aria-selected={selected}
      tabIndex={tabStop ? 0 : -1}
      style={{ paddingLeft: PAD + depth * INDENT }}
      className={`${rowClass} ${
        active ? 'bg-accent/16 text-text' : selected ? 'bg-accent/8 text-text' : 'text-dim hover:bg-raised hover:text-text'
      } ${dragged ? 'opacity-45' : ''}`}
      onClick={select}
      onDoubleClick={() => useUi.setState({ renamingId: id })}
      onKeyDown={(e) => onRowKeyDown(e, { kind: 'object', id }, select)}
    >
      {active && <span aria-hidden className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-accent" />}
      <Box size={14} strokeWidth={1.75} className={`shrink-0 ${selected ? 'text-accent' : 'text-faint'} ${visible ? '' : 'opacity-40'}`} />
      {renaming ? (
        <RenameInput kind="object" id={id} name={name} />
      ) : (
        <span className={`min-w-0 flex-1 truncate ${visible ? '' : 'text-faint'}`}>{name}</span>
      )}
      <button
        aria-label={visible ? t.outliner.hide(name) : t.outliner.show(name)}
        aria-pressed={!visible}
        className={`${eyeClass} ${visible ? 'text-faint opacity-0 group-hover:opacity-100' : 'text-dim'}`}
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

const GroupRow = memo(function GroupRow({ id, depth, tabStop }: RowProps) {
  const name = useApp((s) => selectDocState(s).groups[id]?.name ?? '');
  // One primitive, so that the row only re-renders when what it shows changes.
  const summary = useApp((s) => {
    const state = selectDocState(s);
    if (!state.groups[id]) return '0|none|none';
    const { count, selected, visible } = groupSummary(state, id);
    return `${count}|${selected}|${visible}`;
  });
  const [countText, selected, visible] = summary.split('|');
  const count = Number(countText);
  const collapsed = useOutliner((s) => Boolean(s.collapsed[id]));
  const renaming = useUi((s) => s.renamingId === id);
  const dragged = useOutliner((s) => s.drag?.dragged.has(id) ?? false);
  const dropState = useOutliner((s) =>
    s.drag?.drop?.kind === 'into' && s.drag.drop.targetGroupId === id ? (s.drag.valid ? 'ok' : 'invalid') : null,
  );
  const t = useT();

  const select = (e: MouseEvent | KeyboardEvent) =>
    void dispatch('group.select', { id, mode: e.ctrlKey || e.metaKey || e.shiftKey ? 'toggle' : 'replace' });

  const hidden = count > 0 && visible === 'none';
  const FolderIcon = collapsed ? Folder : FolderOpen;
  return (
    <div
      role="treeitem"
      data-row=""
      data-kind="group"
      data-id={id}
      data-depth={depth}
      data-selected={selected}
      aria-label={t.grouping.rowLabel(name, count)}
      aria-level={depth + 1}
      aria-expanded={!collapsed}
      aria-selected={selected === 'all'}
      tabIndex={tabStop ? 0 : -1}
      style={{ paddingLeft: PAD - 4 + depth * INDENT }}
      className={`${rowClass} ${selected === 'all' ? 'bg-accent/8 text-text' : selected === 'some' ? 'text-text hover:bg-raised' : 'text-dim hover:bg-raised hover:text-text'} ${
        dropState === 'ok' ? 'outline-2 outline-accent' : dropState === 'invalid' ? 'outline-2 outline-danger' : ''
      } ${dragged ? 'opacity-45' : ''}`}
      onClick={select}
      onDoubleClick={() => useUi.setState({ renamingId: id })}
      onKeyDown={(e) => onRowKeyDown(e, { kind: 'group', id }, select, !collapsed)}
    >
      <button
        tabIndex={-1}
        aria-label={collapsed ? t.grouping.expand(name) : t.grouping.collapse(name)}
        className="-mr-1.5 flex size-4.5 shrink-0 items-center justify-center rounded text-faint hover:bg-line-strong hover:text-text"
        onClick={(e) => {
          e.stopPropagation();
          setCollapsed(id, !collapsed);
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <ChevronRight size={13} strokeWidth={2} className={`transition-transform duration-100 motion-reduce:transition-none ${collapsed ? '' : 'rotate-90'}`} />
      </button>
      <FolderIcon
        size={14}
        strokeWidth={1.75}
        className={`shrink-0 ${selected === 'all' ? 'text-accent' : selected === 'some' ? 'text-accent/60' : 'text-faint'} ${hidden ? 'opacity-40' : ''}`}
      />
      {renaming ? (
        <RenameInput kind="group" id={id} name={name} />
      ) : (
        <span className={`min-w-0 flex-1 truncate font-medium ${hidden ? 'text-faint' : ''}`}>{name}</span>
      )}
      {/* A partly selected group: a hollow brass dot. */}
      {selected === 'some' && <span aria-hidden className="size-1.5 shrink-0 rounded-full ring-1 ring-accent" />}
      {!renaming && <span className="tnum shrink-0 pr-0.5 text-[calc(12px*var(--font-scale))] text-faint">{count || ''}</span>}
      <button
        disabled={count === 0}
        aria-label={visible === 'all' ? t.outliner.hide(name) : t.outliner.show(name)}
        aria-pressed={visible === 'all' ? false : visible === 'some' ? 'mixed' : true}
        className={`${eyeClass} disabled:invisible ${visible === 'all' ? 'text-faint opacity-0 group-hover:opacity-100' : visible === 'some' ? 'text-faint' : 'text-dim'}`}
        onClick={(e) => {
          e.stopPropagation();
          void dispatch('group.set_visible', { id, visible: visible !== 'all' });
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {/* Mixed: the eye stays in view, dimmed, and the next click shows everything. */}
        {visible === 'none' ? <EyeOff size={14} /> : <Eye size={14} className={visible === 'some' ? 'opacity-55' : ''} />}
      </button>
    </div>
  );
});

// ---------------------------------------------------------------- drag and drop (pointer based)

const rowAt = (el: Element | null): HTMLElement | null => el?.closest<HTMLElement>('[data-row]') ?? null;
const refOf = (el: HTMLElement): RowRef => ({ kind: el.dataset.kind as RowKind, id: el.dataset.id! });

/** Where in the tree the pointer is, or undefined if that cannot be told (between two rows). */
function dropPosition(list: HTMLElement, x: number, y: number): DropPosition | undefined {
  const el = rowAt(document.elementFromPoint(x, y));
  if (!el || !list.contains(el)) {
    const all = list.querySelectorAll<HTMLElement>('[data-row]');
    const last = all[all.length - 1];
    return !last || y > last.getBoundingClientRect().bottom ? null : undefined;
  }
  const rect = el.getBoundingClientRect();
  const at = (y - rect.top) / rect.height;
  const row = { ...refOf(el), depth: depthOf(el) };
  if (row.kind === 'object') return { row, part: at < 0.5 ? 'before' : 'after' };
  // Below an open group with contents there is no "after": the next row down is inside it.
  const next = el.nextElementSibling;
  const open = isRow(next) && depthOf(next) > row.depth;
  return { row, part: at < 0.25 ? 'before' : at > 0.75 && !open ? 'after' : 'into' };
}

/** Starts watching a press on a row; it becomes a drag once the pointer has moved far enough. */
function watchDrag(down: ReactPointerEvent<HTMLDivElement>): void {
  const list = down.currentTarget;
  const target = down.target as Element;
  const source = rowAt(target);
  if (down.button !== 0 || !source || target.closest('button, input')) return;
  const origin = { x: down.clientX, y: down.clientY };
  let dragging = false;

  const update = (e: PointerEvent) => {
    const drag = useOutliner.getState().drag;
    if (!drag) return;
    const bounds = list.getBoundingClientRect();
    // Pointer positions are in viewport pixels, CSS lengths are not once the interface is zoomed (CSS zoom in a browser).
    const zoom = bounds.width / list.offsetWidth || 1;
    const at = { x: e.clientX / zoom, y: e.clientY / zoom };
    // Near the top or bottom edge the list scrolls along.
    if (e.clientY < bounds.top + 18) list.scrollTop -= 12;
    else if (e.clientY > bounds.bottom - 18) list.scrollTop += 12;

    const inside = e.clientX >= bounds.left && e.clientX <= bounds.right && e.clientY >= bounds.top && e.clientY <= bounds.bottom;
    const position = inside ? dropPosition(list, e.clientX, e.clientY) : undefined;
    if (!inside) return useOutliner.setState({ drag: { ...drag, ...at, drop: null, valid: false, line: null } });
    if (position === undefined) return useOutliner.setState({ drag: { ...drag, ...at } });

    const result = resolveDrop(selectDocState(useApp.getState()), drag.payload, position);
    let line = null;
    if (result.drop.kind === 'line' && result.changes) {
      const { row, after } = result.drop;
      const el = list.querySelector<HTMLElement>(`[data-row][data-id="${row.id}"]`);
      if (el) line = { top: el.offsetTop + (after ? el.offsetHeight : 0), left: PAD - 4 + row.depth * INDENT };
    }
    useOutliner.setState({
      drag: { ...drag, ...at, drop: result.changes || !result.valid ? result.drop : null, valid: result.valid, line },
    });
  };

  const move = (e: PointerEvent) => {
    if (!dragging) {
      if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) < DRAG_THRESHOLD_PX) return;
      dragging = true;
      const state = selectDocState(useApp.getState());
      const row = refOf(source);
      if (!(row.kind === 'group' ? state.groups[row.id] : state.objects[row.id])) return stop();
      const payload = dragPayload(state, row);
      const total = payload.objectIds.length + payload.groupIds.length;
      const label = total === 1 ? (row.kind === 'group' ? state.groups[row.id].name : state.objects[row.id].name) : getT().grouping.items(total);
      useOutliner.setState({
        drag: { payload, dragged: new Set([...payload.objectIds, ...payload.groupIds]), label, x: 0, y: 0, drop: null, valid: false, line: null },
      });
    }
    update(e);
  };

  const stop = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', stop);
    window.removeEventListener('keydown', key, true);
    useOutliner.setState({ drag: null });
  };

  const up = () => {
    const drag = useOutliner.getState().drag;
    stop();
    if (!dragging) return;
    // The release must not also count as a click on the row under the pointer.
    const swallow = (e: Event) => e.stopPropagation();
    window.addEventListener('click', swallow, true);
    setTimeout(() => window.removeEventListener('click', swallow, true));
    if (!drag?.drop || !drag.valid) return;
    const { drop, payload } = drag;
    if (drop.targetGroupId !== null && drop.kind === 'into') setCollapsed(drop.targetGroupId, false);
    void dispatch('group.move', { ...payload, targetGroupId: drop.targetGroupId, ...(drop.kind === 'line' ? { index: drop.index } : {}) });
  };

  const key = (e: globalThis.KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    dragging = false;
    stop();
  };

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', stop);
  window.addEventListener('keydown', key, true);
}

/** What shows a drag: the insertion line, the label at the pointer and the cursor. */
function DragFeedback() {
  const drag = useOutliner((s) => s.drag);
  if (!drag) return null;
  const allowed = drag.valid;
  return (
    <>
      <style>{`* { cursor: ${allowed ? 'grabbing' : 'not-allowed'} !important; }`}</style>
      {drag.line && drag.valid && (
        <div aria-hidden className="pointer-events-none absolute right-1.5 z-10 h-0.5 -translate-y-1/2 rounded-full bg-accent" style={{ top: drag.line.top, left: drag.line.left }}>
          <span className="absolute top-1/2 -left-1 size-2 -translate-y-1/2 rounded-full border-2 border-accent bg-panel" />
        </div>
      )}
      <div
        aria-hidden
        className={`pointer-events-none fixed z-60 max-w-48 truncate rounded-md border bg-overlay px-2 py-1 text-[calc(12px*var(--font-scale))] shadow-pop ${
          allowed ? 'border-line-strong text-text' : 'border-line text-faint'
        }`}
        style={{ left: drag.x + 14, top: drag.y + 12 }}
      >
        {drag.label}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- panel

/** Right-click: the menu is about the row under the pointer, which becomes the selection if it is not part of it. */
function prepareMenu(e: MouseEvent): void {
  const el = rowAt(e.target as Element);
  const target = el ? refOf(el) : null;
  useOutliner.setState({ menuTarget: target });
  if (!target) return;
  const state = selectDocState(useApp.getState());
  if (target.kind === 'object') {
    if (!state.selection.includes(target.id)) void dispatch('scene.select', { ids: [target.id] });
  } else if (state.groups[target.id]) {
    const { count, selected } = groupSummary(state, target.id);
    if (count > 0 && selected !== 'all') void dispatch('group.select', { id: target.id });
  }
}

export function Outliner() {
  const objectCount = useApp((s) => selectDocState(s).order.length);
  const collapsed = useOutliner((s) => s.collapsed);
  const keys = useApp(useShallow((s) => buildRows(selectDocState(s), collapsed).map(rowKey)));
  const activeId = useApp((s) => selectDocState(s).activeId);
  const rootDrop = useOutliner((s) => (s.drag?.drop?.kind === 'into' && s.drag.drop.targetGroupId === null ? (s.drag.valid ? 'ok' : 'invalid') : null));
  const t = useT();

  const rows = keys.map(parseRowKey);
  // Roving tab stop: the active object's row, or the first row if that one is not in view.
  const tabStop = rows.find((row) => row.kind === 'object' && row.id === activeId) ?? rows[0];

  return (
    <section aria-label={t.outliner.title} className="flex min-h-0 min-w-0 flex-col">
      <header className="flex h-8 shrink-0 items-center justify-between pr-3 pl-3">
        <h2 className="text-[calc(12px*var(--font-scale))] font-semibold text-dim">{t.outliner.title}</h2>
        <span className="tnum text-[calc(12px*var(--font-scale))] text-faint">{objectCount || ''}</span>
      </header>
      <OutlinerContextMenu className="flex min-h-0 flex-1 flex-col">
        {/* The menu is prepared in the capture phase, before the trigger opens it. */}
        <div className="flex min-h-0 flex-1 flex-col" onContextMenuCapture={prepareMenu}>
          {rows.length === 0 ? (
            <p className="px-3 pt-1 pb-4 text-[calc(12.5px*var(--font-scale))] leading-relaxed text-faint">
              {t.outliner.empty.before}
              <kbd className="font-sans text-dim">{shortcutLabel('add.menu')}</kbd>
              {t.outliner.empty.after}
            </p>
          ) : (
            <div
              role="tree"
              aria-label={t.outliner.objects}
              aria-multiselectable
              className={`relative mx-1.5 mb-2 flex min-h-0 flex-1 flex-col gap-px overflow-y-auto rounded-md ${
                rootDrop === 'ok' ? 'outline-1 outline-accent/70' : ''
              }`}
              onPointerDown={watchDrag}
            >
              {rows.map((row) =>
                row.kind === 'group' ? (
                  <GroupRow key={row.id} id={row.id} depth={row.depth} tabStop={row === tabStop} />
                ) : (
                  <ObjectRow key={row.id} id={row.id} depth={row.depth} tabStop={row === tabStop} />
                ),
              )}
              <DragFeedback />
            </div>
          )}
        </div>
      </OutlinerContextMenu>
      {/* Factory models: their ports, below the object tree (renders nothing for other documents). */}
      <PortOutliner />
      <DeleteGroupDialog />
    </section>
  );
}
