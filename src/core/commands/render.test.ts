import { beforeEach, describe, expect, it } from 'vitest';
import { defaultRenderSettings, type RenderJob } from '../render';
import { activeDoc, createAppState } from '../state';
import type { AppState, DocState } from '../types';
import { commands } from './index';
import { runCommand, type AnyCommand, type CommandContext } from './registry';
import { runCommandOn } from './targeting';

const byId = new Map<string, AnyCommand>(commands.map((c) => [c.id, c]));

let app: AppState;
let jobs: { state: DocState; job: RenderJob }[];
/** Runs while the fake renderer is "rendering". */
let during: (() => unknown) | null;
let cameraCalls: (string | undefined)[];
const ctx: CommandContext = {
  get: () => app,
  set: (update) => {
    app = update(app);
  },
  services: {
    viewport: null,
    exporter: null,
    renderer: {
      async render(state, job) {
        jobs.push({ state, job });
        await during?.();
        const { width, height, format, samples } = job.settings.output;
        return { mimeType: `image/${format}`, base64: 'AAAA', width, height, samples: Math.min(samples, 7), seconds: 1.25, converged: samples <= 7 };
      },
    },
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function run(id: string, params?: unknown, documentId?: string): Promise<any> {
  const def = byId.get(id);
  if (!def) throw new Error(`Unknown command ${id}`);
  return documentId ? runCommandOn(def, ctx, params, documentId) : runCommand(def, ctx, params);
}

const doc = () => activeDoc(app);
let cube: string;
let ball: string;

beforeEach(async () => {
  app = createAppState();
  jobs = [];
  during = null;
  cameraCalls = [];
  ctx.services.viewport = null;
  cube = (await run('scene.add_primitive', { type: 'cube', name: 'Cube', size: 2 })).id;
  ball = (await run('scene.add_primitive', { type: 'uv_sphere', name: 'Ball', position: [10, 0, 0] })).id;
});

describe('render settings commands', () => {
  it('reports the defaults until something is changed', async () => {
    expect(await run('render.get_settings')).toEqual({ settings: defaultRenderSettings, isDefault: true });
    expect(doc().state.render).toBeUndefined();
  });

  it('stores a partial change as one undo step', async () => {
    const steps = doc().past.length;
    const result = await run('render.set_settings', { environment: { preset: 'studio' }, sun: { enabled: false }, output: { width: 800, height: 600 } });
    expect(result.settings.environment).toEqual({ ...defaultRenderSettings.environment, preset: 'studio' });
    expect(result.settings.sun.enabled).toBe(false);
    expect(result.settings.sun.elevation).toBe(defaultRenderSettings.sun.elevation);
    expect(doc().state.render).toEqual(result.settings);
    expect(doc().past.length).toBe(steps + 1);
    expect(doc().dirty).toBe(true);
    expect((await run('render.get_settings')).isDefault).toBe(false);

    // The same values again are not a step.
    await run('render.set_settings', { sun: { enabled: false } });
    expect(doc().past.length).toBe(steps + 1);

    await run('history.undo');
    expect(doc().state.render).toBeUndefined();
    await run('history.redo');
    expect(doc().state.render?.output.width).toBe(800);

    const reset = await run('render.set_settings', { reset: true, sun: { azimuth: 90 } });
    expect(reset.settings).toEqual({ ...defaultRenderSettings, sun: { ...defaultRenderSettings.sun, azimuth: 90 } });
  });

  it('rejects values out of range and settings that cannot work together', async () => {
    await expect(run('render.set_settings', { output: { width: 5000 } })).rejects.toThrow();
    await expect(run('render.set_settings', { sun: { elevation: 120 } })).rejects.toThrow();
    await expect(run('render.set_settings', { background: { color: 'red' } })).rejects.toThrow();
    await expect(run('render.set_settings', { environment: { preset: 'moon' } })).rejects.toThrow();
    await expect(run('render.set_settings', { output: { maxSeconds: 601 } })).rejects.toThrow();
    await expect(run('render.set_settings', { background: { type: 'transparent' }, output: { format: 'jpeg' } })).rejects.toThrow(/alpha channel/);
    expect(doc().state.render).toBeUndefined();
  });
});

describe('render.image', () => {
  it('renders with the stored settings and changes nothing', async () => {
    await run('render.set_settings', { output: { width: 640, height: 360, samples: 5 } });
    const before = app;
    const result = await run('render.image');
    expect(app).toBe(before);
    expect(result.image).toEqual({ mimeType: 'image/png', base64: 'AAAA' });
    expect(result).toMatchObject({ width: 640, height: 360, samples: 5, seconds: 1.25, converged: true });
    expect(result.camera.fov).toBe(40);
    expect(result.camera.direction).toContain('camera at');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].state).toBe(doc().state);
    expect(jobs[0].job.settings).toEqual(doc().state.render);
    expect(jobs[0].job.hideIds).toEqual([]);
    expect(byId.get('render.image')?.history).toBe(false);
    expect(byId.get('render.image')?.concurrent).toBe(true);
  });

  it('applies one-off overrides without storing them', async () => {
    const steps = doc().past.length;
    const result = await run('render.image', {
      width: 320,
      height: 200,
      samples: 9,
      maxSeconds: 3,
      format: 'webp',
      view: 'front',
      sun: { elevation: 12 },
      background: { type: 'transparent' },
      output: { exposure: 1, bounces: 2 },
    });
    const { settings, camera } = jobs[0].job;
    expect(settings.output).toMatchObject({ width: 320, height: 200, samples: 9, maxSeconds: 3, format: 'webp', exposure: 1, bounces: 2, denoise: defaultRenderSettings.output.denoise });
    expect(settings.sun).toEqual({ ...defaultRenderSettings.sun, elevation: 12 });
    expect(settings.background.type).toBe('transparent');
    expect(settings.camera.view).toBe('front');
    expect(result.image.mimeType).toBe('image/webp');
    expect(result.converged).toBe(false);
    // Front: the camera is on +Z of the middle of both objects, far enough to see them.
    expect(camera.target[0]).toBeCloseTo(5);
    expect(camera.position[2]).toBeGreaterThan(5);
    expect(camera.position[0]).toBeCloseTo(5);
    expect(doc().state.render).toBeUndefined();
    expect(doc().past.length).toBe(steps);
  });

  it('takes an explicit camera, fits to objects, hides objects and focuses', async () => {
    await run('render.image', { camera: { position: [0, 0, 20], target: [0, 0, 0], fov: 30 }, fit: ['Ball'], hideIds: ['Cu*'], depthOfField: { enabled: true }, focusOn: 'Ball' });
    const { camera, hideIds, focusDistance, settings } = jobs[0].job;
    expect(hideIds).toEqual([cube]);
    expect(camera.fov).toBe(30);
    expect(camera.target).toEqual([10, 0, 0]);
    expect(camera.position[0]).toBeCloseTo(10);
    expect(camera.position[2]).toBeGreaterThan(1);
    expect(focusDistance).toBeCloseTo(camera.position[2]);
    expect(settings.camera.fit).toBe(true);
    expect(settings.depthOfField.enabled).toBe(true);
    void ball;

    // Without focusOn the focus is the camera target, or the stored distance.
    await run('render.image', { camera: { position: [0, 0, 20], target: [0, 0, 0] } });
    expect(jobs[1].job.focusDistance).toBeCloseTo(20);
    await run('render.image', { camera: { position: [0, 0, 20], target: [0, 0, 0] }, depthOfField: { focusDistance: 3 } });
    expect(jobs[2].job.focusDistance).toBe(3);
  });

  it('uses the camera of the document for "current"', async () => {
    ctx.services.viewport = {
      getCamera: (target) => {
        cameraCalls.push(target?.id);
        return { position: [1, 2, 3], target: [0, 0, 0] };
      },
    } as CommandContext['services']['viewport'];
    const result = await run('render.image');
    expect(cameraCalls).toEqual([doc().id]);
    expect(result.camera).toMatchObject({ position: [1, 2, 3], target: [0, 0, 0], fov: 40 });
    // With fit the direction stays and the distance changes.
    await run('render.image', { fit: true });
    const fitted = jobs[1].job.camera;
    expect(fitted.target).toEqual([5, 0, 0]);
    expect(fitted.position[1] - fitted.target[1]).toBeGreaterThan(2);
  });

  it('validates its parameters before rendering', async () => {
    await expect(run('render.image', { width: 8 })).rejects.toThrow();
    await expect(run('render.image', { width: 4097 })).rejects.toThrow();
    await expect(run('render.image', { maxSeconds: 601 })).rejects.toThrow();
    await expect(run('render.image', { samples: 0 })).rejects.toThrow();
    await expect(run('render.image', { format: 'gif' })).rejects.toThrow();
    await expect(run('render.image', { view: 'iso', camera: { position: [1, 1, 1], target: [0, 0, 0] } })).rejects.toThrow(/not both/);
    await expect(run('render.image', { camera: { position: [1, 1, 1], target: [1, 1, 1] } })).rejects.toThrow(/same point/);
    await expect(run('render.image', { camera: { position: [1, 1, Infinity], target: [0, 0, 0] } })).rejects.toThrow();
    await expect(run('render.image', { background: { type: 'transparent' }, format: 'jpeg' })).rejects.toThrow(/alpha channel/);
    await expect(run('render.image', { hideIds: ['Nope'] })).rejects.toThrow(/Nope/);
    await expect(run('render.image', { hideIds: ['__proto__'] })).rejects.toThrow();
    await expect(run('render.image', { focusOn: 'Nope' })).rejects.toThrow(/Nope/);
    await expect(run('render.image', { hideIds: ['*'] })).rejects.toThrow(/Nothing to render/);
    expect(jobs).toHaveLength(0);

    await run('scene.delete_objects', { ids: [cube, ball] });
    await expect(run('render.image')).rejects.toThrow('Nothing to render: the document has no objects.');
    const noRenderer = { ...ctx, services: { viewport: null, exporter: null } };
    await expect(runCommand(byId.get('render.image')!, noRenderer, {})).rejects.toThrow(/not ready/);
  });

  it('renders a document in the background without touching the visible one', async () => {
    const visible = doc().id;
    const other = (await run('document.new', { name: 'Other', activate: false })).id;
    expect(app.activeDocId).toBe(visible);
    await run('scene.add_primitive', { type: 'cone', name: 'Cone', position: [0, 5, 0] }, other);
    await run('render.set_settings', { environment: { preset: 'night' } }, other);
    expect(app.docs[visible].state.render).toBeUndefined();

    // The document may change while the render runs: the render keeps the state it started with.
    const started = app.docs[other].state;
    during = () => run('scene.add_primitive', { type: 'cube', name: 'Late' }, other);
    const before = app.docs[visible];
    const result = await run('render.image', { view: 'top', samples: 3 }, other);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].state).toBe(started);
    expect(jobs[0].job.settings.environment.preset).toBe('night');
    expect(result.camera.target).toEqual([0, 5, 0]);
    expect(app.activeDocId).toBe(visible);
    expect(app.docs[visible]).toBe(before);
    expect(Object.keys(app.docs[other].state.objects)).toHaveLength(2);

    await expect(run('render.image', {}, 'missing')).rejects.toThrow(/does not exist/);
  });
});
