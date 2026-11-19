// Pixel-art painting: the operations, as plain data. Core describes WHAT happens to the pixels of one
// layer (or of a texture without layers); src/imaging/pixelArt decides the pixel values, deterministically,
// so the live preview in the UI and the committed command give the same image.
//
// Coordinates are texture pixels: integers, x to the right, y DOWN, row 0 = top of the image (as Minecraft
// UVs and image files have it; the smooth brush of paint.stroke uses UVs with v up instead). A pixel (x, y)
// covers [x, x + 1) x [y, y + 1); geometric tests use its centre (x + 0.5, y + 0.5).

/**
 * How paint lands on a pixel (src = the paint colour with its alpha, dst = the pixel there):
 * - default: src over dst
 * - set_opacity: colour mixed in by opacity, the pixel's alpha SET to the opacity (where painted)
 * - color: dst's lightness kept, hue and saturation from src
 * - behind: dst over src (only shows where dst is transparent)
 * - multiply, add, lighten, darken, screen, overlay, difference: the usual per-channel formulas on the
 *   colours, then mixed into dst by src's alpha; the pixel's alpha becomes as with default.
 */
export const pixelBlendModes = ['default', 'set_opacity', 'color', 'behind', 'multiply', 'add', 'lighten', 'darken', 'screen', 'overlay', 'difference'] as const;
export type PixelBlendMode = (typeof pixelBlendModes)[number];

export const brushShapes = ['square', 'round'] as const;
export type BrushShape = (typeof brushShapes)[number];

/** A pixel position [x, y]: integers, y down. */
export type Px = readonly [x: number, y: number];

export interface PixelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** How a tool's paint is applied to each pixel it covers. */
export interface PixelPaint {
  /** '#rrggbb' (ignored when erase is on, and by tools that bring their own colours). */
  readonly color: string;
  /** 0..1 */
  readonly opacity: number;
  readonly blend: PixelBlendMode;
  /** Keep every pixel's alpha as it was: only the colour of already painted pixels changes. */
  readonly lockAlpha: boolean;
  /** Remove alpha (by opacity) instead of painting; blend and color are ignored. */
  readonly erase: boolean;
}

/**
 * Mirror painting: every covered pixel inside `from` is also covered at the corresponding place inside `to`
 * (the same relative position, after the flips; `swap` exchanges the relative x and y, applied after the flips,
 * for faces that sit rotated in the texture). Sizes may differ: positions are scaled. Computed in core from
 * the elements of a Minecraft model (src/core/minecraft/paintMirror.ts) or for the 2D editor's symmetry.
 */
export interface MirrorMap {
  readonly from: PixelRect;
  readonly to: PixelRect;
  readonly flipX: boolean;
  readonly flipY: boolean;
  readonly swap: boolean;
}

export const selectModes = ['replace', 'add', 'subtract', 'intersect'] as const;
export type SelectMode = (typeof selectModes)[number];

/**
 * One step of building a selection; a selection is a list of them applied in order to an empty mask
 * ('replace' clears the mask first). Colours are compared on RGBA with `tolerance` 0..1 (0 = exactly equal;
 * the largest channel difference / 255 must be <= tolerance). Fully transparent pixels are all equal.
 */
export type SelectionShape =
  | { readonly shape: 'rect'; readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly mode?: SelectMode }
  /** The ellipse inscribed in the rectangle: pixels whose centre lies inside it. */
  | { readonly shape: 'ellipse'; readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly mode?: SelectMode }
  /** A polygon through pixel positions (as points, not centres: [0,0],[4,0],[4,4] covers pixel centres inside). */
  | { readonly shape: 'lasso'; readonly points: readonly Px[]; readonly mode?: SelectMode }
  /** Magic wand: the 4-connected pixels of similar colour around (x, y), read from the edited layer. */
  | { readonly shape: 'wand'; readonly x: number; readonly y: number; readonly tolerance: number; readonly mode?: SelectMode }
  /** Every pixel of similar colour to the one at (x, y), anywhere in the layer. */
  | { readonly shape: 'color'; readonly x: number; readonly y: number; readonly tolerance: number; readonly mode?: SelectMode }
  /**
   * An explicit mask over a rectangle: `bits` is base64 of one bit per pixel, rows top to bottom, each row
   * starting on a new byte, most significant bit first. The UI sends its selection like this.
   */
  | { readonly shape: 'mask'; readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly bits: string; readonly mode?: SelectMode };

