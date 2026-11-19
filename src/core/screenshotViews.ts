import type { ScreenshotOptions, ScreenshotView, Vec3, ViewPreset } from './types';

/*
 * The pure part of `view.screenshot`: where the view presets look from, how a camera is described in
 * words, and how several views are laid out on one sheet. No DOM, no three.js.
 */

/**
 * Direction from the orbit target towards the camera for each preset. Y is up, so "front" has the
 * camera on +Z looking along -Z.
 */
export const presetDirections: Record<ViewPreset, Vec3> = {
  front: [0, 0, 1],
  back: [0, 0, -1],
  right: [1, 0, 0],
  left: [-1, 0, 0],
  // Slightly tilted so the view stays well-defined with a Y-up camera: -Z is up in the top view's image.
  top: [0, 1, 1e-4],
  bottom: [0, -1, 1e-4],
  iso: [1, 0.8, 1],
};

/** Most views one sheet can hold. */
export const MAX_SHEET_VIEWS = 9;

const AXES = ['X', 'Y', 'Z'] as const;
/** An axis is named if the normalised direction has at least this much of it: for the image axes, and for the side the camera is on. */
const AXIS_SHARE = 0.4;
const SIDE_SHARE = 0.3;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);
const negate = (v: Vec3): Vec3 => [-v[0], -v[1], -v[2]];

function normalize(v: Vec3): Vec3 {
  const l = length(v);
  return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0];
}

/**
 * A direction as signed world axes: `+Z`, or `(+X, +Y, +Z)` for a diagonal. Only the axes that make
 * up a substantial part of the direction are named, at least the largest one.
 */
export function axisWords(direction: Vec3, share = AXIS_SHARE): string {
  const d = normalize(direction);
  const largest = Math.max(Math.abs(d[0]), Math.abs(d[1]), Math.abs(d[2]));
  if (largest === 0) return '0';
  const words: string[] = [];
  d.forEach((c, i) => {
    if (Math.abs(c) >= Math.min(share, largest)) words.push(`${c < 0 ? '-' : '+'}${AXES[i]}`);
  });
  return words.length === 1 ? words[0] : `(${words.join(', ')})`;
}

/**
 * The camera's axes in world space for a Y-up camera at `position` looking at `target`: `back` points
 * from the target to the camera, `right` and `up` are the image's right and up. Same convention as
 * three.js' lookAt, including for a camera straight above or below its target.
 */
export function cameraBasis(position: Vec3, target: Vec3): { back: Vec3; right: Vec3; up: Vec3 } {
  let back = sub(position, target);
  if (length(back) === 0) back = [0, 0, 1];
  back = normalize(back);
  let right = cross([0, 1, 0], back);
  if (length(right) === 0) {
    // Looking straight along Y: as if the camera were a hair towards +Z.
    back = normalize([back[0], back[1], back[2] + 1e-4]);
    right = cross([0, 1, 0], back);
  }
  right = normalize(right);
  return { back, right, up: cross(back, right) };
}

export interface CameraWords {
  /** e.g. `camera at +Z looking toward -Z`: on which side of its target the camera is. */
  direction: string;
  /** The world direction that points to the right in the image, e.g. `+X`. */
  imageRight: string;
  /** The world direction that points up in the image, e.g. `+Y`. */
  imageUp: string;
}

/** Describes a camera in words, so that a client that cannot see knows what an image shows. */
export function describeCamera(position: Vec3, target: Vec3): CameraWords {
  const { back, right, up } = cameraBasis(position, target);
  return {
    direction: `camera at ${axisWords(back, SIDE_SHARE)} looking toward ${axisWords(negate(back), SIDE_SHARE)}`,
    imageRight: axisWords(right),
    imageUp: axisWords(up),
  };
}

/** The caption of one view on a sheet. */
export function viewLabel(name: string, words: CameraWords): string {
  return `${name} | ${words.direction} | right ${words.imageRight}, up ${words.imageUp}`;
}

/** The words for a preset, independent of the scene. */
export function describePreset(preset: ViewPreset): CameraWords {
  return describeCamera(presetDirections[preset], [0, 0, 0]);
}

/** One sentence per preset for command descriptions. */
export const PRESET_DIRECTIONS_HINT =
  'World axes: Y is up, units are meters. Presets name the side the camera is on: front = camera on +Z looking toward -Z (image right = +X, up = +Y); ' +
  'back = camera on -Z looking toward +Z (image right = -X); right = camera on +X looking toward -X (image right = -Z); ' +
  'left = camera on -X looking toward +X (image right = +Z); top = camera on +Y looking down (image right = +X, image up = -Z); ' +
  'bottom = camera on -Y looking up (image right = +X, image up = +Z); iso = camera on the (+X, +Y, +Z) side, direction (1, 0.8, 1), looking at the centre.';

