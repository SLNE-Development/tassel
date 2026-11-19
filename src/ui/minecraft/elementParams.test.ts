import { describe, expect, it } from 'vitest';
import { execute, selectDocState, useApp } from '../../app/store';
import { modelBox } from '../../core/minecraft/cuboid';
import type { Cuboid, SceneObject } from '../../core/types';
import { boxParams } from './elementEdits';

type Element = SceneObject & { cuboid: Cuboid };

async function newElement(): Promise<Element> {
  await execute('document.new', { format: 'minecraft_java' });
  await execute('cuboid.add', { from: [2, 0, 2], to: [6, 4, 8], origin: [4, 2, 5] });
  const state = selectDocState(useApp.getState());
  return state.objects[state.activeId!] as Element;
}

const current = (id: string): Element => selectDocState(useApp.getState()).objects[id] as Element;

describe('element panel edits', () => {
  it('moves the box together with its pivot when the position changes', async () => {
    const element = await newElement();
    const { command, params } = boxParams(element, 'position', 0, 5);
    await execute(command, params);
    const box = modelBox(current(element.id));
    expect(box.from).toEqual([5, 0, 2]);
    expect(box.to).toEqual([9, 4, 8]);
    expect(box.origin).toEqual([7, 2, 5]);
  });

  it('resizes from the minimum corner and keeps the pivot', async () => {
    const element = await newElement();
    const { command, params } = boxParams(element, 'size', 1, 10);
    await execute(command, params);
    const box = modelBox(current(element.id));
    expect(box.from).toEqual([2, 0, 2]);
    expect(box.to).toEqual([6, 10, 8]);
    expect(box.origin).toEqual([4, 2, 5]);
  });

  it('moves only the pivot, and rotates around it', async () => {
    const element = await newElement();
    let edit = boxParams(element, 'pivot', 2, 8);
    await execute(edit.command, edit.params);
    expect(modelBox(current(element.id))).toMatchObject({ from: [2, 0, 2], to: [6, 4, 8], origin: [4, 2, 8] });
    edit = boxParams(current(element.id), 'rotation', 1, 45);
    await execute(edit.command, edit.params);
    expect(current(element.id).transform.rotation).toEqual([0, 45, 0]);
  });
});
