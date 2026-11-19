import { invoke, isTauri } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { execute, selectDocState, useApp } from '../../app/store';
import { isMinecraft, MINECRAFT_ONLY } from '../../core/formats';
import type { PixelRect } from '../../core/pixelOps';
import type { BlendMode, Texture } from '../../core/types';
import { getT, type Dictionary } from '../../i18n';
import { saveImage } from '../../bridge/files';
import type { Action } from '../actions';
import { notifyError, notifyInfo, notifySuccess } from '../toast';
import { pixelSession } from './pixelSession';
import { currentPixelTexture, pixelLayer, pixelTools, setPixelSize, swapColors, usePixel, type PixelTool } from './pixelStore';
import { selectAll, selectionParam, selectNone } from './pixelTools';

// What the pixel paint UI does: the actions (shortcuts, palette) and the commands behind its buttons.

/** Runs commands one after the other; a failure becomes a toast. */
export async function runPixel(steps: () => Promise<unknown>): Promise<void> {
  try {
    await steps();
  } catch (error) {
    notifyError(error);
  }
}

// ------------------------------------------------------------------ layers

export const selectPixelLayer = (textureId: string, layerId: string) => usePixel.setState((s) => ({ activeLayer: { ...s.activeLayer, [textureId]: layerId } }));

/** Adds a layer (an image without layers becomes the first one) and makes it the active one. */
export const addPixelLayer = (texture: Texture) =>
  runPixel(async () => {
    const name = `${getT().paint.layer} ${Math.max(1, texture.layers?.length ?? 0) + 1}`;
    const { layerId } = (await execute('paint.add_layer', { textureId: texture.id, name })) as { layerId: string };
    selectPixelLayer(texture.id, layerId);
  });

export const removePixelLayer = (texture: Texture, layerId: string) => runPixel(() => execute('paint.remove_layer', { textureId: texture.id, layerId }));

export const mergePixelLayerDown = (texture: Texture, layerId: string) => {
  const index = texture.layers?.findIndex((l) => l.id === layerId) ?? -1;
  if (index < 1) return Promise.resolve();
  const belowId = texture.layers![index - 1].id;
  return runPixel(async () => {
    await execute('paint.merge_down', { textureId: texture.id, layerId });
    const now = selectDocState(useApp.getState()).textures[texture.id]?.layers;
    const merged = now?.find((l) => l.id === belowId) ?? now?.[index - 1];
    if (merged) selectPixelLayer(texture.id, merged.id);
  });
};

export const flattenPixelLayers = (texture: Texture) => runPixel(() => execute('paint.flatten', { textureId: texture.id }));

export const updatePixelLayer = (textureId: string, layerId: string, change: { name?: string; visible?: boolean; opacity?: number; blend?: BlendMode }) =>
  runPixel(() => execute('paint.update_layer', { textureId, layerId, ...change }));

// ------------------------------------------------------------------ texture

/** Runs a texture-wide command on the painted texture; a texture that is not there is a note. */
function onTexture(fn: (texture: Texture) => Promise<unknown>): Promise<void> {
  const texture = currentPixelTexture();
  if (!texture) {
    notifyInfo(getT().pixel.panel.noTexture);
    return Promise.resolve();
  }
  return runPixel(() => fn(texture));
}

const layerParam = (texture: Texture) => {
  const layer = pixelLayer(texture);
  return layer ? { layerId: layer.id } : {};
};

export const transformTexture = (transform: Record<string, unknown>) => onTexture((texture) => execute('paint.transform', { textureId: texture.id, transform }));

export const clearUnusedSpace = () => onTexture((texture) => execute('paint.clear_unused', { textureId: texture.id, ...layerParam(texture) }));

/** Makes the selected pixels transparent (nothing selected: the whole layer, as the command does). */
export function clearSelectedPixels(): Promise<void> {
  return runPixel(() => pixelSession.commit('paint.clear', { selection: selectionParam() }));
}

