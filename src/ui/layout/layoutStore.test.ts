import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import type { PanelDef } from './registry';

// The store reads and writes localStorage and starts once per module, so each test loads fresh modules.

class MemoryStorage {
  data = new Map<string, string>();
  getItem = (key: string) => this.data.get(key) ?? null;
  setItem = (key: string, value: string) => void this.data.set(key, String(value));
  removeItem = (key: string) => void this.data.delete(key);
}

let storage: MemoryStorage;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  storage = new MemoryStorage();
  vi.stubGlobal('localStorage', storage);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const Nothing = () => null;

const panel = (id: string, extra: Partial<PanelDef> = {}): PanelDef => ({
  id,
  title: () => id,
  icon: Nothing as never,
  component: Nothing,
  side: 'right',
  column: 'sidebar',
  group: id,
  order: 10,
  ...extra,
});

async function load() {
  const store = await import('./layoutStore');
  const registry = await import('./registry');
  const model = await import('./model');
  return { ...store, ...registry, model };
}

describe('layout store', () => {
  it('starts with the default layout and saves changes after they settle', async () => {
    const { registerPanel, initLayout, useLayout, closePanel, STORAGE_KEY, model } = await load();
    registerPanel(panel('outliner'));
    registerPanel(panel('properties', { order: 20 }));
    initLayout();
    expect(model.isPanelOpen(useLayout.getState().layout, 'outliner')).toBe(true);
    closePanel('outliner');
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
    vi.advanceTimersByTime(300);
    const stored = JSON.parse(storage.getItem(STORAGE_KEY)!);
    expect(model.isPanelOpen(stored.layout, 'outliner')).toBe(false);
  });

  it('restores the stored layout and saved layouts on the next start', async () => {
    let s = await load();
    s.registerPanel(panel('outliner'));
    s.registerPanel(panel('properties', { order: 20 }));
    s.initLayout();
    s.setColumnWidth('sidebar', 400);
    s.saveLayout('  Wide   one ');
    s.resetLayout();
    vi.advanceTimersByTime(300);

    s = await load();
    s.registerPanel(panel('outliner'));
    s.registerPanel(panel('properties', { order: 20 }));
    s.initLayout();
    const state = s.useLayout.getState();
    expect(state.layout.right[0].width).toBe(272);
    expect(Object.keys(state.saved)).toEqual(['Wide one']);
    expect(state.current).toBeNull();
    s.applyLayout('Wide one');
    expect(s.useLayout.getState().layout.right[0].width).toBe(400);
    expect(s.useLayout.getState().current).toBe('Wide one');
    s.deleteLayout('Wide one');
    expect(s.useLayout.getState()).toMatchObject({ saved: {}, current: null });
  });

  it('falls back to the default layout when the stored one is unreadable', async () => {
    storage.setItem('tessel.layout', '{not json');
    const { registerPanel, initLayout, useLayout, model } = await load();
    registerPanel(panel('outliner'));
    initLayout();
    expect(model.isPanelOpen(useLayout.getState().layout, 'outliner')).toBe(true);
  });

  it('places a panel registered after start-up at its default place', async () => {
    const { registerPanel, initLayout, useLayout, model } = await load();
    registerPanel(panel('outliner'));
    initLayout();
    registerPanel(panel('history', { group: 'outliner', order: 20 }));
    expect(model.locatePanel(useLayout.getState().layout, 'history')?.group.panels).toEqual(['outliner', 'history']);
  });

  it('keeps a bound store and the layout in step, both ways', async () => {
    const { registerPanel, initLayout, useLayout, closePanel, openPanel, model } = await load();
    const projects = create(() => ({ open: true }));
    registerPanel(
      panel('projects', {
        side: 'left',
        column: 'projects',
        open: false,
        binding: {
          isOpen: () => projects.getState().open,
          setOpen: (open) => projects.setState({ open }),
          subscribe: (listener) => projects.subscribe(listener),
        },
      }),
    );
    initLayout();
    // No stored layout yet: the store's flag (from older versions) decides.
    expect(model.isPanelOpen(useLayout.getState().layout, 'projects')).toBe(true);
    closePanel('projects');
    expect(projects.getState().open).toBe(false);
    projects.setState({ open: true });
    expect(model.isPanelOpen(useLayout.getState().layout, 'projects')).toBe(true);
    openPanel('projects');
    expect(projects.getState().open).toBe(true);
  });

  it('lets a stored layout win over a bound store', async () => {
    let s = await load();
    s.registerPanel(panel('outliner'));
    s.initLayout();
    vi.advanceTimersByTime(300);
    s = await load();
    const projects = create(() => ({ open: true }));
    s.registerPanel(panel('outliner'));
    s.registerPanel(
      panel('projects', {
        side: 'left',
        column: 'projects',
        open: false,
        binding: { isOpen: () => projects.getState().open, setOpen: (open) => projects.setState({ open }), subscribe: (l) => projects.subscribe(l) },
      }),
    );
    s.initLayout();
    // The stored layout had never seen the panel, so it gets its default place: closed.
    expect(s.model.isPanelOpen(s.useLayout.getState().layout, 'projects')).toBe(false);
    expect(projects.getState().open).toBe(false);
  });
});

describe('stored layouts', () => {
  it('cleans names', async () => {
    const { cleanName, MAX_NAME_LENGTH } = await load();
    expect(cleanName('  a \n b ')).toBe('a b');
    expect(cleanName('   ')).toBe('');
    expect(cleanName('x'.repeat(100))).toHaveLength(MAX_NAME_LENGTH);
  });

  it('round-trips and drops broken saved layouts', async () => {
    const { parseStoredLayouts, serializeLayouts, model } = await load();
    const layout = model.defaultLayout([{ id: 'a', side: 'left', column: 'c', group: 'g', order: 1 }]);
    const text = serializeLayouts({ layout, saved: { Mine: layout }, current: 'Mine' });
    expect(parseStoredLayouts(JSON.parse(text))).toEqual({ version: 1, layout, saved: { Mine: layout }, current: 'Mine' });
    const broken = { layout, saved: { Bad: { version: 9 }, '   ': layout }, current: 'Bad' };
    expect(parseStoredLayouts(broken)).toEqual({ version: 1, layout, saved: {}, current: null });
    expect(parseStoredLayouts({ layout: null })).toBeNull();
  });
});
