import { beforeEach, describe, expect, it } from 'vitest';
import type { RenderJob, RenderService } from '../render';
import { activeDoc, createAppState } from '../state';
import type { AppState, DocState, ScreenshotOptions, ScreenshotResult, ViewDocument, ViewportService } from '../types';
import { VIDEO_CANCELLED, type VideoPicture, type VideoRecording, type VideoService, type VideoSpec } from '../video';
import { commands } from './index';
import { runCommand, type AnyCommand, type CommandContext } from './registry';
import { runCommandOn } from './targeting';

const byId = new Map<string, AnyCommand>(commands.map((c) => [c.id, c]));

let app: AppState;
/** What the fake viewport was asked to draw. */
let shots: { opts: ScreenshotOptions; state: DocState; doc?: ViewDocument }[];
let sequences: { doc: ViewDocument; ended: boolean }[];
let renders: { state: DocState; job: RenderJob }[];
let recordings: { spec: VideoSpec; pictures: VideoPicture[]; finished: boolean; aborted: boolean; cancelAfter: number | null; cancelled: boolean }[];
/** Set by a test to make the encoder choose a fallback codec or cancel. */
let encoder: { fallback: string | null; cancelAfter: number | null; fail?: string };

const info = (opts: ScreenshotOptions): Omit<ScreenshotResult, 'base64'> => ({
  views: [
    {
      name: 'view',
      // A view of its own is "framed" by the fake at a recognisable place.
      cameraPosition: opts.camera?.position ?? [9, 9, 9],
      cameraTarget: opts.camera?.target ?? [0, 1, 0],
      fov: opts.camera?.fov ?? 33,
      direction: '',
      imageRight: '+X',
      imageUp: '+Y',
      rect: { x: 0, y: 0, width: opts.width, height: opts.height },
    },
  ],
  width: opts.width,
  height: opts.height,
  backend: 'webgpu',
});

const viewport: ViewportService = {
  screenshot: async (opts, doc) => {
    shots.push({ opts, state: doc!.state, doc });
    return { base64: 'AAAA', ...info(opts) };
  },
  sequence: (doc) => {
    const run = { doc, ended: false };
    sequences.push(run);
    return {
      shot: async (opts, state) => {
        if (run.ended) throw new Error('shot after end');
        shots.push({ opts, state });
        return info(opts);
      },
      end: () => {
        run.ended = true;
      },
    };
  },
  getCamera: () => ({ position: [0, 0, 5], target: [0, 0, 0] }),
  setCamera: () => {},
  setView: () => {},
  frame: () => {},
};

const renderer: RenderService = {
  render: async (state, job) => {
    renders.push({ state, job });
    return { mimeType: 'image/png', base64: `frame${renders.length}`, width: job.settings.output.width, height: job.settings.output.height, samples: job.settings.output.samples, seconds: 0.1, converged: true };
  },
};

const video: VideoService = {
  begin: async (spec) => {
    if (encoder.fail) throw new Error(encoder.fail);
    const record = { spec, pictures: [] as VideoPicture[], finished: false, aborted: false, cancelAfter: encoder.cancelAfter, cancelled: false };
    recordings.push(record);
    const recording: VideoRecording = {
      codec: encoder.fallback ? 'vp09.00.31.08' : 'avc1.64001f',
      codecName: encoder.fallback ? 'VP9' : 'H.264',
      mimeType: `video/${spec.format}`,
      fallback: encoder.fallback,
      canvas: { fake: 'canvas' },
      get cancelled() {
        return record.cancelled;
      },
      add: async (picture) => {
        if (record.cancelled) throw new Error(VIDEO_CANCELLED);
        record.pictures.push(picture);
        if (record.cancelAfter !== null && record.pictures.length >= record.cancelAfter) record.cancelled = true;
      },
      finish: async () => {
        record.finished = true;
        return { base64: 'VklERU8=', bytes: 5 };
      },
      abort: () => {
        record.aborted = true;
      },
    };
    return recording;
  },
};

