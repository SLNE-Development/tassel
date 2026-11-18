import { beforeEach, describe, expect, it } from 'vitest';
import { parseProject, serializeProject } from '../project';
import { activeDoc, createAppState } from '../state';
import type { AppState, DocState } from '../types';
import { documentCommands } from './document';
import { runCommand, type AnyCommand, type CommandContext } from './registry';
import { sceneCommands } from './scene';

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
async function run(id: string, params?: unknown): Promise<any> {
  const def = byId.get(id);
  if (!def) throw new Error(`Unknown command ${id}`);
  return runCommand(def, ctx, params);
}

const doc = () => activeDoc(app);
const state = (): DocState => doc().state;
const objectNames = () => state().order.map((id) => state().objects[id].name);

async function add(type = 'cube', params: Record<string, unknown> = {}): Promise<string> {
  return (await run('scene.add_primitive', { type, ...params })).id;
}

beforeEach(() => {
  app = createAppState();
});

describe('scene.add_primitive', () => {
  it('adds, selects and names the object', async () => {
    const result = await run('scene.add_primitive', { type: 'cube', position: [1, 2, 3] });
    expect(result).toEqual({ id: expect.any(String), name: 'Würfel' });
    const s = state();
    expect(s.order).toEqual([result.id]);
    expect(s.selection).toEqual([result.id]);
    expect(s.activeId).toBe(result.id);
    const obj = s.objects[result.id];
    expect(obj.visible).toBe(true);
    expect(obj.transform).toEqual({ position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] });
    expect(obj.mesh.faces).toHaveLength(6);
    expect(doc().dirty).toBe(true);
  });

  it('passes shape parameters on and makes names unique', async () => {
    const a = await add('uv_sphere', { segments: 8, rings: 4, name: 'Ball' });
    await add('uv_sphere', { name: 'Ball' });
    await add('uv_sphere', { name: 'Ball' });
    expect(objectNames()).toEqual(['Ball', 'Ball.001', 'Ball.002']);
    expect(state().objects[a].mesh.positions).toHaveLength((8 * 3 + 2) * 3);
  });

  it('can create every primitive type', async () => {
    for (const type of ['cube', 'plane', 'uv_sphere', 'ico_sphere', 'cylinder', 'cone', 'torus']) await add(type);
    expect(objectNames()).toEqual(['Würfel', 'Ebene', 'Kugel', 'Ikosphäre', 'Zylinder', 'Kegel', 'Torus']);
  });

  it('undo removes it, redo brings the same object back', async () => {
    const id = await add();
    const added = state();
    expect(doc().past).toHaveLength(1);
    expect(doc().future).toHaveLength(0);

    expect(await run('history.undo')).toEqual({ undone: true });
    expect(state().order).toEqual([]);
    expect(state().objects).toEqual({});
    expect(state().selection).toEqual([]);
    expect(doc().past).toHaveLength(0);
    expect(doc().future).toHaveLength(1);

    expect(await run('history.redo')).toEqual({ redone: true });
    expect(state()).toBe(added);
    expect(state().order).toEqual([id]);
    expect(doc().past).toHaveLength(1);
    expect(doc().future).toHaveLength(0);
  });

  it('undo and redo do nothing when there is no history', async () => {
    const before = app;
    expect(await run('history.undo')).toEqual({ undone: false });
    expect(await run('history.redo')).toEqual({ redone: false });
    expect(app).toBe(before);
  });

  it('a new change discards the redo stack', async () => {
    await add();
    await add();
    await run('history.undo');
    expect(doc().future).toHaveLength(1);
    await add('cone');
    expect(doc().future).toHaveLength(0);
    expect(objectNames()).toEqual(['Würfel', 'Kegel']);
    expect(await run('history.redo')).toEqual({ redone: false });
  });

  it('rejects invalid parameters without touching the state', async () => {
    const before = app;
    await expect(run('scene.add_primitive', { type: 'teapot' })).rejects.toThrow();
    await expect(run('scene.add_primitive', { type: 'cube', size: -1 })).rejects.toThrow();
    await expect(run('scene.add_primitive', { type: 'cube', position: [0, 0] })).rejects.toThrow();
    expect(app).toBe(before);
  });
});

