import { beforeEach, describe, expect, it } from 'vitest';
import type { MinecraftAssetsService, MinecraftAssetsStatus } from '../minecraftAssets';
import { defaultPreferences, parsePreferences } from '../preferences';
import { angleDirections, cameraFrom, withCameraAngle } from '../preview';
import { createAppState } from '../state';
import type { AppState, CameraPose, ViewportService } from '../types';
import { previewCommands } from './preview';
import { runCommand, type AnyCommand, type CommandContext } from './registry';

const byId = new Map<string, AnyCommand>(previewCommands.map((c) => [c.id, c]));

let app: AppState;
let camera: CameraPose;
let assets: MinecraftAssetsStatus;
const services: CommandContext['services'] = { viewport: null, exporter: null };

const viewport: ViewportService = {
  screenshot: async () => {
    throw new Error('not used');
  },
  getCamera: () => camera,
  setCamera: (pose) => {
    camera = { position: pose.position ?? camera.position, target: pose.target ?? camera.target };
  },
  setView: () => {},
  frame: () => {},
};

const minecraftAssets: MinecraftAssetsService = {
  status: () => assets,
  reload: async () => {
    assets = { state: 'ready', path: app.preferences.minecraftAssets, info: { path: app.preferences.minecraftAssets, kind: 'jar', namespaces: ['minecraft'], version: '1.21.4' }, error: null };
    return assets;
  },
  detect: async () => [{ version: '1.21.4', path: 'C:/mc/versions/1.21.4/1.21.4.jar', modified: 1 }],
  list: async () => [],
};

