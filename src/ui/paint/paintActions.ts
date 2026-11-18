import { execute, selectDocState, useApp } from '../../app/store';
import type { BlendMode, PaintLayer, Texture } from '../../core/types';
import { getT, type Dictionary } from '../../i18n';
import type { Action } from '../actions';
import { notifyError, notifyInfo, notifySuccess } from '../toast';
import { activeLayerOf, brushColor, currentTarget, greyHex, paintTools, stepBrushSize, usePaint, type PaintSlot, type PaintTarget } from './paintStore';

type Text = (t: Dictionary) => string;
type Define = (action: Omit<Action, 'title' | 'group'> & { title: Text; group: 'paint' }) => Action;

const inPaint = () => useApp.getState().workspace === 'paint';

/** Runs commands one after the other; a failure becomes a toast. */
async function run(steps: () => Promise<unknown>): Promise<void> {
  try {
    await steps();
  } catch (error) {
    notifyError(error);
  }
}

export const selectLayer = (textureId: string, layerId: string) => usePaint.setState((s) => ({ activeLayer: { ...s.activeLayer, [textureId]: layerId } }));

/** The paint target's texture and active layer, or a note about what is missing. */
function onTexture(fn: (texture: Texture, layer: PaintLayer | undefined, target: PaintTarget) => unknown) {
  return () => {
    const target = currentTarget();
    const t = getT().paint;
    if (target.problem || !target.texture) return notifyInfo(t.notReady, t.notReadyHint);
    return fn(target.texture, target.layer, target);
  };
}

export const createMaterial = () =>
  run(async () => {
    const { object } = currentTarget();
    if (object) await execute('material.create', { name: getT().materials.title, assignTo: [object.id] });
  });

export const unwrapTarget = () =>
  run(async () => {
    const { object } = currentTarget();
    if (object) await execute('uv.unwrap', { objectId: object.id, method: 'smart' });
  });

/**
 * A new paint texture for the current slot. It starts with what the material shows there; the material's
 * own value then steps aside (it is multiplied with the map), so the look stays the same until paint lands.
 */
export const createTexture = () =>
  run(async () => {
    const { material, slot } = currentTarget();
    if (!material) return;
    const t = getT().paint;
    const size = usePaint.getState().textureSize;
    const start: Record<PaintSlot, { color: string; neutral?: Record<string, unknown> }> = {
      baseColor: { color: material.baseColor, neutral: { baseColor: '#ffffff' } },
      roughness: { color: greyHex(material.roughness), neutral: { roughness: 1 } },
      metallic: { color: greyHex(material.metallic), neutral: { metallic: 1 } },
      // Nothing glows until it is painted; the emission colour must be on for the map to show at all.
      emissive: { color: '#000000', neutral: { emissive: '#ffffff' } },
      occlusion: { color: '#ffffff' },
      height: { color: '#808080' },
    };
    const { color, neutral } = start[slot];
    const bind = slot === 'height' ? {} : { materialId: material.id, slot };
    const { id, layerId } = (await execute('paint.create_texture', { name: t.textureName(material.name, t.slots[slot]), width: size, height: size, color, ...bind })) as { id: string; layerId: string };
    usePaint.setState((s) => ({
      activeLayer: { ...s.activeLayer, [id]: layerId },
      heightTexture: slot === 'height' ? { ...s.heightTexture, [material.id]: id } : s.heightTexture,
    }));
    const changed = neutral && Object.entries(neutral).some(([key, value]) => (material as unknown as Record<string, unknown>)[key] !== value);
    if (changed) await execute('material.update', { id: material.id, ...neutral });
  });

export const normalFromHeight = (strength: number) =>
  onTexture((texture, _layer, target) =>
    run(async () => {
      if (target.slot !== 'height' || !target.material) return;
      await execute('texture.normal_from_height', { sourceId: texture.id, strength, materialId: target.material.id });
      notifySuccess(getT().paint.normalCreated, getT().paint.normalCreatedHint);
    }),
  )();

export const fillLayer = onTexture((texture, layer) =>
  run(async () => {
    let layerId = layer?.id;
    if (!layerId) ({ layerId } = (await execute('paint.add_layer', { textureId: texture.id })) as { layerId: string });
    await execute('paint.fill', { textureId: texture.id, layerId, color: brushColor(), opacity: usePaint.getState().opacity });
  }),
);

