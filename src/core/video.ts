// Video export (render.video): what a video of an animation is made of - frame range, size, bitrate -
// with its limits, and the interface of the encoder. DOM-free; the encoder itself (WebCodecs) is src/video.

export const videoFormats = ['mp4', 'webm'] as const;
export type VideoFormat = (typeof videoFormats)[number];
export const videoQualities = ['viewport', 'render'] as const;
export type VideoQuality = (typeof videoQualities)[number];

/** Smallest and largest side of a video, in pixels. */
export const MIN_VIDEO_SIZE = 64;
export const MAX_VIDEO_SIZE = 4096;
/** Most pixels a whole video may have (frames x width x height): 10 minutes of 3840 x 2160 at 30 fps. */
export const MAX_VIDEO_PIXELS = 3840 * 2160 * 30 * 600;
export const MIN_VIDEO_BITRATE = 100_000;
export const MAX_VIDEO_BITRATE = 200_000_000;
/**
 * Largest video file by its bitrate and length. The finished file travels as ONE base64 string from the
 * encoder to whoever asked (the save dialog, or the native render_video tool that writes it to disk), and
 * strings of several hundred megabytes are where the webview gives up.
 */
export const MAX_VIDEO_BYTES = 256 * 1024 * 1024;
/** Longest a video in render quality may take by its own sample budget (frames x maxSecondsPerFrame), in seconds. */
export const MAX_RENDER_VIDEO_SECONDS = 3600;

export const DEFAULT_VIDEO_SAMPLES = 24;
export const DEFAULT_SECONDS_PER_FRAME = 3;

/** What was said when an export is cancelled; the command rejects with it. */
export const VIDEO_CANCELLED = 'The video export was cancelled';

export interface VideoPlanInput {
  /** The animation: frames per second and length in frames. */
  fps: number;
  frameCount: number;
  fromFrame?: number;
  toFrame?: number;
  width: number;
  height: number;
  format: VideoFormat;
  /** Bits per second; default: by size and frame rate. */
  bitrate?: number;
}

