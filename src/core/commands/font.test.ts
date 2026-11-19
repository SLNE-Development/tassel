import { beforeEach, describe, expect, it } from 'vitest';
import { createFixtureFonts } from '../mesh/fixtures/fontFixture';
import { boundingBox } from '../mesh/polymesh';
import { createText } from '../mesh/text';
import { isClosedManifold } from '../modifiers/testing';
import { activeDoc, createAppState } from '../state';
import type { AppState, DocState, Services } from '../types';
import { commandsById } from './index';
import { runCommand, type CommandContext } from './registry';

let app: AppState;
let services: Partial<Services>;
let fonts: ReturnType<typeof createFixtureFonts>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function run(id: string, params?: unknown): Promise<any> {
  const def = commandsById.get(id);
  if (!def) throw new Error(`Unknown command ${id}`);
  const ctx = {
    get: () => app,
    set: (update: (app: AppState) => AppState) => {
      app = update(app);
    },
    services,
  } as unknown as CommandContext;
  return runCommand(def, ctx, params);
}

const state = (): DocState => activeDoc(app).state;

beforeEach(() => {
  app = createAppState();
  fonts = createFixtureFonts();
  services = { fonts };
});

describe('scene.add_text with an installed font', () => {
  it('sets the text in the font and reports what was used', async () => {
    const result = await run('scene.add_text', { text: 'Tessel', font: 'arial', size: 0.5, depth: 0.04, align: 'left', position: [1, 2, 3] });
    expect(result).toMatchObject({ name: 'Tessel', skipped: [], font: { family: 'Arial', style: 'regular', weight: 400 } });
    expect(fonts.calls).toEqual([{ family: 'arial', bold: false, italic: false, text: 'Tessel' }]);
    const obj = state().objects[result.id];
    expect(isClosedManifold(obj.mesh)).toBe(true);
    expect(obj.smooth).toBe(false);
    expect(obj.transform.position).toEqual([1, 2, 3]);
    expect(state().selection).toEqual([result.id]);
    expect(result.localBounds).toEqual(boundingBox(obj.mesh));
    // Cap height = size ("T" and "l" are flat on top; "l" is an ascender, slightly taller in Arial).
    expect(result.localBounds.min[1]).toBeLessThan(0);
    expect(result.localBounds.min[1]).toBeGreaterThan(-0.02);
    expect(result.localBounds.max[1]).toBeCloseTo(0.5, 2);
    expect(result.localBounds.min[2]).toBe(0);
    expect(result.localBounds.max[2]).toBe(0.04);
    expect(result.localBounds.min[0]).toBeGreaterThan(0);
    expect(result.bounds.min[0]).toBeCloseTo(1 + result.localBounds.min[0], 6);
    expect(result.vertices).toBe(obj.mesh.positions.length / 3);
    expect(result.faces).toBe(obj.mesh.faces.length);
    // The letters are Arial's, not the built-in font's.
    const builtin = await run('scene.add_text', { text: 'Tessel', size: 0.5, depth: 0.04, align: 'left' });
    expect(builtin.vertices).not.toBe(result.vertices);
  });

  it('is one undo step', async () => {
    const { id } = await run('scene.add_text', { text: 'To', font: 'Arial' });
    expect(activeDoc(app).past).toHaveLength(1);
    await run('history.undo');
    expect(state().order).toEqual([]);
    await run('history.redo');
    expect(state().order).toEqual([id]);
  });

  it('passes bold and italic on and reports the style the font had', async () => {
    const bold = await run('scene.add_text', { text: 'H', font: 'Arial', bold: true, italic: true });
    expect(fonts.calls[0]).toMatchObject({ bold: true, italic: true });
    expect(bold.font).toEqual({ family: 'Arial', style: 'bold-italic', weight: 700 });
    // Consolas (in this fixture) has no bold: the closest style is used and named.
    const fallback = await run('scene.add_text', { text: 'H', font: 'Consolas', bold: true });
    expect(fallback.font).toEqual({ family: 'Consolas', style: 'regular', weight: 400 });
  });

  it('asks for the text as it is laid out: composed characters, plain line feeds', async () => {
    const result = await run('scene.add_text', { text: 'He\r\nTo\rL', font: 'Arial' });
    expect(fonts.calls[0].text).toBe('He\nTo\nL');
    expect(result.name).toBe('He To L');
    expect(result.localBounds.min[1]).toBeLessThan(-3);
    await run('scene.add_text', { text: 'Ä', font: 'Arial' }).catch(() => undefined);
    expect(fonts.calls[1].text).toBe('Ä');
  });

  it('leaves out characters the font does not have and reports them', async () => {
    const result = await run('scene.add_text', { text: 'To ☃ L☃', font: 'Arial' });
    expect(result.skipped).toEqual(['☃']);
    await expect(run('scene.add_text', { text: '☃✓', font: 'Arial' })).rejects.toThrow('None of the characters has a glyph in the font "Arial" (skipped: "☃✓")');
    await expect(run('scene.add_text', { text: ' \n ', font: 'Arial' })).rejects.toThrow(/only spaces/);
    expect(state().order).toEqual([result.id]);
  });

  it('fails clearly for a family that is not installed', async () => {
    await expect(run('scene.add_text', { text: 'A', font: 'Comic Neue' })).rejects.toThrow(/No installed font family is called "Comic Neue"/);
    await expect(run('scene.add_text', { text: 'A', font: '' })).rejects.toThrow();
    await expect(run('scene.add_text', { text: 'A', font: 'x'.repeat(201) })).rejects.toThrow();
    await expect(run('scene.add_text', { text: 'A', font: 'Arial', bold: 'yes' })).rejects.toThrow();
    expect(state().order).toEqual([]);
    expect(activeDoc(app).past).toHaveLength(0);
  });

  it('says that system fonts need the desktop app when the service is absent', async () => {
    services = {};
    await expect(run('scene.add_text', { text: 'A', font: 'Arial' })).rejects.toThrow(
      'The font "Arial" cannot be used: system fonts are only available in the desktop app. Use font "default" (the built-in font).',
    );
    expect(state().order).toEqual([]);
    // The built-in font still works there.
    expect((await run('scene.add_text', { text: 'A' })).font).toEqual({ family: 'default', style: 'regular', weight: 400 });
  });

  it('leaves the built-in font exactly as it was, whatever bold and italic say', async () => {
    for (const params of [{}, { font: 'default' }, { font: ' Default ' }, { font: 'default', bold: true, italic: true }]) {
      const result = await run('scene.add_text', { text: 'Gate 7\nNorth', size: 0.4, depth: 0.03, align: 'right', ...params });
      expect(state().objects[result.id].mesh).toEqual(createText('Gate 7\nNorth', { size: 0.4, depth: 0.03, align: 'right' }).mesh);
      expect(result.font).toEqual({ family: 'default', style: 'regular', weight: 400 });
    }
    expect(fonts.calls).toEqual([]);
  });
});

