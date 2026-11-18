import { AlertDialog } from '@base-ui/react/alert-dialog';
import { ContextMenu } from '@base-ui/react/context-menu';
import { Copy, CornerLeftUp, Eye, EyeOff, Folder, FolderInput, FolderPlus, Group, PencilLine, Trash2, Ungroup, type LucideIcon } from 'lucide-react';
import { useRef, type ReactNode } from 'react';
import { selectDocState, useApp } from '../app/store';
import { groupWithDescendants, objectsInGroup } from '../core/groups';
import { useT } from '../i18n';
import { dispatch, formatCombo, runAction, shortcutLabel } from './actions';
import { newEmptyGroup, requestDeleteGroup } from './groupActions';
import { itemClass, MenuSeparator, popupClass, Submenu } from './menu';
import { useOutliner } from './outlinerState';
import { buildRows } from './outlinerTree';
import { notifyError } from './toast';
import { useUi } from './uiStore';

function Item({
  icon: Icon,
  title,
  shortcut,
  disabled,
  indent = 0,
  onClick,
}: {
  icon?: LucideIcon;
  title: string;
  shortcut?: string;
  disabled?: boolean;
  indent?: number;
  onClick(): unknown;
}) {
  const run = () => {
    try {
      Promise.resolve(onClick()).catch(notifyError);
    } catch (error) {
      notifyError(error);
    }
  };
  return (
    <ContextMenu.Item className={itemClass} disabled={disabled} onClick={run}>
      <span className="flex w-4 shrink-0 justify-center" style={{ marginLeft: indent * 12 }}>
        {Icon && <Icon size={15} strokeWidth={1.75} />}
      </span>
      <span className="min-w-0 truncate">{title}</span>
      {shortcut && <span className="tnum ml-auto pl-6 text-[calc(12px*var(--font-scale))] opacity-60">{shortcut}</span>}
    </ContextMenu.Item>
  );
}

/** The submenu that lists every group as a move target. `moving` is the group being moved, if it is one. */
function MoveTargets({ moving, onMove }: { moving: string | null; onMove(targetGroupId: string | null): unknown }) {
  const state = useApp(selectDocState);
  const t = useT();
  const blocked = moving ? groupWithDescendants(state, moving) : new Set<string>();
  // Where everything that would move already is; moving there changes nothing.
  const parents = new Set(moving ? [state.groups[moving]?.parentId ?? null] : state.selection.map((id) => state.objects[id].groupId));
  const current = parents.size === 1 ? [...parents][0] : undefined;
  const groups = buildRows(state, {}).filter((row) => row.kind === 'group');
  return (
    <>
      <Item icon={CornerLeftUp} title={t.grouping.topLevel} disabled={current === null} onClick={() => onMove(null)} />
      {groups.length > 0 && <MenuSeparator />}
      {groups.map((row) => (
        <Item
          key={row.id}
          icon={Folder}
          indent={row.depth}
          title={state.groups[row.id].name}
          disabled={blocked.has(row.id) || current === row.id}
          onClick={() => onMove(row.id)}
        />
      ))}
    </>
  );
}

