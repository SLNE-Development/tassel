import { create } from 'zustand';
import { frameOf, pause, setFrame, setTimelineOpen, togglePlay, usePlayback } from '../../app/playback';
import { execute, selectDocState, services, useApp } from '../../app/store';
import { cameraAt } from '../../core/animation';
import { hasKeyAt, lowerBound, navigationLists, neighbourKey, trackChannels, transformChannels } from '../../core/playhead';
import { own } from '../../core/state';
import type { DocState, KeyInterpolation } from '../../core/types';
import { getT, type Dictionary } from '../../i18n';
import type { Action } from '../actions';
import { notifyInfo } from '../toast';
import { openVideoDialog } from './videoStore';

/** Row id of the camera in the timeline; every other row is an object id. */
export const CAMERA_ROW = '\u0000camera';

/** The key marker the user picked in the timeline: what "delete key" and the interpolation menu act on. */
export const useTimeline = create<{ selectedKey: { row: string; frame: number } | null }>(() => ({ selectedKey: null }));

const docState = (): DocState => selectDocState(useApp.getState());
const playhead = () => frameOf(useApp.getState().activeDocId);

/** The picked key if it still exists in the document, else null. */
export function selectedKey(state: DocState = docState()): { row: string; frame: number } | null {
  const key = useTimeline.getState().selectedKey;
  if (!key) return null;
  const animation = state.animation;
  if (!animation) return null;
  const lists = key.row === CAMERA_ROW ? [animation.camera] : trackChannels(own(animation.tracks, key.row));
  return lists.some((keys) => hasKeyAt(keys, key.frame)) ? key : null;
}

/** K: keys position, rotation and scale of the selected objects at the playhead, as they are displayed there. */
export function setKey(): unknown {
  const state = docState();
  if (state.selection.length === 0) return notifyInfo(getT().timeline.nothingToKey, getT().timeline.nothingToKeyHint);
  if (state.edit) return notifyInfo(getT().timeline.editMode);
  return execute('anim.set_pose', { frame: playhead(), items: state.selection.map((id) => ({ id })) });
}

/** Deletes the picked key, or else the keys of the selected objects on the playhead's frame. */
export function deleteKey(): unknown {
  const state = docState();
  const picked = selectedKey(state);
  if (picked) {
    useTimeline.setState({ selectedKey: null });
    return picked.row === CAMERA_ROW ? execute('anim.delete_camera_key', { frame: picked.frame }) : execute('anim.delete_key', { ids: [picked.row], frame: picked.frame });
  }
  const frame = playhead();
  const tracks = state.animation?.tracks ?? {};
  const ids = state.selection.filter((id) => trackChannels(own(tracks, id)).some((keys) => hasKeyAt(keys, frame)));
  if (ids.length === 0) return notifyInfo(getT().timeline.noKeyHere, getT().timeline.noKeyHereHint);
  return execute('anim.delete_key', { ids, frame });
}

/** Keys the camera the viewport looks through right now at the playhead. */
export function setCameraKey(): unknown {
  const app = useApp.getState();
  const state = docState();
  const frame = playhead();
  const keys = state.animation?.camera ?? [];
  // In the camera view the viewport shows the animated camera itself: the key pins it where it is.
  const shown = usePlayback.getState().cameraView && !state.edit ? cameraAt(state.animation, frame) : null;
  const free = services.viewport?.getCamera();
  const camera = shown ?? (free ? { ...free, fov: app.preferences.fieldOfView } : null);
  if (!camera) return;
  // A key dropped into a baked (linear) move stays linear.
  const before = lowerBound(keys, frame + 1) - 1;
  const interpolation: KeyInterpolation = before >= 0 ? keys[before].interpolation : 'smooth';
  return execute('anim.set_camera_key', { frame, position: camera.position, target: camera.target, fov: camera.fov, interpolation });
}

/** The interpolation of a key marker (of its first transform channel), or null if it has none to choose. */
export function keyInterpolation(state: DocState, key: { row: string; frame: number }): KeyInterpolation | null {
  const animation = state.animation;
  if (!animation) return null;
  if (key.row === CAMERA_ROW) {
    const i = lowerBound(animation.camera, key.frame);
    return animation.camera[i]?.frame === key.frame ? animation.camera[i].interpolation : null;
  }
  const track = own(animation.tracks, key.row);
  for (const channel of transformChannels) {
    const keys = track?.[channel];
    if (!keys) continue;
    const i = lowerBound(keys, key.frame);
    if (keys[i]?.frame === key.frame) return keys[i].interpolation;
  }
  return null;
}

