// Rendering ("Rendern…", render.* commands): the per-document settings and the pure maths around them.
// DOM-free. The renderer itself (path tracing on the GPU) is src/render, behind `RenderService`.
import { z } from 'zod';
import { fitDistance, presetDirections } from './screenshotViews';
import { viewPresets, type CameraPose, type DocState, type Vec3, type ViewPreset } from './types';

export const environmentPresets = ['outdoor', 'studio', 'sunset', 'night', 'neutral'] as const;
export type EnvironmentPreset = (typeof environmentPresets)[number];

export const backgroundTypes = ['environment', 'color', 'gradient', 'transparent'] as const;
export const groundTypes = ['none', 'plane'] as const;
export const toneMappings = ['aces', 'agx', 'neutral'] as const;
export type ToneMapping = (typeof toneMappings)[number];
export const renderFormats = ['png', 'jpeg', 'webp'] as const;
export type RenderFormat = (typeof renderFormats)[number];

/** Largest side of a rendered image, in pixels. */
export const MAX_RENDER_SIZE = 4096;
/** Longest time one render may take, in seconds. */
export const MAX_RENDER_SECONDS = 600;

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a colour as #rrggbb');
const finite = z.number().finite();
const finiteVec3 = z.tuple([finite, finite, finite]);

/** A camera given by where it is and what it looks at; `fov` is the vertical field of view in degrees. */
export const renderCameraSchema = z.object({
  position: finiteVec3.describe('Where the camera is, world coordinates in meters (Y is up)'),
  target: finiteVec3.describe('The point it looks at (centre of the image), world coordinates'),
  fov: z.number().min(5).max(120).optional().describe("Vertical field of view in degrees; default: the viewport's (40 unless changed in the preferences)"),
});

/**
 * The settings, one schema per group and none of them with defaults: `defaultRenderSettings` holds
 * those, so that the same schemas describe a complete settings object and (as `.partial()`) a change.
 */