describe('scene.delete_objects', () => {
  it('deletes the given objects and fixes selection and active object', async () => {
    const a = await add();
    const b = await add();
    const c = await add();
    await run('scene.select', { ids: [a, b, c] });
    expect(await run('scene.delete_objects', { ids: [c, a] })).toEqual({ deleted: [c, a] });
    expect(state().order).toEqual([b]);
    expect(Object.keys(state().objects)).toEqual([b]);
    expect(state().selection).toEqual([b]);
    expect(state().activeId).toBe(b);
  });

  it('defaults to the selection and is undoable as one step', async () => {
    const a = await add();
    const b = await add();
    await run('scene.select', { ids: [a, b] });
    const past = doc().past.length;
    await run('scene.delete_objects');
    expect(state().order).toEqual([]);
    expect(state().selection).toEqual([]);
    expect(state().activeId).toBeNull();
    expect(doc().past).toHaveLength(past + 1);
    await run('history.undo');
    expect(state().order).toEqual([a, b]);
    expect(state().selection).toEqual([a, b]);
  });

  it('fails for unknown ids or an empty selection, leaving state and history alone', async () => {
    const a = await add();
    await run('scene.select', { ids: [] });
    const before = app;
    await expect(run('scene.delete_objects')).rejects.toThrow(/nothing is selected/);
    await expect(run('scene.delete_objects', { ids: [a, 'nope'] })).rejects.toThrow(/"nope" does not exist/);
    expect(app).toBe(before);
  });
});

describe('scene.duplicate_objects', () => {
  it('copies with an offset, unique names and selects the copies', async () => {
    const a = await add('cube', { position: [1, 0, 0], scale: [2, 2, 2] });
    const b = await add('cone', { position: [0, 0, 5] });
    const result = await run('scene.duplicate_objects', { ids: [a, b], offset: [0, 2, -1] });
    const [ca, cb] = result.objects.map((o: { id: string }) => o.id);

    expect(result.objects.map((o: { name: string }) => o.name)).toEqual(['Würfel.001', 'Kegel.001']);
    expect(new Set([a, b, ca, cb]).size).toBe(4);
    expect(state().order).toEqual([a, b, ca, cb]);
    expect(state().selection).toEqual([ca, cb]);
    expect(state().activeId).toBe(cb);
    expect(state().objects[ca].transform).toEqual({ position: [1, 2, -1], rotation: [0, 0, 0], scale: [2, 2, 2] });
    expect(state().objects[cb].transform.position).toEqual([0, 2, 4]);
    expect(state().objects[ca].mesh).toEqual(state().objects[a].mesh);
    // Originals are untouched.
    expect(state().objects[a].transform.position).toEqual([1, 0, 0]);
    expect(state().objects[a].name).toBe('Würfel');
  });

  it('keeps names unique across repeated duplication, also within one call', async () => {
    const a = await add();
    await run('scene.duplicate_objects'); // selection: the original
    await run('scene.duplicate_objects'); // selection: the first copy
    expect(objectNames()).toEqual(['Würfel', 'Würfel.001', 'Würfel.002']);
    await run('scene.duplicate_objects', { ids: [a, a] });
    expect(objectNames()).toEqual(['Würfel', 'Würfel.001', 'Würfel.002', 'Würfel.003', 'Würfel.004']);
    expect(new Set(objectNames()).size).toBe(5);
  });

  it('is one undo step', async () => {
    const a = await add();
    const b = await add();
    const past = doc().past.length;
    await run('scene.duplicate_objects', { ids: [a, b], offset: [1, 0, 0] });
    expect(doc().past).toHaveLength(past + 1);
    await run('history.undo');
    expect(state().order).toEqual([a, b]);
    expect(state().selection).toEqual([b]);
  });
});