export const addLayer = onTexture((texture) =>
  run(async () => {
    // Named in the UI language; an image without layers becomes the first one, so the new one is the second.
    const name = `${getT().paint.layer} ${Math.max(1, texture.layers?.length ?? 0) + 1}`;
    const { layerId } = (await execute('paint.add_layer', { textureId: texture.id, name })) as { layerId: string };
    selectLayer(texture.id, layerId);
  }),
);

export const removeLayer = onTexture((texture, layer) => {
  if (layer && (texture.layers?.length ?? 0) > 1) return run(() => execute('paint.remove_layer', { textureId: texture.id, layerId: layer.id }));
});

export const mergeDown = onTexture((texture, layer) => {
  const index = layer ? (texture.layers?.indexOf(layer) ?? -1) : -1;
  if (!layer || index < 1) return;
  const below = texture.layers![index - 1];
  return run(async () => {
    await execute('paint.merge_down', { textureId: texture.id, layerId: layer.id });
    // The merged layer is the lower one, whatever id the command kept for it.
    const now = selectDocState(useApp.getState()).textures[texture.id]?.layers;
    const merged = now?.find((l) => l.id === below.id) ?? now?.[index - 1];
    if (merged) selectLayer(texture.id, merged.id);
  });
});

export const flatten = onTexture((texture) => {
  if ((texture.layers?.length ?? 0) > 1) return run(() => execute('paint.flatten', { textureId: texture.id }));
});

export const updateLayer = (textureId: string, layerId: string, change: { name?: string; visible?: boolean; opacity?: number; blend?: BlendMode }) =>
  run(() => execute('paint.update_layer', { textureId, layerId, ...change }));

/** `index` counts from the bottom, like `Texture.layers`. */
export const moveLayer = (textureId: string, layerId: string, index: number) => run(() => execute('paint.move_layer', { textureId, layerId, index }));

export { activeLayerOf };

const toolKeys = { brush: 'B', eraser: 'E', picker: 'I' } as const;

/** The paint actions: tool rail, paint panel, command palette and shortcuts. They belong to the paint workspace. */
export const paintActions = (action: Define): Action[] => [
  ...paintTools.map((tool) =>
    action({
      id: `paint.tool_${tool}`,
      title: (t) => t.paint.toolAction(t.paint.toolNames[tool]),
      group: 'paint',
      keys: [toolKeys[tool]],
      available: inPaint,
      run: () => usePaint.setState({ tool }),
    }),
  ),
  action({ id: 'paint.fill', title: (t) => t.paint.fill, group: 'paint', keys: ['Shift+F'], command: 'paint.fill', available: inPaint, run: fillLayer }),
  // AltGr (Ctrl+Alt) types the brackets on a German keyboard.
  action({ id: 'paint.size_down', title: (t) => t.paint.sizeDown, group: 'paint', keys: ['[', 'Ctrl+Alt+['], available: inPaint, run: () => stepBrushSize(-1) }),
  action({ id: 'paint.size_up', title: (t) => t.paint.sizeUp, group: 'paint', keys: [']', 'Ctrl+Alt+]'], available: inPaint, run: () => stepBrushSize(1) }),
  action({ id: 'paint.create_texture', title: (t) => t.paint.createTexture, group: 'paint', command: 'paint.create_texture', available: () => inPaint() && currentTarget().problem === 'noTexture', run: createTexture }),
  action({ id: 'paint.add_layer', title: (t) => t.paint.addLayer, group: 'paint', command: 'paint.add_layer', available: inPaint, run: addLayer }),
  action({ id: 'paint.remove_layer', title: (t) => t.paint.removeLayer, group: 'paint', command: 'paint.remove_layer', available: inPaint, run: removeLayer }),
  action({ id: 'paint.merge_down', title: (t) => t.paint.mergeDown, group: 'paint', keys: ['Ctrl+E'], command: 'paint.merge_down', available: inPaint, run: mergeDown }),
  action({ id: 'paint.flatten', title: (t) => t.paint.flatten, group: 'paint', command: 'paint.flatten', available: inPaint, run: flatten }),
];