const ctx: CommandContext = {
  get: () => app,
  set: (update) => {
    app = update(app);
  },
  services,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function run(id: string, params?: unknown): Promise<any> {
  return runCommand(byId.get(id)!, ctx, params);
}

beforeEach(() => {
  app = createAppState();
  camera = { position: [0, 0, 10], target: [0, 0, 0] };
  assets = { state: 'none', path: '', info: null, error: null };
  services.viewport = viewport;
  services.minecraftAssets = minecraftAssets;
});

describe('preview preferences', () => {
  it('have defaults that keep the viewport as it was', () => {
    expect(defaultPreferences).toMatchObject({
      previewScene: 'none',
      previewBackground: 'solid',
      previewGround: false,
      previewPixelGrid: false,
      previewPlayer: false,
      previewCraftingTable: false,
      viewportProjection: 'perspective',
      cameraAngles: [],
      minecraftAssets: '',
    });
  });

  it('fall back one by one when stored values are invalid', () => {
    const parsed = parsePreferences({ previewScene: 'mars', previewPlayer: true, cameraAngles: [{ name: '' }] });
    expect(parsed.previewScene).toBe('none');
    expect(parsed.previewPlayer).toBe(true);
    expect(parsed.cameraAngles).toEqual([]);
  });
});

describe('view.set_preview / view.get_preview', () => {
  it('changes only what is given and never touches the document', async () => {
    const docs = app.docs;
    const result = await run('view.set_preview', { scene: 'plains', player: true });
    expect(result).toMatchObject({ scene: 'plains', player: true, craftingTable: false, background: 'solid', usesVanillaTextures: false, minecraftAssets: 'none' });
    expect(app.preferences.previewScene).toBe('plains');
    expect(app.docs).toBe(docs);

    const ground = await run('view.set_preview', { ground: true, pixelGrid: true, craftingTable: true });
    expect(ground).toMatchObject({ scene: 'plains', ground: true, pixelGrid: true, craftingTable: true, player: true });
  });

  it('switches to the custom background when a colour is given', async () => {
    expect(await run('view.set_preview', { backgroundColor: '#AABBCC' })).toMatchObject({ background: 'custom', backgroundColor: '#aabbcc' });
    expect(await run('view.set_preview', { background: 'checkerboard', backgroundColor: '#112233' })).toMatchObject({ background: 'checkerboard', backgroundColor: '#112233' });
  });

  it('rejects unknown scenes and colours', async () => {
    await expect(run('view.set_preview', { scene: 'mars' })).rejects.toThrow();
    await expect(run('view.set_preview', { backgroundColor: 'red' })).rejects.toThrow();
  });

  it('reports the scenes, saved angles and whether vanilla textures are used', async () => {
    assets = { state: 'ready', path: 'x.jar', info: null, error: null };
    await run('view.set_preview', { scene: 'nether' });
    const state = await run('view.get_preview');
    expect(state.scenes).toContain('deep_dark');
    expect(state.scenes).toContain('studio');
    expect(state.usesVanillaTextures).toBe(true);
    await run('view.set_preview', { scene: 'sky' });
    expect((await run('view.get_preview')).usesVanillaTextures).toBe(false);
  });
});

describe('camera angles', () => {
  it('turns the camera around the target at the same distance', async () => {
    camera = { position: [1, 2, 3], target: [1, 2, -2] };
    const result = await run('view.set_angle', { preset: 'east' });
    expect(result.position).toEqual([6, 2, -2]);
    expect(result.target).toEqual([1, 2, -2]);
    expect(result.projection).toBe('perspective');
    expect((await run('view.set_angle', { preset: 'north' })).position).toEqual([1, 2, -7]);
  });

  it('switches isometric presets to orthographic', async () => {
    const result = await run('view.set_angle', { preset: 'true_iso' });
    expect(result.projection).toBe('orthographic');
    const [x, y, z] = result.position;
    // True isometry: equal parts of every axis.
    expect(x).toBeCloseTo(y, 5);
    expect(y).toBeCloseTo(z, 5);
    // 2:1 isometry: 30° above the horizon.
    const dimetric = cameraFrom({ position: [0, 0, 1], target: [0, 0, 0] }, angleDirections.iso_left).position;
    expect(Math.asin(dimetric[1]) * (180 / Math.PI)).toBeCloseTo(30, 5);
    expect(dimetric[0]).toBeLessThan(0);
  });

  it('saves, restores, overwrites and deletes named angles', async () => {
    camera = { position: [4, 5, 6], target: [0, 1, 0] };
    await run('view.set_projection', { projection: 'orthographic' });
    expect(await run('view.save_angle', { name: ' Hero ' })).toEqual({ name: 'Hero', position: [4, 5, 6], target: [0, 1, 0], projection: 'orthographic' });

    camera = { position: [9, 9, 9], target: [0, 0, 0] };
    await run('view.set_projection', { projection: 'perspective' });
    const restored = await run('view.set_angle', { name: 'hero' });
    expect(restored).toEqual({ position: [4, 5, 6], target: [0, 1, 0], projection: 'orthographic' });

    camera = { position: [1, 1, 1], target: [0, 0, 0] };
    await run('view.save_angle', { name: 'HERO' });
    expect(app.preferences.cameraAngles).toHaveLength(1);
    expect(app.preferences.cameraAngles[0].position).toEqual([1, 1, 1]);

    await expect(run('view.set_angle', { name: 'missing' })).rejects.toThrow(/Saved: "HERO"/);
    await expect(run('view.set_angle', {})).rejects.toThrow();
    await expect(run('view.set_angle', { preset: 'top', name: 'HERO' })).rejects.toThrow();
    expect(await run('view.delete_angle', { name: 'hero' })).toEqual({ deleted: 'HERO' });
    expect(app.preferences.cameraAngles).toEqual([]);
  });

  it('limits the number of saved angles', () => {
    let angles = withCameraAngle([], { name: 'a0', position: [0, 0, 1], target: [0, 0, 0], projection: 'perspective' });
    for (let i = 1; i < 50; i++) angles = withCameraAngle(angles, { ...angles[0], name: `a${i}` });
    expect(() => withCameraAngle(angles, { ...angles[0], name: 'one more' })).toThrow(/At most 50/);
    expect(withCameraAngle(angles, { ...angles[0], name: 'A3', projection: 'orthographic' })[3].projection).toBe('orthographic');
  });

  it('needs the viewport', async () => {
    services.viewport = null;
    await expect(run('view.set_angle', { preset: 'top' })).rejects.toThrow(/viewport/);
  });
});

describe('Minecraft assets commands', () => {
  it('sets the source and reports its status', async () => {
    expect(await run('assets.get_minecraft')).toEqual({ state: 'none', path: '', info: null, error: null });
    const status = await run('assets.set_minecraft', { path: ' C:/mc/1.21.4.jar ' });
    expect(app.preferences.minecraftAssets).toBe('C:/mc/1.21.4.jar');
    expect(status).toMatchObject({ state: 'ready', info: { version: '1.21.4' } });
    expect(await run('assets.detect_minecraft')).toEqual({ installs: [{ version: '1.21.4', path: 'C:/mc/versions/1.21.4/1.21.4.jar', modified: 1 }] });
  });

  it('says when there is no assets service (browser build)', async () => {
    services.minecraftAssets = null;
    app = { ...app, preferences: { ...app.preferences, minecraftAssets: 'x.jar' } };
    expect(await run('assets.get_minecraft')).toMatchObject({ state: 'unavailable', path: 'x.jar' });
    await expect(run('assets.detect_minecraft')).rejects.toThrow(/desktop app/);
  });
});
