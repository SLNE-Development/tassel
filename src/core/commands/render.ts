import { z } from 'zod';
import { DEFAULT_FPS, MAX_KEY_FRAME, animatedState } from '../animation';
import { objectWorldBounds, unionBounds, type Bounds } from '../bounds';
import { FRAME_HINT, pictureCamera } from '../playhead';
import { REFS_HINT, resolveObjectId, resolveObjectIds } from '../refs';
import {
  MAX_RENDER_SECONDS,
  MAX_RENDER_SIZE,
  defaultRenderSettings,
  mergeRenderSettings,
  renderCameraSchema,
  renderSettingsOf,
  renderSettingsPatchShape,
  renderSettingsSchema,
  resolveRenderCamera,
  type RenderSettings,
  type RenderSettingsPatch,
} from '../render';
import { PRESET_DIRECTIONS_HINT, describeCamera } from '../screenshotViews';
import { activeDoc } from '../state';
import { viewPresets, type DocState, type Vec3 } from '../types';
import { defineCommand, docState, updateDocState } from './registry';

const SETTINGS_HINT =
  'Settings are grouped: environment { preset, intensity, rotation }, sun { enabled, azimuth, elevation, intensity, softness }, background { type, color, topColor }, ground { type, color, reflectivity }, camera { view, fit }, depthOfField { enabled, fStop, focusDistance }, output { width, height, samples, maxSeconds, bounces, denoise, toneMapping, exposure, format, quality }.';

/** The eight corners of a box. */
function corners(b: Bounds): Vec3[] {
  const out: Vec3[] = [];
  for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) out.push([x, y, z]);
  return out;
}

const distance = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Settings that cannot work together, as a message for the caller; null if they are fine. */
function settingsProblem(settings: RenderSettings): string | null {
  if (settings.background.type === 'transparent' && settings.output.format === 'jpeg') {
    return 'A transparent background needs an image format with an alpha channel: use format "png" or "webp", or another background type.';
  }
  return null;
}

