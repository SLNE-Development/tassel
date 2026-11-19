// Per-call document targeting: execute(id, params, { documentId }).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commands } from '../core/commands';
import { documentTargeting } from '../core/commands/targeting';
import { createAppState } from '../core/state';
import type { CameraPose, ViewDocument, ViewportService } from '../core/types';
import { execute, services, useApp } from './store';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (id: string, params?: unknown, documentId?: string): Promise<any> => execute(id, params, documentId === undefined ? undefined : { documentId });

const app = () => useApp.getState();
const docOf = (id: string) => app().docs[id];

let visible: string;
let background: string;
let framed: readonly string[] | null;
/** Every viewport call: the method and the document it was handed. */
let viewCalls: { method: string; doc: ViewDocument | undefined; args: unknown }[];
/** A stand-in for the viewport's camera memory: one camera per document. */
let cameras: Record<string, CameraPose>;

beforeEach(async () => {
  useApp.setState(createAppState(), true);
  framed = null;
  viewCalls = [];
  cameras = {};
  const camera = (doc: ViewDocument | undefined): CameraPose => cameras[doc?.id ?? app().activeDocId] ?? { position: [0, 0, 5], target: [0, 0, 0] };
  services.viewport = {
    screenshot: async (opts: unknown, doc?: ViewDocument) => {
      viewCalls.push({ method: 'screenshot', doc, args: opts });
      return { base64: 'AAAA', views: [], width: 1, height: 1, backend: 'webgpu' };
    },
    getCamera: (doc?: ViewDocument) => {
      viewCalls.push({ method: 'getCamera', doc, args: null });
      return camera(doc);
    },
    setCamera: (pose: Partial<CameraPose>, doc?: ViewDocument) => {
      viewCalls.push({ method: 'setCamera', doc, args: pose });
      cameras[doc?.id ?? app().activeDocId] = { ...camera(doc), ...pose };
    },
    setView: (preset: string, doc?: ViewDocument) => {
      viewCalls.push({ method: 'setView', doc, args: preset });
    },
    frame: (ids: readonly string[], doc?: ViewDocument) => {
      viewCalls.push({ method: 'frame', doc, args: ids });
      framed = ids;
    },
  } as unknown as ViewportService;
  background = app().activeDocId;
  await run('document.rename', { name: 'Background' });
  visible = (await run('document.new', { name: 'Visible' })).id;
  await run('scene.add_primitive', { type: 'cube', name: 'Front cube' });
  await run('document.mark_saved', { id: background });
  expect(app().activeDocId).toBe(visible);
});

afterEach(() => {
  services.viewport = null;
});