const groups = {
  environment: z.object({
    preset: z
      .enum(environmentPresets)
      .describe(
        'The procedural surroundings that light the scene and show in reflections: outdoor = blue sky over a neutral ground; studio = dark room with large soft boxes (key from the front left, fill from the right, rim from behind, one overhead); sunset = orange horizon under a violet-blue sky, warm sun; night = nearly black studio with one cool key light and a faint warm rim, for dramatic low-key pictures; neutral = evenly white from all sides (flat, shadowless).',
      ),
    intensity: z.number().min(0).max(20).describe('Brightness of the surroundings (not of the sun); 1 = as designed, 0 = off.'),
    rotation: z.number().min(-360).max(360).describe('Turns the surroundings about the vertical axis, in degrees (seen from above, counter-clockwise for positive values). The sun has its own direction and does not turn with them.'),
  }),
  sun: z.object({
    enabled: z.boolean().describe('A sun: one strong directional light with shadows. Its colour follows the environment preset (warm white outdoors, orange at sunset, white otherwise).'),
    azimuth: z.number().min(-360).max(360).describe('Compass direction the sun is in, in degrees in the ground plane: 0 = towards +Z (the side the "front" view looks from), 90 = towards +X, 180 = towards -Z, -90 = towards -X. Shadows fall to the opposite side.'),
    elevation: z.number().min(0).max(90).describe('Height of the sun above the horizon in degrees: 90 = straight above (shortest shadows), 10 = low sun with long shadows.'),
    intensity: z.number().min(0).max(50).describe('Brightness of the sun. 4 is a sunny day: a white surface facing the sun comes out about white, next to an environment of intensity 1.'),
    softness: z.number().min(0.5).max(30).describe('Angular radius of the sun disc in degrees: 0.5 = hard shadows of a clear day, 2 = slightly soft (default), 10 = very soft shadows as from a large light.'),
  }),
  background: z.object({
    type: z.enum(backgroundTypes).describe('What is behind the model: environment = the surroundings themselves (sky, studio); color = one flat colour; gradient = vertical gradient from topColor (top of the image) to color (bottom); transparent = nothing, the image gets an alpha channel (PNG or WebP only). Lighting and reflections always come from the environment, whatever the background shows.'),
    color: color.describe('Background colour as #rrggbb (sRGB): the flat colour, or the bottom colour of the gradient.'),
    topColor: color.describe('Top colour of the gradient as #rrggbb (sRGB).'),
  }),
  ground: z.object({
    type: z.enum(groundTypes).describe('plane = a large matte ground at the lowest point of what is rendered, which catches the shadows and fades out towards its edge (into the background, or into transparency); none = the model floats.'),
    color: color.describe('Colour of the ground as #rrggbb (sRGB).'),
    reflectivity: z.number().min(0).max(1).describe('0 = matte, 1 = polished floor that mirrors the model.'),
  }),
  camera: z.object({
    view: z
      .union([z.enum(['current', ...viewPresets]), renderCameraSchema])
      .describe('"current" = the camera of the document (what the user sees in its viewport), a preset (front, back, left, right, top, bottom, iso: the side the camera is on, always with the scene in frame), or an explicit camera { position, target, fov? }.'),
    fit: z.boolean().describe('Move the camera along its viewing direction so that everything rendered is in frame.'),
  }),
  depthOfField: z.object({
    enabled: z.boolean().describe('Blur what is nearer or farther than the focus distance, like a real lens.'),
    fStop: z.number().min(0.1).max(64).describe('Aperture as an f-number of a 35 mm camera: 1.4 = strong blur, 8 = little. The effect is physical: clearly visible on small objects seen from close by, hardly on a building seen from 100 m.'),
    focusDistance: z.number().positive().nullable().describe('Distance from the camera to the plane that is sharp, in meters; null = the distance to the camera target.'),
  }),
  output: z.object({
    width: z.number().int().min(16).max(MAX_RENDER_SIZE).describe('Image width in pixels.'),
    height: z.number().int().min(16).max(MAX_RENDER_SIZE).describe('Image height in pixels.'),
    samples: z.number().int().min(1).max(100000).describe('Light paths traced per pixel. More = less noise, proportionally longer: 32 is a draft, 128 good, 500+ clean even in dim indirect light.'),
    maxSeconds: z.number().min(1).max(MAX_RENDER_SECONDS).describe('Time budget for computing samples, in seconds: the render stops there even if "samples" is not reached and returns what it has (converged: false). Preparing the scene comes on top.'),
    bounces: z.number().int().min(1).max(16).describe('How often light may bounce. 5 is right for nearly everything; lower is faster and darker in corners.'),
    denoise: z.number().min(0).max(1).describe('Strength of the noise filter applied to the finished image (0 = off). It smooths what the samples left over and removes single bright pixels, at the cost of very fine texture detail; it backs off by itself as the sample count grows.'),
    toneMapping: z.enum(toneMappings).describe('How scene brightness becomes image colours: aces = filmic with contrast, agx = softer, keeps bright colours from clipping, neutral = closest to the material colours as set.'),
    exposure: z.number().min(-10).max(10).describe('Exposure correction in stops: +1 = twice as bright, -1 = half.'),
    format: z.enum(renderFormats).describe('Image file format.'),
    quality: z.number().min(0.1).max(1).describe('Compression quality for jpeg and webp (1 = best).'),
  }),
} as const;

export const renderSettingsSchema = z.object(groups);
export type RenderSettings = z.infer<typeof renderSettingsSchema>;
type GroupName = keyof typeof groups;
export const renderSettingGroups = Object.keys(groups) as GroupName[];

