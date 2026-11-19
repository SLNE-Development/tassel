// The playhead: which frame of its animation each open document shows, and playback. UI state, not part
// of any document (and so not undoable): the viewport displays `animatedState(doc.state, frame)`, the
// timeline moves the frame, and frame-aware commands take their frame as a parameter instead.
import { create } from 'zustand';
import { DEFAULT_FPS, DEFAULT_FRAME_COUNT } from '../core/animation';
import { clampFrame, playbackFrame } from '../core/playhead';
import { useApp } from './store';

export interface PlaybackState {
  /** Current frame per document id (a whole number); a document without an entry is on frame 0. */
  frames: Readonly<Record<string, number>>;
  /** Id of the document that is playing, or null. */
  playing: string | null;
  loop: boolean;
  /** "Kamera-Ansicht": the viewport looks through the animated camera (if the document has camera keys). */
  cameraView: boolean;
  /** Whether the timeline dock is shown. */
  timelineOpen: boolean;
}

const OPEN_KEY = 'tessel.timeline.open';

function storedOpen(): boolean {
  try {
    return globalThis.localStorage?.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

export const usePlayback = create<PlaybackState>(() => ({ frames: {}, playing: null, loop: true, cameraView: false, timelineOpen: storedOpen() }));

export function setTimelineOpen(open: boolean): void {
  usePlayback.setState({ timelineOpen: open });
  try {
    globalThis.localStorage?.setItem(OPEN_KEY, open ? '1' : '0');
  } catch {
    // Not remembered across sessions then.
  }
}

/** fps and length of a document's animation (the defaults while it has none). */
export function animationRange(docId: string): { fps: number; frameCount: number } {
  const animation = useApp.getState().docs[docId]?.state.animation;
  return { fps: animation?.fps ?? DEFAULT_FPS, frameCount: animation?.frameCount ?? DEFAULT_FRAME_COUNT };
}

/** The frame a document shows, inside its animation's range. */
export function frameOf(docId: string, playback: PlaybackState = usePlayback.getState()): number {
  const frame = playback.frames[docId];
  return frame === undefined ? 0 : clampFrame(frame, animationRange(docId).frameCount);
}

/** Selector for React: the current frame of the visible document. */
export const selectFrame = (playback: PlaybackState) => frameOf(useApp.getState().activeDocId, playback);

let request = 0;
/** Where and when the running playback started. */
let origin = { frame: 0, time: 0 };

function tick(now: number): void {
  request = 0;
  const { playing, loop, frames } = usePlayback.getState();
  const doc = playing === null ? undefined : useApp.getState().docs[playing];
  // Playback belongs to the document on screen; in edit mode the static pose is shown.
  if (playing === null || !doc || useApp.getState().activeDocId !== playing || doc.state.edit) return pause();
  const { fps, frameCount } = animationRange(playing);
  const { frame, ended } = playbackFrame(origin.frame, (now - origin.time) / 1000, fps, frameCount, loop);
  if (frame !== frames[playing]) usePlayback.setState({ frames: { ...frames, [playing]: frame } });
  if (ended) return pause();
  request = requestAnimationFrame(tick);
}

export function pause(): void {
  if (request) cancelAnimationFrame(request);
  request = 0;
  if (usePlayback.getState().playing !== null) usePlayback.setState({ playing: null });
}

/** Plays the visible document from its current frame (from the start if it is on the last frame). */
export function play(): void {
  pause();
  const app = useApp.getState();
  const docId = app.activeDocId;
  if (app.docs[docId]?.state.edit) return;
  const { frameCount } = animationRange(docId);
  let frame = frameOf(docId);
  if (frame >= frameCount - 1) frame = 0;
  origin = { frame, time: performance.now() };
  usePlayback.setState((s) => ({ playing: docId, frames: { ...s.frames, [docId]: frame } }));
  request = requestAnimationFrame(tick);
}

export function togglePlay(): void {
  if (usePlayback.getState().playing !== null) pause();
  else play();
}

/** Moves the playhead of a document (default: the visible one); playback goes on from there. */
export function setFrame(frame: number, docId: string = useApp.getState().activeDocId): void {
  const next = clampFrame(frame, animationRange(docId).frameCount);
  const state = usePlayback.getState();
  if (state.playing === docId) origin = { frame: next, time: performance.now() };
  if (state.frames[docId] === next) return;
  usePlayback.setState({ frames: { ...state.frames, [docId]: next } });
}

// Playback stops when its document leaves the screen, enters edit mode or is closed; closed documents are forgotten.
useApp.subscribe((app) => {
  const { playing, frames } = usePlayback.getState();
  if (playing !== null && (app.activeDocId !== playing || !app.docs[playing] || app.docs[playing].state.edit)) pause();
  const gone = Object.keys(frames).filter((id) => !app.docs[id]);
  if (gone.length > 0) {
    const kept = { ...frames };
    for (const id of gone) delete kept[id];
    usePlayback.setState({ frames: kept });
  }
});
