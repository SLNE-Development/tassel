import { Menu } from '@base-ui/react/menu';
import { ChevronsDownUp, ChevronsUpDown, PanelLeft, PanelRight, X } from 'lucide-react';
import { useMemo, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { useApp } from '../../app/store';
import { useT } from '../../i18n';
import { useDocFormat } from '../format';
import { itemClass, popupClass } from '../menu';
import { dropAt, type ColumnBox, type DockGeometry, type Drop, type GroupBox } from './dropZones';
import { closePanel, movePanel, openPanel, setCollapsed, setColumnWidth, updateLayout, useLayout } from './layoutStore';
import * as model from './model';
import type { DockColumn, DockGroup, Side } from './model';
import { isShown, usePanelRegistry, type PanelContext, type PanelDef } from './registry';

// The two sidebars: their columns, the groups stacked in them, the tabs of a group, the dividers that
// resize them, and dragging panels by their header to dock them elsewhere.

/** The centre keeps at least this width (CSS px) when a sidebar is widened. */
const MIN_CENTRE_WIDTH = 320;
/** Pointer travel (screen px) before pressing a header becomes a drag. */
const DRAG_THRESHOLD = 5;
const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;

/** Elements in a panel header that keep their own pointer behaviour (no drag from there). */
const INTERACTIVE = 'button, input, select, textarea, a, [role="button"], [role="menuitem"], [role="switch"], [role="slider"], [role="tab"], [contenteditable="true"], [data-no-dock-drag]';

interface DragState {
  panelId: string;
  title: string;
  x: number;
  y: number;
  /** Screen px per CSS px (a CSS zoom of the interface in a plain browser). */
  zoom: number;
  drop: Drop | null;
}

interface DockUi {
  drag: DragState | null;
  menu: { panelId: string; groupId: string; x: number; y: number } | null;
}

const useDockUi = create<DockUi>(() => ({ drag: null, menu: null }));

/** What decides which panels have something to show right now. */
export function usePanelContext(): PanelContext {
  const format = useDocFormat();
  const workspace = useApp((s) => s.workspace);
  // Item definitions have no scene of their own and always show the modelling layout.
  return useMemo(() => ({ format, workspace: format === 'minecraft_item' ? 'modeling' : workspace }), [format, workspace]);
}

/** Screen px per layout px of an element (1 unless the interface is zoomed with CSS). */
const zoomOf = (element: HTMLElement) => element.getBoundingClientRect().width / (element.offsetWidth || 1) || 1;

const centreElement = () => document.querySelector<HTMLElement>('[data-dock-centre]');

// ---- dragging panels -----------------------------------------------------------------------------

function measure(): DockGeometry {
  const box = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  };
  const layout = useLayout.getState().layout;
  const groups: GroupBox[] = [...document.querySelectorAll<HTMLElement>('[data-dock-group]')].map((el) => ({
    id: el.dataset.dockGroup!,
    columnId: el.dataset.dockColumnId!,
    rect: box(el),
  }));
  const columns: ColumnBox[] = [...document.querySelectorAll<HTMLElement>('[data-dock-column]')].map((el) => ({
    id: el.dataset.dockColumn!,
    side: el.dataset.dockSide as Side,
    index: Number(el.dataset.dockIndex),
    rect: box(el),
  }));
  const centre = centreElement();
  return {
    groups,
    columns,
    centre: centre ? box(centre) : { left: 0, top: 0, width: 0, height: 0 },
    columnCount: { left: layout.left.length, right: layout.right.length },
  };
}

/** Starts watching a press on a panel header or tab; past a few pixels it becomes a drag that docks the panel where it is dropped. */
function pressPanel(event: ReactPointerEvent, panelId: string, title: string, handle: HTMLElement): void {
  if (event.button !== 0) return;
  const startX = event.clientX;
  const startY = event.clientY;
  const zoom = zoomOf(handle);
  let dragging = false;

  const move = (e: PointerEvent) => {
    if (!dragging) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD) return;
      dragging = true;
      document.documentElement.classList.add('dock-dragging');
    }
    let drop = dropAt(e.clientX, e.clientY, measure());
    if (drop && model.isNoopMove(useLayout.getState().layout, panelId, drop.target)) drop = null;
    useDockUi.setState({ drag: { panelId, title, x: e.clientX, y: e.clientY, zoom, drop } });
  };
  const finish = (commit: boolean) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('keydown', key, true);
    document.documentElement.classList.remove('dock-dragging');
    const drop = useDockUi.getState().drag?.drop;
    useDockUi.setState({ drag: null });
    if (commit && dragging && drop) movePanel(panelId, drop.target);
  };
  const up = () => finish(true);
  const cancel = () => finish(false);
  const key = (e: globalThis.KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    finish(false);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
  window.addEventListener('keydown', key, true);
}

