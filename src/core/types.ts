// Core data model. Everything in src/core is DOM-free.
// All state is immutable: commands produce new objects, which makes undo a stack of DocStates.
// Conventions: Y is up, units are meters, rotations are Euler XYZ in degrees.

import type { Preferences } from './preferences';
import type { RenderService, RenderSettings } from './render';
import type { VideoService } from './video';

export type Vec3 = [number, number, number];

/** Polygon mesh: flat xyz positions and faces as vertex index loops (CCW seen from outside). */
export interface PolyMesh {
  readonly positions: readonly number[];
  readonly faces: readonly (readonly number[])[];
  /**
   * Optional texture coordinates per face corner: `uvs[f]` holds u,v for every corner of `faces[f]`
   * (length = 2 * faces[f].length), v pointing up. Absent = the mesh has not been unwrapped.
   */
  readonly uvs?: readonly (readonly number[])[];
}

export const textureMimeTypes = ['image/png', 'image/jpeg', 'image/webp'] as const;

/** An image stored inside the document. */
export interface Texture {
  readonly id: string;
  readonly name: string;
  readonly mimeType: (typeof textureMimeTypes)[number];
  /** The encoded image file as base64 (no data: prefix). */
  readonly data: string;
  readonly width: number;
  readonly height: number;
  /**
   * Paint layers, bottom first. Present on textures created or edited by painting; `data` is then
   * always the flattened PNG of the visible layers, so renderers and exporters only ever need `data`.
   */
  readonly layers?: readonly PaintLayer[];
}

export const blendModes = ['normal', 'multiply', 'screen', 'overlay', 'add'] as const;
export type BlendMode = (typeof blendModes)[number];

/** One layer of a painted texture: a PNG of the texture's size with alpha. */
export interface PaintLayer {
  readonly id: string;
  readonly name: string;
  readonly visible: boolean;
  /** 0..1 */
  readonly opacity: number;
  readonly blend: BlendMode;
  /** PNG as base64 (no data: prefix), same pixel size as the texture. */
  readonly data: string;
}

export const textureSlots = ['baseColor', 'normal', 'roughness', 'metallic', 'emissive', 'occlusion'] as const;
export type TextureSlot = (typeof textureSlots)[number];

/** PBR material (metallic-roughness, as in glTF). Colours are #rrggbb in sRGB. */
export interface Material {
  readonly id: string;
  readonly name: string;
  readonly baseColor: string;
  readonly metallic: number;
  readonly roughness: number;
  readonly emissive: string;
  readonly emissiveStrength: number;
  /** Strength of the normal map. */
  readonly normalScale: number;
  /** Texture id per slot. Scalar maps (roughness, metallic, occlusion) are read from the image's luminance. */
  readonly maps: Readonly<Partial<Record<TextureSlot, string>>>;
}

export interface Transform {
  readonly position: Vec3;
  readonly rotation: Vec3;
  readonly scale: Vec3;
}

/** An undirected edge as a vertex index pair with a < b. */
export type Edge = readonly [number, number];

export const modifierTypes = ['mirror', 'subdivision', 'array', 'boolean'] as const;
export type ModifierType = (typeof modifierTypes)[number];

export const booleanOperations = ['union', 'difference', 'intersect'] as const;
export type BooleanOperation = (typeof booleanOperations)[number];

interface ModifierBase {
  readonly id: string;
  /** Disabled modifiers are skipped when the object is evaluated. */
  readonly enabled: boolean;
}

