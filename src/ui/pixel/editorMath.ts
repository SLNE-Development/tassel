// Pure helpers of the 2D pixel editor: the view transform (texture pixels <-> screen) and the outline of a
// selection mask.

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 64;

/** The texture's top-left corner on screen (CSS px) and the screen pixels per texture pixel. */
export interface View {
  zoom: number;
  panX: number;
  panY: number;
}

export const clampZoom = (zoom: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

/** The zoom at which the frame fits the viewport with a margin: an integer when it is 1 or more. */
export function fitZoom(width: number, height: number, viewW: number, viewH: number, margin = 24): number {
  if (width <= 0 || height <= 0) return 1;
  const raw = Math.min((viewW - 2 * margin) / width, (viewH - 2 * margin) / height);
  if (!(raw > 0)) return MIN_ZOOM;
  return clampZoom(raw >= 1 ? Math.floor(raw) : raw);
}

/** A view that centres the frame in the viewport. */
export function centeredView(width: number, height: number, viewW: number, viewH: number, zoom: number): View {
  return { zoom, panX: Math.round((viewW - width * zoom) / 2), panY: Math.round((viewH - height * zoom) / 2) };
}

/** The next integer zoom step up or down (below 1 it halves / doubles). */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  if (direction > 0) return clampZoom(zoom < 1 ? zoom * 2 : Math.floor(zoom + 1e-9) + 1);
  return clampZoom(zoom <= 1 ? zoom / 2 : Math.ceil(zoom - 1e-9) - 1);
}

/** Zooms to `zoom`, keeping the texture point under the screen point (sx, sy) fixed. */
export function zoomAt(view: View, zoom: number, sx: number, sy: number): View {
  const z = clampZoom(zoom);
  const tx = (sx - view.panX) / view.zoom;
  const ty = (sy - view.panY) / view.zoom;
  return { zoom: z, panX: sx - tx * z, panY: sy - ty * z };
}

export const screenToTexture = (view: View, sx: number, sy: number): [number, number] => [(sx - view.panX) / view.zoom, (sy - view.panY) / view.zoom];

/** Wraps a pixel coordinate into 0..size-1 (for painting on the tiled copies). */
export const wrap = (v: number, size: number): number => (size <= 0 ? v : ((v % size) + size) % size);

/** Wraps a fractional coordinate into [0, size). */
export const wrapFloat = (v: number, size: number): number => (size <= 0 ? v : v - Math.floor(v / size) * size);

/** A wheel delta to a zoom factor step (one notch = one integer step). */
export const wheelDirection = (deltaY: number): 1 | -1 => (deltaY < 0 ? 1 : -1);

/** Unit edge of a pixel grid: [x0, y0, x1, y1] in texture pixels. */
export type Edge = readonly [number, number, number, number];

/**
 * The boundary between selected and unselected pixels of the rows y0..y0+h-1 of a mask (width `width`), as
 * horizontal and vertical unit edges; y is relative to y0.
 */
export function selectionEdges(mask: Uint8Array, width: number, height: number, y0 = 0, h = height - y0): Edge[] {
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] !== 0;
  const edges: Edge[] = [];
  for (let y = y0; y < y0 + h; y++) {
    const ry = y - y0;
    for (let x = 0; x < width; x++) {
      if (!on(x, y)) continue;
      if (!on(x, y - 1) || y === y0) edges.push([x, ry, x + 1, ry]);
      if (!on(x, y + 1) || y === y0 + h - 1) edges.push([x, ry + 1, x + 1, ry + 1]);
      if (!on(x - 1, y)) edges.push([x, ry, x, ry + 1]);
      if (!on(x + 1, y)) edges.push([x + 1, ry, x + 1, ry + 1]);
    }
  }
  return edges;
}