export interface VideoPlan {
  fromFrame: number;
  toFrame: number;
  /** Number of pictures: toFrame - fromFrame + 1. */
  frames: number;
  fps: number;
  /** Length of the video in seconds: frames / fps. */
  seconds: number;
  /** Even numbers (H.264 cannot encode odd sizes). */
  width: number;
  height: number;
  format: VideoFormat;
  bitrate: number;
  /** What was changed about the request, in English sentences. */
  warnings: string[];
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** A bitrate that keeps viewport pictures (flat colours, hard edges) clean: 0.12 bits per pixel and frame, 1 to 60 Mbit/s. */
export function defaultBitrate(width: number, height: number, fps: number): number {
  return Math.round(Math.min(60_000_000, Math.max(1_000_000, width * height * fps * 0.12)));
}

/**
 * Works out the frames, size and bitrate of a video and checks them against the limits. Throws an Error
 * with a clear English message when the request cannot be met.
 */
export function planVideo(input: VideoPlanInput): VideoPlan {
  const { fps, frameCount, format } = input;
  const last = frameCount - 1;
  const fromFrame = input.fromFrame ?? 0;
  const toFrame = input.toFrame ?? last;
  for (const [name, value] of [
    ['fromFrame', fromFrame],
    ['toFrame', toFrame],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a whole frame number from 0`);
    if (value > last) {
      throw new Error(`${name} ${value} is beyond the end of the animation (frameCount ${frameCount} = frames 0..${last}). Extend the animation with anim.set_range { frameCount: ${value + 1} } or export fewer frames.`);
    }
  }
  if (toFrame < fromFrame) throw new Error(`toFrame (${toFrame}) must not be before fromFrame (${fromFrame})`);

  const warnings: string[] = [];
  for (const [name, value] of [
    ['width', input.width],
    ['height', input.height],
  ] as const) {
    if (!Number.isFinite(value) || value < MIN_VIDEO_SIZE || value > MAX_VIDEO_SIZE) throw new Error(`${name} must be between ${MIN_VIDEO_SIZE} and ${MAX_VIDEO_SIZE} pixels`);
  }
  const width = Math.min(MAX_VIDEO_SIZE, even(input.width));
  const height = Math.min(MAX_VIDEO_SIZE, even(input.height));
  if (width !== input.width || height !== input.height) {
    warnings.push(`Video encoders need even dimensions: ${input.width} x ${input.height} was rounded to ${width} x ${height}.`);
  }

  const frames = toFrame - fromFrame + 1;
  const seconds = frames / fps;
  const pixels = frames * width * height;
  if (pixels > MAX_VIDEO_PIXELS) {
    const most = Math.floor(MAX_VIDEO_PIXELS / (width * height));
    throw new Error(
      `The video is too large: ${frames} frames of ${width} x ${height} are more than the limit of 10 minutes of 3840 x 2160 at 30 fps. At this size at most ${most} frames (${Math.floor(most / fps)} s) fit: export a shorter range or a smaller size.`,
    );
  }

  if (input.bitrate !== undefined && (!Number.isFinite(input.bitrate) || input.bitrate < MIN_VIDEO_BITRATE || input.bitrate > MAX_VIDEO_BITRATE)) {
    throw new Error(`bitrate must be between ${MIN_VIDEO_BITRATE} and ${MAX_VIDEO_BITRATE} bits per second`);
  }
  const bitrate = Math.round(input.bitrate ?? defaultBitrate(width, height, fps));
  const bytes = (bitrate * seconds) / 8;
  if (bytes > MAX_VIDEO_BYTES) {
    const fits = Math.floor((MAX_VIDEO_BYTES * 8) / seconds);
    throw new Error(
      `The video file would be about ${Math.round(bytes / (1024 * 1024))} MB (${seconds.toFixed(1)} s at ${(bitrate / 1e6).toFixed(1)} Mbit/s), more than the ${MAX_VIDEO_BYTES / (1024 * 1024)} MB one export can return. Pass a bitrate of at most ${fits}, or export the animation in several parts (fromFrame / toFrame).`,
    );
  }
  return { fromFrame, toFrame, frames, fps, seconds, width, height, format, bitrate, warnings };
}

/** What the encoder is asked to make. */
export interface VideoSpec {
  width: number;
  height: number;
  fps: number;
  frames: number;
  format: VideoFormat;
  bitrate: number;
  quality: VideoQuality;
  /** Upper estimate of how long producing all pictures takes, in seconds, where that is known before the start (render quality). */
  estimateSeconds?: number;
}

/** One picture of a video: the recording's own canvas (after it was drawn on), or an encoded image. */
export type VideoPicture = { canvas: unknown } | { mimeType: string; base64: string };

/** A video being written. Pictures are encoded as they come; no raw frames are kept. */
export interface VideoRecording {
  /** Codec string of the video stream, e.g. `avc1.640028`, and what it is called, e.g. `H.264`. */
  readonly codec: string;
  readonly codecName: string;
  readonly mimeType: `video/${VideoFormat}`;
  /** The fallback that was taken when the preferred codec of the format is not available, as a sentence; else null. */
  readonly fallback: string | null;
  /** A canvas of the video's size (an HTMLCanvasElement; opaque here) for the viewport to draw each picture into. */
  readonly canvas: unknown;
  /** True once the user (or anything else) cancelled the export. */
  readonly cancelled: boolean;
  /** Appends the next picture. Rejects with `VIDEO_CANCELLED` when the export was cancelled. */
  add(picture: VideoPicture): Promise<void>;
  /** Finishes the file. */
  finish(): Promise<{ base64: string; bytes: number }>;
  /** Gives up; safe to call at any time, also after `finish`. */
  abort(): void;
}

/** Implemented by src/video (WebCodecs), registered at startup. */
export interface VideoService {
  /** Starts a recording. Rejects with a clear English message when no encoder for the format is available, or another export is running. */
  begin(spec: VideoSpec): Promise<VideoRecording>;
}