/** Non-destructive operations, evaluated top to bottom on the object's base mesh (in local space). */
export type Modifier =
  | (ModifierBase & {
      readonly type: 'mirror';
      /** Mirror across the local planes x=0 / y=0 / z=0. */
      readonly axes: { readonly x: boolean; readonly y: boolean; readonly z: boolean };
      /** Vertices closer than this to the mirror plane are welded. */
      readonly mergeDistance: number;
    })
  | (ModifierBase & { readonly type: 'subdivision'; /** Catmull-Clark levels, 1-4. */ readonly levels: number })
  | (ModifierBase & {
      readonly type: 'array';
      readonly count: number;
      /** Offset per copy, in local units or (see `offsetSpace`) in world meters. */
      readonly offset: Vec3;
      /** Euler XYZ in degrees by which each copy is turned further than the one before it. */
      readonly rotation: Vec3;
      /** Local point the per-copy rotation turns about. */
      readonly pivot: Vec3;
      /**
       * 'world': `offset` is along the world axes in meters for the object's current rotation and scale. It
       * moves rigidly with the object: commands that change rotation or scale re-express it (modifiers/worldOffsets.ts).
       */
      readonly offsetSpace: 'local' | 'world';
    })
  | (ModifierBase & {
      readonly type: 'boolean';
      readonly operation: BooleanOperation;
      /** The other object; null (or a missing object) makes the modifier a no-op. */
      readonly targetId: string | null;
    });

export interface SceneObject {
  readonly id: string;
  readonly name: string;
  readonly visible: boolean;
  readonly transform: Transform;
  /** The editable base mesh. What is rendered and exported is this mesh after `modifiers`. */
  readonly mesh: PolyMesh;
  readonly modifiers: readonly Modifier[];
  /** Smooth (averaged vertex normals) instead of flat shading. */
  readonly smooth: boolean;
  /** The group this object is filed under, or null at top level. */
  readonly groupId: string | null;
  /** The object's material (a key of `DocState.materials`), or null for the default clay look. */
  readonly materialId: string | null;
}

/**
 * An organisational folder for objects and other groups. It has no transform of its own:
 * "selecting a group" means selecting the objects inside it. Helpers are in core/groups.ts.
 */
export interface Group {
  readonly id: string;
  readonly name: string;
  /** The group this group is nested in, or null at top level. Never forms a cycle. */
  readonly parentId: string | null;
}

export const elementModes = ['vertex', 'edge', 'face'] as const;
export type ElementMode = (typeof elementModes)[number];

/**
 * Edit mode: one object's base mesh is being edited. Only the array that matches `elementMode`
 * holds the selection; the other two are empty. Use the helpers in mesh/selection.ts to get the
 * selection as another element kind. Indices refer to `objects[objectId].mesh`.
 */
export interface EditState {
  readonly objectId: string;
  readonly elementMode: ElementMode;
  readonly vertices: readonly number[];
  readonly edges: readonly Edge[];
  readonly faces: readonly number[];
}

export const keyInterpolations = ['linear', 'smooth', 'step'] as const;
/** How a value gets from one key to the NEXT one: straight, eased in and out, or held and then jumping. */
export type KeyInterpolation = (typeof keyInterpolations)[number];

/** A keyframe: the value of one channel at an integer frame (>= 0). */
export interface Key<T> {
  readonly frame: number;
  readonly value: T;
  /** Applies from this key to the next one. */
  readonly interpolation: KeyInterpolation;
}

/**
 * The animated channels of one object. Every array is sorted by frame with at most one key per frame; a
 * channel without keys (absent) keeps the object's static value. Before the first and after the last
 * key the value holds. `visible` always switches at its keys.
 */
export interface ObjectTrack {
  readonly position?: readonly Key<Vec3>[];
  /** Euler XYZ in degrees; between two keys the rotation takes the shortest way (see core/animation.ts). */
  readonly rotation?: readonly Key<Vec3>[];
  readonly scale?: readonly Key<Vec3>[];
  readonly visible?: readonly Key<boolean>[];
}

/** A keyframe of the animated camera; `fov` is the vertical field of view in degrees. */
export interface CameraKey {
  readonly frame: number;
  readonly position: Vec3;
  readonly target: Vec3;
  readonly fov: number;
  readonly interpolation: KeyInterpolation;
}