describe('font.list', () => {
  it('lists the installed families with their styles', async () => {
    const result = await run('font.list');
    expect(result).toMatchObject({ available: true, builtin: 'default', count: 3, truncated: false });
    expect(result.families.map((f: { family: string }) => f.family)).toEqual(['Arial', 'Consolas', 'Segoe UI']);
    expect(result.families[0].styles).toContainEqual({ style: 'bold-italic', weight: 700, italic: true });
    expect(result.families[1].monospaced).toBe(true);
  });

  it('filters by name and caps the list', async () => {
    expect((await run('font.list', { search: ' SEGOE ' })).families.map((f: { family: string }) => f.family)).toEqual(['Segoe UI']);
    expect(await run('font.list', { search: 'zz' })).toMatchObject({ count: 0, truncated: false, families: [] });
    const capped = await run('font.list', { limit: 2 });
    expect(capped).toMatchObject({ count: 3, truncated: true });
    expect(capped.families).toHaveLength(2);
    await expect(run('font.list', { limit: 0 })).rejects.toThrow();
    await expect(run('font.list', { search: 'x'.repeat(201) })).rejects.toThrow();
  });

  it('reports that there are no system fonts outside the desktop app and changes nothing', async () => {
    services = {};
    expect(await run('font.list')).toEqual({ available: false, builtin: 'default', count: 0, truncated: false, families: [] });
    expect(activeDoc(app).past).toHaveLength(0);
    expect(activeDoc(app).dirty).toBe(false);
  });
});