export const fillModes = ['regions', 'connected', 'same_color', 'all'] as const;
export type FillMode = (typeof fillModes)[number];

export const copyBrushModes = ['copy', 'pattern', 'sample'] as const;
export type CopyBrushMode = (typeof copyBrushModes)[number];

/** What the brush footprint is: a `size` x `size` square, or the round disc of diameter `size`. */
export interface PixelBrush {
  /** 1..256 pixels. */
  readonly size: number;
  readonly shape: BrushShape;
}

/** Image adjustments (Image menu). Each works on colour, keeps alpha unless it is about alpha. */
export type Adjustment =
  /** brightness, contrast: -1..1 (0 = unchanged). */
  | { readonly type: 'brightness_contrast'; readonly brightness: number; readonly contrast: number }
  /** hue: degrees -180..180; saturation, lightness: -1..1 (0 = unchanged). */
  | { readonly type: 'hue_saturation'; readonly hue: number; readonly saturation: number; readonly lightness: number }
  /** Alpha multiplied by `factor` (0..4). */
  | { readonly type: 'opacity'; readonly factor: number }
  | { readonly type: 'invert' }
  /**
   * Tone curves: control points [in, out], both 0..1, sorted by `in`, interpolated with a monotone cubic.
   * `rgb` applies to the three colour channels, then r, g, b, a to their own channel. Absent = identity.
   */
  | {
      readonly type: 'curves';
      readonly rgb?: readonly (readonly [number, number])[];
      readonly r?: readonly (readonly [number, number])[];
      readonly g?: readonly (readonly [number, number])[];
      readonly b?: readonly (readonly [number, number])[];
      readonly a?: readonly (readonly [number, number])[];
    }
  /** Every visible pixel set to the nearest palette colour (RGB distance), alpha kept. */
  | { readonly type: 'limit_palette'; readonly colors: readonly string[] };

/**
 * An edit of ONE layer's pixels (or of the image of a texture without layers). The result depends only on
 * the operation and the pixels of that layer: nothing else is read.
 *
 * `selection` (where present) limits the effect to the selected pixels; absent = everywhere. `mirror` adds
 * the mirrored pixels of everything covered (before the selection limits it).
 */