describe('scene.set_transform', () => {
  it('changes several objects in a single undo step', async () => {
    const a = await add();
    const b = await add();
    const before = state();
    const past = doc().past.length;
    await run('scene.set_transform', {
      items: [
        { id: a, position: [1, 2, 3] },
        { id: b, rotation: [0, 90, 0], scale: [2, 2, 2] },
      ],
    });
    expect(doc().past).toHaveLength(past + 1);
    expect(state().objects[a].transform).toEqual({ position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] });
    expect(state().objects[b].transform).toEqual({ position: [0, 0, 0], rotation: [0, 90, 0], scale: [2, 2, 2] });
    expect(state().selection).toEqual(before.selection);

    await run('history.undo');
    expect(state()).toBe(before);
    await run('history.redo');
    expect(state().objects[a].transform.position).toEqual([1, 2, 3]);
    expect(state().objects[b].transform.scale).toEqual([2, 2, 2]);
  });

  it('applies repeated items for the same object in order', async () => {
    const a = await add();
    await run('scene.set_transform', {
      items: [
        { id: a, position: [1, 0, 0] },
        { id: a, scale: [3, 3, 3] },
        { id: a, position: [5, 0, 0] },
      ],
    });
    expect(state().objects[a].transform).toEqual({ position: [5, 0, 0], rotation: [0, 0, 0], scale: [3, 3, 3] });
  });

  it('is all or nothing: an unknown id changes nothing', async () => {
    const a = await add();
    const before = app;
    await expect(
      run('scene.set_transform', { items: [{ id: a, position: [9, 9, 9] }, { id: 'nope', position: [1, 1, 1] }] }),
    ).rejects.toThrow(/does not exist/);
    await expect(run('scene.set_transform', { items: [] })).rejects.toThrow();
    expect(app).toBe(before);
  });
});

describe('scene.select', () => {
  let a: string;
  let b: string;
  let c: string;
  beforeEach(async () => {
    a = await add();
    b = await add();
    c = await add();
  });

  it('replace', async () => {
    expect(await run('scene.select', { ids: [a, b] })).toEqual({ selection: [a, b], activeId: b });
    expect(state().selection).toEqual([a, b]);
    expect(state().activeId).toBe(b);
    await run('scene.select', { ids: [] });
    expect(state().selection).toEqual([]);
    expect(state().activeId).toBeNull();
  });

  it('add', async () => {
    await run('scene.select', { ids: [a] });
    await run('scene.select', { ids: [b], mode: 'add' });
    expect(state().selection).toEqual([a, b]);
    expect(state().activeId).toBe(b);
    // Adding an already selected object does not duplicate it but makes it active.
    await run('scene.select', { ids: [a], mode: 'add' });
    expect(state().selection).toEqual([a, b]);
    expect(state().activeId).toBe(a);
  });

  it('remove', async () => {
    await run('scene.select', { ids: [a, b, c] });
    await run('scene.select', { ids: [a], mode: 'remove' });
    expect(state().selection).toEqual([b, c]);
    expect(state().activeId).toBe(c);
    // Removing the active object moves the active object to the last remaining one.
    await run('scene.select', { ids: [c], mode: 'remove' });
    expect(state().selection).toEqual([b]);
    expect(state().activeId).toBe(b);
    await run('scene.select', { ids: [b, a], mode: 'remove' });
    expect(state().selection).toEqual([]);
    expect(state().activeId).toBeNull();
  });

  it('toggle', async () => {
    await run('scene.select', { ids: [a, b] });
    await run('scene.select', { ids: [b, c], mode: 'toggle' });
    expect(state().selection).toEqual([a, c]);
    expect(state().activeId).toBe(c);
    await run('scene.select', { ids: [c], mode: 'toggle' });
    expect(state().selection).toEqual([a]);
    expect(state().activeId).toBe(a);
  });

  it('never creates undo steps or marks the document dirty', async () => {
    await run('document.mark_saved');
    const { past, future } = doc();
    await run('scene.select', { ids: [a, b] });
    await run('scene.select', { ids: [c], mode: 'add' });
    await run('scene.select', { ids: [a], mode: 'remove' });
    await run('scene.select', { ids: [a, b], mode: 'toggle' });
    await run('scene.select_all');
    expect(state().selection).toEqual([a, b, c]);
    expect(doc().past).toBe(past);
    expect(doc().future).toBe(future);
    expect(doc().dirty).toBe(false);
  });

  it('does not clear the redo stack', async () => {
    await run('history.undo');
    expect(doc().future).toHaveLength(1);
    await run('scene.select', { ids: [a] });
    expect(doc().future).toHaveLength(1);
    expect(await run('history.redo')).toEqual({ redone: true });
    expect(state().order).toEqual([a, b, c]);
  });

  it('rejects unknown ids', async () => {
    const before = app;
    await expect(run('scene.select', { ids: [a, 'nope'] })).rejects.toThrow(/does not exist/);
    expect(app).toBe(before);
  });
});

