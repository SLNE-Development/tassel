import { create } from 'zustand';
import { selectDocState, useApp } from '../../app/store';
import type { DocState, SceneObject } from '../../core/types';

export const uvBackgrounds = ['texture', 'checker', 'none'] as const;
export type UvBackground = (typeof uvBackgrounds)[number];

/** Transient state of the UV workspace. */
export interface UvUiState {
  /** Share of the centre the UV editor takes; the 3D viewport gets the rest. */
  split: number;
  background: UvBackground;
  /** Where the unwrap menu opened by its shortcut is shown (client coordinates), or null. */
  unwrapMenuAt: { x: number; y: number } | null;
  clearConfirmOpen: boolean;
  /** Counts requests to frame the 0..1 square. */
  fitRequests: number;
  /** Objects that lost their UVs to a mesh operation and have not been unwrapped again. */
  dropped: Readonly<Record<string, true>>;
}

export const useUvUi = create<UvUiState>(() => ({
  split: 0.5,
  background: 'texture',
  unwrapMenuAt: null,
  clearConfirmOpen: false,
  fitRequests: 0,
  dropped: {},
}));

/** The object whose UVs the editor shows: the one being edited, else the active one. */
export function uvObject(state: DocState): SceneObject | undefined {
  const id = state.edit?.objectId ?? state.activeId;
  return id ? state.objects[id] : undefined;
}

// A mesh operation that changes the topology replaces the faces and drops the UVs. Clearing them
// (or undoing an unwrap) keeps the very same faces array, so the two can be told apart.
useApp.subscribe((app, previous) => {
  const [now, before] = [selectDocState(app), selectDocState(previous)];
  if (now.objects === before.objects || app.activeDocId !== previous.activeDocId) return;
  let dropped = useUvUi.getState().dropped;
  const set = (id: string, lost: boolean) => {
    if (lost === (id in dropped)) return;
    const { [id]: _, ...rest } = dropped;
    dropped = lost ? { ...dropped, [id]: true } : rest;
  };
  for (const id of Object.keys(dropped)) if (!now.objects[id]) set(id, false);
  for (const [id, object] of Object.entries(now.objects)) {
    const old = before.objects[id];
    if (!old || old.mesh === object.mesh) continue;
    if (object.mesh.uvs) set(id, false);
    else if (old.mesh.uvs) set(id, old.mesh.faces !== object.mesh.faces);
  }
  if (dropped !== useUvUi.getState().dropped) useUvUi.setState({ dropped });
});

// The unwrap menu opens at the pointer, like the menus of other modelling tools.
export const pointer = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
window.addEventListener('pointermove', (event) => {
  pointer.x = event.clientX;
  pointer.y = event.clientY;
});