/** The panel's own header (or heading) that `target` is in, if it is not one of the header's controls. */
function headerAt(target: EventTarget, host: HTMLElement, allowControls = false): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const root = host.firstElementChild;
  if (!root) return null;
  if (!allowControls && target.closest(INTERACTIVE)) return null;
  for (const handle of [target.closest('header'), target.closest('h2')])
    if (handle instanceof HTMLElement && handle.parentElement === root) return handle;
  return null;
}

/** The drop highlight and the label that follows the pointer while a panel is dragged. */
export function DockOverlay() {
  const drag = useDockUi((s) => s.drag);
  if (!drag) return null;
  const z = drag.zoom;
  const h = drag.drop?.highlight;
  return createPortal(
    <div aria-hidden className="pointer-events-none fixed inset-0 z-[60]">
      {h && (
        <div
          className="absolute rounded-md bg-accent/15 ring-2 ring-accent ring-inset transition-[left,top,width,height] duration-75"
          style={{ left: h.left / z, top: h.top / z, width: h.width / z, height: h.height / z }}
        />
      )}
      <div
        className="absolute rounded-md border border-line-strong bg-overlay px-2 py-1 text-[calc(12px*var(--font-scale))] font-semibold text-text shadow-pop"
        style={{ left: drag.x / z + 12, top: drag.y / z + 10 }}
      >
        {drag.title}
      </div>
    </div>,
    document.body,
  );
}

// ---- panel menu ----------------------------------------------------------------------------------

