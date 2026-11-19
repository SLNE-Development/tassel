import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Action } from './actions';

// The UI modules read `window` while loading (the pointer position of the unwrap menu); tests run in node.
vi.stubGlobal('window', { innerWidth: 1000, innerHeight: 800, addEventListener: () => {} });

let actions: readonly Action[];
let actionAllowedIn: (typeof import('./actions'))['actionAllowedIn'];
let matchShortcut: (typeof import('./actions'))['matchShortcut'];
let isAvailable: (typeof import('./actions'))['isAvailable'];
let fallbackFor: (typeof import('./formatGuards'))['fallbackFor'];

beforeAll(async () => {
  ({ actions, actionAllowedIn, matchShortcut, isAvailable } = await import('./actions'));
  ({ fallbackFor } = await import('./formatGuards'));
});

const byId = (id: string): Action => actions.find((a) => a.id === id)!;
const allowedIn = (format: 'free' | 'minecraft_java') => new Set(actions.filter((a) => actionAllowedIn(a, format)).map((a) => a.id));

describe('actions per document format', () => {
  let free: Set<string>;
  let minecraft: Set<string>;
  beforeAll(() => {
    free = allowedIn('free');
    minecraft = allowedIn('minecraft_java');
  });

  it('offers the free-form tools only in free documents', () => {
    for (const id of ['add.cube', 'add.text', 'mesh.extrude', 'mode.toggle', 'mode.edit', 'element.vertex', 'uv.pack', 'uv.rotate_right', 'paint.fill', 'bake.open', 'timeline.toggle', 'video.export', 'tool.scale', 'workspace.paint', 'file.import', 'file.export_obj', 'file.export_usdz']) {
      expect(byId(id), id).toBeDefined();
      expect(free.has(id), `${id} in free`).toBe(true);
      expect(minecraft.has(id), `${id} in minecraft`).toBe(false);
    }
  });

  it('offers the cuboid actions only in Minecraft documents', () => {
    for (const id of ['add.cuboid', 'mc.flip_x', 'mc.rotate_y_plus', 'mc.center_pivot', 'mc.auto_cullface', 'mc.uv_auto', 'mc.validate', 'file.export_json']) {
      expect(byId(id), id).toBeDefined();
      expect(minecraft.has(id), `${id} in minecraft`).toBe(true);
      expect(free.has(id), `${id} in free`).toBe(false);
    }
  });

  it('keeps everything else in both formats', () => {
    for (const id of ['file.new', 'file.open', 'file.open_java', 'file.save', 'file.export_glb', 'edit.undo', 'edit.duplicate', 'edit.delete', 'add.menu', 'tool.move', 'tool.rotate', 'tool.select', 'workspace.uv', 'workspace.modeling', 'view.frame', 'palette.open', 'render.open']) {
      expect(byId(id), id).toBeDefined();
      expect(free.has(id), `${id} in free`).toBe(true);
      expect(minecraft.has(id), `${id} in minecraft`).toBe(true);
    }
  });

  it('never offers a free-only action in a Minecraft document', () => {
    // Every action that stands for a registry command follows the command's formats.
    const leaked = actions.filter((a) => a.command && minecraft.has(a.id) && /^(mesh|edit|uv|modifier|material|paint|bake|anim)\./.test(a.command) && !a.command.startsWith('edit.undo'));
    expect(leaked.map((a) => a.id)).toEqual([]);
  });

  it('does not bind shortcuts of unavailable actions', () => {
    // matchShortcut reads the active document, which is a free one here: the free-only 'S' (scale) still works.
    const key = (init: Partial<KeyboardEvent>) => ({ ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...init }) as KeyboardEvent;
    expect(matchShortcut(key({ key: 's', code: 'KeyS' }))?.id).toBe('tool.scale');
  });
});

describe('the active document decides', () => {
  const key = (init: Partial<KeyboardEvent>) => ({ ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...init }) as KeyboardEvent;

  it('hides free-only actions and shortcuts once a Minecraft document is active, and brings them back', async () => {
    const { execute } = await import('../app/store');
    expect(isAvailable(byId('add.cube'))).toBe(true);
    expect(isAvailable(byId('add.cuboid'))).toBe(false);
    await execute('document.new', { format: 'minecraft_java' });
    expect(isAvailable(byId('add.cube'))).toBe(false);
    expect(isAvailable(byId('add.cuboid'))).toBe(true);
    expect(isAvailable(byId('mc.flip_x'))).toBe(true);
    expect(matchShortcut(key({ key: 's', code: 'KeyS' }))).toBeUndefined();
    expect(matchShortcut(key({ key: 'g', code: 'KeyG' }))?.id).toBe('tool.move');
    await execute('document.new', {});
    expect(matchShortcut(key({ key: 's', code: 'KeyS' }))?.id).toBe('tool.scale');
  });
});

describe('format guards', () => {
  it('moves the app-wide tool and workspace off what a Minecraft document does not have', () => {
    expect(fallbackFor({ tool: 'scale', workspace: 'paint' }, true)).toEqual({ tool: 'move', workspace: 'modeling' });
    expect(fallbackFor({ tool: 'rotate', workspace: 'uv' }, true)).toBeNull();
    expect(fallbackFor({ tool: 'scale', workspace: 'paint' }, false)).toBeNull();
  });
});