/** Sets how the value travels on from the picked key: the key is written again with its own values. */
export function setKeyInterpolation(interpolation: KeyInterpolation): unknown {
  const state = docState();
  const key = selectedKey(state);
  const animation = state.animation;
  if (!key || !animation) return;
  if (key.row === CAMERA_ROW) {
    const found = animation.camera[lowerBound(animation.camera, key.frame)];
    return execute('anim.set_camera_key', { frame: key.frame, position: found.position, target: found.target, fov: found.fov, interpolation });
  }
  const track = own(animation.tracks, key.row);
  const values: Record<string, unknown> = {};
  for (const channel of transformChannels) {
    const keys = track?.[channel];
    const found = keys?.[lowerBound(keys, key.frame)];
    if (found?.frame === key.frame) values[channel] = found.value;
  }
  if (Object.keys(values).length === 0) return;
  return execute('anim.set_key', { ids: [key.row], frame: key.frame, ...values, interpolation });
}

/** Jumps to the nearest key of the selection or the camera before / after the playhead. */
export function stepKey(direction: 1 | -1): void {
  const state = docState();
  const frame = neighbourKey(navigationLists(state.animation, state.selection), playhead(), direction);
  if (frame !== null) setFrame(frame);
}

export function stepFrame(delta: number): void {
  pause();
  setFrame(playhead() + delta);
}

export function toggleCameraView(): void {
  const next = !usePlayback.getState().cameraView;
  usePlayback.setState({ cameraView: next });
  if (next && (docState().animation?.camera.length ?? 0) === 0) notifyInfo(getT().timeline.noCameraKeys, getT().timeline.noCameraKeysHint);
}

type Text = (t: Dictionary) => string;
type Define = (action: Omit<Action, 'title' | 'group'> & { title: Text; group: 'animation' | 'view' | 'file' }) => Action;

/** The animation actions: timeline buttons, menus, command palette and shortcuts. */
export const timelineActions = (action: Define): Action[] => [
  action({ id: 'timeline.toggle', title: (t) => t.timeline.show, group: 'view', keys: ['Shift+T'], run: () => setTimelineOpen(!usePlayback.getState().timelineOpen) }),
  action({ id: 'timeline.play', title: (t) => t.timeline.playPause, group: 'animation', keys: [' '], when: 'object', run: togglePlay }),
  action({ id: 'timeline.start', title: (t) => t.timeline.toStart, group: 'animation', keys: ['Shift+ArrowLeft'], run: () => setFrame(0) }),
  action({ id: 'timeline.end', title: (t) => t.timeline.toEnd, group: 'animation', keys: ['Shift+ArrowRight'], run: () => setFrame(Infinity) }),
  action({ id: 'timeline.previous_frame', title: (t) => t.timeline.previousFrame, group: 'animation', keys: ['ArrowLeft'], when: 'object', run: () => stepFrame(-1) }),
  action({ id: 'timeline.next_frame', title: (t) => t.timeline.nextFrame, group: 'animation', keys: ['ArrowRight'], when: 'object', run: () => stepFrame(1) }),
  action({ id: 'timeline.previous_key', title: (t) => t.timeline.previousKey, group: 'animation', keys: ['ArrowDown'], when: 'object', run: () => stepKey(-1) }),
  action({ id: 'timeline.next_key', title: (t) => t.timeline.nextKey, group: 'animation', keys: ['ArrowUp'], when: 'object', run: () => stepKey(1) }),
  action({ id: 'timeline.set_key', title: (t) => t.timeline.setKey, group: 'animation', keys: ['K'], when: 'object', command: 'anim.set_pose', run: setKey }),
  action({ id: 'timeline.delete_key', title: (t) => t.timeline.deleteKey, group: 'animation', keys: ['Alt+K'], when: 'object', command: 'anim.delete_key', run: deleteKey }),
  action({ id: 'timeline.set_camera_key', title: (t) => t.timeline.setCameraKey, group: 'animation', keys: ['Shift+K'], command: 'anim.set_camera_key', run: setCameraKey }),
  action({ id: 'timeline.camera_view', title: (t) => t.timeline.cameraView, group: 'animation', keys: ['Numpad0'], run: toggleCameraView }),
  action({ id: 'video.export', title: (t) => t.video.open, group: 'file', command: 'render.video', run: openVideoDialog }),
];