/** Keyframe animation of a document. Frames are integers from 0; time in seconds = frame / fps. Helpers: core/animation.ts. */
export interface Animation {
  /** Frames per second, 1..120. */
  readonly fps: number;
  /** Length in frames, 1..100000: the animation shows the frames 0 .. frameCount - 1. */
  readonly frameCount: number;
  /** Tracks by object id; only objects that have at least one key. */
  readonly tracks: Readonly<Record<string, ObjectTrack>>;
  /** Camera keys sorted by frame, at most one per frame. Empty: the camera is not animated. */
  readonly camera: readonly CameraKey[];
}

/** The undoable part of a document. */
export interface DocState {
  readonly objects: Readonly<Record<string, SceneObject>>;
  /** Object ids in outliner order. */
  readonly order: readonly string[];
  readonly groups: Readonly<Record<string, Group>>;
  /** All group ids (exactly the keys of `groups`); siblings are shown in this relative order. */
  readonly groupOrder: readonly string[];
  /** Materials by id, in no particular order. Unused materials stay until deleted explicitly. */
  readonly materials: Readonly<Record<string, Material>>;
  /** Embedded images by id, in no particular order. */
  readonly textures: Readonly<Record<string, Texture>>;
  readonly selection: readonly string[];
  /** Last selected object; the gizmo attaches to it. Always part of `selection` or null. */
  readonly activeId: string | null;
  /** Set while in edit mode, null in object mode. */
  readonly edit: EditState | null;
  /** Keyframe animation; absent = nothing is animated. `objects` always holds the static (un-animated) values. */
  readonly animation?: Animation;
  /** How the document is rendered to pictures (render.* commands; see core/render.ts). Absent = the defaults. */
  readonly render?: RenderSettings;
}

export interface Doc {
  readonly id: string;
  readonly name: string;
  readonly filePath: string | null;
  readonly dirty: boolean;
  readonly state: DocState;
  readonly past: readonly DocState[];
  readonly future: readonly DocState[];
}

export const workspaces = ['modeling', 'uv', 'paint'] as const;
export type Workspace = (typeof workspaces)[number];

export const shadings = ['solid', 'wireframe', 'material'] as const;
export type Shading = (typeof shadings)[number];

export const tools = ['select', 'move', 'rotate', 'scale'] as const;
export type Tool = (typeof tools)[number];

export const viewPresets = ['front', 'back', 'left', 'right', 'top', 'bottom', 'iso'] as const;
export type ViewPreset = (typeof viewPresets)[number];

export interface AppState {
  /** App-wide settings; see core/preferences.ts. Not part of any document's undo history. */
  readonly preferences: Preferences;
  readonly docs: Readonly<Record<string, Doc>>;
  /** Document ids in tab order. */
  readonly docOrder: readonly string[];
  readonly activeDocId: string;
  readonly workspace: Workspace;
  readonly shading: Shading;
  readonly tool: Tool;
}

export interface CameraPose {
  position: Vec3;
  target: Vec3;
}

/** A camera for one screenshot only; `fov` is the vertical field of view in degrees (default: the viewport's). */
export interface ScreenshotCamera {
  position: Vec3;
  target: Vec3;
  fov?: number;
}

export type ScreenshotView = ViewPreset | 'current' | ScreenshotCamera;

/** Nothing here changes the user's camera, shading, selection or the visibility of objects in the document. */
export interface ScreenshotOptions {
  /** Size of the whole image, also when it shows several views. */
  width: number;
  height: number;
  /** 'current' uses the user's camera; a preset renders from that direction without moving the user's camera. */
  view: ViewPreset | 'current';
  /** Fit into the frame: all objects the screenshot shows, or just the objects with these ids (always done for presets). */
  fit: boolean | readonly string[];
  /** Render from this camera instead of `view`. */
  camera?: ScreenshotCamera;
  /** Several views on one sheet, each with a caption; replaces `view` and `camera`. */
  views?: readonly ScreenshotView[];
  /** Object ids left out of this screenshot. */
  hideIds?: readonly string[];
  /** If given, only these objects are shown. */
  onlyIds?: readonly string[];
  /** Shading for this screenshot (default: the viewport's). */
  shading?: Shading;
  /** Surfaces semi-transparent with all edges drawn, so that hidden parts show through. */
  xray?: boolean;
  /**
   * Render the state that is passed with the call from a scene of its own even when the document is the
   * visible one (as documents in the background always are), instead of the scene on screen: for pictures
   * of the document at another frame of its animation than the one the viewport shows.
   */
  offscreen?: boolean;
}

