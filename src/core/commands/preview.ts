import { z } from 'zod';
import type { MinecraftAssetsStatus } from '../minecraftAssets';
import type { Preferences } from '../preferences';
import {
  ANGLE_PRESETS_HINT,
  angleDirections,
  angleProjection,
  anglePresets,
  cameraAngleSchema,
  cameraFrom,
  findCameraAngle,
  isMinecraftScene,
  previewBackgrounds,
  previewScenes,
  projections,
  withCameraAngle,
} from '../preview';
import { activeDoc } from '../state';
import type { ViewDocument } from '../types';
import { defineCommand, type CommandContext } from './registry';

// Viewport preview options (scene, background, reference models, projection, camera angles) and the
// Minecraft assets source. All of them are app-wide view settings kept with the preferences: nothing
// here changes a document, its undo history or its exports.

function viewport(ctx: CommandContext) {
  if (!ctx.services.viewport) throw new Error('The 3D viewport is not ready yet');
  return ctx.services.viewport;
}

function visibleDoc(ctx: CommandContext): ViewDocument {
  const doc = activeDoc(ctx.get());
  return { id: doc.id, state: doc.state };
}

function setPreferences(ctx: CommandContext, changes: Partial<Preferences>): Preferences {
  ctx.set((app) => ({ ...app, preferences: { ...app.preferences, ...changes } }));
  return ctx.get().preferences;
}

const NO_ASSETS: MinecraftAssetsStatus = { state: 'unavailable', path: '', info: null, error: 'Minecraft assets are only available in the desktop app' };

function assetsStatus(ctx: CommandContext): MinecraftAssetsStatus {
  return ctx.services.minecraftAssets?.status() ?? { ...NO_ASSETS, path: ctx.get().preferences.minecraftAssets };
}

/** The preview options as the commands report them. */
function previewState(ctx: CommandContext) {
  const p = ctx.get().preferences;
  const assets = assetsStatus(ctx);
  return {
    scene: p.previewScene,
    background: p.previewBackground,
    backgroundColor: p.previewBackgroundColor,
    ground: p.previewGround,
    pixelGrid: p.previewPixelGrid,
    player: p.previewPlayer,
    craftingTable: p.previewCraftingTable,
    skin: p.previewSkin,
    projection: p.viewportProjection,
    // Minecraft scenes and the reference models fall back to flat colours without the vanilla textures.
    usesVanillaTextures: assets.state === 'ready' && (isMinecraftScene(p.previewScene) || p.previewPlayer || p.previewCraftingTable),
    minecraftAssets: assets.state,
  };
}

const NOT_DOCUMENT = ' A view setting of the whole app (kept between launches): it never changes a document, its undo history, view_screenshot pictures or exports.';