describe('other scene commands', () => {
  it('rename keeps names unique and may keep its own name', async () => {
    const a = await add();
    const b = await add();
    expect(await run('scene.rename_object', { id: b, name: 'Würfel' })).toEqual({ id: b, name: 'Würfel.001' });
    expect(await run('scene.rename_object', { id: a, name: 'Würfel' })).toEqual({ id: a, name: 'Würfel' });
    expect(await run('scene.rename_object', { id: b, name: 'Kiste' })).toEqual({ id: b, name: 'Kiste' });
    expect(objectNames()).toEqual(['Würfel', 'Kiste']);
  });

  it('set_visible defaults to the selection and is undoable', async () => {
    const a = await add();
    const b = await add();
    await run('scene.set_visible', { visible: false });
    expect(state().objects[a].visible).toBe(true);
    expect(state().objects[b].visible).toBe(false);
    await run('history.undo');
    expect(state().objects[b].visible).toBe(true);
  });

  it('list_objects and get_object report without changing anything', async () => {
    const a = await add('cube', { size: 4 });
    const before = app;
    const list = await run('scene.list_objects');
    expect(list.selection).toEqual([a]);
    expect(list.objects).toEqual([
      expect.objectContaining({ id: a, name: 'Würfel', vertices: 8, edges: 12, faces: 6, triangles: 12 }),
    ]);
    const one = await run('scene.get_object', { id: a, includeMesh: true });
    expect(one.boundingBox).toEqual({ min: [-2, -2, -2], max: [2, 2, 2] });
    expect(one.mesh).toBe(state().objects[a].mesh);
    expect((await run('scene.get_object', { id: a })).mesh).toBeUndefined();
    expect(app).toBe(before);
  });
});

