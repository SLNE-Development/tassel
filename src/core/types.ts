// Core data model. Everything in src/core is DOM-free.
// All state is immutable: commands produce new objects, which makes undo a stack of DocStates.
// Conventions: Y is up, units are meters, rotations are Euler XYZ in degrees.

import type { Preferences } from './preferences';

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
  | (ModifierBase & { readonly type: 'array'; readonly count: number; /** Offset per copy in local units. */ readonly offset: Vec3 })
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

export interface ScreenshotOptions {
  width: number;
  height: number;
  /** 'current' uses the user's camera; a preset renders from that direction without moving the user's camera. */
  view: ViewPreset | 'current';
  /** Fit all visible objects into the frame (always true for presets). */
  fit: boolean;
}

/** Implemented by src/viewport, registered on mount. */
export interface ViewportService {
  /** Returns a PNG as base64 (no data: prefix). */
  screenshot(opts: ScreenshotOptions): Promise<string>;
  getCamera(): CameraPose;
  setCamera(pose: Partial<CameraPose>): void;
  setView(preset: ViewPreset): void;
  /** Frame the given objects; an empty array frames everything. */
  frame(ids: readonly string[]): void;
}

export const exportFormats = ['glb', 'gltf', 'obj', 'stl', 'ply', 'usdz'] as const;
export type ExportFormat = (typeof exportFormats)[number];

export const importFormats = ['glb', 'gltf', 'obj', 'stl', 'ply', 'fbx'] as const;
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
  }[];
  /** Parents come before their children. */
  groups: { name: string; parent: number | null }[];
  materials: (Omit<Material, 'id' | 'maps'> & { maps: Partial<Record<TextureSlot, number>> })[];
  textures: Omit<Texture, 'id'>[];
  /** Things the file had that were not imported, in English. */
  warnings: string[];
}

/** Implemented by src/io, registered at startup. */
export interface ImportService {
  /** Parses a file. Throws an Error with a clear English message if it cannot be read. */
  import(file: { format: ImportFormat; name: string; base64?: string; text?: string }): Promise<ImportedScene>;
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

export interface Services {
  viewport: ViewportService | null;
  exporter: ExportService | null;
  importer?: ImportService | null;
  imaging?: ImagingService | null;
  baker?: BakeService | null;
}
