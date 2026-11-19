import { create } from 'zustand';
import type { DisplayTransform } from '../../core/minecraft/display';
import type { GizmoMode } from '../../viewport/display/DisplayView';

/** UI state of the Display workspace that is neither part of the document nor a preference. */
interface DisplayUi {
  gizmo: GizmoMode;
  showGizmo: boolean;
  /** A slot's value copied with "Copy slot". */
  clipboard: DisplayTransform | null;
  presetDialog: boolean;
  /** Bumped to ask the view to put its camera back. */
  cameraReset: number;
}

export const useDisplayUi = create<DisplayUi>(() => ({ gizmo: 'rotate', showGizmo: true, clipboard: null, presetDialog: false, cameraReset: 0 }));
