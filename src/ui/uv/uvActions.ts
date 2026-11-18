import { execute, selectDocState, useApp } from '../../app/store';
import { unwrapMethods, type UnwrapMethod } from '../../core/mesh/uv';
import { getT, type Dictionary } from '../../i18n';
import type { Action } from '../actions';
import { runOp } from '../live';
import { notifyInfo } from '../toast';
import { pointer, useUvUi, uvObject } from './uvStore';

type Text = (t: Dictionary) => string;
type Define = (action: Omit<Action, 'title' | 'group'> & { title: Text; group: 'uv' }) => Action;

/** Runs `fn` if there is an object to work on (with UVs, if `needsUvs`); otherwise says what is missing. */
function onObject(needsUvs: boolean, fn: () => unknown) {
  return () => {
    const object = uvObject(selectDocState(useApp.getState()));
    const t = getT();
    if (!object) return notifyInfo(t.uv.noObject, t.uv.noObjectHint);
    if (needsUvs && !object.mesh.uvs) return notifyInfo(t.uv.noUvs(object.name), t.uv.noUvsHint);
    return fn();
  };
}

/** Unwraps with the method's defaults; angle, margin and axis follow in the "Letzte Aktion" panel. */
export const unwrapWith = (method: UnwrapMethod) => onObject(false, () => runOp('uv.unwrap', { method }, (t) => t.uv.unwrap))();

/** The UV actions: toolbar of the UV editor, UV menu, command palette and shortcuts. */
export const uvActions = (action: Define): Action[] => [
  action({
    id: 'uv.unwrap_menu',
    title: (t) => t.uv.unwrap,
    group: 'uv',
    keys: ['U'],
    hidden: true,
    // The shortcut belongs to the UV workspace and to edit mode; elsewhere U stays free.
    run: () => {
      const app = useApp.getState();
      if (app.workspace === 'uv' || selectDocState(app).edit) useUvUi.setState({ unwrapMenuAt: { ...pointer } });
    },
  }),
  ...unwrapMethods.map((method) =>
    action({
      id: `uv.unwrap_${method}`,
      title: (t) => t.uv.unwrapWith(t.uv.methods[method]),
      group: 'uv',
      command: method === 'smart' ? 'uv.unwrap' : undefined,
      run: () => unwrapWith(method),
    }),
  ),
  action({ id: 'uv.pack', title: (t) => t.uv.pack, group: 'uv', command: 'uv.pack', run: onObject(true, () => runOp('uv.pack')) }),
  action({ id: 'uv.rotate_left', title: (t) => t.uv.rotateLeft, group: 'uv', command: 'uv.transform', run: onObject(true, () => runOp('uv.transform', { rotate: 90 }, (t) => t.uv.rotate)) }),
  action({ id: 'uv.rotate_right', title: (t) => t.uv.rotateRight, group: 'uv', run: onObject(true, () => runOp('uv.transform', { rotate: -90 }, (t) => t.uv.rotate)) }),
  action({ id: 'uv.flip_horizontal', title: (t) => t.uv.flipHorizontal, group: 'uv', run: onObject(true, () => execute('uv.transform', { scale: [-1, 1] })) }),
  action({ id: 'uv.flip_vertical', title: (t) => t.uv.flipVertical, group: 'uv', run: onObject(true, () => execute('uv.transform', { scale: [1, -1] })) }),
  action({ id: 'uv.clear', title: (t) => t.uv.clear, group: 'uv', command: 'uv.clear', run: onObject(true, () => useUvUi.setState({ clearConfirmOpen: true })) }),
  action({
    id: 'uv.fit',
    title: (t) => t.uv.fit,
    group: 'uv',
    keys: ['Home'],
    hidden: true,
    run: () => useUvUi.setState((s) => ({ fitRequests: s.fitRequests + 1 })),
  }),
];