describe('documents', () => {
  it('starts with one empty, clean document', async () => {
    expect(app.docOrder).toHaveLength(1);
    expect((await run('document.list')).documents).toEqual([
      { id: app.activeDocId, name: 'Unbenannt', filePath: null, dirty: false, active: true, objectCount: 0 },
    ]);
  });

  it('new creates a tab with a unique name and switches to it', async () => {
    const first = app.activeDocId;
    const second = await run('document.new');
    expect(second.name).toBe('Unbenannt.001');
    const third = await run('document.new', { name: 'Haus' });
    expect(app.docOrder).toEqual([first, second.id, third.id]);
    expect(app.activeDocId).toBe(third.id);
    expect(doc()).toMatchObject({ name: 'Haus', dirty: false, filePath: null, past: [], future: [] });
    expect(state().order).toEqual([]);
  });

  it('switch changes the active document and rejects unknown ids', async () => {
    const first = app.activeDocId;
    const second = (await run('document.new')).id;
    expect(await run('document.switch', { id: first })).toEqual({ id: first, name: 'Unbenannt' });
    expect(app.activeDocId).toBe(first);
    await run('document.switch', { id: second });
    expect(app.activeDocId).toBe(second);
    await expect(run('document.switch', { id: 'nope' })).rejects.toThrow(/does not exist/);
    expect(app.activeDocId).toBe(second);
  });

  it('closing the active document activates its neighbour', async () => {
    const a = app.activeDocId;
    const b = (await run('document.new')).id;
    const c = (await run('document.new')).id;

    await run('document.switch', { id: b });
    expect(await run('document.close')).toEqual({ closed: b, activeDocId: c });
    expect(app.docOrder).toEqual([a, c]);
    expect(Object.keys(app.docs).sort()).toEqual([a, c].sort());

    // Closing the last tab in the row falls back to the one before it.
    expect(await run('document.close')).toEqual({ closed: c, activeDocId: a });
    expect(app.docOrder).toEqual([a]);
  });

  it('closing a background document keeps the active one', async () => {
    const a = app.activeDocId;
    const b = (await run('document.new')).id;
    expect(await run('document.close', { id: a })).toEqual({ closed: a, activeDocId: b });
    expect(app.docOrder).toEqual([b]);
    await expect(run('document.close', { id: a })).rejects.toThrow(/does not exist/);
  });

  it('closing the last document opens a new empty one', async () => {
    const only = app.activeDocId;
    await add();
    const result = await run('document.close');
    expect(result.closed).toBe(only);
    expect(result.activeDocId).not.toBe(only);
    expect(app.docOrder).toEqual([result.activeDocId]);
    expect(Object.keys(app.docs)).toEqual([result.activeDocId]);
    expect(doc()).toMatchObject({ name: 'Unbenannt', dirty: false, past: [], future: [] });
    expect(state().order).toEqual([]);
  });

  it('rename and mark_saved update the document metadata', async () => {
    await run('document.rename', { name: 'Haus' });
    expect(doc()).toMatchObject({ name: 'Haus', dirty: true });
    await run('document.mark_saved', { filePath: 'C:/tmp/haus.tessel' });
    expect(doc()).toMatchObject({ name: 'Haus', dirty: false, filePath: 'C:/tmp/haus.tessel' });
    await add();
    expect(doc().dirty).toBe(true);
  });
});

describe('history is per document', () => {
  it('keeps separate undo stacks', async () => {
    const docA = app.activeDocId;
    const a1 = await add('cube');
    const docB = (await run('document.new')).id;
    const b1 = await add('cone');
    const b2 = await add('torus');

    expect(app.docs[docA].past).toHaveLength(1);
    expect(app.docs[docB].past).toHaveLength(2);
    const stateA = app.docs[docA].state;

    // Undo in B does not touch A.
    await run('history.undo');
    expect(app.docs[docB].state.order).toEqual([b1]);
    expect(app.docs[docB].past).toHaveLength(1);
    expect(app.docs[docB].future).toHaveLength(1);
    expect(app.docs[docA]).toMatchObject({ past: { length: 1 }, future: { length: 0 } });
    expect(app.docs[docA].state).toBe(stateA);

    // Undo in A does not touch B.
    await run('document.switch', { id: docA });
    await run('history.undo');
    expect(app.docs[docA].state.order).toEqual([]);
    expect(await run('history.undo')).toEqual({ undone: false });
    expect(app.docs[docB].state.order).toEqual([b1]);

    // Each document redoes its own change.
    await run('history.redo');
    expect(app.docs[docA].state.order).toEqual([a1]);
    await run('document.switch', { id: docB });
    await run('history.redo');
    expect(app.docs[docB].state.order).toEqual([b1, b2]);
  });

  it('opening, switching and closing documents records no history', async () => {
    const docA = app.activeDocId;
    await add();
    const docB = (await run('document.new')).id;
    await run('document.switch', { id: docA });
    await run('document.close', { id: docB });
    expect(doc().past).toHaveLength(1);
    expect(doc().future).toHaveLength(0);
  });

  it('caps the undo stack at 200 steps', async () => {
    const a = await add();
    for (let i = 0; i < 205; i++) await run('scene.set_transform', { items: [{ id: a, position: [i, 0, 0] }] });
    expect(doc().past).toHaveLength(200);
    expect(state().objects[a].transform.position).toEqual([204, 0, 0]);
  });
});

