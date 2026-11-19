// render.video: the animation of a document as a video file. The pictures come from the viewport
// (off-screen, fast) or from the path tracer (one render per frame); the encoder is behind `VideoService`.
import { z } from 'zod';
import { MAX_KEY_FRAME, animatedState, cameraAt, defaultAnimation, type CameraFrame } from '../animation';
import { REFS_HINT, resolveObjectIds } from '../refs';
import { MAX_RENDER_SECONDS, renderCameraSchema } from '../render';
import { PRESET_DIRECTIONS_HINT } from '../screenshotViews';
import { activeDoc, withDoc } from '../state';
import { shadings, viewPresets, type DocState, type ScreenshotCamera, type ScreenshotOptions } from '../types';
import {
  DEFAULT_SECONDS_PER_FRAME,
  DEFAULT_VIDEO_SAMPLES,
  MAX_RENDER_VIDEO_SECONDS,
  MAX_VIDEO_BITRATE,
  MAX_VIDEO_SIZE,
  MIN_VIDEO_BITRATE,
  MIN_VIDEO_SIZE,
  VIDEO_CANCELLED,
  planVideo,
  videoFormats,
  videoQualities,
  type VideoRecording,
} from '../video';
import { defineCommand, runCommand, type CommandContext } from './registry';
import { renderCommands } from './render';

const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;

