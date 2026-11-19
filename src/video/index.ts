// The video service: encodes the pictures of an export with WebCodecs as they come and writes them
// into an MP4 or WebM file in memory. One export at a time, with progress and cancellation for the UI.
import { ArrayBufferTarget as Mp4Target, Muxer as Mp4Muxer } from 'mp4-muxer';
import { ArrayBufferTarget as WebmTarget, Muxer as WebmMuxer } from 'webm-muxer';
import { create } from 'zustand';
import { VIDEO_CANCELLED, type VideoPicture, type VideoQuality, type VideoRecording, type VideoService, type VideoSpec } from '../core/video';
import { cancelRender } from '../render';
import { codecCandidates, fallbackNote, type CodecChoice } from './codecs';

export interface VideoProgress {
  /** Pictures encoded so far, and how many there will be. */
  frame: number;
  frames: number;
  /** Seconds since the export started. */
  elapsed: number;
  /** Estimated seconds left; null while there is nothing to go by yet. */
  remaining: number | null;
  phase: 'frames' | 'finishing';
  quality: VideoQuality;
  codecName: string;
}

/** What the export dialog shows: the running export, or null. */
export const useVideoStatus = create<{ progress: VideoProgress | null }>(() => ({ progress: null }));

let active: { cancelled: boolean; quality: VideoQuality } | null = null;

/** Cancels the running export: its command fails with `VIDEO_CANCELLED`. */
export function cancelVideo(): void {
  if (!active || active.cancelled) return;
  active.cancelled = true;
  // A frame that is being path traced would otherwise run to the end of its time budget.
  if (active.quality === 'render') cancelRender('any');
}

/** Lets the browser handle input and paint; without it a fast export would freeze the window until it is done. */
function breathe(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

function toBase64(buffer: ArrayBuffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The video could not be read back from memory'));
    reader.onload = () => {
      const url = reader.result as string;
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.readAsDataURL(new Blob([buffer]));
  });
}

async function decodeImage(image: { mimeType: string; base64: string }): Promise<ImageBitmap> {
  const blob = await (await fetch(`data:${image.mimeType};base64,${image.base64}`)).blob();
  return createImageBitmap(blob);
}

/** The first codec of the format's list this browser can encode at this size, with its encoder configuration. */
async function chooseCodec(spec: VideoSpec): Promise<{ choice: CodecChoice; config: VideoEncoderConfig }> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    throw new Error('Video export is not available: this browser has no video encoder (WebCodecs).');
  }
  const tried: string[] = [];
  for (const choice of codecCandidates(spec.format, spec.width, spec.height, spec.fps)) {
    const config: VideoEncoderConfig = {
      codec: choice.codec,
      width: spec.width,
      height: spec.height,
      bitrate: spec.bitrate,
      framerate: spec.fps,
      latencyMode: 'quality',
      // MP4 stores H.264 with length prefixes and the parameter sets in the header.
      ...(choice.mux === 'avc' ? { avc: { format: 'avc' as const } } : {}),
    };
    try {
      if ((await VideoEncoder.isConfigSupported(config)).supported) return { choice, config };
    } catch {
      // Not a configuration this browser understands: try the next one.
    }
    tried.push(choice.codec);
  }
  throw new Error(
    `No video encoder for ${spec.format.toUpperCase()} at ${spec.width} x ${spec.height} is available on this system (tried ${tried.join(', ')}). Try the other format (${spec.format === 'mp4' ? 'webm' : 'mp4'}) or a smaller size.`,
  );
}

