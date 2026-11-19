import { z } from 'zod';
import { docFormat } from '../formats';
import { DEFAULT_FPS, MAX_KEY_FRAME, animatedState } from '../animation';
import { FRAME_HINT, pictureCamera } from '../playhead';
import { REFS_HINT, resolveObjectIds } from '../refs';
import { MAX_SHEET_VIEWS, PRESET_DIRECTIONS_HINT } from '../screenshotViews';
import { activeDoc } from '../state';
import { shadings, tools, viewPresets, workspaces, type ViewDocument } from '../types';
import { defineCommand, vec3, type CommandContext } from './registry';
import { DOCUMENT_ID_HINT, requireOpenDocument } from './targeting';

function viewport(ctx: CommandContext) {
  if (!ctx.services.viewport) throw new Error('The 3D viewport is not ready yet');
  return ctx.services.viewport;
}

/** The document a view command is about: the visible one, or the one named by the call's `documentId` (see targeting.ts). */
function viewDoc(ctx: CommandContext): ViewDocument {
  const doc = activeDoc(ctx.get());
  return { id: doc.id, state: doc.state };
}

const BG_CAMERA =
  ' With a documentId that is not the visible document this is the remembered camera of that document: what the user gets when they switch to its tab and what view_screenshot of it uses for "current"; the visible viewport does not move.';

const screenshotCamera = z.object({
  position: vec3.describe('Where the camera is, world coordinates'),
  target: vec3.describe('The point it looks at (centre of the image), world coordinates'),
  fov: z.number().min(5).max(120).optional().describe("Vertical field of view in degrees; default: the viewport's (40 unless changed in the preferences)"),
});

