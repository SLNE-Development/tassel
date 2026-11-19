import { create } from 'zustand';
import { selectDocState, useApp } from '../../app/store';
import { frameCount } from '../../core/minecraft/paintRegions';
import type { MirrorAxis } from '../../core/minecraft/paintRegions';
import type { BrushShape, CopyBrushMode, PixelBlendMode, PixelRect, Px, SelectMode } from '../../core/pixelOps';
import type { DocState, PaintLayer, Texture } from '../../core/types';

// Transient state of pixel painting (the paint workspace of Minecraft documents): the tools and their
// options, the colours, what is painted on, and the selection. Nothing here is part of the document.

export const pixelTools = ['brush', 'eraser', 'fill', 'shape', 'gradient', 'select', 'move', 'copy', 'picker'] as const;
export type PixelTool = (typeof pixelTools)[number];

export const pixelFillModes = ['face', 'element', 'selected', 'connected', 'same_color'] as const;
export type PixelFillMode = (typeof pixelFillModes)[number];

export const selectKinds = ['rect', 'ellipse', 'lasso', 'wand', 'color'] as const;
export type SelectKind = (typeof selectKinds)[number];

export const shapeKinds = ['rectangle', 'ellipse'] as const;
export type ShapeKind = (typeof shapeKinds)[number];

/** The pixels that are selected: one byte per pixel of the texture (1 = selected). */
export interface PixelSelection {
  readonly textureId: string;
  readonly width: number;
  readonly height: number;
  readonly mask: Uint8Array;
}

/** Where the copy brush takes its pixels from (set with Ctrl+click). */
export interface CopySource {
  /** The pixel that was Ctrl+clicked. */
  readonly at: Px;
  /** pattern / sample: the area around it (brush-sized) or the selection's bounds. */
  readonly rect: PixelRect;
}

/** The colours the default palette offers: a small pixel-art set. */
export const defaultPalette: readonly string[] = [
  '#000000', '#1d1d21', '#474f52', '#9d9d97', '#f9fffe', '#b02e26', '#f9801d', '#fed83d',
  '#80c71f', '#5e7c16', '#169c9c', '#3ab3da', '#3c44aa', '#8932b8', '#c74ebd', '#f38baa',
  '#835432', '#5a3a22', '#c8a26b', '#e6d4a8',
];

export interface PixelUiState {
  tool: PixelTool;
  /** Pixel-perfect lines for the brush (and eraser) at size 1. */
  pixelPerfect: boolean;
  size: number;
  shape: BrushShape;
  /** 0..1 */
  opacity: number;
  blend: PixelBlendMode;
  lockAlpha: boolean;
  /** Erase mode: the brush, shapes and fill remove instead of paint. */
  eraseMode: boolean;
  mirror: { enabled: boolean; axes: readonly MirrorAxis[]; mode: 'global' | 'local'; image: boolean };
  fillMode: PixelFillMode;
  /** Colour tolerance of the fill, wand and same-colour selection, 0..1. */
  tolerance: number;
  shapeKind: ShapeKind;
  shapeFilled: boolean;
  lineWidth: number;
  selectKind: SelectKind;
  selectMode: SelectMode;
  copyMode: CopyBrushMode;
  copySource: CopySource | null;
  primary: string;
  secondary: string;
  palette: readonly string[];
  /** The 2D editor shows the texture repeated around itself. */
  tiled: boolean;
  /** The 2D editor's pixel grid. */
  grid: boolean;
  /** The texture being painted (null: the one the active element shows). */
  textureId: string | null;
  /** Active layer per texture id (a missing entry means the top layer). */
  activeLayer: Readonly<Record<string, string>>;
  /** Frame of an animated texture that is painted on and shown. */
  frame: number;
  /** The animation preview runs. */
  playing: boolean;
  selection: PixelSelection | null;
}

const PALETTE_KEY = 'tessel.pixel.palette';

function storedPalette(): readonly string[] {
  try {
    const raw = localStorage.getItem(PALETTE_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : null;
    if (Array.isArray(list) && list.every((c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c))) return list as string[];
  } catch {
    // No storage (private mode) or a broken entry: the default palette.
  }
  return defaultPalette;
}

export const usePixel = create<PixelUiState>(() => ({
  tool: 'brush',
  pixelPerfect: false,
  size: 1,
  shape: 'square',
  opacity: 1,
  blend: 'default',
  lockAlpha: false,
  eraseMode: false,
  mirror: { enabled: false, axes: ['x'], mode: 'global', image: false },
  fillMode: 'connected',
  tolerance: 0,
  shapeKind: 'rectangle',
  shapeFilled: false,
  lineWidth: 1,
  selectKind: 'rect',
  selectMode: 'replace',
  copyMode: 'copy',
  copySource: null,
  primary: '#3c44aa',
  secondary: '#f9fffe',
  palette: storedPalette(),
  tiled: false,
  grid: true,
  textureId: null,
  activeLayer: {},
  frame: 0,
  playing: false,
  selection: null,
}));

/** Replaces the palette and keeps it for the next start. */
export function setPalette(palette: readonly string[]): void {
  const unique = [...new Set(palette.map((c) => c.toLowerCase()))];
  usePixel.setState({ palette: unique });
  try {
    localStorage.setItem(PALETTE_KEY, JSON.stringify(unique));
  } catch {
    // Not kept; it still works for this session.
  }
}

export function setPrimary(color: string): void {
  usePixel.setState({ primary: color.toLowerCase() });
}

export function swapColors(): void {
  usePixel.setState((s) => ({ primary: s.secondary, secondary: s.primary }));
}

export const MAX_PIXEL_BRUSH = 64;

export function setPixelSize(size: number): void {
  usePixel.setState({ size: Math.round(Math.min(MAX_PIXEL_BRUSH, Math.max(1, size))) });
}

// ------------------------------------------------------------------ target

/** The texture a Minecraft document paints on: the chosen one, else what the active element shows, else the first. */
export function pixelTexture(state: DocState, ui: Pick<PixelUiState, 'textureId'> = usePixel.getState()): Texture | undefined {
  if (ui.textureId && Object.hasOwn(state.textures, ui.textureId)) return state.textures[ui.textureId];
  const active = state.activeId ? state.objects[state.activeId] : undefined;
  if (active?.cuboid) {
    for (const face of Object.values(active.cuboid.faces)) {
      if (face.enabled && face.texture && Object.hasOwn(state.textures, face.texture)) return state.textures[face.texture];
    }
  }
  return Object.values(state.textures)[0];
}

/** The layer edits go to: the chosen one, else the top one; undefined for a texture without layers. */
export function pixelLayer(texture: Texture | undefined, ui: Pick<PixelUiState, 'activeLayer'> = usePixel.getState()): PaintLayer | undefined {
  const layers = texture?.layers;
  if (!texture || !layers?.length) return undefined;
  return layers.find((l) => l.id === ui.activeLayer[texture.id]) ?? layers[layers.length - 1];
}

export const currentPixelTexture = (): Texture | undefined => pixelTexture(selectDocState(useApp.getState()));

/** For components: the painted texture, following the document and the choice. */
export function usePixelTexture(): Texture | undefined {
  const textureId = usePixel((s) => s.textureId);
  return useApp((s) => pixelTexture(selectDocState(s), { textureId }));
}

/** The frame shown, kept inside the texture's frames. */
export function shownFrame(texture: Texture | undefined, frame = usePixel.getState().frame): number {
  return texture ? Math.min(Math.max(0, frame), frameCount(texture) - 1) : 0;
}
