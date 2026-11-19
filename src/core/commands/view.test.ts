import { beforeEach, describe, expect, it } from 'vitest';
import { activeDoc, createAppState } from '../state';
import type { AppState, ScreenshotOptions, ScreenshotResult, ViewportService } from '../types';
import { runCommand, type AnyCommand, type CommandContext } from './registry';
import { sceneCommands } from './scene';
import { viewCommands } from './view';

const byId = new Map<string, AnyCommand>([...sceneCommands, ...viewCommands].map((c) => [c.id, c]));

let app: AppState;
let shots: ScreenshotOptions[];

const fakeResult: ScreenshotResult = {
  base64: 'AAAA',
  views: [
    {
      name: 'front',
      cameraPosition: [0, 0, 5],
      cameraTarget: [0, 0, 0],
      fov: 50,
      direction: 'camera at +Z looking toward -Z',
      imageRight: '+X',
      imageUp: '+Y',
      rect: { x: 0, y: 0, width: 1024, height: 768 },
    },
  ],
  width: 1024,
  height: 768,
  backend: 'webgpu',
};

const viewport: ViewportService = {
  screenshot: async (opts) => {
    shots.push(opts);
    return fakeResult;
  },
  getCamera: () => ({ position: [0, 0, 5], target: [0, 0, 0] }),
  setCamera: () => {},
  setView: () => {},
  frame: () => {},
};

const ctx: CommandContext = {
  get: () => app,
  set: (update) => {
    app = update(app);
  },
  services: { viewport, exporter: null },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function run(id: string, params?: unknown): Promise<any> {
  return runCommand(byId.get(id)!, ctx, params);
}

async function add(name: string): Promise<string> {
  return (await run('scene.add_primitive', { type: 'cube', name })).id;
}

beforeEach(() => {
  app = createAppState();
  shots = [];
});

describe('view.screenshot', () => {
  it('keeps working as before and returns the view data next to the image', async () => {
    const result = await run('view.screenshot', {});
    expect(shots).toEqual([{ width: 1024, height: 768, view: 'current', fit: false, xray: false, hideIds: undefined, onlyIds: undefined }]);
    expect(result.image).toEqual({ mimeType: 'image/png', base64: 'AAAA' });
    expect(result).not.toHaveProperty('base64');
    expect(result.views).toEqual(fakeResult.views);
    expect(result).toMatchObject({ width: 1024, height: 768, backend: 'webgpu' });

    await run('view.screenshot', { view: 'top', fit: true, width: 640, height: 480 });
    expect(shots[1]).toMatchObject({ width: 640, height: 480, view: 'top', fit: true });
  });

  it('passes a camera, views, shading and xray through', async () => {
    const camera = { position: [1, 2, 3], target: [0, 0, 0], fov: 35 };
    await run('view.screenshot', { camera, shading: 'wireframe', xray: true });
    expect(shots[0]).toMatchObject({ camera, shading: 'wireframe', xray: true });
    await run('view.screenshot', { views: ['front', 'current', { position: [0, 9, 0], target: [0, 0, 0] }] });
    expect(shots[1].views).toEqual(['front', 'current', { position: [0, 9, 0], target: [0, 0, 0] }]);
  });

  it('resolves ids, names and globs in hideIds, onlyIds and fit', async () => {
    const hopper = await add('Hopper');
    const a = await add('Roller A');
    const b = await add('Roller B');
    await run('view.screenshot', { hideIds: ['Hopper'], onlyIds: ['Roller *', hopper], fit: [a, 'Roller B'] });
    expect(shots[0].hideIds).toEqual([hopper]);
    expect(shots[0].onlyIds).toEqual([a, b, hopper]);
    expect(shots[0].fit).toEqual([a, b]);
    await run('view.screenshot', { fit: [] });
    expect(shots[1].fit).toBe(true);
  });

  it('changes nothing in the document', async () => {
    const id = await add('Box');
    const before = activeDoc(app);
    await run('view.screenshot', { hideIds: [id], shading: 'material', xray: true, views: ['front', 'iso'] });
    expect(activeDoc(app)).toBe(before);
    expect(app.shading).toBe('solid');
  });

  it('rejects unknown objects and malformed options with a clear message', async () => {
    await add('Box');
    await expect(run('view.screenshot', { hideIds: ['Nope'] })).rejects.toThrow(/Object "Nope" does not exist/);
    await expect(run('view.screenshot', { onlyIds: ['toString'] })).rejects.toThrow(/does not exist/);
    await expect(run('view.screenshot', { fit: ['No*'] })).rejects.toThrow(/matches no object name/);
    await expect(run('view.screenshot', { onlyIds: [] })).rejects.toThrow();
    await expect(run('view.screenshot', { views: [] })).rejects.toThrow();
    await expect(run('view.screenshot', { views: Array(10).fill('front') })).rejects.toThrow();
    await expect(run('view.screenshot', { views: ['sideways'] })).rejects.toThrow();
    await expect(run('view.screenshot', { views: ['front'], camera: { position: [0, 0, 1], target: [0, 0, 0] } })).rejects.toThrow(
      /Give either/,
    );
    await expect(run('view.screenshot', { camera: { position: [0, 0, 1] } })).rejects.toThrow();
    await expect(run('view.screenshot', { camera: { position: [0, 0, Infinity], target: [0, 0, 0] } })).rejects.toThrow();
    await expect(run('view.screenshot', { camera: { position: [0, 0, 1], target: [0, 0, 0], fov: 179 } })).rejects.toThrow();
    await expect(run('view.screenshot', { shading: 'glossy' })).rejects.toThrow();
    await expect(run('view.screenshot', { width: 100000 })).rejects.toThrow();
    expect(shots).toEqual([]);
  });
});