/** A change of settings: any subset of the groups, each with any subset of its fields. */
export const renderSettingsPatchShape = {
  environment: groups.environment.partial().optional().describe('The surroundings that light the scene.'),
  sun: groups.sun.partial().optional().describe('The sun light.'),
  background: groups.background.partial().optional().describe('What is behind the model.'),
  ground: groups.ground.partial().optional().describe('The ground the model stands on.'),
  camera: groups.camera.partial().optional().describe('Where the picture is taken from.'),
  depthOfField: groups.depthOfField.partial().optional().describe('Lens blur.'),
  output: groups.output.partial().optional().describe('Image size, quality and file format.'),
} as const;
export type RenderSettingsPatch = { [G in GroupName]?: Partial<RenderSettings[G]> };

/** What a document renders with until something is changed: a sunny outdoor look on a soft backdrop. */
export const defaultRenderSettings: RenderSettings = {
  environment: { preset: 'outdoor', intensity: 1, rotation: 0 },
  sun: { enabled: true, azimuth: -40, elevation: 48, intensity: 4, softness: 2 },
  background: { type: 'gradient', color: '#dcdfe3', topColor: '#f2f4f6' },
  ground: { type: 'plane', color: '#d6d8db', reflectivity: 0 },
  camera: { view: 'current', fit: false },
  depthOfField: { enabled: false, fStop: 2.8, focusDistance: null },
  output: { width: 1280, height: 720, samples: 128, maxSeconds: 30, bounces: 5, denoise: 0.5, toneMapping: 'aces', exposure: 0, format: 'png', quality: 0.92 },
};

/** Sun direction and brightness that suit each environment preset (what the render dialog sets along with the preset). */
export const presetSun: Record<EnvironmentPreset, Partial<RenderSettings['sun']>> = {
  outdoor: { enabled: true, elevation: 48, intensity: 4, softness: 2 },
  studio: { enabled: false },
  sunset: { enabled: true, elevation: 8, intensity: 3, softness: 3 },
  night: { enabled: false },
  neutral: { enabled: false },
};

/** `base` with the fields of `patch` replaced. Groups without a change keep their identity. */
export function mergeRenderSettings(base: RenderSettings, patch: RenderSettingsPatch): RenderSettings {
  const next = { ...base } as Record<GroupName, unknown>;
  for (const group of renderSettingGroups) {
    const change = patch[group];
    if (!change) continue;
    const defined = Object.entries(change).filter(([, value]) => value !== undefined);
    if (defined.length > 0) next[group] = { ...base[group], ...Object.fromEntries(defined) };
  }
  return next as RenderSettings;
}

/**
 * Settings read from a project file. Never throws: a missing or invalid group or field falls back
 * to its default one by one, so a file from an older or newer version still opens.
 */
export function parseRenderSettings(raw: unknown): RenderSettings {
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const result = {} as Record<GroupName, Record<string, unknown>>;
  for (const group of renderSettingGroups) {
    const given = typeof input[group] === 'object' && input[group] !== null ? (input[group] as Record<string, unknown>) : {};
    const fields: Record<string, unknown> = { ...defaultRenderSettings[group] };
    for (const [key, schema] of Object.entries(groups[group].shape) as [string, z.ZodType][]) {
      if (!Object.hasOwn(given, key)) continue;
      const parsed = schema.safeParse(given[key]);
      if (parsed.success) fields[key] = parsed.data;
    }
    result[group] = fields;
  }
  return result as unknown as RenderSettings;
}

/** The document's render settings (the defaults until it has its own). */
export function renderSettingsOf(state: DocState): RenderSettings {
  return state.render ?? defaultRenderSettings;
}

/**
 * Unit vector from the scene towards the sun. Azimuth is measured in the ground plane from +Z
 * towards +X, elevation up from the horizon, both in degrees: (0, 0) is +Z, (90, 0) is +X, (·, 90) is +Y.
 */
export function sunDirection(azimuth: number, elevation: number): Vec3 {
  const a = (azimuth * Math.PI) / 180;
  const e = (elevation * Math.PI) / 180;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)];
}