/** The context menu of a panel header or tab: collapse, move to the other sidebar, close. */
export function DockMenu() {
  const menu = useDockUi((s) => s.menu);
  const layout = useLayout((s) => s.layout);
  const t = useT();
  const at = menu ? model.locatePanel(layout, menu.panelId) : null;
  const close = () => useDockUi.setState({ menu: null });
  const anchor = useMemo(() => {
    const x = menu?.x ?? 0;
    const y = menu?.y ?? 0;
    return { getBoundingClientRect: () => DOMRect.fromRect({ x, y, width: 0, height: 0 }) };
  }, [menu]);
  const item = (key: string, Icon: typeof X, title: string, run: () => void, disabled = false) => (
    <Menu.Item key={key} className={itemClass} disabled={disabled} onClick={run}>
      <span className="flex w-4 shrink-0 justify-center">
        <Icon size={15} strokeWidth={1.75} />
      </span>
      <span>{title}</span>
    </Menu.Item>
  );
  return (
    <Menu.Root open={!!menu && !!at} onOpenChange={(open) => !open && close()}>
      <Menu.Portal>
        <Menu.Positioner anchor={anchor} side="bottom" align="start" sideOffset={2} className="z-50 outline-none">
          <Menu.Popup className={popupClass}>
            {menu && at && (
              <>
                {item('collapse', at.group.collapsed ? ChevronsUpDown : ChevronsDownUp, at.group.collapsed ? t.layout.expand : t.layout.collapse, () =>
                  setCollapsed(at.group.id, !at.group.collapsed),
                )}
                {item('left', PanelLeft, t.layout.moveLeft, () => movePanel(menu.panelId, { kind: 'column', side: 'left', index: layout.left.length }), at.side === 'left' && at.column.groups.length === 1 && at.group.panels.length === 1)}
                {item('right', PanelRight, t.layout.moveRight, () => movePanel(menu.panelId, { kind: 'column', side: 'right', index: 0 }), at.side === 'right' && at.column.groups.length === 1 && at.group.panels.length === 1)}
                <Menu.Separator className="mx-1 my-1 h-px bg-line-strong" />
                {item('close', X, t.layout.closePanel, () => closePanel(menu.panelId))}
              </>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

const openMenu = (event: ReactMouseEvent, panelId: string, groupId: string) => {
  event.preventDefault();
  event.stopPropagation();
  useDockUi.setState({ menu: { panelId, groupId, x: event.clientX, y: event.clientY } });
};

// ---- dividers ------------------------------------------------------------------------------------

function separatorKeys(event: KeyboardEvent, decrease: string, increase: string): number {
  const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
  if (event.key === decrease) return -step;
  if (event.key === increase) return step;
  return 0;
}

/** Resizes a column from its edge towards the centre. */
function ColumnHandle({ column, side, defs }: { column: DockColumn; side: Side; defs: readonly PanelDef[] }) {
  const t = useT();
  const sign = side === 'left' ? 1 : -1;
  /** The widest the column can get without squeezing the centre below its minimum (never less than it is now: narrowing always works). */
  const maxWidth = () => {
    const centre = centreElement();
    return centre ? Math.max(column.width, column.width + centre.offsetWidth - MIN_CENTRE_WIDTH) : model.MAX_COLUMN_WIDTH;
  };
  const resize = (width: number, limit = maxWidth()) => setColumnWidth(column.id, Math.min(limit, width));

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = column.width;
    const limit = maxWidth();
    const zoom = zoomOf(handle.parentElement!);
    document.documentElement.classList.add('dock-resizing-x');
    const move = (e: PointerEvent) => resize(startWidth + (sign * (e.clientX - startX)) / zoom, limit);
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      document.documentElement.classList.remove('dock-resizing-x');
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Arrow keys move the divider in their direction, whichever side the column is on.
    const step = separatorKeys(event, 'ArrowLeft', 'ArrowRight') * sign;
    if (step) resize(column.width + step);
    else if (event.key === 'Home') resize(model.MIN_COLUMN_WIDTH);
    else if (event.key === 'End') resize(model.MAX_COLUMN_WIDTH);
    else if (event.key === 'Enter') resize(model.defaultColumnWidth(column, defs));
    else return;
    event.preventDefault();
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t.layout.resizeColumn}
      aria-valuenow={column.width}
      aria-valuemin={model.MIN_COLUMN_WIDTH}
      aria-valuemax={model.MAX_COLUMN_WIDTH}
      tabIndex={0}
      title={t.layout.resizeHint}
      className={`group absolute inset-y-0 z-30 flex w-2 cursor-col-resize touch-none justify-center outline-none ${side === 'left' ? '-right-1' : '-left-1'}`}
      onPointerDown={onPointerDown}
      onDoubleClick={() => resize(model.defaultColumnWidth(column, defs))}
      onKeyDown={onKeyDown}
    >
      <div className="h-full w-0 group-hover:w-0.5 group-hover:bg-accent group-focus-visible:w-0.5 group-focus-visible:bg-accent group-active:w-0.5 group-active:bg-accent" />
    </div>
  );
}

/** The border between two groups of a column; drags the height between them. */
function GroupDivider({ column, above, below, defs }: { column: DockColumn; above: DockGroup; below: DockGroup; defs: readonly PanelDef[] }) {
  const t = useT();
  const fixed = above.collapsed || below.collapsed;
  const heights = (handle: HTMLElement) => {
    const first = handle.previousElementSibling as HTMLElement;
    const second = handle.nextElementSibling as HTMLElement;
    return { first: first.offsetHeight, total: first.offsetHeight + second.offsetHeight };
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || fixed) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const start = heights(handle);
    const zoom = zoomOf(handle.parentElement!);
    document.documentElement.classList.add('dock-resizing-y');
    const move = (e: PointerEvent) =>
      updateLayout((l) => model.resizeGroupPair(l, above.id, below.id, start.first + (e.clientY - startY) / zoom, start.total));
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      document.documentElement.classList.remove('dock-resizing-y');
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (fixed) return;
    const step = separatorKeys(event, 'ArrowUp', 'ArrowDown');
    if (step) {
      const { first, total } = heights(event.currentTarget);
      updateLayout((l) => model.resizeGroupPair(l, above.id, below.id, first + step, total));
    } else if (event.key === 'Enter') updateLayout((l) => model.resetGroupWeights(l, column.id, defs));
    else return;
    event.preventDefault();
  };
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={t.layout.resizeGroups}
      tabIndex={fixed ? -1 : 0}
      title={fixed ? undefined : t.layout.resizeHint}
      className={`group relative z-20 h-px shrink-0 bg-line outline-none ${fixed ? '' : 'cursor-row-resize'}`}
      onPointerDown={onPointerDown}
      onDoubleClick={() => !fixed && updateLayout((l) => model.resetGroupWeights(l, column.id, defs))}
      onKeyDown={onKeyDown}
    >
      {/* A wider hit area than the visible line. */}
      <div className="absolute inset-x-0 -top-1 h-2 touch-none" />
      <div className="absolute inset-x-0 top-0 h-px group-hover:h-0.5 group-hover:bg-accent group-focus-visible:h-0.5 group-focus-visible:bg-accent group-active:h-0.5 group-active:bg-accent" />
    </div>
  );
}

// ---- groups --------------------------------------------------------------------------------------

