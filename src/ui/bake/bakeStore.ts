import { create } from 'zustand';
import { selectDocState, useApp } from '../../app/store';
import { getT } from '../../i18n';
import { notifyInfo } from '../toast';

/** The bake dialog: closed (null), or open for one target object. */
export const useBakeDialog = create<{ targetId: string | null }>(() => ({ targetId: null }));

/** Opens the bake dialog for the active object. */
export function openBakeDialog(): void {
  const state = selectDocState(useApp.getState());
  if (!state.activeId) return notifyInfo(getT().bake.noActive, getT().bake.noActiveHint);
  useBakeDialog.setState({ targetId: state.activeId });
}