describe('execute with documentId', () => {
  it('changes the targeted document and its history, not the visible one', async () => {
    const before = docOf(visible);
    const result = await run('scene.add_primitive', { type: 'cube', name: 'Back cube' }, background);

    expect(app().activeDocId).toBe(visible);
    expect(docOf(visible)).toBe(before);
    const doc = docOf(background);
    expect(doc.state.order).toEqual([result.id]);
    expect(doc.state.objects[result.id].name).toBe('Back cube');
    expect(doc.state.selection).toEqual([result.id]);
    expect(doc.past).toHaveLength(1);
    expect(doc.dirty).toBe(true);
  });

  it('reads from the targeted document, also by name', async () => {
    await run('scene.add_primitive', { type: 'cube', name: 'Back cube' }, background);
    const list = await run('scene.list_objects', {}, background);
    expect(list.objects.map((o: { name: string }) => o.name)).toEqual(['Back cube']);
    expect((await run('scene.list_objects')).objects.map((o: { name: string }) => o.name)).toEqual(['Front cube']);

    await run('scene.set_transform', { items: [{ id: 'Back cube', position: [1, 2, 3] }] }, background);
    expect(Object.values(docOf(background).state.objects)[0].transform.position).toEqual([1, 2, 3]);
    // The name exists only in the background document.
    await expect(run('scene.set_transform', { items: [{ id: 'Back cube', position: [0, 0, 0] }] })).rejects.toThrow('does not exist');
    await expect(run('scene.get_object', { id: 'Front cube' }, background)).rejects.toThrow('does not exist');
  });

  it('undoes and redoes on the targeted document', async () => {
    await run('scene.add_primitive', { type: 'cube', name: 'One' }, background);
    await run('scene.add_primitive', { type: 'cube', name: 'Two' }, background);
    const front = docOf(visible);

    expect(await run('history.undo', {}, background)).toEqual({ undone: true });
    expect(docOf(background).state.order).toHaveLength(1);
    expect(docOf(background).future).toHaveLength(1);
    expect(docOf(visible)).toBe(front);

    expect(await run('history.redo', {}, background)).toEqual({ redone: true });
    expect(docOf(background).state.order).toHaveLength(2);
    expect(app().activeDocId).toBe(visible);

    // Undo without a target still acts on the visible document.
    await run('history.undo');
    expect(docOf(visible).state.order).toHaveLength(0);
    expect(docOf(background).state.order).toHaveLength(2);
  });

  it('leaves the edit mode of the visible document alone and keeps edit mode per document', async () => {
    await run('edit.enter', { id: 'Front cube' });
    const edit = docOf(visible).state.edit;
    expect(edit).not.toBeNull();

    const { id } = await run('scene.add_primitive', { type: 'cube', name: 'Back cube' }, background);
    await run('edit.enter', { id }, background);
    await run('edit.set_element_mode', { mode: 'face' }, background);
    await run('mesh.select', { indices: [0] }, background);
    await run('mesh.extrude', { distance: 1 }, background);
    await run('edit.exit', {}, background);

    expect(docOf(background).state.objects[id].mesh.faces.length).toBeGreaterThan(6);
    expect(docOf(background).state.edit).toBeNull();
    expect(docOf(visible).state.edit).toBe(edit);
    expect(app().activeDocId).toBe(visible);
  });

  it('behaves like a plain call when the target is the visible document', async () => {
    const { id } = await run('scene.add_primitive', { type: 'cube', name: 'Second' }, visible);
    expect(docOf(visible).state.order).toContain(id);
    await run('view.frame', { ids: [id] }, visible);
    expect(framed).toEqual([id]);
    expect((await run('view.screenshot', {}, visible)).image).toBeDefined();
  });

  it('rejects an unknown documentId without running anything', async () => {
    const before = app();
    await expect(run('scene.add_primitive', { type: 'cube' }, 'nope')).rejects.toThrow(/Document "nope" does not exist.*Open documents: .*"Background".*"Visible"/);
    await expect(run('scene.add_primitive', { type: 'cube' }, 'toString')).rejects.toThrow('does not exist');
    await expect(run('scene.add_primitive', { type: 'cube' }, '__proto__')).rejects.toThrow('does not exist');
    await expect(run('app.get_state', {}, 'nope')).rejects.toThrow('does not exist');
    expect(app()).toBe(before);
  });

  it('runs view commands against a document in the background and hands the viewport that document', async () => {
    const { id: tree } = await run('scene.add_primitive', { type: 'cube', name: 'Tree' }, background);
    const { id: bush } = await run('scene.add_primitive', { type: 'cube', name: 'Bush' }, background);
    await run('scene.select', { ids: [bush] }, background);
    const before = app();
    viewCalls = [];

    const shot = await run('view.screenshot', { view: 'front', onlyIds: ['Tree'], fit: ['Bu*'] }, background);
    expect(shot.image).toEqual({ mimeType: 'image/png', base64: 'AAAA' });
    // Names are looked up in the targeted document, not in the visible one (which has no "Tree").
    expect(viewCalls[0].args).toMatchObject({ view: 'front', onlyIds: [tree], fit: [bush] });
    await expect(run('view.screenshot', { onlyIds: ['Front cube'] }, background)).rejects.toThrow('Front cube');

    expect(await run('view.set_camera', { position: [1, 2, 3] }, background)).toEqual({ position: [1, 2, 3], target: [0, 0, 0] });
    expect(await run('view.get_camera', {}, background)).toEqual({ position: [1, 2, 3], target: [0, 0, 0] });
    // The camera of the visible document is another one.
    expect(await run('view.get_camera')).toEqual({ position: [0, 0, 5], target: [0, 0, 0] });
    expect(viewCalls.at(-1)!.doc!.id).toBe(visible);

    viewCalls = [];
    expect(await run('view.set_view', { preset: 'top' }, background)).toEqual({ position: [1, 2, 3], target: [0, 0, 0] });
    await run('view.frame', { ids: ['Tree'] }, background);
    expect(framed).toEqual([tree]);
    // Default: the selection of the targeted document.
    await run('view.frame', {}, background);
    expect(framed).toEqual([bush]);
    expect(viewCalls.map((c) => c.method)).toEqual(['setView', 'getCamera', 'frame', 'getCamera', 'frame', 'getCamera']);
    for (const call of viewCalls) expect(call.doc, call.method).toEqual({ id: background, state: docOf(background).state });

    // Nothing of the app changed: not the visible tab, no document, no history.
    expect(app()).toBe(before);
  });

  it('rejects view.set_tool and view.set_shading for a document that is not visible', async () => {
    await expect(run('view.set_shading', { shading: 'wireframe' }, background)).rejects.toThrow(
      /view\.set_shading changes a setting of the whole app.*"Background".*is not the visible document.*pass "shading" to view_screenshot/,
    );
    await expect(run('view.set_tool', { tool: 'move' }, background)).rejects.toThrow(/view\.set_tool changes a setting of the whole app.*"Background".*without documentId/);
    expect(app().tool).toBe('select');
    expect(app().shading).toBe('solid');
    // For the visible document they work as without documentId.
    await run('view.set_shading', { shading: 'wireframe' }, visible);
    await run('view.set_tool', { tool: 'move' }, visible);
    expect(app()).toMatchObject({ tool: 'move', shading: 'wireframe' });
  });

  it('creates and loads documents in the background with activate: false', async () => {
    const tree = await run('document.new', { name: 'Tree', activate: false });
    expect(tree).toEqual({ id: expect.any(String), name: 'Tree', active: false, format: 'free' });
    expect(app().activeDocId).toBe(visible);
    expect(app().docOrder).toEqual([background, visible, tree.id]);
    // The new id is the documentId for everything else.
    await run('scene.add_primitive', { type: 'cube', name: 'Trunk' }, tree.id);
    expect(docOf(tree.id).state.order).toHaveLength(1);
    expect(docOf(visible).state.order).toHaveLength(1);
    expect((await run('view.screenshot', {}, tree.id)).image).toBeDefined();
    expect(viewCalls.at(-1)!.doc).toEqual({ id: tree.id, state: docOf(tree.id).state });

    const { json } = await run('document.serialize', {}, tree.id);
    const loaded = await run('document.load', { json, name: 'Tree copy', activate: false });
    expect(loaded).toMatchObject({ name: 'Tree copy', active: false });
    expect(app().activeDocId).toBe(visible);
    expect(Object.values(docOf(loaded.id).state.objects).map((o) => o.name)).toEqual(['Trunk']);
    await expect(run('document.new', { activate: 'no' })).rejects.toThrow();

    // The default still switches to the new tab.
    const front = await run('document.new', { name: 'Front' });
    expect(front.active).toBe(true);
    expect(app().activeDocId).toBe(front.id);
    expect((await run('document.load', { json })).id).toBe(app().activeDocId);
  });

  it('lets document, preferences and app commands ignore it, or take it as their id', async () => {
    expect((await run('app.get_state', {}, background)).activeDocument.id).toBe(visible);
    expect((await run('document.list', {}, background)).documents).toHaveLength(2);
    const created = await run('document.new', { name: 'Third' }, background);
    expect(app().activeDocId).toBe(created.id);
    await run('document.switch', { id: visible }, background);
    expect(app().activeDocId).toBe(visible);

    expect((await run('document.serialize', {}, background)).id).toBe(background);
    expect((await run('document.serialize', { id: visible }, background)).id).toBe(visible);
    await run('scene.add_primitive', { type: 'cube' }, background);
    expect(docOf(background).dirty).toBe(true);
    await run('document.mark_saved', { filePath: 'C:/x/back.tessel' }, background);
    expect(docOf(background)).toMatchObject({ dirty: false, filePath: 'C:/x/back.tessel' });
    expect(docOf(visible).filePath).toBeNull();
    await run('document.rename', { name: 'Renamed' }, background);
    expect(docOf(background).name).toBe('Renamed');
    expect((await run('document.close', {}, background)).closed).toBe(background);
    expect(app().docs[background]).toBeUndefined();
    expect(app().activeDocId).toBe(visible);
  });

  it('runs export and import against the targeted document', async () => {
    const exported: string[][] = [];
    services.exporter = {
      export: async (state) => {
        exported.push(state.order.map((id) => state.objects[id].name));
        return { base64: 'AAAA' };
      },
    };
    try {
      await run('scene.add_primitive', { type: 'cube', name: 'Back cube' }, background);
      await run('export.file', { format: 'glb' }, background);
      expect(exported).toEqual([['Back cube']]);
    } finally {
      services.exporter = null;
    }
  });

  it('keeps commands of two documents in order, one at a time', async () => {
    const calls = [
      run('scene.add_primitive', { type: 'cube', name: 'A' }, background),
      run('scene.add_primitive', { type: 'cube', name: 'B' }),
      run('scene.get_object', { id: 'A' }, background),
      run('scene.add_primitive', { type: 'cube', name: 'C' }, background),
      run('scene.rename_object', { id: 'B', name: 'B2' }),
      run('history.undo', {}, background),
    ];
    await Promise.all(calls);
    const names = (id: string) => docOf(id).state.order.map((o) => docOf(id).state.objects[o].name);
    expect(names(background)).toEqual(['A']);
    expect(names(visible)).toEqual(['Front cube', 'B2']);
    expect(docOf(background).past).toHaveLength(1);
    expect(docOf(visible).past).toHaveLength(3);
  });

  it('fails clearly when the document is closed while an asynchronous command runs', async () => {
    let release = () => {};
    let started = () => {};
    const baking = new Promise<void>((resolve) => {
      started = resolve;
    });
    services.baker = {
      bake: () =>
        new Promise((resolve) => {
          started();
          release = () => resolve({ data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', coverage: 1, distance: 1 });
        }),
    };
    try {
      const { id } = await run('scene.add_primitive', { type: 'plane', name: 'Low' }, background);
      await run('uv.unwrap', { objectId: id, method: 'planar' }, background);
      const bake = run('bake.ao', { targetId: 'Low', size: 16 }, background);
      await baking;
      // Close it behind the running command's back (the command queue would otherwise wait for the bake).
      useApp.setState((state) => {
        const docs = { ...state.docs };
        delete docs[background];
        return { ...state, docs, docOrder: state.docOrder.filter((d) => d !== background) };
      }, true);
      release();
      await expect(bake).rejects.toThrow(/was closed while the command was running/);
      expect(app().activeDocId).toBe(visible);
    } finally {
      services.baker = null;
    }
  });
});

describe('documentTargeting', () => {
  it('classifies every registered command', () => {
    const byKind: Record<string, string[]> = { scoped: [], 'visible-only': [], 'as-id': [], 'as-param': [], ignored: [] };
    for (const def of commands) byKind[documentTargeting(def.id)].push(def.id);
    expect(byKind['as-id'].sort()).toEqual(['document.close', 'document.mark_saved', 'document.rename', 'document.serialize']);
    // Only the settings of the whole app refuse a document in the background.
    expect(byKind['visible-only'].sort()).toEqual(['view.set_shading', 'view.set_tool']);
    expect(byKind['as-param']).toEqual(['app.get_state']);
    // An `as-param` command must really have the parameter the per-call documentId is handed to.
    for (const id of byKind['as-param']) expect(commands.find((c) => c.id === id)!.params.shape, id).toHaveProperty('documentId');
    expect(byKind.ignored.every((id) => /^(document|preferences|app)\./.test(id))).toBe(true);
    expect(byKind.scoped).toEqual(
      expect.arrayContaining([
        'scene.add_primitive',
        'history.undo',
        'history.redo',
        'export.file',
        'import.file',
        'bake.ao',
        'edit.enter',
        'view.screenshot',
        'view.get_camera',
        'view.set_camera',
        'view.set_view',
        'view.frame',
      ]),
    );
  });
});

describe('app.get_state with documentId', () => {
  it('reports that document as the working document and says which one is visible', async () => {
    const { id: tree } = await run('scene.add_primitive', { type: 'cube', name: 'Tree' }, background);
    await run('scene.add_primitive', { type: 'cube', name: 'Bush' }, background);
    await run('scene.select', { ids: [tree] }, background);
    await run('history.undo', {}, background);
    await run('history.redo', {}, background);
    await run('history.undo', {}, background);
    await run('edit.enter', { id: tree }, background);
    await run('edit.set_element_mode', { mode: 'face' }, background);
    await run('view.set_camera', { position: [4, 5, 6], target: [0, 1, 0] }, background);
    const before = app();

    for (const state of [await run('app.get_state', {}, background), await run('app.get_state', { documentId: background })]) {
      expect(state.document).toEqual({ id: background, name: 'Background', filePath: null, dirty: true, visible: false, format: 'free' });
      expect(state.visibleDocumentId).toBe(visible);
      expect(state.activeDocument.id).toBe(visible);
      expect(state).toMatchObject({
        objectCount: 1,
        selection: [tree],
        activeObjectId: tree,
        editMode: { objectId: tree, elementMode: 'face' },
        canUndo: true,
        canRedo: true,
        camera: { position: [4, 5, 6], target: [0, 1, 0] },
      });
      expect(state.documents.map((d: { id: string; active: boolean }) => [d.id, d.active])).toEqual([
        [background, false],
        [visible, true],
      ]);
    }
    expect(viewCalls.at(-1)).toMatchObject({ method: 'getCamera', doc: { id: background } });
    expect(app()).toBe(before);
  });

  it('describes the visible document without documentId, as before', async () => {
    const state = await run('app.get_state');
    expect(state.document).toEqual({ id: visible, name: 'Visible', filePath: null, dirty: true, visible: true, format: 'free' });
    expect(state).toMatchObject({ visibleDocumentId: visible, objectCount: 1, editMode: null, canUndo: true, canRedo: false });
    expect(state.activeDocument).toEqual({ id: visible, name: 'Visible', filePath: null, dirty: true });
    expect(state.camera).toEqual({ position: [0, 0, 5], target: [0, 0, 0] });
    expect(viewCalls.at(-1)!.doc!.id).toBe(visible);
  });

  it('rejects a document that is not open, also as its own parameter', async () => {
    await expect(run('app.get_state', { documentId: 'nope' })).rejects.toThrow(/Document "nope" does not exist.*Open documents/);
    await expect(run('app.get_state', { documentId: 'constructor' })).rejects.toThrow('does not exist');
    await expect(run('app.get_state', { documentId: 5 })).rejects.toThrow();
  });
});

describe('app.get_state and document.list', () => {
  it('describe every open document', async () => {
    await run('document.mark_saved', { id: background, filePath: 'C:/x/back.tessel' });
    await run('scene.add_primitive', { type: 'cube' }, background);
    await run('group.create', { ids: [], name: 'Empty group' }, background);
    const expected = [
      { id: background, name: 'Background', format: 'free', objectCount: 1, dirty: true, filePath: 'C:/x/back.tessel', active: false },
      { id: visible, name: 'Visible', format: 'free', objectCount: 1, dirty: true, filePath: null, active: true },
    ];
    const state = await run('app.get_state');
    expect(state.documents).toEqual(expected);
    expect(state.activeDocument).toEqual({ id: visible, name: 'Visible', filePath: null, dirty: true });
    expect(state.objectCount).toBe(1);
    const list = await run('document.list');
    expect(list.documents.map((d: Record<string, unknown>) => ({ id: d.id, name: d.name, format: d.format, objectCount: d.objectCount, dirty: d.dirty, filePath: d.filePath, active: d.active }))).toEqual(expected);
    for (const id of ['app.get_state', 'document.list']) {
      const description = commands.find((c) => c.id === id)!.description;
      expect(description).toContain('objectCount (the number of scene objects');
      expect(description).toContain('documentId');
    }
  });
});
