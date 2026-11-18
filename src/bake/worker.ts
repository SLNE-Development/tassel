// A bake worker: computes one band of a job, or dilates the assembled image. See index.ts for the other side.
import { bakeBand, DILATION, type BakeJob, type Band, type BandResult } from './bake';
import { dilate } from './dilate';

export type WorkerRequest =
  | { type: 'band'; job: BakeJob; band: Band }
  | { type: 'dilate'; size: number; pixels: Uint8ClampedArray<ArrayBuffer>; mask: Uint8Array<ArrayBuffer> };

export type WorkerMessage =
  | { type: 'progress'; value: number }
  | { type: 'band'; result: BandResult }
  | { type: 'dilated'; pixels: Uint8ClampedArray<ArrayBuffer> }
  | { type: 'error'; message: string };

const post = (message: WorkerMessage, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(message, transfer);

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    if (request.type === 'band') {
      const result = bakeBand(request.job, request.band, (value) => post({ type: 'progress', value }));
      post({ type: 'band', result }, [result.pixels.buffer, result.mask.buffer]);
    } else {
      dilate(request.pixels, request.mask, request.size, DILATION);
      post({ type: 'dilated', pixels: request.pixels }, [request.pixels.buffer]);
    }
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
