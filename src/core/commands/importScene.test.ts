import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { decompose, multiply, placeObject, placementMatrix } from '../placement';
import { transformMatrix } from '../modifiers/boolean';
import { serializeProject } from '../project';
import { activeDoc, createAppState } from '../state';
import type { AppState, DocState, Material, PolyMesh, Texture, Transform } from '../types';
import { baseName, sameMaterial, sameTexture } from './importScene';
import { commands } from './index';
import { runCommand, type AnyCommand, type CommandContext } from './registry';

const byId = new Map<string, AnyCommand>(commands.map((c) => [c.id, c]));

let app: AppState;
// No import service: project files are read by the commands themselves.
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
const names = (list: readonly { name: string }[]) => list.map((item) => item.name);

// Tiny real image files.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='; // 1x1
const PNG_2X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGM8ISfHwMAAAAXMAQZFiFnUAAAAAElFTkSuQmCC';

interface Machine {
  body: string;
  cutter: string;
  hidden: string;
  steel: string;
  paint: string;
  unused: string;
  texture: string;
  outer: string;
  inner: string;
  empty: string;
}

/** A small "machine": a body that subtracts a cutter and is mirrored, nested groups, an empty group, three materials. */
async function buildMachine(): Promise<Machine> {
  const body = (await run('scene.add_primitive', { type: 'cube', name: 'Body', position: [1, 2, 3], rotation: [0, 90, 0] })).id;
  const cutter = (await run('scene.add_primitive', { type: 'cylinder', name: 'Cutter', position: [1, 2, 3], scale: [0.5, 2, 0.5] })).id;
  const hidden = (await run('scene.add_primitive', { type: 'plane', name: 'Hidden', position: [0, -1, 0] })).id;
  await run('scene.set_visible', { ids: [hidden], visible: false });
  await run('modifier.add', { objectId: body, type: 'boolean', operation: 'difference', targetId: cutter });
  await run('modifier.add', { objectId: body, type: 'mirror' });
  const texture = (await run('texture.add', { name: 'scratches.png', mimeType: 'image/png', data: PNG, width: 1, height: 1 })).id;
  await run('texture.add', { name: 'unused.png', mimeType: 'image/png', data: PNG_2X1, width: 2, height: 1 });
  const steel = (await run('material.create', { name: 'Steel', baseColor: '#8090a0', metallic: 1, roughness: 0.35, assignTo: [body, cutter] })).id;
  await run('material.update', { id: steel, maps: { roughness: texture } });
  const paint = (await run('material.create', { name: 'Paint red', baseColor: '#cc2200' })).id;
  const unused = (await run('material.create', { name: 'Paint blue', baseColor: '#0022cc' })).id;
  const outer = (await run('group.create', { ids: [], name: 'Machine' })).id;
  const inner = (await run('group.create', { ids: [body, cutter], name: 'Head', parentId: outer })).id;
  const empty = (await run('group.create', { ids: [], name: 'Spare parts', parentId: outer })).id;
  return { body, cutter, hidden, steel, paint, unused, texture, outer, inner, empty };
}

beforeEach(() => {
  app = createAppState();
});