export const previewCommands = [
  defineCommand({
    id: 'view.get_preview',
    title: 'Vorschau-Optionen abfragen',
    description:
      'Get the viewport preview options: scene, background, ground plane, pixel grid, reference models (Minecraft player, crafting table), projection, and whether the Minecraft assets (vanilla textures) are available. Also lists every scene and the saved camera angles.' +
      NOT_DOCUMENT,
    params: z.object({}),
    history: false,
    run(ctx) {
      return { ...previewState(ctx), scenes: previewScenes, cameraAngles: ctx.get().preferences.cameraAngles.map((a) => a.name) };
    },
  }),

  defineCommand({
    id: 'view.set_preview',
    title: 'Vorschau-Optionen ändern',
    description:
      'Change the viewport preview options; pass only what changes. scene: none, studio (neutral lit backdrop), sky, space, or a Minecraft scene (plains, snowy_tundra, cherry_grove, desert, ocean, underwater, lush_cave, deep_dark, nether, sunset, night) that builds a small block landscape from the vanilla textures (flat colours if no Minecraft assets are configured). ' +
      'A scene sets the lighting, fog and background around the model. background (solid = theme colour, checkerboard, custom = backgroundColor) shows when scene is none. ' +
      'ground: a ground plane (in Minecraft scenes the terrain floor). pixelGrid: a 1/16 block grid at the origin. player / craftingTable: reference models next to the model for scale (a player is 1.8 blocks tall, one block is 1 unit). skin: path of a 64x64 skin PNG for the player ("" = default skin from the assets). Returns the new options.' +
      NOT_DOCUMENT,
    params: z.object({
      scene: z.enum(previewScenes).optional(),
      background: z.enum(previewBackgrounds).optional(),
      backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe('#rrggbb; also switches the background to "custom" unless background is given'),
      ground: z.boolean().optional(),
      pixelGrid: z.boolean().optional(),
      player: z.boolean().optional(),
      craftingTable: z.boolean().optional(),
      skin: z.string().max(4096).optional(),
    }),
    history: false,
    run(ctx, p) {
      const changes: Partial<Preferences> = {};
      if (p.scene !== undefined) changes.previewScene = p.scene;
      if (p.backgroundColor !== undefined) {
        changes.previewBackgroundColor = p.backgroundColor.toLowerCase();
        changes.previewBackground = 'custom';
      }
      if (p.background !== undefined) changes.previewBackground = p.background;
      if (p.ground !== undefined) changes.previewGround = p.ground;
      if (p.pixelGrid !== undefined) changes.previewPixelGrid = p.pixelGrid;
      if (p.player !== undefined) changes.previewPlayer = p.player;
      if (p.craftingTable !== undefined) changes.previewCraftingTable = p.craftingTable;
      if (p.skin !== undefined) changes.previewSkin = p.skin.trim();
      setPreferences(ctx, changes);
      return previewState(ctx);
    },
  }),

  defineCommand({
    id: 'view.set_projection',
    title: 'Projektion wechseln',
    description: 'Switch the viewport camera between perspective and orthographic projection (no vanishing point; zoom changes the visible size).' + NOT_DOCUMENT,
    params: z.object({ projection: z.enum(projections) }),
    history: false,
    run(ctx, p) {
      return { projection: setPreferences(ctx, { viewportProjection: p.projection }).viewportProjection };
    },
  }),

  defineCommand({
    id: 'view.set_angle',
    title: 'Kamerawinkel wählen',
    description:
      "Turn the user's viewport camera to a camera angle: a preset (keeps the orbit target and distance) or one saved with view_save_angle (by name; restores its position, target and projection). " +
      ANGLE_PRESETS_HINT +
      ' Returns the resulting camera and projection.',
    params: z
      .object({
        preset: z.enum(anglePresets).optional(),
        name: z.string().optional().describe('Name of a saved camera angle'),
      })
      .refine((p) => (p.preset === undefined) !== (p.name === undefined), { message: 'Give either "preset" or "name"' }),
    history: false,
    run(ctx, p) {
      const view = viewport(ctx);
      const doc = visibleDoc(ctx);
      if (p.preset) {
        view.setCamera(cameraFrom(view.getCamera(doc), angleDirections[p.preset]), doc);
        const projection = angleProjection(p.preset);
        if (projection) setPreferences(ctx, { viewportProjection: projection });
      } else {
        const angles = ctx.get().preferences.cameraAngles;
        const angle = findCameraAngle(angles, p.name!);
        if (!angle) throw new Error(`No saved camera angle "${p.name}". Saved: ${angles.map((a) => `"${a.name}"`).join(', ') || 'none'}`);
        view.setCamera({ position: angle.position, target: angle.target }, doc);
        setPreferences(ctx, { viewportProjection: angle.projection });
      }
      return { ...view.getCamera(doc), projection: ctx.get().preferences.viewportProjection };
    },
  }),

  defineCommand({
    id: 'view.save_angle',
    title: 'Kamerawinkel speichern',
    description:
      "Save the user's current viewport camera (position, target, projection) as a named camera angle, or overwrite the one with that name. Saved angles belong to the app, not to a document; view_set_angle restores them.",
    params: z.object({ name: cameraAngleSchema.shape.name }),
    history: false,
    run(ctx, p) {
      const camera = viewport(ctx).getCamera(visibleDoc(ctx));
      const angle = { name: p.name.trim(), position: camera.position, target: camera.target, projection: ctx.get().preferences.viewportProjection };
      setPreferences(ctx, { cameraAngles: withCameraAngle(ctx.get().preferences.cameraAngles, angle) });
      return angle;
    },
  }),

  defineCommand({
    id: 'view.delete_angle',
    title: 'Kamerawinkel löschen',
    description: 'Delete a saved camera angle by name.',
    params: z.object({ name: z.string() }),
    history: false,
    run(ctx, p) {
      const angles = ctx.get().preferences.cameraAngles;
      const angle = findCameraAngle(angles, p.name);
      if (!angle) throw new Error(`No saved camera angle "${p.name}"`);
      setPreferences(ctx, { cameraAngles: angles.filter((a) => a !== angle) });
      return { deleted: angle.name };
    },
  }),

  defineCommand({
    id: 'assets.get_minecraft',
    title: 'Minecraft-Assets abfragen',
    description:
      'Get the Minecraft assets source (where vanilla textures and models are read from: a client .jar or a resource pack folder from the user\'s own install; nothing is bundled): state none / loading / ready / error / unavailable, the path, version and namespaces.',
    params: z.object({}),
    history: false,
    run(ctx) {
      return assetsStatus(ctx);
    },
  }),

  defineCommand({
    id: 'assets.set_minecraft',
    title: 'Minecraft-Assets festlegen',
    description:
      'Set the Minecraft assets source: path of a Minecraft client .jar (e.g. from assets_detect_minecraft) or of a folder with an unpacked resource pack (the folder that contains "assets", or "assets" itself); "" removes it. Read-only: only files under assets/ are ever read. Waits until it is opened and returns the status (state "error" with a message if the path is no assets source).',
    params: z.object({ path: z.string().max(4096) }),
    history: false,
    async run(ctx, p) {
      setPreferences(ctx, { minecraftAssets: p.path.trim() });
      const service = ctx.services.minecraftAssets;
      return service ? service.reload() : assetsStatus(ctx);
    },
  }),

  defineCommand({
    id: 'assets.detect_minecraft',
    title: 'Minecraft-Installationen suchen',
    description: 'List the Minecraft client versions installed in the standard launcher folder (.minecraft/versions), newest first, with the path of each client .jar for assets_set_minecraft.',
    params: z.object({}),
    history: false,
    async run(ctx) {
      const service = ctx.services.minecraftAssets;
      if (!service) throw new Error(NO_ASSETS.error!);
      return { installs: await service.detect() };
    },
  }),
];