/** Contents of the outliner's context menu. Only mounted while the menu is open. */
function Items({ startRename }: { startRename(id: string): void }) {
  const target = useOutliner((s) => s.menuTarget);
  const state = useApp(selectDocState);
  const t = useT();
  const hasSelection = state.selection.length > 0;
  const editing = state.edit !== null;

  const create = (
    <>
      <Item icon={Group} title={t.grouping.group} shortcut={shortcutLabel('edit.group')} disabled={editing || !hasSelection} onClick={() => runAction('edit.group')} />
      <Item
        icon={FolderPlus}
        title={t.grouping.newEmpty}
        onClick={() => newEmptyGroup(target?.kind === 'group' ? target.id : null)}
      />
    </>
  );

  if (target?.kind === 'group' && state.groups[target.id]) {
    const id = target.id;
    const ids = objectsInGroup(state, id);
    const allVisible = ids.every((o) => state.objects[o].visible);
    return (
      <>
        {create}
        <Item icon={Ungroup} title={t.grouping.ungroup} shortcut={shortcutLabel('edit.ungroup')} onClick={() => dispatch('group.ungroup', { id })} />
        <MenuSeparator />
        <Item icon={PencilLine} title={t.grouping.rename} shortcut="F2" onClick={() => startRename(id)} />
        <Item icon={Copy} title={t.grouping.duplicate} shortcut={shortcutLabel('edit.duplicate')} disabled={ids.length === 0} onClick={() => dispatch('scene.duplicate_objects', { ids })} />
        <Item
          icon={allVisible ? EyeOff : Eye}
          title={allVisible ? t.grouping.hide : t.grouping.show}
          disabled={ids.length === 0}
          onClick={() => dispatch('group.set_visible', { id, visible: !allVisible })}
        />
        <Submenu title={t.grouping.moveTo} icon={FolderInput}>
          <MoveTargets moving={id} onMove={(targetGroupId) => dispatch('group.move', { groupIds: [id], targetGroupId })} />
        </Submenu>
        <MenuSeparator />
        <Item icon={Trash2} title={t.grouping.deleteGroup} onClick={() => requestDeleteGroup(id)} />
      </>
    );
  }

  if (target?.kind === 'object' && state.objects[target.id]) {
    const id = target.id;
    const ids = state.selection.includes(id) ? state.selection : [id];
    const allVisible = ids.every((o) => state.objects[o].visible);
    const groupId = state.objects[id].groupId;
    return (
      <>
        {create}
        <Item
          icon={Ungroup}
          title={t.grouping.ungroup}
          shortcut={shortcutLabel('edit.ungroup')}
          disabled={groupId === null}
          onClick={() => dispatch('group.ungroup', { id: groupId })}
        />
        <MenuSeparator />
        <Item icon={PencilLine} title={t.grouping.rename} shortcut="F2" onClick={() => startRename(id)} />
        <Item icon={Copy} title={t.grouping.duplicate} shortcut={shortcutLabel('edit.duplicate')} onClick={() => dispatch('scene.duplicate_objects', { ids })} />
        <Item
          icon={allVisible ? EyeOff : Eye}
          title={allVisible ? t.grouping.hide : t.grouping.show}
          onClick={() => dispatch('scene.set_visible', { ids, visible: !allVisible })}
        />
        <Submenu title={t.grouping.moveTo} icon={FolderInput}>
          <MoveTargets moving={null} onMove={(targetGroupId) => dispatch('group.move', { objectIds: ids, targetGroupId })} />
        </Submenu>
        <MenuSeparator />
        <Item icon={Trash2} title={t.grouping.delete} shortcut={formatCombo('Delete')} onClick={() => dispatch('scene.delete_objects', { ids })} />
      </>
    );
  }

  return create;
}

/** Wraps the outliner body: right-click opens the menu for the row under the pointer (see `menuTarget`). */
export function OutlinerContextMenu({ className, children }: { className?: string; children: ReactNode }) {
  // Renaming starts once the menu is gone, and the menu then keeps its hands off the focus: giving it
  // back to where it was would end the rename right away.
  const renameAfterClose = useRef<string | null>(null);
  return (
    <ContextMenu.Root
      onOpenChange={(open) => {
        if (open) renameAfterClose.current = null;
      }}
      onOpenChangeComplete={(open) => {
        if (!open && renameAfterClose.current) useUi.setState({ renamingId: renameAfterClose.current });
      }}
    >
      <ContextMenu.Trigger className={className}>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="z-50 outline-none">
          <ContextMenu.Popup className={popupClass} finalFocus={() => (renameAfterClose.current ? false : undefined)}>
            <Items startRename={(id) => (renameAfterClose.current = id)} />
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

const buttonBase = 'h-8 rounded-md px-3.5 text-[calc(13px*var(--font-scale))] font-medium';

/** Asks before a group is deleted together with the objects in it. */
export function DeleteGroupDialog() {
  const id = useOutliner((s) => s.deleteGroupId);
  const name = useApp((s) => (id ? selectDocState(s).groups[id]?.name : undefined));
  const count = useApp((s) => (id && selectDocState(s).groups[id] ? objectsInGroup(selectDocState(s), id).length : 0));
  const t = useT();
  const close = () => useOutliner.setState({ deleteGroupId: null });
  return (
    <AlertDialog.Root open={id !== null && name !== undefined} onOpenChange={(next) => !next && close()}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-40 bg-black/45" />
        <AlertDialog.Popup className="anim-pop fixed top-[24vh] left-1/2 z-50 w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 rounded-xl border border-line-strong bg-overlay p-5 shadow-pop">
          <AlertDialog.Title className="font-display text-[calc(15px*var(--font-scale))] font-semibold text-text">
            {t.grouping.deleteTitle(name ?? '')}
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-1.5 text-[calc(13px*var(--font-scale))] leading-relaxed text-dim">
            {t.grouping.deleteText(count)}
          </AlertDialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Close className={`${buttonBase} mr-auto text-dim hover:bg-raised hover:text-text`}>{t.dialogs.cancel}</AlertDialog.Close>
            <button
              className={`${buttonBase} text-danger ring-1 ring-danger/40 ring-inset hover:bg-danger/12`}
              onClick={() => {
                close();
                if (id) void dispatch('group.delete', { id });
              }}
            >
              {t.grouping.deleteGroup}
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
