import { useSyncExternalStore } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { execute, useApp } from '../../app/store';
import { anglePresets, type AnglePreset } from '../../core/preview';
import type { Dictionary } from '../../i18n';
import { getT } from '../../i18n';
import { minecraftAssetsStatus, onMinecraftAssetsChange } from '../../mcassets';
import type { Action } from '../actions';
import { notifyError } from '../toast';

type Text = (t: Dictionary) => string;
type Define = (action: Omit<Action, 'title' | 'group'> & { title: Text; group: 'view' }) => Action;

/** The status of the Minecraft assets, re-rendering when it changes. */
export function useMinecraftAssetsStatus() {
  return useSyncExternalStore(onMinecraftAssetsChange, minecraftAssetsStatus);
}

export const setAngle = (preset: AnglePreset) => execute('view.set_angle', { preset }).catch(notifyError);

export function toggleProjection() {
  const projection = useApp.getState().preferences.viewportProjection === 'orthographic' ? 'perspective' : 'orthographic';
  return execute('view.set_projection', { projection }).catch(notifyError);
}

/** Asks for a skin PNG and uses it for the reference player. */
export async function chooseSkin(): Promise<void> {
  if (!isTauri()) return notifyError(new Error(getT().preview.assets.unavailable));
  const path = await open({ multiple: false, directory: false, filters: [{ name: getT().preview.skinFilter, extensions: ['png'] }] });
  if (path) await execute('view.set_preview', { skin: path, player: true }).catch(notifyError);
}

/** Asks for a Minecraft client .jar or a resource pack folder and makes it the assets source. */
export async function chooseAssets(kind: 'jar' | 'folder'): Promise<void> {
  if (!isTauri()) return notifyError(new Error(getT().preview.assets.unavailable));
  const path =
    kind === 'jar'
      ? await open({ multiple: false, directory: false, filters: [{ name: getT().preview.assets.jarFilter, extensions: ['jar', 'zip'] }] })
      : await open({ multiple: false, directory: true });
  if (path) await execute('assets.set_minecraft', { path }).catch(notifyError);
}

/** Menu, palette and shortcut actions: projection and the camera angle presets. */
export function previewActions(action: Define): Action[] {
  return [
    action({
      id: 'preview.toggle_projection',
      title: (t) => t.preview.toggleProjection,
      group: 'view',
      keys: ['Numpad5'],
      command: 'view.set_projection',
      run: toggleProjection,
    }),
    ...anglePresets.map((preset) =>
      action({
        id: `preview.angle_${preset}`,
        title: (t) => t.preview.angle(t.preview.angles[preset]),
        group: 'view',
        run: () => setAngle(preset),
      }),
    ),
  ];
}