async function begin(spec: VideoSpec): Promise<VideoRecording> {
  if (active) throw new Error('Another video export is running; wait for it to finish or cancel it first.');
  const state = (active = { cancelled: false, quality: spec.quality });
  const release = () => {
    if (active === state) active = null;
    useVideoStatus.setState({ progress: null });
  };
  try {
    const { choice, config } = await chooseCodec(spec);
    const video = { width: spec.width, height: spec.height, frameRate: spec.fps };
    const muxer =
      spec.format === 'mp4'
        ? new Mp4Muxer({ target: new Mp4Target(), video: { ...video, codec: choice.mux as 'avc' | 'vp9' | 'av1' }, fastStart: 'in-memory', firstTimestampBehavior: 'offset' })
        : new WebmMuxer({ target: new WebmTarget(), video: { ...video, codec: choice.mux }, firstTimestampBehavior: 'offset' });

    let failure: Error | null = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => {
        try {
          muxer.addVideoChunk(chunk, meta);
        } catch (error) {
          failure ??= error instanceof Error ? error : new Error(String(error));
        }
      },
      error: (error) => {
        failure ??= new Error(`The video encoder failed: ${error.message}`);
      },
    });
    encoder.configure(config);

    const canvas = document.createElement('canvas');
    canvas.width = spec.width;
    canvas.height = spec.height;
    const started = performance.now();
    let count = 0;
    let lastBreath = started;
    let lastReport = 0;
    let done = false;
    // A key frame every two seconds keeps seeking quick without costing much.
    const keyInterval = Math.max(1, Math.round(spec.fps * 2));
    const report = (phase: VideoProgress['phase']) => {
      const elapsed = (performance.now() - started) / 1000;
      const remaining = count > 0 ? (elapsed / count) * (spec.frames - count) : (spec.estimateSeconds ?? null);
      useVideoStatus.setState({ progress: { frame: count, frames: spec.frames, elapsed, remaining, phase, quality: spec.quality, codecName: choice.name } });
    };
    report('frames');

    const close = () => {
      if (done) return;
      done = true;
      if (encoder.state !== 'closed') encoder.close();
      release();
    };

    return {
      codec: choice.codec,
      codecName: choice.name,
      mimeType: `video/${spec.format}`,
      fallback: fallbackNote(spec.format, choice),
      canvas,
      get cancelled() {
        return state.cancelled;
      },
      async add(picture: VideoPicture) {
        if (state.cancelled) throw new Error(VIDEO_CANCELLED);
        if (failure) throw failure;
        if (count >= spec.frames) throw new Error('More pictures than the video was planned for');
        const timestamp = Math.round((count * 1e6) / spec.fps);
        const duration = Math.round(((count + 1) * 1e6) / spec.fps) - timestamp;
        let frame: VideoFrame;
        if ('canvas' in picture) {
          frame = new VideoFrame(picture.canvas as HTMLCanvasElement, { timestamp, duration });
        } else {
          const bitmap = await decodeImage(picture);
          try {
            if (bitmap.width !== spec.width || bitmap.height !== spec.height) {
              // A picture of another size is scaled onto the video's canvas.
              const context = canvas.getContext('2d');
              if (!context) throw new Error('Could not draw on the canvas of the video');
              context.drawImage(bitmap, 0, 0, spec.width, spec.height);
              frame = new VideoFrame(canvas, { timestamp, duration });
            } else {
              frame = new VideoFrame(bitmap, { timestamp, duration });
            }
          } finally {
            bitmap.close();
          }
        }
        try {
          encoder.encode(frame, { keyFrame: count % keyInterval === 0 });
        } finally {
          frame.close();
        }
        count++;
        // The encoder works in the background; do not pile up raw frames faster than it takes them.
        while (encoder.encodeQueueSize > 4 && !failure && !state.cancelled) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 50);
            encoder.addEventListener(
              'dequeue',
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });
        }
        const now = performance.now();
        if (now - lastReport > 100 || count === spec.frames) {
          lastReport = now;
          report('frames');
        }
        if (now - lastBreath > 24) {
          await breathe();
          lastBreath = performance.now();
        }
        if (failure) throw failure;
      },
      async finish() {
        if (state.cancelled) throw new Error(VIDEO_CANCELLED);
        if (count === 0) throw new Error('The video has no pictures');
        report('finishing');
        try {
          await encoder.flush();
          if (failure) throw failure;
          muxer.finalize();
          const buffer = muxer.target.buffer;
          return { base64: await toBase64(buffer), bytes: buffer.byteLength };
        } finally {
          close();
        }
      },
      abort: close,
    };
  } catch (error) {
    release();
    throw error;
  }
}

export function createVideoService(): VideoService {
  return { begin };
}
