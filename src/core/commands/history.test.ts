import { beforeEach, describe, expect, it } from 'vitest';
import { historyEntries } from '../history';
import { activeDoc, createAppState } from '../state';
import type { AppState } from '../types';
import { documentCommands } from './document';
import { runCommand, type AnyCommand, type CommandContext } from './registry';
import { sceneCommands } from './scene';
import { runCommandOn } from './targeting';

const byId = new Map<string, AnyCommand>([...documentCommands, ...sceneCommands].map((c) => [c.id, c]));

let app: AppState;
const ctx: CommandContext = {
  get: () => app,
  set: (update) => {
    app = update(app);
  },
  services: { viewport: null, exporter: null },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function run(id: string, params?: unknown, documentId?: string): Promise<any> {
  const def = byId.get(id);
  if (!def) throw new Error(`Unknown command ${id}`);
  return documentId === undefined ? runCommand(def, ctx, params) : runCommandOn(def, ctx, params, documentId);
}

const doc = () => activeDoc(app);
const names = () => doc().state.order.map((id) => doc().state.objects[id].name);
const add = async (type = 'cube', name?: string) => (await run('scene.add_primitive', { type, ...(name ? { name } : {}) })).id as string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const list = async (documentId?: string): Promise<any> => run('history.list', {}, documentId);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const labels = async () => (await list()).entries.map((e: any) => e.label);

beforeEach(() => {
  app = createAppState();
});

describe('history labels', () => {
  it('starts with the new document and labels each change with its command and object', async () => {
    const id = await add('cube', 'Kiste');
    await run('scene.rename_object', { id, name: 'Truhe' });
    await run('scene.set_transform', { items: [{ id, position: [1, 0, 0] }] });
    expect(await labels()).toEqual(['New Document', 'Add Primitive: Kiste', 'Rename Object: Truhe', 'Set Transform: Truhe']);
    const result = await list();
    expect(result.current).toBe(3);
    expect(result.documentId).toBe(app.activeDocId);
    expect(result.entries[1]).toMatchObject({ index: 1, command: 'scene.add_primitive', detail: 'Kiste', current: false, undone: false });
    expect(result.entries[3]).toMatchObject({ index: 3, current: true, undone: false });
    expect(Date.parse(result.entries[3].time)).not.toBeNaN();
  });

  it('labels a deleted object by the name it had', async () => {
    const id = await add('cube', 'Weg');
    await run('scene.delete_objects', { ids: [id] });
    expect((await labels()).at(-1)).toBe('Delete Objects: Weg');
  });

  it('leaves history: false commands out', async () => {
    const id = await add();
    await run('scene.select', { ids: [] });
    await run('scene.select', { ids: [id] });
    expect((await list()).entries).toHaveLength(2);
  });

  it('labels an opened document as such', async () => {
    await add('cube', 'A');
    const text = (await run('document.serialize')).json as string;
    await run('document.load', { json: text, name: 'Geladen' });
    expect(await labels()).toEqual(['Opened']);
  });
});

describe('history.goto', () => {
  it('jumps backward and forward several steps in one go', async () => {
    await add('cube', 'A');
    await add('cube', 'B');
    await add('cube', 'C');
    const full = doc().state;

    expect(await run('history.goto', { index: 1 })).toEqual({ index: 1, previous: 3, undone: 2, redone: 0 });
    expect(names()).toEqual(['A']);
    expect(doc().past).toHaveLength(1);
    expect(doc().future).toHaveLength(2);
    const entries = (await list()).entries;
    expect(entries.map((e: { current: boolean }) => e.current)).toEqual([false, true, false, false]);
    expect(entries.map((e: { undone: boolean }) => e.undone)).toEqual([false, false, true, true]);
    // The labels stay with their snapshots.
    expect(await labels()).toEqual(['New Document', 'Add Primitive: A', 'Add Primitive: B', 'Add Primitive: C']);

    expect(await run('history.goto', { index: 0 })).toMatchObject({ undone: 1 });
    expect(names()).toEqual([]);

    expect(await run('history.goto', { index: 3 })).toEqual({ index: 3, previous: 0, undone: 0, redone: 3 });
    expect(doc().state).toBe(full);
    expect(doc().future).toHaveLength(0);
    expect(await labels()).toEqual(['New Document', 'Add Primitive: A', 'Add Primitive: B', 'Add Primitive: C']);
  });

  it('is the same as repeated undo and redo', async () => {
    await add('cube', 'A');
    await add('cube', 'B');
    await run('history.goto', { index: 0 });
    const viaGoto = doc();
    await run('history.goto', { index: 2 });
    await run('history.undo');
    await run('history.undo');
    expect(doc().state).toBe(viaGoto.state);
    expect(doc().past).toEqual(viaGoto.past);
    expect(doc().future).toEqual(viaGoto.future);
    expect(doc().futureSteps).toEqual(viaGoto.futureSteps);
    await run('history.redo');
    expect(await labels()).toEqual(['New Document', 'Add Primitive: A', 'Add Primitive: B']);
    expect((await list()).current).toBe(1);
  });

  it('does nothing for the current entry and rejects indices out of range', async () => {
    await add();
    const before = doc();
    await run('history.goto', { index: 1 });
    expect(doc()).toBe(before);
    await expect(run('history.goto', { index: 2 })).rejects.toThrow(/out of range/);
    await expect(run('history.goto', { index: -1 })).rejects.toThrow();
    expect(doc()).toBe(before);
  });

  it('is not an undo step itself', async () => {
    await add();
    await run('history.goto', { index: 0 });
    expect(doc().past).toHaveLength(0);
    expect(doc().future).toHaveLength(1);
    expect(doc().dirty).toBe(true);
  });
});

describe('history after a new change', () => {
  it('drops the undone entries', async () => {
    await add('cube', 'A');
    await add('cube', 'B');
    await add('cube', 'C');
    await run('history.goto', { index: 1 });
    await add('cone', 'D');
    expect(await labels()).toEqual(['New Document', 'Add Primitive: A', 'Add Primitive: D']);
    expect(doc().future).toHaveLength(0);
    expect(doc().futureSteps).toHaveLength(0);
    expect(names()).toEqual(['A', 'D']);
  });

  it('keeps labels in step with the history limit', async () => {
    app = { ...app, preferences: { ...app.preferences, undoSteps: 10 } };
    for (let i = 0; i < 12; i++) await add('cube', `O${i}`);
    expect(doc().past).toHaveLength(10);
    expect(doc().pastSteps).toHaveLength(10);
    const result = await list();
    expect(result.entries).toHaveLength(11);
    // The oldest snapshot still kept is labelled with the change that made it.
    expect(result.entries[0].label).toBe('Add Primitive: O1');
    expect(result.entries[10].label).toBe('Add Primitive: O11');
    await run('history.goto', { index: 0 });
    expect(names()).toEqual(['O0', 'O1']);
  });
});

describe('history in several documents', () => {
  it('keeps each document its own entries', async () => {
    const docA = app.activeDocId;
    await add('cube', 'A1');
    const docB = (await run('document.new')).id as string;
    await add('cone', 'B1');
    await add('cone', 'B2');

    expect(await labels()).toEqual(['New Document', 'Add Primitive: B1', 'Add Primitive: B2']);
    expect((await list(docA)).entries.map((e: { label: string }) => e.label)).toEqual(['New Document', 'Add Primitive: A1']);

    // Jumping in a background document leaves the visible one alone.
    await run('history.goto', { index: 0 }, docA);
    expect(app.activeDocId).toBe(docB);
    expect(app.docs[docA].state.order).toEqual([]);
    expect(app.docs[docB].state.order).toHaveLength(2);
    expect(historyEntries(app.docs[docA]).map((e) => e.current)).toEqual([true, false]);

    // A change made in a background document lands in its own history.
    await run('scene.add_primitive', { type: 'cube', name: 'A2' }, docA);
    expect((await list(docA)).entries.map((e: { label: string }) => e.label)).toEqual(['New Document', 'Add Primitive: A2']);
    expect(await labels()).toEqual(['New Document', 'Add Primitive: B1', 'Add Primitive: B2']);
  });
});