export const viewCommands = [
  defineCommand({
    id: 'app.get_state',
    title: 'Editor-Zustand abfragen',
    description:
      `Get the current editor state: open documents, active document, workspace, tool, shading, selection and camera. Call this first to find out where you are. "documents" lists every open document (tab) in tab order with id, name, format ("free" for a general 3D model, "minecraft_java" for a Minecraft Java block/item model made of cuboid elements: the tools that only work in one of them say so first in their description), objectCount (the number of scene objects in it; groups, materials and textures are not counted), dirty (has unsaved changes), filePath (null if never saved) and active; activeDocument and visibleDocumentId are the tab the user is looking at right now (it can change at any time). "document" is the document this answer is about - the one given as documentId, else the visible one - and objectCount, selection, activeObjectId, editMode ({ objectId, elementMode } or null in object mode), canUndo, canRedo and camera (for a document in the background: its remembered camera) describe that document. So if you work in a document of your own, call this with its documentId to see where you are in it. ${DOCUMENT_ID_HINT}`,
    params: z.object({
      documentId: z.string().optional().describe('Optional: id of an open document (see "documents") to report on as "document" instead of the visible one.'),
    }),
    run(ctx, p) {
      const app = ctx.get();
      const visible = activeDoc(app);
      const doc = p.documentId === undefined ? visible : requireOpenDocument(app, p.documentId);
      const edit = doc.state.edit;
      return {
        activeDocument: { id: visible.id, name: visible.name, filePath: visible.filePath, dirty: visible.dirty },
        visibleDocumentId: visible.id,
        document: { id: doc.id, name: doc.name, filePath: doc.filePath, dirty: doc.dirty, visible: doc.id === visible.id, format: docFormat(doc.state) },
        documents: app.docOrder.map((id) => {
          const d = app.docs[id];
          return { id, name: d.name, format: docFormat(d.state), objectCount: d.state.order.length, dirty: d.dirty, filePath: d.filePath, active: id === app.activeDocId };
        }),
        workspace: app.workspace,
        tool: app.tool,
        shading: app.shading,
        objectCount: doc.state.order.length,
        selection: doc.state.selection,
        activeObjectId: doc.state.activeId,
        editMode: edit ? { objectId: edit.objectId, elementMode: edit.elementMode } : null,
        canUndo: doc.past.length > 0,
        canRedo: doc.future.length > 0,
        camera: ctx.services.viewport?.getCamera({ id: doc.id, state: doc.state }) ?? null,
      };
    },
  }),

  defineCommand({
    id: 'app.set_workspace',
    title: 'Arbeitsbereich wechseln',
    description: 'Switch the workspace tab: modeling, uv or paint.',
    params: z.object({ workspace: z.enum(workspaces) }),
    run(ctx, p) {
      ctx.set((app) => ({ ...app, workspace: p.workspace }));
    },
  }),

  defineCommand({
    id: 'view.set_tool',
    title: 'Werkzeug wählen',
    description: 'Set the active viewport tool for the user: select, move, rotate or scale. A setting of the whole app, not of one document; it has no effect on what other tools do.',
    params: z.object({ tool: z.enum(tools) }),
    run(ctx, p) {
      ctx.set((app) => ({ ...app, tool: p.tool }));
    },
  }),

  defineCommand({
    id: 'view.set_shading',
    title: 'Darstellung wechseln',
    description:
      'Set the viewport shading the user sees: solid, wireframe or material. A setting of the whole app, not of one document. To look at a model in another shading yourself, leave this alone and pass "shading" to view_screenshot.',
    params: z.object({ shading: z.enum(shadings) }),
    run(ctx, p) {
      ctx.set((app) => ({ ...app, shading: p.shading }));
    },
  }),

  defineCommand({
    id: 'view.screenshot',
    title: 'Screenshot',
    description:
      'Render a document to a PNG image so you can see the result of your work: the visible document, or with "documentId" any open document - that one is rendered off-screen with every option below, while the user keeps looking at their own tab. Nothing here changes a document or what the user sees: not the camera, the shading, the selection or the visibility of objects. ' +
      'ONE VIEW: "view" is "current" (the camera of that document: the user\'s camera for the visible one, else the camera remembered for its tab, which view_set_camera / view_set_view / view_frame with the same documentId set) or a preset, which looks at the scene from that side with everything in frame; or give "camera" { position, target, fov? } to look from anywhere, e.g. into a housing. ' +
      'SEVERAL VIEWS IN ONE IMAGE: "views" takes up to 9 entries (presets, "current", or { position, target, fov? }) and returns one contact sheet, e.g. ["front","right","top","iso"] as a 2 x 2 grid (2 views: 2 x 1, 5-6: 3 x 2, 7-9: 3 x 3; filled row by row). Each tile is rendered at its own size and has a caption with the view name, where the camera is and which world axes point right and up in it; width/height are the size of the whole sheet. One view often hides a mistake (a long arm seen end-on looks like a dot), so prefer a sheet to check a model. ' +
      'LOOKING INSIDE: "hideIds" leaves objects out of the picture, "onlyIds" shows nothing but the given objects, "xray" draws every surface semi-transparent with its border and crease edges as lines, so parts behind and inside others show through. ' +
      '"shading" overrides the viewport shading for this picture (solid = neutral clay, wireframe = all edges, material = PBR materials and textures). ' +
      '"fit": true frames all objects the picture shows (keeping the viewing direction of "current" / a given camera); a list of objects frames just those. Presets always frame: the objects in "fit" if given, else everything shown. ' +
      PRESET_DIRECTIONS_HINT +
      ' ANIMATION: ' +
      FRAME_HINT +
      ' The result then also has frame, time (seconds) and animationCamera (whether the animated camera was used). Use it to check the timing of an animation before render_video.' +
      ' Selected objects keep their highlight (accent-coloured outline and edges), in every tile, and an object in edit mode shows its edit-mode display with the selected elements; the transform gizmo is never drawn. ' +
      'Returns the image and, as text, { views: [{ name, cameraPosition, cameraTarget, fov, direction, imageRight, imageUp, rect }], width, height, backend }: per view the exact camera (world coordinates), its direction in words (e.g. "camera at +Z looking toward -Z"), the world axes that point right / up in the image, and rect = where that view is in the image in pixels { x, y, width, height } from the top left.',
    params: z
      .object({
        width: z.number().int().min(64).max(4096).default(1024).describe('Width of the whole image in pixels'),
        height: z.number().int().min(64).max(4096).default(768).describe('Height of the whole image in pixels'),
        view: z.enum(['current', ...viewPresets]).optional().describe('The single view to render, unless "camera" or "views" is given. Default: "current" (with "frame" and camera keys: the animated camera).'),
        camera: screenshotCamera.optional().describe("Render from this camera instead of \"view\". The user's viewport camera does not move."),
        views: z
          .array(z.union([z.enum(['current', ...viewPresets]), screenshotCamera]))
          .min(1)
          .max(MAX_SHEET_VIEWS)
          .optional()
          .describe('Several views on one captioned sheet; replaces "view". Cannot be combined with "camera" (put the camera into the list instead).'),
        fit: z
          .union([z.boolean(), z.array(z.string()).max(10000)])
          .default(false)
          .describe(`true: frame every object the picture shows. A list frames just these objects: ${REFS_HINT}. An empty list is the same as true.`),
        hideIds: z.array(z.string()).max(10000).optional().describe(`Objects left out of this picture only: ${REFS_HINT}.`),
        onlyIds: z.array(z.string()).min(1).max(10000).optional().describe(`Show only these objects in this picture: ${REFS_HINT}. Objects hidden in the document stay hidden.`),
        shading: z.enum(shadings).optional().describe('Shading for this picture only; default: the current viewport shading'),
        xray: z.boolean().default(false).describe('Semi-transparent surfaces with edge lines, so that enclosed and occluded parts show through'),
        frame: z.number().min(0).max(MAX_KEY_FRAME).optional().describe('Animation frame to show (fractional allowed). Default: the static pose, no animation.'),
        useAnimationCamera: z.boolean().optional().describe('Look through the animated camera at "frame". Default: true when "frame" is given, the document has camera keys and neither "view", "camera" nor "views" is given.'),
      })
      .refine((p) => !(p.views && p.camera), { message: 'Give either "views" or "camera", not both: put the camera into the "views" list', path: ['camera'] }),
    async run(ctx, p) {
      const doc = viewDoc(ctx);
      const state = doc.state;
      const refs = (list: readonly string[] | undefined) => (list ? resolveObjectIds(state, list) : undefined);
      const { frame, useAnimationCamera, ...shot } = p;
      const animated = pictureCamera(state.animation, frame, useAnimationCamera, p.view !== undefined || p.camera !== undefined || p.views !== undefined);
      const { base64, ...info } = await viewport(ctx).screenshot(
        {
          ...shot,
          view: p.view ?? 'current',
          ...(animated ? { camera: animated } : {}),
          fit: typeof p.fit === 'boolean' ? p.fit : p.fit.length === 0 || resolveObjectIds(state, p.fit),
          hideIds: refs(p.hideIds),
          onlyIds: refs(p.onlyIds),
          // The viewport shows the document at its playhead; a picture of a given frame is drawn apart from it.
          ...(frame !== undefined ? { offscreen: true } : {}),
        },
        frame !== undefined ? { id: doc.id, state: animatedState(state, frame) } : doc,
      );
      if (frame === undefined) return { image: { mimeType: 'image/png', base64 }, ...info };
      const fps = state.animation?.fps ?? DEFAULT_FPS;
      return { image: { mimeType: 'image/png', base64 }, ...info, frame, time: Math.round((frame / fps) * 1e6) / 1e6, animationCamera: animated !== null };
    },
  }),

  defineCommand({
    id: 'view.get_camera',
    title: 'Kamera abfragen',
    description: "Get the user's viewport camera: position and target (the orbit centre it looks at), world coordinates in meters, Y is up." + BG_CAMERA,
    params: z.object({}),
    run(ctx) {
      return viewport(ctx).getCamera(viewDoc(ctx));
    },
  }),

  defineCommand({
    id: 'view.set_camera',
    title: 'Kamera setzen',
    description:
      "Move the user's viewport camera. position and target (the point it looks at and orbits) are world coordinates in meters, Y is up; an omitted one stays as it is. Returns the resulting camera. To only look at something yourself, do not move the user's camera: give view.screenshot a \"camera\" instead." +
      BG_CAMERA,
    params: z.object({ position: vec3.optional(), target: vec3.optional() }),
    run(ctx, p) {
      const doc = viewDoc(ctx);
      viewport(ctx).setCamera(p, doc);
      return viewport(ctx).getCamera(doc);
    },
  }),

  defineCommand({
    id: 'view.set_view',
    title: 'Ansicht wählen',
    description:
      "Turn the user's viewport camera to a preset side of the scene (front, back, left, right, top, bottom, iso) with all visible objects in frame. " +
      PRESET_DIRECTIONS_HINT +
      ' view.screenshot takes the same presets without moving the user\'s camera. Returns the resulting camera.' +
      BG_CAMERA,
    params: z.object({ preset: z.enum(viewPresets) }),
    run(ctx, p) {
      const doc = viewDoc(ctx);
      viewport(ctx).setView(p.preset, doc);
      return viewport(ctx).getCamera(doc);
    },
  }),

  defineCommand({
    id: 'view.frame',
    title: 'Auswahl fokussieren',
    description:
      'Frame the given objects in the viewport, keeping the viewing direction. Defaults to the selection (in edit mode: the selected elements), or everything if nothing is selected. Returns the resulting camera.' +
      BG_CAMERA,
    params: z.object({ ids: z.array(z.string()).optional().describe(`Objects to frame: ${REFS_HINT}.`) }),
    run(ctx, p) {
      const doc = viewDoc(ctx);
      viewport(ctx).frame(p.ids ? resolveObjectIds(doc.state, p.ids) : doc.state.selection, doc);
      return viewport(ctx).getCamera(doc);
    },
  }),
];
