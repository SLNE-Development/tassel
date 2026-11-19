import { execute, selectDocState, useApp } from '../../app/store';
import { MINECRAFT_ONLY } from '../../core/formats';
import { getT, type Dictionary } from '../../i18n';
import type { Action } from '../actions';
import { notifyInfo, notifySuccess } from '../toast';

type Text = (t: Dictionary) => string;
type Define = (action: Omit<Action, 'title' | 'group'> & { title: Text; group: 'minecraft' | 'add' }) => Action;

type Axis = 'x' | 'y' | 'z';
const axes: readonly Axis[] = ['x', 'y', 'z'];

/** Runs `fn` on the selected elements, or tells the user that nothing is selected. */
const onElements = (fn: () => unknown) => () => (selectDocState(useApp.getState()).selection.length > 0 ? fn() : notifyInfo(getT().toasts.nothingSelected));

/** Operations on the face UVs of all selected elements, by action id suffix (the UV editor has its own buttons for one face). */
export const uvOps = ['auto', 'maximize', 'mirror_x', 'mirror_y', 'rotate', 'clear_rotation'] as const;

async function validate() {
  const t = getT().mc;
  const result = (await execute('minecraft.validate')) as { issues: unknown[] };
  if (result.issues.length === 0) notifySuccess(t.validOk);
  else notifyInfo(t.validIssues(result.issues.length));
}

/** The Minecraft Java actions: adding and shaping cuboid elements, UV operations, model checks. */
export const minecraftActions = (action: Define): Action[] => {
  const mc = (id: string, title: Text, command: string, run: () => unknown) =>
    action({ id: `mc.${id}`, title, group: 'minecraft', command, formats: MINECRAFT_ONLY, run });
  return [
    action({
      id: 'add.cuboid',
      title: (t) => t.mc.addCube,
      group: 'add',
      command: 'cuboid.add',
      formats: MINECRAFT_ONLY,
      // The new element is named in the UI language; the command's own default name is English.
      run: () => execute('cuboid.add', { name: getT().mc.cubeName }),
    }),
    ...axes.map((axis) => mc(`flip_${axis}`, (t) => t.mc.flip(axis.toUpperCase()), 'cuboid.flip', onElements(() => execute('cuboid.flip', { axis })))),
    ...axes.flatMap((axis) =>
      ([1, -1] as const).map((direction) =>
        mc(
          `rotate_${axis}_${direction > 0 ? 'plus' : 'minus'}`,
          (t) => t.mc.rotate90(axis.toUpperCase(), direction),
          'cuboid.rotate90',
          onElements(() => execute('cuboid.rotate90', { axis, direction })),
        ),
      ),
    ),
    mc('center_pivot', (t) => t.mc.centerPivot, 'cuboid.set_pivot', onElements(() => execute('cuboid.set_pivot', { center: true }))),
    mc('center_block', (t) => t.mc.centerOnBlock, 'cuboid.center', onElements(() => execute('cuboid.center', {}))),
    mc('auto_cullface', (t) => t.mc.autoCullface, 'cuboid.auto_cullface', onElements(() => execute('cuboid.auto_cullface', {}))),
    mc('remove_blank_faces', (t) => t.mc.removeBlankFaces, 'cuboid.remove_blank_faces', onElements(() => execute('cuboid.remove_blank_faces', {}))),
    ...uvOps.map((op) => mc(`uv_${op}`, (t) => t.mc.uvOps[op], 'cuboid.uv', onElements(() => execute('cuboid.uv', { op })))),
    mc('validate', (t) => t.mc.validate, 'minecraft.validate', validate),
  ];
};
