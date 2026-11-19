import { describe, expect, it } from 'vitest';
import { globMatcher, isGlob, resolveGroupId, resolveMaterialId, resolveObjectId, resolveObjectIds } from './refs';
import { emptyDocState } from './state';
import type { DocState, Group, Material, SceneObject } from './types';

function object(id: string, name: string): SceneObject {
  return {
    id,
    name,
    visible: true,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    mesh: { positions: [], faces: [] } as unknown as SceneObject['mesh'],
    modifiers: [],
    smooth: false,
    groupId: null,
    materialId: null,
  };
}

function scene(objects: [id: string, name: string][], groups: [string, string][] = [], materials: [string, string][] = []): DocState {
  return {
    ...emptyDocState,
    objects: Object.fromEntries(objects.map(([id, name]) => [id, object(id, name)])),
    order: objects.map(([id]) => id),
    groups: Object.fromEntries(groups.map(([id, name]): [string, Group] => [id, { id, name, parentId: null }])),
    groupOrder: groups.map(([id]) => id),
    materials: Object.fromEntries(materials.map(([id, name]) => [id, { id, name } as Material])),
  };
}

const state = scene(
  [
    ['a1', 'Belt 1'],
    ['a2', 'Belt 2'],
    ['a3', 'Belt 10'],
    ['a4', 'Wheel'],
    ['a5', 'belt 3'],
    ['a6', 'a1'], // an object whose NAME is another object's id
    ['a7', 'Star*'],
    ['a8', 'Starship'],
    ['a9', 'Twin'],
    ['b1', 'Twin'],
  ],
  [
    ['g1', 'Chassis'],
    ['g2', 'Wheels front'],
    ['g3', 'Wheels rear'],
  ],
  [
    ['m1', 'Steel'],
    ['m2', 'Steel brushed'],
    ['m3', 'Rubber'],
  ],
);

