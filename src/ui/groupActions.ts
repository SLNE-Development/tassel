// What the outliner, its context menu and the group shortcuts do. Everything goes through commands.
import { execute, selectDocState, useApp } from '../app/store';
import { objectsInGroup } from '../core/groups';
import { getT } from '../i18n';
import { setCollapsed, useOutliner } from './outlinerState';
import { groupPath } from './outlinerTree';
import { notifyInfo } from './toast';
import { useUi } from './uiStore';

const docState = () => selectDocState(useApp.getState());

/** Opens the group's ancestors (and the group itself) so that its row and contents are visible. */
export function revealGroup(id: string): void {
  for (const groupId of groupPath(docState(), id)) setCollapsed(groupId, false);
}

/** Creates a group and starts renaming it inline, so that typing a name is the next thing that happens. */
async function createGroup(params: { ids: string[]; parentId?: string | null }): Promise<void> {
  const { id } = (await execute('group.create', { ...params, name: getT().grouping.defaultName })) as { id: string };
  revealGroup(id);
  useUi.setState({ renamingId: id });
}

/** Ctrl+G: puts the selected objects into a new group. */
export function groupSelection(): unknown {
  const { selection } = docState();
  if (selection.length === 0) return notifyInfo(getT().toasts.nothingSelected);
  return createGroup({ ids: [...selection] });
}

/** A new empty group inside `parentId` (null = top level). */
export function newEmptyGroup(parentId: string | null = null): Promise<void> {
  return createGroup({ ids: [], parentId });
}

/**
 * The group Ctrl+Shift+G dissolves: the active object's group, or the outermost group around it
 * whose objects are all selected (the "selected group").
 */
export function groupToUngroup(): string | null {
  const state = docState();
  const start = state.activeId ? (state.objects[state.activeId]?.groupId ?? null) : null;
  if (start === null) return null;
  const selection = new Set(state.selection);
  let groupId: string = start;
  for (;;) {
    const parent: string | null = state.groups[groupId].parentId;
    if (parent === null || !objectsInGroup(state, parent).every((id) => selection.has(id))) return groupId;
    groupId = parent;
  }
}

export function ungroupSelection(): unknown {
  const id = groupToUngroup();
  if (id === null) return notifyInfo(getT().grouping.noGroup, getT().grouping.noGroupHint);
  return execute('group.ungroup', { id });
}

/** Deletes a group; asks first if objects would go with it. */
export function requestDeleteGroup(id: string): unknown {
  const state = docState();
  if (!state.groups[id]) return;
  if (objectsInGroup(state, id).length > 0) return useOutliner.setState({ deleteGroupId: id });
  return execute('group.delete', { id });
}
