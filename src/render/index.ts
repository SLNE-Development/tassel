// The render service: one path-tracing renderer shared by the render dialog and the render.image
// command, renders one after another, progress and cancellation for the UI.
import { create } from 'zustand';
import type { RenderJob, RenderOutput, RenderService } from '../core/render';
import type { DocState } from '../core/types';
import { RenderSession, type RenderControl, type RenderProgress } from './session';

export type { RenderProgress } from './session';

interface RenderStatus {
  /** The running render, or null when none is running. */
  progress: RenderProgress | null;
  /** Whether the running render is the render dialog's own. */
  interactive: boolean;
  /** The canvas the renderer draws on: the live picture while rendering, the last result afterwards. Null while there is no renderer. */
  canvas: HTMLCanvasElement | null;
  /** Size of the picture on the canvas, or null if nothing has been rendered on it yet. */
  picture: { width: number; height: number } | null;
}

/** What the render dialog shows. */
export const useRenderStatus = create<RenderStatus>(() => ({ progress: null, interactive: false, canvas: null, picture: null }));

/** What a cancelled render rejects with. */
export const RENDER_CANCELLED = 'Rendering was cancelled';
/** What the render dialog's own render rejects with when another render takes its place. */
export const RENDER_SUPERSEDED = 'Rendering was interrupted by another render';

/** Without the dialog open, the renderer and its GPU memory are given back this long after the last render. */
const IDLE_MS = 15_000;

let session: RenderSession | null = null;
/** The render dialog holds the renderer while it is open. */
let holders = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let running: { control: RenderControl; interactive: boolean } | null = null;
/** Renders waiting for their turn, the running one included. */
let pending = 0;
let queue: Promise<unknown> = Promise.resolve();

function dispose(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  session?.dispose();
  session = null;
  useRenderStatus.setState({ canvas: null, picture: null });
}

function acquire(): RenderSession {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (!session) {
    try {
      session = new RenderSession();
    } catch (error) {
      throw new Error(`Rendering is not available: the renderer could not be started (WebGL 2 is needed). ${error instanceof Error ? error.message : ''}`.trim());
    }
    useRenderStatus.setState({ canvas: session.canvas, picture: null });
  }
  return session;
}

function settle(): void {
  if (pending > 0 || !session) return;
  if (holders > 0) return;
  idleTimer = setTimeout(dispose, IDLE_MS);
}

/** The render dialog opens: keeps the renderer (and the last picture) alive until `releaseRenderer`. */
export function retainRenderer(): void {
  holders++;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}

/** The render dialog closes: frees the renderer's GPU resources as soon as nothing is rendering. */
export function releaseRenderer(): void {
  holders = Math.max(0, holders - 1);
  if (holders === 0 && pending === 0) dispose();
}

/** Aborts the running render: its command fails with `RENDER_CANCELLED`. `own`: only if it is the dialog's. */
export function cancelRender(scope: 'any' | 'interactive' = 'any'): void {
  if (running && (scope === 'any' || running.interactive)) running.control.cancelled ??= RENDER_CANCELLED;
}

/** Ends the running render after the sample it is working on; it returns the picture as it is. */
export function stopRender(scope: 'any' | 'interactive' = 'any'): void {
  if (running && (scope === 'any' || running.interactive)) running.control.stop = true;
}

/** GPU resource counts of the renderer (null if there is none), for leak checks in development. */
export function rendererStats() {
  return session?.stats() ?? null;
}

async function run(state: DocState, job: RenderJob, control: RenderControl): Promise<RenderOutput> {
  if (control.cancelled) throw new Error(control.cancelled);
  const active = acquire();
  running = { control, interactive: job.interactive === true };
  const { width, height, format, quality } = job.settings.output;
  try {
    useRenderStatus.setState({ interactive: running.interactive, picture: { width, height } });
    const result = await active.render(state, job, control);
    useRenderStatus.setState((s) => (s.progress ? { progress: { ...s.progress, phase: 'encoding' } } : s));
    const mimeType = `image/${format}` as const;
    const base64 = await active.encode(mimeType, quality);
    return { mimeType, base64, width, height, samples: result.samples, seconds: Math.round(result.seconds * 100) / 100, converged: result.converged };
  } catch (error) {
    // After anything but a cancellation the renderer may be in an unknown state: start afresh next time.
    if (!control.cancelled) {
      dispose();
    } else {
      useRenderStatus.setState({ picture: null });
    }
    throw error;
  } finally {
    running = null;
    useRenderStatus.setState({ progress: null, interactive: false });
  }
}

export function createRenderer(): RenderService {
  return {
    render(state, job) {
      const control: RenderControl = {
        cancelled: null,
        stop: false,
        onProgress: (progress) => useRenderStatus.setState({ progress }),
      };
      // A render the user merely watches in the dialog gives way; it can be started again with one click.
      if (running?.interactive) running.control.cancelled ??= RENDER_SUPERSEDED;
      pending++;
      const result = queue.then(() => run(state, job, control));
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      void queue.then(() => {
        pending--;
        settle();
      });
      return result;
    },
  };
}

// For leak checks and tests in development (see `__tessel` in main.tsx).
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __tesselRender: unknown }).__tesselRender = { cancelRender, stopRender, rendererStats, useRenderStatus };
}
