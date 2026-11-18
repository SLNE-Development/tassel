import { beforeEach, describe, expect, it } from 'vitest';
import { commands } from '../core/commands';
import { runCommand, type AnyCommand, type CommandContext } from '../core/commands/registry';
import { activeDoc, createAppState } from '../core/state';
import type { AppState, DocState } from '../core/types';
import { buildRows, dragPayload, groupSummary, parseRowKey, resolveDrop, rowKey, type DropPosition, type Payload, type TreeRow } from './outlinerTree';

const byId = new Map<string, AnyCommand>(commands.map((c) => [c.id, c]));
let app: AppState;
const ctx: CommandContext = {
  get: () => app,
  set: (update) => {
    app = update(app);
  },
  services: { viewport: null, exporter: null },
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (id: string, params?: unknown): Promise<any> => runCommand(byId.get(id)!, ctx, params);
const state = (): DocState => activeDoc(app).state;
const add = async (name: string, groupId: string | null = null): Promise<string> => (await run('scene.add_primitive', { type: 'plane', name, groupId })).id;
const group = async (name: string, parentId: string | null = null): Promise<string> => (await run('group.create', { ids: [], name, parentId })).id;

/** Rows as "name@depth". */
const names = (rows: TreeRow[]) => rows.map((r) => `${r.kind === 'group' ? state().groups[r.id].name : state().objects[r.id].name}@${r.depth}`);
const rowOf = (id: string): TreeRow => buildRows(state(), {}).find((r) => r.id === id)!;

/** Applies a drop the way the outliner does and returns the resulting rows. */
async function drop(payload: Payload, position: DropPosition) {
  const result = resolveDrop(state(), payload, position);
  if (result.valid && result.changes) {
    const { drop } = result;
    await run('group.move', { ...payload, targetGroupId: drop.targetGroupId, ...(drop.kind === 'line' ? { index: drop.index } : {}) });
  }
  return { ...result, rows: names(buildRows(state(), {})) };
}

// Wheels { Front { a, b }, c }, Body { }, d, e
let wheels: string, front: string, body: string, a: string, b: string, c: string, d: string, e: string;

beforeEach(async () => {
  app = createAppState();
  wheels = await group('Wheels');
  front = await group('Front', wheels);
  body = await group('Body');
  a = await add('a', front);
  b = await add('b', front);
  c = await add('c', wheels);
  d = await add('d');
  e = await add('e');
});

describe('buildRows', () => {
  it('lists groups before objects on every level and honours collapsed groups', () => {
    expect(names(buildRows(state(), {}))).toEqual(['Wheels@0', 'Front@1', 'a@2', 'b@2', 'c@1', 'Body@0', 'd@0', 'e@0']);
    expect(names(buildRows(state(), { [front]: true }))).toEqual(['Wheels@0', 'Front@1', 'c@1', 'Body@0', 'd@0', 'e@0']);
    expect(names(buildRows(state(), { [wheels]: true }))).toEqual(['Body@0', 'd@0', 'e@0'].flatMap((n, i) => (i === 0 ? ['Wheels@0', n] : [n])));
  });

  it('round-trips row keys', () => {
    for (const row of buildRows(state(), {})) expect(parseRowKey(rowKey(row))).toEqual(row);
  });
});

describe('groupSummary', () => {
  it('counts nested objects and reports partial selection and visibility', async () => {
    await run('scene.select', { ids: [a] });
    await run('scene.set_visible', { ids: [c], visible: false });
    expect(groupSummary(state(), wheels)).toEqual({ count: 3, selected: 'some', visible: 'some' });
    expect(groupSummary(state(), front)).toEqual({ count: 2, selected: 'some', visible: 'all' });
    expect(groupSummary(state(), body)).toEqual({ count: 0, selected: 'none', visible: 'none' });
    await run('group.select', { id: wheels });
    expect(groupSummary(state(), wheels).selected).toBe('all');
  });
});

describe('dragPayload', () => {
  it('moves an unselected row alone', async () => {
    await run('scene.select', { ids: [d] });
    expect(dragPayload(state(), { kind: 'object', id: e })).toEqual({ objectIds: [e], groupIds: [] });
    expect(dragPayload(state(), { kind: 'group', id: wheels })).toEqual({ objectIds: [], groupIds: [wheels] });
  });

  it('moves all selected objects with a selected object row, in outliner order', async () => {
    await run('scene.select', { ids: [e, a, d] });
    expect(dragPayload(state(), { kind: 'object', id: d })).toEqual({ objectIds: [a, d, e], groupIds: [] });
  });

  it('moves fully selected groups as a whole with a selected group row, plus the other selected objects', async () => {
    await run('group.select', { id: wheels });
    await run('scene.select', { ids: [e], mode: 'add' });
    // Front is fully selected too, but travels inside Wheels.
    expect(dragPayload(state(), { kind: 'group', id: front })).toEqual({ objectIds: [e], groupIds: [wheels] });
  });
});

describe('resolveDrop', () => {
  it('moves objects into a group and to top level', async () => {
    expect((await drop({ objectIds: [d, e], groupIds: [] }, { row: rowOf(body), part: 'into' })).rows).toEqual([
      'Wheels@0', 'Front@1', 'a@2', 'b@2', 'c@1', 'Body@0', 'd@1', 'e@1',
    ]);
    expect((await drop({ objectIds: [a], groupIds: [] }, null)).rows).toEqual(['Wheels@0', 'Front@1', 'b@2', 'c@1', 'Body@0', 'd@1', 'e@1', 'a@0']);
  });

  it('reorders objects between rows, counting the index without the moved ones', async () => {
    const f = await add('f');
    expect((await drop({ objectIds: [d], groupIds: [] }, { row: rowOf(f), part: 'after' })).rows.slice(-3)).toEqual(['e@0', 'f@0', 'd@0']);
    expect((await drop({ objectIds: [d, f], groupIds: [] }, { row: rowOf(e), part: 'before' })).rows.slice(-3)).toEqual(['d@0', 'f@0', 'e@0']);
    // Into another group at a position.
    expect((await drop({ objectIds: [e], groupIds: [] }, { row: rowOf(b), part: 'before' })).rows).toEqual([
      'Wheels@0', 'Front@1', 'a@2', 'e@2', 'b@2', 'c@1', 'Body@0', 'd@0', 'f@0',
    ]);
  });

  it('reorders and nests groups', async () => {
    expect((await drop({ objectIds: [], groupIds: [body] }, { row: rowOf(wheels), part: 'before' })).rows.filter((n) => n.endsWith('@0'))).toEqual([
      'Body@0', 'Wheels@0', 'd@0', 'e@0',
    ]);
    expect((await drop({ objectIds: [], groupIds: [body] }, { row: rowOf(front), part: 'after' })).rows).toEqual([
      'Wheels@0', 'Front@1', 'a@2', 'b@2', 'Body@1', 'c@1', 'd@0', 'e@0',
    ]);
  });

  it('rejects a group dropped into itself or a descendant, between rows as well', async () => {
    const before = state();
    expect((await drop({ objectIds: [], groupIds: [wheels] }, { row: rowOf(front), part: 'into' })).valid).toBe(false);
    expect((await drop({ objectIds: [], groupIds: [wheels] }, { row: rowOf(wheels), part: 'into' })).valid).toBe(false);
    expect((await drop({ objectIds: [], groupIds: [wheels] }, { row: rowOf(front), part: 'before' })).valid).toBe(false);
    expect((await drop({ objectIds: [], groupIds: [wheels] }, { row: rowOf(a), part: 'after' })).valid).toBe(false);
    expect(state()).toBe(before);
  });

  it('reports drops that change nothing', async () => {
    const before = state();
    for (const [payload, position] of [
      [{ objectIds: [d], groupIds: [] }, { row: rowOf(d), part: 'before' }],
      [{ objectIds: [d], groupIds: [] }, { row: rowOf(d), part: 'after' }],
      [{ objectIds: [d], groupIds: [] }, { row: rowOf(e), part: 'before' }],
      [{ objectIds: [d, e], groupIds: [] }, null],
      [{ objectIds: [c], groupIds: [front] }, { row: rowOf(wheels), part: 'into' }],
    ] as [Payload, DropPosition][]) {
      expect(resolveDrop(state(), payload, position).changes).toBe(false);
    }
    expect(state()).toBe(before);
  });

  it('moves a mixed drag, or one of the other kind, into the parent of the row it is dropped next to', async () => {
    const mixed = await drop({ objectIds: [d], groupIds: [body] }, { row: rowOf(a), part: 'before' });
    expect(mixed.drop).toEqual({ kind: 'into', targetGroupId: front });
    expect(mixed.rows).toEqual(['Wheels@0', 'Front@1', 'Body@2', 'a@2', 'b@2', 'd@2', 'c@1', 'e@0']);
    const other = await drop({ objectIds: [e], groupIds: [] }, { row: rowOf(front), part: 'before' });
    expect(other.drop).toEqual({ kind: 'into', targetGroupId: wheels });
  });
});
