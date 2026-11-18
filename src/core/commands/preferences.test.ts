import { describe, expect, it } from 'vitest';
import { defaultPreferences, parsePreferences } from '../preferences';
import { createAppState } from '../state';
import type { AppState } from '../types';
import { commandsById } from './index';
import { runCommand, type CommandContext } from './registry';

function setup() {
  let app: AppState = createAppState();
  const ctx: CommandContext = {
    get: () => app,
    set: (update) => {
      app = update(app);
    },
    services: { viewport: null, exporter: null },
  };
  const run = (id: string, params?: unknown) => runCommand(commandsById.get(id)!, ctx, params);
  return { run, app: () => app };
}

describe('preferences', () => {
  it('starts with the defaults', async () => {
    const { run } = setup();
    expect(await run('preferences.get')).toEqual(defaultPreferences);
  });

  it('set changes only the given fields and keeps earlier changes', async () => {
    const { run, app } = setup();
    await run('preferences.set', { theme: 'light', uiScale: 1.25 });
    await run('preferences.set', { language: 'en' });
    expect(app().preferences).toEqual({ ...defaultPreferences, theme: 'light', uiScale: 1.25, language: 'en' });
  });

  it('set rejects invalid values and leaves the preferences untouched', async () => {
    const { run, app } = setup();
    await expect(run('preferences.set', { uiScale: 9 })).rejects.toThrow();
    await expect(run('preferences.set', { accentColor: 'red' })).rejects.toThrow();
    expect(app().preferences).toEqual(defaultPreferences);
  });

  it('is not part of undo and does not mark documents dirty', async () => {
    const { run, app } = setup();
    await run('preferences.set', { theme: 'light' });
    const doc = app().docs[app().activeDocId];
    expect(doc.past).toHaveLength(0);
    expect(doc.dirty).toBe(false);
  });

  it('reset restores the defaults', async () => {
    const { run, app } = setup();
    await run('preferences.set', { fontScale: 1.2 });
    await run('preferences.reset');
    expect(app().preferences).toEqual(defaultPreferences);
  });

  it('undoSteps limits the history', async () => {
    const { run, app } = setup();
    await run('preferences.set', { undoSteps: 10 });
    for (let i = 0; i < 15; i++) await run('scene.add_primitive', { type: 'plane' });
    expect(app().docs[app().activeDocId].past).toHaveLength(10);
  });

  it('parsePreferences keeps valid fields and replaces invalid ones with defaults', () => {
    expect(parsePreferences({ theme: 'light', uiScale: 'big', unknown: 1 })).toEqual({ ...defaultPreferences, theme: 'light' });
    expect(parsePreferences(null)).toEqual(defaultPreferences);
  });
});