export const videoCommands = [
  defineCommand({
    id: 'render.video',
    title: 'Video rendern',
    description:
      'Export the animation of the document as a video: one picture per animation frame from `fromFrame` to `toFrame` (default: the whole animation, frames 0 .. frameCount - 1), played at the animation\'s fps (constant frame rate), so the video lasts (toFrame - fromFrame + 1) / fps seconds. ' +
      'Animate first with the anim_* tools, check the timing with anim_evaluate and single pictures with view_screenshot { frame }, then call this. ' +
      'Every picture shows the document as its animation has it at that frame (anim_evaluate gives the same poses as numbers), without selection highlights, edit-mode overlays or the gizmo. ' +
      'QUALITY: "viewport" (default) = the editor look of view_screenshot (studio light, grid, the chosen `shading`: solid = neutral clay, wireframe, material = PBR materials and textures); fast - typically dozens of frames per second at 1280 x 720, so a 10 s clip takes a few seconds. ' +
      '"render" = every frame is path traced like render_image with the render settings of the document (render_get_settings / render_set_settings: environment, sun, ground, background, depth of field); each frame gets `samples` samples per pixel but at most `maxSecondsPerFrame` seconds, ' +
      `so the whole export takes about frames x maxSecondsPerFrame seconds (plus scene preparation per frame) and is refused if that is more than ${MAX_RENDER_VIDEO_SECONDS} s - lower maxSecondsPerFrame, the size or the frame range, or export in parts. ` +
      'CAMERA: with camera keys in the document (anim_set_camera_key, anim_camera_orbit) the video looks through the ANIMATED camera. Otherwise - or when you give one - the camera is fixed for the whole video: `view` "current" (the camera of that document\'s viewport) or a preset (framed once on the pose at fromFrame), or `camera` { position, target, fov? }. ' +
      PRESET_DIRECTIONS_HINT +
      ' FORMAT: "mp4" (default) is encoded as H.264, which plays everywhere; where the system has no H.264 encoder the video is encoded as VP9 (or AV1) in the MP4 file instead. "webm" is VP9 (fallback VP8). The codec that was used is returned as `codec` / `codecName`, and a fallback is explained in `warnings`. ' +
      `SIZE: width and height from ${MIN_VIDEO_SIZE} to ${MAX_VIDEO_SIZE}, rounded to even numbers (the result reports the size used). \`bitrate\` in bits per second (default: about 0.12 bits per pixel and frame, e.g. 3.3 Mbit/s for 1280 x 720 at 30 fps). ` +
      'Limits: at most 10 minutes of 3840 x 2160 at 30 fps in pixels x frames, and at most 256 MB by bitrate x length (the file is returned in one piece); beyond that the call fails with what would fit. ' +
      'Nothing in the document or in what the user sees changes, other tool calls are not blocked while it runs, and with "documentId" any open document can be exported while the user works in another tab. Only one video export runs at a time. ' +
      'Returns { video: { mimeType, base64 }, frames, fps, seconds (length of the video), width, height, codec, codecName, format, bytes, bitrate, quality, camera ("animated" or "fixed"), fromFrame, toFrame, elapsedSeconds, framesPerSecond (export speed), warnings? }. ' +
      'The video is large: prefer the native render_video tool with "path", which writes the file to disk and returns only the numbers.',
    params: z
      .object({
        fromFrame: z.number().int().min(0).max(MAX_KEY_FRAME).optional().describe('First frame. Default 0.'),
        toFrame: z.number().int().min(0).max(MAX_KEY_FRAME).optional().describe('Last frame (included). Default: the last frame of the animation, frameCount - 1.'),
        width: z.number().int().min(MIN_VIDEO_SIZE).max(MAX_VIDEO_SIZE).default(1280).describe('Width in pixels (rounded to an even number).'),
        height: z.number().int().min(MIN_VIDEO_SIZE).max(MAX_VIDEO_SIZE).default(720).describe('Height in pixels (rounded to an even number).'),
        quality: z.enum(videoQualities).default('viewport').describe('"viewport": editor look, fast. "render": path traced, each frame takes up to maxSecondsPerFrame.'),
        format: z.enum(videoFormats).default('mp4').describe('Container: mp4 (H.264 where available) or webm (VP9).'),
        bitrate: z.number().min(MIN_VIDEO_BITRATE).max(MAX_VIDEO_BITRATE).optional().describe('Bits per second. Default: by size and frame rate.'),
        samples: z.number().int().min(1).max(100000).optional().describe(`Render quality only: samples per pixel and frame to aim for. Default ${DEFAULT_VIDEO_SAMPLES}.`),
        maxSecondsPerFrame: z.number().min(1).max(MAX_RENDER_SECONDS).optional().describe(`Render quality only: time budget per frame in seconds. Default ${DEFAULT_SECONDS_PER_FRAME}.`),
        view: z.enum(['current', ...viewPresets]).optional().describe('A fixed view for the whole video instead of the animated camera.'),
        camera: renderCameraSchema.optional().describe('A fixed camera for the whole video instead of the animated one.'),
        shading: z.enum(shadings).optional().describe("Viewport quality only: solid, wireframe or material. Default: the viewport's current shading."),
        hideIds: z.array(z.string()).max(10000).optional().describe(`Objects left out of the video: ${REFS_HINT}.`),
      })
      .refine((p) => !(p.view && p.camera), { message: 'Give either "view" or "camera", not both', path: ['camera'] }),
    history: false,
    concurrent: true,
    async run(ctx, p) {
      const video = ctx.services.video;
      if (!video) throw new Error('Video export is not available here');
      // Everything is taken from the document as it is now; the export then works on that snapshot.
      const app = ctx.get();
      const doc = activeDoc(app);
      const animation = doc.state.animation ?? defaultAnimation();
      if (Object.keys(animation.tracks).length === 0 && animation.camera.length === 0) {
        throw new Error('Nothing is animated in this document: it has no keys. Animate it first (anim_add_motion, anim_follow_path, anim_set_key, anim_camera_orbit, ...).');
      }
      const plan = planVideo({ fps: animation.fps, frameCount: animation.frameCount, fromFrame: p.fromFrame, toFrame: p.toFrame, width: p.width, height: p.height, format: p.format, bitrate: p.bitrate });
      const render = p.quality === 'render';
      const secondsPerFrame = p.maxSecondsPerFrame ?? DEFAULT_SECONDS_PER_FRAME;
      if (render) {
        if (!ctx.services.renderer) throw new Error('The renderer is not ready yet');
        if (p.shading) throw new Error('"shading" belongs to viewport quality; a rendered video always shows the materials.');
        const budget = plan.frames * secondsPerFrame;
        if (budget > MAX_RENDER_VIDEO_SECONDS) {
          throw new Error(
            `Rendering ${plan.frames} frames at up to ${secondsPerFrame} s each would take about ${Math.round(budget)} s, more than the ${MAX_RENDER_VIDEO_SECONDS} s one export may take. Lower maxSecondsPerFrame (to at most ${Math.max(1, Math.floor(MAX_RENDER_VIDEO_SECONDS / plan.frames))}), export fewer frames (fromFrame / toFrame), or use quality "viewport".`,
          );
        }
      } else {
        if (p.samples !== undefined || p.maxSecondsPerFrame !== undefined) throw new Error('"samples" and "maxSecondsPerFrame" belong to quality "render".');
        if (!ctx.services.viewport?.sequence) throw new Error('The 3D viewport is not ready yet');
      }
      const hideIds = p.hideIds ? resolveObjectIds(doc.state, p.hideIds) : [];
      // A video shows the scene, not the editing state.
      const clean: DocState = { ...doc.state, selection: [], activeId: null, edit: null };
      const animatedCamera = p.view === undefined && p.camera === undefined && animation.camera.length > 0;

      const started = Date.now();
      let recording: VideoRecording | null = null;
      try {
        recording = await video.begin({ width: plan.width, height: plan.height, fps: plan.fps, frames: plan.frames, format: plan.format, bitrate: plan.bitrate, quality: p.quality, ...(render ? { estimateSeconds: plan.frames * secondsPerFrame } : {}) });
        if (render) await renderFrames(ctx, recording, withDoc(app, { ...doc, state: clean }), plan, { animatedCamera, view: p.view, camera: p.camera, hideIds, samples: p.samples ?? DEFAULT_VIDEO_SAMPLES, secondsPerFrame });
        else await viewportFrames(ctx, recording, doc.id, clean, plan, { animatedCamera, view: p.view, camera: p.camera, hideIds, shading: p.shading });
        const file = await recording.finish();
        const elapsed = (Date.now() - started) / 1000;
        const warnings = [...plan.warnings, ...(recording.fallback ? [recording.fallback] : [])];
        return {
          video: { mimeType: recording.mimeType, base64: file.base64 },
          frames: plan.frames,
          fps: plan.fps,
          seconds: round(plan.seconds, 4),
          width: plan.width,
          height: plan.height,
          codec: recording.codec,
          codecName: recording.codecName,
          format: plan.format,
          bytes: file.bytes,
          bitrate: plan.bitrate,
          quality: p.quality,
          camera: animatedCamera ? 'animated' : 'fixed',
          fromFrame: plan.fromFrame,
          toFrame: plan.toFrame,
          elapsedSeconds: round(elapsed),
          framesPerSecond: round(plan.frames / Math.max(elapsed, 1e-3), 1),
          ...(warnings.length > 0 ? { warnings } : {}),
        };
      } catch (error) {
        const cancelled = recording?.cancelled === true;
        recording?.abort();
        // A render that was interrupted because the export was cancelled is the cancellation, not a render error.
        throw cancelled ? new Error(VIDEO_CANCELLED) : error;
      }
    },
  }),
];

