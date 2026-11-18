// The bake service: collects the geometry, runs the job in workers, encodes the result as PNG.
import { create } from 'zustand';
import type { BakeOutput, BakeService } from '../core/types';
import { assemble, type BandResult } from './bake';
import { buildJob } from './geometry';
import type { WorkerMessage, WorkerRequest } from './worker';

export { defaultDistance } from './geometry';

/** Progress of the running bake (0..1), or null when none is running. The bake dialog shows it. */
export const useBakeProgress = create<{ progress: number | null }>(() => ({ progress: null }));

/** What a cancelled bake rejects with. */
export const BAKE_CANCELLED = 'Baking was cancelled';

/** Share of the progress bar that the ray casting gets; the rest is dilation and encoding. */
const CASTING = 0.96;
const MAX_WORKERS = 8;

let cancelRunning: (() => void) | null = null;

/** Stops the running bake, if any; its command fails with `BAKE_CANCELLED`. */
export function cancelBake(): void {
  cancelRunning?.();
}

/** RGBA pixels (row 0 at the top) → PNG as base64 without a data: prefix. */
async function encodePng(pixels: Uint8ClampedArray<ArrayBuffer>, size: number): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The baked image could not be encoded (no 2D canvas)');
  context.putImageData(new ImageData(pixels, size, size), 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('The baked image could not be encoded');
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('The baked image could not be encoded'));
    reader.readAsDataURL(blob);
  });
  return url.slice(url.indexOf(',') + 1);
}

export function createBaker(): BakeService {
  return {
    async bake(state, request): Promise<BakeOutput> {
      if (cancelRunning) throw new Error('Another bake is still running. Wait for it to finish or cancel it.');
      const { distanceUsed, ...job } = buildJob(state, request);
      const size = job.size;
      // The rows are dealt out to the workers in turn, which shares the work evenly whatever the UV layout.
      const count = Math.max(1, Math.min(MAX_WORKERS, (navigator.hardwareConcurrency || 2) - 1, size));
      const workers = Array.from({ length: count }, () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }));
      useBakeProgress.setState({ progress: 0 });
      try {
        const cancelled = new Promise<never>((_, reject) => {
          cancelRunning = () => reject(new Error(BAKE_CANCELLED));
        });
        // Cancelling between two steps must not count as an unhandled rejection.
        cancelled.catch(() => {});
        /** Sends one request to a worker and resolves with its answer of the given type. */
        const ask = <T extends WorkerMessage['type']>(worker: Worker, message: WorkerRequest, transfer: Transferable[], answer: T, onProgress?: (value: number) => void) =>
          Promise.race([
            cancelled,
            new Promise<Extract<WorkerMessage, { type: T }>>((resolve, reject) => {
              worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
                const reply = event.data;
                if (reply.type === 'progress') onProgress?.(reply.value);
                else if (reply.type === 'error') reject(new Error(reply.message));
                else if (reply.type === answer) resolve(reply as Extract<WorkerMessage, { type: T }>);
              };
              worker.onerror = (event) => reject(new Error(`Baking failed: ${event.message || 'the bake worker could not be started'}`));
              worker.postMessage(message, transfer);
            }),
          ]);

        const done = new Array<number>(count).fill(0);
        const bands: BandResult[] = await Promise.all(
          workers.map(async (worker, index) => {
            const reply = await ask(worker, { type: 'band', job, band: { index, count } }, [], 'band', (value) => {
              done[index] = value;
              useBakeProgress.setState({ progress: (done.reduce((a, b) => a + b, 0) / count) * CASTING });
            });
            return reply.result;
          }),
        );
        useBakeProgress.setState({ progress: CASTING });
        const covered = bands.reduce((n, band) => n + band.covered, 0);
        const hits = bands.reduce((n, band) => n + band.hits, 0);
        const image = assemble(size, bands);
        const dilated = await ask(workers[0], { type: 'dilate', size, ...image }, [image.pixels.buffer, image.mask.buffer], 'dilated');
        useBakeProgress.setState({ progress: 0.98 });
        const data = await Promise.race([cancelled, encodePng(dilated.pixels, size)]);
        return { data, coverage: covered > 0 ? hits / covered : 0, distance: distanceUsed };
      } finally {
        // Also what stops a cancelled bake: the loops in the workers never yield.
        for (const worker of workers) worker.terminate();
        cancelRunning = null;
        useBakeProgress.setState({ progress: null });
      }
    },
  };
}
