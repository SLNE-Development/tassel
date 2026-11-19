import { create } from 'zustand';
import { selectDocState, useApp } from '../../app/store';
import { getT } from '../../i18n';
import { notifyInfo } from '../toast';

/** The "Video exportieren" dialog: open or closed. */
export const useVideoDialog = create<{ open: boolean }>(() => ({ open: false }));

/** Opens the export dialog for the active document, if it has anything animated. */
export function openVideoDialog(): void {
  const animation = selectDocState(useApp.getState()).animation;
  if (!animation || (animation.camera.length === 0 && Object.keys(animation.tracks).length === 0)) {
    return notifyInfo(getT().video.nothing, getT().video.nothingHint);
  }
  useVideoDialog.setState({ open: true });
}