/**
 * A run of pictures of one document, e.g. the frames of a video. The scene is kept between the pictures,
 * so only what moved is updated; the scene on screen is never touched. `end` must be called when done.
 */
export interface ShotSequence {
  /**
   * Draws `state` (the document at one moment) into `target`, an HTMLCanvasElement or OffscreenCanvas
   * (opaque here, as core is DOM-free) that is resized to the picture. Selection highlights and
   * edit-mode overlays are drawn as `state` has them.
   */
  shot(opts: ScreenshotOptions, state: DocState, target: unknown): Promise<Omit<ScreenshotResult, 'base64'>>;
  end(): void;
}

/** What one view of a screenshot shows. */
export interface ScreenshotViewInfo {
  name: string;
  cameraPosition: Vec3;
  cameraTarget: Vec3;
  /** Vertical field of view in degrees. */
  fov: number;
  /** In words, e.g. `camera at +Z looking toward -Z`. */
  direction: string;
  /** The world directions that point right and up in the image, e.g. `+X` and `+Y`. */
  imageRight: string;
  imageUp: string;
  /** Where this view is in the image, in pixels from the top left (the whole image for a single view). */
  rect: { x: number; y: number; width: number; height: number };
}

export interface ScreenshotResult {
  /** PNG as base64 (no data: prefix). */
  base64: string;
  views: ScreenshotViewInfo[];
  width: number;
  height: number;
  backend: 'webgpu' | 'webgl2';
}

/** The open document a viewport call is about: its id and its current state. */
export interface ViewDocument {
  id: string;
  state: DocState;
}

/**
 * Implemented by src/viewport, registered on mount.
 *
 * Every method takes the document it is about (default: the visible one). For a document that is not
 * the visible tab nothing the user sees changes: a screenshot renders that document off-screen, and
 * the camera methods read / write its remembered camera - the one the user gets when they switch to
 * its tab and that `view: 'current'` screenshots of it use.
 */
export interface ViewportService {
  screenshot(opts: ScreenshotOptions, doc?: ViewDocument): Promise<ScreenshotResult>;
  /** Starts a run of pictures of a document (see `ShotSequence`). Optional: not every viewport can. */
  sequence?(doc: ViewDocument): ShotSequence;
  getCamera(doc?: ViewDocument): CameraPose;
  setCamera(pose: Partial<CameraPose>, doc?: ViewDocument): void;
  setView(preset: ViewPreset, doc?: ViewDocument): void;
  /** Frame the given objects; an empty array frames everything. */
  frame(ids: readonly string[], doc?: ViewDocument): void;
}

export const exportFormats = ['glb', 'gltf', 'obj', 'stl', 'ply', 'usdz'] as const;
export type ExportFormat = (typeof exportFormats)[number];

/** `tessel` is a project file whose content is merged into the document; `import.file` reads it itself, without the import service. */
export const importFormats = ['glb', 'gltf', 'obj', 'stl', 'ply', 'fbx', 'tessel'] as const;
export type ImportFormat = (typeof importFormats)[number];

/** An exported file: binary formats as base64, text formats as text. OBJ comes with its material library and images. */
export interface ExportResult {
  base64?: string;
  text?: string;
  /** OBJ only: the material library, to be written next to the .obj as `mtlName`. */
  mtl?: string;
  mtlName?: string;
  /** OBJ only: the texture images the .mtl refers to, to be written next to it. */
  files?: { name: string; base64: string }[];
}

