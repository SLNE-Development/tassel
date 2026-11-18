import { useMemo } from 'react';
import { create } from 'zustand';
import { execute, selectDocState, useApp } from '../../app/store';
import { evaluateObject } from '../../core/modifiers/evaluate';
import type { DocState, Material, PaintLayer, SceneObject, Texture, TextureSlot } from '../../core/types';

export const paintTools = ['brush', 'eraser', 'picker'] as const;
export type PaintTool = (typeof paintTools)[number];

/** What can be painted: a map slot of the material, or a height texture that feeds "Normal Map erzeugen". */
export const paintSlots = ['baseColor', 'roughness', 'metallic', 'emissive', 'occlusion', 'height'] as const;
export type PaintSlot = (typeof paintSlots)[number];

/** Slots whose texture holds one value per pixel: painted in greys. */
export const isScalarSlot = (slot: PaintSlot): boolean => slot !== 'baseColor' && slot !== 'emissive';

export const textureSizes = [512, 1024, 2048, 4096] as const;

export const MIN_BRUSH = 1;
export const MAX_BRUSH = 1024;
const HINT_KEY = 'tessel.paint.hintSeen';

function hintSeen(): boolean {
  try {
    return localStorage.getItem(HINT_KEY) === '1';
  } catch {
    return false;
  }
}

/** Transient state of the paint workspace: the brush, and what it paints on. */
export interface PaintUiState {
  tool: PaintTool;
  /** Brush colour for colour slots, #rrggbb. */
  color: string;
  /** Brush value for scalar slots, 0..1 (painted as a grey). */
  value: number;
  /** Most recently painted colours, newest first. */
  recent: readonly string[];
  /** Brush diameter in texture pixels. */
  size: number;
  opacity: number;
  hardness: number;
  slot: PaintSlot;
  /** Size offered for new paint textures. */
  textureSize: (typeof textureSizes)[number];
  /** Active layer per texture id; a missing or stale entry means the top layer. */
  activeLayer: Readonly<Record<string, string>>;
  /** The height texture painted for a material (it is not bound to a slot), by material id. */
  heightTexture: Readonly<Record<string, string>>;
  /** The note about painting in texture space has been dismissed. */
  hintSeen: boolean;
}

export const usePaint = create<PaintUiState>(() => ({
  tool: 'brush',
  color: '#c2452d',
  value: 1,
  recent: [],
  size: 32,
  opacity: 1,
  hardness: 0.8,
  slot: 'baseColor',
  textureSize: 1024,
  activeLayer: {},
  heightTexture: {},
  hintSeen: hintSeen(),
}));

export function dismissHint(): void {
  try {
    localStorage.setItem(HINT_KEY, '1');
  } catch {
    // Private mode: the hint simply comes back next time.
  }
  usePaint.setState({ hintSeen: true });
}

export const greyHex = (value: number): string => {
  const c = Math.round(Math.min(1, Math.max(0, value)) * 255)
    .toString(16)
    .padStart(2, '0');
  return `#${c}${c}${c}`;
};

/** The colour the brush paints with on the current slot. */
export function brushColor(ui: PaintUiState = usePaint.getState()): string {
  return isScalarSlot(ui.slot) ? greyHex(ui.value) : ui.color;
}

/** Remembers a colour that was just painted with. */
export function rememberColor(color: string): void {
  const { recent } = usePaint.getState();
  if (recent[0] === color) return;
  usePaint.setState({ recent: [color, ...recent.filter((c) => c !== color)].slice(0, 6) });
}

export function setBrushSize(size: number): void {
  usePaint.setState({ size: Math.round(Math.min(MAX_BRUSH, Math.max(MIN_BRUSH, size))) });
}

/** One step of `[` / `]`: fine for small brushes, coarser for large ones. */
export function stepBrushSize(direction: 1 | -1): void {
  const { size } = usePaint.getState();
  const step = size < 10 ? 1 : size < 50 ? 4 : size < 200 ? 10 : 25;
  setBrushSize(size + direction * step);
}

/** What stands between the user and painting, in the order the panel offers to fix it. */
export type PaintProblem = 'noObject' | 'editMode' | 'noMaterial' | 'noUvs' | 'noTexture';

export interface PaintTarget {
  object: SceneObject | undefined;
  material: Material | undefined;
  slot: PaintSlot;
  texture: Texture | undefined;
  /** The layer strokes go to; undefined while the texture has no layers yet. */
  layer: PaintLayer | undefined;
  problem: PaintProblem | null;
}

/** The texture painted for `slot` on the material, if there is one. */
function slotTexture(state: DocState, material: Material, ui: PaintUiState): Texture | undefined {
  const id = ui.slot === 'height' ? ui.heightTexture[material.id] : material.maps[ui.slot as TextureSlot];
  return id === undefined ? undefined : state.textures[id];
}

/** The layer of `texture` that is painted on: the chosen one, else the top one. */
export function activeLayerOf(texture: Texture | undefined, ui: PaintUiState = usePaint.getState()): PaintLayer | undefined {
  const layers = texture?.layers;
  if (!texture || !layers?.length) return undefined;
  return layers.find((l) => l.id === ui.activeLayer[texture.id]) ?? layers[layers.length - 1];
}

/** Resolves what the brush would paint on right now, and what is missing if it cannot. */
export function paintTarget(state: DocState, ui: PaintUiState = usePaint.getState()): PaintTarget {
  const object = state.activeId ? state.objects[state.activeId] : undefined;
  const material = object?.materialId ? state.materials[object.materialId] : undefined;
  const texture = material ? slotTexture(state, material, ui) : undefined;
  const layer = activeLayerOf(texture, ui);
  let problem: PaintProblem | null = null;
  if (!object) problem = 'noObject';
  else if (state.edit) problem = 'editMode';
  else if (!material) problem = 'noMaterial';
  // What is painted on is the mesh as rendered, after modifiers.
  else if (!evaluateObject(state, object.id).mesh.uvs) problem = 'noUvs';
  else if (!texture) problem = 'noTexture';
  return { object, material, slot: ui.slot, texture, layer, problem };
}

export const currentTarget = (): PaintTarget => paintTarget(selectDocState(useApp.getState()));

/** The paint target, for components: follows the document and the choices in the paint store. */
export function usePaintTarget(): PaintTarget {
  const state = useApp(selectDocState);
  const slot = usePaint((s) => s.slot);
  const activeLayer = usePaint((s) => s.activeLayer);
  const heightTexture = usePaint((s) => s.heightTexture);
  return useMemo(() => paintTarget(state), [state, slot, activeLayer, heightTexture]);
}

// Entering the paint workspace: material shading shows what is painted, and painting needs object mode.
useApp.subscribe((app, previous) => {
  if (app.workspace !== 'paint' || previous.workspace === 'paint') return;
  if (app.shading !== 'material') void execute('view.set_shading', { shading: 'material' });
  if (selectDocState(app).edit) void execute('edit.exit');
});