/** The smallest rectangle around the selected pixels, or null when nothing is selected. */
export function selectionBounds(): PixelRect | null {
  const sel = usePixel.getState().selection;
  if (!sel || sel.textureId !== pixelSession.texture?.id) return null;
  let x0 = sel.width;
  let y0 = sel.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < sel.height; y++) {
    for (let x = 0; x < sel.width; x++) {
      if (!sel.mask[y * sel.width + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

export function cropToSelection(): Promise<void> {
  const rect = selectionBounds();
  if (!rect) {
    notifyInfo(getT().pixel.panel.nothingSelected, getT().pixel.panel.nothingSelectedHint);
    return Promise.resolve();
  }
  return transformTexture({ op: 'crop', rect }).then(() => selectNone());
}

// ------------------------------------------------------------------ animation

export const editFrames = (action: 'add' | 'duplicate' | 'remove' | 'move', index: number, to?: number) =>
  onTexture((texture) => execute('paint.frames', { textureId: texture.id, action, index, ...(to === undefined ? {} : { to }) }));

export const setAnimation = (texture: Texture, animation: { frametime: number; interpolate: boolean } | null) =>
  runPixel(() => execute('texture.set_animation', { id: texture.id, animation }));

// ------------------------------------------------------------------ export

interface TextureExport {
  fileName: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  base64: string;
  mcmeta?: { fileName: string; text: string };
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Saves the texture as an image and, for an animated one, its .mcmeta next to it. */
export function exportTexture(textureId: string): Promise<void> {
  return runPixel(async () => {
    const t = getT().pixel.panel;
    const out = (await execute('texture.export', { id: textureId })) as TextureExport;
    const stem = out.fileName.replace(/\.[^.\\/]+$/, '');
    if (isTauri() && out.mimeType === 'image/png') {
      // The dialog gives the path; the .mcmeta is written beside it as "<image file>.mcmeta".
      let path = await save({ defaultPath: out.fileName, filters: [{ name: 'PNG', extensions: ['png'] }] });
      if (!path) return;
      if (!path.toLowerCase().endsWith('.png')) path += '.png';
      await invoke('write_binary_file', { path, base64: out.base64 });
      if (out.mcmeta) await invoke('write_text_file', { path: `${path}.mcmeta`, contents: out.mcmeta.text });
      notifySuccess(t.exported, out.mcmeta ? t.exportedMcmeta(`${path.split(/[\\/]/).pop()}.mcmeta`) : undefined);
      return;
    }
    if (!(await saveImage({ mimeType: out.mimeType, base64: out.base64 }, stem))) return;
    if (out.mcmeta) downloadBlob(new Blob([out.mcmeta.text], { type: 'application/json' }), out.mcmeta.fileName);
    notifySuccess(t.exported, out.mcmeta ? t.exportedMcmeta(out.mcmeta.fileName) : undefined);
  });
}

// ------------------------------------------------------------------ actions

type Text = (t: Dictionary) => string;
type Define = Omit<Action, 'title' | 'group'> & { title: Text };

/** Defines an action whose title and palette group follow the UI language (read on every access). */
const define = ({ title, ...rest }: Define): Action => ({
  ...rest,
  get title() {
    return title(getT());
  },
  get group() {
    return getT().groups.paint;
  },
});

const inPixelPaint = () => {
  const app = useApp.getState();
  return app.workspace === 'paint' && isMinecraft(selectDocState(app));
};

const toolKeys: Record<PixelTool, string> = { brush: 'B', eraser: 'E', fill: 'G', shape: 'U', gradient: 'Shift+G', select: 'M', move: 'V', copy: 'C', picker: 'I' };

/**
 * The pixel paint actions (Minecraft documents, paint workspace): tools, colours, selection, brush size,
 * grid. Ids start with "pixel.", so they are not caught by the free-only "paint." family.
 */
export function pixelActionDefs(): Action[] {
  const base = { formats: MINECRAFT_ONLY, available: inPixelPaint } as const;
  return [
    ...pixelTools.map((tool) =>
      define({ ...base, id: `pixel.tool_${tool}`, title: (t) => t.pixel.panel.toolAction(t.pixel.panel.toolNames[tool]), keys: [toolKeys[tool]], run: () => usePixel.setState({ tool }) }),
    ),
    define({ ...base, id: 'pixel.swap_colors', title: (t) => t.pixel.panel.swapColors, keys: ['X'], run: swapColors }),
    define({ ...base, id: 'pixel.select_all', title: (t) => t.pixel.panel.selectAll, keys: ['Ctrl+A'], run: selectAll }),
    define({ ...base, id: 'pixel.deselect', title: (t) => t.pixel.panel.deselect, keys: ['Ctrl+D'], run: selectNone }),
    define({ ...base, id: 'pixel.clear_selection', title: (t) => t.pixel.panel.clearSelection, keys: ['Delete'], run: clearSelectedPixels }),
    // AltGr (Ctrl+Alt) types the brackets on a German keyboard.
    define({ ...base, id: 'pixel.size_down', title: (t) => t.pixel.panel.sizeDown, keys: ['[', 'Ctrl+Alt+['], run: () => setPixelSize(usePixel.getState().size - 1) }),
    define({ ...base, id: 'pixel.size_up', title: (t) => t.pixel.panel.sizeUp, keys: [']', 'Ctrl+Alt+]'], run: () => setPixelSize(usePixel.getState().size + 1) }),
    define({ ...base, id: 'pixel.toggle_grid', title: (t) => t.pixel.panel.grid, run: () => usePixel.setState((s) => ({ grid: !s.grid })) }),
    define({ ...base, id: 'pixel.toggle_tiled', title: (t) => t.pixel.panel.tiled, run: () => usePixel.setState((s) => ({ tiled: !s.tiled })) }),
  ];
}