describe('import.file with a project file', () => {
  it('merges objects, modifiers, groups, materials and textures under fresh ids as one undo step', async () => {
    const built = await buildMachine();
    const source = state();
    const text = serializeProject(doc());

    await run('document.new', {});
    // The target already has things with the same names.
    await run('scene.add_primitive', { type: 'cube', name: 'Body' });
    await run('group.create', { ids: [], name: 'Head' });
    await run('material.create', { name: 'Steel', baseColor: '#111111' });
    const before = state();
    const pastBefore = doc().past.length;

    const result = await run('import.file', { format: 'tessel', name: 'machine.tessel', text });
    const s = state();
    expect(doc().past).toHaveLength(pastBefore + 1);

    // Everything of the project, the hidden object and the empty group included.
    expect(names(result.objects)).toEqual(['Body.001', 'Cutter', 'Hidden']);
    expect(names(result.groups)).toEqual(['Machine', 'Head.001', 'Spare parts']);
    expect(names(result.materials).sort()).toEqual(['Paint blue', 'Paint red', 'Steel.001']);
    expect(names(result.textures).sort()).toEqual(['scratches.png', 'unused.png']);
    expect(result.reused).toEqual({ materials: 0, textures: 0 });
    expect(result.warnings).toEqual([]);

    // No id of the source survives, and none collides with the target.
    const sourceIds = new Set([...source.order, ...source.groupOrder, ...Object.keys(source.materials), ...Object.keys(source.textures)]);
    const newIds = [...result.objects, ...result.groups, ...result.materials, ...result.textures].map((item: { id: string }) => item.id);
    expect(new Set(newIds).size).toBe(newIds.length);
    for (const id of newIds) {
      expect(sourceIds.has(id)).toBe(false);
      expect(before.objects[id] ?? before.groups[id] ?? before.materials[id]).toBeUndefined();
    }

    const [body, cutter, hidden] = result.objects.map((o: { id: string }) => s.objects[o.id]);
    // Modifiers are kept; the boolean points at the merged copy of its target.
    expect(body.modifiers).toEqual([
      { ...source.objects[built.body].modifiers[0], targetId: cutter.id },
      source.objects[built.body].modifiers[1],
    ]);
    expect(body.mesh).toEqual(source.objects[built.body].mesh);
    expect(body.transform).toEqual(source.objects[built.body].transform);
    expect(hidden.visible).toBe(false);
    expect(cutter.visible).toBe(true);

    // Groups, materials and textures are rewired.
    expect(s.groups[body.groupId!].name).toBe('Head.001');
    expect(s.groups[s.groups[body.groupId!].parentId!].name).toBe('Machine');
    expect(hidden.groupId).toBeNull();
    const spare = s.groups[result.groups[2].id];
    expect(spare.parentId).toBe(result.groups[0].id);
    const steel = s.materials[body.materialId!];
    expect(steel.name).toBe('Steel.001');
    expect(cutter.materialId).toBe(steel.id);
    expect(s.textures[steel.maps.roughness!].data).toBe(PNG);
    expect(s.selection).toEqual(result.objects.map((o: { id: string }) => o.id));
    expect(result.bounds.min).toHaveLength(3);

    // One undo removes everything.
    await run('history.undo', {});
    expect(state()).toBe(before);
    await run('history.redo', {});
    expect(state().order).toHaveLength(4);
  });

  it('reuses identical materials and textures on a second merge, and places each copy as a unit', async () => {
    const built = await buildMachine();
    const source = state();
    const text = serializeProject(doc());
    await run('document.new', {});
    const first = await run('import.file', { format: 'tessel', name: 'machine.tessel', text, groupName: 'Machine A' });
    const second = await run('import.file', { format: 'tessel', name: 'machine.tessel', text, groupName: 'Machine A', position: [10, 0, 5], rotation: [0, 90, 0] });
    const s = state();
    expect(second.reused).toEqual({ materials: 3, textures: 2 });
    expect(second.materials.every((m: { reused: boolean }) => m.reused)).toBe(true);
    expect(Object.keys(s.materials)).toHaveLength(3);
    expect(Object.keys(s.textures)).toHaveLength(2);
    expect(names(second.objects)).toEqual(['Body.001', 'Cutter.001', 'Hidden.001']);
    expect(names(second.groups)).toEqual(['Machine A.001', 'Machine.001', 'Head.001', 'Spare parts.001']);
    expect(s.groups[second.groupId].parentId).toBeNull();
    expect(s.groups[second.groups[1].id].parentId).toBe(second.groupId);
    expect(s.objects[second.objects[2].id].groupId).toBe(second.groupId);

    // Each copy's boolean points at its own cutter.
    const bodyA = s.objects[first.objects[0].id];
    const bodyB = s.objects[second.objects[0].id];
    expect(bodyA.modifiers[0]).toMatchObject({ type: 'boolean', targetId: first.objects[1].id });
    expect(bodyB.modifiers[0]).toMatchObject({ type: 'boolean', targetId: second.objects[1].id });
    expect(bodyA.materialId).toBe(bodyB.materialId);

    // The second copy sits where the exact matrix puts it (three's maths as the reference).
    const rad = (deg: number) => (deg * Math.PI) / 180;
    const matrixOf = (t: Transform) =>
      new Matrix4().compose(new Vector3(...t.position), new Quaternion().setFromEuler(new Euler(rad(t.rotation[0]), rad(t.rotation[1]), rad(t.rotation[2]), 'XYZ')), new Vector3(...t.scale));
    const placement = matrixOf({ position: [10, 0, 5], rotation: [0, 90, 0], scale: [1, 1, 1] });
    [built.body, built.cutter, built.hidden].forEach((id, i) => {
      const original = source.objects[id];
      const placed = s.objects[second.objects[i].id];
      const expected = placement.clone().multiply(matrixOf(original.transform));
      const actual = matrixOf(placed.transform);
      const p = original.mesh.positions;
      for (let k = 0; k < p.length; k += 3) {
        const a = new Vector3(p[k], p[k + 1], p[k + 2]).applyMatrix4(actual);
        const e = new Vector3(p[k], p[k + 1], p[k + 2]).applyMatrix4(expected);
        expect(a.distanceTo(e)).toBeLessThan(1e-6);
      }
    });
  });

  it('clears a boolean target that is not part of the file and warns when modifiers get baked', async () => {
    await run('scene.add_primitive', { type: 'cube', name: 'Body', rotation: [0, 30, 0] });
    const id = state().order[0];
    await run('modifier.add', { objectId: id, type: 'mirror' });
    const project = JSON.parse(serializeProject(doc()));
    project.objects[0].modifiers.push({ id: 'b1', enabled: true, type: 'boolean', operation: 'union', targetId: 'somewhere-else' });
    await run('document.new', {});
    const result = await run('import.file', { format: 'tessel', name: 'x.tessel', text: JSON.stringify(project), scale: [1, 2, 3] });
    const body = state().objects[result.objects[0].id];
    expect(body.modifiers.map((m) => (m.type === 'boolean' ? m.targetId : m.type))).toEqual(['mirror', null]);
    // A per-axis scale on a rotated object is a shear: baked, with a warning because of the modifiers.
    expect(body.transform).toEqual({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('"Body"');
    expect(result.warnings[0]).toContain('baked into the vertices');
  });

  it('treats the file as untrusted', async () => {
    await buildMachine();
    const good = JSON.parse(serializeProject(doc()));
    await run('document.new', {});
    const before = app;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = (change: (project: any) => void) => {
      const project = structuredClone(good);
      change(project);
      return JSON.stringify(project);
    };
    const failing: [string, string][] = [
      ['{ not json', 'not valid JSON'],
      ['[]', 'Not a valid Tessel file'],
      ['{"format":"tessel","version":2,"name":"x","objects":[]}', 'Not a valid Tessel file'],
      [text((p) => (p.objects = [])), 'contains no objects'],
      [text((p) => (p.objects[0].mesh.faces = [[0, 1, 99]])), 'face references a vertex that does not exist'],
      [text((p) => (p.objects[0].transform.position = [0, null, 0])), 'Not a valid Tessel file'],
      [text((p) => (p.textures[0].data = 'AAAA')), 'texture "scratches.png"'],
      [text((p) => (p.objects[0].modifiers[0].operation = 'explode')), 'Not a valid Tessel file'],
    ];
    for (const [file, message] of failing) await expect(run('import.file', { format: 'tessel', name: 'x.tessel', text: file }), message).rejects.toThrow(message);
    await expect(run('import.file', { format: 'tessel', name: 'x.tessel', base64: '!!!' })).rejects.toThrow('not valid base64');
    await expect(run('import.file', { format: 'tessel', name: 'x.tessel' })).rejects.toThrow('either as base64 or as text');
    expect(app).toBe(before);

    // Ids that are Object.prototype keys, duplicates and dangling references are harmless.
    const hostile = text((p) => {
      p.objects[0].id = '__proto__';
      p.objects[1].id = 'constructor';
      p.objects[2].id = 'constructor';
      p.objects[0].modifiers[0].targetId = 'constructor';
      p.objects[1].groupId = 'toString';
      p.objects[1].materialId = 'hasOwnProperty';
      p.groups[0].id = 'valueOf';
      p.groups[1].parentId = 'valueOf';
      p.groups[2].parentId = '__proto__';
      p.materials[0].id = 'toString';
      p.materials[0].maps = { roughness: 'constructor', normal: '__proto__' };
      p.textures[0].id = 'constructor';
    });
    const result = await run('import.file', { format: 'tessel', name: 'x.tessel', text: hostile });
    const s = state();
    expect(result.objects.length).toBeGreaterThanOrEqual(2);
    for (const { id } of [...result.objects, ...result.groups, ...result.materials, ...result.textures]) expect(id).toMatch(/^[0-9a-f]{8}$/);
    for (const id of s.order) {
      const object = s.objects[id];
      expect(object.groupId === null || Object.hasOwn(s.groups, object.groupId)).toBe(true);
      expect(object.materialId === null || Object.hasOwn(s.materials, object.materialId)).toBe(true);
      for (const m of object.modifiers) if (m.type === 'boolean') expect(m.targetId === null || Object.hasOwn(s.objects, m.targetId)).toBe(true);
    }
    for (const id of s.groupOrder) expect(s.groups[id].parentId === null || Object.hasOwn(s.groups, s.groups[id].parentId!)).toBe(true);
    for (const material of Object.values(s.materials)) for (const textureId of Object.values(material.maps)) expect(Object.hasOwn(s.textures, textureId!)).toBe(true);
  });
});

describe('material.import', () => {
  it('copies materials with the textures they use, filtered by exact names and globs', async () => {
    await buildMachine();
    const json = serializeProject(doc());
    await run('document.new', {});
    const pastBefore = doc().past.length;
    const result = await run('material.import', { json, names: ['Steel', 'Paint r*'] });
    expect(result.materials).toEqual([
      { id: expect.any(String), name: 'Steel', reused: false },
      { id: expect.any(String), name: 'Paint red', reused: false },
    ]);
    // Only the texture the copied materials use comes along.
    expect(result.textures).toEqual([{ id: expect.any(String), name: 'scratches.png', reused: false }]);
    expect(result.reused).toEqual({ materials: 0, textures: 0 });
    const s = state();
    expect(Object.keys(s.materials)).toHaveLength(2);
    expect(Object.keys(s.textures)).toHaveLength(1);
    const steel = s.materials[result.materials[0].id];
    expect(steel).toMatchObject({ baseColor: '#8090a0', metallic: 1, roughness: 0.35, maps: { roughness: result.textures[0].id } });
    expect(s.order).toEqual([]);
    expect(doc().past).toHaveLength(pastBefore + 1);
    await run('history.undo', {});
    expect(state().materials).toEqual({});
    expect(state().textures).toEqual({});
  });

  it('reuses equal materials, adds changed ones under a unique name, and leaves no undo step when nothing is new', async () => {
    await buildMachine();
    const json = serializeProject(doc());
    await run('document.new', {});
    const first = await run('material.import', { json });
    expect(names(first.materials).sort()).toEqual(['Paint blue', 'Paint red', 'Steel']);
    expect(Object.keys(state().textures)).toHaveLength(1);

    const pastBefore = doc().past.length;
    const stateBefore = state();
    const second = await run('material.import', { json });
    expect(second.materials).toEqual(first.materials.map((m: object) => ({ ...m, reused: true })));
    expect(second.reused).toEqual({ materials: 3, textures: 1 });
    expect(state()).toBe(stateBefore);
    expect(doc().past).toHaveLength(pastBefore);

    // One value changed in the document: that material is copied again, the others are reused.
    const steelId = first.materials.find((m: { name: string }) => m.name === 'Steel').id;
    await run('material.update', { id: steelId, roughness: 0.36 });
    const third = await run('material.import', { json, names: ['*'] });
    const steel = third.materials.find((m: { name: string }) => m.name.startsWith('Steel'));
    expect(steel).toEqual({ id: expect.any(String), name: 'Steel.001', reused: false });
    expect(third.reused).toEqual({ materials: 2, textures: 1 });
    expect(state().materials[steel.id].maps.roughness).toBe(first.textures[0].id);

    // The same texture under another id still counts as the same map content.
    const copy = (await run('texture.add', { name: 'copy', mimeType: 'image/png', data: PNG, width: 1, height: 1 })).id;
    await run('material.update', { id: steel.id, maps: { roughness: copy } });
    await run('material.delete', { id: steelId });
    const fourth = await run('material.import', { json, names: ['Steel'] });
    expect(fourth.materials).toEqual([{ id: steel.id, name: 'Steel.001', reused: true }]);
  });

  it('explains what is wrong with the input', async () => {
    await buildMachine();
    const json = serializeProject(doc());
    await run('document.new', {});
    const before = app;
    await expect(run('material.import', { json, names: ['Steal'] })).rejects.toThrow('No material named "Steal" in the project. It has: "Steel", "Paint red", "Paint blue"');
    await expect(run('material.import', { json, names: ['Steel', 'X*'] })).rejects.toThrow('No material named "X*"');
    await expect(run('material.import', { json: '{' })).rejects.toThrow('not valid JSON');
    await expect(run('material.import', { json: '{"format":"tessel"}' })).rejects.toThrow('Not a valid Tessel file');
    await expect(run('material.import', { json: '' })).rejects.toThrow();
    await expect(run('material.import', { json, names: 'Steel' })).rejects.toThrow();
    await expect(run('material.import', { json: JSON.stringify({ format: 'tessel', version: 1, name: 'x', objects: [] }) })).rejects.toThrow('contains no materials');
    // A name that is an Object.prototype key is just a name that does not exist.
    await expect(run('material.import', { json, names: ['constructor'] })).rejects.toThrow('No material named "constructor"');
    expect(app).toBe(before);
  });
});

describe('what counts as the same material or texture', () => {
  const texture: Texture = { id: 't1', name: 'a', mimeType: 'image/png', data: PNG, width: 1, height: 1 };
  const material: Material = { id: 'm1', name: 'Steel', baseColor: '#808080', metallic: 1, roughness: 0.5, emissive: '#000000', emissiveStrength: 1, normalScale: 1, maps: { baseColor: 't1' } };

  it('compares textures by type, size, bytes and paint layers', () => {
    const renamed: Texture = { ...texture, id: 't2', name: 'other name' };
    expect(sameTexture(texture, renamed)).toBe(true);
    expect(sameTexture(texture, { ...texture, data: PNG_2X1 })).toBe(false);
    expect(sameTexture(texture, { ...texture, width: 2 })).toBe(false);
    expect(sameTexture(texture, { ...texture, mimeType: 'image/webp' })).toBe(false);
    const layer = { id: 'l1', name: 'Layer', visible: true, opacity: 1, blend: 'normal' as const, data: PNG };
    expect(sameTexture(texture, { ...texture, layers: [layer] })).toBe(false);
    expect(sameTexture({ ...texture, layers: [layer] }, { ...texture, layers: [{ ...layer, id: 'l2' }] })).toBe(true);
    expect(sameTexture({ ...texture, layers: [layer] }, { ...texture, layers: [{ ...layer, opacity: 0.5 }] })).toBe(false);
  });

  it('compares materials by base name, values and map content', () => {
    const textures = { t1: texture, t2: { ...texture, id: 't2', name: 'copy' }, t3: { ...texture, id: 't3', data: PNG_2X1, width: 2 } };
    expect(baseName('Steel.001')).toBe('Steel');
    expect(baseName('Steel.01')).toBe('Steel.01');
    expect(baseName('Rib 1.250')).toBe('Rib 1');
    expect(sameMaterial(material, { ...material, id: 'm2', name: 'Steel.003' }, textures)).toBe(true);
    expect(sameMaterial(material, { ...material, name: 'Steel 2' }, textures)).toBe(false);
    expect(sameMaterial(material, { ...material, roughness: 0.5000001 }, textures)).toBe(true);
    expect(sameMaterial(material, { ...material, roughness: 0.51 }, textures)).toBe(false);
    expect(sameMaterial(material, { ...material, baseColor: '#808081' }, textures)).toBe(false);
    expect(sameMaterial(material, { ...material, maps: { baseColor: 't2' } }, textures)).toBe(true);
    expect(sameMaterial(material, { ...material, maps: { baseColor: 't3' } }, textures)).toBe(false);
    expect(sameMaterial(material, { ...material, maps: {} }, textures)).toBe(false);
    expect(sameMaterial(material, { ...material, maps: { normal: 't1' } }, textures)).toBe(false);
    expect(sameMaterial(material, { ...material, maps: { baseColor: 'toString' } }, textures)).toBe(false);
  });
});

describe('placement maths', () => {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const three = (t: Transform) =>
    new Matrix4().compose(new Vector3(...t.position), new Quaternion().setFromEuler(new Euler(rad(t.rotation[0]), rad(t.rotation[1]), rad(t.rotation[2]), 'XYZ')), new Vector3(...t.scale));
  /** Row-major 3x4 of a three matrix. */
  const rows = (m: Matrix4) => [0, 1, 2].flatMap((r) => [0, 1, 2, 3].map((c) => m.elements[c * 4 + r]));
  const transforms: Transform[] = [
    { position: [1, 2, 3], rotation: [10, 20, 30], scale: [1, 2, 0.5] },
    { position: [-4, 0, 9], rotation: [0, 90, 0], scale: [1, 1, 1] },
    { position: [0, 0, 0], rotation: [180, -90, 45], scale: [3, 3, 3] },
    { position: [0.1, -0.2, 0.3], rotation: [-170, 60, 135], scale: [0.01, 0.01, 0.02] },
  ];

  it('multiplies and decomposes like three.js', () => {
    for (const a of transforms) {
      for (const b of transforms) {
        const product = multiply(transformMatrix(a), transformMatrix(b));
        const expected = rows(three(a).multiply(three(b)));
        product.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 9));
      }
      const back = decompose(transformMatrix(a))!;
      rows(three(back)).forEach((v, i) => expect(v).toBeCloseTo(transformMatrix(a)[i], 6));
    }
    expect(decompose(transformMatrix({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [-1, 1, 1] }))).toBeNull();
    expect(decompose(transformMatrix({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [0, 1, 1] }))).toBeNull();
    expect(decompose([1, 0.5, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0])).toBeNull();
    // A shear hidden in a tiny axis is still a shear.
    expect(decompose([1000, 0, 0, 0, 0, 1000, 0.0005, 0, 0, 0, 0.001, 0])).toBeNull();
    expect(decompose([NaN, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0])).toBeNull();
    // Whole angles stay whole.
    expect(decompose(multiply(transformMatrix({ position: [10, 0, 5], rotation: [0, 90, 0], scale: [1, 1, 1] }), transformMatrix({ position: [0, 0, -4], rotation: [0, 0, 0], scale: [1, 1, 1] })))).toEqual({
      position: [6, 0, 5],
      rotation: [0, 90, 0],
      scale: [1, 1, 1],
    });
  });

  it('places an object exactly: as a transform where possible, baked otherwise', () => {
    const mesh: PolyMesh = { positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0.5, 0.5, 1], faces: [[0, 1, 2, 3], [0, 1, 4]], uvs: [[0, 0, 1, 0, 1, 1, 0, 1], [0, 0, 1, 0, 0.5, 1]] };
    expect(placementMatrix({})).toBeNull();
    expect(placementMatrix({ position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 })).toBeNull();
    const placements = [
      { position: [10, 0, 5] as const, rotation: [0, 90, 0] as const },
      { scale: 2.5, rotation: [15, 25, 35] as const },
      { scale: [1, 2, 3] as const },
      { scale: [-1, 1, 1] as const, position: [1, 1, 1] as const },
      { scale: -2 },
    ];
    for (const placement of placements) {
      const p = placement as Parameters<typeof placementMatrix>[0];
      const scale = typeof p.scale === 'number' ? [p.scale, p.scale, p.scale] : (p.scale ?? [1, 1, 1]);
      const reference = three({ position: p.position ?? [0, 0, 0], rotation: p.rotation ?? [0, 0, 0], scale: scale as never });
      for (const transform of transforms) {
        const placed = placeObject(transform, mesh, placementMatrix(p)!);
        const expected = reference.clone().multiply(three(transform));
        const actual = three(placed.transform);
        const mirrored = expected.determinant() < 0;
        expect(placed.baked || !mirrored).toBe(true);
        if (!placed.baked) expect(placed.mesh).toBe(mesh);
        else expect(placed.transform).toEqual({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
        const size = Math.max(...expected.elements.map(Math.abs));
        placed.mesh.faces.forEach((face, f) => {
          // A mirrored face keeps its first corner and runs the other way round.
          const sourceFace = mesh.faces[f];
          const corners = mirrored ? [sourceFace[0], ...sourceFace.slice(1).reverse()] : sourceFace;
          face.forEach((v, c) => {
            const a = new Vector3(...placed.mesh.positions.slice(v * 3, v * 3 + 3)).applyMatrix4(actual);
            const e = new Vector3(...mesh.positions.slice(corners[c] * 3, corners[c] * 3 + 3)).applyMatrix4(expected);
            expect(a.distanceTo(e)).toBeLessThan(1e-6 * Math.max(1, size));
          });
        });
        if (mirrored) expect(placed.mesh.uvs![0]).toEqual([0, 0, 0, 1, 1, 1, 1, 0]);
      }
    }
    // Uniform scale and rotation never need baking.
    for (const transform of transforms) expect(placeObject(transform, mesh, placementMatrix(placements[1] as never)!).baked).toBe(false);
    expect(placeObject(transforms[0], mesh, placementMatrix({ scale: [1, 2, 3] })!).baked).toBe(true);
    expect(placeObject(transforms[1], mesh, placementMatrix({ scale: [1, 2, 3] })!).baked).toBe(false);
  });
});