interface FrameOptions {
  animatedCamera: boolean;
  view?: ScreenshotOptions['view'];
  camera?: ScreenshotCamera;
  hideIds: readonly string[];
}

type Plan = ReturnType<typeof planVideo>;

/** Viewport quality: every frame is drawn off-screen into the recording's canvas, from one scene that is kept for the whole run. */
async function viewportFrames(ctx: CommandContext, recording: VideoRecording, docId: string, state: DocState, plan: Plan, o: FrameOptions & { shading?: ScreenshotOptions['shading'] }): Promise<void> {
  const sequence = ctx.services.viewport!.sequence!({ id: docId, state });
  const animation = state.animation;
  const base = { width: plan.width, height: plan.height, fit: false, hideIds: o.hideIds, shading: o.shading } as const;
  // A fixed camera is worked out on the first frame (a preset frames the scene as it is then) and kept.
  let fixed: ScreenshotCamera | null = o.camera ?? null;
  try {
    for (let frame = plan.fromFrame; frame <= plan.toFrame; frame++) {
      if (recording.cancelled) throw new Error(VIDEO_CANCELLED);
      const camera: ScreenshotCamera | CameraFrame | null = o.animatedCamera ? cameraAt(animation, frame) : fixed;
      const info = await sequence.shot(camera ? { ...base, view: 'current', camera } : { ...base, view: o.view ?? 'current' }, animatedState(state, frame), recording.canvas);
      if (!o.animatedCamera && !fixed) {
        const view = info.views[0];
        fixed = { position: view.cameraPosition, target: view.cameraTarget, fov: view.fov };
      }
      await recording.add({ canvas: recording.canvas });
    }
  } finally {
    sequence.end();
  }
}

/** Render quality: render.image once per frame, on a context pinned to the snapshot of the document. */
async function renderFrames(ctx: CommandContext, recording: VideoRecording, app: ReturnType<CommandContext['get']>, plan: Plan, o: FrameOptions & { samples: number; secondsPerFrame: number }): Promise<void> {
  const renderImage = renderCommands.find((c) => c.id === 'render.image')!;
  const pinned: CommandContext = {
    services: ctx.services,
    get: () => app,
    set: () => {
      throw new Error('render.image must not change the document');
    },
  };
  let fixed: ScreenshotCamera | null = o.camera ?? null;
  for (let frame = plan.fromFrame; frame <= plan.toFrame; frame++) {
    if (recording.cancelled) throw new Error(VIDEO_CANCELLED);
    const out = (await runCommand(renderImage, pinned, {
      frame,
      width: plan.width,
      height: plan.height,
      samples: o.samples,
      maxSeconds: o.secondsPerFrame,
      format: 'png',
      hideIds: o.hideIds,
      // The animated camera is render.image's default for a frame; a fixed one is given explicitly.
      ...(o.animatedCamera ? {} : fixed ? { camera: fixed, fit: false, useAnimationCamera: false } : { view: o.view ?? 'current', useAnimationCamera: false }),
    })) as { image: { mimeType: string; base64: string }; camera: { position: ScreenshotCamera['position']; target: ScreenshotCamera['target']; fov: number } };
    if (!o.animatedCamera && !fixed) fixed = { position: out.camera.position, target: out.camera.target, fov: out.camera.fov };
    await recording.add(out.image);
  }
}