/** Solid angle in steradians of a disc of the given angular radius (degrees) on the sky. */
export function discSolidAngle(radius: number): number {
  return 2 * Math.PI * (1 - Math.cos((radius * Math.PI) / 180));
}

/** The camera a picture is rendered from. */
export interface RenderCamera {
  position: Vec3;
  target: Vec3;
  /** Vertical field of view in degrees. */
  fov: number;
}

export interface RenderCameraInput {
  view: RenderSettings['camera']['view'];
  /** Frame `fitPoints` (keeping the viewing direction). Presets always do. */
  fit: boolean;
  /** World-space points that have to be in frame: the corners of the boxes of the objects to frame. */
  fitPoints: readonly Vec3[];
  /** The document's own camera for "current", if a viewport knows it. */
  current: CameraPose | null;
  /** Field of view where the view does not give one. */
  defaultFov: number;
  /** width / height of the image. */
  aspect: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 1];
};

function centreOf(points: readonly Vec3[]): Vec3 {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    for (let i = 0; i < 3; i++) {
      if (p[i] < min[i]) min[i] = p[i];
      if (p[i] > max[i]) max[i] = p[i];
    }
  }
  return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
}

/** A camera on the side `direction` of the points, far enough away to have them all in frame. */
function framed(points: readonly Vec3[], direction: Vec3, fov: number, aspect: number): RenderCamera {
  const d = norm(direction);
  if (points.length === 0) return { position: [d[0] * 5, d[1] * 5, d[2] * 5], target: [0, 0, 0], fov };
  const target = centreOf(points);
  const distance = fitDistance(points, target, d, fov, aspect);
  return { position: [target[0] + d[0] * distance, target[1] + d[1] * distance, target[2] + d[2] * distance], target, fov };
}

/**
 * Works out the camera of a render: an explicit camera or the document's current one as they are
 * (or moved along their viewing direction to frame the points with `fit`), a preset always framed.
 * Without a viewport that knows the current camera, "current" is the iso view.
 */
export function resolveRenderCamera(input: RenderCameraInput): RenderCamera {
  const { view, fitPoints, defaultFov, aspect } = input;
  if (typeof view === 'string' && view !== 'current') return framed(fitPoints, presetDirections[view as ViewPreset], defaultFov, aspect);
  const pose = typeof view === 'object' ? view : input.current;
  if (!pose) return framed(fitPoints, presetDirections.iso, defaultFov, aspect);
  const fov = (typeof view === 'object' ? view.fov : undefined) ?? defaultFov;
  if (input.fit && fitPoints.length > 0) return framed(fitPoints, sub(pose.position, pose.target), fov, aspect);
  return { position: [...pose.position], target: [...pose.target], fov };
}

/** One render: everything the renderer needs besides the document. */
export interface RenderJob {
  settings: RenderSettings;
  camera: RenderCamera;
  /** Objects left out of this picture. */
  hideIds: readonly string[];
  /** Distance of the sharp plane for depth of field, in meters. */
  focusDistance: number;
  /**
   * A render the user is watching in the render dialog: it gives way (is cancelled) when another
   * render is asked for, where other renders wait their turn.
   */
  interactive?: boolean;
}

export interface RenderOutput {
  mimeType: `image/${RenderFormat}`;
  /** The encoded image as base64 (no data: prefix). */
  base64: string;
  width: number;
  height: number;
  /** Samples per pixel the image was made of. */
  samples: number;
  /** Time the whole render took: preparing the scene, compiling the renderer if needed, sampling. */
  seconds: number;
  /** True if the asked-for sample count was reached within the time budget. */
  converged: boolean;
}

/** Implemented by src/render, registered at startup. */
export interface RenderService {
  /**
   * Renders the visible objects of `state` as they are displayed (after modifiers, world space, PBR
   * materials). Does not touch the viewport. Rejects with a clear English message, also when cancelled.
   */
  render(state: DocState, job: RenderJob): Promise<RenderOutput>;
}