export const renderCommands = [
  defineCommand({
    id: 'render.get_settings',
    title: 'Render-Einstellungen abfragen',
    description: `Get the render settings of the document: how render_image lights and frames it and what picture it produces. They are saved with the project. ${SETTINGS_HINT} Returns { settings, isDefault } (isDefault: the document has never changed them).`,
    params: z.object({}),
    history: false,
    run(ctx) {
      const state = docState(ctx);
      return { settings: renderSettingsOf(state), isDefault: state.render === undefined };
    },
  }),

  defineCommand({
    id: 'render.set_settings',
    title: 'Render-Einstellungen ändern',
    description:
      `Change the render settings of the document (saved with the project, one undo step). Give only what should change: any of the groups, each with any of its fields; everything else stays. ${SETTINGS_HINT} ` +
      'Typical looks: sunny outdoor = environment.preset "outdoor" with sun.enabled (elevation 30-60); product shot = "studio", sun off, background gradient or color, ground plane; evening = "sunset" with sun.elevation 5-15; dramatic = "night". ' +
      'Light and reflections always come from the environment and the sun; the background only decides what is seen behind the model. "reset": true first puts everything back to the defaults, then applies the rest. Returns { settings }. ' +
      'To try a setting for one picture only, pass it to render_image instead: nothing is stored then.',
    params: z.object({
      ...renderSettingsPatchShape,
      reset: z.boolean().default(false).describe('Start from the default settings instead of the current ones.'),
    }),
    run(ctx, p) {
      const { reset, ...patch } = p;
      const state = docState(ctx);
      const next = mergeRenderSettings(reset ? defaultRenderSettings : renderSettingsOf(state), patch as RenderSettingsPatch);
      const problem = settingsProblem(next);
      if (problem) throw new Error(problem);
      // Unchanged settings are not an undo step.
      if (JSON.stringify(next) !== JSON.stringify(renderSettingsOf(state)) || (reset && state.render !== undefined)) {
        updateDocState(ctx, (s) => ({ ...s, render: next }));
      }
      return { settings: next };
    },
  }),

  defineCommand({
    id: 'render.image',
    title: 'Bild rendern',
    description:
      'Render a presentation-quality picture of the document by path tracing: physically based light with soft shadows, light bouncing between surfaces, reflections of the surroundings in metals, emissive materials that really light what is near them. For a quick look while modelling use view_screenshot (instant, editor look); use this for pictures that are shown to someone. ' +
      'Rendered are the visible objects as displayed (after modifiers, world space, their PBR materials and textures, smooth or flat shading), without grid, gizmo or selection highlight; objects without a material are a neutral light grey. Nothing in the document or in what the user sees changes, and with "documentId" any open document can be rendered while the user works in another tab. ' +
      `The look comes from the render settings of the document (render_get_settings / render_set_settings); every parameter here overrides them for this one picture only. ${SETTINGS_HINT} ` +
      'CAMERA: "view" is "current" (the camera of that document\'s viewport) or a preset, which always frames the scene; or give "camera" { position, target, fov? }. "fit": true moves the camera along its viewing direction until everything rendered is in frame; a list frames just those objects. ' +
      PRESET_DIRECTIONS_HINT +
      ' The sun direction is sun.azimuth (0 = towards +Z, 90 = towards +X) and sun.elevation above the horizon; shadows fall to the opposite side, so for a camera on the +Z side a sun at azimuth -40 lights the model from the front left. ' +
      'TIME: the picture is refined sample by sample until "samples" is reached or "maxSeconds" is over, whichever comes first (the time includes preparing the scene, and the very first render of a session also compiles the renderer for a few seconds). The speed depends on the graphics card and the image size: on integrated graphics a 1280 x 720 picture gets about 3-5 samples per second. A draft needs about 30 samples, a clean picture 150-500; dim interiors lit only indirectly need more. If the result has converged: false and looks grainy, raise maxSeconds (up to ' +
      MAX_RENDER_SECONDS +
      ') or lower the size. Other calls are not blocked while a render runs; a second render waits for the first. ' +
      'ANIMATION: ' +
      FRAME_HINT +
      ' The result then also has frame, time (seconds) and animationCamera. For a whole animation as a video use render_video. ' +
      'Returns the image and { width, height, samples, seconds, converged, camera: { position, target, fov, direction, imageRight, imageUp } } (samples actually computed; converged = the asked-for sample count was reached). The native render_image tool additionally takes "path" to write the image to a file.',
    params: z
      .object({
        width: z.number().int().min(16).max(MAX_RENDER_SIZE).optional().describe(`Image width in pixels (up to ${MAX_RENDER_SIZE}). Default: the document's setting (1280).`),
        height: z.number().int().min(16).max(MAX_RENDER_SIZE).optional().describe(`Image height in pixels (up to ${MAX_RENDER_SIZE}). Default: the document's setting (720).`),
        samples: z.number().int().min(1).max(100000).optional().describe("Samples per pixel to aim for. Default: the document's setting (128)."),
        maxSeconds: z.number().min(1).max(MAX_RENDER_SECONDS).optional().describe(`Time budget in seconds, up to ${MAX_RENDER_SECONDS}. Default: the document's setting (30).`),
        view: z.enum(['current', ...viewPresets]).optional().describe('The view to render, unless "camera" is given. Default: the document\'s setting ("current").'),
        camera: renderCameraSchema.optional().describe('Render from this camera instead of "view". The user\'s viewport camera does not move.'),
        fit: z
          .union([z.boolean(), z.array(z.string()).max(10000)])
          .optional()
          .describe(`true: frame everything that is rendered, keeping the viewing direction. A list frames just these objects: ${REFS_HINT}. An empty list is the same as true. Presets always frame.`),
        hideIds: z.array(z.string()).max(10000).optional().describe(`Objects left out of this picture only: ${REFS_HINT}.`),
        focusOn: z.string().optional().describe('For depth of field: the object (id or name) that is in focus. Overrides depthOfField.focusDistance.'),
        format: renderSettingsSchema.shape.output.shape.format.optional().describe('png (default, lossless, alpha), jpeg or webp.'),
        environment: renderSettingsPatchShape.environment,
        sun: renderSettingsPatchShape.sun,
        background: renderSettingsPatchShape.background,
        ground: renderSettingsPatchShape.ground,
        depthOfField: renderSettingsPatchShape.depthOfField,
        output: renderSettingsPatchShape.output.describe('Further output settings for this picture: bounces, denoise, toneMapping, exposure, quality (width, height, samples, maxSeconds and format can also be given here).'),
        frame: z.number().min(0).max(MAX_KEY_FRAME).optional().describe('Animation frame to render (fractional allowed). Default: the static pose, no animation.'),
        useAnimationCamera: z.boolean().optional().describe('Look through the animated camera at "frame". Default: true when "frame" is given, the document has camera keys and neither "view" nor "camera" is given.'),
        interactive: z.boolean().default(false).describe('Used by the render dialog: such a render is cancelled when another render is asked for. Leave it out.'),
      })
      .refine((p) => !(p.view && p.camera), { message: 'Give either "view" or "camera", not both', path: ['camera'] }),
    history: false,
    concurrent: true,
    async run(ctx, p) {
      const renderer = ctx.services.renderer;
      if (!renderer) throw new Error('The renderer is not ready yet');
      // Everything is taken from the document as it is now; the render then works on that snapshot.
      const app = ctx.get();
      const doc = activeDoc(app);
      // At a frame of the animation: the document as it looks there, and by default through its animated camera.
      const state: DocState = p.frame === undefined ? doc.state : animatedState(doc.state, p.frame);
      const animated = pictureCamera(doc.state.animation, p.frame, p.useAnimationCamera, p.view !== undefined || p.camera !== undefined);
      const stored = renderSettingsOf(state);
      const fitRefs = Array.isArray(p.fit) ? p.fit : null;
      const settings = mergeRenderSettings(stored, {
        environment: p.environment,
        sun: p.sun,
        background: p.background,
        ground: p.ground,
        depthOfField: p.depthOfField,
        camera: { view: animated ?? p.camera ?? p.view, fit: p.fit === undefined ? (animated ? false : undefined) : p.fit !== false },
        output: { ...p.output, ...(p.width !== undefined && { width: p.width }), ...(p.height !== undefined && { height: p.height }), ...(p.samples !== undefined && { samples: p.samples }), ...(p.maxSeconds !== undefined && { maxSeconds: p.maxSeconds }), ...(p.format !== undefined && { format: p.format }) },
      });
      const problem = settingsProblem(settings);
      if (problem) throw new Error(problem);

      const hideIds = p.hideIds ? resolveObjectIds(state, p.hideIds) : [];
      const hidden = new Set(hideIds);
      const shown = state.order.filter((id) => state.objects[id].visible && !hidden.has(id));
      const boxes = shown.map((id) => objectWorldBounds(state, id)).filter((b): b is Bounds => b !== null);
      if (boxes.length === 0) {
        throw new Error(state.order.length === 0 ? 'Nothing to render: the document has no objects.' : 'Nothing to render: every object is hidden (in the document or by hideIds) or has no geometry.');
      }
      const fitIds = fitRefs && fitRefs.length > 0 ? resolveObjectIds(state, fitRefs) : null;
      const fitBoxes = fitIds ? fitIds.map((id) => objectWorldBounds(state, id)).filter((b): b is Bounds => b !== null) : boxes;
      const { width, height } = settings.output;
      const camera = resolveRenderCamera({
        view: settings.camera.view,
        fit: settings.camera.fit,
        fitPoints: (fitBoxes.length > 0 ? fitBoxes : boxes).flatMap(corners),
        current: ctx.services.viewport?.getCamera({ id: doc.id, state }) ?? null,
        defaultFov: app.preferences.fieldOfView,
        aspect: width / height,
      });
      if (distance(camera.position, camera.target) < 1e-9) throw new Error('The camera position and its target are the same point: there is no viewing direction.');

      let focusDistance = settings.depthOfField.focusDistance ?? distance(camera.position, camera.target);
      if (p.focusOn !== undefined) {
        const box = unionBounds([objectWorldBounds(state, resolveObjectId(state, p.focusOn))]);
        if (!box) throw new Error('The object to focus on has no geometry.');
        focusDistance = Math.max(1e-3, distance(camera.position, [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2]));
      }

      const { mimeType, base64, ...info } = await renderer.render(state, { settings, camera, hideIds, focusDistance, interactive: p.interactive });
      return {
        image: { mimeType, base64 },
        ...info,
        camera: { ...camera, ...describeCamera(camera.position, camera.target) },
        ...(p.frame !== undefined ? { frame: p.frame, time: Math.round((p.frame / (doc.state.animation?.fps ?? DEFAULT_FPS)) * 1e6) / 1e6, animationCamera: animated !== null } : {}),
      };
    },
  }),
];