describe('project files', () => {
  async function buildScene() {
    const a = await add('cube', { position: [1, 2, 3], rotation: [0, 45, 0], scale: [1, 2, 1] });
    const b = await add('uv_sphere', { name: 'Ball', segments: 8, rings: 4 });
    const c = await add('torus', { segments: 6, minorSegments: 4 });
    await run('scene.set_visible', { ids: [b], visible: false });
    await run('document.rename', { name: 'Szene' });
    return [a, b, c];
  }

  it('serialize -> load round trips objects, order and name', async () => {
    const ids = await buildScene();
    const source = doc();
    const { json, name } = await run('document.serialize');
    expect(name).toBe('Szene');
    expect(JSON.parse(json)).toMatchObject({ format: 'tessel', version: 1, name: 'Szene' });

    const loaded = await run('document.load', { json });
    expect(loaded.name).toBe('Szene');
    expect(loaded.id).not.toBe(source.id);
    expect(app.activeDocId).toBe(loaded.id);
    expect(app.docOrder).toEqual([source.id, loaded.id]);

    expect(state().order).toEqual(ids);
    expect(state().objects).toEqual(source.state.objects);
    // Selection and history are not part of the file.
    expect(state().selection).toEqual([]);
    expect(state().activeId).toBeNull();
    expect(doc()).toMatchObject({ dirty: false, filePath: null, past: [], future: [] });
    // The source document is untouched.
    expect(app.docs[source.id]).toBe(source);

    // Serializing the loaded document gives the same file again.
    expect((await run('document.serialize')).json).toBe(json);
  });

  it('round trips every primitive exactly', async () => {
    for (const type of ['cube', 'plane', 'uv_sphere', 'ico_sphere', 'cylinder', 'cone', 'torus']) await add(type);
    const parsed = parseProject(serializeProject(doc()));
    expect(parsed.state.objects).toEqual(state().objects);
    expect(parsed.state.order).toEqual(state().order);
  });

  it('load takes name and file path overrides', async () => {
    await add();
    const { json } = await run('document.serialize');
    await run('document.load', { json, name: 'Kopie', filePath: 'C:/tmp/kopie.tessel' });
    expect(doc()).toMatchObject({ name: 'Kopie', filePath: 'C:/tmp/kopie.tessel', dirty: false });
  });

  it('serialize can address a background document', async () => {
    const first = app.activeDocId;
    await add('cone');
    await run('document.new', { name: 'Leer' });
    const result = await run('document.serialize', { id: first });
    expect(result.id).toBe(first);
    expect(JSON.parse(result.json).objects).toHaveLength(1);
    expect(JSON.parse((await run('document.serialize')).json).objects).toHaveLength(0);
  });

  it('a loaded document is editable and undoable', async () => {
    await add();
    const { json } = await run('document.serialize');
    await run('document.load', { json });
    const [id] = state().order;
    await run('scene.delete_objects', { ids: [id] });
    expect(state().order).toEqual([]);
    await run('history.undo');
    expect(state().order).toEqual([id]);
    expect(await run('history.undo')).toEqual({ undone: false });
  });

  const triangle = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], faces: [[0, 1, 2]] };
  const object = (overrides: Record<string, unknown> = {}) => ({
    id: 'a',
    name: 'Dreieck',
    visible: true,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    mesh: triangle,
    ...overrides,
  });
  const project = (objects: unknown[], overrides: Record<string, unknown> = {}) =>
    JSON.stringify({ format: 'tessel', version: 1, name: 'Test', objects, ...overrides });

  it('parseProject accepts a minimal valid file', () => {
    const parsed = parseProject(project([object()]));
    expect(parsed.name).toBe('Test');
    // Files written before modifiers and groups existed get the defaults.
    expect(parsed.state).toEqual({
      objects: { a: object({ modifiers: [], smooth: false, groupId: null }) },
      order: ['a'],
      groups: {},
      groupOrder: [],
      selection: [],
      activeId: null,
      edit: null,
    });
    expect(parseProject(project([])).state.order).toEqual([]);
  });

  it('parseProject gives duplicate ids a new id instead of dropping objects', () => {
    const parsed = parseProject(project([object(), object({ name: 'Zweites' })]));
    expect(parsed.state.order).toHaveLength(2);
    expect(parsed.state.order[0]).toBe('a');
    expect(parsed.state.order[1]).not.toBe('a');
    expect(parsed.state.order.map((id) => parsed.state.objects[id].name)).toEqual(['Dreieck', 'Zweites']);
    expect(parsed.state.order.map((id) => parsed.state.objects[id].id)).toEqual(parsed.state.order);
  });

  it('parseProject rejects text that is not JSON', () => {
    expect(() => parseProject('')).toThrow('Datei ist kein gültiges JSON');
    expect(() => parseProject('{ "format": "tessel", ')).toThrow('Datei ist kein gültiges JSON');
    expect(() => parseProject('not json')).toThrow('Datei ist kein gültiges JSON');
  });

  it('parseProject rejects JSON that is not a Tessel project', () => {
    const invalid = /^Keine gültige Tessel-Datei: /;
    expect(() => parseProject('null')).toThrow(invalid);
    expect(() => parseProject('[]')).toThrow(invalid);
    expect(() => parseProject('{}')).toThrow(invalid);
    expect(() => parseProject(project([], { format: 'blender' }))).toThrow(invalid);
    expect(() => parseProject(project([], { version: 2 }))).toThrow(invalid);
    expect(() => parseProject(project([], { name: 5 }))).toThrow(invalid);
    expect(() => parseProject(project([], { objects: {} }))).toThrow(invalid);
    expect(() => parseProject(project([object({ id: '' })]))).toThrow(invalid);
    expect(() => parseProject(project([object({ visible: 'yes' })]))).toThrow(invalid);
    expect(() => parseProject(project([object({ transform: { position: [0, 0, 0], rotation: [0, 0, 0] } })]))).toThrow(
      invalid,
    );
    expect(() =>
      parseProject(project([object({ transform: { position: [0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } })])),
    ).toThrow(invalid);
  });

  it('parseProject rejects invalid meshes', () => {
    const invalid = /^Keine gültige Tessel-Datei: /;
    const withMesh = (mesh: unknown) => project([object(), object({ id: 'b', mesh })]);
    expect(() => parseProject(withMesh({ ...triangle, faces: [[0, 1, 3]] }))).toThrow(
      'Keine gültige Tessel-Datei: face references a vertex that does not exist',
    );
    expect(() => parseProject(withMesh({ ...triangle, positions: [0, 0, 0, 1, 0, 0, 0, 1] }))).toThrow(
      'Keine gültige Tessel-Datei: positions length must be a multiple of 3',
    );
    expect(() => parseProject(withMesh({ ...triangle, faces: [[0, 1]] }))).toThrow(invalid);
    expect(() => parseProject(withMesh({ ...triangle, faces: [[0, 1, -2]] }))).toThrow(invalid);
    expect(() => parseProject(withMesh({ ...triangle, faces: [[0, 1, 1.5]] }))).toThrow(invalid);
    // JSON has no NaN/Infinity: JSON.stringify writes them as null.
    expect(() => parseProject(withMesh({ ...triangle, positions: [0, 0, 0, 1, 0, 0, 0, 1, NaN] }))).toThrow(invalid);
    expect(() => parseProject(withMesh({ positions: triangle.positions }))).toThrow(invalid);
    expect(() => parseProject(withMesh(null))).toThrow(invalid);
  });

  it('document.load with a bad file opens nothing', async () => {
    const before = app;
    await expect(run('document.load', { json: 'not json' })).rejects.toThrow('Datei ist kein gültiges JSON');
    await expect(run('document.load', { json: project([object({ mesh: { positions: [], faces: [[0, 1, 2]] } })]) })).rejects.toThrow(
      /Keine gültige Tessel-Datei/,
    );
    expect(app).toBe(before);
  });
});