describe('globMatcher', () => {
  it('matches * and ? against the whole text, case-sensitively', () => {
    expect(globMatcher('Belt *')('Belt 1')).toBe(true);
    expect(globMatcher('Belt *')('Belt ')).toBe(true);
    expect(globMatcher('Belt *')('belt 1')).toBe(false);
    expect(globMatcher('Belt ?')('Belt 1')).toBe(true);
    expect(globMatcher('Belt ?')('Belt 10')).toBe(false);
    expect(globMatcher('*el*')('Wheel')).toBe(true);
    expect(globMatcher('el*')('Wheel')).toBe(false);
    expect(globMatcher('*')('')).toBe(true);
    expect(globMatcher('Wheel')('Wheel')).toBe(true);
    expect(globMatcher('Wheel')('Wheels')).toBe(false);
  });

  it('takes every other character literally', () => {
    expect(globMatcher('a.b*')('a.bc')).toBe(true);
    expect(globMatcher('a.b*')('axbc')).toBe(false);
    expect(globMatcher('(x)[y]{z}+^$|\\*')('(x)[y]{z}+^$|\\!')).toBe(true);
    expect(globMatcher('Line*')('Line\nbreak')).toBe(true);
    expect(isGlob('plain.name')).toBe(false);
    expect(isGlob('a?')).toBe(true);
  });

  it('stays fast for patterns with many stars', () => {
    const start = Date.now();
    expect(globMatcher(`${'*a'.repeat(30)}*b`)('a'.repeat(200))).toBe(false);
    expect(globMatcher('*'.repeat(5000))('abc')).toBe(true);
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

describe('resolveObjectIds', () => {
  it('keeps ids, expands names and globs in outliner order, without duplicates', () => {
    expect(resolveObjectIds(state, [])).toEqual([]);
    expect(resolveObjectIds(state, ['a4', 'a2'])).toEqual(['a4', 'a2']);
    expect(resolveObjectIds(state, ['Wheel'])).toEqual(['a4']);
    expect(resolveObjectIds(state, ['Belt *'])).toEqual(['a1', 'a2', 'a3']);
    expect(resolveObjectIds(state, ['Belt ?'])).toEqual(['a1', 'a2']);
    expect(resolveObjectIds(state, ['a2', 'Belt *', 'Wheel', 'a4'])).toEqual(['a2', 'a1', 'a3', 'a4']);
    expect(resolveObjectIds(state, ['Twin'])).toEqual(['a9', 'b1']);
  });

  it('lets an id win over a name', () => {
    // "a1" is the id of "Belt 1" and the name of a6: the id wins.
    expect(resolveObjectIds(state, ['a1'])).toEqual(['a1']);
    expect(resolveObjectId(state, 'a1')).toBe('a1');
  });

  it('prefers a literal name over reading it as a glob', () => {
    expect(resolveObjectIds(state, ['Star*'])).toEqual(['a7']);
    expect(resolveObjectIds(state, ['Star?*'])).toEqual(['a7', 'a8']);
  });

  it('fails for an entry without a match', () => {
    expect(() => resolveObjectIds(state, ['a1', 'nope'])).toThrow('Object "nope" does not exist');
    expect(() => resolveObjectIds(state, ['Chain *'])).toThrow(/"Chain \*" does not exist.*pattern matches no object/);
    expect(() => resolveObjectIds(state, ['wheel'])).toThrow(/case-sensitive/);
    expect(() => resolveObjectIds(state, [''])).toThrow('does not exist');
  });

  it('never takes Object.prototype keys for ids', () => {
    for (const key of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']) {
      expect(() => resolveObjectIds(state, [key])).toThrow('does not exist');
      expect(() => resolveObjectId(state, key)).toThrow('does not exist');
      expect(() => resolveGroupId(state, key)).toThrow('does not exist');
      expect(() => resolveMaterialId(state, key)).toThrow('does not exist');
    }
  });
});

describe('resolveObjectId', () => {
  it('needs exactly one match', () => {
    expect(resolveObjectId(state, 'Wheel')).toBe('a4');
    expect(resolveObjectId(state, 'Whe*')).toBe('a4');
    expect(resolveObjectId(state, 'Belt 1?')).toBe('a3');
    expect(() => resolveObjectId(state, 'nope')).toThrow('Object "nope" does not exist');
  });

  it('lists the candidates when a pattern is ambiguous', () => {
    expect(() => resolveObjectId(state, 'Belt *')).toThrow('"Belt *" matches 3 objects, but exactly one is needed here: "Belt 1" (a1), "Belt 2" (a2), "Belt 10" (a3).');
    expect(() => resolveObjectId(state, 'Twin')).toThrow(/matches 2 objects.*\(a9\), "Twin" \(b1\)/);
  });

  it('lists at most 5 candidates', () => {
    const many = scene(Array.from({ length: 8 }, (_, i): [string, string] => [`o${i}`, `Bolt ${i}`]));
    expect(() => resolveObjectId(many, 'Bolt *')).toThrow(/matches 8 objects.*"Bolt 4" \(o4\), and 3 more\./);
    try {
      resolveObjectId(many, 'Bolt *');
    } catch (error) {
      expect((error as Error).message).not.toContain('Bolt 5');
    }
  });
});

describe('groups and materials by name', () => {
  it('resolves ids, exact names and unique globs', () => {
    expect(resolveGroupId(state, 'g2')).toBe('g2');
    expect(resolveGroupId(state, 'Chassis')).toBe('g1');
    expect(resolveGroupId(state, 'Wheels r*')).toBe('g3');
    expect(resolveMaterialId(state, 'm3')).toBe('m3');
    expect(resolveMaterialId(state, 'Steel')).toBe('m1');
    expect(resolveMaterialId(state, 'Rub*')).toBe('m3');
  });

  it('fails for no match and for several matches', () => {
    expect(() => resolveGroupId(state, 'nope')).toThrow('Group "nope" does not exist');
    expect(() => resolveGroupId(state, 'Wheels *')).toThrow(/matches 2 groups.*"Wheels front" \(g2\), "Wheels rear" \(g3\)/);
    expect(() => resolveMaterialId(state, 'nope')).toThrow('Material "nope" does not exist');
    expect(() => resolveMaterialId(state, 'Steel*')).toThrow(/matches 2 materials/);
    // Objects, groups and materials are separate name spaces.
    expect(() => resolveGroupId(state, 'Wheel')).toThrow('does not exist');
    expect(() => resolveMaterialId(state, 'a1')).toThrow('does not exist');
  });
});
