import { z } from 'zod';
import type { CameraPose, Vec3 } from './types';

// Viewport preview options: backdrop, preview scene, reference models, projection and saved camera
// angles. They are app-wide view settings (stored with the preferences), never part of a document:
// they change what the viewport shows around the model, not the model, its file or its exports.

export const previewBackgrounds = ['solid', 'checkerboard', 'custom'] as const;
export type PreviewBackground = (typeof previewBackgrounds)[number];

/** Scenes that are not Minecraft-specific. */
export const basicScenes = ['none', 'studio', 'sky', 'space'] as const;
/** Scenes built from blocks; they use vanilla textures from the Minecraft assets when those are configured. */
export const minecraftScenes = [
  'plains',
  'snowy_tundra',
  'cherry_grove',
  'desert',
  'ocean',
  'underwater',
  'lush_cave',
  'deep_dark',
  'nether',
  'sunset',
  'night',
] as const;
export const previewScenes = [...basicScenes, ...minecraftScenes] as const;
export type PreviewScene = (typeof previewScenes)[number];
export type MinecraftScene = (typeof minecraftScenes)[number];

export const isMinecraftScene = (scene: PreviewScene): scene is MinecraftScene => (minecraftScenes as readonly string[]).includes(scene);

export const projections = ['perspective', 'orthographic'] as const;
export type Projection = (typeof projections)[number];

const vec3 = z.tuple([z.number(), z.number(), z.number()]);

export const MAX_CAMERA_ANGLES = 50;

export const cameraAngleSchema = z.object({
  name: z.string().trim().min(1).max(60),
  position: vec3,
  target: vec3,
  projection: z.enum(projections),
});
export type CameraAngle = z.infer<typeof cameraAngleSchema>;

/** Fields of the preferences schema (src/core/preferences.ts); every one has a default. */
export const previewPreferenceFields = {
  previewBackground: z
    .enum(previewBackgrounds)
    .default('solid')
    .describe('Viewport background when the preview scene is "none": solid (the theme colour), checkerboard, or custom (previewBackgroundColor).'),
  previewBackgroundColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#3b4a54')
    .describe('Custom viewport background colour as #rrggbb, used when previewBackground is "custom".'),
  previewScene: z
    .enum(previewScenes)
    .default('none')
    .describe('Preview scene around the model: lighting, fog, background and (Minecraft scenes) a small block landscape. Never part of the document or exports.'),
  previewGround: z.boolean().default(false).describe('Show a ground plane under the model (scenes with block terrain bring their own ground).'),
  previewPixelGrid: z.boolean().default(false).describe('Show a 1/16 block pixel grid on the ground around the origin.'),
  previewPlayer: z.boolean().default(false).describe('Show a Minecraft player next to the model for scale.'),
  previewCraftingTable: z.boolean().default(false).describe('Show a crafting table (one block) next to the model for scale.'),
  previewSkin: z.string().max(4096).default('').describe('Path of a 64x64 skin PNG for the reference player; "" uses the default skin from the Minecraft assets.'),
  viewportProjection: z.enum(projections).default('perspective').describe('Projection of the viewport camera.'),
  cameraAngles: z.array(cameraAngleSchema).max(MAX_CAMERA_ANGLES).default([]).describe('Saved camera angles (view_save_angle / view_set_angle).'),
  minecraftAssets: z
    .string()
    .max(4096)
    .default('')
    .describe('Where vanilla Minecraft assets are read from: a client .jar or a resource pack folder ("" = none). Nothing is bundled with the app.'),
};

// ---------------------------------------------------------------- camera angles

export const anglePresets = ['top', 'bottom', 'north', 'south', 'east', 'west', 'iso_right', 'iso_left', 'true_iso'] as const;
export type AnglePreset = (typeof anglePresets)[number];

const DIMETRIC = Math.PI / 6; // 2:1 pixel isometry: the camera is 30° above the horizon.
const ISOMETRIC = Math.atan(1 / Math.SQRT2); // True isometry: 35.26°, so the axes are 120° apart on screen.
const tilted = (elevation: number, sideX: number): Vec3 => {
  const flat = Math.cos(elevation) * Math.SQRT1_2;
  return [sideX * flat, Math.sin(elevation), flat];
};

/**
 * Direction from the orbit target towards the camera for each preset. Minecraft's compass: north is -Z,
 * east is +X. `north` puts the camera on the north side, looking south at the north face.
 */
export const angleDirections: Record<AnglePreset, Vec3> = {
  // Slightly tilted so a Y-up camera stays well-defined straight above or below.
  top: [0, 1, 1e-4],
  bottom: [0, -1, 1e-4],
  north: [0, 0, -1],
  south: [0, 0, 1],
  east: [1, 0, 0],
  west: [-1, 0, 0],
  iso_right: tilted(DIMETRIC, 1),
  iso_left: tilted(DIMETRIC, -1),
  true_iso: tilted(ISOMETRIC, 1),
};

/** Isometric views only look right without perspective. */
export const angleProjection = (preset: AnglePreset): Projection | null => (preset.includes('iso') ? 'orthographic' : null);

export const ANGLE_PRESETS_HINT =
  'Presets: top / bottom; north / south / east / west = camera on that side (Minecraft compass: north is -Z, east is +X) looking at the centre; ' +
  'iso_right / iso_left = 2:1 pixel-art isometry (camera 30° above the horizon, from front-right / front-left); true_iso = true isometry (35.26°, from front-right). ' +
  'The iso presets switch to the orthographic projection.';

/** The camera that looks at the same target from `direction` at the same distance as `current`. */
export function cameraFrom(current: CameraPose, direction: Vec3): CameraPose {
  const [tx, ty, tz] = current.target;
  const distance = Math.hypot(current.position[0] - tx, current.position[1] - ty, current.position[2] - tz) || 1;
  const length = Math.hypot(...direction) || 1;
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  return {
    position: [round(tx + (direction[0] / length) * distance), round(ty + (direction[1] / length) * distance), round(tz + (direction[2] / length) * distance)],
    target: [...current.target],
  };
}

/** The angle list with `angle` added, or replacing the one of the same name (case-insensitive). */
export function withCameraAngle(angles: readonly CameraAngle[], angle: CameraAngle): CameraAngle[] {
  const key = angle.name.trim().toLowerCase();
  const index = angles.findIndex((a) => a.name.trim().toLowerCase() === key);
  if (index >= 0) return angles.map((a, i) => (i === index ? angle : a));
  if (angles.length >= MAX_CAMERA_ANGLES) throw new Error(`At most ${MAX_CAMERA_ANGLES} camera angles can be saved; delete one first`);
  return [...angles, angle];
}

export function findCameraAngle(angles: readonly CameraAngle[], name: string): CameraAngle | undefined {
  const key = name.trim().toLowerCase();
  return angles.find((a) => a.name.trim().toLowerCase() === key);
}