function TabStrip({ group, panels, active }: { group: DockGroup; panels: readonly PanelDef[]; active: string }) {
  const t = useT();
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
    const next = event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1 : null;
    if (next !== null) {
      const panel = panels[(next + panels.length) % panels.length];
      openPanel(panel.id);
      (event.currentTarget.parentElement?.children[(next + panels.length) % panels.length] as HTMLElement | undefined)?.focus();
    } else if (event.key === 'Delete') closePanel(panels[index].id);
    else return;
    event.preventDefault();
  };
  return (
    <div role="tablist" aria-label={t.layout.tabs} className="flex h-8 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-line px-1.5">
      {panels.map((panel, index) => {
        const selected = panel.id === active;
        const Icon = panel.icon;
        const title = panel.title(t);
        return (
          <div
            key={panel.id}
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            title={title}
            className={`group/tab flex h-7 min-w-0 shrink cursor-default items-center gap-1.5 rounded-t-md pr-1 pl-2 text-[calc(12px*var(--font-scale))] outline-none select-none focus-visible:ring-1 focus-visible:ring-accent ${
              selected ? 'bg-raised font-semibold text-text' : 'text-dim hover:bg-raised/60 hover:text-text'
            }`}
            onPointerDown={(e) => {
              if ((e.target as Element).closest('button')) return;
              openPanel(panel.id);
              pressPanel(e, panel.id, title, e.currentTarget);
            }}
            onContextMenu={(e) => openMenu(e, panel.id, group.id)}
            onKeyDown={(e) => onKeyDown(e, index)}
          >
            <Icon size={13} strokeWidth={1.75} className="shrink-0" />
            <span className="truncate">{title}</span>
            <button
              type="button"
              aria-label={t.layout.closeNamed(title)}
              tabIndex={-1}
              className="flex size-4.5 shrink-0 items-center justify-center rounded text-faint opacity-0 group-hover/tab:opacity-100 group-focus-visible/tab:opacity-100 hover:bg-line-strong hover:text-text"
              onClick={() => closePanel(panel.id)}
            >
              <X size={12} strokeWidth={2} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function GroupView({ group, column, visible }: { group: DockGroup; column: DockColumn; visible: readonly PanelDef[] }) {
  const t = useT();
  const active = visible.find((p) => p.id === group.active) ?? visible[0];
  const Component = active.component;
  const title = active.title(t);
  return (
    <div
      data-dock-group={group.id}
      data-dock-column-id={column.id}
      className={`flex min-h-0 min-w-0 flex-col overflow-hidden ${group.collapsed ? 'dock-collapsed' : ''}`}
      style={{ flex: group.collapsed ? '0 0 auto' : `${group.weight} 1 0px` }}
    >
      {visible.length > 1 && <TabStrip group={group} panels={visible} active={active.id} />}
      <div
        data-dock-panel={active.id}
        className="dock-panel flex min-h-0 min-w-0 flex-1 flex-col"
        onPointerDown={(e) => {
          const handle = headerAt(e.target, e.currentTarget);
          if (handle) pressPanel(e, active.id, title, handle);
        }}
        onDoubleClick={(e) => headerAt(e.target, e.currentTarget) && setCollapsed(group.id, !group.collapsed)}
        onContextMenu={(e) => headerAt(e.target, e.currentTarget, true) && openMenu(e, active.id, group.id)}
      >
        <Component key={active.id} />
      </div>
    </div>
  );
}

// ---- sidebars ------------------------------------------------------------------------------------

/** One sidebar: its columns, left to right, with what they show in the current workspace and format. */
export function DockSide({ side }: { side: Side }) {
  const columns = useLayout((s) => s.layout[side]);
  const defs = usePanelRegistry((s) => s.panels);
  const context = usePanelContext();
  const t = useT();
  const byId = useMemo(() => new Map(defs.map((d) => [d.id, d])), [defs]);
  const shown = columns
    .map((column, index) => ({
      column,
      index,
      groups: column.groups
        .map((group) => ({ group, visible: group.panels.map((id) => byId.get(id)).filter((d): d is PanelDef => isShown(d, context)) }))
        .filter((g) => g.visible.length > 0),
    }))
    .filter((c) => c.groups.length > 0);
  return (
    <div aria-label={side === 'left' ? t.layout.leftSidebar : t.layout.rightSidebar} role="complementary" className="flex min-h-0 min-w-0">
      {shown.map(({ column, index, groups }) => (
        <div
          key={column.id}
          data-dock-column={column.id}
          data-dock-side={side}
          data-dock-index={index}
          className={`relative flex min-h-0 shrink-0 flex-col bg-panel ${side === 'left' ? 'border-r' : 'border-l'} border-line`}
          style={{ width: column.width }}
        >
          {groups.map(({ group, visible }, i) => (
            <GroupSlot key={group.id} column={column} group={group} visible={visible} previous={i > 0 ? groups[i - 1].group : null} defs={defs} />
          ))}
          <ColumnHandle column={column} side={side} defs={defs} />
        </div>
      ))}
    </div>
  );
}

function GroupSlot({ column, group, visible, previous, defs }: { column: DockColumn; group: DockGroup; visible: readonly PanelDef[]; previous: DockGroup | null; defs: readonly PanelDef[] }) {
  return (
    <>
      {previous && <GroupDivider column={column} above={previous} below={group} defs={defs} />}
      <GroupView group={group} column={column} visible={visible} />
    </>
  );
}