/** Implemented by src/io, registered at startup. */
export interface ExportService {
  /**
   * Writes the visible objects (limited to `ids` if given) in the given format. `name` is the file name
   * without extension, used where a format refers to its side files (OBJ: .mtl and image names).
   */
  export(state: DocState, opts: { format: ExportFormat; ids?: readonly string[]; name?: string }): Promise<ExportResult>;
}

/** What an importer read from a file: plain data that `import.file` adds to the document. Indices refer to the arrays here. */
export interface ImportedScene {
  objects: {
    name: string;
    mesh: PolyMesh;
    transform: Transform;
    smooth: boolean;
    /** Index into `materials`, or null. */
    material: number | null;
    /** Index into `groups`, or null at top level. */
    group: number | null;
    /** Default: visible. */
    visible?: boolean;
    /** Default: none. A boolean modifier's `targetId` names the `key` of another object in `objects`. */
    modifiers?: readonly Modifier[];
    /** What boolean modifiers of this scene call this object (its id in the source project). */
    key?: string;
  }[];
  /** Parents come before their children. */
  groups: { name: string; parent: number | null }[];
  /** True: groups without objects are added too (a merged project). Default: only groups that hold objects. */
  keepEmptyGroups?: boolean;
  /**
   * `nameOnly`: the file names the material but its values are unknown (OBJ without its .mtl); such a
   * material stands for an existing material of the same name whatever that one's values are.
   */
  materials: (Omit<Material, 'id' | 'maps'> & { maps: Partial<Record<TextureSlot, number>>; nameOnly?: boolean })[];
  textures: Omit<Texture, 'id'>[];
  /** Things the file had that were not imported, in English. */
  warnings: string[];
}

/** Implemented by src/io, registered at startup. */
export interface ImportService {
  /** Parses a file. Throws an Error with a clear English message if it cannot be read. */
  import(file: { format: Exclude<ImportFormat, 'tessel'>; name: string; base64?: string; text?: string }): Promise<ImportedScene>;
}

/** One point of a brush stroke: texture coordinates (v up, 0..1) and optional pen pressure (0..1, default 1). */
export type StrokePoint = readonly [u: number, v: number, pressure?: number];
/** Stroke points as functions take them: `StrokePoint[]` and plain `number[][]` (as parsed from JSON) both fit. */
export type StrokePoints = readonly (readonly (number | undefined)[])[];

/** The brush of `paint.stroke` (see the command for the exact meaning of each value). */
export interface PaintBrush {
  /** #rrggbb (sRGB). Ignored when erasing. */
  readonly color: string;
  /** Diameter in texture pixels at pressure 1. */
  readonly size: number;
  /** 0..1, applied to the stroke as a whole. */
  readonly opacity: number;
  /** 1 = hard edge, 0 = soft from the centre. */
  readonly hardness: number;
  /** Stamp distance as a fraction of the diameter. */
  readonly spacing: number;
  /** Remove alpha instead of painting. */
  readonly erase: boolean;
}

/**
 * Pixel work for the paint commands (core itself never touches pixels). Implemented by src/imaging,
 * registered at startup. Every PNG is base64 without a data: prefix, 8-bit RGBA, not premultiplied.
 * All methods throw an Error with a clear English message when an image cannot be read or is too large.
 */
