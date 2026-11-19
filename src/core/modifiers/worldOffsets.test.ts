import { beforeEach, describe, expect, it } from 'vitest';
import { animatedState } from '../animation';
import { commandsById } from '../commands/index';
import { runCommand, type CommandContext } from '../commands/registry';
import { parseProject, serializeProject } from '../project';
import { activeDoc, createAppState } from '../state';
import { apply3, applyMat, eulerMatrix } from '../transformMath';
import type { AppState, DocState, Modifier, Transform, Vec3 } from '../types';
import { transformMatrix } from './boolean';
import { evaluateObject } from './evaluate';
import { carryWorldOffsets, localizeWorldOffsets, withTransform } from './worldOffsets';

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
  const def = commandsById.get(id);
  if (!def) throw new Error(`Unknown command ${id}`);
  return runCommand(def, ctx, params);
}

const doc = () => activeDoc(app);
const state = (): DocState => doc().state;
const obj = (id: string, s: DocState = state()) => s.objects[id];
const arrayOf = (id: string, s: DocState = state()) => obj(id, s).modifiers.find((m) => m.type === 'array') as Extract<Modifier, { type: 'array' }>;

/** Positions of the object's evaluated mesh in its local space, one Vec3 per vertex. */
function localVertices(id: string, s: DocState = state()): Vec3[] {
  const p = evaluateObject(s, id).mesh.positions;
  const out: Vec3[] = [];
  for (let i = 0; i < p.length; i += 3) out.push([p[i], p[i + 1], p[i + 2]]);
  return out;
}

const through = (transform: Transform, points: Vec3[]): Vec3[] => {
  const m = transformMatrix(transform);
  return points.map((v) => applyMat(m, v[0], v[1], v[2]));
};

/** World-space positions of the object's evaluated mesh. */
const worldVertices = (id: string, s: DocState = state()): Vec3[] => through(obj(id, s).transform, localVertices(id, s));

function expectSame(actual: Vec3[], expected: Vec3[], tolerance = 1e-6): void {
  expect(actual).toHaveLength(expected.length);
  let worst = 0;
  actual.forEach((v, i) => v.forEach((c, k) => (worst = Math.max(worst, Math.abs(c - expected[i][k])))));
  expect(worst).toBeLessThan(tolerance);
}

/** A leg (thin box) at `position` with a row of 5 along world X, one per meter. */
async function addLeg(params: Record<string, unknown> = {}, space: 'world' | 'local' = 'world'): Promise<string> {
  const id = (await run('scene.add_primitive', { type: 'cube', name: 'Leg', position: [-2, 0.5, 0.4], scale: [0.1, 0.5, 0.1], ...params })).id;
  await run('modifier.add', { objectId: id, type: 'array', count: 5, offset: [1, 0, 0], offsetSpace: space });
  return id;
}

beforeEach(() => {
  app = createAppState();
});