export type PixelOp =
  /** Pixel brush: Bresenham lines between the points, the footprint stamped at every pixel of them. Each covered pixel is painted once per stroke. */
  | {
      readonly op: 'stroke';
      readonly points: readonly Px[];
      /** Indices into points at which a new, unconnected polyline starts. */
      readonly breaks?: readonly number[];
      readonly brush: PixelBrush;
      /** Size 1 only: L-shaped corners of the line are removed, so it stays one pixel thin. */
      readonly pixelPerfect: boolean;
      readonly paint: PixelPaint;
      readonly mirror?: readonly MirrorMap[];
      readonly selection?: readonly SelectionShape[];
    }
  /**
   * Paint bucket. regions: every pixel inside the rectangles (faces / elements); connected: the 4-connected
   * pixels of similar colour around (x, y); same_color: all pixels of similar colour to (x, y); all: the whole layer.
   */
  | {
      readonly op: 'fill';
      readonly mode: FillMode;
      readonly x?: number;
      readonly y?: number;
      readonly regions?: readonly PixelRect[];
      readonly tolerance?: number;
      readonly paint: PixelPaint;
      readonly mirror?: readonly MirrorMap[];
      readonly selection?: readonly SelectionShape[];
    }
  /** Rectangle or ellipse spanning the pixels from..to (both included, any order). Hollow: an outline lineWidth pixels thick, inside the shape. */
  | {
      readonly op: 'shape';
      readonly shape: 'rectangle' | 'ellipse';
      readonly from: Px;
      readonly to: Px;
      readonly filled: boolean;
      readonly lineWidth: number;
      readonly paint: PixelPaint;
      readonly mirror?: readonly MirrorMap[];
      readonly selection?: readonly SelectionShape[];
    }
  /** Linear gradient from colors[0] at `from` to colors[1] at `to` (pixel centres), clamped beyond; painted with paint.opacity/blend/lockAlpha. */
  | {
      readonly op: 'gradient';
      readonly from: Px;
      readonly to: Px;
      readonly colors: readonly [string, string];
      readonly paint: Omit<PixelPaint, 'color' | 'erase'>;
      readonly selection?: readonly SelectionShape[];
    }
  /** Moves (or copies) the selected pixels by dx, dy: they replace what is at the destination; a move leaves transparency behind. */
  | { readonly op: 'move'; readonly selection: readonly SelectionShape[]; readonly dx: number; readonly dy: number; readonly copy: boolean }
  /**
   * Copy brush: a pixel brush stroke whose colour comes from the layer itself (as it was before the stroke).
   * copy: from the pixel at +offset (clone stamp); pattern: from `source` repeated over the whole image, aligned
   * to source.x/y; sample: the `source` rectangle stamped centred on every pixel of the stroke (later stamps win).
   */
  | {
      readonly op: 'copy_brush';
      readonly mode: CopyBrushMode;
      readonly points: readonly Px[];
      readonly breaks?: readonly number[];
      readonly brush: PixelBrush;
      readonly offset?: Px;
      readonly source?: PixelRect;
      readonly paint: Omit<PixelPaint, 'color' | 'erase'>;
      readonly selection?: readonly SelectionShape[];
    }
  | { readonly op: 'adjust'; readonly adjust: Adjustment; readonly selection?: readonly SelectionShape[] }
  /** Makes pixels transparent: the selection (or everything), except inside `keep`. */
  | { readonly op: 'clear'; readonly keep?: readonly PixelRect[]; readonly selection?: readonly SelectionShape[] }
  /** Replaces a rectangle with explicit pixels: base64 RGBA, width * height * 4 bytes, rows top to bottom. */
  | { readonly op: 'set'; readonly rect: PixelRect; readonly rgba: string };

/**
 * An edit of the whole texture (every layer the same way); the size may change.
 * frames: the texture as a vertical strip of square frames (frame height = width) is rebuilt from `order`:
 * each entry is the index of an old frame to put there, or null for a transparent frame.
 */
export type TextureTransform =
  | { readonly op: 'flip'; readonly axis: 'x' | 'y' }
  | { readonly op: 'rotate'; readonly direction: 'cw' | 'ccw' }
  /** canvas: pixels stay where they are (anchored top-left), new space transparent; scale: nearest-neighbour scaling. */
  | { readonly op: 'resize'; readonly width: number; readonly height: number; readonly mode: 'canvas' | 'scale' }
  | { readonly op: 'crop'; readonly rect: PixelRect }
  | { readonly op: 'frames'; readonly order: readonly (number | null)[] };

/** Size of a texture after a transform (frames: needs the frame height = width). */
export function transformedSize(width: number, height: number, t: TextureTransform): { width: number; height: number } {
  switch (t.op) {
    case 'flip':
      return { width, height };
    case 'rotate':
      return { width: height, height: width };
    case 'resize':
      return { width: t.width, height: t.height };
    case 'crop':
      return { width: t.rect.width, height: t.rect.height };
    case 'frames':
      return { width, height: width * t.order.length };
  }
}