const ctx: CommandContext = {
  get: () => app,
  set: (update) => {
    app = update(app);
  },
  services: { viewport, exporter: null, renderer, video },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function run(id: string, params?: unknown, documentId?: string): Promise<any> {
  return runCommandOn(byId.get(id)!, ctx, params, documentId);
}

const state = () => activeDoc(app).state;

/** A cube that slides 10 m along +X over frames 0..20 (linear), in an animation of 30 fps and 21 frames. */
async function slidingCube(): Promise<string> {
  const id = (await run('scene.add_primitive', { type: 'cube', position: [0, 0, 0] })).id;
  await run('anim.set_range', { fps: 30, frameCount: 21 });
  await run('anim.add_motion', { ids: [id], fromFrame: 0, toFrame: 20, translate: [10, 0, 0], interpolation: 'linear' });
  return id;
}

beforeEach(() => {
  app = createAppState();
  shots = [];
  sequences = [];
  renders = [];
  recordings = [];
  encoder = { fallback: null, cancelAfter: null };
});

describe('render.video in viewport quality', () => {
  it('draws every frame of the animation into the recording and returns the file', async () => {
    const id = await slidingCube();
    await run('scene.select', { ids: [id] });
    const before = app;
    const result = await run('render.video', { width: 640, height: 360 });
    expect(app).toBe(before);
    expect(result).toMatchObject({
      video: { mimeType: 'video/mp4', base64: 'VklERU8=' },
      frames: 21,
      fps: 30,
      seconds: 0.7,
      width: 640,
      height: 360,
      codec: 'avc1.64001f',
      codecName: 'H.264',
      format: 'mp4',
      bytes: 5,
      quality: 'viewport',
      camera: 'fixed',
      fromFrame: 0,
      toFrame: 20,
    });
    expect(result.warnings).toBeUndefined();
    expect(recordings).toHaveLength(1);
    expect(recordings[0].spec).toMatchObject({ width: 640, height: 360, fps: 30, frames: 21, format: 'mp4', quality: 'viewport' });
    expect(recordings[0].spec.estimateSeconds).toBeUndefined();
    expect(recordings[0].pictures).toHaveLength(21);
    expect(recordings[0].finished).toBe(true);
    // One run of pictures, ended, each showing the animated pose of its frame without the editing state.
    expect(sequences).toHaveLength(1);
    expect(sequences[0].ended).toBe(true);
    expect(shots.map((s) => s.state.objects[id].transform.position[0])).toEqual(Array.from({ length: 21 }, (_, i) => i * 0.5));
    expect(shots.every((s) => s.state.selection.length === 0 && s.state.activeId === null && s.state.edit === null)).toBe(true);
    expect(shots.every((s) => s.opts.width === 640 && s.opts.height === 360 && s.opts.fit === false)).toBe(true);
  });

  it('keeps one camera for the whole video when the camera is not animated', async () => {
    await slidingCube();
    await run('render.video', { width: 320, height: 240, view: 'front' });
    // The first frame works the preset out; the others reuse the camera it reported.
    expect(shots[0].opts.view).toBe('front');
    expect(shots[0].opts.camera).toBeUndefined();
    for (const shot of shots.slice(1)) expect(shot.opts.camera).toEqual({ position: [9, 9, 9], target: [0, 1, 0], fov: 33 });
    shots = [];
    await run('render.video', { width: 320, height: 240, camera: { position: [1, 2, 3], target: [0, 0, 0], fov: 50 } });
    expect(shots.every((s) => s.opts.camera?.position[0] === 1 && s.opts.camera.fov === 50)).toBe(true);
    shots = [];
    await run('render.video', { width: 320, height: 240 });
    expect(shots[0].opts.view).toBe('current');
  });

  it('looks through the animated camera when there are camera keys', async () => {
    await slidingCube();
    await run('anim.set_camera_key', { frame: 0, position: [0, 2, 10], target: [0, 0, 0], fov: 40, interpolation: 'linear' });
    await run('anim.set_camera_key', { frame: 20, position: [20, 2, 10], target: [10, 0, 0], fov: 60, interpolation: 'linear' });
    const result = await run('render.video', { width: 320, height: 240, fromFrame: 5, toFrame: 15 });
    expect(result).toMatchObject({ camera: 'animated', frames: 11, fromFrame: 5, toFrame: 15 });
    expect(shots).toHaveLength(11);
    expect(shots[0].opts.camera).toEqual({ position: [5, 2, 10], target: [2.5, 0, 0], fov: 45 });
    expect(shots[10].opts.camera).toEqual({ position: [15, 2, 10], target: [7.5, 0, 0], fov: 55 });
    // A view of one's own wins over the camera keys.
    shots = [];
    expect((await run('render.video', { width: 320, height: 240, view: 'top' })).camera).toBe('fixed');
    expect(shots[0].opts.view).toBe('top');
  });

  it('passes shading and hidden objects on and reports rounded sizes and codec fallbacks', async () => {
    const id = await slidingCube();
    const other = (await run('scene.add_primitive', { type: 'cube', name: 'Floor' })).id;
    encoder.fallback = 'This system has no H.264 encoder, so the MP4 file was encoded as VP9.';
    const result = await run('render.video', { width: 321, height: 241, shading: 'material', hideIds: ['Floor'], format: 'mp4', bitrate: 2_000_000 });
    expect(result).toMatchObject({ width: 322, height: 242, codecName: 'VP9', bitrate: 2_000_000 });
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toMatch(/rounded to 322 x 242/);
    expect(result.warnings[1]).toMatch(/no H\.264 encoder/);
    expect(shots[0].opts).toMatchObject({ shading: 'material', hideIds: [other], width: 322, height: 242 });
    expect(id).toBeTruthy();
    expect((await run('render.video', { width: 320, height: 240, format: 'webm' })).video.mimeType).toBe('video/webm');
  });

  it('works on a document in the background without touching the visible one', async () => {
    await slidingCube();
    const animated = app.activeDocId;
    await run('document.new', {});
    const visible = app.activeDocId;
    expect(visible).not.toBe(animated);
    const before = app;
    const result = await run('render.video', { width: 320, height: 240 }, animated);
    expect(result.frames).toBe(21);
    expect(sequences[0].doc.id).toBe(animated);
    expect(app).toBe(before);
    expect(app.activeDocId).toBe(visible);
    // The visible document has nothing animated.
    await expect(run('render.video', {})).rejects.toThrow(/Nothing is animated/);
  });

  it('stops when cancelled, ends the run of pictures and gives up the recording', async () => {
    await slidingCube();
    encoder.cancelAfter = 4;
    await expect(run('render.video', { width: 320, height: 240 })).rejects.toThrow(VIDEO_CANCELLED);
    expect(recordings[0].pictures).toHaveLength(4);
    expect(recordings[0].finished).toBe(false);
    expect(recordings[0].aborted).toBe(true);
    expect(sequences[0].ended).toBe(true);
    expect(shots).toHaveLength(4);
  });

  it('refuses what cannot be exported, before anything is drawn', async () => {
    await expect(run('render.video', {})).rejects.toThrow(/Nothing is animated/);
    await slidingCube();
    await expect(run('render.video', { toFrame: 21 })).rejects.toThrow(/beyond the end of the animation/);
    await expect(run('render.video', { fromFrame: 10, toFrame: 5 })).rejects.toThrow(/must not be before/);
    await expect(run('render.video', { width: 32 })).rejects.toThrow();
    await expect(run('render.video', { width: 5000 })).rejects.toThrow();
    await expect(run('render.video', { samples: 10 })).rejects.toThrow(/belong to quality "render"/);
    await expect(run('render.video', { view: 'front', camera: { position: [1, 1, 1], target: [0, 0, 0] } })).rejects.toThrow(/not both/);
    await expect(run('render.video', { hideIds: ['nope'] })).rejects.toThrow();
    await expect(run('render.video', { format: 'gif' })).rejects.toThrow();
    await expect(run('render.video', { quality: 'render', shading: 'solid' })).rejects.toThrow(/shading/);
    expect(recordings).toHaveLength(0);
    expect(shots).toHaveLength(0);
    encoder.fail = 'No video encoder for MP4';
    await expect(run('render.video', {})).rejects.toThrow(/No video encoder/);
    const without: CommandContext = { ...ctx, services: { viewport, exporter: null } };
    await expect(runCommand(byId.get('render.video')!, without, {})).rejects.toThrow(/not available/);
  });
});

describe('render.video in render quality', () => {
  it('renders every frame with its budget through the animated camera and tells the encoder how long it may take', async () => {
    const id = await slidingCube();
    await run('anim.set_camera_key', { frame: 0, position: [0, 2, 10], target: [0, 0, 0], fov: 40, interpolation: 'linear' });
    await run('anim.set_camera_key', { frame: 20, position: [20, 2, 10], target: [10, 0, 0], fov: 40, interpolation: 'linear' });
    const result = await run('render.video', { quality: 'render', width: 320, height: 180, fromFrame: 0, toFrame: 4, samples: 8, maxSecondsPerFrame: 2 });
    expect(result).toMatchObject({ frames: 5, quality: 'render', camera: 'animated', width: 320, height: 180 });
    expect(recordings[0].spec).toMatchObject({ quality: 'render', frames: 5, estimateSeconds: 10 });
    expect(renders).toHaveLength(5);
    expect(renders.map((r) => r.state.objects[id].transform.position[0])).toEqual([0, 0.5, 1, 1.5, 2]);
    expect(renders.map((r) => r.job.camera.position[0])).toEqual([0, 1, 2, 3, 4]);
    for (const { job } of renders) expect(job.settings.output).toMatchObject({ width: 320, height: 180, samples: 8, maxSeconds: 2, format: 'png' });
    expect(recordings[0].pictures).toEqual([1, 2, 3, 4, 5].map((n) => ({ mimeType: 'image/png', base64: `frame${n}` })));
    expect(sequences).toHaveLength(0);
  });

  it('uses defaults for samples and time, and one fixed camera without camera keys', async () => {
    await slidingCube();
    await run('render.video', { quality: 'render', width: 320, height: 180, toFrame: 2, view: 'front' });
    expect(renders[0].job.settings.output).toMatchObject({ samples: 24, maxSeconds: 3 });
    // The preset is framed on the first frame; the others keep exactly that camera.
    expect(renders[1].job.camera).toEqual(renders[0].job.camera);
    expect(renders[2].job.camera).toEqual(renders[0].job.camera);
    expect(recordings[0].spec.estimateSeconds).toBe(9);
  });

  it('refuses an export whose own budget is longer than an hour', async () => {
    await slidingCube();
    await run('anim.set_range', { frameCount: 2000 });
    await expect(run('render.video', { quality: 'render', width: 320, height: 180 })).rejects.toThrow(/would take about 6000 s.*maxSecondsPerFrame \(to at most 1\)/);
    expect(recordings).toHaveLength(0);
  });

  it('turns an interrupted render into the cancellation', async () => {
    await slidingCube();
    encoder.cancelAfter = 2;
    await expect(run('render.video', { quality: 'render', width: 320, height: 180 })).rejects.toThrow(VIDEO_CANCELLED);
    expect(renders).toHaveLength(2);
    expect(recordings[0].aborted).toBe(true);
  });
});

describe('pictures of a frame', () => {
  it('view.screenshot { frame } draws the animated pose apart from the screen', async () => {
    const id = await slidingCube();
    const still = await run('view.screenshot', {});
    expect(still.frame).toBeUndefined();
    expect(shots[0].opts).toMatchObject({ view: 'current' });
    expect(shots[0].opts.offscreen).toBeUndefined();
    expect(shots[0].state).toBe(state());

    const result = await run('view.screenshot', { frame: 10 });
    expect(result).toMatchObject({ frame: 10, time: Math.round((10 / 30) * 1e6) / 1e6, animationCamera: false });
    expect(shots[1].opts).toMatchObject({ offscreen: true, view: 'current' });
    expect(shots[1].opts.camera).toBeUndefined();
    expect(shots[1].state.objects[id].transform.position).toEqual([5, 0, 0]);
    expect(shots[1].doc!.id).toBe(app.activeDocId);
    // Fractional frames are evaluated as they are.
    await run('view.screenshot', { frame: 2.5 });
    expect(shots[2].state.objects[id].transform.position).toEqual([1.25, 0, 0]);
    // Nothing of this is passed on as a screenshot option.
    expect('frame' in shots[1].opts || 'useAnimationCamera' in shots[1].opts).toBe(false);
  });

  it('view.screenshot uses the animated camera by default and a given view instead', async () => {
    await slidingCube();
    await run('anim.set_camera_key', { frame: 0, position: [0, 2, 10], target: [0, 0, 0], fov: 40, interpolation: 'linear' });
    await run('anim.set_camera_key', { frame: 20, position: [20, 2, 10], target: [10, 0, 0], fov: 60, interpolation: 'linear' });
    const result = await run('view.screenshot', { frame: 10 });
    expect(result.animationCamera).toBe(true);
    expect(shots[0].opts.camera).toEqual({ position: [10, 2, 10], target: [5, 0, 0], fov: 50 });

    expect((await run('view.screenshot', { frame: 10, view: 'top' })).animationCamera).toBe(false);
    expect(shots[1].opts).toMatchObject({ view: 'top' });
    expect(shots[1].opts.camera).toBeUndefined();
    expect((await run('view.screenshot', { frame: 10, useAnimationCamera: false })).animationCamera).toBe(false);
    expect((await run('view.screenshot', { frame: 10, views: ['front', 'top'] })).animationCamera).toBe(false);
    await expect(run('view.screenshot', { frame: 10, view: 'top', useAnimationCamera: true })).rejects.toThrow(/cannot be combined/);
    await expect(run('view.screenshot', { useAnimationCamera: true })).rejects.toThrow(/needs "frame"/);
    await expect(run('view.screenshot', { frame: -1 })).rejects.toThrow();
    await run('anim.clear', { camera: true });
    await expect(run('view.screenshot', { frame: 10, useAnimationCamera: true })).rejects.toThrow(/no camera keys/);
  });

  it('render.image { frame } renders the animated pose through the animated camera', async () => {
    const id = await slidingCube();
    await run('render.image', {});
    expect(renders[0].state).toBe(state());
    const plain = await run('render.image', { frame: 10 });
    expect(plain).toMatchObject({ frame: 10, animationCamera: false });
    expect(renders[1].state.objects[id].transform.position).toEqual([5, 0, 0]);

    await run('anim.set_camera_key', { frame: 0, position: [0, 2, 10], target: [0, 0, 0], fov: 40, interpolation: 'linear' });
    await run('anim.set_camera_key', { frame: 20, position: [20, 2, 10], target: [10, 0, 0], fov: 60, interpolation: 'linear' });
    // Stored settings that frame the scene must not move the animated camera.
    await run('render.set_settings', { camera: { fit: true } });
    const result = await run('render.image', { frame: 10 });
    expect(result.animationCamera).toBe(true);
    expect(renders[2].job.camera).toEqual({ position: [10, 2, 10], target: [5, 0, 0], fov: 50 });
    expect((await run('render.image', { frame: 10, view: 'front' })).animationCamera).toBe(false);
    expect((await run('render.image', { frame: 10, useAnimationCamera: false })).animationCamera).toBe(false);
    await expect(run('render.image', { frame: 10, camera: { position: [1, 1, 1], target: [0, 0, 0] }, useAnimationCamera: true })).rejects.toThrow(/cannot be combined/);
  });
});