describe('world-space array offsets move rigidly with their object', () => {
  it('scene.transform_objects on a group turns the row of legs with the belt', async () => {
    const belt = (await run('scene.add_primitive', { type: 'cube', name: 'Belt', position: [0, 1.1, 0], scale: [2.5, 0.1, 0.5] })).id;
    const leg = await addLeg();
    const groupId = (await run('group.create', { ids: [belt, leg], name: 'Conveyor' })).id;
    const before = { belt: worldVertices(belt), leg: worldVertices(leg) };
    expect(before.leg).toHaveLength(40);
    const start = state();

    const result = await run('scene.transform_objects', { groupId, rotate: [0, 30, 0], translate: [0, 0, 2] });
    const r = eulerMatrix([0, 30, 0]);
    const pivot = result.pivot as Vec3;
    const rigid = (v: Vec3): Vec3 => {
      const p = apply3(r, [v[0] - pivot[0], v[1] - pivot[1], v[2] - pivot[2]]);
      return [p[0] + pivot[0], p[1] + pivot[1], p[2] + pivot[2] + 2];
    };
    expectSame(worldVertices(leg), before.leg.map(rigid));
    expectSame(worldVertices(belt), before.belt.map(rigid));
    // The stored offset is the old one turned by 30° about Y, still in world meters.
    const offset = arrayOf(leg).offset;
    expect(arrayOf(leg).offsetSpace).toBe('world');
    expect(offset[0]).toBeCloseTo(Math.cos(Math.PI / 6), 8);
    expect(offset[1]).toBe(0);
    expect(offset[2]).toBeCloseTo(-0.5, 8);
    expect(evaluateObject(state(), leg).errors).toEqual({});

    // One undo step, which brings the offset back.
    expect(doc().past.at(-1)).toBe(start);
    await run('history.undo');
    expect(state()).toBe(start);
    expect(arrayOf(leg).offset).toEqual([1, 0, 0]);
    expectSame(worldVertices(leg), before.leg, 1e-12);
  });

  it('scene.transform_objects with a uniform and a non-uniform scale keeps the evaluated local mesh', async () => {
    const leg = await addLeg({ rotation: [10, 40, -20] });
    const local = localVertices(leg);
    await run('scene.transform_objects', { ids: [leg], scale: 2, pivot: [1, 0, 0] });
    expectSame(localVertices(leg), local, 1e-7);
    expect(Math.hypot(...arrayOf(leg).offset)).toBeCloseTo(2, 8);
    // Non-uniform on a rotated object: the object's own scale is approximated per local axis, and the row follows the object exactly.
    await run('scene.transform_objects', { ids: [leg], scale: [1, 3, 0.5], rotate: [0, 0, 45] });
    expectSame(localVertices(leg), local, 1e-7);
    expectSame(worldVertices(leg), through(obj(leg).transform, local), 1e-8);
  });

  it('scene.set_transform: a new rotation, a non-uniform scale, both, and nothing for a move', async () => {
    const leg = await addLeg({ rotation: [0, 20, 0] });
    const before = worldVertices(leg);
    const local = localVertices(leg);
    const t0 = obj(leg).transform;

    // Only moved: the offset and even the modifier list are untouched.
    const modifiers = obj(leg).modifiers;
    await run('scene.set_transform', { items: [{ id: leg, position: [7, 0, 0] }] });
    expect(obj(leg).modifiers).toBe(modifiers);
    await run('scene.set_transform', { items: [{ id: leg, position: t0.position }] });

    // Turned about its own origin: every world vertex is the old one turned by the same delta rotation.
    await run('scene.set_transform', { items: [{ id: leg, rotation: [35, -50, 80] }] });
    const r0 = eulerMatrix(t0.rotation);
    const r1 = eulerMatrix([35, -50, 80]);
    const delta = (v: Vec3): Vec3 => {
      const d: Vec3 = [v[0] - t0.position[0], v[1] - t0.position[1], v[2] - t0.position[2]];
      // R1 * R0^T
      const inLocal: Vec3 = [0, 1, 2].map((c) => r0[c] * d[0] + r0[3 + c] * d[1] + r0[6 + c] * d[2]) as Vec3;
      const p = apply3(r1, inLocal);
      return [p[0] + t0.position[0], p[1] + t0.position[1], p[2] + t0.position[2]];
    };
    expectSame(worldVertices(leg), before.map(delta));
    expect(Math.hypot(...arrayOf(leg).offset)).toBeCloseTo(1, 8);

    // Scaled non-uniformly, then everything at once: the object is the same local shape under the new transform.
    await run('scene.set_transform', { items: [{ id: leg, scale: [0.3, 2, -0.7] }] });
    expectSame(localVertices(leg), local, 1e-7);
    await run('scene.set_transform', { items: [{ id: leg, position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] }] });
    expectSame(localVertices(leg), local, 1e-7);
    expectSame(worldVertices(leg), through({ position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] }, local), 1e-8);

    // Back to the first transform through several steps: the offset is the one that was set.
    await run('scene.set_transform', { items: [{ id: leg, ...t0 }] });
    arrayOf(leg).offset.forEach((v, i) => expect(v).toBeCloseTo([1, 0, 0][i], 8));
    expectSame(worldVertices(leg), before);
  });

  it('a scale of zero leaves the offset alone (it cannot be carried through)', async () => {
    const leg = await addLeg();
    await run('scene.set_transform', { items: [{ id: leg, scale: [0, 1, 1], rotation: [0, 90, 0] }] });
    expect(arrayOf(leg).offset).toEqual([1, 0, 0]);
    await run('scene.set_transform', { items: [{ id: leg, scale: [1, 1, 1] }] });
    expect(arrayOf(leg).offset).toEqual([1, 0, 0]);
    expect(evaluateObject(state(), leg).errors).toEqual({});
  });

  it('local-space arrays and other modifiers are unchanged bit for bit', async () => {
    const leg = await addLeg({ rotation: [0, 20, 0] }, 'local');
    await run('modifier.add', { objectId: leg, type: 'mirror' });
    const modifiers = obj(leg).modifiers;
    const mesh = evaluateObject(state(), leg);
    await run('scene.set_transform', { items: [{ id: leg, rotation: [35, -50, 80], scale: [2, 3, 4] }] });
    expect(obj(leg).modifiers).toBe(modifiers);
    await run('scene.transform_objects', { ids: [leg], rotate: [0, 30, 0], scale: 2, translate: [0, 0, 2] });
    expect(obj(leg).modifiers).toBe(modifiers);
    expect(evaluateObject(state(), leg)).toBe(mesh);
    await run('anim.set_key', { ids: [leg], frame: 0, rotation: [0, 0, 0] });
    await run('anim.set_key', { ids: [leg], frame: 10, rotation: [0, 90, 0] });
    expect(animatedState(state(), 5).objects[leg].modifiers).toBe(modifiers);
    expect(arrayOf(leg)).toMatchObject({ offset: [1, 0, 0], offsetSpace: 'local' });
  });

  it('scene.mirror_objects mirrors the row exactly', async () => {
    const leg = await addLeg({ rotation: [15, 40, -10], scale: [0.1, 0.5, 0.2] });
    await run('modifier.update', { objectId: leg, modifierId: arrayOf(leg).id, offset: [1, 0.25, -0.5] });
    for (const [axis, index] of [['x', 0], ['y', 1], ['z', 2]] as const) {
      const expected = worldVertices(leg).map((v) => v.map((c, k) => (k === index ? 2 * 0.5 - c : c)) as Vec3);
      await run('scene.mirror_objects', { ids: [leg], axis, pivot: [0.5, 0.5, 0.5], duplicate: false });
      expectSame(worldVertices(leg), expected, 1e-5);
    }
  });

  it('scene.apply_transform keeps the object where it is: the world offset stays the same world vector', async () => {
    const leg = await addLeg({ rotation: [15, 40, -10], scale: [0.1, 0.5, 0.2] });
    const before = worldVertices(leg);
    await run('scene.apply_transform', { ids: [leg] });
    expect(obj(leg).transform).toMatchObject({ rotation: [0, 0, 0], scale: [1, 1, 1] });
    expect(arrayOf(leg).offset).toEqual([1, 0, 0]);
    expectSame(worldVertices(leg), before);
    // And it keeps moving rigidly afterwards.
    await run('scene.set_transform', { items: [{ id: leg, rotation: [0, 90, 0] }] });
    arrayOf(leg).offset.forEach((v, i) => expect(v).toBeCloseTo([0, 0, -1][i], 8));
  });

  it('placing a .tessel model with rotation and scale turns its world-offset arrays with it', async () => {
    const leg = await addLeg({ rotation: [0, 20, 0] });
    const sourceWorld = worldVertices(leg);
    const text = serializeProject(doc());

    const cases: { position: Vec3; rotation: Vec3; scale: number | Vec3; baked: boolean }[] = [
      { position: [10, 0, 5], rotation: [0, 90, 0], scale: 1, baked: false },
      { position: [-3, 1, 2], rotation: [25, -40, 70], scale: 2.5, baked: false },
      // No position / rotation / scale form for the rotated leg: baked into its vertices, and the offset with it.
      { position: [1, 2, 3], rotation: [0, 30, 0], scale: [1, 2, 3], baked: true },
    ];
    for (const { baked, ...placement } of cases) {
      await run('document.new', {});
      const result = await run('import.file', { format: 'tessel', name: 'conveyor.tessel', text, ...placement });
      const placed = result.objects[0].id as string;
      const scale: Vec3 = typeof placement.scale === 'number' ? [placement.scale, placement.scale, placement.scale] : placement.scale;
      expect(obj(placed).transform.rotation.every((a) => a === 0) && obj(placed).transform.scale.every((s) => s === 1)).toBe(baked);
      expect(arrayOf(placed).offsetSpace).toBe('world');
      expectSame(worldVertices(placed), through({ position: placement.position, rotation: placement.rotation, scale }, sourceWorld));
      // One undo step.
      const steps = doc().past.length;
      await run('history.undo');
      expect(doc().past).toHaveLength(steps - 1);
      expect(state().order).toHaveLength(0);
    }

    // Without a placement nothing is touched.
    await run('document.new', {});
    const plain = (await run('import.file', { format: 'tessel', name: 'conveyor.tessel', text })).objects[0].id as string;
    expect(arrayOf(plain).offset).toEqual([1, 0, 0]);
    expectSame(worldVertices(plain), sourceWorld, 1e-12);
  });

  it('an animated rotation and scale carry the row along on every frame, without recomputing the mesh', async () => {
    const leg = await addLeg({ rotation: [0, 20, 0] });
    const rest = evaluateObject(state(), leg);
    await run('anim.set_key', { ids: [leg], frame: 0, rotation: [0, 20, 0], interpolation: 'linear' });
    await run('anim.set_key', { ids: [leg], frame: 20, rotation: [30, 150, -45], interpolation: 'linear' });
    await run('anim.set_key', { ids: [leg], frame: 0, scale: [0.1, 0.5, 0.1], interpolation: 'linear' });
    await run('anim.set_key', { ids: [leg], frame: 20, scale: [0.4, 0.5, 0.2], interpolation: 'linear' });
    await run('anim.set_key', { ids: [leg], frame: 0, position: [-2, 0.5, 0.4], interpolation: 'linear' });
    await run('anim.set_key', { ids: [leg], frame: 20, position: [3, 0.5, 0.4], interpolation: 'linear' });
    const s = state();
    expect(arrayOf(leg)).toMatchObject({ offset: [1, 0, 0], offsetSpace: 'world' });
    const local = localVertices(leg);
    let previous: unknown = null;
    for (const frame of [0, 3, 7.5, 10, 19, 20, 40]) {
      const at = animatedState(s, frame);
      // The same local mesh as at rest, bit for bit, under the animated transform: a rigid motion of the whole object.
      expect(evaluateObject(at, leg).mesh.positions).toEqual(rest.mesh.positions);
      expect(evaluateObject(at, leg).errors).toEqual({});
      expectSame(worldVertices(leg, at), through(at.objects[leg].transform, local), 1e-12);
      if (frame > 0) {
        expect(at.objects[leg].transform.rotation).not.toEqual([0, 20, 0]);
        // Same cached result on every moving frame.
        if (previous) expect(evaluateObject(at, leg)).toBe(previous);
        previous = evaluateObject(at, leg);
      }
    }
    // The document itself is untouched by looking at frames.
    expect(state()).toBe(s);
    expect(evaluateObject(s, leg)).toBe(rest);

    // A static change under the animation: the static offset follows, the animated frames look as before.
    const shown = worldVertices(leg, animatedState(s, 10));
    await run('scene.set_transform', { items: [{ id: leg, rotation: [0, 110, 0] }] });
    arrayOf(leg).offset.forEach((v, i) => expect(v).toBeCloseTo([0, 0, -1][i], 8));
    expectSame(worldVertices(leg, animatedState(state(), 10)), shown, 1e-8);
  });

  it('an animation of the position alone leaves the modifiers as they are', async () => {
    const leg = await addLeg();
    await run('anim.set_key', { ids: [leg], frame: 0, position: [0, 0, 0] });
    await run('anim.set_key', { ids: [leg], frame: 10, position: [5, 0, 0] });
    const at = animatedState(state(), 5);
    expect(at.objects[leg]).not.toBe(obj(leg));
    expect(at.objects[leg].modifiers).toBe(obj(leg).modifiers);
    expect(evaluateObject(at, leg)).toBe(evaluateObject(state(), leg));
  });

  it('anim.set_pose with autoKey writes channels without keys to the static transform and carries the offset', async () => {
    const leg = await addLeg();
    await run('anim.set_key', { ids: [leg], frame: 0, position: [0, 0, 0] });
    const local = localVertices(leg);
    const steps = doc().past.length;
    const result = await run('anim.set_pose', { frame: 0, items: [{ id: leg, position: [1, 0, 0], rotation: [0, 90, 0] }], autoKey: true });
    expect(result.moved).toEqual([{ id: leg, channels: ['rotation'] }]);
    expect(doc().past).toHaveLength(steps + 1);
    expect(obj(leg).transform.rotation).toEqual([0, 90, 0]);
    arrayOf(leg).offset.forEach((v, i) => expect(v).toBeCloseTo([0, 0, -1][i], 8));
    expectSame(localVertices(leg), local, 1e-7);
  });

  it('survives a project round trip after being carried', async () => {
    const leg = await addLeg();
    await run('scene.transform_objects', { ids: [leg], rotate: [10, 30, 50], scale: 1.5 });
    const loaded = parseProject(serializeProject(doc())).state;
    expect(loaded.objects[leg].modifiers).toEqual(obj(leg).modifiers);
    expect(evaluateObject(loaded, leg).mesh).toEqual(evaluateObject(state(), leg).mesh);
  });
});