export interface NamedView {
  /** `front`, `current`, `camera`, or `camera 2` for the second view of a sheet. */
  name: string;
  view: ScreenshotView;
}

/** The views a screenshot shows, in order: `views`, else the one `camera`, else `view`. */
export function screenshotViews(opts: Pick<ScreenshotOptions, 'view' | 'camera' | 'views'>): NamedView[] {
  if (opts.views && opts.views.length > 0) {
    return opts.views.map((view, i) => ({ name: typeof view === 'string' ? view : `camera ${i + 1}`, view }));
  }
  if (opts.camera) return [{ name: 'camera', view: opts.camera }];
  return [{ name: opts.view, view: opts.view }];
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SheetTile {
  /** The whole tile, caption included. */
  tile: Rect;
  /** Where the rendered view goes, below the caption. */
  image: Rect;
}

export interface SheetLayout {
  columns: number;
  rows: number;
  /** Height of the caption strip at the top of each tile. */
  labelHeight: number;
  fontSize: number;
  tiles: SheetTile[];
}

/** Line between tiles. */
export const SHEET_GAP = 2;
/** A view smaller than this shows nothing useful. */
export const MIN_TILE_IMAGE = 32;

/**
 * Lays `count` views out on a sheet of `width` x `height` pixels: a grid as square as possible
 * (2 → 2x1, 3-4 → 2x2, 5-6 → 3x2, 7-9 → 3x3), filled row by row, tiles separated by a thin line, each
 * with a caption strip on top. All numbers are whole pixels and the tiles cover the sheet exactly.
 * Throws if the sheet is too small for that many views.
 */
export function sheetLayout(count: number, width: number, height: number): SheetLayout {
  if (!Number.isInteger(count) || count < 1 || count > MAX_SHEET_VIEWS) {
    throw new Error(`A screenshot shows 1 to ${MAX_SHEET_VIEWS} views, not ${count}`);
  }
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  /** Start of cell i of n along a side of `size` pixels, the gaps included. */
  const edge = (i: number, n: number, size: number) => Math.round((i * (size + SHEET_GAP)) / n);
  const cell = (i: number, n: number, size: number) => ({ start: edge(i, n, size), size: edge(i + 1, n, size) - SHEET_GAP - edge(i, n, size) });

  const rowHeight = cell(0, rows, height).size;
  const fontSize = Math.max(11, Math.min(16, Math.round(rowHeight * 0.045)));
  const labelHeight = fontSize + 8;
  const tiles: SheetTile[] = [];
  for (let i = 0; i < count; i++) {
    const h = cell(i % columns, columns, width);
    const v = cell(Math.floor(i / columns), rows, height);
    const tile = { x: h.start, y: v.start, width: h.size, height: v.size };
    const image = { x: tile.x, y: tile.y + labelHeight, width: tile.width, height: tile.height - labelHeight };
    if (image.width < MIN_TILE_IMAGE || image.height < MIN_TILE_IMAGE) {
      throw new Error(
        `${count} views do not fit on a ${width} x ${height} image (each view would be ${Math.max(0, image.width)} x ${Math.max(0, image.height)} pixels). Use a larger width/height or fewer views.`,
      );
    }
    tiles.push({ tile, image });
  }
  return { columns, rows, labelHeight, fontSize, tiles };
}

/** Free space around a framed model, as a factor on the camera distance. */
export const FIT_MARGIN = 1.08;

/**
 * How far from `centre` a camera has to be, on the side `direction` (from the centre towards the
 * camera), so that all `points` are in a frame of the given vertical field of view and aspect ratio
 * (width / height) with a small margin. With the corners of each object's box as points this is much
 * tighter than framing a bounding sphere: a flat or long model fills the picture from every side.
 */
export function fitDistance(points: readonly Vec3[], centre: Vec3, direction: Vec3, fovDeg: number, aspect: number): number {
  const { back, right, up } = cameraBasis(direction, [0, 0, 0]);
  const tanV = Math.tan((fovDeg * Math.PI) / 360);
  const tanH = tanV * aspect;
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  let distance = 0;
  let nearest = 0;
  let radius = 0;
  for (const point of points) {
    const p = sub(point, centre);
    // A point `depth` towards the camera and `x`, `y` off the axis is in frame from depth + offset / tan.
    const depth = dot(p, back);
    distance = Math.max(distance, depth + Math.abs(dot(p, right)) / tanH, depth + Math.abs(dot(p, up)) / tanV);
    nearest = Math.max(nearest, depth);
    radius = Math.max(radius, length(p));
  }
  // The margin, and room in front of the nearest point for something long seen end-on.
  return Math.max(distance * FIT_MARGIN, nearest + radius * 0.25, 1e-3);
}