export interface ImagingService {
  /** A PNG of the given size: one opaque colour (#rrggbb), or fully transparent for null. */
  blank(width: number, height: number, color: string | null): Promise<string>;
  /** The texture's image as a PNG of exactly `texture.width` x `texture.height` (returns `texture.data` itself if it already is one). */
  baseLayer(texture: Texture): Promise<string>;
  /**
   * Paints the stroke into one layer of a layered texture. `flattened` is the same string as `layer` when the two images are identical.
   * `breaks`: indices into `points` at which a new polyline of the same stroke starts (not connected to the point before).
   */
  stroke(texture: Texture, layerId: string, brush: PaintBrush, points: StrokePoints, breaks?: readonly number[]): Promise<{ layer: string; flattened: string }>;
  /** Fills one layer with the colour at `opacity` (1 replaces every pixel). */
  fill(texture: Texture, layerId: string, color: string, opacity: number): Promise<{ layer: string; flattened: string }>;
  /** The visible layers (bottom first) composited onto transparency. */
  flatten(width: number, height: number, layers: readonly PaintLayer[]): Promise<string>;
  /** `upper` (with its opacity and blend mode) composited onto the pixels of `lower`. */
  mergeDown(width: number, height: number, lower: PaintLayer, upper: PaintLayer): Promise<string>;
  /** Tangent-space normal map (OpenGL convention) from the image's luminance as height. */
  normalFromHeight(texture: Texture, strength: number, invert: boolean): Promise<string>;
}

/** What a bake computes; see the bake.* commands for the meaning of the fields. */
export type BakeRequest =
  | { type: 'normal'; targetId: string; sourceIds: readonly string[]; size: number; maxDistance?: number }
  | { type: 'ao'; targetId: string; includeIds: readonly string[]; size: number; samples: number; distance?: number };

export interface BakeOutput {
  /** The baked image as a PNG of `size` x `size` pixels, base64 without a data: prefix. */
  data: string;
  /** Normal: share (0..1) of the target's texels that found a source surface. Ambient occlusion: 1. */
  coverage: number;
  /** The ray length that was used (the request's, or the default derived from the geometry). */
  distance: number;
}

/** Implemented by src/bake (in a worker), registered at startup. */
export interface BakeService {
  /** Bakes from the evaluated meshes of `state`. Rejects with a clear English message, also when the bake is cancelled. */
  bake(state: DocState, request: BakeRequest): Promise<BakeOutput>;
}

export const fontStyles = ['regular', 'bold', 'italic', 'bold-italic'] as const;

/** One available style of an installed font family. */
export interface FontStyle {
  /** bold = weight 600 and above. */
  style: (typeof fontStyles)[number];
  /** 100 (thin) to 900 (black); 400 is regular, 700 bold. */
  weight: number;
  italic: boolean;
}

export interface FontFamily {
  family: string;
  styles: FontStyle[];
  monospaced: boolean;
}

/**
 * One closed contour of a glyph in font units, y up. `ops` has one letter per segment and `coords` its
 * numbers: `M` x y (start), `L` x y (line), `Q` cx cy x y (quadratic Bezier), `C` c1x c1y c2x c2y x y (cubic Bezier).
 */
export interface FontContour {
  ops: string;
  coords: number[];
}

/** What a font has for the characters of a text. Lengths are in font units. */
export interface FontOutline {
  /** The family and style that were used (the closest style the family has). */
  family: string;
  style: FontStyle;
  unitsPerEm: number;
  /** Height of capital letters. */
  capHeight: number;
  ascender: number;
  /** Negative: below the baseline. */
  descender: number;
  lineGap: number;
  /** Every different character of the text the font has a glyph for. `contours` is empty for blanks. */
  glyphs: { char: string; advance: number; contours: FontContour[] }[];
  /** Characters of the text the font has no glyph for. */
  missing: string[];
  /** Added to the advance of `left` when `right` follows it directly; usually negative. */
  kerning: { left: string; right: string; value: number }[];
}

/** The fonts installed on the computer. Implemented by src/bridge/fonts.ts; only present in the desktop app. */
export interface FontService {
  /** All installed families, sorted by name. */
  list(): Promise<FontFamily[]>;
  /** Rejects with a clear English message if the family is not installed or the font cannot be read. */
  outline(request: { family: string; bold?: boolean; italic?: boolean; text: string }): Promise<FontOutline>;
}

export interface Services {
  viewport: ViewportService | null;
  exporter: ExportService | null;
  importer?: ImportService | null;
  imaging?: ImagingService | null;
  baker?: BakeService | null;
  fonts?: FontService | null;
  renderer?: RenderService | null;
  video?: VideoService | null;
}