describe('worldOffsets helpers', () => {
  const world: Modifier = { id: 'w', enabled: true, type: 'array', count: 3, offset: [1, 2, 3], rotation: [0, 0, 0], pivot: [0, 0, 0], offsetSpace: 'world' };
  const local: Modifier = { ...world, id: 'l', offsetSpace: 'local' };
  const a: Transform = { position: [1, 2, 3], rotation: [10, 20, 30], scale: [1, 2, 3] };
  const b: Transform = { position: [4, 5, 6], rotation: [-40, 5, 100], scale: [2, 0.5, -1] };

  it('carryWorldOffsets returns the same list when there is nothing to do, and is undone by the way back', () => {
    expect(carryWorldOffsets([local], a, b)).toEqual([local]);
    const list = [world, local];
    expect(carryWorldOffsets(list, a, { ...a, position: [9, 9, 9] })).toBe(list);
    expect(carryWorldOffsets([local], a, b)[0]).toBe(local);
    const there = carryWorldOffsets(list, a, b);
    expect(there[1]).toBe(local);
    expect(there[0]).not.toEqual(world);
    const back = carryWorldOffsets(there, b, a)[0] as typeof world & { offset: Vec3 };
    back.offset.forEach((v, i) => expect(v).toBeCloseTo([1, 2, 3][i], 7));
    // A disabled array belongs to the object just the same.
    const disabled = { ...world, enabled: false };
    expect(carryWorldOffsets([disabled], a, b)).toEqual([{ ...disabled, offset: (there[0] as typeof world & { offset: Vec3 }).offset }]);
  });

  it('withTransform keeps the object when the transform is the same', () => {
    const o = { id: 'o', name: 'o', visible: true, transform: a, mesh: { positions: [], faces: [] }, modifiers: [world], smooth: false, groupId: null, materialId: null };
    expect(withTransform(o, a)).toBe(o);
    expect(withTransform(o, b).modifiers).toEqual(carryWorldOffsets([world], a, b));
  });

  it('localizeWorldOffsets is cached per modifier list and transform', () => {
    const list = [world, local];
    const first = localizeWorldOffsets(list, a);
    expect(first[0]).toMatchObject({ offsetSpace: 'local' });
    expect(first[1]).toBe(local);
    expect(localizeWorldOffsets(list, { ...a, position: [0, 0, 0] })).toBe(first);
    expect(localizeWorldOffsets(list, b)).not.toBe(first);
    expect(localizeWorldOffsets([local], a)).toHaveLength(1);
    const zero = [world];
    expect(localizeWorldOffsets(zero, { ...a, scale: [0, 1, 1] })).toBe(zero);
  });
});
