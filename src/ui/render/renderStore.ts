import { create } from 'zustand';
import { selectDocState, useApp } from '../../app/store';
import { getT } from '../../i18n';
import { notifyInfo } from '../toast';

/** The render dialog: open or closed. */
export const useRenderDialog = create<{ open: boolean }>(() => ({ open: false }));

/** Opens the render dialog for the active document (F12 closes it again). */
export function openRenderDialog(): void {
  if (useRenderDialog.getState().open) return useRenderDialog.setState({ open: false });
  const state = selectDocState(useApp.getState());
  if (!state.order.some((id) => state.objects[id].visible)) return notifyInfo(getT().render.nothing, getT().render.nothingHint);
  useRenderDialog.setState({ open: true });
}
